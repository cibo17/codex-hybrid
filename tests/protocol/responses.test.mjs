import assert from "node:assert/strict";
import test from "node:test";

import {
  ResponsesEventAdapter,
  ResponsesSseAdapter,
  adaptRequestForProvider,
  parseSseBlock,
  transformResponseObject,
} from "../../src/protocol/responses.mjs";

test("converts Codex request extensions into portable Responses fields", () => {
  const result = adaptRequestForProvider({
    model: "custom-model",
    prompt_cache_key: "private-cache-key",
    service_tier: "priority",
    text: { verbosity: "high", format: { type: "text" } },
    tools: [{ type: "custom", name: "apply_patch", description: "patch" }],
    input: [{ type: "custom_tool_call", name: "apply_patch", call_id: "1", input: "*** Begin Patch" }],
  });
  assert.equal(result.body.prompt_cache_key, undefined);
  assert.equal(result.body.service_tier, undefined);
  assert.deepEqual(result.body.text, { format: { type: "text" } });
  assert.equal(result.body.tools[0].type, "function");
  assert.equal(result.body.input[0].type, "function_call");
});

test("restores apply_patch output into the Codex custom tool shape", () => {
  const transformed = transformResponseObject({
    output: [{ type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch: "PATCH" }) }],
  });
  assert.deepEqual(transformed.output[0], { type: "custom_tool_call", name: "apply_patch", input: "PATCH" });
});

test("event adapter converts streamed apply_patch arguments", () => {
  const adapter = new ResponsesEventAdapter();
  adapter.adapt("response.output_item.added", { item: { id: "item-1", type: "function_call", name: "apply_patch" } });
  assert.deepEqual(adapter.adapt("response.function_call_arguments.delta", { item_id: "item-1", delta: '{"patch":"PA' }), []);
  assert.deepEqual(adapter.adapt("response.function_call_arguments.delta", { item_id: "item-1", delta: 'TCH"}' }), []);
  const events = adapter.adapt("response.function_call_arguments.done", { item_id: "item-1" });
  assert.equal(events[0].eventName, "response.custom_tool_call_input.delta");
  assert.equal(events[0].data.delta, "PATCH");
  assert.equal(events[1].data.input, "PATCH");
});

test("SSE parser and stream adapter preserve portable events", async () => {
  assert.deepEqual(parseSseBlock('event: response.created\ndata: {"type":"response.created"}'), {
    eventName: "response.created",
    data: { type: "response.created" },
  });
  const adapter = new ResponsesSseAdapter();
  const chunks = [];
  adapter.on("data", (chunk) => chunks.push(chunk));
  adapter.end(Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'));
  await new Promise((resolve, reject) => {
    adapter.on("end", resolve);
    adapter.on("error", reject);
  });
  assert.match(Buffer.concat(chunks).toString("utf8"), /response\.created/);
});
