import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillDirective } from "../core/agent-loop.js";
import { buildWorkspaceContext } from "../core/workspace.js";
import { createRuntime, runRuntime } from "../core/runtime.js";
import { handleListSkills } from "../web/server.js";
import type { ModelProvider } from "../model/provider.js";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}`);
  if (!ok) failures++;
};

const available = ["critical-review", "problem-framing", "kk-skill"];

const bare = parseSkillDirective("/critical-review", available);
check("bare directive resolves the skill and leaves no remainder",
  bare?.skillId === "critical-review" && bare?.remainder === "");

const withText = parseSkillDirective("/critical-review 看看这个收银台方案", available);
check("directive keeps the user's own question as remainder",
  withText?.skillId === "critical-review" && withText?.remainder === "看看这个收银台方案");

const ideographicSpace = parseSkillDirective("/kk-skill\u3000这批标签怎么分", available);
check("full-width space also separates directive from text",
  ideographicSpace?.skillId === "kk-skill" && ideographicSpace?.remainder === "这批标签怎么分");

const multiline = parseSkillDirective("/problem-framing 第一行\n第二行", available);
check("remainder preserves a multi-line brief",
  multiline?.remainder === "第一行\n第二行");

const leadingSpace = parseSkillDirective("   /problem-framing 重建字段体系", available);
check("leading whitespace does not hide the directive",
  leadingSpace?.skillId === "problem-framing");

check("uppercase input still matches a lowercase skill id",
  parseSkillDirective("/Critical-Review", available)?.skillId === "critical-review");

// An unknown slash word must stay ordinary text. Turning it into an error would
// break normal writing that merely happens to start with a slash.
check("unknown slash word is not treated as a directive",
  parseSkillDirective("/不知道该写什么", available) === null);
check("unknown ascii slash word is not treated as a directive",
  parseSkillDirective("/deploy 上线流程", available) === null);

// Runtime commands must not be shadowed by a same-named Skill.
check("/context stays a runtime command", parseSkillDirective("/context", available) === null);
check("/compact stays a runtime command", parseSkillDirective("/compact 只保留决定", available) === null);
check("a skill named context cannot hijack /context",
  parseSkillDirective("/context", [...available, "context"]) === null);

// A slash in the middle of a sentence is not an invocation.
check("mid-sentence slash is ignored",
  parseSkillDirective("对比 A/critical-review 两种做法", available) === null);
check("path-like text is ignored",
  parseSkillDirective("读一下 /kk-skill 目录", available) === null);

check("empty input is safe", parseSkillDirective("", available) === null);
check("lone slash is safe", parseSkillDirective("/", available) === null);
check("no skills installed means no directive",
  parseSkillDirective("/critical-review", []) === null);

// ─── End-to-end: the directive must reach the model and the catalog API ───────

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-skill-directive-workspace");
fs.rmSync(root, { recursive: true, force: true });
process.env.PRODUCT_DIRECTOR_WORKSPACE = root;

try {
  const workspace = buildWorkspaceContext(process.cwd());
  const skillDir = path.join(workspace.paths.skillsDir, "critical-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: critical-review\ndescription: 对方案做第二视角评审。\n---\n\n# 设计评审\n\n先弄清目标再选角度。\n",
    "utf-8",
  );

  const catalog = handleListSkills();
  check("the panel reads the same catalog the model sees",
    catalog.ok
    && catalog.skills.some((skill) => skill.id === "critical-review" && skill.description?.includes("第二视角")));

  let sawInstruction = false;
  let sawSkillBody = false;
  let round = 0;
  const provider: ModelProvider = {
    name: "skill-directive-test",
    contextWindowTokens: 100_000,
    async generate(request) {
      round++;
      if (round === 1) {
        const systemText = request.messages
          .filter((item) => item.role === "system")
          .map((item) => item.content)
          .join("\n");
        sawInstruction = systemText.includes("用户已在输入框中显式选择了一个 Skill")
          && systemText.includes("critical-review")
          && systemText.includes("本轮必须先调用 skill 工具");
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "skill", input: { name: "critical-review" } }],
          stopReason: "tool_call",
        };
      }
      sawSkillBody = request.messages.some((item) => item.role === "tool" && item.content.includes("先弄清目标再选角度"));
      return { content: "已按评审方法处理。", toolCalls: [], stopReason: "final" };
    },
  };

  await runRuntime(createRuntime(workspace, provider), "/critical-review 看看这个收银台方案", { maxSteps: 3 });
  check("an explicit choice is injected as a turn constraint, not as user text", sawInstruction);
  check("the skill tool still owns loading the body", sawSkillBody);

  // A plain question must not carry the constraint.
  let plainTurnStayedClean = false;
  const plainProvider: ModelProvider = {
    name: "plain-turn-test",
    contextWindowTokens: 100_000,
    async generate(request) {
      plainTurnStayedClean = !request.messages.some((item) => item.content.includes("显式选择了一个 Skill"));
      return { content: "普通回答。", toolCalls: [], stopReason: "final" };
    },
  };
  await runRuntime(createRuntime(workspace, plainProvider), "看看这个收银台方案", { maxSteps: 2 });
  check("an ordinary turn carries no skill constraint", plainTurnStayedClean);

  // The constraint is per-turn: a follow-up without the directive must be clean
  // even though the previous turn used one.
  let followUpStayedClean = false;
  const followUpProvider: ModelProvider = {
    name: "follow-up-test",
    contextWindowTokens: 100_000,
    async generate(request) {
      followUpStayedClean = !request.messages.some((item) => item.content.includes("显式选择了一个 Skill"));
      return { content: "继续回答。", toolCalls: [], stopReason: "final" };
    },
  };
  await runRuntime(createRuntime(workspace, followUpProvider), "那商家侧呢", {
    maxSteps: 2,
    historyMessages: [
      { id: "h1", role: "user", content: "/critical-review 看看这个收银台方案", createdAt: "1" },
      { id: "h2", role: "assistant", content: "已按评审方法处理。", createdAt: "2" },
    ],
  });
  check("the constraint does not persist into the next turn", followUpStayedClean);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAIL` : "all checks passed"}`);
if (failures) process.exitCode = 1;
