import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceContext, createRuntime, runRuntime } from "../core/index.js";
import { ScriptedToolUseModelProvider } from "../model/index.js";
import { createDefaultToolRegistry } from "../tools/builtins.js";
import {
  PermissionManager,
  AutoDenyConfirmationProvider,
} from "../permissions/index.js";
import type { DirectorSettings } from "../core/types.js";
import { DEFAULT_SETTINGS } from "../core/config.js";

function getProjectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.dirname(path.dirname(path.dirname(thisFile)));
}

const TMP_WORKSPACE = path.join(getProjectRoot(), ".tmp", "smoke-permissions-workspace");

function makeSettings(permissions: DirectorSettings["permissions"]): DirectorSettings {
  return { ...DEFAULT_SETTINGS, permissions };
}

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail: string) {
  if (condition) {
    console.log(`  [PASS] ${name}: ${detail}`);
    pass++;
  } else {
    console.log(`  [FAIL] ${name}: ${detail}`);
    fail++;
  }
}

async function main(): Promise<void> {
  if (fs.existsSync(TMP_WORKSPACE)) {
    fs.rmSync(TMP_WORKSPACE, { recursive: true, force: true });
  }
  process.env.PRODUCT_DIRECTOR_WORKSPACE = TMP_WORKSPACE;

  const workspace = buildWorkspaceContext(process.cwd());
  console.log(`[smoke:permissions] workspace=${workspace.paths.root}`);

  console.log("=".repeat(60));
  console.log("Smoke test: Permission Manager");
  console.log("=".repeat(60));

  const toolRegistry = createDefaultToolRegistry();

  // ─── Test 1: allow (glob with read=allow) ─────────────────────
  console.log("\n--- Test 1: allow (read) ---");
  {
    const settings = makeSettings({
      read: "allow",
      directorUpdate: "deny",
      delete: "deny",
      externalAction: "deny",
    });

    const pm = new PermissionManager(settings, new AutoDenyConfirmationProvider());
    const provider = new ScriptedToolUseModelProvider({ toolName: "glob", input: { pattern: "docs/**/*" } });
    const runtime = createRuntime(workspace, provider, toolRegistry, pm);
    const result = await runRuntime(runtime, "test allow");

    const toolStep = result.agentRun.steps.find((s) => s.toolResults.length > 0);
    const tr = toolStep?.toolResults[0];

    check("allow: tool executed", tr?.ok === true, `ok=${tr?.ok}`);
    check("allow: permission metadata", tr?.permission?.level === "allow", `level=${tr?.permission?.level}`);
    check("allow: category", tr?.permission?.category === "read", `category=${tr?.permission?.category}`);
    check("allow: allowed", tr?.permission?.allowed === true, `allowed=${tr?.permission?.allowed}`);
  }

  // ─── Test 2: PermissionManager.check() directly ────────────────────
  console.log("\n--- Test 2: PermissionManager.check() directly ---");
  {
    const settings = makeSettings({
      read: "allow",
      directorUpdate: "deny",
      delete: "deny",
      externalAction: "deny",
    });

    const pm = new PermissionManager(settings, new AutoDenyConfirmationProvider());

    const readTool = toolRegistry.get("glob")!;
    const d1 = pm.check(readTool, {});
    check("direct: read→allow", d1.allowed && !d1.requiresConfirmation, `allowed=${d1.allowed}, reqConf=${d1.requiresConfirmation}`);

    const deleteSettings: DirectorSettings = { ...settings, permissions: { ...settings.permissions, read: "deny" } };
    const pm2 = new PermissionManager(deleteSettings, new AutoDenyConfirmationProvider());
    const d4 = pm2.check(readTool, {});
    check("direct: read→deny", !d4.allowed && !d4.requiresConfirmation, `allowed=${d4.allowed}, reqConf=${d4.requiresConfirmation}`);
  }

  // ─── Test 3: runtime default allows read tools ─────────────────────
  console.log("\n--- Test 3: runtime default allows read tools ---");
  {
    const provider = new ScriptedToolUseModelProvider({ toolName: "glob", input: { pattern: "docs/**/*" } });
    const runtime = createRuntime(workspace, provider, toolRegistry);
    const result = await runRuntime(runtime, "test runtime allow");

    const toolStep = result.agentRun.steps.find((s) => s.toolResults.length > 0);
    const tr = toolStep?.toolResults[0];

    check("runtime-allow: tool executed", tr?.ok === true, `ok=${tr?.ok}`);
    check("runtime-allow: permission level", tr?.permission?.level === "allow", `level=${tr?.permission?.level}`);
    check("runtime: permissionManager exists", runtime.permissionManager != null, `pm=${runtime.permissionManager.constructor.name}`);
  }

  // ─── Cleanup temp workspace ────────────────────────────────────────
  try {
    fs.rmSync(TMP_WORKSPACE, { recursive: true, force: true });
    console.log(`[smoke:permissions] cleaned up temp workspace`);
  } catch { /* skip */ }

  // ─── Summary ───────────────────────────────────────────────────────
  console.log();
  console.log("=".repeat(60));
  console.log(`Results: ${pass} PASS, ${fail} FAIL`);
  console.log("=".repeat(60));

  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
