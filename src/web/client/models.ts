import type { ChatModelInfo, ModelCatalog, ProviderName } from "./types";

/** Rendered when the catalog has not loaded yet, so the picker is never empty. */
export const FALLBACK_MODELS: ChatModelInfo[] = [
  { id: "deepseek-v4.1-flash", vendor: "deepseek", vendorLabel: "DeepSeek", label: "DeepSeek V4.1 Flash", description: "", acceptsImages: true, configured: true },
  { id: "deepseek-pro", vendor: "deepseek", vendorLabel: "DeepSeek", label: "DeepSeek V4 Pro", description: "", acceptsImages: false, configured: true },
  { id: "claude-fable-5.1", vendor: "anthropic", vendorLabel: "Claude", label: "Claude Fable 5.1", description: "", acceptsImages: true, configured: true },
  { id: "claude-opus-5", vendor: "anthropic", vendorLabel: "Claude", label: "Claude Opus 5", description: "", acceptsImages: true, configured: true },
  { id: "gpt-6", vendor: "openai", vendorLabel: "OpenAI", label: "GPT-6", description: "", acceptsImages: true, configured: true },
];

export function catalogModels(catalog?: ModelCatalog): ChatModelInfo[] {
  return catalog?.models.length ? catalog.models : FALLBACK_MODELS;
}

export function findModel(catalog: ModelCatalog | undefined, id: ProviderName | undefined): ChatModelInfo | undefined {
  return catalogModels(catalog).find((model) => model.id === id);
}

/** Unknown ids default to accepting images; the server still enforces the real rule. */
export function providerAcceptsImages(catalog: ModelCatalog | undefined, id: ProviderName | undefined): boolean {
  return findModel(catalog, id)?.acceptsImages ?? true;
}

export function labelForProvider(catalog: ModelCatalog | undefined, id: ProviderName | undefined): string {
  return findModel(catalog, id)?.label || id || "";
}

/** Picker groups: one per vendor, in catalog order, legacy ids hidden unless selected. */
export function groupModels(catalog: ModelCatalog | undefined, selected: ProviderName): Array<{ vendor: string; vendorLabel: string; models: ChatModelInfo[] }> {
  const groups: Array<{ vendor: string; vendorLabel: string; models: ChatModelInfo[] }> = [];
  for (const model of catalogModels(catalog)) {
    if (model.legacy && model.id !== selected) continue;
    let group = groups.find((item) => item.vendor === model.vendor);
    if (!group) {
      group = { vendor: model.vendor, vendorLabel: model.vendorLabel, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}
