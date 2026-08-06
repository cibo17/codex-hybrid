import assert from "node:assert/strict";
import test from "node:test";

import { compactExecDescription } from "../../src/tools/exec-catalog.mjs";
import { ProviderToolCodec } from "../../src/tools/codec.mjs";

const description = [
  "Run JavaScript code.\n\nShared types.",
  "### `exec_command`\nRun a shell command.",
  "### `mcp__codex_apps__github_get_repo`\nRead a GitHub repository.",
  "### `mcp__node_repl__js`\nRun JavaScript in node_repl.",
  "### `mcp__hybrid_vision__analyze_image`\nAnalyze an image.",
  "### `mcp__codex_apps__linear_save_issue`\nWrite Linear issues.",
  "### `mcp__codex_apps__atlassian_rovo_search`\nSearch Jira.",
  "### `mcp__codex_slides__create_deck`\nCreate slides.",
  "### `image_gen__imagegen`\nGenerate an image.",
  "### `view_image`\nInspect an image directly.",
].join("\n");

test("ordinary turns keep only the always-loaded Hybrid tool catalog", () => {
  const compact = compactExecDescription(description, "fix the local code");
  assert.match(compact, /exec_command/);
  assert.match(compact, /github_get_repo/);
  assert.match(compact, /node_repl__js/);
  assert.match(compact, /hybrid_vision__analyze_image/);
  assert.doesNotMatch(compact, /linear_save_issue/);
  assert.doesNotMatch(compact, /atlassian_rovo_search/);
  assert.doesNotMatch(compact, /codex_slides/);
  assert.doesNotMatch(compact, /image_gen/);
  assert.doesNotMatch(compact, /view_image/);
  assert.match(compact, /ALL_TOOLS/);
  assert.match(compact, /nodeRepl\.write/);
});

test("a user request activates only its matching lazy catalog", () => {
  const compact = compactExecDescription(description, "Update the matching Linear issue");
  assert.match(compact, /linear_save_issue/);
  assert.doesNotMatch(compact, /atlassian_rovo_search/);
  assert.doesNotMatch(compact, /codex_slides/);
});

test("host context mentioning plugin names does not activate lazy catalogs", () => {
  const turn = new ProviderToolCodec().prepare({
    tools: [{ type: "custom", name: "exec", description }],
    input: [
      { role: "user", content: "<recommended_plugins>Linear, Atlassian Rovo, Codex Slides</recommended_plugins>" },
      { role: "user", content: "Reply with a local calculation" },
    ],
  });
  const compact = turn.upstreamBody.tools[0].description;
  assert.doesNotMatch(compact, /linear_save_issue/);
  assert.doesNotMatch(compact, /atlassian_rovo_search/);
  assert.doesNotMatch(compact, /codex_slides/);
});
