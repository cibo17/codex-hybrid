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
  let resolveProviderStreamClosed;
  const providerStreamClosed = new Promise((resolve) => { resolveProviderStreamClosed = resolve; });
  let resolveProviderFirstEventPending;
  const providerFirstEventPending = new Promise((resolve) => { resolveProviderFirstEventPending = resolve; });
  let resolveProviderFirstEventStreamClosed;
  const providerFirstEventStreamClosed = new Promise((resolve) => { resolveProviderFirstEventStreamClosed = resolve; });
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestBody = Buffer.concat(chunks).toString("utf8");
    upstreamRequests.push({
      url: request.url,
      authorization: request.headers.authorization,
      anthropicVersion: request.headers["anthropic-version"],
      body: JSON.parse(requestBody),
    });
    if (request.url.endsWith("/messages")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_anthropic", model: "anthropic-upstream", usage: { input_tokens: 4, output_tokens: 0 } } })}\n\n`);
      response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ANTHROPIC_OK" } })}\n\n`);
      response.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      response.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`);
      response.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return;
    }
    if (request.url.endsWith("/chat/completions")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chat_json",
        object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "CHAT_JSON_OK" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requestBody.includes("disconnect before provider stream starts")) {
      response.flushHeaders();
      response.once("close", resolveProviderFirstEventStreamClosed);
      resolveProviderFirstEventPending();
      return;
    }
    if (requestBody.includes("disconnect active provider stream")) {
      const heartbeat = setInterval(() => response.write('event: ping\ndata: {"type":"ping"}\n\n'), 25);
      response.once("close", () => {
        clearInterval(heartbeat);
        resolveProviderStreamClosed();
      });
      response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_disconnect","object":"response","status":"in_progress","output":[]}}\n\n');
      return;
    }
    response.write('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_custom","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"CUSTOM_OK"}]}]}}\n\n');
    setTimeout(() => response.end('event: ping\ndata: {"type":"ping"}\n\n'), 750);
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
          "chat-json-model": {
            upstream_model: "chat-json-upstream",
            context_window: 32768,
            reasoning_efforts: ["high"],
            default_reasoning_effort: "high",
            vision_mode: "native",
            api_protocol: "chat_completions",
          },
          "anthropic-model": {
            upstream_model: "anthropic-upstream",
            context_window: 1048576,
            reasoning_efforts: ["low", "medium", "high"],
            default_reasoning_effort: "high",
            vision_mode: "native",
            api_protocol: "anthropic_messages",
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
  assert.deepEqual(health.registry, { providers: 1, models: 3, error: null });

  const responseStartedAt = Date.now();
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
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "function_call", id: "fc_from_another_provider", call_id: "call_shared", name: "lookup", arguments: "{}" },
        { type: "function_call_output", id: "fco_from_another_provider", call_id: "call_shared", output: "done" },
      ],
    }),
  });
  const text = await response.text();
  const responseDurationMs = Date.now() - responseStartedAt;
  assert.equal(response.status, 200, stderr);
  assert.match(text, /CUSTOM_OK/);
  assert.doesNotMatch(text, /event: ping/);
  assert.ok(responseDurationMs < 500, `terminal response took ${responseDurationMs} ms`);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, "/v1/responses");
  assert.equal(upstreamRequests[0].authorization, "Bearer plain-text-key");
  assert.equal(upstreamRequests[0].body.prompt_cache_key, undefined);
  assert.equal(upstreamRequests[0].body.input[1].id, undefined);
  assert.equal(upstreamRequests[0].body.input[1].call_id, "call_shared");
  assert.equal(upstreamRequests[0].body.input[2].id, undefined);

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

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${routerPort}/v1/responses`);
    let closed = false;
    socket.on("open", () => {
      for (let index = 0; index < 2; index += 1) {
        socket.send(JSON.stringify({
          type: "response.create",
          model: "custom-model",
          input: [{ role: "user", content: [{ type: "input_text", text: "disconnect active provider stream" }] }],
        }));
      }
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "response.created" && !closed) {
        closed = true;
        socket.close();
      }
    });
    socket.on("close", resolve);
    socket.on("error", reject);
  });
  await Promise.race([
    providerStreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream remained open after client disconnect")), 1_000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(upstreamRequests.length, 3, "queued provider request must not start after client disconnect");

  const pendingStreamSocket = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${routerPort}/v1/responses`);
    socket.on("open", () => {
      socket.send(JSON.stringify({
        type: "response.create",
        model: "custom-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "disconnect before provider stream starts" }] }],
      }));
      resolve(socket);
    });
    socket.on("error", reject);
  });
  await providerFirstEventPending;
  pendingStreamSocket.close();
  await Promise.race([
    providerFirstEventStreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream awaiting its first event remained open after client disconnect")), 1_000)),
  ]);
  assert.equal(upstreamRequests.length, 4);

  const chatJsonResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chat-json-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "json response" }] }],
    }),
  });
  const chatJsonBody = await chatJsonResponse.json();
  assert.equal(chatJsonBody.status, "completed");
  assert.equal(chatJsonBody.output[0].content[0].text, "CHAT_JSON_OK");
  assert.equal(chatJsonBody.usage.total_tokens, 7);

  const chatJsonWebSocket = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${routerPort}/v1/responses`);
    socket.on("open", () => socket.send(JSON.stringify({
      type: "response.create",
      model: "chat-json-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "json websocket" }] }],
    })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "response.completed") {
        resolve(message.response);
        socket.close();
      }
    });
    socket.on("error", reject);
  });
  assert.equal(chatJsonWebSocket.output[0].content[0].text, "CHAT_JSON_OK");
  assert.equal(upstreamRequests.at(-1).url, "/v1/chat/completions");

  const anthropicResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "anthropic-model",
      reasoning: { effort: "high" },
      input: [{ role: "user", content: [{ type: "input_text", text: "anthropic http" }] }],
    }),
  });
  const anthropicText = await anthropicResponse.text();
  assert.match(anthropicText, /ANTHROPIC_OK/);
  assert.equal(upstreamRequests.at(-1).url, "/v1/messages");
  assert.equal(upstreamRequests.at(-1).anthropicVersion, "2023-06-01");
  assert.deepEqual(upstreamRequests.at(-1).body.thinking, { type: "adaptive" });

  const anthropicWebSocket = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${routerPort}/v1/responses`);
    socket.on("open", () => socket.send(JSON.stringify({
      type: "response.create",
      model: "anthropic-model",
      input: [{ role: "user", content: [{ type: "input_text", text: "anthropic websocket" }] }],
    })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "response.completed") {
        resolve(message.response);
        socket.close();
      }
    });
    socket.on("error", reject);
  });
  assert.equal(anthropicWebSocket.output[0].content[0].text, "ANTHROPIC_OK");
});
