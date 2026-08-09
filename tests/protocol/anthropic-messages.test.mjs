import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicMessageToResponses,
  readAnthropicMessagesSse,
  responsesToAnthropicMessages,
} from "../../src/protocol/anthropic-messages.mjs";

function sseResponse(records) {
  const text = records.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

test("Responses requests become Anthropic messages with native vision, tools, and adaptive effort", () => {
  const body = responsesToAnthropicMessages({
    model: "fable-5[1m]",
    instructions: "system",
    reasoning: { effort: "high" },
    input: [
      { role: "developer", content: [{ type: "input_text", text: "developer" }] },
      { role: "user", content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,QUJD" },
      ] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [{ type: "function", name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
    tool_choice: { type: "function", name: "lookup" },
  });
  assert.deepEqual(body.system.map((part) => part.text), ["system", "developer"]);
  assert.deepEqual(body.messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(body.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
  assert.equal(body.messages[1].content[0].type, "tool_use");
  assert.equal(body.messages[2].content[0].tool_use_id, "call_1");
  assert.equal(body.tools[0].input_schema.type, "object");
  assert.deepEqual(body.tool_choice, { type: "tool", name: "lookup" });
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.equal(body.max_tokens, 24_576);
});

test("non-streaming Anthropic messages become Responses JSON", () => {
  const response = anthropicMessageToResponses({
    id: "msg_upstream",
    model: "opus-5[1m]",
    stop_reason: "tool_use",
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
    ],
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3 },
  });
  assert.equal(response.status, "completed");
  assert.deepEqual(response.output.map((item) => item.type), ["message", "function_call"]);
  assert.equal(response.output[1].call_id, "toolu_1");
  assert.equal(response.usage.total_tokens, 14);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 3);
});

test("Anthropic SSE becomes a complete Responses tool and text sequence", async () => {
  const events = [];
  await readAnthropicMessagesSse(sseResponse([
    { event: "message_start", data: { message: { id: "msg_stream", model: "fable-5[1m]", usage: { input_tokens: 7, output_tokens: 0 } } } },
    { event: "content_block_start", data: { index: 0, content_block: { type: "tool_use", id: "toolu_stream", name: "lookup", input: {} } } },
    { event: "content_block_delta", data: { index: 0, delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" } } },
    { event: "content_block_stop", data: { index: 0 } },
    { event: "content_block_start", data: { index: 1, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { index: 1, delta: { type: "text_delta", text: "done" } } },
    { event: "content_block_stop", data: { index: 1 } },
    { event: "message_delta", data: { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: {} },
  ]), async (event) => events.push(event));
  assert.equal(events.find((event) => event.eventName === "response.output_item.added")?.data.item.type, "function_call");
  assert.equal(events.find((event) => event.eventName === "response.function_call_arguments.done")?.data.arguments, "{\"q\":\"x\"}");
  assert.equal(events.find((event) => event.eventName === "response.output_text.delta")?.data.delta, "done");
  const terminal = events.at(-1);
  assert.equal(terminal.eventName, "response.completed");
  assert.deepEqual(terminal.data.response.output.map((item) => item.type), ["function_call", "message"]);
  assert.equal(terminal.data.response.usage.total_tokens, 12);
});

test("max_tokens and premature EOF are explicit terminal states", async () => {
  const incomplete = anthropicMessageToResponses({ id: "msg_short", stop_reason: "max_tokens", content: [], usage: {} });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.incomplete_details.reason, "max_output_tokens");

  const events = [];
  await readAnthropicMessagesSse(sseResponse([
    { event: "message_start", data: { message: { id: "msg_eof", usage: {} } } },
  ]), async (event) => events.push(event));
  assert.equal(events.at(-1).eventName, "response.failed");
});

test("unsupported Responses history fails diagnostically", () => {
  assert.throws(
    () => responsesToAnthropicMessages({ model: "fable", input: [{ type: "computer_call", id: "computer_1" }] }),
    /computer_call/,
  );
});
