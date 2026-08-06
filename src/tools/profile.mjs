const NAMESPACE_MODES = new Set(["flatten", "native"]);
const CUSTOM_TOOL_MODES = new Set(["function", "native"]);
const DEFERRED_TOOL_MODES = new Set(["code_mode", "expand"]);
const TOOL_SEARCH_MODES = new Set(["passthrough", "disabled"]);

export const DEFAULT_PROVIDER_TOOL_PROFILE = Object.freeze({
  namespaces: "flatten",
  customTools: "function",
  deferredTools: "code_mode",
  toolSearch: "passthrough",
});

export function normalizeProviderToolProfile(value = {}) {
  const profile = {
    namespaces: value.namespaces ?? DEFAULT_PROVIDER_TOOL_PROFILE.namespaces,
    customTools: value.custom_tools ?? value.customTools ?? DEFAULT_PROVIDER_TOOL_PROFILE.customTools,
    deferredTools: value.deferred_tools ?? value.deferredTools ?? DEFAULT_PROVIDER_TOOL_PROFILE.deferredTools,
    toolSearch: value.tool_search ?? value.toolSearch ?? DEFAULT_PROVIDER_TOOL_PROFILE.toolSearch,
  };
  if (!NAMESPACE_MODES.has(profile.namespaces)) throw new Error("tool_protocol.namespaces is invalid");
  if (!CUSTOM_TOOL_MODES.has(profile.customTools)) throw new Error("tool_protocol.custom_tools is invalid");
  if (!DEFERRED_TOOL_MODES.has(profile.deferredTools)) throw new Error("tool_protocol.deferred_tools is invalid");
  if (!TOOL_SEARCH_MODES.has(profile.toolSearch)) throw new Error("tool_protocol.tool_search is invalid");
  return Object.freeze(profile);
}
