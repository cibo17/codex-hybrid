const ALWAYS_SKILLS = [
  "browser:control-in-app-browser",
  "chrome:control-chrome",
  "computer-use:computer-use",
  "x-bird-cli",
];

function keepSkillLine(line) {
  if (!line.startsWith("- ")) return false;
  const entry = line.slice(2);
  return ALWAYS_SKILLS.some((name) => entry.startsWith(`${name}:`)) || entry.startsWith("github:");
}

function compactBlock(block) {
  const kept = block.split("\n").filter(keepSkillLine);
  return [
    "<skills_instructions>",
    "## Always-loaded skills",
    ...kept,
    "",
    "## Lazy skills",
    "Other installed skills are intentionally omitted from the standing prompt.",
    "GitHub, node_repl, Chrome, Browser, Computer Use, and x-bird-cli are already loaded; never run skill-search for them.",
    "When the task may match another skill, your first discovery action must be this exec call, replacing query:",
    'text(await tools.exec_command({cmd: "node \\\"$HOME/.codex/hybrid/bin/skill-search.mjs\\\" \\\"query\\\""}))',
    "ALL_TOOLS and MCP resource listing do not discover local skills. Read the returned SKILL.md completely before taking actions required by that skill. Do not guess skill paths.",
    "</skills_instructions>",
  ].join("\n");
}

function compactText(text) {
  if (typeof text !== "string" || !text.includes("<skills_instructions>")) return text;
  return text.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, compactBlock);
}

export function compactSkillsCatalog(originalBody) {
  const body = structuredClone(originalBody);
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (item?.role !== "developer") continue;
    if (typeof item.content === "string") item.content = compactText(item.content);
    if (Array.isArray(item.content)) {
      for (const content of item.content) {
        if (typeof content?.text === "string") content.text = compactText(content.text);
        if (typeof content?.input_text === "string") content.input_text = compactText(content.input_text);
      }
    }
  }
  return body;
}
