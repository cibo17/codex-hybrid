#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const query = process.argv.slice(2).join(" ").trim().toLowerCase();
if (!query) {
  process.stderr.write("usage: skill-search <query>\n");
  process.exit(2);
}

const roots = [
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".codex", "skills"),
  path.join(os.homedir(), ".codex", "plugins", "cache"),
];
const files = [];
const visitedDirectories = new Set();

function visit(directory) {
  let realDirectory;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch {
    return;
  }
  if (visitedDirectories.has(realDirectory)) return;
  visitedDirectories.add(realDirectory);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isSymbolicLink()) {
      try {
        const resolved = fs.realpathSync(target);
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) visit(resolved);
        else if (stat.isFile() && path.basename(resolved) === "SKILL.md") files.push(resolved);
      } catch {}
    }
    else if (entry.isFile() && entry.name === "SKILL.md") files.push(target);
  }
}
for (const root of roots) visit(root);

function metadata(file) {
  const text = fs.readFileSync(file, "utf8");
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || "";
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || path.basename(path.dirname(file));
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
  return { name, description, path: file };
}

const terms = query.split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean);
const seen = new Set();
const matches = files.map(metadata).map((skill) => {
  const haystack = `${skill.name} ${skill.description}`.toLowerCase();
  let score = 0;
  if (haystack.includes(query)) score += 20;
  for (const term of terms) {
    if (skill.name.toLowerCase().includes(term)) score += 8;
    else if (haystack.includes(term)) score += 2;
  }
  return { ...skill, score };
}).filter((skill) => skill.score > 0).sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).filter((skill) => {
  if (seen.has(skill.name)) return false;
  seen.add(skill.name);
  return true;
}).slice(0, 12).map(({ score, ...skill }) => skill);

process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
