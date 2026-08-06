function clone(value) {
  return structuredClone(value);
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

function demandText(input) {
  if (typeof input === "string") return input;
  const relevant = (Array.isArray(input) ? input : []).filter((item) =>
    ["function_call", "custom_tool_call", "tool_search_call"].includes(item?.type),
  );
  return JSON.stringify(relevant);
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

function namespaceEntries(tools, source) {
  const entries = [];
  for (const tool of tools) {
    if (tool?.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) continue;
    for (const child of tool.tools) {
      if (!child || typeof child.name !== "string" || !child.name) continue;
      entries.push({ namespace: tool.name, name: child.name, tool: clone(child), source });
    }
  }
  return entries;
}

/**
 * Immutable, per-turn snapshot of the tools and history advertised by Codex.
 * It deliberately contains no provider aliases or response-stream state.
 */
export class ToolInventory {
  #body;

  constructor(body) {
    this.#body = clone(body || {});
    const topTools = Array.isArray(this.#body.tools) ? this.#body.tools : [];
    const deferredCollections = [];
    for (const item of Array.isArray(this.#body.input) ? this.#body.input : []) {
      if (item?.type === "additional_tools" && Array.isArray(item.tools)) deferredCollections.push(item.tools);
    }

    this.topTools = Object.freeze(clone(topTools));
    this.deferredCollections = Object.freeze(deferredCollections.map((tools) => Object.freeze(clone(tools))));
    this.namespaceEntries = Object.freeze([
      ...namespaceEntries(topTools, "top"),
      ...deferredCollections.flatMap((tools) => namespaceEntries(tools, "deferred")),
    ]);
    this.latestUserText = latestUserText(this.#body.input);
    this.demandText = `${this.latestUserText}\n${demandText(this.#body.input)}`;
    this.codeMode = topTools.some((tool) => tool?.type === "custom" && tool?.name === "exec");
    Object.freeze(this);
  }

  static from(body) {
    return new ToolInventory(body);
  }

  body() {
    return clone(this.#body);
  }

  historyUses(namespace) {
    return historyUsesNamespace(this.#body.input, namespace);
  }

  toolChoiceUses(namespace) {
    const choice = this.#body.tool_choice;
    return choice?.namespace === namespace || choice?.function?.namespace === namespace;
  }
}
