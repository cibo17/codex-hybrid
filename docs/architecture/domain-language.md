# Codex Hybrid Routing

Codex Hybrid Routing lets one Codex installation keep its official ChatGPT path while selecting additional Responses-compatible model backends by model name.

## Language

**Official Path**:
The unchanged route from Codex to the ChatGPT Codex backend for models not claimed by a configured Responses Provider.
_Avoid_: OpenAI provider, default provider

**Responses Provider**:
A configured upstream that accepts OpenAI Responses-shaped HTTP requests and owns one or more Model Routes.
_Avoid_: Ollama provider, third-party backend

**Model Route**:
The globally unique model name that selects a Responses Provider and its model-specific capabilities.
_Avoid_: model alias, provider model

**Provider Registry**:
The versioned configuration containing Responses Providers, Model Routes, and credential references or inline credentials.
_Avoid_: provider list, routes file

**Credential Source**:
The configured location of a Responses Provider credential: inline configuration, environment, macOS Keychain, or no credential.
_Avoid_: API key field

**Compatibility Translation**:
The reversible conversion between Codex-specific Responses shapes and the portable Responses shape accepted by a Responses Provider.
_Avoid_: Ollama adapter, request cleanup

**Tool Inventory**:
The immutable, per-turn snapshot of tools and deferred tools advertised by Codex App. It never stores provider aliases, Vision authorization, or streaming state.
_Avoid_: plugin registry, global tools

**Tool Exposure**:
The pure policy that selects which Tool Inventory entries a Model Route may see and whether they remain native, flatten into functions, or stay deferred behind Code Mode.
_Avoid_: tool filter patch, namespace hack

**Provider Tool Codec**:
The reversible per-turn Compatibility Translation for tool declarations, calls, and streamed call arguments. Its call state ends with the response.
_Avoid_: NamespaceBridge, plugin middleware

**Collaboration History Bridge**:
The cross-provider boundary that removes non-portable reasoning, converts Codex `agent_message` items into standard Responses messages, and decodes an official encrypted task through a minimal Luna sidecar only when an official parent targets a Responses Provider subagent.
_Avoid_: agent-message patch, global decryption

**Vision Capability**:
The isolated binding that augments the Hybrid vision tool with an opaque context and decorates its returned calls without entering general namespace state.
_Avoid_: vision namespace state, image fallback token

**Vision Evidence**:
Textual evidence produced from an image for a Model Route that delegates image understanding instead of accepting native image input.
_Avoid_: image description, vision fallback

**Activation Snapshot**:
The complete pre-Hybrid Codex configuration captured so deactivation can restore it byte-for-byte.
_Avoid_: config backup, previous config
