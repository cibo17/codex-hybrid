# Codex Hybrid

Codex Hybrid adds any OpenAI Responses-compatible model backend to Codex App while preserving the
existing ChatGPT login, official models, saved tasks, and `model_provider = "openai"`.

- Unclaimed model names continue through the unchanged ChatGPT Official Path.
- Configured Model Routes use their Responses Provider.
- HTTP and Codex App WebSocket requests share one routing and Compatibility Translation pipeline.
- `codex-hybrid on` enables the router and generated model catalog.
- `codex-hybrid off` restores the exact pre-Hybrid Codex configuration.

This is an experimental macOS integration for the current Codex App/CLI protocol. Codex
implementation details may change in future releases.

## Responses Providers

The Provider Registry lives at `~/.codex/hybrid/providers.json`. It hot-reloads after direct edits;
an invalid edit keeps the last-known-good registry active and is reported by `/health` and
`codex-hybrid status`.

Every provider needs an HTTP endpoint implementing `POST /responses` with JSON or SSE responses.
The upstream does not need WebSocket support: Codex Hybrid adapts the App's WebSocket transport to
HTTP Responses requests locally.

The default registry preserves the original Ollama Pro routes:

- `deepseek-v4-flash:0731`
- `glm-5.2`

Model names must be globally unique across providers. Names not claimed by the registry are never
sent to a third party.

### Example configuration

```json
{
  "version": 1,
  "providers": {
    "example": {
      "name": "Example Responses",
      "base_url": "https://api.example.com/v1",
      "credential": {
        "type": "inline",
        "api_key": "plain-text-key-is-allowed"
      },
      "models": {
        "example-coder": {
          "display_name": "Example Coder",
          "description": "Coding model served by Example Responses.",
          "context_window": 262144,
          "reasoning_efforts": ["low", "high"],
          "default_reasoning_effort": "high",
          "vision_mode": "delegated"
        }
      }
    }
  }
}
```

Credential types:

- `inline`: `api_key` is stored directly in `providers.json`.
- `env`: `name` selects an environment variable.
- `keychain`: `service` and `account` select a macOS Keychain generic password.
- `none`: no authentication header.

`header` and `prefix` may be set on any credential to replace the default
`Authorization: Bearer <key>` shape.

Provider URLs must use HTTPS. Loopback HTTP is allowed for local servers.

## CLI management

```sh
# Providers
codex-hybrid provider list
codex-hybrid provider add example --base-url https://api.example.com/v1 --api-key plain-text-key
codex-hybrid provider remove example

# Credential Sources
codex-hybrid key set example --api-key plain-text-key
codex-hybrid key set example --env EXAMPLE_API_KEY
codex-hybrid key set example --keychain-service codex-hybrid-example --keychain-account api-key
codex-hybrid key set example --api-key plain-text-key --header x-api-key --prefix ''
codex-hybrid key remove example

# Model Routes
codex-hybrid model list
codex-hybrid model add example example-coder \
  --display-name "Example Coder" \
  --context-window 262144 \
  --efforts low,high \
  --default-effort high \
  --vision delegated
codex-hybrid model remove example-coder
```

Registry and credential changes are immediately visible to the running router. Adding or removing
a Model Route also rebuilds the catalog while Hybrid is active; fully quit and reopen Codex App to
refresh the model picker.

## Vision modes

- `delegated` replaces image inputs with separately labeled Vision Evidence from `gpt-5.6-luna`
  and exposes the Hybrid-only `analyze_image` MCP tool.
- `native` forwards image inputs to the Responses Provider and removes the Hybrid-only vision tool.

Official models retain native Codex vision and never see the Hybrid vision tool.

## Install

Requirements: macOS, Node.js 20.18.1 or newer, npm, and Codex authenticated with a ChatGPT account.

The installer creates `~/.codex/hybrid/runtime/node` as a symlink to the Node executable used to run the installer. Codex Hybrid does not depend on a particular Node distributor. Run the installer with `CODEX_HYBRID_NODE=/absolute/path/to/node` to select a different target. Full Disk Access is optional and only relevant when that Node process must read macOS-protected folders.

```sh
git clone https://github.com/cibo17/codex-hybrid.git
cd codex-hybrid
npm run install:local
codex-hybrid on
```

Fully quit and reopen Codex App once so its startup-only model catalog reloads.

To use the default Ollama Pro routes, store its key without placing it in shell history:

```sh
read -s 'OLLAMA_PRO_KEY?Ollama Pro API key: '
security add-generic-password -U -s codex-hybrid-ollama-pro -a ollama-pro -w "$OLLAMA_PRO_KEY"
unset OLLAMA_PRO_KEY
```

## Optional Exa MCP

Codex Hybrid can register the official
[`exa-mcp-server`](https://github.com/exa-labs/exa-mcp-server), pinned to commit
`a664592b5dd7c5598b70158c771dcc5c2a4fb2c1`. The included patch adds local key-pool rotation without
changing Exa's tool names, schemas, transport, or result formatting.

```sh
git clone https://github.com/exa-labs/exa-mcp-server.git ~/.codex/hybrid/vendor/exa-mcp-server
git -C ~/.codex/hybrid/vendor/exa-mcp-server checkout a664592b5dd7c5598b70158c771dcc5c2a4fb2c1
git -C ~/.codex/hybrid/vendor/exa-mcp-server apply "$PWD/patches/exa-key-pool.patch"
npm ci --prefix ~/.codex/hybrid/vendor/exa-mcp-server
npm run build --prefix ~/.codex/hybrid/vendor/exa-mcp-server
```

Put one Exa key per line in `~/.codex/hybrid/exa.keys`. If the server or key file is absent, Exa is
disabled and the core router still works. `EXA_MCP_ENTRY` and `EXA_KEYS_FILE` select alternate
locations.

## Activation

```sh
codex-hybrid on
codex-hybrid off
codex-hybrid status
```

Activation is transactional: it captures an Activation Snapshot, builds the catalog, updates Codex
configuration, starts the router, and verifies health. A failed first activation restores the
original config and stops the router. `off` restores the complete snapshot byte-for-byte.

The switch never edits or deletes Codex tasks. Configuration changes made while Hybrid is active
are intentionally discarded by the byte-exact restore.

## Architecture

- `responses-protocol.mjs`: deep Compatibility Translation module for JSON, SSE, WebSocket events,
  namespace tools, and `apply_patch`.
- `model-routing.mjs`: transport-independent model decision and request preparation pipeline.
- `provider-registry.mjs`: versioned registry validation, hot reload, routing, and credentials.
- `vision-workflow.mjs`: task contexts, Luna calls, Vision Evidence, cache, and metrics.
- `activation.mjs`: catalog, Activation Snapshot, launchctl, health, and restore transaction.
- `router.mjs`, `vision-mcp.mjs`, `codex-hybrid.mjs`: thin transport and CLI adapters.

The repository's domain language is in `CONTEXT.md`; the provider-registry decision is recorded in
`docs/adr/0001-provider-registry-routing.md`.

## Privacy

Generated registries, credentials, catalogs, runtime state, logs, backups, Exa keys, and local Codex
configuration are excluded from Git. Plaintext inline credentials are supported by explicit user
choice. CLI list/status output never prints resolved credential values.

## Test

```sh
npm ci
npm test
```

Tests cover the Provider Registry, CLI editing module, runtime coordinates, namespace conversion,
Compatibility Translation, routing pipeline, HTTP/WebSocket provider integration, vision workflow,
cache behavior, and official-model isolation.

## License

MIT
