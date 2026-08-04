# Route configured model names through a Responses Provider registry

Codex Hybrid keeps the Official Path implicit and isolated, while a versioned Provider Registry claims globally unique Model Routes for any HTTP upstream that accepts OpenAI Responses-shaped requests. This avoids coupling the router to Ollama Pro, permits configuration and CLI management without changing Codex account identity, and keeps Compatibility Translation shared across providers instead of forking per-provider routing logic.

Credential Sources may be inline configuration, environment variables, macOS Keychain entries, or absent. The router never prints resolved credential values, but plaintext inline credentials are intentionally allowed for users who prefer a self-contained configuration.
