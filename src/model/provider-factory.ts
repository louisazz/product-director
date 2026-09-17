import type { DirectorSettings } from "../core/types.js";
import type { ModelProvider } from "./provider.js";
import { MockModelProvider } from "./mock-provider.js";
import { DeepSeekProvider } from "./deepseek-provider.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import {
  DEFAULT_CHAT_MODEL,
  getChatModel,
  normalizeChatModel,
  VENDOR_META,
  type ModelVendor,
  type RequestedChatModel,
} from "./model-catalog.js";

export interface ProviderFactoryOptions {
  forceProvider?: RequestedChatModel;
}

function requireApiKey(vendor: ModelVendor): string {
  const meta = VENDOR_META[vendor];
  const apiKey = process.env[meta.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new Error(
      [
        `${meta.label} 的 API Key 未配置（${meta.apiKeyEnv}）。`,
        "",
        "可以：",
        `  1. 在 .env 中设置 ${meta.apiKeyEnv}`,
        "  2. 在侧边栏设置里填入 Key",
        "  3. 改用其他已配置的模型",
      ].join("\n"),
    );
  }
  return apiKey;
}

export function createModelProviderFromSettings(
  settings: DirectorSettings | null,
  options?: ProviderFactoryOptions,
): ModelProvider {
  const requested = options?.forceProvider ?? settings?.modelProvider ?? DEFAULT_CHAT_MODEL;
  if (requested === "mock") return new MockModelProvider();

  const id = normalizeChatModel(requested);
  if (!id) {
    throw new Error(`Unknown model provider: "${String(requested)}". Valid options: mock, ${["deepseek-v4.1-flash", "deepseek-pro", "claude-fable-5.1", "claude-opus-5", "gpt-6"].join(", ")}`);
  }
  const entry = getChatModel(id);
  const apiKey = requireApiKey(entry.vendor);
  const reasoningEffort = settings?.reasoningEffort ?? "high";

  switch (entry.vendor) {
    case "deepseek":
      return new DeepSeekProvider({
        apiKey,
        model: entry.model,
        providerName: entry.id,
        acceptsImages: entry.acceptsImages,
      });

    case "anthropic":
      return new AnthropicProvider({
        apiKey,
        model: entry.model,
        providerName: entry.id,
        acceptsImages: entry.acceptsImages,
        contextWindowTokens: entry.contextWindowTokens,
        reasoningEffort,
      });

    case "openai":
      return new OpenAIProvider({
        apiKey,
        model: entry.model,
        providerName: entry.id,
        acceptsImages: entry.acceptsImages,
        contextWindowTokens: entry.contextWindowTokens,
        reasoningEffort,
      });
  }
}
