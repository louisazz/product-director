import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS } from "../core/config.js";
import type { AgentMessage, ImageAttachmentRef } from "../core/agent-types.js";
import { SessionStore } from "../core/session.js";
import { buildWorkspaceContext } from "../core/workspace.js";
import { DeepSeekProvider } from "../model/deepseek-provider.js";
import { mapMessagesToOpenAI } from "../model/message-mapper.js";
import { persistIncomingAttachments, resolveSessionProvider } from "../web/server.js";

const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const root = path.join(projectRoot, ".tmp", "verify-vision-workspace");
let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}`);
  if (!ok) failures++;
};

try {
  fs.rmSync(root, { recursive: true, force: true });
  process.env.PRODUCT_DIRECTOR_WORKSPACE = root;
  const workspace = buildWorkspaceContext(process.cwd(), "default");
  const store = new SessionStore(workspace);

  check("V4.1 Flash is the product default", DEFAULT_SETTINGS.modelProvider === "deepseek-v4.1-flash" && DEFAULT_SETTINGS.model === "deepseek-flash");
  const visionProvider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-v4-flash-vision-exp" });
  const flash41Provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", providerName: "deepseek-v4.1-flash" });
  const proProvider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-v4-pro" });
  check("provider capabilities distinguish multimodal models from Pro", visionProvider.acceptsImages && flash41Provider.acceptsImages && !proProvider.acceptsImages);
  check("V4.1 Flash keeps its provider identity", flash41Provider.name === "deepseek-v4.1-flash");

  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const attachment: ImageAttachmentRef = {
    id: "image-1",
    name: "pixel.png",
    mimeType: "image/png",
    size: 68,
    relativePath: ".runtime/attachments/default/session/image-1.png",
    dataUrl,
  };
  const messages: AgentMessage[] = [{ id: "u1", role: "user", content: "看图", createdAt: new Date().toISOString(), attachments: [attachment] }];
  const visionMessage = mapMessagesToOpenAI(messages, { acceptsImages: true })[0] as any;
  const proMessage = mapMessagesToOpenAI(messages, { acceptsImages: false })[0] as any;
  check("Vision receives a real image content block", Array.isArray(visionMessage.content) && visionMessage.content.some((item: any) => item.type === "image_url"));
  check("Pro receives no image content block", typeof proMessage.content === "string" && proMessage.content.includes("无法读取图片内容"));

  const visionSession = store.createSession("vision-session", "vision");
  check("first message can lock a Session to Vision", resolveSessionProvider(visionSession, "deepseek-vision") === "deepseek-vision");
  store.saveSession(visionSession);
  const restoredVision = store.loadSession(visionSession.id)!;
  check("a locked Vision Session ignores later Pro selection", resolveSessionProvider(restoredVision, "deepseek-pro") === "deepseek-vision");

  const flash41Session = store.createSession("flash41-session", "flash41");
  check("first message can lock a Session to V4.1 Flash", resolveSessionProvider(flash41Session, "deepseek-v4.1-flash") === "deepseek-v4.1-flash");
  store.saveSession(flash41Session);
  check("V4.1 Flash Session lock persists", store.loadSession(flash41Session.id)?.modelProvider === "deepseek-v4.1-flash");

  const proSession = store.createSession("pro-session", "pro");
  check("first message can lock a Session to Pro", resolveSessionProvider(proSession, "deepseek-pro") === "deepseek-pro");
  store.saveSession(proSession);
  check("Pro Session lock persists", store.loadSession(proSession.id)?.modelProvider === "deepseek-pro");

  const imageSession = store.createSession("image-session", "image");
  imageSession.modelProvider = "deepseek-vision";
  const saved = await persistIncomingAttachments(workspace, imageSession.id, [{ id: "pixel", name: "pixel.png", mimeType: "image/png", dataUrl }]);
  const manyImages = Array.from({ length: 30 }, (_, index) => ({ id: `pixel-${index}`, name: `pixel-${index}.png`, mimeType: "image/png", dataUrl }));
  check("a Vision message accepts thirty images", (await persistIncomingAttachments(workspace, imageSession.id, manyImages)).length === 30);
  imageSession.turns.push({ userContent: "", modelProvider: "deepseek-vision", userAttachments: saved, events: [], status: "completed", finalAnswer: "一张图片" });
  store.saveSession(imageSession);
  const imagePath = path.resolve(workspace.paths.root, saved[0].relativePath);
  check("image attachment is persisted outside Session JSON", fs.existsSync(imagePath) && !fs.readFileSync(path.join(workspace.paths.sessionsDir, `${imageSession.id}.json`), "utf8").includes("base64"));
  store.deleteSession(imageSession.id);
  check("deleting a Session leaves the shared Project file intact", fs.existsSync(imagePath));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
