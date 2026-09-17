import { buildWorkspaceContext } from "../core/index.js";
import { createRuntime, runRuntime } from "../core/runtime.js";
import { createModelProviderFromSettings } from "../model/index.js";
import type { AgentObserver } from "../core/agent-types.js";

async function main() {
  const workspace = buildWorkspaceContext(process.cwd());
  const runtime = createRuntime(workspace, createModelProviderFromSettings(workspace.settings));
  const input = process.argv.filter((arg) => !arg.startsWith("--")).slice(2).join(" ") || "请查看项目资料，并告诉我你目前能确认什么。";
  const observer: AgentObserver = {
    onAssistantText: (text) => console.log(`[note] ${text}`),
    onToolCall: (call) => console.log(`[tool] ${call.name} ${JSON.stringify(call.input)}`),
    onToolResult: (result) => console.log(`[result] ${result.name} ok=${result.ok}`),
    onFinal: (text) => console.log(`[final]\n${text}`),
  };
  await runRuntime(runtime, input, { observer, maxSteps: 64 });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
