import { Readable, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import {
  adaptNamespacesForProvider,
  restoreNamespaces,
} from "./namespaces.mjs";

function patchFromArguments(argumentsText) {
  if (typeof argumentsText !== "string") return "";
  try {
    const value = JSON.parse(argumentsText);
    if (typeof value?.patch === "string") return value.patch;
    if (typeof value?.input === "string") return value.input;
  } catch {
    // Some compatible servers put the raw patch in arguments.
  }
  return argumentsText;
}

function adaptApplyPatchTool(tool) {
  if (tool?.type !== "custom" || tool?.name !== "apply_patch") return tool;
  return {
    type: "function",
    name: "apply_patch",
    description: tool.description || "Apply a patch to files in the workspace.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "The complete apply_patch patch text.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  };
}

function adaptInputItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "custom_tool_call" && item.name === "apply_patch") {
    return {
      ...item,
      type: "function_call",
      arguments: JSON.stringify({ patch: item.input || "" }),
      input: undefined,
    };
  }
  if (item.type === "custom_tool_call_output") {
    return { ...item, type: "function_call_output" };
  }
  return item;
}

export function adaptRequestForProvider(body, seedBridge) {
  const namespaceResult = adaptNamespacesForProvider(body, seedBridge);
  const adapted = namespaceResult.body;
  if (Array.isArray(adapted.tools)) adapted.tools = adapted.tools.map(adaptApplyPatchTool);
  if (Array.isArray(adapted.input)) adapted.input = adapted.input.map(adaptInputItem);

  // These fields are ChatGPT/Codex extensions rather than portable Responses fields.
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
  ]) delete adapted[key];

  if (adapted.text && typeof adapted.text === "object") {
    const text = { ...adapted.text };
    delete text.verbosity;
    if (Object.keys(text).length === 0) delete adapted.text;
    else adapted.text = text;
  }
  return { body: adapted, bridge: namespaceResult.bridge };
}

function transformOutputItem(item, bridge) {
  if (!item || typeof item !== "object") return item;
  const restored = restoreNamespaces(structuredClone(item), bridge);
  if (restored.type === "function_call" && restored.name === "apply_patch" && !restored.namespace) {
    const { arguments: argumentsText, ...rest } = restored;
    return {
      ...rest,
      type: "custom_tool_call",
      input: patchFromArguments(argumentsText),
    };
  }
  return restored;
}

export function transformResponseObject(value, bridge) {
  if (!value || typeof value !== "object") return value;
  const transformed = { ...value };
  if (Array.isArray(transformed.output)) {
    transformed.output = transformed.output.map((item) => transformOutputItem(item, bridge));
  }
  if (transformed.response && typeof transformed.response === "object") {
    transformed.response = transformResponseObject(transformed.response, bridge);
  }
  if (transformed.item && typeof transformed.item === "object") {
    transformed.item = transformOutputItem(transformed.item, bridge);
  }
  return transformed;
}

function sseBlock(eventName, data) {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class ResponsesEventAdapter {
  constructor(bridge) {
    this.bridge = bridge;
    this.applyPatchKeys = new Set();
    this.argumentBuffers = new Map();
  }

  keyFor(data) {
    return String(data.item_id ?? data.call_id ?? data.id ?? data.output_index ?? "unknown");
  }

  adapt(eventName, originalData) {
    let data = transformResponseObject(originalData, this.bridge);
    if (
      eventName === "response.output_item.added" &&
      data.item?.name === "apply_patch" &&
      !data.item?.namespace
    ) {
      const key = this.keyFor({ ...data, ...data.item });
      this.applyPatchKeys.add(key);
      return [{ eventName, data }];
    }

    if (eventName === "response.function_call_arguments.delta") {
      const key = this.keyFor(data);
      if (this.applyPatchKeys.has(key)) {
        this.argumentBuffers.set(key, (this.argumentBuffers.get(key) || "") + (data.delta || ""));
        return [];
      }
    }

    if (eventName === "response.function_call_arguments.done") {
      const key = this.keyFor(data);
      if (this.applyPatchKeys.has(key)) {
        const patch = patchFromArguments(data.arguments || this.argumentBuffers.get(key) || "");
        const common = { ...data };
        delete common.arguments;
        delete common.delta;
        this.argumentBuffers.delete(key);
        return [
          {
            eventName: "response.custom_tool_call_input.delta",
            data: { ...common, type: "response.custom_tool_call_input.delta", delta: patch },
          },
          {
            eventName: "response.custom_tool_call_input.done",
            data: { ...common, type: "response.custom_tool_call_input.done", input: patch },
          },
        ];
      }
    }

    return [{ eventName, data }];
  }
}

export function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataText = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!eventName || !dataText || dataText === "[DONE]") return null;
  try {
    return { eventName, data: JSON.parse(dataText) };
  } catch {
    return null;
  }
}

export class ResponsesSseAdapter extends Transform {
  constructor(bridge) {
    super();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.adapter = new ResponsesEventAdapter(bridge);
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += this.decoder.write(chunk);
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = blocks.pop() || "";
    try {
      for (const block of blocks) this.processBlock(block);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.buffer += this.decoder.end();
      if (this.buffer.trim()) this.processBlock(this.buffer);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  processBlock(block) {
    const parsed = parseSseBlock(block);
    if (!parsed) {
      this.push(`${block}\n\n`);
      return;
    }
    for (const event of this.adapter.adapt(parsed.eventName, parsed.data)) {
      this.push(sseBlock(event.eventName, event.data));
    }
  }
}

export async function readResponsesSse(upstream, onEvent) {
  if (!upstream.body) return;
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    buffer += decoder.write(chunk);
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) await onEvent(parsed);
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) {
    const parsed = parseSseBlock(buffer);
    if (parsed) await onEvent(parsed);
  }
}
