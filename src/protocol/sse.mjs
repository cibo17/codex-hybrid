import { Readable, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function sseBlock(eventName, data) {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const dataText = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!eventName || !dataText || dataText === "[DONE]") return null;
  try {
    return { eventName, data: JSON.parse(dataText) };
  } catch {
    return null;
  }
}

export class ResponsesSseAdapter extends Transform {
  constructor(turn, { onEvent = () => {} } = {}) {
    super();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.reducer = turn.createEventReducer();
    this.onEvent = onEvent;
  }

  _transform(chunk, _encoding, callback) {
    this.buffer += this.decoder.write(chunk);
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = blocks.pop() || "";
    try {
      for (const block of blocks) this.processBlock(block);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.buffer += this.decoder.end();
      if (this.buffer.trim()) this.processBlock(this.buffer);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  processBlock(block) {
    const parsed = parseSseBlock(block);
    if (!parsed) {
      this.push(`${block}\n\n`);
      return;
    }
    for (const event of this.reducer.adapt(parsed.eventName, parsed.data)) {
      this.onEvent(event.data);
      this.push(sseBlock(event.eventName, event.data));
    }
  }
}

export async function readResponsesSse(upstream, onEvent) {
  if (!upstream.body) return;
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    buffer += decoder.write(chunk);
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) await onEvent(parsed);
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) {
    const parsed = parseSseBlock(buffer);
    if (parsed) await onEvent(parsed);
  }
}
