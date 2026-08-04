import crypto from "node:crypto";
import fs from "node:fs";

import { readResponsesSse } from "../protocol/responses.mjs";
import {
  VisionCache,
  bindHybridVisionContext,
  imageDataUrlFromPath,
  latestUserHasDirectImage,
  replaceImagesForTextModel,
  sanitizeHistoryForOpenAI,
  stripHybridVisionTools,
  suppressViewImageTool,
} from "./bridge.mjs";

export class VisionEvidenceWorkflow {
  constructor({
    tokenFile,
    openAiBase,
    model = "gpt-5.6-luna",
    fetch,
    dispatcher,
    log = () => {},
    maxContextAgeMs = 15 * 60 * 1000,
    contextLimit = 128,
    cache = new VisionCache(64, 60 * 60 * 1000),
  }) {
    this.tokenFile = tokenFile;
    this.openAiBase = openAiBase;
    this.model = model;
    this.fetch = fetch;
    this.dispatcher = dispatcher;
    this.log = log;
    this.maxContextAgeMs = maxContextAgeMs;
    this.contextLimit = contextLimit;
    this.cache = cache;
    this.contextDerivationKey = crypto.randomBytes(32);
    this.contexts = new Map();
    this.metrics = {
      inputsReplaced: 0,
      lunaCalls: 0,
      lunaLatencySamples: 0,
      lunaLatencyTotalMs: 0,
      lunaLatencyLastMs: 0,
      lunaLatencyMaxMs: 0,
      authContextsCreated: 0,
      authContextReuses: 0,
    };
  }

  pruneContexts() {
    const cutoff = Date.now() - this.maxContextAgeMs;
    for (const [id, context] of this.contexts) {
      if (context.capturedAt <= cutoff) this.contexts.delete(id);
    }
    while (this.contexts.size > this.contextLimit) this.contexts.delete(this.contexts.keys().next().value);
  }

  stableContextId(accountScope, promptCacheKey) {
    if (typeof promptCacheKey !== "string" || !promptCacheKey) return null;
    const digest = crypto
      .createHmac("sha256", this.contextDerivationKey)
      .update(String(accountScope || ""))
      .update("\0")
      .update(promptCacheKey)
      .digest("base64url")
      .slice(0, 24);
    return `vision_ctx_${digest}`;
  }

  rememberContext(headers, preferredId = null) {
    this.pruneContexts();
    const id = preferredId || `vision_ctx_${crypto.randomBytes(18).toString("base64url")}`;
    const existing = this.contexts.get(id);
    if (existing) {
      existing.headers = headers;
      existing.capturedAt = Date.now();
      this.metrics.authContextReuses += 1;
      return { id, context: existing };
    }
    const context = { headers, capturedAt: Date.now() };
    this.contexts.set(id, context);
    this.metrics.authContextsCreated += 1;
    return { id, context };
  }

  activeContext(contextId) {
    this.pruneContexts();
    const context = this.contexts.get(contextId);
    if (!context) throw new Error("Hybrid vision capability is missing or expired; send a new Hybrid model message and retry");
    return context;
  }

  outputText(value) {
    const texts = [];
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (["output_text", "text"].includes(node.type) && typeof node.text === "string" && node.text) texts.push(node.text);
      for (const child of Object.values(node)) visit(child);
    };
    visit(value?.output ?? value?.response?.output ?? []);
    return texts.join("\n").trim();
  }

  requestBody(request) {
    const images = Array.isArray(request.images) && request.images.length
      ? request.images
      : [{ image_url: request.image_url, detail: request.detail || "high", label: request.label || "Image 1" }];
    const imageContent = images.flatMap((image, index) => [
      { type: "input_text", text: image.label || `Image ${index + 1}` },
      { type: "input_image", image_url: image.image_url, detail: image.detail || "high" },
    ]);
    return {
      model: this.model,
      reasoning: { effort: "medium" },
      instructions: [
        "You are a vision sidecar for a downstream coding agent.",
        "Answer only from the supplied image. Preserve exact visible text, numbers, paths, error messages, spatial relationships, and uncertainty.",
        "Do not claim to have performed actions. Return a compact but sufficiently detailed factual analysis for the downstream agent.",
      ].join("\n"),
      input: [{
        role: "user",
        content: [{ type: "input_text", text: request.prompt || "Describe this image accurately." }, ...imageContent],
      }],
      tools: [],
      stream: true,
      store: false,
    };
  }

  async responseText(upstream) {
    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const value = await upstream.json();
      const text = this.outputText(value);
      if (!text) throw new Error("Luna returned no text analysis");
      return text;
    }
    let text = "";
    let completed;
    await readResponsesSse(upstream, async ({ eventName, data }) => {
      if (eventName === "response.output_text.delta" && typeof data.delta === "string") text += data.delta;
      if (eventName === "response.output_text.done" && !text && typeof data.text === "string") text = data.text;
      if (eventName === "response.completed") completed = data;
      if (eventName === "response.failed") throw new Error(data?.response?.error?.message || "Luna response failed");
    });
    text = text.trim() || this.outputText(completed);
    if (!text) throw new Error("Luna returned no text analysis");
    return text;
  }

  async analyzeWithLuna(request, context) {
    return this.cache.getOrCreate(request, async () => {
      this.metrics.lunaCalls += 1;
      const startedAt = Date.now();
      try {
        const upstream = await this.fetch(`${this.openAiBase}/responses`, {
          method: "POST",
          headers: context.headers,
          body: JSON.stringify(this.requestBody(request)),
          redirect: "manual",
          dispatcher: this.dispatcher,
        });
        if (!upstream.ok) {
          const errorText = await upstream.text();
          throw new Error(`Luna vision request received HTTP ${upstream.status}: ${errorText.slice(0, 300)}`);
        }
        return await this.responseText(upstream);
      } finally {
        const durationMs = Date.now() - startedAt;
        this.metrics.lunaLatencySamples += 1;
        this.metrics.lunaLatencyTotalMs += durationMs;
        this.metrics.lunaLatencyLastMs = durationMs;
        this.metrics.lunaLatencyMaxMs = Math.max(this.metrics.lunaLatencyMaxMs, durationMs);
        this.log(`Luna vision request finished in ${durationMs} ms`);
      }
    });
  }

  async prepareProviderBody(body, { visionMode, headers, accountScope, promptCacheKey, contextId = null, transport = "http" }) {
    if (visionMode === "native") return { body: stripHybridVisionTools(body), contextId: null, replaced: 0 };
    const preferredId = contextId || this.stableContextId(accountScope, promptCacheKey);
    const openAiContext = this.rememberContext(headers, preferredId);
    const directImage = latestUserHasDirectImage(body?.input);
    const prepared = await replaceImagesForTextModel(body, (request) => this.analyzeWithLuna(request, openAiContext.context));
    const result = bindHybridVisionContext(suppressViewImageTool(prepared.body), openAiContext.id);
    if (prepared.replaced) {
      this.metrics.inputsReplaced += prepared.replaced;
      this.log(`replaced ${prepared.replaced} ${transport === "websocket" ? "websocket " : ""}image input(s) with parallel per-image ${this.model} evidence${directImage ? "; direct attachment" : ""}`);
    }
    return { body: result, contextId: openAiContext.id, replaced: prepared.replaced };
  }

  prepareOfficialBody(body) {
    return sanitizeHistoryForOpenAI(stripHybridVisionTools(body));
  }

  validToken(actual) {
    try {
      const expected = fs.readFileSync(this.tokenFile, "utf8").trim();
      const expectedBytes = Buffer.from(expected);
      const actualBytes = Buffer.from(String(actual || ""));
      return expectedBytes.length > 0 && expectedBytes.length === actualBytes.length && crypto.timingSafeEqual(expectedBytes, actualBytes);
    } catch {
      return false;
    }
  }

  async analyzePath({ token, path, prompt, detail = "high", contextId }) {
    if (!this.validToken(token)) throw new Error("unauthorized hybrid vision request");
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
    if (!["high", "original"].includes(detail)) throw new Error("detail must be high or original");
    const image = imageDataUrlFromPath(path);
    const context = this.activeContext(contextId);
    return this.analyzeWithLuna({
      image_url: image.image_url,
      prompt: prompt.slice(0, 16_000),
      detail,
      mode: "tool",
    }, context);
  }

  health() {
    this.pruneContexts();
    return {
      tokenAvailable: fs.existsSync(this.tokenFile),
      authReady: this.contexts.size > 0,
      vision: {
        ...this.cache.stats(),
        authContexts: this.contexts.size,
        authContextsCreated: this.metrics.authContextsCreated,
        authContextReuses: this.metrics.authContextReuses,
        inputsReplaced: this.metrics.inputsReplaced,
        lunaCalls: this.metrics.lunaCalls,
        lunaLatencyMs: {
          last: this.metrics.lunaLatencyLastMs,
          average: this.metrics.lunaLatencySamples
            ? Math.round(this.metrics.lunaLatencyTotalMs / this.metrics.lunaLatencySamples)
            : 0,
          max: this.metrics.lunaLatencyMaxMs,
          samples: this.metrics.lunaLatencySamples,
        },
      },
    };
  }
}
