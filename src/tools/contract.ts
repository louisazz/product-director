/** Permission metadata for a tool. Tool usage guidance lives in its own description. */
export interface ToolContract {
  category: "read" | "search" | "write";
  sideEffect: "none" | "project-state";
  userVisibleEffect: string;
  requiresExplicitUserIntent: boolean;
  confirmationPolicy: "never" | "ask" | "always";
  guidance: string;
}
