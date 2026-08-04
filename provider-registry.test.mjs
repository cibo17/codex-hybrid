import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ProviderRegistry,
  defaultRegistry,
  publicRegistry,
  resolveCredential,
  validateRegistry,
  writeRegistry,
} from "./provider-registry.mjs";

test("default registry preserves the existing Ollama model routes", () => {
  const registry = validateRegistry(defaultRegistry());
  assert.equal(registry.routes.get("deepseek-v4-flash:0731"), "ollama-pro");
  assert.equal(registry.routes.get("glm-5.2"), "ollama-pro");
});

test("accepts inline, environment, keychain, and no-auth credentials", () => {
  for (const credential of [
    { type: "inline", api_key: "visible" },
    { type: "env", name: "PROVIDER_KEY" },
    { type: "keychain", service: "hybrid", account: "provider" },
    { type: "none" },
  ]) {
    const value = defaultRegistry();
    value.providers["ollama-pro"].credential = credential;
    assert.equal(validateRegistry(value).providers["ollama-pro"].credential.type, credential.type);
  }
});

test("public registry redacts inline credential values", () => {
  const value = defaultRegistry();
  value.providers["ollama-pro"].credential = { type: "inline", api_key: "plain-text-is-allowed" };
  assert.deepEqual(publicRegistry(value).providers["ollama-pro"].credential, { type: "inline" });
});

test("requires globally unique model routes", () => {
  const value = defaultRegistry();
  value.providers.second = {
    base_url: "https://example.com/v1",
    credential: { type: "none" },
    models: { "glm-5.2": {} },
  };
  assert.throws(() => validateRegistry(value), /claimed by multiple providers/);
});

test("allows HTTP only for loopback providers", () => {
  const value = defaultRegistry();
  value.providers["ollama-pro"].base_url = "http://example.com/v1";
  assert.throws(() => validateRegistry(value), /HTTPS or loopback HTTP/);
  value.providers["ollama-pro"].base_url = "http://127.0.0.1:11434/v1";
  assert.equal(validateRegistry(value).providers["ollama-pro"].base_url, "http://127.0.0.1:11434/v1");
});

test("resolves all credential sources without exposing policy to callers", () => {
  assert.equal(resolveCredential({ type: "inline", api_key: "inline" }), "inline");
  assert.equal(resolveCredential({ type: "env", name: "KEY" }, { KEY: "from-env" }), "from-env");
  assert.equal(resolveCredential({ type: "none" }), "");
  const spawn = () => ({ status: 0, stdout: "from-keychain\n" });
  assert.equal(resolveCredential({ type: "keychain", service: "s", account: "a" }, {}, spawn), "from-keychain");
});

test("hot reload keeps the last-known-good registry on invalid edits", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-registry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "providers.json");
  writeRegistry(file, defaultRegistry());
  const errors = [];
  const registry = new ProviderRegistry(file, { onError: (message) => errors.push(message) });
  registry.ensure();
  assert.equal(registry.route("glm-5.2").provider.id, "ollama-pro");
  fs.writeFileSync(file, "{ invalid", "utf8");
  assert.equal(registry.route("glm-5.2").provider.id, "ollama-pro");
  assert.equal(errors.length, 1);
});
