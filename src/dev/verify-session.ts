import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../core/session.js";
import { buildWorkspaceContext } from "../core/workspace.js";
import { assembleContext, pruneToolResultsToFit, sanitizeSessionMessages } from "../core/context-assembler.js";
import type { AgentMessage } from "../core/agent-types.js";
import type { ModelProvider } from "../model/provider.js";
import { createRuntime, runRuntime } from "../core/runtime.js";
import { storeProjectAttachment } from "../core/attachment-store.js";
import { ToolRegistry } from "../tools/index.js";
import { formatAnnotatedUserMessage, handleForkSession, normalizeConversationAnnotations, repairMissingTurnAnswers } from "../web/server.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-session-workspace");
fs.rmSync(root, { recursive: true, force: true });
process.env.PRODUCT_DIRECTOR_WORKSPACE = root;
const workspace = buildWorkspaceContext(process.cwd());
workspace.directorContent = "# Director\n保持清晰。";
const sessionsDir = workspace.paths.sessionsDir;

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}`);
  if (!ok) failures++;
}

try {
  const store = new SessionStore(workspace);
  const session = store.createSession("merge-test", "merge test");
  store.saveSession(session);
  const stopped = store.loadSession(session.id)!;
  const stale = store.loadSession(session.id)!;
  stopped.turns.push({ userContent: "test", events: [], status: "stopped", stoppedAt: new Date().toISOString() });
  store.saveSession(stopped);
  stale.turns.push({ userContent: "test", events: [], status: "running" });
  store.saveSession(stale);
  const restored = store.loadSession(session.id)!;
  check("stale running save cannot undo stop", restored.turns[0]?.status === "stopped");
  check("session schema remains v2", restored.schemaVersion === 2 && restored.revision >= 2);
  const newerContext = store.loadSession(session.id)!;
  const olderContext = store.loadSession(session.id)!;
  newerContext.contextState = { version: 1, summary: "new", compactionCount: 2, updatedAt: "2026-02-02T00:00:00.000Z" };
  store.saveSession(newerContext);
  olderContext.contextState = { version: 1, summary: "old", compactionCount: 1, updatedAt: "2026-01-01T00:00:00.000Z" };
  store.saveSession(olderContext);
  check("stale save cannot undo newer compact state", store.loadSession(session.id)?.contextState?.summary === "new");
  check("atomic write leaves no temp files", fs.readdirSync(sessionsDir).every((name) => !name.endsWith(".tmp")));
  fs.writeFileSync(path.join(sessionsDir, "legacy_evidence.json"), JSON.stringify({ claims: [] }), "utf-8");
  check("legacy evidence excluded from list", store.listSessions().every((item) => item.id !== "legacy_evidence"));

  const missingTurnAnswer = store.createSession("missing-turn-answer", "missing turn answer");
  missingTurnAnswer.messages.push(
    { id: "recover-user", role: "user", content: "分析需求", createdAt: "1" },
    { id: "recover-tool-call", role: "assistant", content: "我先读取资料", toolCalls: [{ id: "recover-call", name: "read", input: { file_path: "docs/a.md" } }], createdAt: "2" },
    { id: "recover-tool-result", role: "tool", name: "read", toolCallId: "recover-call", content: "资料", createdAt: "3" },
    { id: "recover-answer", role: "assistant", content: "已经生成并保存的完整答案", createdAt: "4" },
  );
  missingTurnAnswer.turns.push({ userContent: "分析需求", events: [], status: "stopped" });
  check("durable transcript repairs a missing turn answer",
    repairMissingTurnAnswers(missingTurnAnswer)
    && missingTurnAnswer.turns[0]?.finalAnswer === "已经生成并保存的完整答案"
    && missingTurnAnswer.turns[0]?.status === "completed");

  const annotations = normalizeConversationAnnotations([{
    id: "note-1",
    sourceTurnIndex: 1,
    sourceKind: "answer",
    selectedText: "不要把首页做成数据看板",
    comment: "这里再结合达人路径验证",
    ignoredUiAnchor: 0.4,
  }]);
  const annotatedInput = formatAnnotatedUserMessage("另外看看商家侧", annotations);
  check("annotations become one transparent ordinary user message",
    annotations.length === 1
    && annotatedInput.includes("> 不要把首页做成数据看板")
    && annotatedInput.includes("批注：这里再结合达人路径验证")
    && annotatedInput.includes("[用户补充]\n另外看看商家侧"));

  const legacyAttachmentLabels = store.createSession("legacy-attachment-labels", "旧附件编号");
  const legacyImageA = {
    id: "legacy-image-a",
    fileId: "physical-a",
    name: "image.png",
    mimeType: "image/png",
    size: 1,
    relativePath: "projects/default/files/physical-a/original.png",
    kind: "image" as const,
    label: "图1",
  };
  const legacyImageB = {
    ...legacyImageA,
    id: "legacy-image-b",
    fileId: "physical-b",
    relativePath: "projects/default/files/physical-b/original.png",
  };
  legacyAttachmentLabels.turns.push(
    { userContent: ":attachment[图1]{name=legacy-image-a}", userAttachments: [legacyImageA], events: [], status: "completed" },
    { userContent: ":attachment[图1]{name=legacy-image-b}", userAttachments: [legacyImageB], events: [], status: "completed" },
  );
  store.saveSession(legacyAttachmentLabels);
  const repairedLabels = store.loadSession(legacyAttachmentLabels.id)!;
  check("legacy per-message attachment labels become unique across the Session",
    repairedLabels.turns[0]?.userAttachments?.[0]?.label === "图1"
    && repairedLabels.turns[1]?.userAttachments?.[0]?.label === "图2"
    && repairedLabels.turns[1]?.userContent.includes(":attachment[图2]{name=legacy-image-b}"));

  const branchSource = store.createSession("branch-source", "原会话");
  branchSource.modelProvider = "deepseek-vision";
  const sourceAttachmentDir = path.join(workspace.paths.attachmentsDir, branchSource.id);
  fs.mkdirSync(sourceAttachmentDir, { recursive: true });
  const sourceAttachmentPath = path.join(sourceAttachmentDir, "source.png");
  fs.writeFileSync(sourceAttachmentPath, Buffer.from("branch-image"));
  const sourceAttachment = {
    id: "source-image",
    name: "方案.png",
    mimeType: "image/png" as const,
    size: fs.statSync(sourceAttachmentPath).size,
    relativePath: path.relative(workspace.paths.root, sourceAttachmentPath).replace(/\\/g, "/"),
  };
  branchSource.turns.push(
    { userContent: "第一问", userAttachments: [sourceAttachment], events: [{ type: "done", data: {}, at: "2026-01-01T00:00:00.000Z" }], status: "completed", finalAnswer: "第一答", modelProvider: "deepseek-vision" },
    { userContent: "第二问", events: [{ type: "done", data: {}, at: "2026-01-01T00:01:00.000Z" }], status: "completed", finalAnswer: "第二答", modelProvider: "deepseek-vision" },
    { userContent: "不应进入分支", events: [], status: "completed", finalAnswer: "未来回答", modelProvider: "deepseek-vision" },
  );
  store.saveSession(branchSource);
  const forkedResult = handleForkSession(branchSource.id, 1, workspace.project.id);
  const forked = forkedResult.session ? store.loadSession(forkedResult.session.id) : null;
  const forkedAttachment = forked?.turns[0]?.userAttachments?.[0];
  const forkedAttachmentPath = forkedAttachment ? path.resolve(workspace.paths.root, forkedAttachment.relativePath) : "";
  check("fork creates an independent chat through the selected answer",
    forkedResult.ok
    && forked?.turns.length === 2
    && forked?.messages.length === 4
    && forked?.turns[1]?.finalAnswer === "第二答"
    && !forked?.messages.some((message) => message.content.includes("未来回答"))
    && forked?.modelProvider === "deepseek-vision");
  check("fork shares the same Project file reference",
    Boolean(forkedAttachment)
    && forkedAttachment?.id === sourceAttachment.id
    && forkedAttachment?.relativePath === sourceAttachment.relativePath
    && fs.existsSync(forkedAttachmentPath));
  store.deleteSession(branchSource.id);
  check("fork images survive deletion of the source chat", fs.existsSync(forkedAttachmentPath));

  const runningSource = store.createSession("running-branch-source", "运行中");
  runningSource.turns.push({ userContent: "仍在生成", events: [], status: "running", partialAnswerText: "一半" });
  store.saveSession(runningSource);
  check("a running answer cannot be forked", !handleForkSession(runningSource.id, 0, workspace.project.id).ok);

  const history: AgentMessage[] = [
    { id: "u1", role: "user", content: "问题一", createdAt: "1" },
    { id: "a-tool", role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: { file_path: "docs/a.md" } }], createdAt: "2" },
    { id: "t1-result", role: "tool", name: "read", toolCallId: "t1", content: "x".repeat(1200), createdAt: "3" },
    { id: "a1", role: "assistant", content: "最终回答一", createdAt: "4" },
  ];
  check("tool protocol remains valid", sanitizeSessionMessages(history).length === 4);
  const interruptedParallelTools: AgentMessage[] = [
    { id: "parallel", role: "assistant", content: "", toolCalls: [
      { id: "parallel-1", name: "read", input: { file_path: "a.md" } },
      { id: "parallel-2", name: "read", input: { file_path: "b.md" } },
    ], createdAt: "1" },
    { id: "parallel-result-1", role: "tool", name: "read", toolCallId: "parallel-1", content: "a", createdAt: "2" },
  ];
  const sanitizedInterrupted = sanitizeSessionMessages(interruptedParallelTools);
  check("interrupted parallel tools cannot leave an invalid orphan result", sanitizedInterrupted.every((item) => item.role !== "tool"));
  const manyToolResults: AgentMessage[] = Array.from({ length: 6 }, (_, index) => ({
    id: `tool-${index}`,
    role: "tool" as const,
    name: "read",
    toolCallId: `call-${index}`,
    content: "x".repeat(1200),
    createdAt: String(index),
  }));
  const preserved = pruneToolResultsToFit(manyToolResults, 100_000);
  check("tool outputs remain intact below context pressure", preserved.cleared === 0 && preserved.messages.every((item) => item.content.length === 1200));
  const cleared = pruneToolResultsToFit(manyToolResults, 1_000);
  check("old large tool outputs clear only under context pressure", cleared.cleared >= 1 && cleared.messages.some((item) => item.content.includes("上下文接近容量")));

  fs.mkdirSync(path.join(root, "skills", "review"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: 评审方案\n---\n\n# Review\n\n完整正文不应启动注入。", "utf-8");
  fs.writeFileSync(path.join(workspace.paths.memoryDir, "MEMORY.md"), "# Memory\n\n- `用户偏好.md`：稳定偏好入口。", "utf-8");
  const assembled = assembleContext({ workspace, historyMessages: history, toolNames: ["glob", "grep", "read"] });
  const systemText = assembled.messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
  check("assembler injects only the Memory index", systemText.includes("MEMORY.md — 长期工作语境") && systemText.includes("用户偏好.md"));
  check("base prompt gives the agent independent problem-framing agency",
    systemText.includes("双方对问题的当前理解")
    && systemText.includes("重新定义问题、推翻原题")
    && systemText.includes("保持独立立场和判断的连续性"));
  check("visible Session attachments must not be searched or read again",
    systemText.includes("禁止搜索或重复读取同一文件")
    && systemText.includes("当前对话没有提供过的项目附件不属于你的可见范围"));
  check("assembler loads skill metadata only", systemText.includes("评审方案") && !systemText.includes("完整正文不应启动注入"));
  check("context report exposes composition", assembled.report.toolNames.length === 3 && assembled.report.historyMessages === 4);
  const withActiveSkill = assembleContext({ workspace, toolNames: ["skill"] });
  check("invoked skill body is not statically re-injected every turn", !withActiveSkill.messages.some((item) => item.content.includes("完整正文不应启动注入")));
  check("read source paths are not injected as prompts to re-read", !withActiveSkill.messages.some((item) => item.content.includes("曾使用的资料")));

  const readFiles = Array.from({ length: 6 }, (_, index) => {
    const relativePath = `memory/read-${index}.md`;
    fs.writeFileSync(path.join(workspace.paths.root, relativePath), `UNIQUE-${index}\n${"正文".repeat(600)}`, "utf8");
    return { relativePath };
  });
  let secondRequestKeptAllReads = false;
  let readRound = 0;
  const readRetentionProvider: ModelProvider = {
    name: "read-retention-test",
    contextWindowTokens: 100_000,
    async generate(request) {
      readRound++;
      if (readRound === 1) {
        return {
          content: "",
          toolCalls: Array.from({ length: 6 }, (_, index) => ({
            id: `read-call-${index}`,
            name: "read",
            input: { file_path: readFiles[index].relativePath },
          })),
          stopReason: "tool_call",
        };
      }
      const results = request.messages.filter((item) => item.role === "tool");
      secondRequestKeptAllReads = results.length === 6
        && results.every((item, index) => item.content.includes(`UNIQUE-${index}`));
      return { content: "已完整使用读取结果。", toolCalls: [], stopReason: "final" };
    },
  };
  await runRuntime(createRuntime(workspace, readRetentionProvider), "读取这些文档", { maxSteps: 2 });
  check("normal multi-read turn keeps every tool result for the next model step", secondRequestKeptAllReads);

  const delayedReads = new ToolRegistry();
  delayedReads.register({
    name: "read",
    description: "test read",
    permission: "read",
    contract: { category: "read", sideEffect: "none", userVisibleEffect: "test", requiresExplicitUserIntent: false, confirmationPolicy: "never", guidance: "test" },
    inputSchema: { type: "object" },
    async execute(input) {
      await new Promise((resolve) => setTimeout(resolve, 45));
      return { ok: true, content: String(input.file_path) };
    },
  });
  let parallelRound = 0;
  const parallelProvider: ModelProvider = {
    name: "parallel-read-test",
    contextWindowTokens: 100_000,
    async generate() {
      parallelRound++;
      return parallelRound === 1
        ? { content: "", toolCalls: [
          { id: "parallel-a", name: "read", input: { file_path: "a.md" } },
          { id: "parallel-b", name: "read", input: { file_path: "b.md" } },
        ], stopReason: "tool_call" }
        : { content: "完成", toolCalls: [], stopReason: "final" };
    },
  };
  const parallelStarted = Date.now();
  await runRuntime(createRuntime(workspace, parallelProvider, delayedReads), "并行读取", { maxSteps: 2 });
  check("independent read calls execute concurrently", Date.now() - parallelStarted < 85);

  let duplicateRound = 0;
  let duplicateWasReused = false;
  const duplicatePath = readFiles[0].relativePath;
  const duplicateProvider: ModelProvider = {
    name: "duplicate-read-test",
    contextWindowTokens: 100_000,
    async generate(request) {
      duplicateRound++;
      if (duplicateRound <= 2) return { content: "", toolCalls: [{ id: `duplicate-${duplicateRound}`, name: "read", input: { file_path: duplicatePath } }], stopReason: "tool_call" };
      duplicateWasReused = request.messages.some((item) => item.role === "tool" && item.content.includes("UNCHANGED"));
      return { content: "完成", toolCalls: [], stopReason: "final" };
    },
  };
  await runRuntime(createRuntime(workspace, duplicateProvider), "重复读取", { maxSteps: 3 });
  check("identical read range is reused within one run", duplicateWasReused);

  const abortController = new AbortController();
  let providerSawAbort = false;
  const cancellableProvider: ModelProvider = {
    name: "cancellation-test",
    contextWindowTokens: 100_000,
    async generate(request) {
      return await new Promise((_resolve, reject) => {
        const abort = () => {
          providerSawAbort = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (request.signal?.aborted) return abort();
        request.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const cancelledRun = runRuntime(createRuntime(workspace, cancellableProvider), "开始长任务", { signal: abortController.signal });
  setTimeout(() => abortController.abort(), 5);
  let cancelled = false;
  try { await cancelledRun; } catch (error: any) { cancelled = error?.name === "AbortError"; }
  check("stop signal reaches the active model request", cancelled && providerSawAbort);

  const lengthProvider: ModelProvider = {
    name: "length-test",
    contextWindowTokens: 100_000,
    async generate() {
      return { content: "尚未写完的回答", toolCalls: [], stopReason: "length" };
    },
  };
  const truncated = await runRuntime(createRuntime(workspace, lengthProvider), "生成长回答");
  check("length-limited output is not reported as a normal final", truncated.agentRun.stopReason === "length" && truncated.outputText.includes("可继续生成"));

  const failedProvider: ModelProvider = {
    name: "provider-error-test",
    contextWindowTokens: 100_000,
    async generate() {
      return { content: "provider failed", toolCalls: [], stopReason: "error" };
    },
  };
  let providerErrorRejected = false;
  try { await runRuntime(createRuntime(workspace, failedProvider), "触发错误"); } catch { providerErrorRejected = true; }
  check("provider errors cannot be persisted as completed answers", providerErrorRejected);

  let modelCalls = 0;
  let compactPreservesEpistemicHistory = false;
  const compactProvider: ModelProvider = {
    name: "compact-test",
    contextWindowTokens: 400,
    async generate(request) {
      modelCalls++;
      const compacting = request.messages.some((item) => item.content.includes("压缩成一份供同一个 Agent"));
      if (compacting) {
        const compactText = request.messages.map((item) => item.content).join("\n");
        compactPreservesEpistemicHistory = compactText.includes("仍然并存的解释、矛盾和不确定性")
          && compactText.includes("不要把助手的提案升级成用户立场");
      }
      return { content: compacting ? "保留目标、决定与未完成事项。" : "继续完成。", toolCalls: [], stopReason: "final" };
    },
  };
  const longHistory: AgentMessage[] = [
    { id: "old-user", role: "user", content: "旧目标".repeat(500), createdAt: "1" },
    { id: "old-answer", role: "assistant", content: "旧回答".repeat(500), createdAt: "2" },
  ];
  const compacted = await runRuntime(createRuntime(workspace, compactProvider), "继续处理", { historyMessages: longHistory, maxSteps: 1 });
  check("long session auto compacts near provider capacity", compacted.contextState.compactionCount === 1 && compacted.contextState.compactedThroughMessageId === "old-answer");
  check("compact preserves corrections, disagreement and provisional interpretations", compactPreservesEpistemicHistory);
  check("successful compact clears stale prompt usage to prevent premature re-compaction", compacted.contextState.lastPromptTokens === undefined);
  check("compaction summary is reinjected for continued work", compacted.agentRun.steps[0]?.inputMessages.some((item) => item.content.includes("保留目标、决定与未完成事项")) === true);
  check("compaction summary is reinjected as a lossy and revisable handoff",
    compacted.agentRun.steps[0]?.inputMessages.some((item) => item.content.includes("有损摘要") && item.content.includes("不是不可修正的事实记录")) === true);
  const callsAfterFirstCompact = modelCalls;
  await runRuntime(createRuntime(workspace, compactProvider), "再继续", { historyMessages: longHistory, contextState: compacted.contextState, maxSteps: 1 });
  check("fresh compact summary does not thrash", modelCalls === callsAfterFirstCompact + 1);

  const emptyCompactProvider: ModelProvider = {
    name: "empty-compact-test",
    contextWindowTokens: 400,
    async generate() {
      return { content: "", toolCalls: [], stopReason: "final" };
    },
  };
  let emptyCompactRejected = false;
  try {
    await runRuntime(createRuntime(workspace, emptyCompactProvider), "继续", { historyMessages: longHistory });
  } catch {
    emptyCompactRejected = true;
  }
  check("failed compact cannot advance the history boundary", emptyCompactRejected);

  const thirtyTurns: AgentMessage[] = Array.from({ length: 60 }, (_, index) => ({
    id: `long-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `${index % 2 === 0 ? "用户补充" : "阶段回答"}${String(index).padStart(2, "0")}`.repeat(80),
    createdAt: String(index),
  }));
  const firstLongCompact = await runRuntime(createRuntime(workspace, compactProvider), "继续长期任务", { historyMessages: thirtyTurns, maxSteps: 1 });
  const nextTail: AgentMessage[] = [
    ...thirtyTurns,
    { id: "tail-user", role: "user", content: "新的重要约束".repeat(500), createdAt: "61" },
    { id: "tail-answer", role: "assistant", content: "继续分析结果".repeat(500), createdAt: "62" },
  ];
  const secondLongCompact = await runRuntime(createRuntime(workspace, compactProvider), "继续长期任务", { historyMessages: nextTail, contextState: firstLongCompact.contextState, maxSteps: 1 });
  check("30-turn session can compact repeatedly without moving", firstLongCompact.contextState.compactionCount === 1 && secondLongCompact.contextState.compactionCount === 2 && secondLongCompact.contextState.compactedThroughMessageId === "tail-answer");

  const hundredTurns: AgentMessage[] = Array.from({ length: 200 }, (_, index) => ({
    id: `stress-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `${index % 2 === 0 ? "长期补充" : "长期回答"}${index}`.repeat(50),
    createdAt: String(index),
  }));
  const hundredTurnRun = await runRuntime(createRuntime(workspace, compactProvider), "继续一百轮会话", { historyMessages: hundredTurns });
  check("100-turn conversation compacts and remains resumable", hundredTurnRun.contextState.compactionCount === 1 && hundredTurnRun.contextState.compactedThroughMessageId === "stress-199" && hundredTurnRun.agentRun.stopReason === "final");

  const manual = await runRuntime(createRuntime(workspace, compactProvider), "/compact 只保留设计决定", { historyMessages: history });
  check("manual compact command persists an exact boundary", manual.contextState.compactionCount === 1 && manual.contextState.compactedThroughMessageId === "a1" && manual.outputText.includes("会话已压缩"));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
