import { createHash } from "node:crypto";
import type { ConfirmationProvider, ConfirmationRequest } from "../permissions/index.js";

export class WebConfirmationRequiredError extends Error {
  public confirmationId: string;
  public toolName: string;
  public category: string;
  public inputPreview: string;
  public rawInput: Record<string, unknown>;
  public toolCallId?: string;
  public pendingNewMessages?: Array<{ id: string; role: string; content: string; createdAt: string; toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>; toolCallId?: string; name?: string }>;

  constructor(
    confirmationId: string,
    toolName: string,
    category: string,
    inputPreview: string,
    rawInput: Record<string, unknown>,
  ) {
    super(`Confirmation required for "${toolName}" (${category})`);
    this.name = "WebConfirmationRequiredError";
    this.confirmationId = confirmationId;
    this.toolName = toolName;
    this.category = category;
    this.inputPreview = inputPreview.slice(0, 500);
    this.rawInput = rawInput;
  }
}

/**
 * WebConfirmationProvider doesn't block waiting for user input.
 * If an approvedConfirmationId is provided, it auto-allows matching confirmations.
 * Otherwise it throws WebConfirmationRequiredError, which the chat handler
 * catches and returns to the browser as a "needsConfirmation" response.
 */
export class WebConfirmationProvider implements ConfirmationProvider {
  private approvedConfirmationId?: string;

  constructor(options?: { approvedConfirmationId?: string }) {
    this.approvedConfirmationId = options?.approvedConfirmationId;
  }

  async confirm(request: ConfirmationRequest): Promise<boolean> {
    const id = makeConfirmationId(request.toolName, request.permission, request.input);

    if (this.approvedConfirmationId && id === this.approvedConfirmationId) {
      return true;
    }

    throw new WebConfirmationRequiredError(
      id,
      request.toolName,
      request.permission,
      JSON.stringify(request.input, null, 2),
      request.input ?? {},
    );
  }
}

function makeConfirmationId(
  toolName: string,
  category: string,
  input: Record<string, unknown>,
): string {
  const payload = `${toolName}|${category}|${JSON.stringify(input ?? {})}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
