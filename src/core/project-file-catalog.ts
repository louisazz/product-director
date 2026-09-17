import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceContext } from "./types.js";
import { listStoredProjectFiles, type StoredProjectFile } from "./attachment-store.js";

export const PROJECT_FILE_HANDLE_PREFIX = "project-file:";

export interface ProjectFileCatalogItem extends StoredProjectFile {
  handle: string;
  sourcePath: string;
  readable: boolean;
}

export function listProjectFileCatalog(workspace: WorkspaceContext): ProjectFileCatalogItem[] {
  return listStoredProjectFiles(workspace).map((file) => {
    const sourcePath = file.mimeType === "application/pdf"
      ? path.join(path.dirname(file.originalPath), "text.json")
      : file.originalPath;
    return {
      ...file,
      handle: `${PROJECT_FILE_HANDLE_PREFIX}${file.fileId}`,
      sourcePath,
      readable: file.mimeType === "application/pdf" || file.mimeType === "text/plain" || file.mimeType === "text/markdown",
    };
  });
}

export function resolveProjectFileHandle(
  workspace: WorkspaceContext,
  value: unknown,
): ProjectFileCatalogItem | null {
  const input = String(value || "").trim();
  if (!input.startsWith(PROJECT_FILE_HANDLE_PREFIX)) return null;
  const fileId = input.slice(PROJECT_FILE_HANDLE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/i.test(fileId)) return null;
  return listProjectFileCatalog(workspace).find((file) => file.fileId === fileId) || null;
}

export function readProjectFileText(file: ProjectFileCatalogItem): string | null {
  if (!file.readable) return null;
  if (file.mimeType !== "application/pdf") {
    try { return fs.readFileSync(file.sourcePath, "utf8"); } catch { return null; }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file.sourcePath, "utf8"));
    if (!Array.isArray(parsed.pages)) return null;
    return parsed.pages.map((page: any) => {
      const pageNumber = Number(page?.page) || 0;
      const text = String(page?.text || "").trim();
      return `[第${pageNumber}页]\n${text || "（这一页没有提取到可搜索文字）"}`;
    }).join("\n\n");
  } catch {
    return null;
  }
}

export function describeProjectFile(file: ProjectFileCatalogItem): string {
  const type = file.mimeType === "application/pdf"
    ? `PDF${file.pageCount ? `，${file.pageCount} 页` : ""}`
    : file.mimeType.startsWith("image/")
      ? "图片"
      : file.mimeType === "text/markdown"
        ? "Markdown"
        : file.mimeType === "text/plain"
          ? "文本"
          : file.mimeType;
  return `${file.name}  [${file.handle}]  （${type}${file.readable ? "，可读取" : "，需作为附件查看"}）`;
}
