import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceContext } from "../core/types.js";
import { assertInsideWorkspace, isReadableDocExtension } from "../tools/path-utils.js";

export interface SkillDefinition {
  id: string;
  path: string;
  title: string;
  description?: string;
}

export interface SkillIndex {
  generatedAt: string;
  skills: SkillDefinition[];
}

/**
 * Claude Code compatible layout:
 *   skills/<name>/SKILL.md  (preferred)
 *   skills/<name>.md        (legacy compatibility)
 * Only metadata is included in the startup catalog. The body is loaded on use.
 */
export function buildSkillIndex(workspace: WorkspaceContext): SkillIndex {
  const dir = workspace.paths.skillsDir;
  const skills: SkillDefinition[] = [];
  if (!fs.existsSync(dir)) return { generatedAt: new Date().toISOString(), skills };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    let filePath: string | undefined;
    let defaultId = entry.name;
    if (entry.isDirectory()) {
      const candidate = path.join(dir, entry.name, "SKILL.md");
      if (fs.existsSync(candidate)) filePath = candidate;
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name !== ".gitkeep") {
      filePath = path.join(dir, entry.name);
      defaultId = entry.name.slice(0, -3);
    }
    if (!filePath) continue;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      if (!raw.trim()) continue;
      skills.push(parseSkill(defaultId, workspace.paths.root, filePath, raw));
    } catch {
      // A broken skill should not hide the rest of the catalog.
    }
  }

  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { generatedAt: new Date().toISOString(), skills };
}

function parseSkill(defaultId: string, root: string, filePath: string, raw: string): SkillDefinition {
  const frontmatter = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const metadata = new Map<string, string>();
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([\w-]+):\s*(.+)$/);
      if (match) metadata.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ""));
    }
  }
  const body = frontmatter ? raw.slice(frontmatter[0].length) : raw;
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstParagraph = body
    .replace(/^#{1,6}\s+.*$/gm, "")
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return {
    id: metadata.get("name") || metadata.get("id") || defaultId,
    path: path.relative(root, filePath).replace(/\\/g, "/"),
    title: metadata.get("title") || heading || defaultId,
    description: (metadata.get("description") || firstParagraph || "").slice(0, 240) || undefined,
  };
}

export function buildSkillBrief(workspace: WorkspaceContext): string {
  const skills = buildSkillIndex(workspace).skills;
  if (skills.length === 0) return "(当前没有可用 Skill)";
  return skills.map((skill) =>
    `- ${skill.id}: ${skill.description || skill.title}`
  ).join("\n");
}

export function resolveSkillPath(workspace: WorkspaceContext, skillIdOrPath: string): string | null {
  const direct = path.resolve(workspace.paths.root, skillIdOrPath);
  if (assertInsideWorkspace(workspace.paths.skillsDir, direct) && fs.existsSync(direct) && fs.statSync(direct).isFile()) {
    return direct;
  }
  const found = buildSkillIndex(workspace).skills.find((skill) => skill.id === skillIdOrPath);
  if (!found) return null;
  const resolved = path.resolve(workspace.paths.root, found.path);
  return assertInsideWorkspace(workspace.paths.skillsDir, resolved) ? resolved : null;
}

export function loadSkillContent(workspace: WorkspaceContext, skillIdOrPath: string): string | null {
  const filePath = resolveSkillPath(workspace, skillIdOrPath);
  if (!filePath || !isReadableDocExtension(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
