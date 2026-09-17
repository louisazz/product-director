import type { DirectorSettings } from "./types.js";

export const DEFAULT_SETTINGS: DirectorSettings = {
  version: 1,
  modelProvider: "deepseek-v4.1-flash",
  model: "deepseek-flash",
  reasoningEffort: "high",
  permissions: {
    read: "allow",
    directorUpdate: "ask",
    delete: "deny",
    externalAction: "deny",
  },
};
