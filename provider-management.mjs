import fs from "node:fs";

import {
  defaultRegistry,
  publicRegistry,
  validateRegistry,
  writeRegistry,
} from "./provider-registry.mjs";

export class ProviderRegistryEditor {
  constructor(file) {
    this.file = file;
  }

  ensure() {
    if (!fs.existsSync(this.file)) writeRegistry(this.file, defaultRegistry());
    return this.read();
  }

  read() {
    const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
    validateRegistry(value);
    return value;
  }

  publicView() {
    return publicRegistry(this.ensure());
  }

  update(mutator) {
    const value = structuredClone(this.ensure());
    mutator(value);
    validateRegistry(value);
    writeRegistry(this.file, value);
    return value;
  }

  addProvider(id, { name = id, baseUrl, credential = { type: "none" } }) {
    return this.update((value) => {
      if (value.providers[id]) throw new Error(`Responses Provider already exists: ${id}`);
      value.providers[id] = { name, base_url: baseUrl, credential, models: {} };
    });
  }

  removeProvider(id) {
    return this.update((value) => {
      if (!value.providers[id]) throw new Error(`Responses Provider not found: ${id}`);
      delete value.providers[id];
    });
  }

  setCredential(id, credential) {
    return this.update((value) => {
      if (!value.providers[id]) throw new Error(`Responses Provider not found: ${id}`);
      value.providers[id].credential = credential;
    });
  }

  addModel(providerId, slug, model = {}) {
    return this.update((value) => {
      const provider = value.providers[providerId];
      if (!provider) throw new Error(`Responses Provider not found: ${providerId}`);
      for (const candidate of Object.values(value.providers)) {
        if (candidate.models?.[slug]) throw new Error(`Model Route already exists: ${slug}`);
      }
      provider.models ||= {};
      provider.models[slug] = model;
    });
  }

  removeModel(slug) {
    return this.update((value) => {
      for (const provider of Object.values(value.providers)) {
        if (provider.models?.[slug]) {
          delete provider.models[slug];
          return;
        }
      }
      throw new Error(`Model Route not found: ${slug}`);
    });
  }
}
