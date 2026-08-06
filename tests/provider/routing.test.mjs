import assert from "node:assert/strict";
import test from "node:test";

import { ModelRoutingPipeline } from "../../src/provider/routing.mjs";

function route() {
  return {
    provider: { id: "custom", base_url: "https://example.com/v1", credential: { type: "inline", api_key: "key" } },
    model: { vision_mode: "delegated", upstream_model: "upstream-custom" },
  };
}

test("official models bypass provider compatibility translation", async () => {
  const body = { model: "gpt-5.6-luna", tools: [{ type: "function", name: "official_tool" }] };
  const vision = {
    prepareOfficialBody: (value) => value,
    prepareProviderBody: () => assert.fail("provider vision should not run"),
  };
  const toolCodec = { prepare: () => assert.fail("official tools must bypass ProviderToolCodec") };
  const pipeline = new ModelRoutingPipeline({ registry: { route: () => null }, visionWorkflow: vision, toolCodec });
  const result = await pipeline.prepare(body, { transport: "http" });
  assert.equal(result.kind, "official");
  assert.equal(result.body, body);
  assert.equal(result.toolTurn, null);
});

test("provider models cross one vision and protocol pipeline", async () => {
  const calls = [];
  const vision = {
    prepareOfficialBody: () => assert.fail("official vision should not run"),
    prepareProviderBody: async (body, context) => {
      calls.push(context);
      return { body: { ...body, prompt_cache_key: "remove-me" }, contextId: "vision-1" };
    },
  };
  const pipeline = new ModelRoutingPipeline({ registry: { route }, visionWorkflow: vision });
  const result = await pipeline.prepare({ model: "custom-model" }, {
    transport: "websocket",
    authHeaders: new Headers(),
    accountScope: "account",
    contextId: "existing",
  });
  assert.equal(result.kind, "provider");
  assert.equal(result.route.provider.id, "custom");
  assert.equal(result.body.model, "upstream-custom");
  assert.equal(result.contextId, "vision-1");
  assert.equal(result.body.prompt_cache_key, undefined);
  assert.equal(calls[0].transport, "websocket");
});
