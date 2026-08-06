const ALWAYS_TOOL_PATTERNS = [
  /^__exec_base__$/,
  /^(?:apply_patch|exec_command|write_stdin|update_plan|request_plugin_install|list_mcp_resources|list_mcp_resource_templates|read_mcp_resource)$/,
  /^mcp__codex_apps__github_/,
  /^mcp__node_repl__/,
  /^mcp__hybrid_vision__/,
  /(?:^|__)(?:chrome|browser|computer_use)(?:__|_)/i,
];

const LAZY_GROUPS = [
  { tool: /^mcp__codex_apps__linear_/, demand: /\blinear\b/i },
  { tool: /^mcp__codex_apps__atlassian_rovo_/, demand: /\b(?:atlassian|jira|confluence|rovo)\b|阿特拉西安/i },
  { tool: /^mcp__codex_slides__/, demand: /\b(?:slides?|deck|presentation|pptx?)\b|幻灯片|演示文稿/i },
  { tool: /^mcp__codex_security__/, demand: /\b(?:security scan|threat model|vulnerabilit|attack path)\b|安全扫描|威胁模型|漏洞/i },
  { tool: /^mcp__codex_apps__sites_/, demand: /\b(?:codex sites?|deploy (?:a )?site|site version)\b|网站部署/i },
  { tool: /^mcp__codex_apps__plugin_management_/, demand: /\b(?:plugin management|app permissions?|uninstall (?:an )?app)\b|插件管理|应用权限/i },
  { tool: /^mcp__codex_apps__codex_document_control_/, demand: /\b(?:document control|document session)\b|文档控制/i },
  { tool: /^mcp__codex_apps__hugging_face_/, demand: /\b(?:hugging ?face|hf hub|hf jobs?)\b/i },
  { tool: /^mcp__codex_apps__podcast_app_/, demand: /\bpodcasts?\b|播客/i },
  { tool: /^mcp__codex_apps__hotline_/, demand: /\bhotline\b|热线/i },
  { tool: /^image_gen__/, demand: /\b(?:image generation|generate (?:an )?image|imagegen)\b|生成图片|画一张/i },
];

const LAZY_DISCOVERY = [
  "",
  "For mcp__node_repl__js, code must call nodeRepl.write(value) to return a visible result; a bare expression returns empty output and must not be used.",
  "Lazy nested tools are available at runtime but omitted from this prompt.",
  "When a task needs an omitted tool, discover exact names with exec:",
  "text(ALL_TOOLS.filter(({ name, description }) => `${name} ${description}`.toLowerCase().includes(\"query\")).slice(0, 20))",
  "Then call the returned tool with text(await tools.<exact_name>(args)). Do not guess tool names.",
  "ALL_TOOLS discovers tools, not skills. For an omitted local skill, run:",
  'text(await tools.exec_command({cmd: "node \\\"$HOME/.codex/hybrid/bin/skill-search.mjs\\\" \\\"query\\\""}))',
  "Do not use MCP resource listing to search for local skills.",
  "GitHub, node_repl, Chrome, Browser, Computer Use, and x-bird-cli are already loaded; never run skill-search for them.",
].join("\n");

function blockName(block, index) {
  return block.match(/^### `([^`]+)`/m)?.[1] ?? (index === 0 ? "__exec_base__" : "__unknown__");
}

function shouldKeep(name, demandText) {
  if (ALWAYS_TOOL_PATTERNS.some((pattern) => pattern.test(name))) return true;
  const lazy = LAZY_GROUPS.find((group) => group.tool.test(name));
  return Boolean(lazy?.demand.test(demandText));
}

export function compactExecDescription(description, demandText = "") {
  if (typeof description !== "string" || !description.includes("### `")) return description;
  const blocks = description.split(/\n(?=### `)/);
  const kept = blocks.filter((block, index) => shouldKeep(blockName(block, index), demandText));
  if (kept.length === blocks.length) return description;
  return `${kept.join("\n")}${LAZY_DISCOVERY}`;
}

export function compactExecTool(tool, demandText = "") {
  if (tool?.type !== "custom" || tool?.name !== "exec") return tool;
  return { ...tool, description: compactExecDescription(tool.description, demandText) };
}
