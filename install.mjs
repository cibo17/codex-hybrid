#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeConfig } from "./runtime-config.mjs";

if (process.platform !== "darwin") throw new Error("Codex Hybrid currently supports macOS only");

const SOURCE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_HOME = process.env.CODEX_HYBRID_INSTALL_HOME || os.homedir();
const runtime = runtimeConfig(process.env, INSTALL_HOME);
const DEST = runtime.root;
const RUNTIME = runtime.nodeExecutable;
const SOURCE_NODE = process.env.CODEX_HYBRID_NODE || process.execPath;
const BIN_DIR = path.join(INSTALL_HOME, ".local", "bin");
const CLI = path.join(BIN_DIR, "codex-hybrid");
const PLIST = runtime.launchAgentFile;
const PORT = String(runtime.port);
const files = [
  "codex-hybrid.mjs",
  "router.mjs",
  "activation.mjs",
  "model-routing.mjs",
  "namespace-bridge.mjs",
  "provider-management.mjs",
  "provider-registry.mjs",
  "responses-protocol.mjs",
  "runtime-config.mjs",
  "vision-bridge.mjs",
  "vision-workflow.mjs",
  "vision-mcp.mjs",
  "package.json",
  "package-lock.json",
  "app-server-model-list.mjs",
];

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function environmentXml() {
  const environment = { CODEX_HYBRID_PORT: PORT };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return Object.entries(environment)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join("\n");
}

fs.mkdirSync(DEST, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(RUNTIME), { recursive: true, mode: 0o700 });
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PLIST), { recursive: true });
for (const file of files) fs.copyFileSync(path.join(SOURCE, file), path.join(DEST, file));
try {
  fs.unlinkSync(RUNTIME);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.symlinkSync(SOURCE_NODE, RUNTIME);
fs.chmodSync(path.join(DEST, "codex-hybrid.mjs"), 0o755);
try {
  fs.unlinkSync(CLI);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
fs.symlinkSync(path.join(DEST, "codex-hybrid.mjs"), CLI);

const install = spawnSync("npm", ["ci", "--omit=dev", "--prefix", DEST], {
  encoding: "utf8",
  stdio: "inherit",
});
if (install.status !== 0) throw new Error("npm dependency installation failed");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.openai.codex-hybrid-router</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(RUNTIME)}</string>
      <string>${xml(path.join(DEST, "router.mjs"))}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml()}
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(path.join(DEST, "router.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(path.join(DEST, "router.log"))}</string>
  </dict>
</plist>
`;
fs.writeFileSync(PLIST, plist, { mode: 0o600 });

process.stdout.write(`Installed Codex Hybrid into ${DEST}\n`);
process.stdout.write(`CLI: ${CLI}\n`);
process.stdout.write(`Runtime Node: ${RUNTIME} -> ${SOURCE_NODE}\n`);
process.stdout.write("Add the Ollama Pro key to Keychain, then run: codex-hybrid on\n");
