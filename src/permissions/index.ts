import type { DirectorSettings } from "../core/types.js";
import { DEFAULT_SETTINGS } from "../core/config.js";
import type { Tool } from "../tools/index.js";

export type ToolPermission =
  | "read"
  | "directorUpdate"
  | "delete"
  | "externalAction";

export type PermissionLevel = "allow" | "ask" | "deny";

export interface PermissionDecision {
  level: PermissionLevel;
  category: ToolPermission;
  allowed: boolean;
  requiresConfirmation: boolean;
  reason: string;
}

export interface ConfirmationRequest {
  toolName: string;
  permission: ToolPermission;
  input: Record<string, unknown>;
  reason: string;
}

export interface ConfirmationProvider {
  confirm(request: ConfirmationRequest): Promise<boolean>;
}

export class AutoDenyConfirmationProvider implements ConfirmationProvider {
  async confirm(_request: ConfirmationRequest): Promise<boolean> {
    return false;
  }
}

export class PermissionManager {
  private settings: DirectorSettings;
  private confirmationProvider: ConfirmationProvider;

  constructor(settings: DirectorSettings, confirmationProvider: ConfirmationProvider) {
    this.settings = settings;
    this.confirmationProvider = confirmationProvider;
  }

  check(tool: Tool, _input: Record<string, unknown>): PermissionDecision {
    const category = tool.permission;
    let level = this.settings.permissions[category] ?? "deny";

    // Overlay ToolContract.confirmationPolicy (runtime-level enforcement)
    // Deny always wins — contract cannot override a deny.
    if (level !== "deny") {
      const cp = tool.contract.confirmationPolicy;
      if (cp === "always") {
        level = "ask";
      } else if (cp === "ask" && level === "allow") {
        level = "ask";
      }
      // cp === "never": keep settings level as-is
    }

    let allowed: boolean;
    let requiresConfirmation: boolean;
    let reason: string;

    switch (level) {
      case "allow":
        allowed = true;
        requiresConfirmation = false;
        reason = `Permission "${category}" is allow.`;
        break;
      case "ask":
        allowed = false;
        requiresConfirmation = true;
        reason = `Permission "${category}" requires user confirmation.`;
        break;
      case "deny":
        allowed = false;
        requiresConfirmation = false;
        reason = `Permission "${category}" is denied.`;
        break;
    }

    return { level, category, allowed, requiresConfirmation, reason };
  }

  async confirmIfNeeded(decision: PermissionDecision, request: ConfirmationRequest): Promise<boolean> {
    if (!decision.requiresConfirmation) {
      return decision.allowed;
    }
    return this.confirmationProvider.confirm(request);
  }
}

export function createPermissionManagerFromSettings(
  settings: DirectorSettings | null,
  confirmationProvider?: ConfirmationProvider
): PermissionManager {
  return new PermissionManager(
    settings ?? DEFAULT_SETTINGS,
    confirmationProvider ?? new AutoDenyConfirmationProvider()
  );
}
