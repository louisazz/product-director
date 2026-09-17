import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "./config.js";
import { PROJECT_STATUSES, type DirectorSettings, type ProjectStatus, type WorkspacePaths, type WorkspaceContext } from "./types.js";
import { migrateLegacySessionStorage } from "./attachment-store.js";

export const DEFAULT_PROJECT_ID = "default";

// Derive project source root from this module's file path.
// workspace.ts lives at: <project>/src/core/workspace.ts (dev) or <project>/dist/core/workspace.js (build)
// Going up 3 levels from the file always lands at the project root.
function getProjectRoot(): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // core → src(or dist) → project root
    return path.dirname(path.dirname(path.dirname(thisFile)));
  } catch {
    return null;
  }
}
export function resolveWorkspace(cwd: string, requestedProjectId: string = DEFAULT_PROJECT_ID): WorkspacePaths {
  const envWorkspace = process.env.PRODUCT_DIRECTOR_WORKSPACE;

  let root: string;
  if (envWorkspace) {
    root = path.resolve(envWorkspace);
  } else {
    // Default: keep code and private data under one visible project root.
    const projectRoot = getProjectRoot();
    if (projectRoot) {
      root = path.resolve(projectRoot, "workspace");
    } else {
      // Last resort: cwd/workspace (shouldn't happen normally)
      root = path.join(cwd, "workspace");
    }
  }
  const projectId = safeProjectId(requestedProjectId);
  const runtimeDir = path.join(root, ".runtime");
  const attachmentsRoot = path.join(runtimeDir, "attachments");
  const indexesDir = path.join(runtimeDir, "indexes");
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, projectId);
  return {
    root,
    directorMd: path.join(root, "DIRECTOR.md"),
    settings: path.join(root, "settings.json"),
    memoryDir: path.join(root, "memory"),
    skillsDir: path.join(root, "skills"),
    projectsDir,
    projectDir,
    projectMeta: path.join(projectDir, "project.json"),
    projectDocsDir: path.join(projectDir, "docs"),
    projectDesignDir: path.join(projectDir, "design"),
    projectFilesDir: path.join(projectDir, "files"),
    runtimeDir,
    sessionsRoot: path.join(runtimeDir, "sessions"),
    sessionsDir: path.join(projectDir, "sessions"),
    progressDir: path.join(runtimeDir, "progress"),
    projectProgress: path.join(runtimeDir, "progress", `${projectId}.json`),
    indexesDir,
    memoryDocsIndex: path.join(indexesDir, "memory.json"),
    projectDocsIndex: path.join(indexesDir, "projects", `${projectId}.json`),
    modelCacheDir: path.join(runtimeDir, "model-cache"),
    attachmentsRoot,
    attachmentsDir: path.join(attachmentsRoot, projectId),
    legacySessionsDir: path.join(runtimeDir, "sessions", projectId),
    legacyAttachmentsDir: path.join(attachmentsRoot, projectId),
  };
}

export function ensureWorkspace(cwd: string, projectId: string = DEFAULT_PROJECT_ID): WorkspacePaths {
  const paths = resolveWorkspace(cwd, projectId);

  // Ensure directories exist
  ensureDir(paths.root);
  ensureDir(paths.memoryDir);
  ensureDir(paths.skillsDir);
  ensureDir(paths.projectFilesDir);
  ensureDir(paths.sessionsDir);
  ensureDir(paths.progressDir);
  ensureDir(path.dirname(paths.projectDocsIndex));
  ensureDir(paths.modelCacheDir);
  migrateLegacySessionStorage(paths);

  // Ensure settings.json exists (needed by loadSettings)
  if (!fs.existsSync(paths.settings)) {
    fs.writeFileSync(paths.settings, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n", "utf-8");
  }

  if (!fs.existsSync(paths.projectMeta)) {
    const now = new Date().toISOString();
    fs.writeFileSync(paths.projectMeta, JSON.stringify({
      id: safeProjectId(projectId),
      name: safeProjectId(projectId) === DEFAULT_PROJECT_ID ? "默认项目" : projectId,
      month: formatProjectMonth(new Date()),
      createdAt: now,
      updatedAt: now,
    }, null, 2) + "\n", "utf-8");
  }

  return paths;
}

export function loadSettings(paths: WorkspacePaths): DirectorSettings | null {
  try {
    const raw = fs.readFileSync(paths.settings, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      permissions: { ...DEFAULT_SETTINGS.permissions, ...(parsed.permissions || {}) },
    };
  } catch {
    return null;
  }
}

export function loadDirectorContext(paths: WorkspacePaths): string | null {
  try {
    return fs.readFileSync(paths.directorMd, "utf-8");
  } catch {
    return null;
  }
}

export function buildWorkspaceContext(cwd: string, projectId: string = DEFAULT_PROJECT_ID): WorkspaceContext {
  const paths = ensureWorkspace(cwd, projectId);
  const settings = loadSettings(paths);
  const directorContent = loadDirectorContext(paths);
  const project = loadProject(paths);
  return { paths, project, settings, directorContent };
}

export function listProjects(cwd: string) {
  const base = ensureWorkspace(cwd, DEFAULT_PROJECT_ID);
  const projects = fs.readdirSync(base.projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        const context = buildWorkspaceContext(cwd, entry.name);
        return [context.project];
      } catch {
        return [];
      }
    });
  return projects.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function createProject(cwd: string, name: string, description?: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("项目名称不能为空。");
  const baseId = safeProjectId(trimmed.toLowerCase()) || `project-${Date.now()}`;
  const existing = new Set(listProjects(cwd).map((item) => item.id));
  let id = baseId;
  let counter = 2;
  while (existing.has(id)) id = `${baseId}-${counter++}`;
  const paths = ensureWorkspace(cwd, id);
  const now = new Date().toISOString();
  const project = {
    id,
    name: trimmed.slice(0, 80),
    description: description?.trim().slice(0, 500) || undefined,
    month: formatProjectMonth(new Date()),
    status: "待启动" as ProjectStatus,
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(paths.projectMeta, JSON.stringify(project, null, 2) + "\n", "utf-8");
  return project;
}

export function updateProject(cwd: string, projectId: string, name: string, description?: string, status?: ProjectStatus) {
  const id = safeProjectId(projectId);
  const trimmed = name.trim();
  if (!trimmed) throw new Error("项目名称不能为空。");
  const paths = resolveWorkspace(cwd, id);
  if (!fs.existsSync(paths.projectDir) || !fs.existsSync(paths.projectMeta)) {
    throw new Error(`项目“${projectId}”不存在。`);
  }
  const current = loadProject(paths);
  if (status !== undefined && !PROJECT_STATUSES.includes(status)) throw new Error("无效的项目状态。");
  const project = {
    ...current,
    id,
    name: trimmed.slice(0, 80),
    description: description?.trim().slice(0, 500) || undefined,
    status: status ?? current.status,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(paths.projectMeta, project);
  return project;
}

export function deleteProject(cwd: string, projectId: string): void {
  const id = safeProjectId(projectId);
  if (id === DEFAULT_PROJECT_ID) throw new Error("默认项目不能删除。");
  const paths = resolveWorkspace(cwd, id);
  if (!fs.existsSync(paths.projectDir)) throw new Error(`项目“${projectId}”不存在。`);

  const targets = [paths.projectDir, paths.projectProgress, paths.projectDocsIndex, paths.legacySessionsDir, paths.legacyAttachmentsDir];
  const allowedRoots = [paths.projectsDir, paths.progressDir, path.dirname(paths.projectDocsIndex), paths.sessionsRoot, paths.attachmentsRoot];
  targets.forEach((target, index) => {
    const resolvedTarget = path.resolve(target);
    const resolvedRoot = path.resolve(allowedRoots[index]);
    if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`拒绝删除越界路径：${target}`);
    }
  });
  for (const target of targets) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

function loadProject(paths: WorkspacePaths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.projectMeta, "utf-8"));
    const now = new Date().toISOString();
    const createdAt = String(parsed.createdAt || now);
    return {
      id: safeProjectId(parsed.id || path.basename(paths.projectDir)),
      name: String(parsed.name || path.basename(paths.projectDir)),
      description: parsed.description ? String(parsed.description) : undefined,
      month: normalizeProjectMonth(parsed.month) || formatProjectMonth(new Date(createdAt)),
      status: normalizeProjectStatus(parsed.status),
      createdAt,
      updatedAt: String(parsed.updatedAt || parsed.createdAt || now),
    };
  } catch {
    const now = new Date().toISOString();
    const id = safeProjectId(path.basename(paths.projectDir));
    return { id, name: id === DEFAULT_PROJECT_ID ? "默认项目" : id, month: formatProjectMonth(new Date()), createdAt: now, updatedAt: now };
  }
}

function normalizeProjectMonth(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : undefined;
}

function normalizeProjectStatus(value: unknown): ProjectStatus | undefined {
  return typeof value === "string" && PROJECT_STATUSES.includes(value as ProjectStatus) ? value as ProjectStatus : undefined;
}

function formatProjectMonth(value: Date): string {
  if (!Number.isFinite(value.getTime())) value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tempPath, filePath);
}

export function safeProjectId(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || DEFAULT_PROJECT_ID;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

