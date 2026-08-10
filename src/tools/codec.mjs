import { ExposurePlanner, directMcpTarget } from "./exposure.mjs";
import { ToolInventory } from "./inventory.mjs";
import { normalizeProviderToolProfile } from "./profile.mjs";
import { compactSkillsCatalog } from "./skills-catalog.mjs";
import { VisionCapability } from "./vision-capability.mjs";

function customInputFromArguments(argumentsText, argumentKey = "input") {
  if (typeof argumentsText !== "string") return "";
  try {
    const value = JSON.parse(argumentsText);
    if (typeof value?.[argumentKey] === "string") return value[argumentKey];
    if (typeof value?.input === "string") return value.input;
  } catch {
    // Some compatible servers return raw custom-tool input in arguments.
  }
  return argumentsText;
}

function portableCustomTool(tool, customTools) {
  if (tool?.type !== "custom" || typeof tool?.name !== "string") return tool;
  const argumentKey = tool.name === "apply_patch" ? "patch" : "input";
  customTools.set(tool.name, argumentKey);
  return {
    type: "function",
    name: tool.name,
    description: tool.description || `Run the ${tool.name} custom tool.`,
    parameters: {
      type: "object",
      properties: {
        [argumentKey]: {
          type: "string",
          description: tool.name === "apply_patch"
            ? "The complete apply_patch patch text."
            : "The complete raw input for this custom tool.",
        },
      },
      required: [argumentKey],
      additionalProperties: false,
    },
  };
}

function adaptInputItem(item, customTools) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "custom_tool_call" && customTools.has(item.name)) {
    const argumentKey = customTools.get(item.name);
    const result = { ...item, type: "function_call", arguments: JSON.stringify({ [argumentKey]: item.input || "" }) };
    delete result.input;
    return result;
  }
  if (item.type === "custom_tool_call_output") return { ...item, type: "function_call_output" };
  return item;
}

function stripCodexExtensions(body) {
  for (const key of [
    "background",
    "client_metadata",
    "conversation",
    "include",
    "metadata",
    "previous_response_id",
    "prompt",
    "prompt_cache_key",
    "prompt_cache_retention",
    "safety_identifier",
    "service_tier",
    "store",
    "stream_options",
  ]) delete body[key];
  if (body.text && typeof body.text === "object") {
    const text = { ...body.text };
    delete text.verbosity;
    if (Object.keys(text).length === 0) delete body.text;
    else body.text = text;
  }
}

function restoreNamespace(item, aliases) {
  if (!item || typeof item !== "object") return item;
  if (["function_call", "tool_search_call"].includes(item.type) && typeof item.name === "string" && !item.namespace) {
    const target = aliases.targetFor(item.name) || directMcpTarget(item.name);
    if (target) {
      const restored = { ...item, name: target.name };
      if (target.namespace) restored.namespace = target.namespace;
      else delete restored.namespace;
      return restored;
    }
  }
  return item;
}

function reasoningTextContent(item) {
  if (!Array.isArray(item?.content)) return [];
  return item.content.filter(
    (part) => part?.type === "reasoning_text" && typeof part.text === "string",
  );
}

function projectProviderReasoning(item, providerId) {
  if (item?.type !== "reasoning" || !providerId) return item;
  const rawContent = reasoningTextContent(item);
  const nativeSummary = Array.isArray(item.summary) ? item.summary : [];
  const summary = nativeSummary.length
    ? structuredClone(nativeSummary)
    : rawContent.map((part) => ({ type: "summary_text", text: part.text }));
  const metadata = {
    ...(item.internal_chat_message_metadata_passthrough || {}),
    hybrid_provider_id: providerId,
  };
  if (rawContent.length) metadata.hybrid_reasoning_content = structuredClone(rawContent);
  return {
    ...item,
    summary,
    content: [],
    internal_chat_message_metadata_passthrough: metadata,
  };
}

function transformOutputItem(item, state) {
  if (!item || typeof item !== "object") return item;
  const providerName = item.name;
  let restored = restoreNamespace(structuredClone(item), state.aliases);
  restored = state.vision.decorateCall(restored);
  restored = projectProviderReasoning(restored, state.providerId);
  const argumentKey = !restored.namespace
    ? state.customTools.get(providerName) ?? state.customTools.get(restored.name)
    : undefined;
  if (restored.type === "function_call" && argumentKey) {
    const { arguments: argumentsText, ...rest } = restored;
    let input = customInputFromArguments(argumentsText, argumentKey);
    if (restored.name === "exec") input = state.vision.bindExecSource(input);
    return { ...rest, type: "custom_tool_call", input };
  }
  return restored;
}

function transformResponse(value, state) {
  if (!value || typeof value !== "object") return value;
  const transformed = { ...value };
  if (Array.isArray(transformed.output)) transformed.output = transformed.output.map((item) => transformOutputItem(item, state));
  if (transformed.response && typeof transformed.response === "object") {
    transformed.response = transformResponse(transformed.response, state);
  }
  if (transformed.item && typeof transformed.item === "object") transformed.item = transformOutputItem(transformed.item, state);
  return transformed;
}

class ToolCallReducer {
  constructor(state) {
    this.state = state;
    this.customToolKeys = new Map();
    this.customNames = new Map();
    this.argumentBuffers = new Map();
    this.visionToolKeys = new Set();
    this.reasoningKeys = new Set();
    this.reasoningSummaryParts = new Set();
  }

  keyFor(data) {
    return String(data.item_id ?? data.call_id ?? data.id ?? data.output_index ?? "unknown");
  }

  adapt(eventName, originalData) {
    if (eventName === "response.output_item.added") {
      const originalItem = originalData?.item;
      const key = this.keyFor({ ...originalData, ...originalItem });
      if (originalItem?.type === "reasoning") this.reasoningKeys.add(key);
      if (this.state.vision.isCall(originalItem)) this.visionToolKeys.add(key);
      if (originalItem?.type === "function_call" && this.state.customTools.has(originalItem.name)) {
        this.customToolKeys.set(key, this.state.customTools.get(originalItem.name));
        this.customNames.set(key, originalItem.name);
      }
    }
    let data = transformResponse(originalData, this.state);

    const reasoningKey = this.keyFor({ ...data, ...(data?.item || {}) });
    const isReasoningItemAdded = eventName === "response.output_item.added"
      && (data?.item?.type === "reasoning" || this.reasoningKeys.has(reasoningKey));
    const isReasoningItemDone = eventName === "response.output_item.done"
      && (data?.item?.type === "reasoning" || this.reasoningKeys.has(reasoningKey));
    const isReasoningPartEvent = ["response.content_part.added", "response.content_part.done"].includes(eventName)
      && (data?.part?.type === "reasoning_text" || this.reasoningKeys.has(reasoningKey));
    if (isReasoningItemDone) {
      this.reasoningKeys.delete(reasoningKey);
      return [{ eventName, data }];
    }
    if (eventName === "response.reasoning_text.delta") {
      const summaryIndex = Number.isInteger(data.content_index) ? data.content_index : 0;
      const partKey = `${reasoningKey}:${summaryIndex}`;
      const events = [];
      if (!this.reasoningSummaryParts.has(partKey)) {
        this.reasoningSummaryParts.add(partKey);
        events.push({
          eventName: "response.reasoning_summary_part.added",
          data: {
            ...data,
            type: "response.reasoning_summary_part.added",
            summary_index: summaryIndex,
            part: { type: "summary_text", text: "" },
          },
        });
      }
      events.push({
        eventName: "response.reasoning_summary_text.delta",
        data: {
          ...data,
          type: "response.reasoning_summary_text.delta",
          summary_index: summaryIndex,
        },
      });
      // Codex's sequential-cutoff renderer intentionally ignores summary
      // deltas for OpenAI-compatible providers and only surfaces `done`
      // events. Mirror each provider delta as an atomic cutoff as well: the
      // desktop keeps streaming immediately, while Remote still receives the
      // structured summary channel instead of raw reasoning events.
      events.push({
        eventName: "response.reasoning_summary_text.done",
        data: {
          ...data,
          type: "response.reasoning_summary_text.done",
          summary_index: summaryIndex,
          text: data.delta || "",
        },
      });
      return events;
    }
    if (eventName === "response.reasoning_text.done") {
      // Every raw delta was already emitted as a summary cutoff. Replaying the
      // provider's cumulative done text would duplicate the visible summary.
      return [];
    }
    if (isReasoningItemAdded) return [{ eventName, data }];
    if (isReasoningPartEvent) {
      return [];
    }

    if (eventName === "response.function_call_arguments.delta") {
      const key = this.keyFor(data);
      if (this.visionToolKeys.has(key) || this.customToolKeys.has(key)) {
        this.argumentBuffers.set(key, (this.argumentBuffers.get(key) || "") + (data.delta || ""));
        return [];
      }
    }

    if (eventName === "response.function_call_arguments.done") {
      const key = this.keyFor(data);
      if (this.visionToolKeys.has(key) && this.state.vision.active) {
        data = { ...data, arguments: this.state.vision.bindArguments(data.arguments || this.argumentBuffers.get(key) || "{}") };
        this.argumentBuffers.delete(key);
        this.visionToolKeys.delete(key);
        return [
          {
            eventName: "response.function_call_arguments.delta",
            data: { ...data, type: "response.function_call_arguments.delta", delta: data.arguments, arguments: undefined },
          },
          { eventName, data },
        ];
      }
      if (this.customToolKeys.has(key)) {
        let input = customInputFromArguments(
          data.arguments || this.argumentBuffers.get(key) || "",
          this.customToolKeys.get(key),
        );
        const customName = this.customNameForKey(key);
        if (customName === "exec") input = this.state.vision.bindExecSource(input);
        const common = { ...data };
        delete common.arguments;
        delete common.delta;
        this.argumentBuffers.delete(key);
        this.customToolKeys.delete(key);
        this.customNames.delete(key);
        return [
          { eventName: "response.custom_tool_call_input.delta", data: { ...common, type: "response.custom_tool_call_input.delta", delta: input } },
          { eventName: "response.custom_tool_call_input.done", data: { ...common, type: "response.custom_tool_call_input.done", input } },
        ];
      }
    }
    return [{ eventName, data }];
  }

  customNameForKey(key) {
    // The transformed output-item event already carries the name, but the done
    // event often does not. Keep a separate reverse lookup without leaking it
    // into the turn-wide codec state.
    return this.customNames.get(key);
  }
}

export class ProviderToolTurn {
  #state;

  constructor({ upstreamBody, aliases, customTools, vision }) {
    this.upstreamBody = upstreamBody;
    this.#state = Object.freeze({ aliases, customTools, vision });
    Object.freeze(this);
  }

  adaptResponse(value, { providerId = null } = {}) {
    return transformResponse(value, { ...this.#state, providerId });
  }

  createEventReducer({ providerId = null } = {}) {
    return new ToolCallReducer({ ...this.#state, providerId });
  }
}

export class ProviderToolCodec {
  constructor({ planner = new ExposurePlanner() } = {}) {
    this.planner = planner;
  }

  prepare(body, { profile: profileValue = {}, nativeSearch = false, visionContextId = null } = {}) {
    const profile = normalizeProviderToolProfile(profileValue);
    const vision = new VisionCapability(visionContextId);
    const inventory = ToolInventory.from(vision.augmentBody(compactSkillsCatalog(body)));
    const plan = this.planner.plan(inventory, { profile, nativeSearch });
    const adapted = plan.body;
    const customTools = new Map();
    if (profile.customTools === "function" && Array.isArray(adapted.tools)) {
      adapted.tools = adapted.tools.map((tool) => portableCustomTool(tool, customTools));
      if (Array.isArray(adapted.input)) adapted.input = adapted.input.map((item) => adaptInputItem(item, customTools));
      if (adapted.tool_choice?.type === "custom" && customTools.has(adapted.tool_choice.name)) {
        adapted.tool_choice = { ...adapted.tool_choice, type: "function" };
      }
    }
    stripCodexExtensions(adapted);
    return new ProviderToolTurn({
      upstreamBody: adapted,
      aliases: plan.aliases,
      customTools,
      vision,
    });
  }
}
