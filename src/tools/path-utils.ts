import * as path from "node:path";

export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  relativePath: string
): string | null {
  if (path.isAbsolute(relativePath)) {
    return null;
  }

  if (relativePath.includes("..")) {
    return null;
  }

  const resolved = path.resolve(workspaceRoot, relativePath);

  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    return null;
  }

  return resolved;
}

export function assertInsideWorkspace(
  workspaceRoot: string,
  resolvedPath: string
): boolean {
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedPath = path.resolve(resolvedPath);
  return normalizedPath.startsWith(normalizedRoot + path.sep) || normalizedPath === normalizedRoot;
}

export function safeFileName(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

export function isReadableDocExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".md", ".txt", ".json"].includes(ext);
}

export function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
