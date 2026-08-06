import { resolveCredential } from "./registry.mjs";

const RETRYABLE_STATUS = new Set([401, 403, 408, 429]);
const MAX_FIRST_EVENT_BYTES = 8 * 1024 * 1024;

export class ProviderTimeoutError extends Error {
  constructor(kind, timeoutMs) {
    super(`Responses Provider ${kind} timeout after ${timeoutMs} ms`);
    this.name = "ProviderTimeoutError";
    this.kind = kind;
    this.timeoutMs = timeoutMs;
  }
}

function retryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

function entriesFor(provider) {
  if (provider.credential_pool) return provider.credential_pool.entries;
  return [{ id: "default", ...provider.credential }];
}

function poolSettings(provider) {
  return provider.credential_pool || {
    strategy: "fill_first",
    cooldown_ms: 300_000,
    first_event_timeout_ms: 20_000,
    idle_timeout_ms: 45_000,
  };
}

function waitFor(promise, timeoutMs, kind) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProviderTimeoutError(kind, timeoutMs)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function containsCompleteSseEvent(chunks) {
  const value = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return value.includes("\n\n") || value.includes("\r\n\r\n");
}

function responseWithGuardedBody(response, reader, initialChunks, idleTimeoutMs, onStreamError) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of initialChunks) controller.enqueue(chunk);
      void (async () => {
        try {
          for (;;) {
            const chunk = await waitFor(reader.read(), idleTimeoutMs, "stream idle");
            if (chunk.done) {
              controller.close();
              return;
            }
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          onStreamError(error);
          await reader.cancel(error).catch(() => {});
          controller.error(error);
        }
      })();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function primeResponse(response, { firstEventTimeoutMs, idleTimeoutMs, onStreamError = () => {} }) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  const isSse = (response.headers.get("content-type") || "").includes("text/event-stream");
  const deadline = Date.now() + firstEventTimeoutMs;
  let size = 0;
  try {
    for (;;) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await waitFor(reader.read(), remaining, isSse ? "first SSE event" : "first response byte");
      if (chunk.done) break;
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
      if (!isSse || containsCompleteSseEvent(chunks)) break;
      if (size > MAX_FIRST_EVENT_BYTES) throw new Error("Responses Provider first SSE event exceeds 8 MiB");
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
  return responseWithGuardedBody(response, reader, chunks, idleTimeoutMs, onStreamError);
}

function retryAfterMs(response, now, fallback) {
  const value = response.headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(1_000, timestamp - now) : fallback;
}

export class ProviderTransport {
  constructor({ fetch, dispatcher, credentialResolver = resolveCredential, now = () => Date.now(), log = () => {} }) {
    this.fetch = fetch;
    this.dispatcher = dispatcher;
    this.credentialResolver = credentialResolver;
    this.now = now;
    this.log = log;
    this.cooldowns = new Map();
  }

  resolvedEntries(provider) {
    return entriesFor(provider).map((entry) => ({
      entry,
      credential: this.credentialResolver(entry),
    })).filter(({ entry, credential }) => entry.type === "none" || Boolean(credential));
  }

  credentialAvailable(route) {
    return !route || this.resolvedEntries(route.provider).length > 0;
  }

  allCredentialsAvailable(registry) {
    return Object.values(registry.reload().providers).every((provider) => this.credentialAvailable({ provider }));
  }

  cooldownKey(provider, entry) {
    return `${provider.id}:${entry.id}`;
  }

  orderedEntries(provider) {
    const now = this.now();
    const entries = this.resolvedEntries(provider);
    const ready = entries.filter(({ entry }) => (this.cooldowns.get(this.cooldownKey(provider, entry)) || 0) <= now);
    if (ready.length > 0) return ready;
    return entries.toSorted((left, right) =>
      (this.cooldowns.get(this.cooldownKey(provider, left.entry)) || 0)
      - (this.cooldowns.get(this.cooldownKey(provider, right.entry)) || 0));
  }

  markCooldown(provider, entry, durationMs, reason) {
    this.cooldowns.set(this.cooldownKey(provider, entry), this.now() + durationMs);
    this.log(`Responses Provider ${provider.id} credential ${entry.id} cooling down after ${reason}`);
  }

  requestHeaders(entry, credential, input) {
    const headers = new Headers(input || {});
    if (entry.type !== "none") {
      const name = entry.header || "authorization";
      const prefix = entry.prefix ?? "Bearer ";
      headers.set(name, `${prefix}${credential}`);
    }
    return headers;
  }

  async fetchWithHeaderTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const upstreamSignal = options.signal;
    const relayAbort = () => controller.abort(upstreamSignal.reason);
    if (upstreamSignal?.aborted) relayAbort();
    else upstreamSignal?.addEventListener("abort", relayAbort, { once: true });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new ProviderTimeoutError("response headers", timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.fetch(url, { ...options, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      upstreamSignal?.removeEventListener("abort", relayAbort);
    }
  }

  async request(route, requestPath, init = {}) {
    const provider = route.provider;
    const settings = poolSettings(provider);
    const candidates = this.orderedEntries(provider);
    if (candidates.length === 0) throw new Error(`credential is unavailable for Responses Provider ${provider.id}`);
    let lastError = null;
    let lastResponse = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const { entry, credential } = candidates[index];
      try {
        const options = {
          ...init,
          headers: this.requestHeaders(entry, credential, init.headers),
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        };
        const response = await this.fetchWithHeaderTimeout(
          `${provider.base_url}${requestPath}`,
          options,
          settings.first_event_timeout_ms,
        );
        if (retryableStatus(response.status)) {
          lastResponse = response;
          const duration = retryAfterMs(response, this.now(), settings.cooldown_ms);
          this.markCooldown(provider, entry, duration, `HTTP ${response.status}`);
          if (index + 1 < candidates.length) {
            await response.body?.cancel().catch(() => {});
            continue;
          }
          return response;
        }
        return await primeResponse(response, {
          firstEventTimeoutMs: settings.first_event_timeout_ms,
          idleTimeoutMs: settings.idle_timeout_ms,
          onStreamError: (error) => this.markCooldown(
            provider,
            entry,
            settings.cooldown_ms,
            error?.message || "stream error",
          ),
        });
      } catch (error) {
        lastError = error;
        this.markCooldown(provider, entry, settings.cooldown_ms, error?.message || "network error");
        if (index + 1 >= candidates.length) throw error;
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError || new Error(`Responses Provider ${provider.id} request failed`);
  }
}
