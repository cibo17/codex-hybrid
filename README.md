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
      "credential_pool": {
        "strategy": "fill_first",
        "entries": [
          { "id": "primary", "type": "inline", "api_key": "first-key" },
          { "id": "secondary", "type": "env", "name": "EXAMPLE_SECONDARY_KEY" }
        ]
      },
      "models": {
        "example-coder": {
          "display_name": "Example Coder",
          "description": "Coding model served by Example Responses.",
          "upstream_model": "provider-model-name",
          "context_window": 262144,
          "reasoning_efforts": ["low", "high"],
          "default_reasoning_effort": "high",
          "vision_mode": "delegated",
          "search_mode": "external",
          "tool_protocol": {
            "namespaces": "flatten",
            "custom_tools": "function",
            "deferred_tools": "code_mode",
            "tool_search": "passthrough"
          }
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

A provider may use either one legacy `credential` or a `credential_pool`. Pools use
`fill_first`: the first healthy entry remains preferred; retryable HTTP/network failures and a
first-event timeout cool it down and move to the next entry. A partially emitted stream is never
replayed through another credential. Optional pool settings are `cooldown_ms`,
`first_event_timeout_ms`, and `idle_timeout_ms`.

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
codex-hybrid key add example secondary --env EXAMPLE_SECONDARY_KEY
codex-hybrid key list example
codex-hybrid key remove example secondary
codex-hybrid key remove example

# Model Routes
codex-hybrid model list
codex-hybrid model add example example-coder \
  --display-name "Example Coder" \
  --upstream-model provider-model-name \
  --context-window 262144 \
  --efforts low,high \
  --default-effort high \
  --vision delegated \
  --search external \
  --namespaces flatten \
  --custom-tools function \
  --deferred-tools code_mode \
  --tool-search passthrough
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

## Search modes

- `external` leaves MCP search tools such as Exa visible and does not advertise provider-native search.
- `native` advertises the Responses `web_search` tool and removes Exa tools from requests to that model,
  giving the provider-native search path deterministic priority.

Official models bypass this policy and retain Codex's native search behavior.

## Tool protocol profiles

Each Model Route can declare the Responses Provider features it actually supports:

- `namespaces`: `flatten` converts Codex namespaces into portable function names; `native` preserves them.
- `custom_tools`: `function` converts freeform tools such as `exec` and `apply_patch`; `native` preserves them.
- `deferred_tools`: `code_mode` keeps deferred tools behind Codex Code Mode; `expand` exposes them directly.
- `tool_search`: `passthrough` preserves a host-advertised `tool_search`; `disabled` removes it and its history.

Codex Hybrid does not invent a `tool_search` capability when Codex App did not advertise one. A future
discovery adapter can be added at the Tool Exposure seam without changing Provider or Router modules.

For Code Mode, the standing catalog keeps GitHub, `node_repl` (the entry to Chrome, Browser, and
Computer Use), Subagents, Hybrid Vision, and the required core execution tools. Other nested tools activate from explicit task
keywords or can be discovered from the runtime `ALL_TOOLS` index. The standing skill list keeps GitHub,
Chrome, Browser, Computer Use, and `x-bird-cli`; other local skills are discovered with the bundled
`bin/skill-search.mjs` and loaded from their `SKILL.md` only when needed.

## Install

Requirements: macOS, Node.js 20.18.1 or newer, npm, and Codex authenticated with a ChatGPT account.

The installer creates `~/.codex/hybrid/runtime/node` as a symlink to a standalone Node executable.
Hermes-owned runtimes are deliberately skipped. Homebrew Node is discovered automatically, or use
`CODEX_HYBRID_NODE=/absolute/path/to/node` to select a different target. Full Disk Access is optional
and only relevant when that Node process must read macOS-protected folders.

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

Exa is independent from Codex Hybrid. Install Exa's official hosted MCP directly in Codex if you
want its standard `web_search_exa` and `web_fetch_exa` tools:

```sh
codex mcp add exa --url https://mcp.exa.ai/mcp
```

Codex Hybrid does not install, patch, configure, remove, or add instructions for Exa. See the
official [`exa-mcp-server`](https://github.com/exa-labs/exa-mcp-server) documentation for API-key
and self-hosted options.

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

- `src/provider/`: Provider Registry, capability profiles, fill-first transport, routing, and management.
- `src/tools/`: immutable per-turn Tool Inventory, Tool Exposure policy, Provider Tool Codec, stream reducer,
  portable collaboration history, lazy tool/skill catalogs, diagnostics, and isolated Vision Capability binding.
- `src/protocol/`: transport-neutral Responses SSE framing only.
- `src/vision/`: delegated Vision Evidence workflow and its MCP adapter; it does not own namespace state.
- `src/activation.mjs`: catalog, Activation Snapshot, launchctl, health, and restore transaction.
- `src/router.mjs`: HTTP/WebSocket transport adapter.
- `bin/codex-hybrid.mjs`: CLI adapter.
- `scripts/install.mjs`: local installer and LaunchAgent generation.
- `tests/`: tests organized against the same module seams.

The repository's domain language is in `docs/architecture/domain-language.md`; the Provider
Registry decision is recorded in `docs/adr/0001-provider-registry-routing.md`.

## Privacy

Generated registries, credentials, catalogs, runtime state, logs, backups, and local Codex
configuration are excluded from Git. Plaintext inline credentials are supported by explicit user
choice. CLI list/status output never prints resolved credential values.

`CODEX_HYBRID_DIAGNOSTICS=1` is an explicit troubleshooting mode that writes complete provider request
bodies and field-size breakdowns under `~/.codex/hybrid/diagnostics/`. Those files can include prompts,
tool results, paths, and other private context; leave the setting disabled outside a bounded diagnosis.

## Test

```sh
npm ci
npm test
```

Tests cover the Provider Registry, CLI editing module, runtime coordinates, per-turn namespace conversion,
Tool Exposure and Provider Tool Codec, HTTP/WebSocket equivalence, routing, vision workflow,
credential failover/timeouts, cache behavior, and official-model isolation.

## License

MIT
