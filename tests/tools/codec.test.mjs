import assert from "node:assert/strict";
import test from "node:test";

import { ProviderToolCodec } from "../../src/tools/codec.mjs";

const fn = (name) => ({ name, description: name, parameters: { type: "object", properties: {} } });

test("one provider turn hides namespace and custom-tool compatibility behind one interface", () => {
  const turn = new ProviderToolCodec().prepare({
    prompt_cache_key: "private-cache-key",
    service_tier: "priority",
    text: { verbosity: "high", format: { type: "text" } },
    tools: [
      { type: "namespace", name: "mcp__node_repl", tools: [fn("js")] },
      { type: "custom", name: "apply_patch", description: "patch" },
    ],
    input: [{ type: "custom_tool_call", name: "apply_patch", call_id: "1", input: "*** Begin Patch" }],
  });

  assert.equal(turn.upstreamBody.prompt_cache_key, undefined);
  assert.equal(turn.upstreamBody.service_tier, undefined);
  assert.deepEqual(turn.upstreamBody.text, { format: { type: "text" } });
  assert.deepEqual(turn.upstreamBody.tools.map((tool) => [tool.type, tool.name]), [
    ["function", "apply_patch"],
    ["function", "mcp__node_repl__js"],
  ]);
  assert.equal(turn.upstreamBody.input[0].type, "function_call");

  const response = turn.adaptResponse({
    output: [
      { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch: "PATCH" }) },
      { type: "function_call", name: "mcp__node_repl__js", arguments: "{}" },
    ],
  });
  assert.deepEqual(response.output, [
    { type: "custom_tool_call", name: "apply_patch", input: "PATCH" },
    { type: "function_call", namespace: "mcp__node_repl", name: "js", arguments: "{}" },
  ]);
});

test("code mode keeps subagents and vision available on every turn", () => {
  const turn = new ProviderToolCodec().prepare({
    tools: [
      { type: "custom", name: "exec", description: "Run code" },
      { type: "function", name: "mcp__node_repl__js", parameters: { type: "object" } },
      { type: "function", name: "mcp__hybrid_vision__analyze_image", parameters: { type: "object" } },
      { type: "namespace", name: "agents", tools: [{ type: "function", name: "spawn_agent" }] },
    ],
    input: [
      { role: "user", content: "Fix this function" },
      {
        type: "additional_tools",
        tools: [{ type: "namespace", name: "mcp__node_repl", tools: [fn("js")] }],
      },
    ],
  });
  assert.deepEqual(turn.upstreamBody.tools.map((tool) => tool.name), [
    "exec",
    "mcp__hybrid_vision__analyze_image",
    "agents__spawn_agent",
  ]);
  assert.equal(turn.upstreamBody.input.some((item) => item.type === "additional_tools"), false);
});

test("agent delegation tools remain available on ordinary turns", () => {
  const codec = new ProviderToolCodec();
  const tools = [{ type: "namespace", name: "agents", tools: [fn("spawn_agent"), fn("wait_agent")] }];
  const ordinary = codec.prepare({ tools, input: [{ role: "user", content: "Fix this function" }] });
  assert.deepEqual(ordinary.upstreamBody.tools.map((tool) => tool.name), ["agents__spawn_agent", "agents__wait_agent"]);
  const delegated = codec.prepare({ tools, input: [{ role: "user", content: "Delegate this to a subagent" }] });
  assert.deepEqual(delegated.upstreamBody.tools.map((tool) => tool.name), ["agents__spawn_agent", "agents__wait_agent"]);
});

test("lazy namespace policy stays outside namespace encoding", () => {
  const codec = new ProviderToolCodec();
  const tools = [
    { type: "namespace", name: "mcp__codex_apps__github", tools: [fn("_get_repo")] },
    { type: "namespace", name: "mcp__codex_apps__linear", tools: [fn("_save_issue")] },
    { type: "namespace", name: "mcp__codex_apps__atlassian_rovo", tools: [fn("_search")] },
  ];
  const ordinary = codec.prepare({ tools, input: [{ role: "user", content: "Inspect this repository" }] });
  assert.deepEqual(ordinary.upstreamBody.tools.map((tool) => tool.name), ["mcp__codex_apps__github___get_repo"]);
  const linear = codec.prepare({ tools, input: [{ role: "user", content: "Update the Linear issue" }] });
  assert.deepEqual(linear.upstreamBody.tools.map((tool) => tool.name), [
    "mcp__codex_apps__github___get_repo",
    "mcp__codex_apps__linear___save_issue",
  ]);
});

test("aliases are isolated per turn when a later direct function reuses an old short name", () => {
  const codec = new ProviderToolCodec();
  const first = codec.prepare({ tools: [{ type: "namespace", name: "mcp__old", tools: [fn("run")] }] });
  assert.deepEqual(first.adaptResponse({ output: [{ type: "function_call", name: "run", arguments: "{}" }] }).output[0], {
    type: "function_call",
    namespace: "mcp__old",
    name: "run",
    arguments: "{}",
  });

  const second = codec.prepare({
    tools: [
      { type: "function", ...fn("run") },
      { type: "namespace", name: "mcp__new", tools: [fn("run")] },
    ],
  });
  assert.deepEqual(second.adaptResponse({ output: [{ type: "function_call", name: "run", arguments: "{}" }] }).output[0], {
    type: "function_call",
    name: "run",
    arguments: "{}",
  });
});

test("direct function names are portable upstream and restored on output", () => {
  const invalidFunction = "1.invalid/function";
  const invalidCustom = "_custom.tool";
  const turn = new ProviderToolCodec().prepare({
    tools: [
      { type: "function", ...fn(invalidFunction) },
      { type: "custom", name: invalidCustom, description: "custom" },
    ],
    input: [
      { type: "function_call", name: invalidFunction, call_id: "f1", arguments: "{}" },
      { type: "custom_tool_call", name: invalidCustom, call_id: "c1", input: "hello" },
    ],
    tool_choice: {
      type: "allowed_tools",
      mode: "auto",
      tools: [
        { type: "function", name: invalidFunction },
        { type: "function", function: { name: invalidCustom } },
      ],
    },
  });
  const [functionTool, customTool] = turn.upstreamBody.tools;
  for (const tool of [functionTool, customTool]) {
    assert.match(tool.name, /^[A-Za-z][A-Za-z0-9_-]*$/);
    assert.ok(tool.name.length <= 64);
  }
  assert.equal(turn.upstreamBody.input[0].name, functionTool.name);
  assert.equal(turn.upstreamBody.input[1].name, customTool.name);
  assert.equal(turn.upstreamBody.tool_choice.tools[0].name, functionTool.name);
  assert.equal(turn.upstreamBody.tool_choice.tools[1].function.name, customTool.name);

  const response = turn.adaptResponse({ output: [
    { type: "function_call", name: functionTool.name, arguments: "{}" },
    { type: "function_call", name: customTool.name, arguments: JSON.stringify({ input: "world" }) },
  ] });
  assert.deepEqual(response.output, [
    { type: "function_call", name: invalidFunction, arguments: "{}" },
    { type: "custom_tool_call", name: invalidCustom, input: "world" },
  ]);
});

test("HTTP object and streamed completion use the same turn codec", () => {
  const turn = new ProviderToolCodec().prepare({
    tools: [{ type: "namespace", name: "mcp__node_repl", tools: [fn("js")] }],
  });
  const raw = { id: "r1", output: [{ type: "function_call", name: "mcp__node_repl__js", arguments: "{}" }] };
  const objectResult = turn.adaptResponse({ response: raw });
  const events = turn.createEventReducer().adapt("response.completed", { type: "response.completed", response: raw });
  assert.deepEqual(events[0].data.response, objectResult.response);
});

test("provider raw reasoning is projected as client summary and retained privately", () => {
  const turn = new ProviderToolCodec().prepare({ input: [] });
  const reducer = turn.createEventReducer({ providerId: "opencode-go" });
  const reasoning = {
    id: "reasoning-1",
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: "private chain of thought" }],
    encrypted_content: null,
  };

  const added = reducer.adapt("response.output_item.added", {
    output_index: 0,
    item: { ...reasoning, content: [] },
  });
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].data.item.content, []);
  assert.deepEqual(added[0].data.item.summary, []);
  assert.deepEqual(reducer.adapt("response.content_part.added", {
    item_id: reasoning.id,
    output_index: 0,
    content_index: 0,
    part: { type: "reasoning_text", text: "" },
  }), []);
  const delta = reducer.adapt("response.reasoning_text.delta", {
    item_id: reasoning.id,
    output_index: 0,
    content_index: 0,
    delta: "private chain",
  });
  assert.deepEqual(delta.map((event) => event.eventName), [
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
  ]);
  assert.equal(delta[1].data.summary_index, 0);
  assert.equal(delta[1].data.delta, "private chain");
  assert.equal(delta[2].data.summary_index, 0);
  assert.equal(delta[2].data.text, "private chain");
  const secondDelta = reducer.adapt("response.reasoning_text.delta", {
    item_id: reasoning.id,
    output_index: 0,
    content_index: 0,
    delta: " of thought",
  });
  assert.deepEqual(secondDelta.map((event) => event.eventName), [
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
  ]);
  assert.equal(secondDelta[1].data.text, " of thought");
  const done = reducer.adapt("response.reasoning_text.done", {
    item_id: reasoning.id,
    output_index: 0,
    content_index: 0,
    text: "private chain of thought",
  });
  assert.deepEqual(done, []);
  const completedItem = reducer.adapt("response.output_item.done", {
    output_index: 0,
    item: reasoning,
  });
  assert.equal(completedItem.length, 1);
  assert.deepEqual(completedItem[0].data.item.content, []);
  assert.equal(completedItem[0].data.item.summary[0].text, "private chain of thought");
  assert.equal(
    completedItem[0].data.item.internal_chat_message_metadata_passthrough.hybrid_provider_id,
    "opencode-go",
  );
  assert.equal(
    completedItem[0].data.item.internal_chat_message_metadata_passthrough.hybrid_reasoning_content[0].text,
    "private chain of thought",
  );

  const terminal = reducer.adapt("response.completed", {
    type: "response.completed",
    response: { id: "response-1", status: "completed", output: [reasoning] },
  });
  assert.equal(terminal.length, 1);
  assert.equal(
    terminal[0].data.response.output[0].internal_chat_message_metadata_passthrough.hybrid_provider_id,
    "opencode-go",
  );
  assert.deepEqual(terminal[0].data.response.output[0].content, []);
  assert.equal(terminal[0].data.response.output[0].summary[0].text, "private chain of thought");
  assert.equal(
    terminal[0].data.response.output[0].internal_chat_message_metadata_passthrough.hybrid_reasoning_content[0].text,
    "private chain of thought",
  );
});

test("native provider reasoning summaries remain native and raw content stays private", () => {
  const turn = new ProviderToolCodec().prepare({ input: [] });
  const reducer = turn.createEventReducer({ providerId: "bytedance" });
  const reasoning = {
    id: "reasoning-native-summary",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "provider summary" }],
    content: [{ type: "reasoning_text", text: "provider private reasoning" }],
  };

  const completed = reducer.adapt("response.output_item.done", {
    output_index: 0,
    item: reasoning,
  });
  assert.equal(completed[0].data.item.summary[0].text, "provider summary");
  assert.deepEqual(completed[0].data.item.content, []);
  assert.equal(
    completed[0].data.item.internal_chat_message_metadata_passthrough.hybrid_reasoning_content[0].text,
    "provider private reasoning",
  );
});

test("vision capability is turn-local for direct and code-mode calls", () => {
  const turn = new ProviderToolCodec().prepare({ tools: [
    { type: "custom", name: "exec" },
    { type: "function", name: "mcp__hybrid_vision__analyze_image", parameters: { type: "object", properties: {} } },
  ] }, {
    visionContextId: "vision-turn-a",
  });
  assert.deepEqual(
    turn.upstreamBody.tools.find((tool) => tool.name === "mcp__hybrid_vision__analyze_image").parameters.properties._hybrid_context_id.enum,
    ["vision-turn-a"],
  );
  const direct = turn.adaptResponse({ output: [{
    type: "function_call",
    name: "mcp__hybrid_vision__analyze_image",
    arguments: JSON.stringify({ path: "/tmp/a.png", prompt: "inspect" }),
  }] });
  assert.equal(JSON.parse(direct.output[0].arguments)._hybrid_context_id, "vision-turn-a");

  const exec = turn.adaptResponse({ output: [{
    type: "function_call",
    name: "exec",
    arguments: JSON.stringify({ input: 'await tools.mcp__hybrid_vision__analyze_image({ path: "/tmp/a.png" });' }),
  }] });
  assert.match(exec.output[0].input, /_hybrid_context_id: "vision-turn-a"/);
});

test("stream reducer binds vision arguments and converts custom-tool input", () => {
  const turn = new ProviderToolCodec().prepare({ tools: [{ type: "custom", name: "exec" }] }, {
    visionContextId: "vision-stream",
  });
  const vision = turn.createEventReducer();
  vision.adapt("response.output_item.added", { item: { id: "v1", type: "function_call", name: "mcp__hybrid_vision__analyze_image" } });
  assert.deepEqual(vision.adapt("response.function_call_arguments.delta", { item_id: "v1", delta: '{"path":"/tmp/a.png"}' }), []);
  const visionEvents = vision.adapt("response.function_call_arguments.done", { item_id: "v1" });
  assert.equal(JSON.parse(visionEvents[1].data.arguments)._hybrid_context_id, "vision-stream");

  const custom = turn.createEventReducer();
  custom.adapt("response.output_item.added", { item: { id: "e1", type: "function_call", name: "exec" } });
  custom.adapt("response.function_call_arguments.delta", { item_id: "e1", delta: '{"input":"text(42)"}' });
  const customEvents = custom.adapt("response.function_call_arguments.done", { item_id: "e1" });
  assert.equal(customEvents[1].data.input, "text(42)");
});

test("tool_search is passthrough by default and can be explicitly disabled", () => {
  const codec = new ProviderToolCodec();
  const body = {
    tools: [{ type: "tool_search", name: "tool_search" }],
    input: [{ type: "tool_search_call", id: "ts1", name: "lookup", arguments: "{}" }],
  };
  assert.equal(codec.prepare(body).upstreamBody.tools[0].type, "tool_search");
  const disabled = codec.prepare(body, { profile: { tool_search: "disabled" } });
  assert.deepEqual(disabled.upstreamBody.tools, []);
  assert.deepEqual(disabled.upstreamBody.input, []);
});

test("a capable provider can opt into native namespaces and custom tools", () => {
  const body = {
    tools: [
      { type: "namespace", name: "mcp__native", tools: [fn("run")] },
      { type: "custom", name: "exec", description: "Run code" },
    ],
    input: [{ type: "custom_tool_call", name: "exec", call_id: "c1", input: "text(1)" }],
  };
  const turn = new ProviderToolCodec().prepare(body, {
    profile: { namespaces: "native", custom_tools: "native", deferred_tools: "expand" },
  });
  assert.deepEqual(turn.upstreamBody.tools, body.tools);
  assert.deepEqual(turn.upstreamBody.input, body.input);
});

test("native search removes Exa but keeps provider web_search", () => {
  const turn = new ProviderToolCodec().prepare({
    tools: [
      { type: "web_search" },
      { type: "namespace", name: "mcp__exa", tools: [fn("web_search_exa")] },
      { type: "function", name: "web_fetch_exa" },
      { type: "function", name: "exec" },
    ],
  }, { nativeSearch: true });
  assert.deepEqual(turn.upstreamBody.tools, [{ type: "web_search" }, { type: "function", name: "exec" }]);
});

test("external search removes provider web_search but keeps Exa", () => {
  const turn = new ProviderToolCodec().prepare({
    tools: [
      { type: "web_search" },
      { type: "web_search_preview" },
      { type: "namespace", name: "mcp__exa", tools: [fn("web_search_exa")] },
      { type: "function", name: "exec" },
    ],
    input: [
      { type: "web_search_call", id: "ws1", status: "completed" },
      { role: "user", content: "hello" },
    ],
    tool_choice: { type: "web_search" },
  });
  assert.deepEqual(turn.upstreamBody.tools.map((tool) => [tool.type, tool.name]), [
    ["function", "exec"],
    ["function", "mcp__exa__web_search_exa"],
  ]);
  assert.equal(turn.upstreamBody.input.some((item) => item.type === "web_search_call"), false);
  assert.equal(turn.upstreamBody.tool_choice, "auto");
});
