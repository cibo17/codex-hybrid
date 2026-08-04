#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn("codex", ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: child.stdout });
let finished = false;

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const timer = setTimeout(() => {
  if (!finished) {
    process.stderr.write("app-server model/list timed out\n");
    child.kill("SIGTERM");
    process.exitCode = 1;
  }
}, 15_000);

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 1 && message.result) {
    send({ method: "initialized", params: {} });
    send({ method: "model/list", id: 2, params: { limit: 100, includeHidden: false } });
    return;
  }
  if (message.id === 2) {
    finished = true;
    clearTimeout(timer);
    process.stdout.write(`${JSON.stringify(message.result)}\n`);
    child.kill("SIGTERM");
  }
});

child.stderr.on("data", () => {});
child.on("exit", (code) => {
  if (!finished && code !== 0) process.exitCode = code || 1;
});

send({
  method: "initialize",
  id: 1,
  params: {
    clientInfo: {
      name: "codex_hybrid_verifier",
      title: "Codex Hybrid Verifier",
      version: "1.0.0",
    },
    capabilities: { experimentalApi: true },
  },
});
