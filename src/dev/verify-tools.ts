import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceContext, storeProjectAttachment } from "../core/index.js";
import { createDefaultToolRegistry } from "../tools/builtins.js";
import type { ToolExecutionContext } from "../tools/index.js";
import { buildSkillIndex } from "../skills/index.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-tools-workspace");

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${name}${detail ? `: ${detail}` : ""}`);
  condition ? pass++ : fail++;
}

async function main(): Promise<void> {
  fs.rmSync(root, { recursive: true, force: true });
  process.env.PRODUCT_DIRECTOR_WORKSPACE = root;
  const workspace = buildWorkspaceContext(process.cwd());
  fs.writeFileSync(workspace.paths.directorMd, "# Director\n\n以用户问题为起点。\n", "utf-8");
  fs.writeFileSync(path.join(workspace.paths.memoryDir, "MEMORY.md"), "# Memory\n\n- `用户偏好.md`：长期偏好。\n", "utf-8");
  fs.writeFileSync(path.join(workspace.paths.memoryDir, "用户偏好.md"), "# 用户偏好\n\n默认使用简体中文。\n", "utf-8");
  const requirement = await storeProjectAttachment(workspace, { name: "需求.md", mimeType: "text/markdown", bytes: Buffer.from("# 群聊排序需求\n\n最近联系人优先，随后是群主和管理员。\n\n边缘情况需要单独讨论。\n") });
  const skillDir = path.join(workspace.paths.skillsDir, "critical-review");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: critical-review\ndescription: 评审需求和方案中的盲区。\n---\n\n# 设计评审\n\n先理解问题，再检查遗漏。\n", "utf-8");
  fs.writeFileSync(path.join(skillDir, "references", "checklist.md"), "# 检查表\n\n检查异常路径。\n", "utf-8");
  fs.writeFileSync(path.join(workspace.paths.skillsDir, "legacy.md"), "# Legacy Skill\n\n兼容旧的单文件 Skill。\n", "utf-8");

  const registry = createDefaultToolRegistry(workspace);
  const ctx: ToolExecutionContext = { workspace };
  check("small general tool surface", registry.list().map((tool) => tool.name).join(",") === "glob,grep,read,semantic_search,skill", registry.list().map((tool) => tool.name).join(", "));

  const glob = registry.get("glob")!;
  const globResult = await glob.execute({ pattern: "**/*.md" }, ctx);
  check("glob does not discover Project attachments", globResult.ok && !globResult.content.includes(requirement.fileId!) && !globResult.content.includes("需求.md"), globResult.content);
  check("glob finds common Memory", globResult.ok && globResult.content.includes("memory/MEMORY.md"), globResult.content);
  check("glob hides skills from ordinary discovery", !globResult.content.includes("skills/"), globResult.content);
  const projectGlob = await glob.execute({ pattern: "**/*", path: "projects/default/files" }, ctx);
  check("glob rejects the Project attachment library", !projectGlob.ok, projectGlob.error);
  const traversalGlob = await glob.execute({ pattern: "**/*", path: "../" }, ctx);
  check("glob rejects traversal", !traversalGlob.ok, traversalGlob.error);

  const grep = registry.get("grep")!;
  const grepFiles = await grep.execute({ pattern: "最近联系人", path: "projects/default/files" }, ctx);
  check("grep rejects the Project attachment library", !grepFiles.ok, grepFiles.error);
  const grepMemory = await grep.execute({ pattern: "简体中文", path: "memory" }, ctx);
  check("grep can target common Memory", grepMemory.ok && grepMemory.content.includes("memory/用户偏好.md"), grepMemory.content);
  const noMatch = await grep.execute({ pattern: "xyzzy-no-match", path: "memory" }, ctx);
  check("grep reports no matches", noMatch.ok && noMatch.content === "No matches found.", noMatch.content);

  const read = registry.get("read")!;
  const readResult = await read.execute({ file_path: requirement.relativePath, offset: 2, limit: 2 }, ctx);
  check("read rejects a Project attachment path", !readResult.ok, readResult.error);
  const readByHandle = await read.execute({ file_path: `project-file:${requirement.fileId}`, offset: 2, limit: 2 }, ctx);
  check("read rejects a dormant Project file handle", !readByHandle.ok, readByHandle.error);
  const readMemory = await read.execute({ file_path: "memory/用户偏好.md" }, ctx);
  check("read opens common Memory", readMemory.ok && readMemory.content.includes("简体中文"), readMemory.content);
  const readPastEnd = await read.execute({ file_path: "memory/用户偏好.md", offset: 99 }, ctx);
  check("read explains past-end offset", readPastEnd.ok && readPastEnd.content.includes("past the end"), readPastEnd.content);
  fs.writeFileSync(path.join(workspace.paths.memoryDir, "长文档.md"), Array.from({ length: 2105 }, (_, index) => `第 ${index + 1} 行`).join("\n"), "utf8");
  const longFirst = await read.execute({ file_path: "memory/长文档.md" }, ctx);
  const longTail = await read.execute({ file_path: "memory/长文档.md", offset: 2001 }, ctx);
  check("read exposes an exact continuation point for long documents", longFirst.content.includes("offset=2001") && longTail.content.includes("  2105→第 2105 行") && !longTail.content.includes("PARTIAL"));
  const unsafeRead = await read.execute({ file_path: "../../etc/passwd" }, ctx);
  check("read rejects traversal", !unsafeRead.ok, unsafeRead.error);

  const skillIndex = buildSkillIndex(workspace);
  check("skill package discovered", skillIndex.skills.some((item) => item.id === "critical-review" && item.path.endsWith("critical-review/SKILL.md")));
  check("legacy skill discovered", skillIndex.skills.some((item) => item.id === "legacy"));
  const skill = registry.get("skill")!;
  const skillResult = await skill.execute({ name: "critical-review" }, ctx);
  check("skill loads only SKILL.md", skillResult.ok && skillResult.content.includes("先理解问题") && !skillResult.content.includes("检查异常路径"));
  const referenceResult = await read.execute({ file_path: "skills/critical-review/references/checklist.md" }, ctx);
  check("skill references readable on demand", referenceResult.ok && referenceResult.content.includes("异常路径"));

  const semantic = registry.get("semantic_search")!;
  check("semantic search is explicit tool", semantic.description.includes("按含义") && semantic.contract.confirmationPolicy === "never");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nResults: ${pass} PASS, ${fail} FAIL`);
  if (fail) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
