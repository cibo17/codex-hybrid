import crypto from "node:crypto";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_TOKENS = 8_192;
const OUTPUT_HEADROOM = 8_192;
const MAX_TOKENS = 64_000;

function unsupported(description) {
  throw new TypeError(`Anthropic Messages adapter cannot convert ${description}`);
}

function dataUrlSource(imageUrl) {
  const match = String(imageUrl || "").match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) return { type: "url", url: imageUrl };
  return { type: "base64", media_type: match[1], data: match[2] };
}

function textValue(part, description) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") unsupported(description);
  if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") return part.text;
  unsupported(`${description} with type ${JSON.stringify(part.type)}`);
}

function anthropicContent(content, { allowImages = true } = {}) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) unsupported("message content that is not a string or array");
  return content.map((part) => {
    if (typeof part === "string" || ["input_text", "output_text", "text"].includes(part?.type)) {
      return { type: "text", text: textValue(part, "a message content part") };
    }
    if (part?.type === "input_image" && allowImages && typeof part.image_url === "string") {
      return { type: "image", source: dataUrlSource(part.image_url) };
    }
    unsupported(`a message content part with type ${JSON.stringify(part?.type)}`);
  });
}

function resultContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value ?? "");
  return value.map((part) => {
    if (typeof part === "string" || ["input_text", "output_text", "text"].includes(part?.type)) {
      return { type: "text", text: textValue(part, "a tool result content part") };
    }
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      return { type: "image", source: dataUrlSource(part.image_url) };
    }
    unsupported(`a tool result content part with type ${JSON.stringify(part?.type)}`);
  });
}

function appendMessage(messages, role, blocks) {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function reasoningBudget(effort) {
  return { minimal: 1_024, low: 4_096, medium: 8_192, high: 16_384, xhigh: 24_576, max: 32_000 }[effort] || 8_192;
}

function anthropicTool(tool) {
  if (tool?.type !== "function" || typeof tool.name !== "string") {
    unsupported(`a tool with type ${JSON.stringify(tool?.type)}`);
  }
  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  };
}

function anthropicToolChoice(choice) {
  if (choice === undefined || choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice?.type === "function" && typeof choice.name === "string") return { type: "tool", name: choice.name };
  unsupported(`tool_choice ${JSON.stringify(choice)}`);
}

export function responsesToAnthropicMessages(body) {
  const messages = [];
  const system = [];
  if (typeof body?.instructions === "string" && body.instructions) system.push({ type: "text", text: body.instructions });
  const input = typeof body?.input === "string" ? [{ role: "user", content: body.input }] : body?.input;
  if (input !== undefined && !Array.isArray(input)) unsupported("input that is not a string or array");

  for (const item of input || []) {
    if (["system", "developer"].includes(item?.role)) {
      system.push(...anthropicContent(item.content, { allowImages: false }));
      continue;
    }
    if (["user", "assistant"].includes(item?.role)) {
      appendMessage(messages, item.role, anthropicContent(item.content, { allowImages: item.role === "user" }));
      continue;
    }
    if (item?.type === "function_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") unsupported("a function_call without call_id or name");
      let inputValue;
      try { inputValue = JSON.parse(item.arguments || "{}"); } catch { inputValue = {}; }
      appendMessage(messages, "assistant", [{ type: "tool_use", id: item.call_id, name: item.name, input: inputValue }]);
      continue;
    }
    if (item?.type === "function_call_output") {
      if (typeof item.call_id !== "string") unsupported("a function_call_output without call_id");
      appendMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: item.call_id,
        content: resultContent(item.output ?? item.content),
      }]);
      continue;
    }
    unsupported(`an input item with type ${JSON.stringify(item?.type)}`);
  }

  if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "" }] });
  const effort = body?.reasoning?.effort;
  const explicitMax = Number.isFinite(body?.max_output_tokens) ? body.max_output_tokens : null;
  const maxTokens = explicitMax ?? (typeof effort === "string" && effort !== "none"
    ? reasoningBudget(effort) + OUTPUT_HEADROOM
    : DEFAULT_MAX_TOKENS);
  const result = {
    model: body?.model,
    messages,
    max_tokens: Math.min(MAX_TOKENS, Math.max(1, Math.trunc(maxTokens))),
    stream: true,
  };
  if (system.length) result.system = system;
  if (Array.isArray(body?.tools) && body.tools.length) {
    result.tools = body.tools.map(anthropicTool);
    result.tool_choice = anthropicToolChoice(body.tool_choice);
  }
  if (Number.isFinite(body?.temperature)) result.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) result.top_p = body.top_p;
  if (typeof effort === "string" && effort !== "none") {
    result.thinking = { type: "adaptive" };
    result.output_config = { effort: effort === "minimal" ? "low" : effort };
    delete result.temperature;
    delete result.top_p;
  }
  return result;
}

function usageValue(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  const value = {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
  };
  value.total_tokens = value.input_tokens + value.output_tokens;
  if (Number.isFinite(usage.cache_read_input_tokens)) {
    value.input_tokens_details = { cached_tokens: usage.cache_read_input_tokens };
  }
  return value;
}

function terminalStatus(stopReason) {
  if (stopReason === "max_tokens") return { status: "incomplete", reason: "max_output_tokens" };
  if (["refusal", "content_filter"].includes(stopReason)) return { status: "incomplete", reason: "content_filter" };
  return { status: "completed", reason: null };
}

function outputFromBlocks(blocks, responseId) {
  const output = [];
  const text = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      text.push({ type: "output_text", text: block.text, annotations: [] });
    } else if (block?.type === "tool_use" && typeof block.name === "string") {
      const id = typeof block.id === "string" && block.id ? block.id : `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
      output.push({
        id,
        type: "function_call",
        call_id: id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: "completed",
      });
    }
  }
  if (text.length) output.unshift({
    id: `msg_${responseId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: text,
  });
  return output;
}

export function anthropicMessageToResponses(message) {
  if (!message || typeof message !== "object") unsupported("a non-streaming Messages response that is not an object");
  const responseId = `resp_anthropic_${String(message.id || crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const terminal = terminalStatus(message.stop_reason);
  const response = {
    id: responseId,
    object: "response",
    status: terminal.status,
    model: message.model,
    output: outputFromBlocks(message.content, responseId),
  };
  if (terminal.reason) response.incomplete_details = { reason: terminal.reason };
  const usage = usageValue(message.usage);
  if (usage) response.usage = usage;
  return response;
}

function responseEvent(eventName, data) {
  return { eventName, data: { type: eventName, ...data } };
}

class AnthropicEventReducer {
  constructor() {
    this.responseId = null;
    this.model = null;
    this.started = false;
    this.terminal = false;
    this.text = "";
    this.message = null;
    this.tools = new Map();
    this.nextOutputIndex = 0;
    this.stopReason = null;
    this.usage = {};
  }

  begin(message = {}) {
    if (this.started) return [];
    this.started = true;
    this.responseId = `resp_anthropic_${String(message.id || crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    this.model = message.model;
    this.usage = { ...(message.usage || {}) };
    const response = { id: this.responseId, object: "response", status: "in_progress", model: this.model, output: [] };
    return [responseEvent("response.created", { response }), responseEvent("response.in_progress", { response })];
  }

  startMessage(events) {
    if (this.message) return;
    this.message = { id: `msg_${this.responseId}`, outputIndex: this.nextOutputIndex++ };
    events.push(responseEvent("response.output_item.added", {
      output_index: this.message.outputIndex,
      item: { id: this.message.id, type: "message", role: "assistant", status: "in_progress", content: [] },
    }));
    events.push(responseEvent("response.content_part.added", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }));
  }

  adapt(eventName, data) {
    if (this.terminal) return [];
    const events = [];
    if (eventName === "message_start") events.push(...this.begin(data?.message));
    else if (eventName === "content_block_start") {
      if (!this.started) events.push(...this.begin());
      const index = data?.index ?? this.tools.size;
      const block = data?.content_block;
      if (block?.type === "text") this.startMessage(events);
      else if (block?.type === "tool_use") {
        const id = typeof block.id === "string" && block.id ? block.id : `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
        const state = { id, name: block.name || "", arguments: "", outputIndex: this.nextOutputIndex++ };
        this.tools.set(index, state);
        events.push(responseEvent("response.output_item.added", {
          output_index: state.outputIndex,
          item: { id, type: "function_call", call_id: id, name: state.name, arguments: "", status: "in_progress" },
        }));
      }
    } else if (eventName === "content_block_delta") {
      const delta = data?.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.startMessage(events);
        this.text += delta.text;
        events.push(responseEvent("response.output_text.delta", {
          item_id: this.message.id,
          output_index: this.message.outputIndex,
          content_index: 0,
          delta: delta.text,
        }));
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const state = this.tools.get(data?.index);
        if (state) {
          state.arguments += delta.partial_json;
          events.push(responseEvent("response.function_call_arguments.delta", {
            item_id: state.id,
            output_index: state.outputIndex,
            delta: delta.partial_json,
          }));
        }
      }
    } else if (eventName === "content_block_stop") {
      const state = this.tools.get(data?.index);
      if (state && !state.done) {
        state.done = true;
        const args = state.arguments || "{}";
        try { JSON.parse(args); } catch { return this.fail("Anthropic stream sent malformed tool_use arguments"); }
        const item = { id: state.id, type: "function_call", call_id: state.id, name: state.name, arguments: args, status: "completed" };
        events.push(responseEvent("response.function_call_arguments.done", {
          item_id: state.id,
          output_index: state.outputIndex,
          arguments: args,
        }));
        events.push(responseEvent("response.output_item.done", { output_index: state.outputIndex, item }));
      }
    } else if (eventName === "message_delta") {
      if (typeof data?.delta?.stop_reason === "string") this.stopReason = data.delta.stop_reason;
      this.usage = { ...this.usage, ...(data?.usage || {}) };
    } else if (eventName === "message_stop") return this.finish();
    else if (eventName === "error") return this.fail(data?.error?.message || "Anthropic Messages stream failed");
    return events;
  }

  finish() {
    if (this.terminal) return [];
    this.terminal = true;
    const events = [];
    const output = [];
    if (this.message) {
      const content = { type: "output_text", text: this.text, annotations: [] };
      const item = { id: this.message.id, type: "message", role: "assistant", status: "completed", content: [content] };
      events.push(responseEvent("response.output_text.done", { item_id: item.id, output_index: this.message.outputIndex, content_index: 0, text: this.text }));
      events.push(responseEvent("response.content_part.done", { item_id: item.id, output_index: this.message.outputIndex, content_index: 0, part: content }));
      events.push(responseEvent("response.output_item.done", { output_index: this.message.outputIndex, item }));
      output.push({ outputIndex: this.message.outputIndex, item });
    }
    for (const state of this.tools.values()) {
      if (!state.done) {
        const args = state.arguments || "{}";
        const item = { id: state.id, type: "function_call", call_id: state.id, name: state.name, arguments: args, status: "completed" };
        output.push({ outputIndex: state.outputIndex, item });
      } else {
        output.push({ outputIndex: state.outputIndex, item: {
          id: state.id, type: "function_call", call_id: state.id, name: state.name, arguments: state.arguments || "{}", status: "completed",
        } });
      }
    }
    output.sort((a, b) => a.outputIndex - b.outputIndex);
    const terminal = terminalStatus(this.stopReason);
    const response = { id: this.responseId, object: "response", status: terminal.status, model: this.model, output: output.map(({ item }) => item) };
    if (terminal.reason) response.incomplete_details = { reason: terminal.reason };
    const usage = usageValue(this.usage);
    if (usage) response.usage = usage;
    events.push(responseEvent(terminal.status === "incomplete" ? "response.incomplete" : "response.completed", { response }));
    return events;
  }

  fail(message) {
    if (this.terminal) return [];
    this.terminal = true;
    return [responseEvent("response.failed", { response: {
      id: this.responseId || `resp_anthropic_${crypto.randomUUID().replaceAll("-", "")}`,
      object: "response",
      status: "failed",
      error: { code: "anthropic_messages_adapter_error", message },
      output: [],
    } })];
  }

  end() {
    if (this.terminal) return [];
    return this.fail("Anthropic Messages stream ended before message_stop");
  }
}

function parseBlock(block) {
  let eventName = "";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    const value = JSON.parse(data.join("\n"));
    return { eventName: eventName || value.type || "message", data: value };
  } catch {
    return null;
  }
}

export async function readAnthropicMessagesSse(upstream, onEvent) {
  if (!upstream.body) return;
  const reducer = new AnthropicEventReducer();
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    buffer += decoder.write(chunk);
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const parsed = parseBlock(block);
      if (!parsed) continue;
      for (const event of reducer.adapt(parsed.eventName, parsed.data)) await onEvent(event);
      if (reducer.terminal) return;
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) {
    const parsed = parseBlock(buffer);
    if (parsed) for (const event of reducer.adapt(parsed.eventName, parsed.data)) await onEvent(event);
  }
  for (const event of reducer.end()) await onEvent(event);
}
