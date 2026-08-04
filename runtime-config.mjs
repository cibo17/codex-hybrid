import os from "node:os";
import path from "node:path";

export function runtimeConfig(environment = process.env, home = environment.CODEX_HYBRID_HOME || os.homedir()) {
  const port = Number(environment.CODEX_HYBRID_PORT || "19091");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("CODEX_HYBRID_PORT must be a valid TCP port");
  const codexDir = path.join(home, ".codex");
  const root = path.join(codexDir, "hybrid");
  return {
    home,
    port,
    codexDir,
    root,
    configFile: path.join(codexDir, "config.toml"),
    providerRegistryFile: environment.CODEX_HYBRID_PROVIDERS || path.join(root, "providers.json"),
    modelCatalogFile: path.join(root, "models.hybrid.json"),
    visionTokenFile: path.join(root, "vision.token"),
    visionMcpFile: path.join(root, "vision-mcp.mjs"),
    nodeExecutable: path.join(root, "runtime", "node"),
    stateFile: path.join(root, "state.json"),
    launchAgentFile: path.join(home, "Library", "LaunchAgents", "com.openai.codex-hybrid-router.plist"),
    routerBaseUrl: `http://127.0.0.1:${port}`,
    visionEndpoint: `http://127.0.0.1:${port}/hybrid/vision/analyze`,
  };
}
