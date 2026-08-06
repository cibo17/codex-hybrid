import assert from "node:assert/strict";
import test from "node:test";

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
