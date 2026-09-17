import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Files, MessageSquare, RotateCcw, X } from "lucide-react";
import { api } from "./api";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { FileWorkspace } from "./components/FileWorkspace";
import { ProgressView, RetrospectiveView } from "./components/ProjectViews";
import { Sidebar } from "./components/Sidebar";
import { DEFAULT_PROVIDER, type Project, type ProjectStatus, type ProviderName, type ThemeName, type ViewName } from "./types";

type ResidentChat = { key: string; projectId: string; sessionId: string };

export function App() {
  const queryClient = useQueryClient();
  const [initialSourceLink] = useState(readInitialSourceLink);
  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: ({ signal }) => api.listProjects({ signal }) });
  const [projectId, setProjectId] = useState(() => initialSourceLink?.projectId || localStorage.getItem("lazy:active-project") || "default");
  const [sessionId, setSessionIdState] = useState<string | null>(() => initialSourceLink?.sessionId || sessionStorage.getItem(sessionKey(projectId)));
  const [view, setView] = useState<ViewName>("chat");
  const [theme, setTheme] = useState<ThemeName>(() => document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [provider, setProvider] = useState<ProviderName>(DEFAULT_PROVIDER);
  const [runningChatKeys, setRunningChatKeys] = useState<Set<string>>(() => new Set());
  const [residentChats, setResidentChats] = useState<ResidentChat[]>([]);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);
  const [queuedPrompt, setQueuedPrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const [toast, setToast] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const projects = projectsQuery.data || [];
  const activeProject = projects.find((project) => project.id === projectId) || projects[0];
  const sessionsQuery = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: ({ signal }) => api.listSessions(projectId, signal),
    enabled: Boolean(projectId),
  });
  const sessions = sessionsQuery.data || [];
  const sessionExists = Boolean(sessionId && sessions.some((session) => session.id === sessionId));
  const activeSession = sessions.find((session) => session.id === sessionId);
  const activeChatKey = sessionId ? chatKey(projectId, sessionId) : null;
  const generating = runningChatKeys.size > 0;

  useEffect(() => {
    if (!projects.length || projects.some((project) => project.id === projectId)) return;
    selectProject(projects.find((project) => project.id === "default")?.id || projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    if (sessionsQuery.isLoading || sessionId) return;
    const preferred = sessions.find((session) => session.kind === "chat") || sessions[0];
    if (preferred) setSessionId(preferred.id);
    else newSession();
  }, [sessionId, sessions, sessionsQuery.isLoading]);

  useEffect(() => {
    if (activeSession?.modelProvider) setProvider(activeSession.modelProvider);
  }, [activeSession?.modelProvider]);

  useEffect(() => {
    if (!sessionId || !activeChatKey) return;
    setResidentChats((current) => {
      const kept = current.filter((chat) => chat.key === activeChatKey || runningChatKeys.has(chat.key));
      if (!kept.some((chat) => chat.key === activeChatKey)) kept.push({ key: activeChatKey, projectId, sessionId });
      return kept;
    });
  }, [activeChatKey, projectId, runningChatKeys, sessionId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const createProject = useMutation({
    mutationFn: (name: string) => api.createProject(name),
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(["projects"], (current = []) => [...current, project]);
      selectProject(project.id);
      setToast({ kind: "success", text: `已创建项目“${project.name}”` });
    },
  });
  const renameProject = useMutation({
    mutationFn: ({ project, name }: { project: Project; name: string }) => api.updateProject(project.id, name, project.description),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(["projects"], (current = []) => current.map((project) => project.id === updated.id ? updated : project));
      setToast({ kind: "success", text: "项目已重命名" });
    },
  });
  const updateProjectStatus = useMutation({
    mutationFn: ({ project, status }: { project: Project; status: ProjectStatus }) => api.updateProject(project.id, project.name, project.description, status),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(["projects"], (current = []) => current.map((project) => project.id === updated.id ? updated : project));
    },
    onError: (error) => setToast({ kind: "error", text: (error as Error).message || "项目状态更新失败" }),
  });
  const deleteProject = useMutation({
    mutationFn: (project: Project) => api.deleteProject(project.id).then(() => project),
    onSuccess: (deleted) => {
      queryClient.setQueryData<Project[]>(["projects"], (current = []) => current.filter((project) => project.id !== deleted.id));
      if (deleted.id === projectId) selectProject("default");
      queryClient.removeQueries({ queryKey: ["sessions", deleted.id] });
      setToast({ kind: "success", text: `已删除项目“${deleted.name}”` });
    },
  });
  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(projectId, id).then(() => id),
    onSuccess: (deletedId) => {
      queryClient.setQueryData(["sessions", projectId], sessions.filter((session) => session.id !== deletedId));
      if (sessionId === deletedId) newSession();
      setDeleteSessionId(null);
      setToast({ kind: "success", text: "对话已删除" });
    },
  });

  function selectProject(id: string) {
    setProjectId(id);
    localStorage.setItem("lazy:active-project", id);
    const remembered = sessionStorage.getItem(sessionKey(id));
    setSessionIdState(remembered);
    setQueuedPrompt(null);
    setView("chat");
  }

  function setSessionId(id: string | null) {
    setSessionIdState(id);
    const sessionModel = id ? sessions.find((session) => session.id === id)?.modelProvider : undefined;
    setProvider(sessionModel || DEFAULT_PROVIDER);
    if (id) sessionStorage.setItem(sessionKey(projectId), id);
    else sessionStorage.removeItem(sessionKey(projectId));
  }

  function newSession() {
    setProvider(DEFAULT_PROVIDER);
    setSessionId(`session-${Date.now()}`);
    setQueuedPrompt(null);
    setView("chat");
  }

  async function startRetrospective() {
    const result = await api.startRetrospective(projectId);
    await queryClient.invalidateQueries({ queryKey: ["sessions", projectId] });
    await queryClient.invalidateQueries({ queryKey: ["retrospectives", projectId] });
    setSessionId(result.session.id);
    setProvider(DEFAULT_PROVIDER);
    setQueuedPrompt({ sessionId: result.session.id, text: result.prompt });
    setView("chat");
  }

  const headerTitle = view === "files" ? "项目文件" : view === "chat" ? activeSession?.title || "新对话" : view === "progress" ? "项目进度" : "项目复盘";
  const tabs = useMemo(() => [
    { id: "chat" as const, label: "会话", icon: MessageSquare },
    { id: "progress" as const, label: "进度", icon: RotateCcw },
    { id: "retrospective" as const, label: "复盘", icon: Check },
  ], []);

  if (projectsQuery.isLoading) return <div className="app-loading"><div className="brand-mark">L</div><span>正在打开工作区…</span></div>;
  if (projectsQuery.error || !activeProject) return <div className="app-loading error">无法读取项目：{projectsQuery.error?.message || "没有可用项目"}</div>;

  return (
    <div className="app-shell">
      <Sidebar
        projects={projects}
        activeProjectId={projectId}
        sessions={sessions}
        activeSessionId={sessionId}
        generating={generating}
        onProjectSelect={selectProject}
        onCreateProject={async (name) => { await createProject.mutateAsync(name); }}
        onRenameProject={async (project, name) => { await renameProject.mutateAsync({ project, name }); }}
        onProjectStatusChange={async (project, status) => { await updateProjectStatus.mutateAsync({ project, status }); }}
        onDeleteProject={async (project) => { await deleteProject.mutateAsync(project); }}
        onNewSession={newSession}
        onSessionSelect={(id) => { setSessionId(id); setView("chat"); }}
        onDeleteSession={async (id) => { setDeleteSessionId(id); }}
        runningSessionIds={[...runningChatKeys].filter((key) => key.startsWith(`${projectId}:`)).map((key) => key.slice(projectId.length + 1))}
        theme={theme}
        onThemeChange={(value) => { setTheme(value); document.documentElement.dataset.theme = value; localStorage.setItem("lazy:theme", value); }}
      />
      <main className="main-panel">
        <header className="main-header">
          <div className="header-context"><span>{activeProject.name}</span><strong>{headerTitle}</strong></div>
          <div className="header-navigation" role="tablist">
            <button role="tab" aria-selected={view === "files"} className={`files-tab ${view === "files" ? "active" : ""}`} onClick={() => setView("files")}><Files size={14} />文件</button>
            <span className="tab-divider" />
            <div className="project-tabs">
              {tabs.map((tab) => <button role="tab" aria-selected={view === tab.id} className={view === tab.id ? "active" : ""} key={tab.id} onClick={() => setView(tab.id)}><tab.icon size={14} />{tab.label}</button>)}
            </div>
          </div>
        </header>
        <div className="main-content">
          {residentChats.map((chat) => {
            const active = chat.key === activeChatKey;
            return <div key={chat.key} className={`workspace-layer ${active && view === "chat" ? "is-active" : "is-background"}`} aria-hidden={!active || view !== "chat"}>
              <ChatWorkspace
                projectId={chat.projectId}
                sessionId={chat.sessionId}
                sessionExists={active ? sessionExists : true}
                provider={provider}
                onProviderChange={setProvider}
                onSessionId={(id) => { if (active) setSessionId(id); }}
                onRunningChange={(running) => setRunningChatKeys((current) => {
                  if (current.has(chat.key) === running) return current;
                  const next = new Set(current);
                  if (running) next.add(chat.key); else next.delete(chat.key);
                  return next;
                })}
                onNotice={(kind, text) => setToast({ kind, text })}
                queuedPrompt={queuedPrompt?.sessionId === chat.sessionId ? queuedPrompt : null}
                onQueuedPromptConsumed={() => setQueuedPrompt(null)}
                initialAnchorTurnIndex={initialSourceLink?.projectId === chat.projectId && initialSourceLink.sessionId === chat.sessionId ? initialSourceLink.turnIndex : undefined}
              />
            </div>;
          })}
          {view === "files" && <FileWorkspace
            projectId={projectId}
            onNotice={(kind, text) => setToast({ kind, text })}
          />}
          {view === "progress" && <ProgressView projectId={projectId} provider={provider} onOpenSession={(id) => { setSessionId(id); setView("chat"); }} />}
          {view === "retrospective" && <RetrospectiveView projectId={projectId} onOpenSession={(id) => { setSessionId(id); setView("chat"); }} onStart={startRetrospective} />}
        </div>
      </main>

      <Dialog.Root open={Boolean(deleteSessionId)} onOpenChange={(open) => { if (!open && !deleteSession.isPending) setDeleteSessionId(null); }}>
        <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"><div className="dialog-title-row"><Dialog.Title>删除对话</Dialog.Title><Dialog.Close asChild><button className="ghost-icon"><X size={17} /></button></Dialog.Close></div><Dialog.Description className="dialog-description">这个对话及其中的回答会被永久删除。此操作不会影响项目文档。</Dialog.Description><div className="dialog-actions"><Dialog.Close asChild><button className="secondary-button">取消</button></Dialog.Close><button className="danger-button" disabled={deleteSession.isPending} onClick={() => deleteSessionId && deleteSession.mutate(deleteSessionId)}>{deleteSession.isPending ? "正在删除" : "删除对话"}</button></div></Dialog.Content></Dialog.Portal>
      </Dialog.Root>

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === "success" ? <Check size={15} /> : <X size={15} />}{toast.text}</div>}
    </div>
  );
}

function sessionKey(projectId: string) { return `lazy:active-session:${projectId}`; }
function chatKey(projectId: string, sessionId: string) { return `${projectId}:${sessionId}`; }

function readInitialSourceLink(): { projectId: string; sessionId: string; turnIndex: number } | null {
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("projectId") || "";
  const sessionId = params.get("sessionId") || "";
  const turnIndex = Number(params.get("turn"));
  if (!projectId || !sessionId || !Number.isInteger(turnIndex) || turnIndex < 0) return null;
  return { projectId, sessionId, turnIndex };
}
