import assert from "node:assert/strict";
import test from "node:test";

import { runtimeConfig } from "./runtime-config.mjs";

test("one runtime configuration controls router, registry, vision, and the project runtime", () => {
  const config = runtimeConfig({ CODEX_HYBRID_PORT: "19123" }, "/tmp/hybrid-home");
  assert.equal(config.port, 19123);
  assert.equal(config.providerRegistryFile, "/tmp/hybrid-home/.codex/hybrid/providers.json");
  assert.equal(config.visionEndpoint, "http://127.0.0.1:19123/hybrid/vision/analyze");
  assert.equal(config.nodeExecutable, "/tmp/hybrid-home/.codex/hybrid/runtime/node");
});

test("rejects invalid ports", () => {
  assert.throws(() => runtimeConfig({ CODEX_HYBRID_PORT: "70000" }, "/tmp/home"), /valid TCP port/);
});
