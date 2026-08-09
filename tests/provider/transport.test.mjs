import assert from "node:assert/strict";
import test from "node:test";

import { ProviderTimeoutError, ProviderTransport } from "../../src/provider/transport.mjs";

function route(overrides = {}) {
  return {
    provider: {
      id: "custom",
      base_url: "https://example.com/v1",
      credential: { type: "none" },
      credential_pool: {
        strategy: "fill_first",
        cooldown_ms: 1_000,
        first_event_timeout_ms: 25,
        idle_timeout_ms: 25,
        entries: [
          { id: "primary", type: "inline", api_key: "key-1" },
          { id: "secondary", type: "inline", api_key: "key-2" },
        ],
      },
      ...overrides,
    },
    model: {},
  };
}

function completed(text = "OK") {
  return new Response(`event: response.completed\ndata: {"type":"response.completed","text":"${text}"}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("fill-first keeps using the primary credential while it is healthy", async () => {
  const authorizations = [];
  const transport = new ProviderTransport({
    fetch: async (_url, init) => {
      authorizations.push(init.headers.get("authorization"));
      return completed();
    },
  });
  assert.match(await (await transport.request(route(), "/responses")).text(), /response.completed/);
  assert.match(await (await transport.request(route(), "/responses")).text(), /response.completed/);
  assert.deepEqual(authorizations, ["Bearer key-1", "Bearer key-1"]);
});

test("retryable status cools the primary credential and fills from secondary", async () => {
  let now = 1_000;
  const authorizations = [];
  const transport = new ProviderTransport({
    now: () => now,
    fetch: async (_url, init) => {
      const authorization = init.headers.get("authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer key-1") return new Response("limited", { status: 429 });
      return completed("SECONDARY");
    },
  });
  assert.match(await (await transport.request(route(), "/responses")).text(), /SECONDARY/);
  assert.match(await (await transport.request(route(), "/responses")).text(), /SECONDARY/);
  now += 1_001;
  assert.match(await (await transport.request(route(), "/responses")).text(), /SECONDARY/);
  assert.deepEqual(authorizations, ["Bearer key-1", "Bearer key-2", "Bearer key-2", "Bearer key-1", "Bearer key-2"]);
});

test("first SSE event timeout fails over before exposing output", async () => {
  const authorizations = [];
  const transport = new ProviderTransport({
    fetch: async (_url, init) => {
      const authorization = init.headers.get("authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer key-1") {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return completed("FAILOVER");
    },
  });
  assert.match(await (await transport.request(route(), "/responses")).text(), /FAILOVER/);
  assert.deepEqual(authorizations, ["Bearer key-1", "Bearer key-2"]);
});

test("response header timeout fails over before a request can hang", async () => {
  const authorizations = [];
  const transport = new ProviderTransport({
    fetch: async (_url, init) => {
      const authorization = init.headers.get("authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer key-1") return new Promise(() => {});
      return completed("HEADER_FAILOVER");
    },
  });
  assert.match(await (await transport.request(route(), "/responses")).text(), /HEADER_FAILOVER/);
  assert.deepEqual(authorizations, ["Bearer key-1", "Bearer key-2"]);
});

test("idle timeout terminates a partially emitted stream without replaying another credential", async () => {
  const authorizations = [];
  const transport = new ProviderTransport({
    fetch: async (_url, init) => {
      const authorization = init.headers.get("authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer key-2") return completed("SECONDARY");
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const response = await transport.request(route(), "/responses");
  await assert.rejects(response.text(), (error) => error instanceof ProviderTimeoutError && error.kind === "stream idle");
  assert.match(await (await transport.request(route(), "/responses")).text(), /SECONDARY/);
  assert.deepEqual(authorizations, ["Bearer key-1", "Bearer key-2"]);
});

test("consumer cancellation after a terminal event does not cool a healthy credential", async () => {
  const authorizations = [];
  let requestCount = 0;
  const transport = new ProviderTransport({
    fetch: async (_url, init) => {
      authorizations.push(init.headers.get("authorization"));
      requestCount += 1;
      if (requestCount > 1) return completed("NEXT");
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: response.completed\ndata: {"type":"response.completed"}\n\n'));
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const response = await transport.request(route(), "/responses");
  await response.body.cancel("terminal event received");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(await (await transport.request(route(), "/responses")).text(), /NEXT/);
  assert.deepEqual(authorizations, ["Bearer key-1", "Bearer key-1"]);
});

test("legacy single credentials use the same transport interface", async () => {
  let authorization;
  const legacy = route({ credential_pool: null, credential: { type: "inline", api_key: "legacy" } });
  const transport = new ProviderTransport({
    fetch: async (_url, init) => {
      authorization = init.headers.get("authorization");
      return completed();
    },
  });
  await (await transport.request(legacy, "/responses")).text();
  assert.equal(authorization, "Bearer legacy");
});
