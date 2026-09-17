import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AttachmentRef } from "./agent-types.js";
import type { WorkspaceContext, WorkspacePaths } from "./types.js";

export type IncomingAttachmentData = {
  id?: string;
  name?: string;
  mimeType?: string;
  bytes: Buffer;
};

export type StoredFileMeta = {
  version: 1;
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  pageCount?: number;
};

export type StoredProjectFile = StoredFileMeta & {
  originalPath: string;
};

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown"]);

export function isImageAttachment(attachment: Pick<AttachmentRef, "mimeType" | "kind">): boolean {
  return attachment.kind === "image" || IMAGE_MIMES.has(attachment.mimeType);
}

export function assignAttachmentLabels(
  attachments: AttachmentRef[],
  sessionAttachments: AttachmentRef[] = [],
): AttachmentRef[] {
  // A recalled file keeps the label from its source Session. Its source text is
  // the namespace, so 图1 from two Sessions may intentionally coexist.
  const localSessionAttachments = sessionAttachments.filter((item) => !item.referenceScope);
  const localIncomingAttachments = attachments.filter((item) => !item.referenceScope);
  const claimedImages = collectLabelNumbers(localSessionAttachments, true);
  const claimedFiles = collectLabelNumbers(localSessionAttachments, false);
  const reservedImages = collectLabelNumbers([...localSessionAttachments, ...localIncomingAttachments], true);
  const reservedFiles = collectLabelNumbers([...localSessionAttachments, ...localIncomingAttachments], false);
  const labelsByFileId = new Map<string, string>();
  for (const attachment of localSessionAttachments) {
    if (attachment.fileId && attachment.label && !labelsByFileId.has(attachment.fileId)) {
      labelsByFileId.set(attachment.fileId, attachment.label);
    }
  }
  let nextImage = Math.max(0, ...reservedImages) + 1;
  let nextFile = Math.max(0, ...reservedFiles) + 1;

  return attachments.map((attachment) => {
    const image = isImageAttachment(attachment);
    const recalledLabel = attachment.label?.match(image ? /^图\d+$/ : /^文件\d+$/);
    if (attachment.referenceScope && recalledLabel) {
      return { ...attachment, kind: image ? "image" : "file" };
    }
    const existingLabel = attachment.fileId ? labelsByFileId.get(attachment.fileId) : undefined;
    if (existingLabel && (image ? /^图\d+$/.test(existingLabel) : /^文件\d+$/.test(existingLabel))) {
      return { ...attachment, kind: image ? "image" : "file", label: existingLabel };
    }
    const match = attachment.label?.match(image ? /^图(\d+)$/ : /^文件(\d+)$/);
    const claimed = image ? claimedImages : claimedFiles;
    if (match && !claimed.has(Number(match[1]))) {
      claimed.add(Number(match[1]));
      return { ...attachment, kind: image ? "image" : "file" };
    }

    const reserved = image ? reservedImages : reservedFiles;
    let next = image ? nextImage : nextFile;
    while (reserved.has(next) || claimed.has(next)) next++;
    claimed.add(next);
    if (image) nextImage = next + 1;
    else nextFile = next + 1;
    const label = image ? `图${next}` : `文件${next}`;
    return { ...attachment, kind: image ? "image" : "file", label };
  });
}

function collectLabelNumbers(attachments: AttachmentRef[], image: boolean): Set<number> {
  const numbers = new Set<number>();
  for (const attachment of attachments) {
    if (isImageAttachment(attachment) !== image) continue;
    const match = attachment.label?.match(image ? /^图(\d+)$/ : /^文件(\d+)$/);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

export function listStoredProjectFiles(workspace: WorkspaceContext): StoredProjectFile[] {
  if (!fs.existsSync(workspace.paths.projectFilesDir)) return [];
  return fs.readdirSync(workspace.paths.projectFilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/i.test(entry.name))
    .flatMap((entry) => {
      const bundleDir = safeBundleDir(workspace.paths.projectFilesDir, entry.name);
      const meta = readMeta(path.join(bundleDir, "meta.json"));
      if (!meta) return [];
      const original = fs.readdirSync(bundleDir, { withFileTypes: true })
        .find((item) => item.isFile() && item.name.startsWith("original."));
      return original ? [{ ...meta, originalPath: path.join(bundleDir, original.name) }] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function storeProjectAttachment(
  workspace: WorkspaceContext,
  incoming: IncomingAttachmentData,
): Promise<AttachmentRef> {
  const detected = detectAttachment(incoming.bytes, incoming.mimeType, incoming.name);
  const fileId = createHash("sha256").update(incoming.bytes).digest("hex");
  const bundleDir = safeBundleDir(workspace.paths.projectFilesDir, fileId);
  const originalPath = path.join(bundleDir, `original.${detected.extension}`);
  fs.mkdirSync(bundleDir, { recursive: true });
  if (!fs.existsSync(originalPath)) writeFileAtomic(originalPath, incoming.bytes);

  let pageCount: number | undefined;
  if (detected.mimeType === "application/pdf") {
    const result = await preparePdfBundle(originalPath, bundleDir);
    pageCount = result.pageCount;
  }

  const name = safeDisplayName(incoming.name, detected.extension);
  const metaPath = path.join(bundleDir, "meta.json");
  const existing = readMeta(metaPath);
  const meta: StoredFileMeta = {
    version: 1,
    fileId,
    name: existing?.name || name,
    mimeType: detected.mimeType,
    size: incoming.bytes.length,
    createdAt: existing?.createdAt || new Date().toISOString(),
    pageCount: pageCount ?? existing?.pageCount,
  };
  writeJsonAtomic(metaPath, meta);

  return {
    id: incoming.id || randomUUID(),
    fileId,
    name,
    mimeType: detected.mimeType,
    size: incoming.bytes.length,
    kind: IMAGE_MIMES.has(detected.mimeType) ? "image" : "file",
    pageCount: meta.pageCount,
    relativePath: relativeToWorkspace(workspace.paths, originalPath),
  };
}

export function hydrateAttachment(
  workspace: WorkspaceContext,
  attachment: AttachmentRef,
): AttachmentRef {
  const originalPath = resolveAttachmentOriginal(workspace, attachment);
  if (!originalPath || !fs.existsSync(originalPath)) return { ...attachment };
  if (isImageAttachment(attachment)) {
    const bytes = fs.readFileSync(originalPath);
    return { ...attachment, dataUrl: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` };
  }
  if (attachment.mimeType === "application/pdf") {
    const bundleDir = path.dirname(originalPath);
    const textPath = path.join(bundleDir, "text.json");
    const pagesDir = path.join(bundleDir, "pages");
    let extractedText = "";
    try {
      const parsed = JSON.parse(fs.readFileSync(textPath, "utf8"));
      extractedText = Array.isArray(parsed.pages)
        ? parsed.pages.map((item: any) => `[第${item.page}页]\n${String(item.text || "")}`).join("\n\n")
        : "";
    } catch {}
    const allPageEntries = fs.existsSync(pagesDir)
      ? fs.readdirSync(pagesDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^\d+\.png$/i.test(entry.name))
        .sort((a, b) => Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10))
      : [];
    const pages = allPageEntries.map((entry) => {
          const pagePath = path.join(pagesDir, entry.name);
          return {
            page: Number.parseInt(entry.name, 10),
            relativePath: relativeToWorkspace(workspace.paths, pagePath),
            dataUrl: `data:image/png;base64,${fs.readFileSync(pagePath).toString("base64")}`,
          };
        });
    return { ...attachment, extractedText, pages, pageCount: attachment.pageCount || allPageEntries.length };
  }
  if (TEXT_MIMES.has(attachment.mimeType)) {
    return { ...attachment, extractedText: fs.readFileSync(originalPath, "utf8") };
  }
  return { ...attachment };
}

export function resolveAttachmentOriginal(workspace: WorkspaceContext, attachment: AttachmentRef): string | null {
  const root = path.resolve(workspace.paths.projectFilesDir);
  if (attachment.fileId) {
    const bundleDir = safeBundleDir(root, attachment.fileId);
    const candidates = fs.existsSync(bundleDir)
      ? fs.readdirSync(bundleDir).filter((name) => name.startsWith("original."))
      : [];
    if (candidates.length) return path.join(bundleDir, candidates[0]);
  }
  const candidate = path.resolve(workspace.paths.root, attachment.relativePath);
  if (candidate.startsWith(`${root}${path.sep}`)) return candidate;
  const legacyRoot = path.resolve(workspace.paths.legacyAttachmentsDir);
  if (candidate.startsWith(`${legacyRoot}${path.sep}`)) return candidate;
  return null;
}

export function migrateLegacySessionStorage(paths: WorkspacePaths): void {
  migrateLegacyProjectFiles(paths);
  if (!fs.existsSync(paths.legacySessionsDir)) return;
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const entries = fs.readdirSync(paths.legacySessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  let complete = true;
  for (const entry of entries) {
    const sourceSession = path.join(paths.legacySessionsDir, entry.name);
    const targetSession = path.join(paths.sessionsDir, entry.name);
    if (fs.existsSync(targetSession)) continue;
    try {
      const session = JSON.parse(fs.readFileSync(sourceSession, "utf8"));
      const migrated = new Map<string, AttachmentRef>();
      const migrateRef = (value: any): any => {
        if (!value || typeof value !== "object" || !value.relativePath) return value;
        const oldPath = path.resolve(paths.root, String(value.relativePath));
        const legacyRoot = path.resolve(paths.legacyAttachmentsDir);
        if (!oldPath.startsWith(`${legacyRoot}${path.sep}`) || !fs.existsSync(oldPath)) return value;
        const key = oldPath.toLowerCase();
        const cached = migrated.get(key);
        if (cached) return { ...value, ...cached, id: value.id || cached.id };
        const bytes = fs.readFileSync(oldPath);
        const fileId = createHash("sha256").update(bytes).digest("hex");
        const extension = path.extname(oldPath).replace(/^\./, "") || extensionFromMime(String(value.mimeType || ""));
        const bundleDir = safeBundleDir(paths.projectFilesDir, fileId);
        const originalPath = path.join(bundleDir, `original.${extension}`);
        fs.mkdirSync(bundleDir, { recursive: true });
        if (!fs.existsSync(originalPath)) writeFileAtomic(originalPath, bytes);
        const next: AttachmentRef = {
          ...value,
          fileId,
          kind: String(value.mimeType || "").startsWith("image/") ? "image" : "file",
          relativePath: relativeToWorkspace(paths, originalPath),
        };
        writeJsonAtomic(path.join(bundleDir, "meta.json"), {
          version: 1,
          fileId,
          name: String(value.name || path.basename(oldPath)),
          mimeType: String(value.mimeType || "application/octet-stream"),
          size: bytes.length,
          createdAt: new Date().toISOString(),
        } satisfies StoredFileMeta);
        migrated.set(key, next);
        return next;
      };
      if (Array.isArray(session.messages)) {
        session.messages = session.messages.map((message: any) => ({
          ...message,
          attachments: Array.isArray(message.attachments) ? assignAttachmentLabels(message.attachments.map(migrateRef)) : message.attachments,
        }));
      }
      if (Array.isArray(session.turns)) {
        session.turns = session.turns.map((turn: any) => ({
          ...turn,
          userAttachments: Array.isArray(turn.userAttachments) ? assignAttachmentLabels(turn.userAttachments.map(migrateRef)) : turn.userAttachments,
        }));
      }
      writeJsonAtomic(targetSession, session);
    } catch {
      complete = false;
    }
  }
  if (complete && entries.every((entry) => fs.existsSync(path.join(paths.sessionsDir, entry.name)))) {
    fs.rmSync(paths.legacySessionsDir, { recursive: true, force: true });
    if (fs.existsSync(paths.legacyAttachmentsDir)) fs.rmSync(paths.legacyAttachmentsDir, { recursive: true, force: true });
  }
}

function migrateLegacyProjectFiles(paths: WorkspacePaths): void {
  const sources: string[] = [];
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name !== ".gitkeep") sources.push(candidate);
    }
  };
  visit(paths.projectDocsDir);
  visit(paths.projectDesignDir);
  if (!sources.length) {
    if (fs.existsSync(paths.projectDocsDir)) fs.rmSync(paths.projectDocsDir, { recursive: true, force: true });
    if (fs.existsSync(paths.projectDesignDir)) fs.rmSync(paths.projectDesignDir, { recursive: true, force: true });
    return;
  }

  let complete = true;
  for (const source of sources) {
    try {
      const bytes = fs.readFileSync(source);
      const fileId = createHash("sha256").update(bytes).digest("hex");
      const extension = path.extname(source).replace(/^\./, "").toLowerCase() || "bin";
      const bundleDir = safeBundleDir(paths.projectFilesDir, fileId);
      const originalPath = path.join(bundleDir, `original.${extension}`);
      fs.mkdirSync(bundleDir, { recursive: true });
      if (!fs.existsSync(originalPath)) writeFileAtomic(originalPath, bytes);
      const existing = readMeta(path.join(bundleDir, "meta.json"));
      writeJsonAtomic(path.join(bundleDir, "meta.json"), {
        version: 1,
        fileId,
        name: existing?.name || path.basename(source),
        mimeType: extension === "md" ? "text/markdown" : extension === "txt" ? "text/plain" : extension === "json" ? "application/json" : "application/octet-stream",
        size: bytes.length,
        createdAt: existing?.createdAt || fs.statSync(source).mtime.toISOString(),
      } satisfies StoredFileMeta);
    } catch {
      complete = false;
    }
  }
  if (!complete) return;
  if (fs.existsSync(paths.projectDocsDir)) fs.rmSync(paths.projectDocsDir, { recursive: true, force: true });
  if (fs.existsSync(paths.projectDesignDir)) fs.rmSync(paths.projectDesignDir, { recursive: true, force: true });
}

function detectAttachment(bytes: Buffer, declaredMime?: string, name?: string): { mimeType: string; extension: string } {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: "image/png", extension: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: "image/jpeg", extension: "jpg" };
  const header = bytes.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return { mimeType: "image/gif", extension: "gif" };
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return { mimeType: "image/webp", extension: "webp" };
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { mimeType: "application/pdf", extension: "pdf" };
  const lowerName = String(name || "").toLowerCase();
  if (declaredMime === "text/markdown" || /\.md$/.test(lowerName)) return { mimeType: "text/markdown", extension: "md" };
  if (declaredMime === "text/plain" || /\.txt$/.test(lowerName)) return { mimeType: "text/plain", extension: "txt" };
  throw new Error("暂时只支持 PNG、JPEG、GIF、WebP、PDF、TXT 和 Markdown 文件。");
}

async function preparePdfBundle(originalPath: string, bundleDir: string): Promise<{ pageCount: number }> {
  const textPath = path.join(bundleDir, "text.json");
  const pagesDir = path.join(bundleDir, "pages");
  if (fs.existsSync(textPath) && fs.existsSync(pagesDir)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(textPath, "utf8"));
      if (Array.isArray(parsed.pages) && parsed.pages.length) return { pageCount: parsed.pages.length };
    } catch {}
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas, DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
  Object.assign(globalThis, {
    DOMMatrix: (globalThis as any).DOMMatrix || DOMMatrix,
    ImageData: (globalThis as any).ImageData || ImageData,
    Path2D: (globalThis as any).Path2D || Path2D,
  });
  const bytes = new Uint8Array(fs.readFileSync(originalPath));
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true, disableFontFace: false });
  const document = await loadingTask.promise;
  fs.mkdirSync(pagesDir, { recursive: true });
  const pageTexts: Array<{ page: number; text: string }> = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item: any) => typeof item.str === "string" ? item.str : "").filter(Boolean).join(" ");
    pageTexts.push({ page: pageNumber, text });
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1800 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const canvasContext = canvas.getContext("2d");
    await page.render({ canvasContext: canvasContext as any, viewport, canvas: canvas as any }).promise;
    writeFileAtomic(path.join(pagesDir, `${pageNumber}.png`), canvas.toBuffer("image/png"));
    page.cleanup();
  }
  await loadingTask.destroy();
  writeJsonAtomic(textPath, { version: 1, pages: pageTexts });
  return { pageCount: pageTexts.length };
}

function safeBundleDir(root: string, fileId: string): string {
  const safeId = fileId.replace(/[^a-f0-9]/gi, "").slice(0, 64);
  if (!safeId) throw new Error("文件标识无效。");
  const candidate = path.resolve(root, safeId);
  const resolvedRoot = path.resolve(root);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("文件路径越界。");
  return candidate;
}

function safeDisplayName(name: string | undefined, extension: string): string {
  const base = path.basename(String(name || `file.${extension}`)).replace(/[\x00-\x1f]/g, "").trim();
  return (base || `file.${extension}`).slice(0, 180);
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown") return "md";
  if (mimeType === "text/plain") return "txt";
  return "png";
}

function relativeToWorkspace(paths: WorkspacePaths, filePath: string): string {
  return path.relative(paths.root, filePath).replace(/\\/g, "/");
}

function readMeta(metaPath: string): StoredFileMeta | null {
  try { return JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { return null; }
}

function writeFileAtomic(filePath: string, data: Buffer): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, data);
  try {
    if (fs.existsSync(filePath)) fs.rmSync(tempPath, { force: true });
    else fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(filePath)) fs.rmSync(tempPath, { force: true });
    else throw error;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}
