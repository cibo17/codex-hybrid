import assert from "node:assert/strict";
import test from "node:test";

import { ModelRoutingPipeline } from "../../src/provider/routing.mjs";
import { CollaborationHistoryBridge } from "../../src/tools/collaboration-history.mjs";

test("provider history drops reasoning and converts plaintext agent messages", async () => {
  const bridge = new CollaborationHistoryBridge();
  const body = await bridge.prepareProviderBody({ input: [
    { type: "reasoning", encrypted_content: "gAAAAAcipher" },
    { type: "agent_message", content: [
      { type: "input_text", text: "Payload:\n" },
      { type: "encrypted_content", encrypted_content: "plain child result" },
    ] },
  ] });
  assert.deepEqual(body.input, [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "Payload:\n" },
      { type: "input_text", text: "plain child result" },
    ],
  }]);
});

test("removes provider-owned item ids while preserving portable call correlation", async () => {
  const bridge = new CollaborationHistoryBridge();
  const body = await bridge.prepareProviderBody({ input: [
    {
      type: "function_call",
      id: "fc_02178626342885200000000000000000000ffffac174e10b16e38",
      call_id: "call_portable",
      name: "lookup",
      arguments: "{}",
    },
    {
      type: "function_call_output",
      id: "fco_provider_owned",
      call_id: "call_portable",
      output: "done",
    },
    { type: "message", id: "msg_provider_owned", role: "assistant", content: "ok" },
    { type: "item_reference", id: "provider_only_reference" },
  ] });

  assert.deepEqual(body.input, [
    { type: "function_call", call_id: "call_portable", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_portable", output: "done" },
    { type: "message", role: "assistant", content: "ok" },
  ]);
});

test("provider child receives cached plaintext instead of official ciphertext", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe({
    type: "function_call",
    id: "call-1",
    namespace: "agents",
    name: "spawn_agent",
    arguments: JSON.stringify({ task_name: "child", message: "reply CHILD_OK" }),
  });
  const body = await bridge.prepareProviderBody({ input: [{
    type: "agent_message",
    recipient: "/root/child",
    content: [
      { type: "input_text", text: "Task name: /root/child\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAAofficialciphertext" },
    ],
  }] });
  assert.deepEqual(body.input[0].content.at(-1), { type: "input_text", text: "reply CHILD_OK" });
});

test("official ciphertext uses the collaboration decoder when cached arguments are also encrypted", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe({
    type: "function_call",
    id: "call-2",
    name: "spawn_agent",
    arguments: JSON.stringify({ task_name: "child", message: "gAAAAAencrypted_argument" }),
  });
  const body = await bridge.prepareProviderBody({ input: [{
    type: "agent_message",
    recipient: "/root/child",
    content: [{ type: "encrypted_content", encrypted_content: "gAAAAAencrypted_argument" }],
  }] }, { resolveEncrypted: async () => "decoded task" });
  assert.deepEqual(body.input[0].content, [{ type: "input_text", text: "decoded task" }]);
});

test("decoded collaboration payloads are cached across provider sampling rounds", async () => {
  const bridge = new CollaborationHistoryBridge();
  let calls = 0;
  const original = { input: [{
    type: "agent_message",
    recipient: "/root/child",
    content: [{ type: "encrypted_content", encrypted_content: "gAAAAArepeatedciphertext" }],
  }] };
  const options = { resolveEncrypted: async () => {
    calls += 1;
    return "decoded once";
  } };
  await bridge.prepareProviderBody(original, options);
  await bridge.prepareProviderBody(original, options);
  assert.equal(calls, 1);
});

test("uses full task paths to keep same-named concurrent agents separate", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe([
    {
      type: "function_call",
      id: "call-alpha",
      name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "/root/alpha/worker", message: "alpha payload" }),
    },
    {
      type: "function_call",
      id: "call-beta",
      name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "/root/beta/worker", message: "beta payload" }),
    },
  ]);

  const body = await bridge.prepareProviderBody({ input: [
    {
      type: "agent_message",
      recipient: "/root/beta/worker",
      content: [{ type: "encrypted_content", encrypted_content: "gAAAAAbeta" }],
    },
    {
      type: "agent_message",
      recipient: "/root/alpha/worker",
      content: [{ type: "encrypted_content", encrypted_content: "gAAAAAalpha" }],
    },
  ] });

  assert.deepEqual(body.input.map((item) => item.content[0].text), ["beta payload", "alpha payload"]);
});

test("matches an unambiguous short task name without reintroducing path collisions", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe({
    type: "function_call",
    id: "call-short-name",
    name: "spawn_agent",
    arguments: JSON.stringify({ task_name: "child", message: "short-name payload" }),
  });

  const body = await bridge.prepareProviderBody({ input: [{
    type: "agent_message",
    recipient: "/root/child",
    content: [{ type: "encrypted_content", encrypted_content: "gAAAAAshort" }],
  }] });

  assert.equal(body.input[0].content[0].text, "short-name payload");
});

test("does not use a leaf-name fallback when multiple paths match", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe([
    {
      type: "function_call",
      id: "call-left-worker",
      name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "/root/left/worker", message: "left payload" }),
    },
    {
      type: "function_call",
      id: "call-right-worker",
      name: "spawn_agent",
      arguments: JSON.stringify({ task_name: "/root/right/worker", message: "right payload" }),
    },
  ]);

  const body = await bridge.prepareProviderBody({ input: [{
    type: "agent_message",
    recipient: "/root/unrelated/worker",
    content: [{ type: "encrypted_content", encrypted_content: "gAAAAAunknown" }],
  }] });

  assert.deepEqual(body.input, []);
});

test("concurrent provider handoffs consume same-target history in FIFO order", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe([
    {
      type: "function_call",
      id: "call-first",
      name: "send_message",
      arguments: JSON.stringify({ target: "/root/worker", message: "first payload" }),
    },
    {
      type: "function_call",
      id: "call-second",
      name: "send_message",
      arguments: JSON.stringify({ target: "/root/worker", message: "second payload" }),
    },
  ]);
  const providerBody = (ciphertext) => ({ input: [{
    type: "agent_message",
    recipient: "/root/worker",
    content: [{ type: "encrypted_content", encrypted_content: ciphertext }],
  }] });

  const [first, second] = await Promise.all([
    bridge.prepareProviderBody(providerBody("gAAAAAfirst")),
    bridge.prepareProviderBody(providerBody("gAAAAAsecond")),
  ]);

  assert.equal(first.input[0].content[0].text, "first payload");
  assert.equal(second.input[0].content[0].text, "second payload");
});

test("converts official-origin and third-party collaboration history for a provider", async () => {
  const bridge = new CollaborationHistoryBridge();
  bridge.observe({
    type: "function_call",
    id: "call-official-to-provider",
    name: "followup_task",
    arguments: JSON.stringify({ target: "/root/child", message: "official to provider" }),
  });

  const fromOfficial = await bridge.prepareProviderBody({ input: [{
    type: "agent_message",
    recipient: "/root/child",
    content: [{ type: "encrypted_content", encrypted_content: "gAAAAAofficial" }],
  }] });
  assert.deepEqual(fromOfficial.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "official to provider" }],
  }]);

  const betweenProviders = await bridge.prepareProviderBody({ input: [{
    type: "agent_message",
    content: [{ type: "encrypted_content", encrypted_content: "third-party plaintext" }],
  }] });
  assert.deepEqual(betweenProviders.input, [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "third-party plaintext" }],
  }]);
});

test("official models bypass collaboration history conversion", async () => {
  const pipeline = new ModelRoutingPipeline({
    registry: { route: () => null },
    collaborationBridge: { prepareProviderBody: () => assert.fail("official history must not be converted") },
    visionWorkflow: { prepareOfficialBody: (body) => body },
  });
  const body = { model: "gpt-5.6-luna", input: [{ type: "agent_message", content: [] }] };

  const result = await pipeline.prepare(body, { transport: "http" });

  assert.equal(result.kind, "official");
  assert.equal(result.body, body);
});
