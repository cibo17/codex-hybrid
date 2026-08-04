import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";

import { writeRegistry } from "../../src/provider/registry.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForRouter(port, child, errorText = () => "") {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`router exited with ${child.exitCode}: ${errorText()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {
      // Router is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("router did not become healthy");
}

test("routes any configured Responses Provider through the generic protocol module", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-router-integration-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const upstreamRequests = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamRequests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_custom","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"CUSTOM_OK"}]}]}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const root = path.join(home, ".codex", "hybrid");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "vision.token"), "test-token\n");
  writeRegistry(path.join(root, "providers.json"), {
    version: 1,
    providers: {
      custom: {
        name: "Custom Responses",
        base_url: `http://127.0.0.1:${upstreamPort}/v1`,
        credential: { type: "inline", api_key: "plain-text-key" },
        models: {
          "custom-model": {
            context_window: 32768,
            reasoning_efforts: ["high"],
            default_reasoning_effort: "high",
            vision_mode: "native",
          },
        },
      },
    },
  });

  const routerPort = await freePort();
  const child = spawn(process.execPath, [path.join(process.cwd(), "src", "router.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HYBRID_HOME: home,
      CODEX_HYBRID_PORT: String(routerPort),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  const health = await waitForRouter(routerPort, child, () => stderr);
  assert.deepEqual(health.registry, { providers: 1, models: 1, error: null });

  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer chatgpt-credential-must-not-leak",
      "chatgpt-account-id": "account",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "custom-model",
      stream: true,
      prompt_cache_key: "codex-only",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, stderr);
  assert.match(text, /CUSTOM_OK/);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, "/v1/responses");
  assert.equal(upstreamRequests[0].authorization, "Bearer plain-text-key");
  assert.equal(upstreamRequests[0].body.prompt_cache_key, undefined);

  const websocketResult = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${routerPort}/v1/responses`);
    socket.on("open", () => socket.send(JSON.stringify({
      type: "response.create",
      model: "custom-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "websocket" }] }],
    })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "response.completed") {
        resolve(message);
        socket.close();
      }
    });
    socket.on("error", reject);
  });
  assert.equal(websocketResult.response.output[0].content[0].text, "CUSTOM_OK");
  assert.equal(upstreamRequests.length, 2);
});
