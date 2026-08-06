import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compactSkillsCatalog } from "../../src/tools/skills-catalog.mjs";

test("provider prompts keep only always-loaded skills and a lazy discovery instruction", () => {
  const original = {
    input: [{ role: "developer", content: [{ type: "input_text", text: [
      "before",
      "<skills_instructions>",
      "## Skills",
      "- browser:control-in-app-browser: Browser control. (file: /browser/SKILL.md)",
      "- chrome:control-chrome: Chrome control. (file: /chrome/SKILL.md)",
      "- computer-use:computer-use: Computer use. (file: /computer/SKILL.md)",
      "- github:github: GitHub workflows. (file: /github/SKILL.md)",
      "- x-bird-cli: Read X. (file: /bird/SKILL.md)",
      "- codex-slides:codex-slides: Make slides. (file: /slides/SKILL.md)",
      "</skills_instructions>",
      "after",
    ].join("\n") }] }],
  };
  const compact = compactSkillsCatalog(original);
  const text = compact.input[0].content[0].text;
  assert.match(text, /browser:control-in-app-browser/);
  assert.match(text, /chrome:control-chrome/);
  assert.match(text, /computer-use:computer-use/);
  assert.match(text, /github:github/);
  assert.match(text, /x-bird-cli/);
  assert.doesNotMatch(text, /codex-slides:codex-slides/);
  assert.match(text, /skill-search\.mjs/);
  assert.match(text, /node_repl.*already loaded/);
  assert.match(text, /before/);
  assert.match(text, /after/);
  assert.match(original.input[0].content[0].text, /codex-slides:codex-slides/);
});

test("lazy skill search returns matching SKILL.md locations", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-skill-search-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const directory = path.join(home, "canonical", "slides-helper");
  const skillsRoot = path.join(home, ".agents", "skills");
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.symlinkSync(directory, path.join(skillsRoot, "slides-helper"));
  fs.writeFileSync(path.join(directory, "SKILL.md"), [
    "---",
    "name: slides-helper",
    "description: Build presentation decks and PPTX files.",
    "---",
    "# Slides",
  ].join("\n"));
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "skill-search.mjs"), "presentation"], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const matches = JSON.parse(result.stdout);
  assert.equal(matches[0].name, "slides-helper");
  assert.equal(matches[0].path, fs.realpathSync(path.join(directory, "SKILL.md")));
});
