import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VisionEvidenceWorkflow } from "../../src/vision/workflow.mjs";

function workflow(tokenFile, fetch = async () => assert.fail("unexpected Luna call")) {
  return new VisionEvidenceWorkflow({
    tokenFile,
    openAiBase: "https://chatgpt.com/backend-api/codex",
    fetch,
    dispatcher: null,
  });
}

test("delegated vision returns an opaque context without owning tool encoding", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vision-workflow-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "vision.token");
  fs.writeFileSync(tokenFile, "token\n");
  const result = await workflow(tokenFile).prepareProviderBody({
    model: "custom",
    tools: [{ type: "namespace", name: "mcp__hybrid_vision", tools: [{ type: "function", name: "analyze_image" }] }],
    input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  }, { visionMode: "delegated", headers: new Headers(), accountScope: "a", promptCacheKey: "p" });
  const tool = result.body.tools[0].tools[0];
  assert.equal(tool.parameters, undefined);
  assert.match(result.contextId, /^vision_ctx_/);
});

test("native vision removes the Hybrid-only tool and preserves images", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vision-workflow-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const body = {
    tools: [{ type: "namespace", name: "mcp__hybrid_vision", tools: [] }],
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  };
  const result = await workflow(path.join(directory, "token")).prepareProviderBody(body, { visionMode: "native" });
  assert.deepEqual(result.body.tools, []);
  assert.equal(result.body.input[0].content[0].type, "input_image");
});

test("explicit image analysis reuses the same workflow and Luna adapter", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vision-workflow-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, "vision.token");
  const imageFile = path.join(directory, "image.png");
  fs.writeFileSync(tokenFile, "token\n");
  fs.writeFileSync(imageFile, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const fakeFetch = async () => ({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ output: [{ type: "output_text", text: "visible evidence" }] }),
  });
  const instance = workflow(tokenFile, fakeFetch);
  const prepared = await instance.prepareProviderBody({ input: [] }, {
    visionMode: "delegated",
    headers: new Headers({ authorization: "Bearer chatgpt" }),
    accountScope: "a",
    promptCacheKey: "p",
  });
  const result = await instance.analyzePath({
    token: "token",
    path: imageFile,
    prompt: "inspect",
    contextId: prepared.contextId,
  });
  assert.equal(result, "visible evidence");
});
