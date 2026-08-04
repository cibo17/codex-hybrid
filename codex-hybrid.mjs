#!/usr/bin/env node

import { hybridActivation, providerRegistryEditor } from "./activation.mjs";

function fail(message) {
  process.stderr.write(`codex-hybrid: ${message}\n`);
  process.exit(1);
}

function printRestartNotice() {
  process.stdout.write("Fully quit and reopen Codex App once to reload its model picker.\n");
}

function optionMap(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

function credentialFromOptions(options, fallback = { type: "none" }) {
  const transport = {
    ...(typeof options.header === "string" ? { header: options.header } : {}),
    ...(typeof options.prefix === "string" ? { prefix: options.prefix } : {}),
  };
  if (typeof options["api-key"] === "string") return { type: "inline", api_key: options["api-key"], ...transport };
  if (typeof options.env === "string") return { type: "env", name: options.env, ...transport };
  if (typeof options["keychain-service"] === "string") {
    if (typeof options["keychain-account"] !== "string") fail("--keychain-account is required with --keychain-service");
    return { type: "keychain", service: options["keychain-service"], account: options["keychain-account"], ...transport };
  }
  if (options.none) return { type: "none" };
  return fallback;
}

function printRegistry() {
  process.stdout.write(`${JSON.stringify(providerRegistryEditor.publicView(), null, 2)}\n`);
}

function providerCommand(args) {
  const subcommand = args[0] || "list";
  const id = args[1];
  const options = optionMap(args.slice(2));
  if (subcommand === "list") return printRegistry();
  if (!id) fail(`provider ${subcommand} requires an id`);
  if (subcommand === "add") {
    if (typeof options["base-url"] !== "string") fail("provider add requires --base-url");
    providerRegistryEditor.addProvider(id, {
      name: typeof options.name === "string" ? options.name : id,
      baseUrl: options["base-url"],
      credential: credentialFromOptions(options),
    });
  } else if (subcommand === "remove") providerRegistryEditor.removeProvider(id);
  else fail("usage: codex-hybrid provider list | add <id> --base-url <url> | remove <id>");
  hybridActivation.refreshCatalogIfActive();
  process.stdout.write(`Responses Provider ${id} ${subcommand === "add" ? "added" : "removed"}.\n`);
  printRestartNotice();
}

function keyCommand(args) {
  const subcommand = args[0];
  const providerId = args[1];
  if (!providerId || !["set", "remove"].includes(subcommand)) {
    fail("usage: codex-hybrid key set <provider> [--api-key <key> | --env <name> | --keychain-service <service> --keychain-account <account> | --none] | key remove <provider>");
  }
  const credential = subcommand === "remove"
    ? { type: "none" }
    : credentialFromOptions(optionMap(args.slice(2)), null);
  if (!credential) fail("key set requires a credential option");
  providerRegistryEditor.setCredential(providerId, credential);
  process.stdout.write(`Credential Source for ${providerId} set to ${credential.type}.\n`);
}

function modelCommand(args) {
  const subcommand = args[0] || "list";
  if (subcommand === "list") return printRegistry();
  if (subcommand === "add") {
    const providerId = args[1];
    const slug = args[2];
    if (!providerId || !slug) fail("model add requires <provider> <slug>");
    const options = optionMap(args.slice(3));
    providerRegistryEditor.addModel(providerId, slug, {
      display_name: typeof options["display-name"] === "string" ? options["display-name"] : undefined,
      description: typeof options.description === "string" ? options.description : undefined,
      context_window: options["context-window"] ? Number(options["context-window"]) : undefined,
      reasoning_efforts: typeof options.efforts === "string" ? options.efforts.split(",").filter(Boolean) : undefined,
      default_reasoning_effort: typeof options["default-effort"] === "string" ? options["default-effort"] : undefined,
      vision_mode: typeof options.vision === "string" ? options.vision : "delegated",
    });
    hybridActivation.refreshCatalogIfActive();
    process.stdout.write(`Model Route ${slug} added to ${providerId}.\n`);
    printRestartNotice();
    return;
  }
  if (subcommand === "remove") {
    const slug = args[1];
    if (!slug) fail("model remove requires <slug>");
    providerRegistryEditor.removeModel(slug);
    hybridActivation.refreshCatalogIfActive();
    process.stdout.write(`Model Route ${slug} removed.\n`);
    printRestartNotice();
    return;
  }
  fail("usage: codex-hybrid model list | add <provider> <slug> [options] | remove <slug>");
}

async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "on") await hybridActivation.on();
  else if (command === "off") await hybridActivation.off();
  else if (command === "status") await hybridActivation.status();
  else if (command === "provider") providerCommand(args);
  else if (command === "key") keyCommand(args);
  else if (command === "model") modelCommand(args);
  else fail("usage: codex-hybrid on | off | status | provider ... | key ... | model ...");
}

try {
  await main();
} catch (error) {
  fail(error?.message || String(error));
}
