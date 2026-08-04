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

**Vision Evidence**:
Textual evidence produced from an image for a Model Route that delegates image understanding instead of accepting native image input.
_Avoid_: image description, vision fallback

**Activation Snapshot**:
The complete pre-Hybrid Codex configuration captured so deactivation can restore it byte-for-byte.
_Avoid_: config backup, previous config
