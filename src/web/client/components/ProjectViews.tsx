import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import type { ProviderName } from "../types";

export function ProgressView({ projectId, provider, onOpenSession }: { projectId: string; provider: ProviderName; onOpenSession: (id: string) => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["progress", projectId], queryFn: ({ signal }) => api.getProgress(projectId, signal) });
  const update = useMutation({
    mutationFn: () => api.updateProgress(projectId, provider),
    onSuccess: (progress) => queryClient.setQueryData(["progress", projectId], progress),
  });
  const progress = query.data;
  return (
    <div className="project-view">
      <div className="project-view-heading"><div><span className="eyebrow">PROJECT PULSE</span><h2>项目进度</h2><p>基于这个项目的会话结果，生成一份可阅读的滚动总结。</p></div><button className="primary-button" disabled={update.isPending} onClick={() => update.mutate()}><RefreshCw className={update.isPending ? "spin" : ""} size={15} />{update.isPending ? "正在总结" : "更新进度"}</button></div>
      {query.isLoading ? <ViewSkeleton /> : update.error ? <ViewError message={update.error.message} /> : progress ? (
        <article className="document-card">
          <div className="document-meta">更新于 {new Date(progress.generatedAt).toLocaleString("zh-CN")} · 覆盖 {progress.coveredSessions.length} 个会话</div>
          <div className="markdown-body document-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{progress.content}</ReactMarkdown></div>
          {progress.coveredSessions.length > 0 && <div className="source-sessions"><strong>来源会话</strong>{progress.coveredSessions.map((session) => <button key={session.id} onClick={() => onOpenSession(session.id)}><span>{session.title}</span><ArrowRight size={14} /></button>)}</div>}
        </article>
      ) : (
        <div className="view-empty"><div className="empty-icon"><RefreshCw size={20} /></div><h3>还没有项目进度</h3><p>点击“更新进度”，Lazy 会汇总当前项目的会话。普通对话不会自动读取这份总结。</p></div>
      )}
    </div>
  );
}

export function RetrospectiveView({ projectId, onOpenSession, onStart }: { projectId: string; onOpenSession: (id: string) => void; onStart: () => Promise<void> }) {
  const query = useQuery({ queryKey: ["retrospectives", projectId], queryFn: ({ signal }) => api.listRetrospectives(projectId, signal) });
  const start = useMutation({ mutationFn: onStart });
  return (
    <div className="project-view">
      <div className="project-view-heading"><div><span className="eyebrow">LEARNING LOOP</span><h2>项目复盘</h2><p>回看关键转折、有效判断和可迁移经验，并继续追问。</p></div><button className="primary-button" disabled={start.isPending} onClick={() => start.mutate()}><Sparkles size={15} />{start.isPending ? "正在开始" : "开始复盘"}</button></div>
      {start.error && <ViewError message={start.error.message} />}
      {query.isLoading ? <ViewSkeleton /> : query.data?.length ? (
        <div className="retrospective-grid">{query.data.map((session) => <button className="retrospective-card" key={session.id} onClick={() => onOpenSession(session.id)}><span className="eyebrow">RETROSPECTIVE</span><strong>{session.title || "项目复盘"}</strong><small>{session.messageCount} 轮 · {new Date(session.updatedAt).toLocaleDateString("zh-CN")}</small><ArrowRight size={16} /></button>)}</div>
      ) : (
        <div className="view-empty"><div className="empty-icon"><Sparkles size={20} /></div><h3>还没有复盘</h3><p>每次复盘都会创建一个独立会话，并显式使用 project-retrospective Skill。</p></div>
      )}
    </div>
  );
}

function ViewSkeleton() { return <div className="document-card skeleton-card"><span /><span /><span /><span /></div>; }
function ViewError({ message }: { message: string }) { return <div className="view-error">{message}</div>; }
