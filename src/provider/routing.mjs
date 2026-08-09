import { ProviderToolCodec } from "../tools/codec.mjs";

export class ModelRoutingPipeline {
  constructor({ registry, visionWorkflow, toolCodec = new ProviderToolCodec(), collaborationBridge = null }) {
    this.registry = registry;
    this.visionWorkflow = visionWorkflow;
    this.toolCodec = toolCodec;
    this.collaborationBridge = collaborationBridge;
  }

  route(model) {
    return typeof model === "string" ? this.registry.route(model) : null;
  }

  async prepare(body, {
    transport,
    authHeaders,
    accountScope,
    promptCacheKey,
    contextId = null,
  }) {
    const route = this.route(body?.model);
    if (!route) {
      return {
        kind: "official",
        route: null,
        body: body ? this.visionWorkflow.prepareOfficialBody(body) : body,
        historyBody: body,
        toolTurn: null,
        contextId: null,
      };
    }
    const portableBody = this.collaborationBridge
      ? await this.collaborationBridge.prepareProviderBody(body, {
        resolveEncrypted: (item) => this.visionWorkflow.decodeAgentPayload(item, authHeaders),
      })
      : body;
    const vision = await this.visionWorkflow.prepareProviderBody(portableBody, {
      visionMode: route.model.vision_mode,
      headers: authHeaders,
      accountScope,
      promptCacheKey,
      contextId,
      transport,
      maxImages: route.model.vision_max_images_per_turn,
      failurePolicy: route.model.vision_failure_policy,
    });
    const toolTurn = this.toolCodec.prepare(vision.body, {
      profile: route.model.tool_protocol,
      nativeSearch: route.model.search_mode === "native",
      visionContextId: vision.contextId,
    });
    toolTurn.upstreamBody.model = route.model.upstream_model;
    return {
      kind: "provider",
      route,
      body: toolTurn.upstreamBody,
      historyBody: vision.body,
      toolTurn,
      contextId: vision.contextId,
    };
  }
}
