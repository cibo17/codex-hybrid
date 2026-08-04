import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function run(home, args) {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "codex-hybrid.mjs"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HYBRID_HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("CLI edits providers, credentials, models, and the active model catalog", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-cli-integration-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".codex", "hybrid");
  fs.mkdirSync(root, { recursive: true });
  const sourceCatalog = path.join(home, ".codex", "models.json");
  fs.writeFileSync(sourceCatalog, JSON.stringify({ models: [{
    slug: "gpt-5.6-terra",
    display_name: "GPT-5.6-Terra",
    description: "Official",
    prefer_websockets: true,
    base_instructions: "base",
    instructions_template: "base",
  }] }));
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ active: true, source_catalog: sourceCatalog }));

  run(home, ["provider", "add", "custom", "--base-url", "https://example.com/v1", "--api-key", "visible-key"]);
  run(home, ["model", "add", "custom", "custom-coder", "--context-window", "65536", "--vision", "native"]);
  const list = run(home, ["provider", "list"]);
  assert.doesNotMatch(list, /visible-key/);
  assert.match(list, /"type": "inline"/);

  let catalog = JSON.parse(fs.readFileSync(path.join(root, "models.hybrid.json"), "utf8"));
  assert.equal(catalog.models.find((model) => model.slug === "gpt-5.6-terra").prefer_websockets, true);
  assert.equal(catalog.models.find((model) => model.slug === "custom-coder").context_window, 65536);

  run(home, ["key", "set", "custom", "--env", "CUSTOM_API_KEY"]);
  run(home, ["model", "remove", "custom-coder"]);
  catalog = JSON.parse(fs.readFileSync(path.join(root, "models.hybrid.json"), "utf8"));
  assert.equal(catalog.models.some((model) => model.slug === "custom-coder"), false);
});
