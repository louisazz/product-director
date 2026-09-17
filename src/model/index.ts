export type { ModelProvider } from "./provider.js";
export { MockModelProvider } from "./mock-provider.js";
export { ScriptedToolUseModelProvider } from "./scripted-provider.js";
export type { ScriptedToolUseOptions } from "./scripted-provider.js";
export { DeepSeekProvider } from "./deepseek-provider.js";
export type { DeepSeekProviderOptions } from "./deepseek-provider.js";
export { AnthropicProvider } from "./anthropic-provider.js";
export type { AnthropicProviderOptions } from "./anthropic-provider.js";
export { OpenAIProvider } from "./openai-provider.js";
export type { OpenAIProviderOptions } from "./openai-provider.js";
export { createModelProviderFromSettings } from "./provider-factory.js";
export type { ProviderFactoryOptions } from "./provider-factory.js";
export { mapMessagesToOpenAI, mapToolsToOpenAI, renderAttachmentDirectives } from "./message-mapper.js";
export {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  VENDOR_META,
  getChatModel,
  getPublicModelCatalog,
  isChatModelId,
  isModelVendor,
  isVendorConfigured,
  modelAcceptsImages,
  normalizeChatModel,
} from "./model-catalog.js";
export type { ChatModelEntry, ModelVendor, PublicChatModel, RequestedChatModel } from "./model-catalog.js";
