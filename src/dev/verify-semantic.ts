import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceContext } from "../core/workspace.js";
import { createDefaultToolRegistry } from "../tools/builtins.js";
import { storeProjectAttachment } from "../core/attachment-store.js";
import { buildDocsIndex } from "../core/docs-index.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-semantic-workspace");

try {
  fs.rmSync(root, { recursive: true, force: true });
  process.env.PRODUCT_DIRECTOR_WORKSPACE = root;
  const workspace = buildWorkspaceContext(process.cwd(), "default");
  // Reuse the project-controlled model cache while keeping documents and
  // generated indexes inside the disposable fixture workspace.
  workspace.paths.modelCacheDir = path.join(projectRoot, "workspace", ".runtime", "model-cache");
  fs.writeFileSync(path.join(workspace.paths.memoryDir, "用户偏好.md"), "# 用户偏好\n\n讨论设计时优先深入分析，不要急于下结论。", "utf-8");
  const projectFile = await storeProjectAttachment(workspace, { name: "订单列表复购案例.md", mimeType: "text/markdown", bytes: Buffer.from([
    "# 订单列表复购入口",
    "",
    "历史订单中的商品可能下架、SKU 变化或价格变化，因此最终采用商品级复购，并在购买前重新校验当前商品状态。",
  ].join("\n")) });
  const pdfBundle = path.join(workspace.paths.projectFilesDir, "a".repeat(64));
  fs.mkdirSync(path.join(pdfBundle, "pages"), { recursive: true });
  fs.writeFileSync(path.join(pdfBundle, "original.pdf"), "%PDF-test", "utf8");
  fs.writeFileSync(path.join(pdfBundle, "meta.json"), JSON.stringify({ version: 1, fileId: "a".repeat(64), name: "商机中心规范.pdf", mimeType: "application/pdf", size: 9, createdAt: new Date().toISOString(), pageCount: 1 }), "utf8");
  fs.writeFileSync(path.join(pdfBundle, "text.json"), JSON.stringify({ version: 1, pages: [{ page: 1, text: "商品推荐需要确保商家拥有相关货源，并重新校验商品可售状态。" }] }), "utf8");

  const tool = createDefaultToolRegistry(workspace).get("semantic_search");
  if (!tool) throw new Error("semantic_search tool is missing");
  const result = await tool.execute({ query: "历史订单再次购买时如何处理商品状态变化", limit: 3 }, { workspace });
  console.log(result.content);
  if (!result.ok || result.content.includes(projectFile.fileId!) || result.content.includes("订单列表复购案例.md")) process.exitCode = 1;
  const pdfResult = await tool.execute({ query: "推荐商品时怎样确认货源和可售状态", limit: 3 }, { workspace });
  console.log(pdfResult.content);
  if (!pdfResult.ok || pdfResult.content.includes("商机中心规范.pdf") || pdfResult.content.includes(`project-file:${"a".repeat(64)}`)) process.exitCode = 1;
  const memoryResult = await tool.execute({ query: "讨论设计时应该快速下结论还是深入分析", limit: 3 }, { workspace });
  console.log(memoryResult.content);
  if (!memoryResult.ok || !memoryResult.content.includes("memory/用户偏好.md")) process.exitCode = 1;
  if (!fs.existsSync(workspace.paths.memoryDocsIndex)) process.exitCode = 1;
  if (fs.existsSync(workspace.paths.projectDocsIndex)) process.exitCode = 1;
  if (result.content.includes("skills/")) process.exitCode = 1;
  const dormantProjectIndex = await buildDocsIndex(workspace);
  if (!dormantProjectIndex.files.some((file) => file.path === `project-file:${projectFile.fileId}` && file.title === "订单列表复购案例.md")) process.exitCode = 1;
  if (!dormantProjectIndex.files.some((file) => file.path === `project-file:${"a".repeat(64)}` && file.title === "商机中心规范.pdf")) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
