import crypto from "node:crypto";

const FUNCTION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_FUNCTION_NAME = 64;
const LAZY_NAMESPACE_PATTERNS = new Map([
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

function namespacePairs(tools) {
  const pairs = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) continue;
    for (const child of tool.tools) {
      if (!child || typeof child.name !== "string" || !child.name) continue;
      pairs.push({ namespace: tool.name, name: child.name, tool: child });
    }
  }
  return pairs;
}

function additionalToolCollections(input) {
  const collections = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) collections.push(item.tools);
  }
  return collections;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (typeof item === "string" ? item : item?.text ?? item?.input_text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function latestUserText(input) {
  if (typeof input === "string") return input;
  let latest = "";
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.role === "user") latest = contentText(item.content);
  }
  return latest;
}

function historyUsesNamespace(value, namespace) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((child) => historyUsesNamespace(child, namespace));
  if (value.namespace === namespace) return true;
  if (typeof value.name === "string") {
    const prefix = namespace.endsWith("__") ? namespace : `${namespace}__`;
    if (value.name.startsWith(prefix)) return true;
  }
  return Object.values(value).some((child) => historyUsesNamespace(child, namespace));
}

function activeNamespacePairs(body, pairs) {
  const userText = latestUserText(body.input);
  return pairs.filter((pair) => {
    const pattern = LAZY_NAMESPACE_PATTERNS.get(pair.namespace);
    if (!pattern) return true;
    if (pattern.test(userText)) return true;
    if (historyUsesNamespace(body.input, pair.namespace)) return true;
    if (body.tool_choice?.namespace === pair.namespace) return true;
    if (body.tool_choice?.function?.namespace === pair.namespace) return true;
    return false;
  });
}

export class NamespaceBridge {
  constructor() {
    this.aliases = new Map();
    this.tuples = new Map();
  }

  register(alias, namespace, name) {
    if (!alias || !namespace || !name) return false;
    const existing = this.aliases.get(alias);
    if (existing && (existing.namespace !== namespace || existing.name !== name)) return false;
    this.aliases.set(alias, { namespace, name });
    const key = tupleKey(namespace, name);
    if (!this.tuples.has(key)) this.tuples.set(key, alias);
    return true;
  }

  aliasFor(namespace, name) {
    return this.tuples.get(tupleKey(namespace, name));
  }

  targetFor(alias) {
    return this.aliases.get(alias);
  }

  merge(other) {
    if (!other) return this;
    for (const [alias, target] of other.aliases) this.register(alias, target.namespace, target.name);
    return this;
  }
}

function flattenHistoryValue(value, bridge) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) flattenHistoryValue(child, bridge);
    return;
  }
  if (
    ["function_call", "custom_tool_call", "tool_search_call"].includes(value.type) &&
    typeof value.name === "string" &&
    typeof value.namespace === "string"
  ) {
    const alias = bridge.aliasFor(value.namespace, value.name) ?? preferredAlias(value.namespace, value.name);
    bridge.register(alias, value.namespace, value.name);
    value.name = alias;
    delete value.namespace;
  }
  for (const child of Object.values(value)) flattenHistoryValue(child, bridge);
}

function flattenToolChoice(body, bridge) {
  const choice = body?.tool_choice;
  if (!choice || typeof choice !== "object") return;
  const targets = [choice, choice.function].filter((value) => value && typeof value === "object");
  for (const target of targets) {
    if (typeof target.name !== "string" || typeof target.namespace !== "string") continue;
    const alias = bridge.aliasFor(target.namespace, target.name) ?? preferredAlias(target.namespace, target.name);
    bridge.register(alias, target.namespace, target.name);
    target.name = alias;
    delete target.namespace;
  }
  delete choice.namespace;
}

export function adaptNamespacesForProvider(originalBody, seedBridge) {
  const body = clone(originalBody);
  const bridge = new NamespaceBridge().merge(seedBridge);
  const topTools = Array.isArray(body.tools) ? body.tools : [];
  const extraCollections = additionalToolCollections(body.input);
  const allCollections = [topTools, ...extraCollections];
  const allTools = allCollections.flat();
  const pairs = activeNamespacePairs(body, allCollections.flatMap(namespacePairs));
  const directNames = new Set(
    allTools
      .filter((tool) => tool?.type !== "namespace" && typeof tool?.name === "string")
      .map((tool) => tool.name),
  );
  const shortCounts = new Map();
  for (const pair of pairs) shortCounts.set(pair.name, (shortCounts.get(pair.name) || 0) + 1);

  const outputTools = [];
  const emittedNames = new Set();
  const emit = (tool) => {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (name && emittedNames.has(name)) return;
    if (name) emittedNames.add(name);
    outputTools.push(tool);
  };

  for (const tool of allTools) {
    if (tool?.type !== "namespace") emit(clone(tool));
  }
  for (const pair of pairs) {
    let alias = preferredAlias(pair.namespace, pair.name);
    if (directNames.has(alias)) {
      const digest = crypto.createHash("sha256").update(tupleKey(pair.namespace, pair.name)).digest("hex").slice(0, 24);
      alias = `hybrid_ns_${digest}`;
    }
    bridge.register(alias, pair.namespace, pair.name);
    emit(asFunctionTool(pair.tool, alias));
    if (shortCounts.get(pair.name) === 1 && !directNames.has(pair.name)) {
      bridge.register(pair.name, pair.namespace, pair.name);
    }
  }

  if (Array.isArray(body.tools) || pairs.length || extraCollections.length) body.tools = outputTools;
  if (Array.isArray(body.input) && extraCollections.length) {
    body.input = body.input.filter((item) => item?.type !== "additional_tools");
  }
  flattenHistoryValue(body.input, bridge);
  flattenToolChoice(body, bridge);
  return { body, bridge };
}

export function restoreNamespaces(value, bridge) {
  if (!value || typeof value !== "object" || !bridge) return value;
  if (Array.isArray(value)) {
    for (const child of value) restoreNamespaces(child, bridge);
    return value;
  }
  if (value.type === "function_call" && typeof value.name === "string" && !value.namespace) {
    const target = bridge.targetFor(value.name);
    if (target) {
      value.name = target.name;
      value.namespace = target.namespace;
    }
  }
  for (const child of Object.values(value)) restoreNamespaces(child, bridge);
  return value;
}
