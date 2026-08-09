import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeProviderToolProfile } from "../tools/profile.mjs";

export const REGISTRY_VERSION = 1;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREDENTIAL_TYPES = new Set(["inline", "env", "keychain", "none"]);
const VISION_MODES = new Set(["delegated", "native"]);
const VISION_FAILURE_POLICIES = new Set(["fail_request", "error_evidence"]);
const SEARCH_MODES = new Set(["external", "native"]);
const API_PROTOCOLS = new Set(["responses", "chat_completions", "anthropic_messages"]);
const POOL_STRATEGIES = new Set(["fill_first"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CREDENTIAL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function defaultRegistry() {
  return {
    version: REGISTRY_VERSION,
    providers: {
      "ollama-pro": {
        name: "Ollama Pro",
        base_url: "https://ollama.com/v1",
        credential: {
          type: "keychain",
          service: "codex-hybrid-ollama-pro",
          account: "ollama-pro",
        },
        models: {
          "deepseek-v4-flash:0731": {
            display_name: "DeepSeek-V4-Flash 0731 · Ollama Pro",
            description: "Pinned DeepSeek V4 Flash 0731 served by Ollama Pro.",
            context_window: 1048576,
            reasoning_efforts: ["low", "high", "max"],
            default_reasoning_effort: "high",
            vision_mode: "delegated",
          },
          "glm-5.2": {
            display_name: "GLM-5.2 · Ollama Pro",
            description: "GLM-5.2 long-horizon coding model served by Ollama Pro.",
            context_window: 999424,
            reasoning_efforts: ["high", "max"],
            default_reasoning_effort: "high",
            vision_mode: "delegated",
          },
        },
      },
    },
  };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function normalizedBaseUrl(value, providerId) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`provider ${providerId} base_url is required`);
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`provider ${providerId} base_url must use HTTPS or loopback HTTP`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function validateCredential(value, providerId) {
  const credential = value === undefined ? { type: "none" } : structuredClone(object(value, `provider ${providerId} credential`));
  if (!CREDENTIAL_TYPES.has(credential.type)) throw new Error(`provider ${providerId} credential.type is invalid`);
  if (credential.type === "inline" && typeof credential.api_key !== "string") {
    throw new Error(`provider ${providerId} inline credential requires api_key`);
  }
  if (credential.type === "env" && (typeof credential.name !== "string" || !credential.name)) {
    throw new Error(`provider ${providerId} env credential requires name`);
  }
  if (credential.type === "keychain") {
    if (typeof credential.service !== "string" || !credential.service) throw new Error(`provider ${providerId} keychain service is required`);
    if (typeof credential.account !== "string" || !credential.account) throw new Error(`provider ${providerId} keychain account is required`);
  }
  if (credential.header !== undefined && (typeof credential.header !== "string" || !HEADER_NAME.test(credential.header))) {
    throw new Error(`provider ${providerId} credential.header is invalid`);
  }
  if (credential.prefix !== undefined && typeof credential.prefix !== "string") {
    throw new Error(`provider ${providerId} credential.prefix must be a string`);
  }
  return credential;
}

function positiveDuration(value, fallback, label) {
  const duration = Number(value ?? fallback);
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error(`${label} must be a positive integer`);
  return duration;
}

function validateCredentialPool(value, providerId) {
  if (value === undefined) return null;
  const pool = object(value, `provider ${providerId} credential_pool`);
  const strategy = String(pool.strategy || "fill_first");
  if (!POOL_STRATEGIES.has(strategy)) throw new Error(`provider ${providerId} credential_pool.strategy is invalid`);
  if (!Array.isArray(pool.entries) || pool.entries.length === 0) {
    throw new Error(`provider ${providerId} credential_pool.entries must not be empty`);
  }
  const ids = new Set();
  const entries = pool.entries.map((rawEntry) => {
    const entry = object(rawEntry, `provider ${providerId} credential_pool entry`);
    const id = String(entry.id || "");
    if (!CREDENTIAL_ID.test(id)) throw new Error(`provider ${providerId} credential_pool entry id is invalid`);
    if (ids.has(id)) throw new Error(`provider ${providerId} credential_pool entry id is duplicated: ${id}`);
    ids.add(id);
    const credential = validateCredential(entry, providerId);
    return { id, ...credential };
  });
  return {
    strategy,
    cooldown_ms: positiveDuration(pool.cooldown_ms, 300_000, `provider ${providerId} credential_pool.cooldown_ms`),
    first_event_timeout_ms: positiveDuration(pool.first_event_timeout_ms, 20_000, `provider ${providerId} credential_pool.first_event_timeout_ms`),
    idle_timeout_ms: positiveDuration(pool.idle_timeout_ms, 45_000, `provider ${providerId} credential_pool.idle_timeout_ms`),
    entries,
  };
}

function validateModel(value, providerId, slug) {
  const model = structuredClone(object(value, `model ${slug}`));
  if (!slug || typeof slug !== "string") throw new Error(`provider ${providerId} has an invalid model slug`);
  const contextWindow = Number(model.context_window ?? 262144);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) throw new Error(`model ${slug} context_window is invalid`);
  const efforts = Array.isArray(model.reasoning_efforts) && model.reasoning_efforts.length
    ? [...new Set(model.reasoning_efforts.map(String))]
    : ["high"];
  const defaultEffort = String(model.default_reasoning_effort || efforts[0]);
  if (!efforts.includes(defaultEffort)) throw new Error(`model ${slug} default reasoning effort is not supported`);
  const visionMode = model.vision_mode || "delegated";
  if (!VISION_MODES.has(visionMode)) throw new Error(`model ${slug} vision_mode is invalid`);
  const visionMaxImagesPerTurn = Number(model.vision_max_images_per_turn ?? 8);
  if (!Number.isSafeInteger(visionMaxImagesPerTurn) || visionMaxImagesPerTurn < 1 || visionMaxImagesPerTurn > 64) {
    throw new Error(`model ${slug} vision_max_images_per_turn must be an integer from 1 to 64`);
  }
  const visionFailurePolicy = String(model.vision_failure_policy || "fail_request");
  if (!VISION_FAILURE_POLICIES.has(visionFailurePolicy)) throw new Error(`model ${slug} vision_failure_policy is invalid`);
  const searchMode = model.search_mode || "external";
  if (!SEARCH_MODES.has(searchMode)) throw new Error(`model ${slug} search_mode is invalid`);
  const apiProtocol = model.api_protocol || "responses";
  if (!API_PROTOCOLS.has(apiProtocol)) throw new Error(`model ${slug} api_protocol is invalid`);
  const toolProfile = normalizeProviderToolProfile(model.tool_protocol);
  return {
    display_name: String(model.display_name || `${slug} · ${providerId}`),
    description: String(model.description || `Responses model served by ${providerId}.`),
    upstream_model: String(model.upstream_model || slug),
    context_window: contextWindow,
    reasoning_efforts: efforts,
    default_reasoning_effort: defaultEffort,
    vision_mode: visionMode,
    vision_max_images_per_turn: visionMaxImagesPerTurn,
    vision_failure_policy: visionFailurePolicy,
    search_mode: searchMode,
    api_protocol: apiProtocol,
    tool_protocol: {
      namespaces: toolProfile.namespaces,
      custom_tools: toolProfile.customTools,
      deferred_tools: toolProfile.deferredTools,
      tool_search: toolProfile.toolSearch,
    },
  };
}

export function validateRegistry(value) {
  const root = object(value, "provider registry");
  if (root.version !== REGISTRY_VERSION) throw new Error(`provider registry version must be ${REGISTRY_VERSION}`);
  const providersValue = object(root.providers, "provider registry providers");
  const providers = {};
  const routes = new Map();
  for (const [providerId, rawProvider] of Object.entries(providersValue)) {
    if (!PROVIDER_ID.test(providerId)) throw new Error(`invalid provider id: ${providerId}`);
    const provider = object(rawProvider, `provider ${providerId}`);
    const models = {};
    for (const [slug, rawModel] of Object.entries(object(provider.models ?? {}, `provider ${providerId} models`))) {
      if (routes.has(slug)) throw new Error(`model route ${slug} is claimed by multiple providers`);
      models[slug] = validateModel(rawModel, providerId, slug);
      routes.set(slug, providerId);
    }
    providers[providerId] = {
      id: providerId,
      name: String(provider.name || providerId),
      base_url: normalizedBaseUrl(provider.base_url, providerId),
      credential: validateCredential(provider.credential, providerId),
      credential_pool: validateCredentialPool(provider.credential_pool, providerId),
      models,
    };
  }
  return { version: REGISTRY_VERSION, providers, routes };
}

export function publicRegistry(value) {
  const registry = validateRegistry(value);
  const providers = {};
  for (const [id, provider] of Object.entries(registry.providers)) {
    providers[id] = {
      ...provider,
      credential: {
        type: provider.credential.type,
        ...(provider.credential.header ? { header: provider.credential.header } : {}),
      },
      ...(provider.credential_pool ? {
        credential_pool: {
          ...provider.credential_pool,
          entries: provider.credential_pool.entries.map((entry) => ({
            id: entry.id,
            type: entry.type,
            ...(entry.header ? { header: entry.header } : {}),
          })),
        },
      } : {}),
    };
  }
  return { version: registry.version, providers };
}

export function resolveCredential(credential, environment = process.env, spawn = spawnSync) {
  if (!credential || credential.type === "none") return "";
  if (credential.type === "inline") return credential.api_key;
  if (credential.type === "env") return environment[credential.name] || "";
  if (credential.type === "keychain") {
    const result = spawn(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", credential.service, "-a", credential.account],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return result.status === 0 ? result.stdout.trim() : "";
  }
  return "";
}

export function writeRegistry(file, value) {
  validateRegistry(value);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export class ProviderRegistry {
  constructor(file, { onError = () => {} } = {}) {
    this.file = file;
    this.onError = onError;
    this.current = validateRegistry(defaultRegistry());
    this.lastSignature = null;
    this.lastError = null;
  }

  ensure() {
    if (!fs.existsSync(this.file)) writeRegistry(this.file, defaultRegistry());
    return this.reload(true);
  }

  reload(force = false) {
    try {
      const stat = fs.statSync(this.file, { bigint: true });
      const signature = `${stat.mtimeNs}:${stat.size}`;
      if (!force && signature === this.lastSignature) return this.current;
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.current = validateRegistry(parsed);
      this.lastSignature = signature;
      this.lastError = null;
    } catch (error) {
      const message = error?.message || String(error);
      if (message !== this.lastError) this.onError(message);
      this.lastError = message;
    }
    return this.current;
  }

  route(model) {
    const registry = this.reload();
    const providerId = registry.routes.get(model);
    if (!providerId) return null;
    const provider = registry.providers[providerId];
    return { provider, model: provider.models[model] };
  }

  status() {
    const registry = this.reload();
    return {
      providers: Object.keys(registry.providers).length,
      models: registry.routes.size,
      error: this.lastError,
    };
  }
}
