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
} from "../../src/provider/registry.mjs";

test("default registry preserves the existing Ollama model routes", () => {
  const registry = validateRegistry(defaultRegistry());
  assert.equal(registry.routes.get("deepseek-v4-flash:0731"), "ollama-pro");
  assert.equal(registry.routes.get("glm-5.2"), "ollama-pro");
  assert.equal(registry.providers["ollama-pro"].models["glm-5.2"].upstream_model, "glm-5.2");
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

test("validates and redacts fill-first credential pools", () => {
  const value = defaultRegistry();
  value.providers["ollama-pro"].credential_pool = {
    strategy: "fill_first",
    cooldown_ms: 10_000,
    first_event_timeout_ms: 2_000,
    idle_timeout_ms: 5_000,
    entries: [
      { id: "primary", type: "inline", api_key: "first" },
      { id: "secondary", type: "env", name: "SECOND_KEY" },
    ],
  };
  const provider = validateRegistry(value).providers["ollama-pro"];
  assert.equal(provider.credential_pool.entries.length, 2);
  assert.deepEqual(publicRegistry(value).providers["ollama-pro"].credential_pool.entries, [
    { id: "primary", type: "inline" },
    { id: "secondary", type: "env" },
  ]);
  value.providers["ollama-pro"].credential_pool.entries[1].id = "primary";
  assert.throws(() => validateRegistry(value), /duplicated/);
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

test("validates native and external search modes", () => {
  const value = defaultRegistry();
  value.providers["ollama-pro"].models["glm-5.2"].search_mode = "native";
  assert.equal(validateRegistry(value).providers["ollama-pro"].models["glm-5.2"].search_mode, "native");
  value.providers["ollama-pro"].models["glm-5.2"].search_mode = "unknown";
  assert.throws(() => validateRegistry(value), /search_mode is invalid/);
});

test("validates delegated vision limits and failure policy", () => {
  const value = defaultRegistry();
  const model = value.providers["ollama-pro"].models["glm-5.2"];
  model.vision_max_images_per_turn = 3;
  model.vision_failure_policy = "error_evidence";
  const validated = validateRegistry(value).providers["ollama-pro"].models["glm-5.2"];
  assert.equal(validated.vision_max_images_per_turn, 3);
  assert.equal(validated.vision_failure_policy, "error_evidence");
  model.vision_max_images_per_turn = 0;
  assert.throws(() => validateRegistry(value), /vision_max_images_per_turn/);
});

test("normalizes and validates provider tool protocol capabilities", () => {
  const value = defaultRegistry();
  value.providers["ollama-pro"].models["glm-5.2"].tool_protocol = {
    namespaces: "native",
    custom_tools: "native",
    deferred_tools: "expand",
    tool_search: "disabled",
  };
  assert.deepEqual(validateRegistry(value).providers["ollama-pro"].models["glm-5.2"].tool_protocol, {
    namespaces: "native",
    custom_tools: "native",
    deferred_tools: "expand",
    tool_search: "disabled",
  });
  value.providers["ollama-pro"].models["glm-5.2"].tool_protocol.namespaces = "guess";
  assert.throws(() => validateRegistry(value), /tool_protocol\.namespaces is invalid/);
});

test("validates per-model upstream API protocols", () => {
  const value = defaultRegistry();
  value.providers["ollama-pro"].models["glm-5.2"].api_protocol = "chat_completions";
  assert.equal(validateRegistry(value).providers["ollama-pro"].models["glm-5.2"].api_protocol, "chat_completions");
  value.providers["ollama-pro"].models["glm-5.2"].api_protocol = "anthropic_messages";
  assert.equal(validateRegistry(value).providers["ollama-pro"].models["glm-5.2"].api_protocol, "anthropic_messages");
  value.providers["ollama-pro"].models["glm-5.2"].api_protocol = "messages";
  assert.throws(() => validateRegistry(value), /api_protocol is invalid/);
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
