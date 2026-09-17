import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assignAttachmentLabels, hydrateAttachment, listStoredProjectFiles, storeProjectAttachment } from "../core/attachment-store.js";
import { buildWorkspaceContext } from "../core/workspace.js";
import { SessionStore } from "../core/session.js";
import { mapMessagesToOpenAI } from "../model/message-mapper.js";
import { handleListProjectAttachmentReferences, hydrateAttachments, persistIncomingAttachments } from "../web/server.js";
import { attachmentTriggerMatcher } from "../web/client/attachment-trigger.js";
import { resolveComposerRecalledAttachments } from "../web/client/attachment-references.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-attachments-workspace");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  fs.rmSync(root, { recursive: true, force: true });
  process.env.PRODUCT_DIRECTOR_WORKSPACE = root;
  const workspace = buildWorkspaceContext(process.cwd(), "附件测试");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const first = await storeProjectAttachment(workspace, { name: "image.png", mimeType: "image/png", bytes: png });
  const second = await storeProjectAttachment(workspace, { name: "另一个名字.png", mimeType: "image/png", bytes: png });
  check("identical files share one Project file", first.fileId === second.fileId && first.relativePath === second.relativePath);

  const labels = assignAttachmentLabels([
    first,
    { ...first, id: "pdf-label", kind: "file", mimeType: "application/pdf", name: "需求.pdf" },
    { ...second, id: "image-label" },
  ]);
  check("message labels only distinguish images and files", labels.map((item) => item.label).join(",") === "图1,文件1,图2");
  const stableLabels = assignAttachmentLabels([
    labels[2]!,
    { ...first, id: "new-after-delete", label: undefined },
  ]);
  check("deleting an earlier attachment never renumbers an existing reference", stableLabels.map((item) => item.label).join(",") === "图2,图3");
  const reusedNextTurn = assignAttachmentLabels([
    { ...first, id: "same-file-next-turn", label: undefined },
  ], labels);
  check("uploading the same Project file again reuses its Session label", reusedNextTurn[0]?.label === "图1");
  const freshNextTurn = assignAttachmentLabels([
    { ...first, id: "new-file-next-turn", fileId: "new-project-file", label: undefined },
  ], labels);
  check("a new Session image continues after the highest existing label", freshNextTurn[0]?.label === "图3");
  const duplicateSourceLabels = assignAttachmentLabels([
    { ...first, id: "source-a", label: "图1", referenceScope: "project", sourceSessionId: "source-a", sourceTurnIndex: 0 },
    { ...first, id: "source-b", fileId: "another-project-file", label: "图1", referenceScope: "project", sourceSessionId: "source-b", sourceTurnIndex: 0 },
  ], labels);
  check("recalled attachments keep duplicate source labels", duplicateSourceLabels.map((item) => item.label).join(",") === "图1,图1");
  const directiveMessage = mapMessagesToOpenAI([{
    id: "directive-message",
    role: "user",
    content: `先看 :attachment[图2]{name=${labels[2]!.id}}，这是设计稿`,
    createdAt: new Date().toISOString(),
    attachments: [labels[2]!],
  }], { acceptsImages: false })[0] as any;
  check("attachment editor syntax is converted to readable model text",
    typeof directiveMessage.content === "string"
    && directiveMessage.content.includes("先看 @图2，这是设计稿")
    && !directiveMessage.content.includes(":attachment["));

  const store = new SessionStore(workspace);
  const sourceSession = store.createSession("source-session", "商品机会改版");
  sourceSession.turns.push({
    userContent: "看图",
    userAttachments: [labels[0]!],
    events: [{ type: "attachments_loaded", data: {}, at: "2026-09-01T10:00:00.000Z" }],
    status: "completed",
  });
  store.saveSession(sourceSession);
  const catalog = handleListProjectAttachmentReferences("附件测试").attachments;
  const projectReference = catalog.find((item) => item.fileId === first.fileId);
  check("project recall catalog exposes source Session and turn", projectReference?.sourceSessionTitle === "商品机会改版" && projectReference.sourceTurnIndex === 0);
  const restoredComposerReferences = projectReference
    ? resolveComposerRecalledAttachments(
        `复查 :project-attachment[图1 · 来自「商品机会改版」]{name=${projectReference.id}}`,
        catalog,
      )
    : [];
  check(
    "serialized @@@ chip restores its outgoing attachment payload",
    restoredComposerReferences.length === 1 && restoredComposerReferences[0]?.fileId === first.fileId,
  );
  const recalled = projectReference
    ? await persistIncomingAttachments(workspace, "target-session", [projectReference])
    : [];
  check("project recall keeps source label and provenance", recalled[0]?.label === "图1" && recalled[0]?.sourceSessionId === sourceSession.id);
  const recalledMessage = recalled[0] ? mapMessagesToOpenAI([{
    id: "project-directive-message",
    role: "user",
    content: `复查 :project-attachment[图1 · 来自「商品机会改版」]{name=${recalled[0].id}}`,
    createdAt: new Date().toISOString(),
    attachments: recalled,
  }], { acceptsImages: false })[0] as any : undefined;
  check("model sees recall scope and source", typeof recalledMessage?.content === "string" && recalledMessage.content.includes("@@@图1，来自对话“商品机会改版”"));

  const pdf = await storeProjectAttachment(workspace, { name: "示例.pdf", mimeType: "application/pdf", bytes: createOnePagePdf("Hello Lazy PDF") });
  const hydrated = hydrateAttachment(workspace, pdf);
  check("PDF is extracted and rendered locally", pdf.pageCount === 1 && Boolean(hydrated.pages?.[0]?.dataUrl) && Boolean(hydrated.extractedText?.includes("Hello")));
  check("PDF artifacts stay beside the original", Boolean(pdf.fileId) && fs.existsSync(path.join(workspace.paths.projectFilesDir, pdf.fileId!, "pages", "1.png")));
  const mappedPdf = mapMessagesToOpenAI([{ id: "pdf-message", role: "user", content: "读文件", createdAt: new Date().toISOString(), attachments: assignAttachmentLabels([hydrated]) }], { acceptsImages: true })[0] as any;
  check("PDF text and page image become one local multimodal message", Array.isArray(mappedPdf.content) && mappedPdf.content.some((part: any) => part.type === "text" && String(part.text).includes("Hello")) && mappedPdf.content.some((part: any) => part.type === "image_url"));
  const pagesDir = path.join(workspace.paths.projectFilesDir, pdf.fileId!, "pages");
  for (let page = 2; page <= 61; page++) fs.copyFileSync(path.join(pagesDir, "1.png"), path.join(pagesDir, `${page}.png`));
  const uncappedPdf = hydrateAttachments(workspace, [{ ...pdf, pageCount: 61 }])?.[0];
  check("all PDF page images enter context without a local page cap", uncappedPdf?.pages?.length === 61);

  const legacyProjectDir = path.join(root, "projects", "旧项目");  fs.mkdirSync(path.join(legacyProjectDir, "docs"), { recursive: true });
  fs.mkdirSync(path.join(legacyProjectDir, "design"), { recursive: true });
  fs.writeFileSync(path.join(legacyProjectDir, "docs", "旧需求.txt"), "需要保留", "utf8");
  const migrated = buildWorkspaceContext(process.cwd(), "旧项目");
  const migratedNames = listStoredProjectFiles(migrated).map((file) => file.name);
  check("legacy Project folders migrate into one files store", migratedNames.includes("旧需求.txt"));
  check("legacy docs and design containers are removed", !fs.existsSync(migrated.paths.projectDocsDir) && !fs.existsSync(migrated.paths.projectDesignDir));

  // The picker is anchored to a live trigger. A stale match keeps an empty
  // panel floating over the transcript, so the boundary rules are verified here
  // rather than only by eye.
  const matched = (text: string, trigger: string) => attachmentTriggerMatcher(text, trigger, text.length);
  check("a mention still matches mid-sentence in Chinese prose", matched("先看@图1", "@")?.query === "图1");
  check("@ does not capture the tail of @@", matched("对比@@图1", "@") === null);
  check("@@ matches its own scope", matched("对比@@图1", "@@")?.query === "图1");
  check("@@ does not capture the tail of @@@", matched("复查@@@文件3", "@@") === null);
  check("an email address does not open the picker", matched("联系 user@example.com", "@") === null);
  check("a long clause after @ closes the trigger", matched("@这段话已经长到不可能是任何一个附件的名字了吧", "@") === null);

} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;

function createOnePagePdf(text: string): Buffer {
  const escaped = text.replace(/[\\()]/g, (match) => `\\${match}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "binary");
}
