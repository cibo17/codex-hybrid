import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HYBRID_VISION_NAMESPACE,
  VisionCache,
  bindHybridVisionContext,
  imageDataUrlFromPath,
  latestUserHasDirectImage,
  replaceImagesForTextModel,
  sanitizeHistoryForOpenAI,
  stripHybridVisionTools,
  suppressViewImageTool,
} from "../../src/vision/bridge.mjs";

test("removes hybrid vision tools from top-level and deferred collections", () => {
  const body = stripHybridVisionTools({
    tools: [
      { type: "namespace", name: HYBRID_VISION_NAMESPACE, tools: [{ name: "analyze_image" }] },
      { type: "function", name: "keep_me" },
    ],
    input: [{ type: "additional_tools", tools: [{ type: "function", name: "mcp__hybrid_vision__analyze_image" }] }],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["keep_me"]);
  assert.deepEqual(body.input[0].tools, []);
});

test("official-model sanitization preserves native view_image", () => {
  const body = stripHybridVisionTools({
    tools: [
      { type: "function", name: "view_image" },
      { type: "namespace", name: HYBRID_VISION_NAMESPACE, tools: [{ name: "analyze_image" }] },
    ],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["view_image"]);
});

test("removes third-party reasoning but preserves official encrypted reasoning", () => {
  const body = sanitizeHistoryForOpenAI({
    input: [
      { type: "message", role: "assistant", content: "keep" },
      {
        type: "reasoning",
        id: "rs_55284",
        summary: [{ type: "summary_text", text: "third-party summary" }],
        encrypted_content: "The user asked a question in plain text.",
      },
      {
        type: "reasoning",
        id: "rs_01ee4cc07bff44f1016a70634e4c748194912e3a7434405c19",
        summary: [],
        encrypted_content: "gAAAAABofficial_ciphertext_without_spaces",
      },
      { type: "reasoning", id: "rs_missing_ciphertext", summary: [] },
    ],
  });
  assert.deepEqual(body.input.map((item) => item.type), ["message", "reasoning"]);
  assert.equal(body.input[1].id, "rs_01ee4cc07bff44f1016a70634e4c748194912e3a7434405c19");
});

test("binds an opaque capability only to the Hybrid vision tool", () => {
  const body = bindHybridVisionContext({
    tools: [
      {
        type: "namespace",
        name: HYBRID_VISION_NAMESPACE,
        tools: [{ name: "analyze_image", parameters: { type: "object", properties: {}, required: [] } }],
      },
      { type: "function", name: "keep_me", parameters: { type: "object", properties: {} } },
    ],
  }, "ctx_test");
  const schema = body.tools[0].tools[0].parameters;
  assert.deepEqual(schema.properties._hybrid_context_id.enum, ["ctx_test"]);
  assert.deepEqual(schema.required, ["_hybrid_context_id"]);
  assert.equal(body.tools[1].parameters.properties._hybrid_context_id, undefined);
});

test("replaces direct and tool-output images with delegated text", async () => {
  const calls = [];
  const result = await replaceImagesForTextModel({
    input: [
      { role: "user", content: [{ type: "input_text", text: "Read the error" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
      { type: "function_call_output", output: [{ type: "input_image", image_url: "data:image/png;base64,BBB", detail: "original" }] },
    ],
  }, async (request) => {
    calls.push(request);
    return `analysis-${calls.length}`;
  });
  assert.equal(result.replaced, 2);
  assert.equal(calls[0].prompt, "Read the error");
  assert.equal(result.body.input[0].content[1].type, "input_text");
  assert.match(result.body.input[1].output[0].text, /analysis-2/);
  assert.match(result.body.input[0].content[1].text, /HYBRID_VISION_ANALYSIS_SUCCEEDED/);
  assert.match(result.body.input[0].content[1].text, /not an error from the vision bridge/);
});

test("keeps an image tied to its own user prompt on later sampling rounds", async () => {
  const calls = [];
  await replaceImagesForTextModel({
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Read the original error" },
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "A later tool round" }] },
    ],
  }, async (request) => {
    calls.push(request);
    return "analysis";
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "Read the original error");
});

test("analyzes multiple images in parallel and preserves per-image evidence positions", async () => {
  const calls = [];
  const result = await replaceImagesForTextModel({
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Compare these" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
        { type: "input_image", image_url: "data:image/png;base64,BBB", detail: "original" },
      ],
    }],
  }, async (request) => {
    calls.push(request);
    if (request.label === "Image 1") await new Promise((resolve) => setTimeout(resolve, 10));
    return `analysis-${request.label}`;
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.mode), ["automatic", "automatic"]);
  assert.deepEqual(calls.map((call) => call.label), ["Image 1", "Image 2"]);
  assert.equal(result.replaced, 2);
  assert.deepEqual(result.body.input[0].content.map((item) => item.type), ["input_text", "input_text", "input_text"]);
  assert.match(result.body.input[0].content[1].text, /Visual evidence for Image 1/);
  assert.match(result.body.input[0].content[1].text, /analysis-Image 1/);
  assert.match(result.body.input[0].content[2].text, /Visual evidence for Image 2/);
  assert.match(result.body.input[0].content[2].text, /analysis-Image 2/);
});

test("detects an image only on the latest user message", () => {
  const oldImage = { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }] };
  assert.equal(latestUserHasDirectImage([oldImage]), true);
  assert.equal(latestUserHasDirectImage([oldImage, { role: "user", content: [{ type: "input_text", text: "look again" }] }]), false);
  assert.equal(latestUserHasDirectImage([
    oldImage,
    { role: "user", content: [{ type: "input_text", text: "new" }, { type: "input_image", image_url: "data:image/png;base64,BBB" }] },
  ]), true);
});

test("suppresses only the direct view_image tool", () => {
  const body = suppressViewImageTool({
    tools: [
      { type: "function", name: "view_image" },
      { type: "function", name: "exec_command" },
      { type: "namespace", name: "mcp__x", tools: [{ name: "view_image" }] },
    ],
    input: [{ type: "additional_tools", tools: [{ type: "function", name: "view_image" }] }],
    tool_choice: { type: "function", name: "view_image" },
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["exec_command", "mcp__x"]);
  assert.deepEqual(body.tools[1].tools.map((tool) => tool.name), ["view_image"]);
  assert.deepEqual(body.input[0].tools, []);
  assert.equal(body.tool_choice, "auto");
});

test("deduplicates identical in-flight and completed analyses", async () => {
  const cache = new VisionCache();
  let calls = 0;
  const request = { image_url: "data:image/png;base64,AAA", detail: "high", prompt: "inspect", mode: "automatic" };
  const values = await Promise.all([
    cache.getOrCreate(request, async () => { calls += 1; return "ok"; }),
    cache.getOrCreate(request, async () => { calls += 1; return "wrong"; }),
  ]);
  assert.deepEqual(values, ["ok", "ok"]);
  assert.equal(calls, 1);
  assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 1 });
});

test("deduplicates equivalent data URLs with different MIME labels", async () => {
  const cache = new VisionCache();
  let calls = 0;
  const png = { image_url: "data:image/png;base64,QUJD", detail: "high", prompt: "inspect", mode: "automatic" };
  const octet = { ...png, image_url: "data:application/octet-stream;base64,QUJD" };
  const first = await cache.getOrCreate(png, async () => { calls += 1; return "ok"; });
  const second = await cache.getOrCreate(octet, async () => { calls += 1; return "wrong"; });
  assert.equal(first, "ok");
  assert.equal(second, "ok");
  assert.equal(calls, 1);
});

test("normalizes harmless prompt formatting for cache keys", async () => {
  const cache = new VisionCache();
  let calls = 0;
  const base = { image_url: "data:image/png;base64,QUJD", detail: "high", mode: "automatic" };
  await cache.getOrCreate({ ...base, prompt: "  比较  两张图。 " }, async () => { calls += 1; return "ok"; });
  const result = await cache.getOrCreate({ ...base, prompt: "比较 两张图." }, async () => { calls += 1; return "wrong"; });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("expires cache entries after the configured TTL", async () => {
  let now = 1_000;
  const cache = new VisionCache(64, 50, () => now);
  let calls = 0;
  const request = { image_url: "data:image/png;base64,QUJD", prompt: "inspect" };
  await cache.getOrCreate(request, async () => { calls += 1; return "first"; });
  now = 1_049;
  assert.equal(await cache.getOrCreate(request, async () => "wrong"), "first");
  now = 1_051;
  assert.equal(await cache.getOrCreate(request, async () => { calls += 1; return "second"; }), "second");
  assert.equal(calls, 2);
  assert.deepEqual(cache.stats(), { entries: 1, hits: 1, misses: 2 });
});

test("loads a supported absolute image path as a data URL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-vision-test-"));
  const file = path.join(directory, "pixel.png");
  fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const result = imageDataUrlFromPath(file);
  assert.match(result.image_url, /^data:image\/png;base64,/);
});
