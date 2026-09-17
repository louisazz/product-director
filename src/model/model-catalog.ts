import type { ChatModelId } from "../core/agent-types.js";

/**
 * One row per selectable chat model. The id is what sessions lock to and what
 * the client sends back; the vendor/model pair is how it is actually called.
 * Keeping the id flat (instead of vendor + model) matches how sessions, turns
 * and the picker already work.
 */
export type ModelVendor = "deepseek" | "anthropic" | "openai";
export type RequestedChatModel = "mock" | ChatModelId | "deepseek" | "deepseek-flash";

export interface ChatModelEntry {
  id: ChatModelId;
  vendor: ModelVendor;
  /** Vendor-side model name sent on the wire. */
  model: string;
  label: string;
  description: string;
  acceptsImages: boolean;
  contextWindowTokens: number;
  /** Kept so old sessions still resolve, but hidden from the picker. */
  legacy?: boolean;
}

export const VENDOR_META: Record<ModelVendor, { label: string; apiKeyEnv: string }> = {
  deepseek: { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  anthropic: { label: "Claude", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY" },
};

export const CHAT_MODELS: readonly ChatModelEntry[] = [
  {
    id: "deepseek-v4.1-flash",
    vendor: "deepseek",
    model: "deepseek-flash",
    label: "DeepSeek V4.1 Flash",
    description: "可读图，速度快，默认模型",
    acceptsImages: true,
    contextWindowTokens: 1_000_000,
  },
  {
    id: "deepseek-pro",
    vendor: "deepseek",
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "最强推理，不能读图和附件",
    acceptsImages: false,
    contextWindowTokens: 1_000_000,
  },
  {
    // DeepSeek retired deepseek-v4-flash-vision-exp; sessions locked to it keep
    // working on the current Flash model, which reads images too.
    id: "deepseek-vision",
    vendor: "deepseek",
    model: "deepseek-flash",
    label: "DeepSeek V4 Vision",
    description: "旧会话专用，已并入 V4.1 Flash",
    acceptsImages: true,
    contextWindowTokens: 1_000_000,
    legacy: true,
  },
  {
    id: "claude-fable-5.1",
    vendor: "anthropic",
    model: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    description: "最高能力，复杂推理与长任务",
    acceptsImages: true,
    contextWindowTokens: 1_000_000,
  },
  {
    id: "claude-opus-5",
    vendor: "anthropic",
    model: "claude-opus-5",
    label: "Claude Opus 5",
    description: "深度分析与写作的高级模型",
    acceptsImages: true,
    contextWindowTokens: 1_000_000,
  },
  {
    id: "gpt-6",
    vendor: "openai",
    model: "gpt-6-astra",
    label: "GPT-6",
    description: "OpenAI 旗舰模型",
    acceptsImages: true,
    contextWindowTokens: 400_000,
  },
];

export const DEFAULT_CHAT_MODEL: ChatModelId = "deepseek-v4.1-flash";

const BY_ID = new Map(CHAT_MODELS.map((entry) => [entry.id, entry]));

export function isChatModelId(value: unknown): value is ChatModelId {
  return typeof value === "string" && BY_ID.has(value as ChatModelId);
}

/** Accepts the current ids plus the aliases older clients and settings used. */
export function normalizeChatModel(value: unknown): ChatModelId | undefined {
  if (isChatModelId(value)) return value;
  if (value === "deepseek-flash") return "deepseek-v4.1-flash";
  if (value === "deepseek") return "deepseek-pro";
  return undefined;
}

export function getChatModel(id: ChatModelId): ChatModelEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`Unknown chat model: "${id}".`);
  return entry;
}

export function modelAcceptsImages(id: unknown): boolean {
  const normalized = normalizeChatModel(id);
  return normalized ? getChatModel(normalized).acceptsImages : false;
}

export function isModelVendor(value: unknown): value is ModelVendor {
  return value === "deepseek" || value === "anthropic" || value === "openai";
}

export function isVendorConfigured(vendor: ModelVendor): boolean {
  return Boolean(process.env[VENDOR_META[vendor].apiKeyEnv]?.trim());
}

export interface PublicChatModel {
  id: ChatModelId;
  vendor: ModelVendor;
  vendorLabel: string;
  label: string;
  description: string;
  acceptsImages: boolean;
  configured: boolean;
  legacy?: boolean;
}

/** What the picker renders: every model, with whether its vendor key is present. */
export function getPublicModelCatalog(): { models: PublicChatModel[]; defaultModel: ChatModelId } {
  const models = CHAT_MODELS.map((entry) => ({
    id: entry.id,
    vendor: entry.vendor,
    vendorLabel: VENDOR_META[entry.vendor].label,
    label: entry.label,
    description: entry.description,
    acceptsImages: entry.acceptsImages,
    configured: isVendorConfigured(entry.vendor),
    legacy: entry.legacy,
  }));
  const preferred = models.find((model) => model.id === DEFAULT_CHAT_MODEL && model.configured);
  const fallback = preferred ?? models.find((model) => model.configured && !model.legacy) ?? models[0];
  return { models, defaultModel: fallback.id };
}
