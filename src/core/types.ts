export interface DirectorSettings {
  version: number;
  modelProvider: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  permissions: {
    read: PermissionLevel;
    directorUpdate: PermissionLevel;
    delete: PermissionLevel;
    externalAction: PermissionLevel;
  };
}

export type PermissionLevel = "allow" | "ask" | "deny";

export interface WorkspacePaths {
  root: string;
  directorMd: string;
  settings: string;
  memoryDir: string;
  skillsDir: string;
  projectsDir: string;
  projectDir: string;
  projectMeta: string;
  projectDocsDir: string;
  projectDesignDir: string;
  projectFilesDir: string;
  runtimeDir: string;
  sessionsRoot: string;
  sessionsDir: string;
  progressDir: string;
  projectProgress: string;
  indexesDir: string;
  memoryDocsIndex: string;
  projectDocsIndex: string;
  modelCacheDir: string;
  attachmentsRoot: string;
  attachmentsDir: string;
  legacySessionsDir: string;
  legacyAttachmentsDir: string;
}

export interface WorkspaceContext {
  paths: WorkspacePaths;
  project: ProjectDefinition;
  settings: DirectorSettings | null;
  directorContent: string | null;
}

export interface ProjectDefinition {
  id: string;
  name: string;
  description?: string;
  month: string;
  status?: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_STATUSES = [
  "产品规划中",
  "待启动",
  "讨论中",
  "待方案排期",
  "方案打磨中",
  "方案定稿待开发",
  "开发中",
  "走查中",
  "近期上线",
  "上线归档",
  "hold",
] as const;

export type ProjectStatus = typeof PROJECT_STATUSES[number];

export interface CliOutput {
  userInput: string;
  workspace: WorkspaceContext;
}
