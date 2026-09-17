import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Code2, Copy, Eye } from "lucide-react";
import { isPreviewableCode } from "../preview-support.js";

interface CodeBlockProps {
  code: string;
  language: string;
  /** A streaming answer must not mount a preview until the block is complete. */
  streaming?: boolean;
}

export function CodeBlock({ code, language, streaming }: CodeBlockProps) {
  const previewable = useMemo(() => isPreviewableCode(language, code), [language, code]);
  // "auto" defers to the streaming state: code while generating, preview once
  // finished. An explicit click pins the mode so a late token cannot yank the
  // user back out of the tab they chose.
  const [pinnedMode, setPinnedMode] = useState<"preview" | "code" | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  // A new streaming block starts fresh: drop any pin from a previous render so
  // the automatic code→preview handoff applies again.
  useEffect(() => {
    if (streaming) setPinnedMode(null);
  }, [streaming]);

  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  const mode: "preview" | "code" = pinnedMode
    ?? (previewable && !streaming ? "preview" : "code");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const helper = document.createElement("textarea");
      helper.value = code;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      try { document.execCommand("copy"); } catch { /* clipboard unavailable */ }
      document.body.removeChild(helper);
    }
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const showPreview = previewable && mode === "preview" && !streaming;

  return (
    <div className="code-block" data-mode={showPreview ? "preview" : "code"}>
      <div className="code-block-bar">
        <span className="code-block-lang">{language || (previewable ? "html" : "text")}</span>
        <div className="code-block-actions">
          {previewable && !streaming && (
            <div className="code-block-toggle" role="group" aria-label="切换预览与代码">
              <button
                type="button"
                className={mode === "preview" ? "is-active" : ""}
                aria-pressed={mode === "preview"}
                onClick={() => setPinnedMode("preview")}
              >
                <Eye size={12} />预览
              </button>
              <button
                type="button"
                className={mode === "code" ? "is-active" : ""}
                aria-pressed={mode === "code"}
                onClick={() => setPinnedMode("code")}
              >
                <Code2 size={12} />代码
              </button>
            </div>
          )}
          <button type="button" className="code-block-copy" onClick={copy} aria-label="复制代码">
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      {showPreview
        ? <HtmlPreview code={code} />
        : <pre className="code-block-pre"><code>{code}</code></pre>}
    </div>
  );
}

/**
 * Renders untrusted model output in a sandboxed iframe. `allow-scripts` without
 * `allow-same-origin` keeps the document in an opaque origin, so it cannot read
 * cookies, localStorage or the parent DOM of the Lazy app itself.
 */
function HtmlPreview({ code }: { code: string }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(320);

  const document_ = useMemo(() => wrapHtml(code), [code]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: string; height?: number };
      if (data?.type !== "lazy-preview-height" || typeof data.height !== "number") return;
      setHeight(Math.max(120, Math.min(1200, Math.ceil(data.height))));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frame}
      className="code-block-preview"
      title="HTML 预览"
      sandbox="allow-scripts allow-popups allow-forms"
      srcDoc={document_}
      style={{ height }}
    />
  );
}

/** Wrap a fragment into a full document and report its height to the parent. */
function wrapHtml(code: string): string {
  const trimmed = code.trim();
  const isFullDocument = /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
  const reporter = `<script>(function(){
    var report=function(){try{parent.postMessage({type:"lazy-preview-height",height:document.documentElement.scrollHeight},"*")}catch(e){}};
    window.addEventListener("load",report);
    window.addEventListener("resize",report);
    if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement)}
    setTimeout(report,80);setTimeout(report,400);
  })();</script>`;
  const baseStyle = `<style>
    :root{color-scheme:light}
    body{margin:0;padding:14px;background:#fff;color:#242421;
      font-family:Inter,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
      font-size:14px;line-height:1.6}
    img,svg,video,canvas{max-width:100%}
  </style>`;

  if (isFullDocument) {
    // Inject the reporter before </body> so the author's own document stays intact.
    return trimmed.includes("</body>")
      ? trimmed.replace("</body>", `${reporter}</body>`)
      : `${trimmed}${reporter}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${baseStyle}</head><body>${trimmed}${reporter}</body></html>`;
}
