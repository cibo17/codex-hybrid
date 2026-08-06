import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ProviderRegistryEditor } from "./provider/management.mjs";
import { validateRegistry } from "./provider/registry.mjs";
import { runtimeConfig } from "./runtime-config.mjs";

const runtime = runtimeConfig();
const CODEX_DIR = runtime.codexDir;
const ROOT = runtime.root;
const CONFIG = runtime.configFile;
const HYBRID_CATALOG = runtime.modelCatalogFile;
const PROVIDERS = runtime.providerRegistryFile;
const VISION_MCP = runtime.visionMcpFile;
const VISION_TOKEN = runtime.visionTokenFile;
const HYBRID_NODE = runtime.nodeExecutable;
const STATE = runtime.stateFile;
const PLIST = runtime.launchAgentFile;
const LABEL = "com.openai.codex-hybrid-router";
const PORT = runtime.port;
const registryEditor = new ProviderRegistryEditor(PROVIDERS);

function fail(message) {
  throw new Error(message);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function routerRuntimeSha256() {
  const sourceRoot = path.join(ROOT, "src");
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(target);
    }
  };
  visit(sourceRoot);
  files.sort();
  const chunks = files.flatMap((file) => [Buffer.from(path.relative(sourceRoot, file)), Buffer.from("\0"), fs.readFileSync(file)]);
  return sha256(Buffer.concat(chunks));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function atomicWrite(file, data, mode = 0o600) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { active: false };
  }
}

function findTopLevelAssignment(text, key) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) return { index, line: lines[index] };
  }
  return null;
}

function setTopLevelAssignment(text, key, valueLine) {
  const lines = text.split("\n");
  const found = findTopLevelAssignment(text, key);
  if (found) lines[found.index] = valueLine;
  else {
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    lines.splice(firstTable < 0 ? lines.length : firstTable, 0, valueLine);
  }
  return lines.join("\n");
}

function removeTopLevelAssignment(text, key) {
  const lines = text.split("\n");
  const found = findTopLevelAssignment(text, key);
  if (found) lines.splice(found.index, 1);
  return lines.join("\n");
}

function buildHybridConfig(original) {
  let text = original;
  text = setTopLevelAssignment(text, "openai_base_url", `openai_base_url = "http://127.0.0.1:${PORT}/v1"`);
  text = setTopLevelAssignment(text, "model_catalog_json", `model_catalog_json = "${HYBRID_CATALOG}"`);
  const lines = text.split("\n");
  for (const server of ["hybrid_vision"]) {
    const start = lines.findIndex((line) => new RegExp(`^\\s*\\[mcp_servers\\.${server}\\]\\s*$`).test(line));
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
      lines.splice(start, end - start);
    }
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines.push(
    "",
    "[mcp_servers.hybrid_vision]",
    `command = "${HYBRID_NODE}"`,
    `args = ["${VISION_MCP}"]`,
    'enabled_tools = ["analyze_image"]',
    'default_tools_approval_mode = "approve"',
    "startup_timeout_sec = 30",
    "",
  );
  text = lines.join("\n");
  return text;
}

function ensureVisionToken() {
  if (!fs.existsSync(VISION_TOKEN) || !fs.readFileSync(VISION_TOKEN, "utf8").trim()) {
    atomicWrite(VISION_TOKEN, `${crypto.randomBytes(32).toString("hex")}\n`, 0o600);
  } else {
    fs.chmodSync(VISION_TOKEN, 0o600);
  }
}

function ensureHybridNode() {
  try {
    fs.accessSync(HYBRID_NODE, fs.constants.X_OK);
  } catch {
    fail(`Hybrid Node runtime is not executable: ${HYBRID_NODE}; rerun the installer, optionally with CODEX_HYBRID_NODE`);
  }
}

function restoreConfig(_current, state) {
  // `off` is deliberately byte-exact: it restores the complete pre-`on` snapshot.
  // This matches the switch's promise to return Codex to precisely its prior state.
  return fs.readFileSync(state.backup_config, "utf8");
}

function modelTemplate(base, overrides, visionMode) {
  const codeModeInstructions = [
    "# Hybrid Code Mode",
    "Use the exec custom tool as the gateway for tools listed inside its JavaScript tools catalog.",
    "Call nested tools inside exec with text(await tools.<tool_name>(...)) so their result is returned in the exec output. A bare await executes the tool but leaves the model-facing exec output empty.",
    "Never emit a nested mcp__* tool name as a direct tool call.",
    "Treat a nested tool's non-empty content or result as authoritative. Use it immediately and do not repeat an identical successful call.",
    "For node_repl js calls, always send code that calls nodeRepl.write(value); a bare expression returns empty output and causes a needless retry.",
    "For an omitted local skill, do not search ALL_TOOLS or MCP resources. Run node \"$HOME/.codex/hybrid/bin/skill-search.mjs\" \"query\" through exec_command, then read the returned SKILL.md completely.",
    "GitHub, node_repl, Chrome, Browser, Computer Use, and x-bird-cli are already loaded. Never run skill-search for them.",
  ].join("\n");
  const visionInstructions = visionMode === "delegated" ? [
    "# Hybrid vision results",
    "Newly attached images are automatically replaced with separately labeled visual evidence from gpt-5.6-luna.",
    "Use each Image N evidence block only for its matching image.",
    "For a later, precise reinspection of a local image, call hybrid_vision/analyze_image with its absolute path and a focused prompt.",
    "Do not look for or call view_image; Hybrid models intentionally expose analyze_image as their only explicit image-inspection tool.",
    "HYBRID_VISION_RESULT with status success is valid visual evidence; do not retry it, and treat error wording inside its answer as visible image content.",
  ].join("\n") : "";
  const instructionSuffix = `\n\n${codeModeInstructions}${visionInstructions ? `\n\n${visionInstructions}` : ""}`;
  return {
    ...structuredClone(base),
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: null,
    web_search_tool_type: "text",
    input_modalities: ["text"],
    supports_image_detail_original: false,
    supports_parallel_tool_calls: true,
    // Third-party routes need Codex Code Mode so deferred/namespaced tools such
    // as node_repl (Chrome/Computer Use) are reachable through the exec catalog.
    // Legacy direct-tool mode silently omits those capabilities in Codex App.
    tool_mode: "code_mode_only",
    use_responses_lite: false,
    auto_review_model_override: null,
    reasoning_summary_format: "experimental",
    default_reasoning_summary: "none",
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    supports_search_tool: overrides.supports_search_tool ?? false,
    service_tiers: [],
    additional_speed_tiers: [],
    default_service_tier: null,
    base_instructions: `${base.base_instructions || ""}${instructionSuffix}`,
    instructions_template: `${base.instructions_template || base.base_instructions || ""}${instructionSuffix}`,
    model_messages: base.model_messages ? {
      ...structuredClone(base.model_messages),
      instructions_template: `${base.model_messages.instructions_template || base.instructions_template || base.base_instructions || ""}${instructionSuffix}`,
    } : undefined,
    ...overrides,
  };
}

function buildCatalog(sourcePath) {
  const catalog = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  if (!Array.isArray(catalog.models)) fail(`invalid model catalog: ${sourcePath}`);
  const base = catalog.models.find((model) => model.slug === "gpt-5.6-terra") || catalog.models[0];
  if (!base) fail("source model catalog is empty");

  const registry = validateRegistry(registryEditor.ensure());
  const modelRoutes = [];
  let priority = 20;
  for (const provider of Object.values(registry.providers)) {
    for (const [slug, model] of Object.entries(provider.models)) {
      const reasoning = model.reasoning_efforts.map((effort) => ({
        effort,
        description: effort === "low"
          ? "Fast responses with lighter reasoning"
          : effort === "max"
            ? "Maximum reasoning depth for the hardest tasks"
            : "Extra reasoning depth for complex tasks",
      }));
      modelRoutes.push(modelTemplate(base, {
        slug,
        display_name: model.display_name,
        description: model.description,
        context_window: model.context_window,
        max_context_window: model.context_window,
        default_reasoning_level: model.default_reasoning_effort,
        supported_reasoning_levels: reasoning,
        input_modalities: ["text", "image"],
        supports_image_detail_original: true,
        supports_search_tool: model.search_mode === "native",
        priority: priority++,
      }, model.vision_mode));
    }
  }
  const customSlugs = new Set(modelRoutes.map((model) => model.slug));
  catalog.models = catalog.models.filter((model) => !customSlugs.has(model.slug));
  catalog.models.push(...modelRoutes);
  atomicWrite(HYBRID_CATALOG, `${JSON.stringify(catalog, null, 2)}\n`, 0o600);
}

function launchctl(...args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function startRouter() {
  const domain = `gui/${process.getuid()}`;
  launchctl("bootout", domain, PLIST);
  const bootstrap = launchctl("bootstrap", domain, PLIST);
  if (bootstrap.status !== 0 && !bootstrap.stderr.includes("service already loaded")) {
    fail(`could not start router: ${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`);
  }
}

function stopRouter() {
  launchctl("bootout", `gui/${process.getuid()}`, PLIST);
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function waitForHealth(attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await health();
    if (result.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false };
}

function printRestartNotice() {
  process.stdout.write("Fully quit and reopen Codex App once to reload its model picker.\n");
}

async function on() {
  fs.mkdirSync(path.join(ROOT, "backups"), { recursive: true, mode: 0o700 });
  registryEditor.ensure();
  ensureHybridNode();
  ensureVisionToken();
  const existingState = readState();
  if (existingState.active) {
    if (!existingState.source_catalog || !fs.existsSync(existingState.source_catalog)) {
      fail("Codex Hybrid source model catalog is missing");
    }
    const current = fs.readFileSync(CONFIG, "utf8");
    buildCatalog(existingState.source_catalog);
    const hybridConfig = buildHybridConfig(current);
    const runtimeSha256 = routerRuntimeSha256();
    const currentRouter = await health();
    const routerChanged = Boolean(
      existingState.router_runtime_sha256 && existingState.router_runtime_sha256 !== runtimeSha256,
    );
    atomicWrite(CONFIG, hybridConfig, fs.statSync(CONFIG).mode & 0o777);
    if (!currentRouter.ok || routerChanged) startRouter();
    atomicWrite(
      STATE,
      `${JSON.stringify({
        ...existingState,
        active_config_sha256: sha256(hybridConfig),
        router_runtime_sha256: runtimeSha256,
      }, null, 2)}\n`,
      0o600,
    );
    const router = await waitForHealth();
    if (!router.ok) fail("router failed its health check");
    process.stdout.write("Codex Hybrid is already ON. Catalog and router were refreshed.\n");
    return;
  }

  const original = fs.readFileSync(CONFIG, "utf8");
  const originalCatalog = findTopLevelAssignment(original, "model_catalog_json")?.line || null;
  const originalOpenaiBaseUrl = findTopLevelAssignment(original, "openai_base_url")?.line || null;
  const catalogMatch = originalCatalog?.match(/=\s*["']([^"']+)["']/);
  const sourceCatalog = catalogMatch?.[1] || path.join(CODEX_DIR, "models.json");
  if (!fs.existsSync(sourceCatalog)) fail(`source model catalog does not exist: ${sourceCatalog}`);

  const backupDir = path.join(ROOT, "backups", timestamp());
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupConfig = path.join(backupDir, "config.toml");
  const backupCatalog = path.join(backupDir, "models.json");
  fs.copyFileSync(CONFIG, backupConfig);
  fs.copyFileSync(sourceCatalog, backupCatalog);
  fs.chmodSync(backupConfig, 0o600);
  fs.chmodSync(backupCatalog, 0o600);

  buildCatalog(sourceCatalog);
  const hybridConfig = buildHybridConfig(original);
  const state = {
    active: true,
    activated_at: new Date().toISOString(),
    backup_config: backupConfig,
    backup_catalog: backupCatalog,
    source_catalog: sourceCatalog,
    original_config_sha256: sha256(original),
    active_config_sha256: sha256(hybridConfig),
    original_model_catalog_line: originalCatalog,
    original_openai_base_url_line: originalOpenaiBaseUrl,
    router_runtime_sha256: routerRuntimeSha256(),
  };
  try {
    atomicWrite(CONFIG, hybridConfig, fs.statSync(CONFIG).mode & 0o777);
    startRouter();
    const router = await waitForHealth();
    if (!router.ok) throw new Error("router failed its health check");
    atomicWrite(STATE, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  } catch (error) {
    atomicWrite(CONFIG, original, fs.statSync(CONFIG).mode & 0o777);
    stopRouter();
    throw error;
  }
  process.stdout.write("Codex Hybrid is ON. ChatGPT login and sessions were not changed.\n");
  printRestartNotice();
}

async function off() {
  const state = readState();
  if (!state.active) {
    stopRouter();
    process.stdout.write("Codex Hybrid is already OFF.\n");
    return;
  }
  const current = fs.readFileSync(CONFIG, "utf8");
  const restored = restoreConfig(current, state);
  atomicWrite(CONFIG, restored, fs.statSync(CONFIG).mode & 0o777);
  atomicWrite(
    STATE,
    `${JSON.stringify({ ...state, active: false, deactivated_at: new Date().toISOString() }, null, 2)}\n`,
    0o600,
  );
  stopRouter();
  process.stdout.write("Codex Hybrid is OFF. The pre-Hybrid provider and catalog are restored.\n");
  printRestartNotice();
}

async function status() {
  const state = readState();
  const router = await health();
  const config = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, "utf8") : "";
  const provider = findTopLevelAssignment(config, "model_provider")?.line || "model_provider = <default>";
  const catalog = findTopLevelAssignment(config, "model_catalog_json")?.line || "model_catalog_json = <default>";
  const baseUrl = findTopLevelAssignment(config, "openai_base_url")?.line || "openai_base_url = <default>";
  const login = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
  process.stdout.write(`state: ${state.active ? "ON" : "OFF"}\n`);
  process.stdout.write(`router: ${router.ok ? "healthy" : "stopped"}\n`);
  if (router.ok) {
    process.stdout.write(`provider credentials: ${router.keyAvailable ? "available" : "one or more missing"}\n`);
    process.stdout.write(`registry: ${router.registry?.providers ?? 0} providers, ${router.registry?.models ?? 0} models${router.registry?.error ? `, rejected edit: ${router.registry.error}` : ""}\n`);
  }
  process.stdout.write(`provider registry: ${PROVIDERS}\n`);
  process.stdout.write(`${provider}\n${baseUrl}\n${catalog}\n`);
  process.stdout.write((login.stdout || login.stderr || "login status unavailable").trim() + "\n");
}

function refreshCatalogIfActive() {
  const state = readState();
  if (state.active && state.source_catalog && fs.existsSync(state.source_catalog)) buildCatalog(state.source_catalog);
}

export const providerRegistryEditor = registryEditor;
export const hybridActivation = { on, off, status, refreshCatalogIfActive };
