import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceContext } from "./types.js";
import { embed } from "../model/local-embedder.js";
import { listProjectFileCatalog, readProjectFileText } from "./project-file-catalog.js";

const INDEX_VERSION = 8;
const CHUNK_MAX_CHARS = 650;
const CHUNK_OVERLAP_CHARS = 100;
export type KnowledgeScope = "memory" | "project";

export interface DocChunk {
  id: string;
  startLine: number;
  endLine: number;
  heading?: string;
  text: string;
  embedding: number[];
}

export interface DocEntry {
  path: string;
  scope: KnowledgeScope;
  title?: string;
  sourcePath?: string;
  lastModified: string;
  chunks: DocChunk[];
}

export interface DocsIndex {
  version: number;
  generatedAt: string;
  files: DocEntry[];
}

interface SourceDir {
  scope: KnowledgeScope;
  dir: string;
}

interface DocCandidate {
  path: string;
  scope: KnowledgeScope;
  title?: string;
  sourcePath: string;
  content?: string;
}

function memorySources(workspace: WorkspaceContext): SourceDir[] {
  return [{ scope: "memory", dir: workspace.paths.memoryDir }];
}

function projectSources(workspace: WorkspaceContext): SourceDir[] {
  return [{ scope: "project", dir: workspace.paths.projectFilesDir }];
}

export async function buildDocsIndex(
  workspace: WorkspaceContext,
  callbacks?: { onProgress?: (current: number, total: number) => void },
): Promise<DocsIndex> {
  const memory = await buildMemoryDocsIndex(workspace, callbacks);
  const project = await buildIndexFile(workspace, projectSources(workspace), workspace.paths.projectDocsIndex, callbacks);
  return mergeIndexes(memory, project);
}

export async function buildMemoryDocsIndex(
  workspace: WorkspaceContext,
  callbacks?: { onProgress?: (current: number, total: number) => void },
): Promise<DocsIndex> {
  return buildIndexFile(workspace, memorySources(workspace), workspace.paths.memoryDocsIndex, callbacks);
}

async function buildIndexFile(
  workspace: WorkspaceContext,
  sources: SourceDir[],
  target: string,
  callbacks?: { onProgress?: (current: number, total: number) => void },
): Promise<DocsIndex> {
  const existing = loadDocsIndex(target);
  const existingMap = new Map((existing?.files || []).map((file) => [file.path, file]));
  const candidates = collectCandidates(workspace, sources);
  const files: DocEntry[] = [];
  const pending: Array<{ entry: DocEntry; chunkIndex: number; text: string }> = [];

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate.sourcePath) ? candidate.sourcePath : path.join(workspace.paths.root, candidate.sourcePath);
    let stat: fs.Stats;
    try { stat = fs.statSync(absolute); } catch { continue; }
    const lastModified = stat.mtime.toISOString();
    const old = existingMap.get(candidate.path);
    if (old && old.scope === candidate.scope && old.lastModified === lastModified) {
      files.push(old);
      continue;
    }
    let content = candidate.content ?? "";
    if (candidate.content === undefined) {
      try { content = fs.readFileSync(absolute, "utf-8"); } catch { continue; }
    }
    const entry: DocEntry = {
      path: candidate.path,
      scope: candidate.scope,
      title: candidate.title,
      sourcePath: candidate.sourcePath,
      lastModified,
      chunks: [],
    };
    for (const chunk of chunkDocument(content)) {
      const chunkIndex = entry.chunks.length;
      entry.chunks.push({
        id: `${candidate.path}#L${chunk.startLine}-L${chunk.endLine}`,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        heading: chunk.heading,
        text: chunk.text,
        embedding: [],
      });
      pending.push({ entry, chunkIndex, text: chunk.text });
    }
    files.push(entry);
  }

  for (let index = 0; index < pending.length; index += 20) {
    const batch = pending.slice(index, index + 20);
    const embeddings = await embed(batch.map((item) => item.text));
    batch.forEach((item, batchIndex) => { item.entry.chunks[item.chunkIndex].embedding = embeddings[batchIndex]; });
    callbacks?.onProgress?.(Math.min(index + 20, pending.length), pending.length);
  }

  const result = { version: INDEX_VERSION, generatedAt: new Date().toISOString(), files };
  saveDocsIndex(target, result);
  return result;
}

export function loadDocsIndex(filePath: string): DocsIndex | null {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.files)) return null;
    if (!data.files.every((file: any) => ["memory", "project"].includes(file.scope))) return null;
    return { version: data.version, generatedAt: data.generatedAt || "", files: data.files };
  } catch {
    return null;
  }
}

export function loadWorkspaceIndexes(workspace: WorkspaceContext): DocsIndex | null {
  const memory = loadDocsIndex(workspace.paths.memoryDocsIndex);
  const project = loadDocsIndex(workspace.paths.projectDocsIndex);
  return memory && project ? mergeIndexes(memory, project) : null;
}

export function loadMemoryDocsIndex(workspace: WorkspaceContext): DocsIndex | null {
  return loadDocsIndex(workspace.paths.memoryDocsIndex);
}

function saveDocsIndex(filePath: string, index: DocsIndex): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(index), "utf-8");
  fs.renameSync(temp, filePath);
}

function mergeIndexes(...indexes: DocsIndex[]): DocsIndex {
  return {
    version: INDEX_VERSION,
    generatedAt: indexes.map((item) => item.generatedAt).sort().at(-1) || "",
    files: indexes.flatMap((item) => item.files),
  };
}

export interface SemanticMatch {
  path: string;
  scope: KnowledgeScope;
  title?: string;
  score: number;
  chunk: DocChunk;
}

/**
 * Hybrid retrieval: dense vector similarity + lightweight lexical (keyword)
 * scoring, fused with Reciprocal Rank Fusion. The lexical leg exists because a
 * small Chinese embedding model does not reliably represent self-coined
 * business jargon (e.g. "渠道品", "经营状态透传"); exact character/term overlap
 * rescues those queries. Latin words and CJK bigrams are both used as terms.
 */
export async function semanticSearch(query: string, index: DocsIndex, topK: number = 6): Promise<SemanticMatch[]> {
  if (index.files.length === 0) return [];

  const chunks: Array<{ path: string; scope: KnowledgeScope; title?: string; chunk: DocChunk }> = [];
  for (const file of index.files) {
    for (const chunk of file.chunks) {
      if (chunk.embedding.length || chunk.text) chunks.push({ path: file.path, scope: file.scope, title: file.title, chunk });
    }
  }
  if (chunks.length === 0) return [];

  const [queryVector] = await embed([`为这个句子生成表示以用于检索相关文章：${query}`]);

  const denseRanked = chunks
    .map((item, i) => ({ i, score: item.chunk.embedding.length ? cosineSimilarity(queryVector, item.chunk.embedding) : 0 }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const queryTerms = extractTerms(query);
  const lexicalRanked = chunks
    .map((item, i) => ({ i, score: lexicalScore(queryTerms, item.chunk.text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  // Reciprocal Rank Fusion: 1/(k+rank) from each ranked list, summed per chunk.
  const RRF_K = 60;
  const fused = new Map<number, { rrf: number; dense: number }>();
  denseRanked.forEach((item, rank) => {
    const entry = fused.get(item.i) || { rrf: 0, dense: 0 };
    entry.rrf += 1 / (RRF_K + rank);
    entry.dense = item.score;
    fused.set(item.i, entry);
  });
  lexicalRanked.forEach((item, rank) => {
    const entry = fused.get(item.i) || { rrf: 0, dense: 0 };
    entry.rrf += 1 / (RRF_K + rank);
    fused.set(item.i, entry);
  });

  const ordered = [...fused.entries()]
    .map(([i, value]) => ({ i, rrf: value.rrf, dense: value.dense }))
    .sort((a, b) => b.rrf - a.rrf);

  // Allow up to 3 chunks per file (was a hard 2) so a single long, on-topic
  // document is not truncated when its best evidence clusters together.
  const perFile = new Map<string, number>();
  const results: SemanticMatch[] = [];
  for (const item of ordered) {
    const source = chunks[item.i];
    const count = perFile.get(source.path) || 0;
    if (count >= 3) continue;
    // Report the dense cosine as `score` so the caller keeps a stable, human
    // readable relevance signal; RRF is only used for ordering.
    results.push({ path: source.path, scope: source.scope, title: source.title, score: item.dense, chunk: source.chunk });
    perFile.set(source.path, count + 1);
    if (results.length >= topK) break;
  }
  return results;
}

/** Query terms: Latin/number words (lowercased) plus CJK character bigrams. */
export function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  const latin = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const word of latin) if (word.length >= 2) terms.add(word);
  const cjk = text.match(/[\u3400-\u9fff]/g) || [];
  const joined = cjk.join("");
  for (let i = 0; i < joined.length - 1; i++) terms.add(joined.slice(i, i + 2));
  if (joined.length === 1) terms.add(joined);
  return [...terms];
}

/** Term-frequency overlap normalized by query term count. */
function lexicalScore(queryTerms: string[], text: string): number {
  if (queryTerms.length === 0 || !text) return 0;
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) if (haystack.includes(term)) hits++;
  return hits / queryTerms.length;
}

export function needsRebuild(index: DocsIndex, workspace: WorkspaceContext): boolean {
  if (index.version !== INDEX_VERSION) return true;
  return sourcesNeedRebuild(index, workspace, [...memorySources(workspace), ...projectSources(workspace)]);
}

export function memoryIndexNeedsRebuild(index: DocsIndex, workspace: WorkspaceContext): boolean {
  if (index.version !== INDEX_VERSION) return true;
  return sourcesNeedRebuild(index, workspace, memorySources(workspace));
}

function sourcesNeedRebuild(index: DocsIndex, workspace: WorkspaceContext, sources: SourceDir[]): boolean {
  const candidates = collectCandidates(workspace, sources);
  const indexed = new Map(index.files.map((file) => [file.path, file]));
  if (indexed.size !== candidates.length) return true;
  for (const candidate of candidates) {
    const entry = indexed.get(candidate.path);
    if (!entry || entry.scope !== candidate.scope) return true;
    try {
      const absolute = path.isAbsolute(candidate.sourcePath) ? candidate.sourcePath : path.join(workspace.paths.root, candidate.sourcePath);
      if (entry.lastModified !== fs.statSync(absolute).mtime.toISOString()) return true;
    } catch { return true; }
  }
  return false;
}

function collectCandidates(workspace: WorkspaceContext, sources: SourceDir[]): DocCandidate[] {
  return sources.flatMap(({ scope, dir }) => {
    if (scope === "project" && dir === workspace.paths.projectFilesDir) {
      return listProjectFileCatalog(workspace).flatMap((file): DocCandidate[] => {
        if (!file.readable) return [];
        const content = readProjectFileText(file);
        if (content === null) return [];
        return [{ path: file.handle, scope, title: file.name, sourcePath: file.sourcePath, content }];
      });
    }
    return collectFilesInDir(dir, workspace.paths.root).map((filePath) => ({
      path: filePath,
      scope,
      sourcePath: filePath,
    }));
  });
}

function collectFilesInDir(dir: string, root: string): string[] {
  const result: string[] = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectFilesInDir(absolute, root));
    else if (entry.isFile() && [".md", ".txt"].includes(path.extname(entry.name).toLowerCase()) && entry.name !== ".gitkeep") {
      result.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  return result;
}

function chunkDocument(text: string): Array<{ text: string; startLine: number; endLine: number; heading?: string }> {
  const lines = text.split(/\r?\n/);
  const paragraphs: Array<{ text: string; startLine: number; endLine: number; heading?: string }> = [];
  let buffer: string[] = [];
  let startLine = 1;
  let heading: string | undefined;
  const flush = (endLine: number) => {
    const value = buffer.join("\n").trim();
    if (value) paragraphs.push({ text: value, startLine, endLine, heading });
    buffer = [];
  };
  lines.forEach((line, index) => {
    const markdownHeading = line.trim().match(/^#{1,6}\s+(.+)$/);
    if (markdownHeading) heading = markdownHeading[1];
    if (!line.trim()) {
      flush(index);
      startLine = index + 2;
    } else {
      if (!buffer.length) startLine = index + 1;
      buffer.push(line);
    }
  });
  flush(lines.length);

  const small: typeof paragraphs = [];
  for (const paragraph of paragraphs) {
    if (paragraph.text.length <= CHUNK_MAX_CHARS) small.push(paragraph);
    else {
      const step = CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS;
      for (let offset = 0; offset < paragraph.text.length; offset += step) {
        small.push({ ...paragraph, text: paragraph.text.slice(offset, offset + CHUNK_MAX_CHARS) });
        if (offset + CHUNK_MAX_CHARS >= paragraph.text.length) break;
      }
    }
  }
  const chunks: typeof paragraphs = [];
  let current: (typeof paragraphs)[number] | undefined;
  let previousTail = "";
  for (const paragraph of small) {
    // A markdown section heading starts a new topic. Breaking there — and
    // dropping the overlap across that break — keeps each chunk centred on one
    // section. Without this the tail of section N leads chunk N+1, which pulls
    // the chunk's meaning toward the previous topic and makes it match queries
    // it has nothing to do with.
    const startsSection = /^#{1,6}\s+/.test(paragraph.text);
    const overflows = current && current.text.length + paragraph.text.length + 2 > CHUNK_MAX_CHARS;
    if (!current || overflows || startsSection) {
      if (current) {
        chunks.push(current);
        previousTail = startsSection ? "" : tailOverlap(current.text);
      }
      // Prepend a short tail of the previous chunk so meaning that spans a
      // paragraph boundary is not split cleanly in half. Overlap is stored in
      // the embedded text only; startLine/heading still point at the real body.
      current = previousTail
        ? { ...paragraph, text: `${previousTail}\n\n${paragraph.text}` }
        : { ...paragraph };
    } else {
      current.text += `\n\n${paragraph.text}`;
      current.endLine = paragraph.endLine;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Last whole-ish segment of a chunk, used as overlap for the next chunk. */
function tailOverlap(text: string): string {
  if (text.length <= CHUNK_OVERLAP_CHARS) return text;
  const tail = text.slice(text.length - CHUNK_OVERLAP_CHARS);
  const breakAt = tail.search(/[。！？!?.\n]/);
  return breakAt >= 0 && breakAt < tail.length - 1 ? tail.slice(breakAt + 1).trim() : tail.trim();
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    left += a[index] * a[index];
    right += b[index] * b[index];
  }
  const denominator = Math.sqrt(left) * Math.sqrt(right);
  return denominator ? dot / denominator : 0;
}
