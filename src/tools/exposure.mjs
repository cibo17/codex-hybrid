import crypto from "node:crypto";
import { compactExecTool } from "./exec-catalog.mjs";

const FUNCTION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_FUNCTION_NAME = 64;
const HYBRID_VISION_NAMESPACE = "mcp__hybrid_vision";

const DEFAULT_LAZY_NAMESPACES = new Map([
  ["mcp__codex_apps__linear", /\blinear\b/i],
  ["mcp__codex_apps__atlassian_rovo", /\b(?:atlassian|jira|confluence|rovo)\b|阿特拉西安/i],
]);

function clone(value) {
  return structuredClone(value);
}

function tupleKey(namespace, name) {
  return `${namespace}\u0000${name}`;
}

function preferredAlias(namespace, name) {
  const separator = namespace.endsWith("__") ? "" : "__";
  const candidate = `${namespace}${separator}${name}`;
  if (candidate.length <= MAX_FUNCTION_NAME && FUNCTION_NAME_RE.test(candidate)) return candidate;
  const digest = crypto.createHash("sha256").update(tupleKey(namespace, name)).digest("hex").slice(0, 24);
  return `hybrid_ns_${digest}`;
}

export function directMcpTarget(name) {
  if (typeof name !== "string" || !name.startsWith("mcp__")) return null;
  const separator = name.lastIndexOf("__");
  if (separator <= "mcp__".length || separator >= name.length - 2) return null;
  return { namespace: name.slice(0, separator), name: name.slice(separator + 2) };
}

function isHybridVisionTool(tool) {
  const name = String(tool?.name || "");
  return name === HYBRID_VISION_NAMESPACE || name === `${HYBRID_VISION_NAMESPACE}__analyze_image` || name === "analyze_image";
}

function asFunctionTool(tool, name) {
  const result = {
    type: "function",
    name,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: clone(tool.parameters ?? tool.input_schema ?? { type: "object", properties: {} }),
  };
  if (typeof tool.strict === "boolean") result.strict = tool.strict;
  return result;
}

function isExaTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  const name = String(tool.name || "");
  if (tool.type === "namespace") return /(?:^|__)exa(?:__|$)/i.test(name);
  return /(?:^|__)exa(?:__|$)/i.test(name) || /_exa$/i.test(name);
}

function stripExaToolCollections(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) stripExaToolCollections(child);
    return;
  }
  if (Array.isArray(value.tools)) value.tools = value.tools.filter((tool) => !isExaTool(tool));
  for (const child of Object.values(value)) stripExaToolCollections(child);
}

function stripToolSearch(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const child = value[index];
      if (["tool_search_call", "tool_search_output"].includes(child?.type)) value.splice(index, 1);
      else stripToolSearch(child);
    }
    return;
  }
  if (Array.isArray(value.tools)) value.tools = value.tools.filter((tool) => tool?.type !== "tool_search");
  for (const child of Object.values(value)) stripToolSearch(child);
}

export class ToolAliasTable {
  #aliases = new Map();
  #tuples = new Map();

  register(alias, namespace, name) {
    if (!alias || !namespace || !name) return false;
    const existing = this.#aliases.get(alias);
    if (existing && (existing.namespace !== namespace || existing.name !== name)) return false;
    this.#aliases.set(alias, { namespace, name });
    const key = tupleKey(namespace, name);
    if (!this.#tuples.has(key)) this.#tuples.set(key, alias);
    return true;
  }

  aliasFor(namespace, name) {
    return this.#tuples.get(tupleKey(namespace, name));
  }

  targetFor(alias) {
    return this.#aliases.get(alias);
  }
}

export class ExposurePlan {
  constructor({ body, aliases = new ToolAliasTable() }) {
    this.body = body;
    this.aliases = aliases;
    Object.freeze(this);
  }
}

export class ExposurePlanner {
  constructor({ lazyNamespaces = DEFAULT_LAZY_NAMESPACES } = {}) {
    this.lazyNamespaces = lazyNamespaces;
  }

  namespaceIsActive(inventory, namespace) {
    const pattern = this.lazyNamespaces.get(namespace);
    return !pattern || pattern.test(inventory.latestUserText) || inventory.historyUses(namespace) || inventory.toolChoiceUses(namespace);
  }

  plan(inventory, { profile, nativeSearch = false } = {}) {
    const body = inventory.body();
    if (nativeSearch) {
      stripExaToolCollections(body);
      if (isExaTool(body.tool_choice) || isExaTool(body.tool_choice?.function)) body.tool_choice = "auto";
    }
    if (profile.toolSearch === "disabled") stripToolSearch(body);
    if (profile.namespaces === "native") return new ExposurePlan({ body });

    const aliases = new ToolAliasTable();
    const topTools = Array.isArray(body.tools) ? body.tools : [];
    const deferredCollections = [];
    for (const item of Array.isArray(body.input) ? body.input : []) {
      if (item?.type === "additional_tools" && Array.isArray(item.tools)) deferredCollections.push(item.tools);
    }

    for (const entry of inventory.namespaceEntries) {
      aliases.register(preferredAlias(entry.namespace, entry.name), entry.namespace, entry.name);
    }
    for (const tool of [...topTools, ...deferredCollections.flat()]) {
      const target = directMcpTarget(tool?.name);
      if (target) aliases.register(tool.name, target.namespace, target.name);
    }

    const keepDeferred = inventory.codeMode && profile.deferredTools === "code_mode";
    const extraCollections = keepDeferred
      ? deferredCollections.map((tools) => tools.filter(isHybridVisionTool)).filter((tools) => tools.length)
      : deferredCollections;
    const providerTopTools = keepDeferred
      ? topTools.filter((tool) => !String(tool?.name || "").startsWith("mcp__") || isHybridVisionTool(tool))
      : topTools;
    const allTools = [providerTopTools, ...extraCollections].flat();
    const activeEntries = inventory.namespaceEntries.filter((entry) => {
      if (nativeSearch && isExaTool({ type: "namespace", name: entry.namespace })) return false;
      if (entry.source === "deferred" && keepDeferred && entry.namespace !== HYBRID_VISION_NAMESPACE) return false;
      return this.namespaceIsActive(inventory, entry.namespace);
    });
    const directNames = new Set(
      allTools.filter((tool) => tool?.type !== "namespace" && typeof tool?.name === "string").map((tool) => tool.name),
    );
    const shortCounts = new Map();
    for (const entry of activeEntries) shortCounts.set(entry.name, (shortCounts.get(entry.name) || 0) + 1);

    const outputTools = [];
    const emittedNames = new Set();
    const emit = (tool) => {
      const name = typeof tool?.name === "string" ? tool.name : "";
      if (name && emittedNames.has(name)) return;
      if (name) emittedNames.add(name);
      outputTools.push(clone(tool));
    };
    for (const tool of allTools) {
      if (tool?.type !== "namespace") emit(compactExecTool(tool, inventory.demandText));
    }
    for (const entry of activeEntries) {
      let alias = preferredAlias(entry.namespace, entry.name);
      if (directNames.has(alias)) {
        const digest = crypto.createHash("sha256").update(tupleKey(entry.namespace, entry.name)).digest("hex").slice(0, 24);
        alias = `hybrid_ns_${digest}`;
      }
      aliases.register(alias, entry.namespace, entry.name);
      emit(asFunctionTool(entry.tool, alias));
      if (shortCounts.get(entry.name) === 1 && !directNames.has(entry.name)) aliases.register(entry.name, entry.namespace, entry.name);
    }

    if (Array.isArray(body.tools) || activeEntries.length || extraCollections.length) body.tools = outputTools;
    if (Array.isArray(body.input) && deferredCollections.length) {
      body.input = body.input.filter((item) => item?.type !== "additional_tools");
    }
    flattenHistoryValue(body.input, aliases);
    flattenToolChoice(body, aliases);
    return new ExposurePlan({ body, aliases });
  }
}

function flattenHistoryValue(value, aliases) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) flattenHistoryValue(child, aliases);
    return;
  }
  if (
    ["function_call", "custom_tool_call", "tool_search_call"].includes(value.type) &&
    typeof value.name === "string" &&
    typeof value.namespace === "string"
  ) {
    const alias = aliases.aliasFor(value.namespace, value.name) ?? preferredAlias(value.namespace, value.name);
    aliases.register(alias, value.namespace, value.name);
    value.name = alias;
    delete value.namespace;
  }
  for (const child of Object.values(value)) flattenHistoryValue(child, aliases);
}

function flattenToolChoice(body, aliases) {
  const choice = body?.tool_choice;
  if (!choice || typeof choice !== "object") return;
  const targets = [choice, choice.function].filter((value) => value && typeof value === "object");
  for (const target of targets) {
    if (typeof target.name !== "string" || typeof target.namespace !== "string") continue;
    const alias = aliases.aliasFor(target.namespace, target.name) ?? preferredAlias(target.namespace, target.name);
    aliases.register(alias, target.namespace, target.name);
    target.name = alias;
    delete target.namespace;
  }
  delete choice.namespace;
}
