#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { ModelRoutingPipeline } from "./provider/routing.mjs";
import { ProviderRegistry } from "./provider/registry.mjs";
import { ProviderTransport } from "./provider/transport.mjs";
import { ResponsesSseAdapter, readResponsesSse } from "./protocol/sse.mjs";
import {
  chatCompletionToResponses,
  readChatCompletionsSse,
  responsesToChatCompletions,
} from "./protocol/chat-completions.mjs";
import {
  anthropicMessageToResponses,
  readAnthropicMessagesSse,
  responsesToAnthropicMessages,
} from "./protocol/anthropic-messages.mjs";
import { captureProviderRequest } from "./tools/diagnostics.mjs";
import { CollaborationHistoryBridge } from "./tools/collaboration-history.mjs";
import { VisionEvidenceWorkflow } from "./vision/workflow.mjs";
import { runtimeConfig } from "./runtime-config.mjs";

const runtime = runtimeConfig();
const HOST = "127.0.0.1";
const PORT = runtime.port;
const OPENAI_BASE = "https://chatgpt.com/backend-api/codex";
const VISION_TOKEN_FILE = runtime.visionTokenFile;
const PROVIDER_REGISTRY_FILE = runtime.providerRegistryFile;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const HTTP_DISPATCHER = new EnvHttpProxyAgent();
const WS_PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
const WS_PROXY_AGENT = WS_PROXY_URL ? new HttpsProxyAgent(WS_PROXY_URL) : undefined;

const providerRegistry = new ProviderRegistry(PROVIDER_REGISTRY_FILE, {
  onError: (message) => log(`provider registry rejected; keeping last-known-good: ${message}`),
});
providerRegistry.ensure();
function log(message) {
  process.stderr.write(`[codex-hybrid] ${new Date().toISOString()} ${message}\n`);
}

function writeSseEvent(response, eventName, data) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

const visionWorkflow = new VisionEvidenceWorkflow({
  tokenFile: VISION_TOKEN_FILE,
  openAiBase: OPENAI_BASE,
  fetch: undiciFetch,
  dispatcher: HTTP_DISPATCHER,
  log,
});
const collaborationBridge = new CollaborationHistoryBridge();
const routingPipeline = new ModelRoutingPipeline({ registry: providerRegistry, visionWorkflow, collaborationBridge });
const providerTransport = new ProviderTransport({
  fetch: undiciFetch,
  dispatcher: HTTP_DISPATCHER,
  log,
});

function routeForModel(model) {
  return routingPipeline.route(model);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) {
        reject(new Error("request body exceeds 128 MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function copyRequestHeaders(request, route = null) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "content-encoding"
    ) continue;
    if (route && (lower === "authorization" || lower === "chatgpt-account-id")) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) if (value !== undefined) headers.append(name, value);
  }
  headers.set("content-type", "application/json");
  return headers;
}

function copyWebSocketHeaders(request) {
  const headers = {};
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower.startsWith("sec-websocket-") ||
      lower === "origin"
    ) continue;
    if (rawValue !== undefined) headers[name] = rawValue;
  }
  headers.origin = "https://chatgpt.com";
  return headers;
}

async function handleVisionAnalyze(request, response) {
  try {
    const rawBody = await readBody(request);
    const args = JSON.parse(rawBody.toString("utf8"));
    const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const analysis = await visionWorkflow.analyzePath({
      token,
      path: args.path ?? args.image_path,
      prompt: args.prompt,
      detail: args.detail || "high",
      contextId: args._hybrid_context_id,
    });
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ analysis }));
  } catch (error) {
    const unauthorized = /unauthorized/.test(error?.message || "");
    response.writeHead(unauthorized ? 401 : 400, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
  }
}

function decodeRequestBody(request, rawBody) {
  const encoding = String(request.headers["content-encoding"] || "").toLowerCase();
  if (!encoding || encoding === "identity") return rawBody;
  if (encoding === "zstd") return zstdDecompressSync(rawBody);
  if (encoding === "gzip") return gunzipSync(rawBody);
  if (encoding === "deflate") return inflateSync(rawBody);
  if (encoding === "br") return brotliDecompressSync(rawBody);
  throw new Error(`unsupported request content-encoding: ${encoding}`);
}

function copyResponseHeaders(upstream, response) {
  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "content-length" ||
      lower === "content-encoding"
    ) continue;
    response.setHeader(name, value);
  }
}

function handleProviderStreamError(error, response, providerId) {
  log(`Responses Provider ${providerId} response stream error: ${error?.message || String(error)}`);
  if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
  if (!response.writableEnded) response.destroy(error);
}

function upstreamPath(requestUrl) {
  const url = new URL(requestUrl, `http://${HOST}:${PORT}`);
  return `${url.pathname.replace(/^\/v1(?=\/|$)/, "") || "/"}${url.search}`;
}

async function handleProxy(request, response) {
  const rawBody = await readBody(request);
  const decodedBody = decodeRequestBody(request, rawBody);
  let parsedBody = null;
  if (decodedBody.length) {
    try {
      parsedBody = JSON.parse(decodedBody.toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "codex-hybrid requires a JSON request body" } }));
      return;
    }
  }

  let prepared;
  try {
    prepared = await routingPipeline.prepare(parsedBody, {
      transport: "http",
      authHeaders: copyRequestHeaders(request),
      accountScope: request.headers["chatgpt-account-id"],
      promptCacheKey: parsedBody?.prompt_cache_key,
    });
  } catch (error) {
    if (/credential is unavailable/.test(error?.message || "")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
      return;
    }
    throw error;
  }
  const route = prepared.route;
  const body = prepared.body;
  const toolTurn = prepared.toolTurn;
  const protocol = route?.model.api_protocol || "responses";
  const providerBody = protocol === "chat_completions"
    ? responsesToChatCompletions(body)
    : protocol === "anthropic_messages"
      ? responsesToAnthropicMessages(body)
      : body;
  const requestPath = protocol === "chat_completions"
    ? "/chat/completions"
    : protocol === "anthropic_messages"
      ? "/messages"
      : upstreamPath(request.url);
  const upstreamHeaders = copyRequestHeaders(request, route);
  if (protocol === "anthropic_messages") {
    upstreamHeaders.set("anthropic-version", "2023-06-01");
    upstreamHeaders.set("accept", "text/event-stream");
  }
  const upstreamInit = {
    method: request.method,
    headers: upstreamHeaders,
    body: decodedBody.length ? JSON.stringify(providerBody) : undefined,
    redirect: "manual",
  };
  let upstream;
  if (route) {
    captureProviderRequest(runtime.root, route, providerBody, { transport: "http" });
    upstream = await providerTransport.request(route, requestPath, upstreamInit);
  } else {
    upstream = await undiciFetch(`${OPENAI_BASE}${requestPath}`, { ...upstreamInit, dispatcher: HTTP_DISPATCHER });
  }

  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response);
  if (!upstream.body) {
    response.end();
    return;
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (route && ["chat_completions", "anthropic_messages"].includes(protocol) && contentType.includes("text/event-stream")) {
    const reducer = toolTurn.createEventReducer({ providerId: route.provider.id });
    const readStream = protocol === "chat_completions" ? readChatCompletionsSse : readAnthropicMessagesSse;
    await readStream(upstream, async (event) => {
      for (const adapted of reducer.adapt(event.eventName, event.data)) {
        collaborationBridge.observe(adapted.data);
        writeSseEvent(response, adapted.eventName, adapted.data);
      }
    });
    response.end();
    return;
  }
  const readable = Readable.fromWeb(upstream.body);
  if (route && contentType.includes("text/event-stream")) {
    let terminalHandled = false;
    const adapter = new ResponsesSseAdapter(toolTurn, {
      onEvent: (event) => collaborationBridge.observe(event),
      providerId: route.provider.id,
      onTerminal: () => {
        if (terminalHandled) return;
        terminalHandled = true;
        queueMicrotask(() => {
          readable.unpipe(adapter);
          readable.destroy();
          adapter.end();
        });
      },
    });
    readable.on("error", (error) => handleProviderStreamError(error, response, route.provider.id));
    adapter.on("error", (error) => handleProviderStreamError(error, response, route.provider.id));
    readable.pipe(adapter).pipe(response);
    return;
  }
  if (route && contentType.includes("application/json")) {
    const chunks = [];
    for await (const chunk of readable) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (["chat_completions", "anthropic_messages"].includes(protocol)) {
      const parsed = JSON.parse(text);
      const portable = protocol === "chat_completions"
        ? chatCompletionToResponses(parsed)
        : anthropicMessageToResponses(parsed);
      const adapted = toolTurn.adaptResponse(portable, { providerId: route.provider.id });
      collaborationBridge.observe(adapted);
      response.end(JSON.stringify(adapted));
      return;
    }
    try {
      const adapted = toolTurn.adaptResponse(JSON.parse(text), { providerId: route.provider.id });
      collaborationBridge.observe(adapted);
      response.end(JSON.stringify(adapted));
    } catch {
      response.end(text);
    }
    return;
  }
  readable.pipe(response);
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    const visionHealth = visionWorkflow.health();
    const registryStatus = providerRegistry.status();
    const credentialsAvailable = providerTransport.allCredentialsAvailable(providerRegistry);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      ok: true,
      keyAvailable: credentialsAvailable,
      registry: registryStatus,
      visionTokenAvailable: visionHealth.tokenAvailable,
      visionAuthReady: visionHealth.authReady,
      vision: visionHealth.vision,
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/hybrid/vision/analyze") {
    await handleVisionAnalyze(request, response);
    return;
  }
  if (!request.url?.startsWith("/v1/") && !request.url?.startsWith("/responses")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unknown codex-hybrid route" } }));
    return;
  }
  try {
    await handleProxy(request, response);
  } catch (error) {
    log(`proxy error: ${error?.message || String(error)}`);
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: { message: "codex-hybrid upstream request failed" } }));
    }
  }
});

const webSocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });

function sanitizeOpenAiWebSocketMessage(data) {
  try {
    const message = JSON.parse(data.toString("utf8"));
    if (message?.type !== "response.create") return data;
    return JSON.stringify(visionWorkflow.prepareOfficialBody(message));
  } catch {
    return data;
  }
}

function createOpenAiWebSocketSession(client, request) {
  let upstream = null;
  const pending = [];
  let opened = false;

  function connect() {
    if (upstream) return;
    const target = `wss://chatgpt.com/backend-api/codex${upstreamPath(request.url)}`;
    upstream = new WebSocket(target, {
      headers: copyWebSocketHeaders(request),
      agent: WS_PROXY_AGENT,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    upstream.on("open", () => {
      opened = true;
      for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
      pending.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      try { collaborationBridge.observe(JSON.parse(data.toString("utf8"))); } catch {}
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on("close", (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(safeCloseCode(code, 1011), reason);
      }
    });
    upstream.on("error", (error) => {
      log(`OpenAI websocket upstream error: ${error?.code || error?.message || "unknown"}`);
      if (client.readyState === WebSocket.OPEN) client.close(1011, "OpenAI upstream unavailable");
    });
  }

  function enqueue(data, isBinary) {
    const sanitized = sanitizeOpenAiWebSocketMessage(data);
    connect();
    if (opened && upstream.readyState === WebSocket.OPEN) upstream.send(sanitized, { binary: isBinary });
    else pending.push([sanitized, isBinary]);
  }

  function close(code, reason) {
    if (!upstream) return;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(safeCloseCode(code), reason);
    }
  }

  return { enqueue, close };
}

function sendWebSocketEvent(client, data) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
}

function safeCloseCode(code, fallback = 1000) {
  if (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))) {
    return code;
  }
  if (code >= 3000 && code <= 4999) return code;
  return fallback;
}

function warmupResponse(model) {
  return {
    id: `resp_hybrid_warmup_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  };
}

function createResponsesProviderSession(client, request, providerId) {
  const state = {
    fullInput: [],
    lastOutput: [],
    visionContextId: null,
    waiting: [],
    processing: false,
    closed: false,
    activeRequest: null,
  };

  async function processMessage(message, route) {
    if (state.closed) return;
    if (message.type !== "response.create") throw new Error(`unsupported websocket message: ${message.type}`);
    if (route.provider.id !== providerId) throw new Error("Responses Provider session route mismatch");
    if (message.generate === false) {
      state.fullInput = Array.isArray(message.input) ? structuredClone(message.input) : [];
      state.lastOutput = [];
      const response = warmupResponse(message.model);
      sendWebSocketEvent(client, { type: "response.created", response: { ...response, status: "in_progress" } });
      sendWebSocketEvent(client, { type: "response.completed", response });
      return;
    }

    const incrementalInput = Array.isArray(message.input) ? structuredClone(message.input) : [];
    const fullInput = message.previous_response_id
      ? [...state.fullInput, ...state.lastOutput, ...incrementalInput]
      : incrementalInput;
    const requestBody = { ...message, input: fullInput, stream: true };
    delete requestBody.type;
    delete requestBody.generate;
    delete requestBody.previous_response_id;
    const controller = new AbortController();
    const prepared = await routingPipeline.prepare(requestBody, {
      transport: "websocket",
      authHeaders: copyRequestHeaders(request),
      accountScope: request.headers["chatgpt-account-id"],
      contextId: state.visionContextId,
    });
    if (state.closed) return;
    const adaptedBody = prepared.body;
    const protocol = route.model.api_protocol || "responses";
    const providerBody = protocol === "chat_completions"
      ? responsesToChatCompletions(adaptedBody)
      : protocol === "anthropic_messages"
        ? responsesToAnthropicMessages(adaptedBody)
        : adaptedBody;
    state.visionContextId = prepared.contextId;
    state.fullInput = Array.isArray(prepared.historyBody?.input) ? structuredClone(prepared.historyBody.input) : [];
    state.lastOutput = [];

    captureProviderRequest(runtime.root, route, providerBody, { transport: "websocket" });

    state.activeRequest = controller;
    try {
      const headers = { "content-type": "application/json" };
      if (protocol === "anthropic_messages") {
        headers["anthropic-version"] = "2023-06-01";
        headers.accept = "text/event-stream";
      }
      const requestPath = protocol === "chat_completions" ? "/chat/completions" : protocol === "anthropic_messages" ? "/messages" : "/responses";
      const upstream = await providerTransport.request(route, requestPath, {
        method: "POST",
        headers,
        body: JSON.stringify(providerBody),
        signal: controller.signal,
      });
      if (state.closed) {
        await upstream.body?.cancel(controller.signal.reason).catch(() => {});
        return;
      }
      if (!upstream.ok) {
        const errorText = await upstream.text();
        throw new Error(`Responses Provider ${providerId} received HTTP ${upstream.status}: ${errorText.slice(0, 300)}`);
      }

      const adapter = prepared.toolTurn.createEventReducer({ providerId });
      const contentType = upstream.headers.get("content-type") || "";
      if (["chat_completions", "anthropic_messages"].includes(protocol) && contentType.includes("application/json")) {
        const parsed = await upstream.json();
        const portable = protocol === "chat_completions"
          ? chatCompletionToResponses(parsed)
          : anthropicMessageToResponses(parsed);
        const adapted = prepared.toolTurn.adaptResponse(portable, { providerId });
        collaborationBridge.observe(adapted);
        state.lastOutput = Array.isArray(adapted.output) ? structuredClone(adapted.output) : [];
        sendWebSocketEvent(client, {
          type: "response.created",
          response: { ...adapted, status: "in_progress", output: [] },
        });
        sendWebSocketEvent(client, {
          type: adapted.status === "incomplete" ? "response.incomplete" : "response.completed",
          response: adapted,
        });
        return;
      }
      const readStream = protocol === "chat_completions"
        ? readChatCompletionsSse
        : protocol === "anthropic_messages"
          ? readAnthropicMessagesSse
          : readResponsesSse;
      await readStream(upstream, async ({ eventName, data }) => {
        if (state.closed) return;
        for (const event of adapter.adapt(eventName, data)) {
          collaborationBridge.observe(event.data);
          if (event.eventName === "response.completed" && Array.isArray(event.data.response?.output)) {
            state.lastOutput = structuredClone(event.data.response.output);
          }
          sendWebSocketEvent(client, event.data);
        }
      });
    } finally {
      if (state.activeRequest === controller) state.activeRequest = null;
    }
  }

  async function drain() {
    if (state.processing) return;
    state.processing = true;
    try {
      while (!state.closed && state.waiting.length > 0) {
        const { message, route } = state.waiting.shift();
        try {
          await processMessage(message, route);
        } catch (error) {
          if (state.closed) return;
          log(`Responses Provider ${providerId} websocket adapter error: ${error?.message || String(error)}`);
          sendWebSocketEvent(client, {
            type: "response.failed",
            response: {
              id: `resp_hybrid_failed_${Date.now()}`,
              object: "response",
              status: "failed",
              error: { code: "hybrid_upstream_error", message: `Responses Provider ${providerId} upstream request failed` },
              output: [],
            },
          });
        }
      }
    } finally {
      state.processing = false;
      if (state.closed) state.waiting.length = 0;
    }
  }

  function enqueue(message, route) {
    if (state.closed) return;
    state.waiting.push({ message, route });
    void drain();
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
    state.waiting.length = 0;
    state.fullInput = [];
    state.lastOutput = [];
    state.visionContextId = null;
    state.activeRequest?.abort(new Error("client websocket disconnected"));
  }

  return { enqueue, close };
}

webSocketServer.on("connection", (client, request) => {
  let openAiSession = null;
  const providerSessions = new Map();

  client.on("message", (data, isBinary) => {
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      client.close(1003, "Expected a JSON Responses request");
      return;
    }
    const route = routeForModel(message.model);
    if (route) {
      let session = providerSessions.get(route.provider.id);
      if (!session) {
        session = createResponsesProviderSession(client, request, route.provider.id);
        providerSessions.set(route.provider.id, session);
      }
      session.enqueue(message, route);
      return;
    }
    openAiSession ??= createOpenAiWebSocketSession(client, request);
    openAiSession.enqueue(data, isBinary);
  });
  client.on("close", (code, reason) => {
    openAiSession?.close(code, reason);
    for (const session of providerSessions.values()) session.close();
    providerSessions.clear();
  });
  client.on("error", () => {
    openAiSession?.close(1011);
    for (const session of providerSessions.values()) session.close();
    providerSessions.clear();
  });
});

server.on("upgrade", (request, socket, head) => {
  if (!request.url?.startsWith("/v1/responses") && !request.url?.startsWith("/responses")) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (client) => {
    webSocketServer.emit("connection", client, request);
  });
});

server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
server.on("error", (error) => {
  log(`server error: ${error.message}`);
  process.exitCode = 1;
});
