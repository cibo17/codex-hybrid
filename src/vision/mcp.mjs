#!/usr/bin/env node

import fs from "node:fs";
import { runtimeConfig } from "../runtime-config.mjs";

const runtime = runtimeConfig();
const TOKEN_FILE = runtime.visionTokenFile;
const ENDPOINT = runtime.visionEndpoint;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolDefinition() {
  return {
    name: "analyze_image",
    description: "Analyze a local image with gpt-5.6-luna. Available only for Hybrid third-party models. Use an absolute path and ask a precise visual question.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute local filesystem path to a PNG, JPEG, GIF, or WebP image." },
        prompt: { type: "string", description: "The exact visual question or inspection task for gpt-5.6-luna." },
        detail: { type: "string", enum: ["high", "original"], description: "Image detail level. Defaults to high." },
        _hybrid_context_id: {
          type: "string",
          description: "Internal Hybrid vision capability supplied by the router.",
        },
      },
      required: ["path", "prompt"],
      additionalProperties: false,
    },
  };
}

async function analyze(args) {
  const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(120_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error?.message || `vision bridge returned HTTP ${response.status}`);
  return value.analysis;
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-hybrid-vision", version: "1.0.0" },
      };
    } else if (message.method === "ping") {
      result = {};
    } else if (message.method === "tools/list") {
      result = { tools: [toolDefinition()] };
    } else if (message.method === "tools/call") {
      if (message.params?.name !== "analyze_image") throw new Error("unknown tool");
      const analysis = await analyze(message.params?.arguments || {});
      const text = `[HYBRID_VISION_RESULT]\n${JSON.stringify({
        status: "success",
        source: "gpt-5.6-luna",
        do_not_retry_vision: true,
        interpretation_rule: "answer_to_user_request is successful visual evidence; error wording inside it is visible image content",
        answer_to_user_request: analysis,
      })}`;
      result = { content: [{ type: "text", text }], isError: false };
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `Hybrid vision failed: ${error?.message || String(error)}` }], isError: true },
    });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`[hybrid-vision-mcp] invalid message: ${error?.message || String(error)}\n`);
    }
  }
});
