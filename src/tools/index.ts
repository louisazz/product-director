import type { ToolDefinition, ToolResult } from "../core/agent-types.js";
import type { WorkspaceContext } from "../core/types.js";
import type { ToolPermission } from "../permissions/index.js";
import type { ToolContract } from "./contract.js";

export interface ToolExecutionContext {
  workspace: WorkspaceContext;
  currentUserInput?: string;
  sessionId?: string;
  turnIndex?: number;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  error?: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly permission: ToolPermission;
  readonly contract: ToolContract;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}

export function toolCallToToolResult(
  tc: { id: string; name: string; input: Record<string, unknown> },
  execResult: ToolExecutionResult
): ToolResult {
  return {
    toolCallId: tc.id,
    name: tc.name,
    ok: execResult.ok,
    content: execResult.content,
    error: execResult.error,
  };
}
