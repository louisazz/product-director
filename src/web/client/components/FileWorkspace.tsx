import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, FileText, FolderOpen, Paperclip } from "lucide-react";
import { api } from "../api";
import type { ProjectFile } from "../types";
import { ImageLightbox } from "./ImageLightbox";

export function FileWorkspace(props: {
  projectId: string;
  onNotice: (kind: "success" | "error", text: string) => void;
}) {
  const [menu, setMenu] = useState<{ file: ProjectFile; x: number; y: number } | null>(null);
  const [openImageIndex, setOpenImageIndex] = useState<number | null>(null);
  const filesQuery = useQuery({
    queryKey: ["project-files", props.projectId],
    queryFn: ({ signal }) => api.listProjectFiles(props.projectId, signal),
  });

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, []);

  async function runFileAction(action: "open" | "reveal" | "copy", file: ProjectFile) {
    setMenu(null);
    try {
      if (action === "copy") {
        await copyText(file.absolutePath);
        props.onNotice("success", "已复制文件路径");
      } else {
        await api.openProjectFile(props.projectId, file, action);
        props.onNotice("success", action === "reveal" ? "已打开文件所在文件夹" : "正在用系统默认应用打开");
      }
    } catch (error) { props.onNotice("error", (error as Error).message); }
  }

  const files = filesQuery.data || [];
  const images = files.filter((file) => file.mimeType.startsWith("image/"));
  const lightboxImages = images.map((file) => ({ id: file.fileId, name: file.name, url: fileContentUrl(props.projectId, file.fileId) }));
  const imageIndexById = new Map(images.map((file, index) => [file.fileId, index]));
  return <div className="file-workspace">
    <div className="project-view-heading file-heading">
      <div><span className="eyebrow">PROJECT FILES</span><h2>项目文件</h2><p>这里被动保存这个项目各次对话上传过的原文件。新对话不会自动读取它们。</p></div>
    </div>
    <div className={`file-dropzone${files.length ? " has-files" : ""}`}>
      {filesQuery.isLoading ? <div className="file-empty">正在读取项目文件…</div> : files.length ? <>
        <div className="file-grid-summary">{files.length} 个文件</div>
        <ul className="file-card-grid">
          {files.map((file) => {
            const image = file.mimeType.startsWith("image/");
            return <li key={file.fileId}>
              <button
                className="file-card"
                type="button"
                aria-label={`${image ? "预览" : "打开"} ${file.name}`}
                onClick={() => image ? setOpenImageIndex(imageIndexById.get(file.fileId) ?? 0) : void runFileAction("open", file)}
                onContextMenu={(event) => { event.preventDefault(); setMenu({ file, x: event.clientX, y: event.clientY }); }}
              >
                <span className={`file-card-preview${image ? " is-image" : ""}`}>
                  {image
                    ? <img src={fileContentUrl(props.projectId, file.fileId)} alt="" loading="lazy" decoding="async" />
                    : <span className="file-card-file-icon"><FileText size={30} /><small>{fileExtension(file.name)}</small></span>}
                </span>
                <span className="file-card-copy">
                  <strong title={file.name}>{file.name}</strong>
                  <small>{[file.pageCount ? `${file.pageCount} 页` : "", formatDate(file.updatedAt), formatSize(file.size)].filter(Boolean).join(" · ")}</small>
                </span>
              </button>
            </li>;
          })}
        </ul>
      </> : <div className="file-empty"><Paperclip size={30} /><strong>还没有项目文件</strong><span>在对话里上传图片或文件后，它们会自动出现在这里。</span></div>}
    </div>
    {menu && <div className="file-context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 140) }} onClick={(event) => event.stopPropagation()}>
      <button onClick={() => void runFileAction("open", menu.file)}><FileText size={14} />打开</button>
      <button onClick={() => void runFileAction("reveal", menu.file)}><FolderOpen size={14} />打开所在文件夹</button>
      <button onClick={() => void runFileAction("copy", menu.file)}><Copy size={14} />复制路径</button>
    </div>}
    {openImageIndex !== null && <ImageLightbox images={lightboxImages} index={openImageIndex} onIndexChange={setOpenImageIndex} onClose={() => setOpenImageIndex(null)} />}
  </div>;
}

function formatSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatDate(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function fileContentUrl(projectId: string, fileId: string) { return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`; }
function fileExtension(name: string) { return name.includes(".") ? name.split(".").pop()!.slice(0, 6).toUpperCase() : "FILE"; }

async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); return; } catch {
    const textarea = document.createElement("textarea"); textarea.value = value; textarea.style.position = "fixed"; textarea.style.opacity = "0";
    document.body.appendChild(textarea); textarea.select(); const copied = document.execCommand("copy"); textarea.remove();
    if (!copied) throw new Error("无法访问系统剪贴板。");
  }
}
