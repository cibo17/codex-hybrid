import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function unsupported(description) {
  throw new TypeError(`Chat Completions adapter cannot convert ${description}`);
}

function partText(part, description) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") unsupported(description);
  if (["input_text", "output_text", "text"].includes(part.type)) {
    const text = part.text ?? part.input_text ?? part.output_text;
    if (typeof text === "string") return text;
  }
  unsupported(`${description} with type ${JSON.stringify(part.type)}`);
}

function textContent(content, description = "content") {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) unsupported(description);
  return content.map((part) => partText(part, description)).join("");
}

function chatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) unsupported("a Responses message without string or array content");
  const parts = [];
  for (const part of content) {
    if (["input_text", "output_text", "text"].includes(part?.type)) {
      const text = part.text ?? part.input_text ?? part.output_text;
      if (typeof text !== "string") unsupported(`a Responses text content part without text (${part.type})`);
      parts.push({ type: "text", text });
    } else if (part?.type === "input_image") {
      const url = part.image_url ?? part.url;
      if (typeof url !== "string") unsupported("a Responses input_image content part without image_url");
      const imageUrl = { url };
      if (typeof part.detail === "string") imageUrl.detail = part.detail;
      parts.push({ type: "image_url", image_url: imageUrl });
    } else {
      unsupported(`a Responses message content part with type ${JSON.stringify(part?.type)}`);
    }
  }
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function chatTool(tool) {
  if (tool?.type !== "function" || typeof tool.name !== "string") {
    unsupported(`a Responses tool with type ${JSON.stringify(tool?.type)}`);
  }
  const definition = {
    name: tool.name,
    description: tool.description || "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
  };
  if (typeof tool.strict === "boolean") definition.strict = tool.strict;
  return { type: "function", function: definition };
}

function chatToolChoice(choice) {
  if (typeof choice === "string") return choice;
  if (!choice || typeof choice !== "object") return "auto";
  if (choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  unsupported(`a Responses tool_choice with type ${JSON.stringify(choice.type)}`);
}

export function responsesToChatCompletions(body) {
  const messages = [];
  if (typeof body?.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = typeof body?.input === "string"
    ? [{ role: "user", content: body.input }]
    : body?.input;
  if (input !== undefined && !Array.isArray(input)) unsupported("a Responses input that is not a string or array");
  for (const item of input || []) {
    if (["system", "developer", "user", "assistant"].includes(item?.role)) {
      messages.push({ role: item.role === "developer" ? "system" : item.role, content: chatContent(item.content) });
      continue;
    }
    if (item?.type === "function_call") {
      if (typeof item.name !== "string") unsupported("a Responses function_call without a name");
      if (typeof (item.call_id ?? item.id) !== "string") unsupported("a Responses function_call without a call_id");
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id ?? item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "{}" },
        }],
      });
      continue;
    }
    if (item?.type === "function_call_output") {
      if (typeof item.call_id !== "string") unsupported("a Responses function_call_output without a call_id");
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textContent(item.output ?? item.content, "a Responses function_call_output") });
      continue;
    }
    unsupported(`a Responses input item with type ${JSON.stringify(item?.type)}`);
  }
  if (body?.tools !== undefined && !Array.isArray(body.tools)) unsupported("a Responses tools field that is not an array");
  const tools = body?.tools?.map(chatTool) || [];
  const result = {
    model: body?.model,
    messages,
    stream: true,
  };
  if (tools.length) {
    result.tools = tools;
    result.tool_choice = chatToolChoice(body.tool_choice);
  }
  if (typeof body?.parallel_tool_calls === "boolean") result.parallel_tool_calls = body.parallel_tool_calls;
  if (Number.isFinite(body?.max_output_tokens)) result.max_tokens = body.max_output_tokens;
  if (Number.isFinite(body?.temperature)) result.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) result.top_p = body.top_p;
  if (typeof body?.reasoning?.effort === "string") result.reasoning_effort = body.reasoning.effort;
  return result;
}

function parseChatBlock(block) {
  const dataText = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!dataText || dataText === "[DONE]") return null;
  try { return JSON.parse(dataText); } catch { return null; }
}

function event(eventName, data) {
  return { eventName, data: { type: eventName, ...data } };
}

function responseUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (![inputTokens, outputTokens, totalTokens].some(Number.isFinite)) return undefined;
  const result = {};
  if (Number.isFinite(inputTokens)) result.input_tokens = inputTokens;
  if (Number.isFinite(outputTokens)) result.output_tokens = outputTokens;
  if (Number.isFinite(totalTokens)) result.total_tokens = totalTokens;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  if (Number.isFinite(cachedTokens)) result.input_tokens_details = { cached_tokens: cachedTokens };
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoningTokens)) result.output_tokens_details = { reasoning_tokens: reasoningTokens };
  return result;
}

function terminalResponse({ responseId, output, finishReason, usage }) {
  const response = { id: responseId, object: "response", status: "completed", output };
  const responseUsageValue = responseUsage(usage);
  if (responseUsageValue) response.usage = responseUsageValue;
  if (finishReason === "length" || finishReason === "content_filter") {
    response.status = "incomplete";
    response.incomplete_details = { reason: finishReason === "length" ? "max_output_tokens" : "content_filter" };
    return { eventName: "response.incomplete", response };
  }
  if ([undefined, null, "stop", "tool_calls", "function_call"].includes(finishReason)) {
    return { eventName: "response.completed", response };
  }
  response.status = "failed";
  response.error = {
    code: "unsupported_chat_finish_reason",
    message: `Chat Completions adapter received unsupported finish_reason ${JSON.stringify(finishReason)}`,
  };
  return { eventName: "response.failed", response };
}

function outputTextParts(content, description) {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [{ type: "output_text", text: content, annotations: [] }];
  if (!Array.isArray(content)) unsupported(description);
  return content.map((part) => ({ type: "output_text", text: partText(part, description), annotations: [] }));
}

function functionCallItem(call, fallbackId) {
  if (!call || call.type !== "function" || typeof call.function?.name !== "string") {
    unsupported("a Chat Completions tool_call that is not a function call");
  }
  const id = call.id ?? fallbackId;
  if (typeof id !== "string") unsupported("a Chat Completions tool_call without an id");
  return {
    id,
    type: "function_call",
    call_id: id,
    name: call.function.name,
    arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
    status: "completed",
  };
}

export function chatCompletionToResponses(completion) {
  if (!completion || typeof completion !== "object") unsupported("a non-streaming Chat Completions response that is not an object");
  const choices = completion.choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    unsupported("a non-streaming Chat Completions response with anything other than one choice");
  }
  const choice = choices[0];
  const message = choice?.message;
  if (!message || typeof message !== "object") unsupported("a non-streaming Chat Completions choice without a message");
  const responseId = typeof completion.id === "string" ? completion.id : `resp_chat_${Date.now()}`;
  const output = [];
  const content = outputTextParts(message.content, "a Chat Completions message content part");
  if (content.length) {
    output.push({ id: `msg_${responseId}`, type: "message", role: "assistant", status: "completed", content });
  }
  for (const [index, call] of (message.tool_calls || []).entries()) {
    output.push(functionCallItem(call, `call_${responseId}_${index}`));
  }
  return terminalResponse({ responseId, output, finishReason: choice.finish_reason, usage: completion.usage }).response;
}

class ChatEventReducer {
  constructor() {
    this.responseId = null;
    this.message = null;
    this.text = "";
    this.tools = new Map();
    this.started = false;
    this.terminal = false;
    this.pendingFinish = null;
    this.nextOutputIndex = 0;
  }

  begin(chunk) {
    if (this.started) return [];
    this.started = true;
    this.responseId = chunk.id || `resp_chat_${Date.now()}`;
    const response = { id: this.responseId, object: "response", status: "in_progress", output: [] };
    return [event("response.created", { response }), event("response.in_progress", { response })];
  }

  startMessage(events) {
    if (this.message) return;
    this.message = {
      id: `msg_${this.responseId}`,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
      outputIndex: this.nextOutputIndex++,
    };
    const { outputIndex, ...message } = this.message;
    events.push(event("response.output_item.added", { output_index: outputIndex, item: message }));
    events.push(event("response.content_part.added", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }));
  }

  adapt(chunk) {
    if (this.terminal) return [];
    const events = this.begin(chunk);
    const choices = chunk?.choices;
    if (!Array.isArray(choices)) unsupported("a streaming Chat Completions chunk without choices");
    if (choices.length === 0) {
      if (chunk.usage) {
        const pending = this.pendingFinish;
        events.push(...this.finish({ ...pending?.chunk, ...chunk }, pending?.finishReason || "stop"));
      }
      return events;
    }
    if (choices.length !== 1 || (choices[0].index !== undefined && choices[0].index !== 0)) {
      unsupported("a streaming Chat Completions chunk with more than one choice");
    }
    const choice = choices[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      this.startMessage(events);
      this.text += delta.content;
      events.push(event("response.output_text.delta", {
        item_id: this.message.id,
        output_index: this.message.outputIndex,
        content_index: 0,
        delta: delta.content,
      }));
    }
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = call.index ?? 0;
      let state = this.tools.get(index);
      const existing = Boolean(state);
      if (!state) {
        state = {
          id: call.id || `call_${this.responseId}_${index}`,
          name: call.function?.name || "",
          arguments: "",
          outputIndex: this.nextOutputIndex++,
        };
        this.tools.set(index, state);
        events.push(event("response.output_item.added", {
          output_index: state.outputIndex,
          item: { id: state.id, type: "function_call", call_id: state.id, name: state.name, arguments: "", status: "in_progress" },
        }));
      }
      if (call.id) state.id = call.id;
      if (existing && call.function?.name) state.name += call.function.name;
      if (call.function?.arguments) {
        state.arguments += call.function.arguments;
        events.push(event("response.function_call_arguments.delta", {
          item_id: state.id,
          output_index: state.outputIndex,
          delta: call.function.arguments,
        }));
      }
    }
    if (choice?.finish_reason) {
      if (chunk.usage) events.push(...this.finish(chunk, choice.finish_reason));
      else this.pendingFinish = { chunk, finishReason: choice.finish_reason };
    }
    return events;
  }

  end() {
    if (this.terminal) return [];
    if (this.pendingFinish) return this.finish(this.pendingFinish.chunk, this.pendingFinish.finishReason);
    if (!this.started) return [];
    return this.finish({}, "stream_ended_without_finish_reason");
  }

  finish(chunk, finishReason) {
    if (this.terminal) return [];
    this.terminal = true;
    this.pendingFinish = null;
    const events = [];
    const output = [];
    if (this.message) {
      const content = { type: "output_text", text: this.text, annotations: [] };
      const { outputIndex, ...message } = { ...this.message, status: "completed", content: [content] };
      output.push({ outputIndex, item: message });
      events.push(event("response.output_text.done", { item_id: message.id, output_index: outputIndex, content_index: 0, text: this.text }));
      events.push(event("response.content_part.done", { item_id: message.id, output_index: outputIndex, content_index: 0, part: content }));
      events.push(event("response.output_item.done", { output_index: outputIndex, item: message }));
    }
    for (const state of this.tools.values()) {
      const item = { id: state.id, type: "function_call", call_id: state.id, name: state.name, arguments: state.arguments, status: "completed" };
      output.push({ outputIndex: state.outputIndex, item });
      events.push(event("response.function_call_arguments.done", { item_id: state.id, output_index: state.outputIndex, arguments: state.arguments }));
      events.push(event("response.output_item.done", { output_index: state.outputIndex, item }));
    }
    output.sort((left, right) => left.outputIndex - right.outputIndex);
    const terminal = terminalResponse({
      responseId: this.responseId,
      output: output.map(({ item }) => item),
      finishReason,
      usage: chunk.usage,
    });
    events.push(event(terminal.eventName, { response: terminal.response }));
    return events;
  }
}

export async function readChatCompletionsSse(upstream, onEvent) {
  if (!upstream.body) return;
  const reducer = new ChatEventReducer();
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    buffer += decoder.write(chunk);
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const parsed = parseChatBlock(block);
      if (!parsed) continue;
      for (const adapted of reducer.adapt(parsed)) await onEvent(adapted);
      if (reducer.terminal) return;
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) {
    const parsed = parseChatBlock(buffer);
    if (parsed) for (const adapted of reducer.adapt(parsed)) await onEvent(adapted);
  }
  for (const adapted of reducer.end()) await onEvent(adapted);
}
