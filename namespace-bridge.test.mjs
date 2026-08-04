import assert from "node:assert/strict";
import test from "node:test";
import { adaptNamespacesForProvider, restoreNamespaces } from "./namespace-bridge.mjs";

const fn = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });

test("flattens a namespace and restores the Codex response shape", () => {
  const { body, bridge } = adaptNamespacesForProvider({
    tools: [{ type: "namespace", name: "mcp__node_repl", tools: [fn("js")] }],
    input: [],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["mcp__node_repl__js"]);
  const response = { type: "function_call", name: "mcp__node_repl__js", arguments: "{}" };
  restoreNamespaces(response, bridge);
  assert.equal(response.name, "js");
  assert.equal(response.namespace, "mcp__node_repl");
});

test("does not emit ambiguous short aliases", () => {
  const { body, bridge } = adaptNamespacesForProvider({
    tools: [
      { type: "namespace", name: "mcp__one", tools: [fn("_search")] },
      { type: "namespace", name: "mcp__two", tools: [fn("_search")] },
    ],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["mcp__one___search", "mcp__two___search"]);
  assert.equal(bridge.targetFor("_search"), undefined);
});

test("a direct function wins over a namespace short name", () => {
  const { body, bridge } = adaptNamespacesForProvider({
    tools: [
      { type: "function", ...fn("js") },
      { type: "namespace", name: "mcp__node_repl", tools: [fn("js")] },
    ],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["js", "mcp__node_repl__js"]);
  assert.equal(bridge.targetFor("js"), undefined);
});

test("lifts additional tools and flattens history and tool choice", () => {
  const { body } = adaptNamespacesForProvider({
    tools: [],
    input: [
      { type: "additional_tools", tools: [{ type: "namespace", name: "mcp__x", tools: [fn("run")] }] },
      { type: "function_call", name: "run", namespace: "mcp__x", call_id: "call_1", arguments: "{}" },
    ],
    tool_choice: { type: "function", name: "run", namespace: "mcp__x" },
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["mcp__x__run"]);
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].name, "mcp__x__run");
  assert.equal(body.input[0].namespace, undefined);
  assert.equal(body.tool_choice.name, "mcp__x__run");
});

test("keeps essential namespaces and defers Linear and Atlassian by default", () => {
  const { body } = adaptNamespacesForProvider({
    tools: [
      { type: "namespace", name: "mcp__codex_apps__github", tools: [fn("_get_repo")] },
      { type: "namespace", name: "mcp__node_repl", tools: [fn("js")] },
      { type: "namespace", name: "mcp__codex_apps__linear", tools: [fn("_save_issue")] },
      { type: "namespace", name: "mcp__codex_apps__atlassian_rovo", tools: [fn("_search")] },
    ],
    input: [{ role: "user", content: [{ type: "input_text", text: "Inspect this repository" }] }],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), [
    "mcp__codex_apps__github___get_repo",
    "mcp__node_repl__js",
  ]);
});

test("loads only the lazy namespace named by the latest user message", () => {
  const tools = [
    { type: "namespace", name: "mcp__codex_apps__linear", tools: [fn("_save_issue")] },
    { type: "namespace", name: "mcp__codex_apps__atlassian_rovo", tools: [fn("_search")] },
  ];
  const linear = adaptNamespacesForProvider({
    tools,
    input: [{ role: "user", content: "Please update this in Linear" }],
  }).body;
  assert.deepEqual(linear.tools.map((tool) => tool.name), ["mcp__codex_apps__linear___save_issue"]);

  const jira = adaptNamespacesForProvider({
    tools,
    input: [{ role: "user", content: "Find the matching Jira ticket" }],
  }).body;
  assert.deepEqual(jira.tools.map((tool) => tool.name), ["mcp__codex_apps__atlassian_rovo___search"]);
});

test("keeps a lazy namespace active when conversation history already used it", () => {
  const { body } = adaptNamespacesForProvider({
    tools: [{ type: "namespace", name: "mcp__codex_apps__linear", tools: [fn("_save_issue")] }],
    input: [
      {
        type: "function_call",
        name: "_save_issue",
        namespace: "mcp__codex_apps__linear",
        call_id: "call_1",
        arguments: "{}",
      },
      { role: "user", content: "Update it again" },
    ],
  });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["mcp__codex_apps__linear___save_issue"]);
});
