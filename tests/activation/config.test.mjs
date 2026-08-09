import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Hybrid keeps Realtime WebRTC calls on the native ChatGPT backend", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-activation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const previousHome = process.env.CODEX_HYBRID_HOME;
  const previousPort = process.env.CODEX_HYBRID_PORT;
  process.env.CODEX_HYBRID_HOME = home;
  process.env.CODEX_HYBRID_PORT = "19191";
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HYBRID_HOME;
    else process.env.CODEX_HYBRID_HOME = previousHome;
    if (previousPort === undefined) delete process.env.CODEX_HYBRID_PORT;
    else process.env.CODEX_HYBRID_PORT = previousPort;
  });

  const { buildHybridConfig } = await import(`../../src/activation.mjs?test=${Date.now()}`);
  const configured = buildHybridConfig([
    'experimental_realtime_webrtc_call_base_url = "https://example.invalid/v1"',
    'model = "gpt-5.6-luna"',
    "",
    "[features]",
    "realtime_conversation = true",
    "",
  ].join("\n"));

  assert.match(configured, /^openai_base_url = "http:\/\/127\.0\.0\.1:19191\/v1"$/m);
  assert.match(
    configured,
    /^experimental_realtime_webrtc_call_base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"$/m,
  );
  assert.equal((configured.match(/^experimental_realtime_webrtc_call_base_url\s*=/gm) || []).length, 1);
  assert.match(configured, /^\[features\]$/m);
});
