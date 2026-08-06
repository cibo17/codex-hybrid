const HYBRID_VISION_NAMESPACE = "mcp__hybrid_vision";
const DIRECT_TOOL_NAMES = new Set(["analyze_image", `${HYBRID_VISION_NAMESPACE}__analyze_image`]);

function bindTool(tool, contextId) {
  if (!tool || typeof tool !== "object") return;
  if (tool.type === "namespace") {
    if (tool.name === HYBRID_VISION_NAMESPACE && Array.isArray(tool.tools)) {
      for (const child of tool.tools) if (child?.name === "analyze_image") bindTool(child, contextId);
    }
    return;
  }
  if (!DIRECT_TOOL_NAMES.has(tool.name)) return;
  const schemaKey = tool.parameters ? "parameters" : tool.input_schema ? "input_schema" : "parameters";
  const schema = structuredClone(tool[schemaKey] || { type: "object", properties: {} });
  schema.properties = { ...(schema.properties || {}) };
  schema.properties._hybrid_context_id = {
    type: "string",
    enum: [contextId],
    description: "Internal Hybrid vision capability. Preserve this exact value when calling the tool.",
  };
  schema.required = [...new Set([...(schema.required || []), "_hybrid_context_id"])];
  tool[schemaKey] = schema;
}

function bindCollections(value, contextId) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) bindCollections(child, contextId);
    return;
  }
  if (Array.isArray(value.tools)) for (const tool of value.tools) bindTool(tool, contextId);
  for (const child of Object.values(value)) bindCollections(child, contextId);
}

export class VisionCapability {
  constructor(contextId = null) {
    this.contextId = contextId || null;
    Object.freeze(this);
  }

  get active() {
    return Boolean(this.contextId);
  }

  augmentBody(body) {
    const result = structuredClone(body);
    if (this.active) bindCollections(result, this.contextId);
    return result;
  }

  isCall(item) {
    if (!item || typeof item !== "object") return false;
    return (
      (item.namespace === HYBRID_VISION_NAMESPACE && item.name === "analyze_image") ||
      (!item.namespace && ["analyze_image", `${HYBRID_VISION_NAMESPACE}__analyze_image`].includes(item.name))
    );
  }

  bindArguments(argumentsText) {
    if (!this.active) return argumentsText;
    try {
      const args = JSON.parse(argumentsText || "{}");
      return JSON.stringify({ ...args, _hybrid_context_id: this.contextId });
    } catch {
      return JSON.stringify({ _hybrid_context_id: this.contextId });
    }
  }

  decorateCall(item) {
    if (!this.active || !this.isCall(item)) return item;
    return { ...item, arguments: this.bindArguments(item.arguments) };
  }

  bindExecSource(source) {
    if (
      typeof source !== "string" ||
      !source.includes(`${HYBRID_VISION_NAMESPACE}__analyze_image`) ||
      !this.active
    ) return source;
    const context = JSON.stringify(this.contextId);
    const pragmaMatch = source.match(/^(\s*\/\/\s*@exec:[^\r\n]*(?:\r?\n)?)/);
    const pragma = pragmaMatch?.[1] || "";
    const body = pragma ? source.slice(pragma.length) : source;
    return `${pragma}const __hybridVisionTools = new Proxy(tools, { get(target, property) {\n` +
      `  if (property === "${HYBRID_VISION_NAMESPACE}__analyze_image") return (args = {}) => target[property]({ ...args, _hybrid_context_id: ${context} });\n` +
      `  return target[property];\n` +
      `} });\n` +
      `await (async (tools) => {\n${body}\n})(__hybridVisionTools);`;
  }
}
