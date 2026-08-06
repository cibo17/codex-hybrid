import fs from "node:fs";
import path from "node:path";

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function toolRow(tool, location) {
  const schema = tool?.parameters ?? tool?.input_schema ?? tool?.format ?? null;
  return {
    location,
    type: tool?.type ?? "unknown",
    name: tool?.name ?? null,
    bytes: bytes(tool),
    description_bytes: typeof tool?.description === "string" ? Buffer.byteLength(tool.description) : 0,
    schema_bytes: schema === null ? 0 : bytes(schema),
    child_tools: Array.isArray(tool?.tools) ? tool.tools.length : 0,
  };
}

function nestedToolRows(input) {
  const rows = [];
  for (const [inputIndex, item] of (Array.isArray(input) ? input : []).entries()) {
    if (item?.type !== "additional_tools" || !Array.isArray(item.tools)) continue;
    for (const [toolIndex, tool] of item.tools.entries()) {
      rows.push(toolRow(tool, `input[${inputIndex}].tools[${toolIndex}]`));
      if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
        for (const [childIndex, child] of tool.tools.entries()) {
          rows.push(toolRow(child, `input[${inputIndex}].tools[${toolIndex}].tools[${childIndex}]`));
        }
      }
    }
  }
  return rows;
}

export function providerRequestBreakdown(body) {
  const topLevel = Object.entries(body || {})
    .map(([key, value]) => ({ key, bytes: bytes(value) }))
    .sort((left, right) => right.bytes - left.bytes);
  const inputItems = (Array.isArray(body?.input) ? body.input : [])
    .map((item, index) => ({
      index,
      type: item?.type ?? null,
      role: item?.role ?? null,
      name: item?.name ?? null,
      namespace: item?.namespace ?? null,
      bytes: bytes(item),
    }))
    .sort((left, right) => right.bytes - left.bytes);
  const tools = [
    ...(Array.isArray(body?.tools) ? body.tools.map((tool, index) => toolRow(tool, `tools[${index}]`)) : []),
    ...nestedToolRows(body?.input),
  ].sort((left, right) => right.bytes - left.bytes);
  return {
    model: body?.model ?? null,
    total_bytes: bytes(body),
    top_level: topLevel,
    input_items: inputItems,
    tools,
  };
}

let sequence = 0;

export function captureProviderRequest(root, route, body, { transport }) {
  if (!process.env.CODEX_HYBRID_DIAGNOSTICS) return;
  const directory = path.join(root, "diagnostics");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = `${Date.now()}-${process.pid}-${sequence++}`;
  const record = {
    captured_at: new Date().toISOString(),
    transport,
    provider: route.provider.id,
    model_route: Object.entries(route.provider.models).find(([, model]) => model === route.model)?.[0] ?? null,
    breakdown: providerRequestBreakdown(body),
  };
  fs.writeFileSync(path.join(directory, `${stamp}.request.json`), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, `${stamp}.breakdown.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}
