import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderRegistryEditor } from "../../src/provider/management.mjs";

test("provider and model changes share validation and atomic persistence", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-editor-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const editor = new ProviderRegistryEditor(path.join(directory, "providers.json"));
  editor.ensure();
  editor.addProvider("local", { baseUrl: "http://127.0.0.1:8000/v1" });
  editor.setCredential("local", { type: "inline", api_key: "visible-key" });
  editor.addModel("local", "local-model", { context_window: 32768, vision_mode: "native" });
  const view = editor.publicView();
  assert.deepEqual(view.providers.local.credential, { type: "inline" });
  assert.equal(view.providers.local.models["local-model"].context_window, 32768);
  editor.removeModel("local-model");
  editor.removeProvider("local");
  assert.equal(editor.publicView().providers.local, undefined);
});

test("rejects duplicate model routes across providers", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-editor-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const editor = new ProviderRegistryEditor(path.join(directory, "providers.json"));
  editor.ensure();
  editor.addProvider("second", { baseUrl: "https://example.com/v1" });
  assert.throws(() => editor.addModel("second", "glm-5.2"), /already exists/);
});
