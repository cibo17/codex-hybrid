const AGENT_CALLS = new Set(["spawn_agent", "followup_task", "send_message"]);

function isOpenAiCiphertext(value) {
  return typeof value === "string" && /^gAAAAA[^\s]+$/.test(value);
}

function targetKey(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function targetName(value) {
  const key = targetKey(value);
  return key.split("/").filter(Boolean).at(-1) || key;
}

function taskNameFromContent(content) {
  const text = (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "input_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text.match(/^Task name:\s*(.+)$/m)?.[1]?.trim() || "";
}

async function portableContent(content, replacement, resolveEncrypted, item) {
  const output = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "input_text" && typeof part.text === "string") output.push(part);
    else if (part?.type === "encrypted_content" && typeof part.encrypted_content === "string") {
      let text = part.encrypted_content;
      if (isOpenAiCiphertext(text)) {
        text = replacement && !isOpenAiCiphertext(replacement) ? replacement : null;
        if (!text && resolveEncrypted) text = await resolveEncrypted(item, part.encrypted_content);
      }
      if (text) output.push({ type: "input_text", text });
    }
  }
  return output;
}

function portableInputItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "item_reference") return null;
  const portable = { ...item };
  // Responses output-item IDs belong to the provider that minted them. They
  // are not conversation identities and some providers validate a private
  // prefix (for example fc_* versus ctc*). Tool-result correlation remains
  // portable through call_id, so never replay the opaque item id upstream.
  delete portable.id;
  return portable;
}

export class CollaborationHistoryBridge {
  constructor({ now = () => Date.now(), ttlMs = 5 * 60 * 1000, limit = 128 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.pending = [];
    this.seen = new Set();
    this.decoded = new Map();
  }

  observe(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) this.observe(child);
      return;
    }
    if (value.type === "function_call" && AGENT_CALLS.has(value.name)) this.#record(value);
    for (const child of Object.values(value)) this.observe(child);
  }

  #record(call) {
    const identity = String(call.call_id || call.id || "");
    if (identity && this.seen.has(identity)) return;
    let args;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {
      return;
    }
    const message = args.message;
    const target = call.name === "spawn_agent" ? args.task_name : args.target;
    if (typeof message !== "string" || !message || typeof target !== "string" || !target) return;
    if (identity) this.seen.add(identity);
    this.pending.push({ target: targetKey(target), message, createdAt: this.now() });
    this.#prune();
  }

  #prune() {
    const cutoff = this.now() - this.ttlMs;
    this.pending = this.pending.filter((entry) => entry.createdAt >= cutoff).slice(-this.limit);
    for (const [ciphertext, entry] of this.decoded) {
      if (entry.createdAt < cutoff) this.decoded.delete(ciphertext);
    }
    while (this.decoded.size > this.limit) this.decoded.delete(this.decoded.keys().next().value);
    if (this.seen.size > this.limit * 4) this.seen.clear();
  }

  #take(target) {
    this.#prune();
    const key = targetKey(target);
    let index = this.pending.findIndex((entry) => entry.target === key);
    if (index < 0) {
      const matches = this.pending
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(({ entry }) => targetName(entry.target) === targetName(key));
      if (matches.length === 1) index = matches[0].entryIndex;
    }
    if (index < 0) return null;
    return this.pending.splice(index, 1)[0].message;
  }

  async prepareProviderBody(originalBody, { resolveEncrypted = null } = {}) {
    const body = structuredClone(originalBody);
    if (!Array.isArray(body?.input)) return body;
    const input = [];
    for (const item of body.input) {
      if (item?.type === "reasoning") continue;
      if (item?.type !== "agent_message") {
        const portable = portableInputItem(item);
        if (portable) input.push(portable);
        continue;
      }
      const replacement = this.#take(item.recipient || taskNameFromContent(item.content));
      const decode = resolveEncrypted
        ? async (message, ciphertext) => {
          const cached = this.decoded.get(ciphertext);
          if (cached) return cached.message;
          const decoded = await resolveEncrypted(message, ciphertext);
          this.decoded.set(ciphertext, { message: decoded, createdAt: this.now() });
          this.#prune();
          return decoded;
        }
        : null;
      const content = await portableContent(item.content, replacement, decode, item);
      if (content.length) input.push({ type: "message", role: "user", content });
    }
    body.input = input;
    return body;
  }
}
