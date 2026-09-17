import { isPreviewableCode } from "../web/client/preview-support.js";

let fail = 0;
function check(name: string, ok: boolean): void {
  console.log((ok ? "[PASS] " : "[FAIL] ") + name);
  if (!ok) fail++;
}

check("html 语言标记可预览", isPreviewableCode("html", "<div>hi</div>"));
check("svg 可预览", isPreviewableCode("svg", "<svg></svg>"));
check("无语言但完整文档可预览", isPreviewableCode("", "<!DOCTYPE html><html><body>x</body></html>"));
check("无语言但以 <html> 开头可预览", isPreviewableCode("", "<html><body>x</body></html>"));
check("无语言的裸 svg 可预览", isPreviewableCode("", "<svg viewBox='0 0 1 1'></svg>"));
check("python 不预览", !isPreviewableCode("python", "print(1)"));
check("typescript 不预览", !isPreviewableCode("typescript", "const a = 1;"));
check("无语言的普通中文文本不预览", !isPreviewableCode("", "这是一段说明文字\n第二行"));
check("无语言的 json 不预览", !isPreviewableCode("", '{"a":1}'));
check("大小写混写 HTML 可预览", isPreviewableCode("HTML", "<p>x</p>"));
check("无语言的裸 div 片段不预览（避免误判散文）", !isPreviewableCode("", "<div>x</div>"));

console.log("");
console.log(fail ? `${fail} 项失败` : "全部通过");
process.exit(fail ? 1 : 0);
