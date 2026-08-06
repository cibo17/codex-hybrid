import assert from "node:assert/strict";
import test from "node:test";

import { ResponsesSseAdapter, parseSseBlock } from "../../src/protocol/sse.mjs";
import { ProviderToolCodec } from "../../src/tools/codec.mjs";

test("SSE parser and stream adapter preserve portable events", async () => {
  assert.deepEqual(parseSseBlock('event: response.created\ndata: {"type":"response.created"}'), {
    eventName: "response.created",
    data: { type: "response.created" },
  });
  const turn = new ProviderToolCodec().prepare({ tools: [] });
  const adapter = new ResponsesSseAdapter(turn);
  const chunks = [];
  adapter.on("data", (chunk) => chunks.push(chunk));
  adapter.end(Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'));
  await new Promise((resolve, reject) => {
    adapter.on("end", resolve);
    adapter.on("error", reject);
  });
  assert.match(Buffer.concat(chunks).toString("utf8"), /response\.created/);
});
