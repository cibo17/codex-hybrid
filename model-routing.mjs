import { resolveCredential } from "./provider-registry.mjs";
import { adaptRequestForProvider } from "./responses-protocol.mjs";

export class ModelRoutingPipeline {
  constructor({ registry, visionWorkflow, credentialResolver = resolveCredential }) {
    this.registry = registry;
    this.visionWorkflow = visionWorkflow;
    this.credentialResolver = credentialResolver;
  }

  route(model) {
    return typeof model === "string" ? this.registry.route(model) : null;
  }

  credential(route) {
    if (!route) return "";
    return this.credentialResolver(route.provider.credential);
  }

  credentialAvailable(route) {
    return !route || route.provider.credential.type === "none" || Boolean(this.credential(route));
  }

  allCredentialsAvailable() {
    const registry = this.registry.reload();
    return Object.values(registry.providers).every((provider) => this.credentialAvailable({ provider }));
  }

  providerHeaders(route) {
    const credential = this.credential(route);
    if (route.provider.credential.type !== "none" && !credential) {
      throw new Error(`credential is unavailable for Responses Provider ${route.provider.id}`);
    }
    const headers = { "content-type": "application/json" };
    if (credential) {
      const name = route.provider.credential.header || "authorization";
      const prefix = route.provider.credential.prefix ?? "Bearer ";
      headers[name] = `${prefix}${credential}`;
    }
    return headers;
  }

  async prepare(body, {
    transport,
    authHeaders,
    accountScope,
    promptCacheKey,
    contextId = null,
    namespaceBridge = null,
  }) {
    const route = this.route(body?.model);
    if (!route) {
      return {
        kind: "official",
        route: null,
        body: body ? this.visionWorkflow.prepareOfficialBody(body) : body,
        historyBody: body,
        namespaceBridge: null,
        contextId: null,
      };
    }
    if (!this.credentialAvailable(route)) {
      throw new Error(`credential is unavailable for Responses Provider ${route.provider.id}`);
    }
    const vision = await this.visionWorkflow.prepareProviderBody(body, {
      visionMode: route.model.vision_mode,
      headers: authHeaders,
      accountScope,
      promptCacheKey,
      contextId,
      transport,
    });
    const protocol = adaptRequestForProvider(vision.body, namespaceBridge);
    return {
      kind: "provider",
      route,
      body: protocol.body,
      historyBody: vision.body,
      namespaceBridge: protocol.bridge,
      contextId: vision.contextId,
    };
  }
}
