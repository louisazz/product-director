import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "./index.js";
import { ToolRegistry } from "./index.js";
import type { ToolContract } from "./contract.js";
import { assertInsideWorkspace, isReadableDocExtension } from "./path-utils.js";
import { buildSkillIndex, loadSkillContent, resolveSkillPath } from "../skills/index.js";
import { buildMemoryDocsIndex, loadMemoryDocsIndex, memoryIndexNeedsRebuild, semanticSearch, extractTerms } from "../core/docs-index.js";
import type { WorkspaceContext } from "../core/types.js";
import { setCacheDir } from "../model/local-embedder.js";

/**
 * How much of a matched chunk semantic_search echoes back. Chunks break at
 * markdown headings, so a section arrives as one chunk and the closing lines
 * carry its scope limits and dissenting positions. Sized above the observed
 * section length so those lines survive.
 */
const SEARCH_EXCERPT_CHARS = 600;

const READ_CONTRACT: ToolContract = {
  category: "read",
  sideEffect: "none",
  userVisibleEffect: "读取本地工作区资料",
  requiresExplicitUserIntent: false,
  confirmationPolicy: "never",
  guidance: "按需读取，不修改任何文件。",
};

const SEARCH_CONTRACT: ToolContract = {
  ...READ_CONTRACT,
  category: "search",
  userVisibleEffect: "在本地工作区中查找资料",
};

function resolvePath(root: string, input: unknown): string | null {
  const value = String(input || ".");
  if (path.isAbsolute(value) || value.includes("..")) return null;
  const resolved = path.resolve(root, value);
  return assertInsideWorkspace(root, resolved) ? resolved : null;
}

function searchableRoots(workspace: WorkspaceContext): string[] {
  return [workspace.paths.memoryDir];
}

function isInsideAny(roots: string[], target: string): boolean {
  return roots.some((root) => assertInsideWorkspace(root, target));
}

function resolveSearchTargets(workspace: WorkspaceContext, input: unknown): string[] | null {
  const value = String(input || ".");
  if (value === "." || value === "") return searchableRoots(workspace);
  const target = resolvePath(workspace.paths.root, value);
  if (!target || !isInsideAny(searchableRoots(workspace), target)) return null;
  return [target];
}

function resolveReadablePath(workspace: WorkspaceContext, input: unknown): string | null {
  const target = resolvePath(workspace.paths.root, input);
  if (!target) return null;
  const allowed = [...searchableRoots(workspace), workspace.paths.skillsDir];
  if (target === workspace.paths.directorMd || isInsideAny(allowed, target)) return target;
  return null;
}

function relative(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function collectFiles(dir: string, root: string, result: string[] = []): string[] {
  if (!fs.existsSync(dir)) return result;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    result.push(relative(root, dir));
    return result;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "sessions") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, root, result);
    else if (entry.isFile() && !["docs-index.json", "preprocessed-evidence.json", "meta.json", ".gitkeep", ".DS_Store"].includes(entry.name)) result.push(relative(root, full));
  }
  return result;
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index++;
      if (normalized[index + 1] === "/") {
        index++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

const globTool: Tool = {
  name: "glob",
  description: "按文件名模式查找通用 Memory 文件。支持 **、* 和 ?，返回最多 100 个路径；结果截断时会明确提示。项目附件不参与搜索。",
  permission: "read",
  contract: SEARCH_CONTRACT,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob 模式，例如 **/*.md 或 memory/**" },
      path: { type: "string", description: "可选的工作区相对目录，默认工作区根目录" },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = String(input.pattern || "");
    if (!pattern) return { ok: false, content: "", error: "Missing required parameter: pattern" };
    const bases = resolveSearchTargets(context.workspace, input.path);
    if (!bases) return { ok: false, content: "", error: "Path is outside the current project's readable knowledge scope." };
    const matcher = globRegex(pattern);
    const files = bases.flatMap((base) => collectFiles(base, context.workspace.paths.root))
      .filter((file) => {
        const absolute = path.resolve(context.workspace.paths.root, file);
        return matcher.test(file) || bases.some((base) => matcher.test(relative(base, absolute)));
      })
      .map((file) => ({ file, mtime: fs.statSync(path.resolve(context.workspace.paths.root, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const shown = files.slice(0, 100).map((item) => item.file);
    if (shown.length === 0) return { ok: true, content: "No files found." };
    return {
      ok: true,
      content: `${shown.join("\n")}${files.length > shown.length ? `\n\n[PARTIAL: showing 100 of ${files.length} files. Narrow the pattern to continue.]` : ""}`,
    };
  },
};

const grepTool: Tool = {
  name: "grep",
  description: "用正则表达式搜索通用 Memory，默认返回匹配文件；可返回带行号内容或计数。项目附件不参与搜索。",
  permission: "read",
  contract: SEARCH_CONTRACT,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      path: { type: "string", description: "可选的文件或目录，默认工作区根目录" },
      glob: { type: "string", description: "可选文件过滤，例如 *.md 或 docs/**/*.txt" },
      output_mode: { type: "string", enum: ["files_with_matches", "content", "count"], description: "默认 files_with_matches" },
      context: { type: "number", description: "content 模式下显示匹配前后的行数" },
      offset: { type: "number", description: "跳过前 N 条结果" },
      head_limit: { type: "number", description: "最多返回多少条，默认 100" },
      case_insensitive: { type: "boolean" },
      multiline: { type: "boolean" },
    },
    required: ["pattern"],
  },
  async execute(input, context) {
    const pattern = String(input.pattern || "");
    if (!pattern) return { ok: false, content: "", error: "Missing required parameter: pattern" };
    const targets = resolveSearchTargets(context.workspace, input.path);
    if (!targets) return { ok: false, content: "", error: "Path is outside the readable Memory scope." };
    const mode = ["files_with_matches", "content", "count"].includes(String(input.output_mode))
      ? String(input.output_mode)
      : "files_with_matches";
    const contextLines = Math.max(0, Math.min(20, Number(input.context) || 0));
    const multiline = input.multiline === true;
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, `${input.case_insensitive === true ? "i" : ""}${multiline ? "ms" : ""}`);
    } catch (error: any) {
      return { ok: false, content: "", error: `Invalid search pattern: ${error.message}` };
    }

    const fileFilter = input.glob ? globRegex(String(input.glob)) : undefined;
    const files = [...new Set(targets.flatMap((target) => collectFiles(target, context.workspace.paths.root)))]
      .filter((file) => fileFilter
        ? fileFilter.test(file) || fileFilter.test(path.basename(file))
        : isReadableDocExtension(file))
      .flatMap((file) => {
        try { return [{ display: file, text: fs.readFileSync(path.resolve(context.workspace.paths.root, file), "utf-8") }]; }
        catch { return []; }
      });
    const rows: string[] = [];

    for (const file of files) {
      const text = file.text;

      if (multiline) {
        const match = matcher.exec(text);
        if (!match) continue;
        if (mode === "files_with_matches") {
          rows.push(file.display);
        } else if (mode === "count") {
          const flags = `${input.case_insensitive === true ? "i" : ""}gms`;
          const allMatches = [...text.matchAll(new RegExp(pattern, flags))];
          rows.push(`${file.display}:${allMatches.length}`);
        } else {
          const lineNumber = text.slice(0, match.index).split(/\r?\n/).length;
          const preview = match[0].replace(/\r?\n/g, "\\n");
          rows.push(`${file.display}:${lineNumber}:${preview}`);
        }
        continue;
      }

      const lines = text.split(/\r?\n/);
      const matchingLines: number[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (matcher.test(lines[index])) matchingLines.push(index);
      }
      if (matchingLines.length === 0) continue;
      if (mode === "files_with_matches") {
        rows.push(file.display);
      } else if (mode === "count") {
        rows.push(`${file.display}:${matchingLines.length}`);
      } else {
        const emitted = new Set<number>();
        for (const matchedIndex of matchingLines) {
          const first = Math.max(0, matchedIndex - contextLines);
          const last = Math.min(lines.length - 1, matchedIndex + contextLines);
          for (let lineIndex = first; lineIndex <= last; lineIndex++) {
            if (emitted.has(lineIndex)) continue;
            emitted.add(lineIndex);
            const separator = lineIndex === matchedIndex ? ":" : "-";
            rows.push(`${file.display}${separator}${lineIndex + 1}${separator}${lines[lineIndex]}`);
          }
        }
      }
    }

    const offset = Math.max(0, Number(input.offset) || 0);
    const limit = Math.max(1, Math.min(500, Number(input.head_limit) || 100));
    const shown = rows.slice(offset, offset + limit);
    if (shown.length === 0) return { ok: true, content: "No matches found." };
    const hasMore = rows.length > offset + shown.length;
    return { ok: true, content: `${shown.join("\n")}${hasMore ? `\n\n[PARTIAL: use offset=${offset + shown.length} to continue.]` : ""}` };
  },
};

const readTool: Tool = {
  name: "read",
  description: "读取工作区中的 Markdown、TXT 或 JSON 文件，输出带行号内容。默认从第 1 行开始，最多 2000 行；看到 PARTIAL 时用 offset/limit 继续。",
  permission: "read",
  contract: READ_CONTRACT,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "工作区相对文件路径" },
      offset: { type: "number", description: "从第几行开始，1-based，默认 1" },
      limit: { type: "number", description: "最多读取多少行，默认 2000，最大 2000" },
    },
    required: ["file_path"],
  },
  async execute(input, context) {
    const filePath = resolveReadablePath(context.workspace, input.file_path);
    if (!filePath) return { ok: false, content: "", error: "File is outside the current project's readable knowledge scope." };
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { ok: false, content: "", error: "File not found." };
    if (!isReadableDocExtension(filePath)) return { ok: false, content: "", error: "Only .md, .txt and .json files are supported." };
    return renderReadResult(fs.readFileSync(filePath, "utf-8"), relative(context.workspace.paths.root, filePath), input.offset, input.limit);
  },
};

function renderReadResult(text: string, label: string, rawOffset: unknown, rawLimit: unknown) {
  const lines = text.split(/\r?\n/);
  const offset = Math.max(1, Math.floor(Number(rawOffset) || 1));
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(rawLimit) || 2000)));
  if (offset > lines.length) return { ok: true, content: `[${label} has ${lines.length} lines; offset ${offset} is past the end.]` };
  const requested = lines.slice(offset - 1, offset - 1 + limit);
  const numbered: string[] = [];
  let outputChars = 0;
  for (let index = 0; index < requested.length; index++) {
    const line = requested[index];
    const clipped = line.length > 2000 ? `${line.slice(0, 2000)}… [line truncated]` : line;
    const rendered = `${String(offset + index).padStart(6)}→${clipped}`;
    if (numbered.length > 0 && outputChars + rendered.length > 40_000) break;
    numbered.push(rendered);
    outputChars += rendered.length + 1;
  }
  const next = offset + numbered.length;
  const header = `[${label} lines ${offset}-${next - 1} of ${lines.length}]`;
  const footer = next <= lines.length ? `\n\n[PARTIAL: use offset=${next} to continue.]` : "";
  return { ok: true, content: `${header}\n${numbered.join("\n")}${footer}` };
}

const semanticSearchTool: Tool = {
  name: "semantic_search",
  description: "按含义搜索通用 Memory。适合不知道原文措辞时寻找候选；项目附件与 Skill 不参与。命中后必须使用 read 核对原文。",
  permission: "read",
  contract: SEARCH_CONTRACT,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "自然语言搜索问题" },
      limit: { type: "number", description: "返回数量，默认 6，最大 12" },
    },
    required: ["query"],
  },
  async execute(input, context) {
    const query = String(input.query || "").trim();
    if (!query) return { ok: false, content: "", error: "Missing required parameter: query" };
    setCacheDir(context.workspace.paths.modelCacheDir);
    let index = loadMemoryDocsIndex(context.workspace);
    if (!index || memoryIndexNeedsRebuild(index, context.workspace)) index = await buildMemoryDocsIndex(context.workspace);
    const limit = Math.max(1, Math.min(12, Number(input.limit) || 6));

    // Multi-query recall: search a few near-synonym rewrites of the question and
    // merge their hits. Small Chinese docs often phrase the same idea in words
    // the user did not use ("复购" vs "再次购买"), so one phrasing under-recalls.
    const queries = expandQueries(query);
    const merged = new Map<string, Awaited<ReturnType<typeof semanticSearch>>[number]>();
    for (const q of queries) {
      const hits = await semanticSearch(q, index, limit * 2);
      for (const hit of hits) {
        const existing = merged.get(hit.chunk.id);
        // Keep the highest dense score seen for the same chunk across rewrites.
        if (!existing || hit.score > existing.score) merged.set(hit.chunk.id, hit);
      }
    }
    const matches = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    if (matches.length === 0) {
      return {
        ok: true,
        content: [
          "No semantic matches found.",
          "[检索质量：没有命中。当前资料很可能没有覆盖这个问题。请换更具体的关键词重搜，或如实告诉用户资料里没有相关内容，不要据此推断结论。]",
        ].join("\n"),
      };
    }

    // Chunks are section-aligned, so a truncated excerpt tends to drop the
    // closing lines — where scope limits and dissenting positions live. Keep
    // the window above the typical section length instead.
    const body = matches.map((match, index) => {
      const text = match.chunk.text.replace(/\s+/g, " ");
      const excerpt = text.length > SEARCH_EXCERPT_CHARS
        ? `${text.slice(0, SEARCH_EXCERPT_CHARS)}…（本节未显示完，用 read 看全文）`
        : text;
      return [
        `${index + 1}. ${match.title ? `${match.title} [${match.path}]` : match.path}:${match.chunk.startLine}-${match.chunk.endLine} (${match.score.toFixed(3)})`,
        excerpt,
      ].join("\n");
    }).join("\n\n");

    return { ok: true, content: `${body}\n\n${retrievalQualityNote(matches[0].score)}` };
  },
};

/** Generate up to 3 lightweight query rewrites without calling any model. */
function expandQueries(query: string): string[] {
  const variants = new Set<string>([query]);
  const bare = query
    .replace(/[?？。！!,，、；;：:]/g, " ")
    .replace(/(是什么|怎么样|怎么办|如何|为什么|吗|呢|的|了)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (bare && bare !== query) variants.add(bare);
  const terms = extractTerms(query);
  if (terms.length) {
    const termForm = terms.filter((t) => /[\u3400-\u9fff]/.test(t) || t.length >= 3).join(" ");
    if (termForm && termForm !== query) variants.add(termForm);
  }
  return [...variants].slice(0, 3);
}

/** Human-readable evidence-sufficiency signal appended to search results. */
function retrievalQualityNote(topScore: number): string {
  if (topScore >= 0.45) return `[检索质量：最高相关度 ${topScore.toFixed(2)}，命中较可靠，可结合原文作答（仍需 read 核对）。]`;
  if (topScore >= 0.30) return `[检索质量：最高相关度 ${topScore.toFixed(2)}，中等。建议 read 核对后谨慎使用，必要时换关键词补搜。]`;
  return `[检索质量：最高相关度仅 ${topScore.toFixed(2)}，偏低。资料可能没有直接覆盖这个问题，请换关键词重搜，或如实说明资料里没有明确依据，不要据此下结论。]`;
}

const skillTool: Tool = {
  name: "skill",
  description: "加载一个 Skill 的完整 SKILL.md。可用 Skill 的名称和简介已在上下文中给出；引用的 references、examples 或模板再用 read 按需读取。",
  permission: "read",
  contract: READ_CONTRACT,
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", description: "Skill 名称" } },
    required: ["name"],
  },
  async execute(input, context) {
    const name = String(input.name || "");
    const content = loadSkillContent(context.workspace, name);
    const filePath = resolveSkillPath(context.workspace, name);
    if (!content || !filePath) {
      const available = buildSkillIndex(context.workspace).skills.map((item) => item.id).join(", ");
      return { ok: false, content: "", error: `Skill not found. Available: ${available || "none"}` };
    }
    return { ok: true, content: `[Skill: ${name}; source: ${relative(context.workspace.paths.root, filePath)}]\n\n${content}` };
  },
};

export const BUILTIN_TOOLS: Tool[] = [globTool, grepTool, readTool, semanticSearchTool, skillTool];

export function createDefaultToolRegistry(workspace?: WorkspaceContext): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of BUILTIN_TOOLS) registry.register(tool);
  return registry;
}
