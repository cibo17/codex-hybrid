import assert from "node:assert/strict";
import test from "node:test";

import {
  chatCompletionToResponses,
  readChatCompletionsSse,
  responsesToChatCompletions,
} from "../../src/protocol/chat-completions.mjs";

function chatStream(chunks) {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

test("Responses requests convert to chat messages, multimodal content, and function tools", () => {
  const result = responsesToChatCompletions({
    model: "kimi-k3",
    instructions: "system",
    input: [
      { role: "user", content: [
        { type: "input_text", text: "inspect" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ],
    tools: [{ type: "function", name: "lookup", description: "lookup", parameters: { type: "object" } }],
    reasoning: { effort: "high" },
    max_output_tokens: 16,
  });
  assert.equal(result.model, "kimi-k3");
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages[1].content[1].type, "image_url");
  assert.equal(result.messages[2].tool_calls[0].function.name, "lookup");
  assert.equal(result.messages[3].role, "tool");
  assert.equal(result.tools[0].function.name, "lookup");
  assert.equal(result.reasoning_effort, "high");
  assert.equal(result.max_tokens, 16);
});

test("Chat text streaming becomes a complete Responses event sequence", async () => {
  const upstream = chatStream([
    { id: "chat_1", choices: [{ delta: { role: "assistant", content: "HEL" }, finish_reason: null }] },
    { id: "chat_1", choices: [{ delta: { content: "LO" }, finish_reason: "stop" }], usage: { total_tokens: 3 } },
  ]);
  const events = [];
  await readChatCompletionsSse(upstream, async (event) => events.push(event));
  assert.equal(events[0].eventName, "response.created");
  assert.deepEqual(events.filter((event) => event.eventName === "response.output_text.delta").map((event) => event.data.delta), ["HEL", "LO"]);
  const completed = events.at(-1);
  assert.equal(completed.eventName, "response.completed");
  assert.equal(completed.data.response.output[0].content[0].text, "HELLO");
});

test("Chat tool-call streaming becomes Responses function-call events", async () => {
  const upstream = chatStream([
    { id: "chat_2", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] }, finish_reason: null }] },
    { id: "chat_2", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }] }, finish_reason: "tool_calls" }] },
  ]);
  const events = [];
  await readChatCompletionsSse(upstream, async (event) => events.push(event));
  const completed = events.at(-1).data.response.output[0];
  assert.equal(completed.type, "function_call");
  assert.equal(completed.name, "lookup");
  assert.equal(completed.arguments, '{"q":"x"}');
});

test("non-streaming Chat Completions JSON becomes Responses JSON with content arrays and multiple tool calls", () => {
  const response = chatCompletionToResponses({
    id: "chat_json",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I need two lookups." }],
        tool_calls: [
          { id: "call_one", type: "function", function: { name: "lookup", arguments: "{\"q\":\"one\"}" } },
          { id: "call_two", type: "function", function: { name: "lookup", arguments: "{\"q\":\"two\"}" } },
        ],
      },
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 4 },
    },
  });
  assert.equal(response.status, "completed");
  assert.equal(response.output[0].content[0].text, "I need two lookups.");
  assert.deepEqual(response.output.slice(1).map((item) => item.call_id), ["call_one", "call_two"]);
  assert.deepEqual(response.usage, {
    input_tokens: 11,
    output_tokens: 7,
    total_tokens: 18,
    input_tokens_details: { cached_tokens: 4 },
  });
});

test("Chat stream supports multiple tool calls before text and usage-only terminal chunks", async () => {
  const upstream = chatStream([
    { id: "chat_4", choices: [{ delta: { tool_calls: [
      { index: 0, id: "call_a", type: "function", function: { name: "first", arguments: "{}" } },
      { index: 1, id: "call_b", type: "function", function: { name: "second", arguments: "{}" } },
    ] }, finish_reason: null }] },
    { id: "chat_4", choices: [{ delta: { content: "done" }, finish_reason: null }] },
    { id: "chat_4", choices: [{ delta: {}, finish_reason: "stop" }] },
    { id: "chat_4", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  ]);
  const events = [];
  await readChatCompletionsSse(upstream, async (event) => events.push(event));
  const completed = events.at(-1);
  assert.equal(completed.eventName, "response.completed");
  assert.deepEqual(completed.data.response.output.map((item) => item.type), ["function_call", "function_call", "message"]);
  assert.deepEqual(completed.data.response.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  assert.deepEqual(
    events.filter((event) => event.eventName === "response.output_text.delta").map((event) => event.data.output_index),
    [2],
  );
});

test("Chat length limits become response.incomplete", async () => {
  const upstream = chatStream([
    { id: "chat_3", choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] },
    { id: "chat_3", choices: [{ delta: {}, finish_reason: "length" }] },
  ]);
  const events = [];
  await readChatCompletionsSse(upstream, async (event) => events.push(event));
  assert.equal(events.at(-1).eventName, "response.incomplete");
  assert.equal(events.at(-1).data.response.incomplete_details.reason, "max_output_tokens");
});

test("Chat content filters become content_filter incompletes", () => {
  const response = chatCompletionToResponses({
    id: "chat_filter",
    choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: null } }],
  });
  assert.equal(response.status, "incomplete");
  assert.equal(response.incomplete_details.reason, "content_filter");
});

test("unsupported Responses inputs fail diagnostically instead of being dropped", () => {
  assert.throws(
    () => responsesToChatCompletions({ model: "chat", input: [{ type: "computer_call", id: "comp_1" }] }),
    /cannot convert a Responses input item with type "computer_call"/,
  );
  assert.throws(
    () => responsesToChatCompletions({ model: "chat", input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] }),
    /cannot convert a Responses message content part with type "input_file"/,
  );
});
