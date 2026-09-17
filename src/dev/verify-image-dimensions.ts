import fs from "node:fs";
import path from "node:path";
import {
  exceedsSideLimit,
  MAX_IMAGE_SIDE,
  maxSideForImageCount,
  readImageDimensions,
} from "../core/image-dimensions.js";

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}`);
  if (!ok) failures++;
};

// 1x1 fixtures built by hand so the suite does not depend on session data.
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const gif1x1 = Buffer.from("R0lGODdhAQABAIAAAAAAAAAAACwAAAAAAQABAAACAkQBADs=", "base64");

const png = readImageDimensions(png1x1);
check("PNG 尺寸解析", png?.width === 1 && png?.height === 1);

const gif = readImageDimensions(gif1x1);
check("GIF 尺寸解析", gif?.width === 1 && gif?.height === 1);

check("非图片返回 null", readImageDimensions(Buffer.from("not an image at all")) === null);
check("截断的 PNG 头返回 null", readImageDimensions(png1x1.subarray(0, 10)) === null);

check("边界内不触发", !exceedsSideLimit({ width: 8192, height: 8192 }, MAX_IMAGE_SIDE));
check("超一像素即触发", exceedsSideLimit({ width: 8192, height: 8193 }, MAX_IMAGE_SIDE));
check("单张时上限 8192", maxSideForImageCount(1) === 8192);
check("14 张时仍为 8192", maxSideForImageCount(14) === 8192);
check("15 张时降为 4096", maxSideForImageCount(15) === 4096);

// Cross-check against whatever real attachments exist locally; skipped in a
// clean clone, where the runtime directory is absent by design.
const attachmentsRoot = "workspace/.runtime/attachments";
const realFiles: string[] = [];
const walk = (dir: string) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(png|jpe?g|gif|webp)$/i.test(entry.name)) realFiles.push(full);
  }
};
walk(attachmentsRoot);

if (!realFiles.length) {
  console.log("[SKIP] 本机无真实附件，跳过实拍图校验");
} else {
  let parsed = 0;
  let oversized = 0;
  for (const file of realFiles) {
    const size = readImageDimensions(fs.readFileSync(file));
    if (size && size.width > 0 && size.height > 0) parsed++;
    else console.log(`  未能解析: ${file}`);
    if (size && exceedsSideLimit(size, MAX_IMAGE_SIDE)) {
      oversized++;
      console.log(`  超限: ${path.basename(file)} ${size.width}x${size.height}`);
    }
  }
  check(`真实附件全部可解析（${parsed}/${realFiles.length}）`, parsed === realFiles.length);
  console.log(`  其中超出 ${MAX_IMAGE_SIDE} px 的有 ${oversized} 张`);
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
