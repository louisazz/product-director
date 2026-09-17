import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceContext, createProject, deleteProject, listProjects, updateProject } from "../core/workspace.js";
import { storeProjectAttachment } from "../core/attachment-store.js";
import { SessionStore } from "../core/session.js";
import { generateProjectProgress, loadProjectProgress } from "../core/project-progress.js";
import { createDefaultToolRegistry } from "../tools/builtins.js";
import type { ModelProvider } from "../model/provider.js";
import { handleListProjectFiles } from "../web/server.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-projects-workspace");
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}`);
  if (!ok) failures++;
};

try {
  fs.rmSync(root, { recursive: true, force: true });
  process.env.PRODUCT_DIRECTOR_WORKSPACE = root;
  const first = buildWorkspaceContext(process.cwd(), "default");
  const secondProject = createProject(process.cwd(), "另一个项目");
  check("new projects enter the current month as pending start", /^\d{4}-\d{2}$/.test(secondProject.month) && secondProject.status === "待启动");
  const second = buildWorkspaceContext(process.cwd(), secondProject.id);
  const firstFile = await storeProjectAttachment(first, { name: "first.md", mimeType: "text/markdown", bytes: Buffer.from("默认项目资料") });
  const secondFile = await storeProjectAttachment(second, { name: "second.md", mimeType: "text/markdown", bytes: Buffer.from("另一个项目资料") });

  check("project catalog includes both projects", listProjects(process.cwd()).length === 2);
  const firstStore = new SessionStore(first);
  const secondStore = new SessionStore(second);
  const session = firstStore.createSession("same-id", "默认项目会话");
  session.turns.push({ userContent: "做到哪里", events: [], status: "completed", finalAnswer: "完成了资料整理" });
  firstStore.saveSession(session);
  secondStore.saveSession(secondStore.createSession("same-id", "另一个项目会话"));
  check("sessions are isolated by project", firstStore.loadSession("same-id")?.title !== secondStore.loadSession("same-id")?.title);

  const registry = createDefaultToolRegistry();
  const glob = registry.get("glob")!;
  const visible = await glob.execute({ pattern: "**/*.md" }, { workspace: first });
  const hidden = await glob.execute({ pattern: "**/*.md", path: `projects/${second.project.id}/files` }, { workspace: first });
  check("current project attachments stay outside ordinary search", visible.ok && !visible.content.includes(firstFile.fileId!));
  check("other project files are rejected", !hidden.ok && !visible.content.includes("second.md"));

  let progressPrompt = "";
  const progressProvider: ModelProvider = {
    name: "progress-contract-test",
    async generate(request) {
      progressPrompt = request.messages.map((item) => item.content).join("\n");
      return { content: "当前进度快照", toolCalls: [], stopReason: "final" };
    },
  };
  const progress = await generateProjectProgress(first, progressProvider);
  check("progress is persisted outside chat sessions", Boolean(progress.content) && loadProjectProgress(first)?.coveredSessions.length === 1);
  check("progress does not create a chat session", firstStore.listSessions().length === 1);
  check("project progress is framed as a revisable snapshot rather than a canonical narrative",
    progressPrompt.includes("可重新生成的当前快照")
    && progressPrompt.includes("不要为了维持叙事连续性而保留过时判断")
    && progressPrompt.includes("助手的阶段性建议"));

  const inProgress = updateProject(process.cwd(), secondProject.id, secondProject.name, secondProject.description, "方案打磨中");
  check("project status is persisted independently from progress snapshots", inProgress.status === "方案打磨中");
  const renamed = updateProject(process.cwd(), secondProject.id, "重命名后的项目", "测试说明");
  check("project rename keeps stable id and lifecycle metadata", renamed.id === secondProject.id && renamed.name === "重命名后的项目" && renamed.status === "方案打磨中" && renamed.month === secondProject.month);
  check("project rename keeps project files", fs.existsSync(path.resolve(second.paths.root, secondFile.relativePath!)));
  check("project files page lists passive attachment storage", handleListProjectFiles(secondProject.id).files.some((file) => file.fileId === secondFile.fileId));

  deleteProject(process.cwd(), secondProject.id);
  check("project deletion removes project files", !fs.existsSync(second.paths.projectDir));
  check("project deletion removes sessions", !fs.existsSync(second.paths.sessionsDir));
  check("project deletion keeps default project", listProjects(process.cwd()).some((item) => item.id === "default"));
  let defaultDeleteBlocked = false;
  try { deleteProject(process.cwd(), "default"); } catch { defaultDeleteBlocked = true; }
  check("default project deletion is blocked", defaultDeleteBlocked);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
