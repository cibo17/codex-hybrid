import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("installer preserves the public layout in the private runtime", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const install = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "install.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HYBRID_INSTALL_HOME: home, CODEX_HYBRID_PORT: "19127" },
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);

  const root = path.join(home, ".codex", "hybrid");
  const runtimeNode = path.join(root, "runtime", "node");
  const cli = path.join(home, ".local", "bin", "codex-hybrid");
  const plist = path.join(home, "Library", "LaunchAgents", "com.openai.codex-hybrid-router.plist");
  assert.equal(fs.lstatSync(runtimeNode).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(cli), path.join(root, "bin", "codex-hybrid.mjs"));
  assert.match(fs.readFileSync(plist, "utf8"), /src\/router\.mjs/);
  assert.equal(fs.existsSync(path.join(root, "router.mjs")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "provider", "registry.mjs")), true);
  assert.equal(fs.existsSync(path.join(root, "src", "tools", "codec.mjs")), true);
  assert.equal(fs.existsSync(path.join(root, "src", "protocol", "responses.mjs")), false);

  const list = spawnSync(runtimeNode, [cli, "provider", "list"], {
    env: { ...process.env, CODEX_HYBRID_HOME: home, CODEX_HYBRID_PORT: "19127" },
    encoding: "utf8",
  });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).providers["ollama-pro"].credential.type, "keychain");
});
