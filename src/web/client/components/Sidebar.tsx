import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight, Folder, KeyRound, MessageSquarePlus, Moon, MoreHorizontal, Pencil, Plus, Settings, Sun, Trash2, X } from "lucide-react";
import { api } from "../api";
import { PROJECT_STATUS_OPTIONS, type Project, type ProjectStatus, type SessionSummary, type ThemeName, type ApiKeyVendor } from "../types";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_STATUS_WIDTH = 320;
const SIDEBAR_WIDTH_KEY = "lazy:sidebar-width";
const EXPANDED_MONTHS_KEY = "lazy:expanded-project-months";

type Props = {
  projects: Project[];
  activeProjectId: string;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  generating: boolean;
  onProjectSelect: (id: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (project: Project, name: string) => Promise<void>;
  onProjectStatusChange: (project: Project, status: ProjectStatus) => Promise<void>;
  onDeleteProject: (project: Project) => Promise<void>;
  onNewSession: () => void;
  onSessionSelect: (id: string) => void;
  onDeleteSession: (id: string) => Promise<void>;
  runningSessionIds: string[];
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
};

export function Sidebar(props: Props) {
  const [dialog, setDialog] = useState<{ mode: "create" | "rename" | "delete"; project?: Project } | null>(null);
  const [keyDialog, setKeyDialog] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const [expandedMonths, setExpandedMonths] = useState(readExpandedMonths);
  const defaultProject = props.projects.find((project) => project.id === "default");
  const monthGroups = useMemo(() => {
    const groups = new Map<string, Project[]>();
    for (const project of props.projects) {
      if (project.id === "default") continue;
      const items = groups.get(project.month) || [];
      items.push(project);
      groups.set(project.month, items);
    }
    return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left));
  }, [props.projects]);

  useEffect(() => {
    const active = props.projects.find((project) => project.id === props.activeProjectId);
    if (!active || active.id === "default") return;
    setExpandedMonths((current) => current.has(active.month) ? current : new Set(current).add(active.month));
  }, [props.activeProjectId, props.projects]);

  useEffect(() => {
    localStorage.setItem(EXPANDED_MONTHS_KEY, JSON.stringify([...expandedMonths]));
  }, [expandedMonths]);

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => setSidebarWidth(clampSidebarWidth(event.clientX));
    const stop = () => setResizing(false);
    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.classList.remove("is-resizing-sidebar");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [resizing]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const toggleMonth = (month: string) => setExpandedMonths((current) => {
    const next = new Set(current);
    if (next.has(month)) next.delete(month); else next.add(month);
    return next;
  });

  const resizeByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const amount = event.shiftKey ? 32 : 16;
    let next = sidebarWidth;
    if (event.key === "ArrowLeft") next -= amount;
    else if (event.key === "ArrowRight") next += amount;
    else if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
    else if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
    else return;
    event.preventDefault();
    setSidebarWidth(clampSidebarWidth(next));
  };

  return (
    <aside
      className={`sidebar ${sidebarWidth < SIDEBAR_STATUS_WIDTH ? "compact-project-status" : ""}`}
      style={{ width: sidebarWidth } as CSSProperties}
    >
      <div className="brand-row"><div className="brand-mark">L</div><strong>Lazy</strong></div>
      <button className="new-chat-button" onClick={props.onNewSession}><MessageSquarePlus size={17} />新对话</button>

      <nav className="sidebar-scroll" aria-label="项目和最近对话">
        <section className="sidebar-section">
          <div className="section-heading"><span>项目</span><button className="section-action" aria-label="新建项目" onClick={() => setDialog({ mode: "create" })}><Plus size={15} /></button></div>
          <div className="project-list">
            {defaultProject && <ProjectRow project={defaultProject} active={defaultProject.id === props.activeProjectId} generating={props.generating} onSelect={props.onProjectSelect} onStatusChange={props.onProjectStatusChange} onDialog={setDialog} />}
            {monthGroups.map(([month, projects]) => {
              const open = expandedMonths.has(month);
              return <div className="project-month" key={month}>
                <button className="project-month-toggle" aria-expanded={open} aria-controls={`project-month-${month}`} onClick={() => toggleMonth(month)}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{month}</span>
                </button>
                {open && <div className="project-month-items" id={`project-month-${month}`}>
                  {projects.map((project) => <ProjectRow key={project.id} project={project} active={project.id === props.activeProjectId} generating={props.generating} onSelect={props.onProjectSelect} onStatusChange={props.onProjectStatusChange} onDialog={setDialog} />)}
                </div>}
              </div>;
            })}
          </div>
        </section>

        <section className="sidebar-section recent-section">
          <div className="section-heading"><span>最近</span></div>
          <div className="recent-list">
            {props.sessions.filter((session) => session.kind === "chat").slice(0, 40).map((session) => (
              <div className={`session-row ${session.id === props.activeSessionId ? "active" : ""}`} key={session.id}>
                <button className="session-select" onClick={() => props.onSessionSelect(session.id)}>
                  <span>{session.title || "未命名对话"}</span>
                  <small>{formatRelative(session.updatedAt)}</small>
                </button>
                <button className="session-delete" aria-label="删除对话" disabled={props.runningSessionIds.includes(session.id)} onClick={() => props.onDeleteSession(session.id)}><Trash2 size={13} /></button>
              </div>
            ))}
            {!props.sessions.some((session) => session.kind === "chat") && <div className="sidebar-empty">这个项目还没有对话</div>}
          </div>
        </section>
      </nav>

      <div className="sidebar-footer">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button className="settings-button"><Settings size={16} />设置</button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="menu-content settings-menu" side="top" sideOffset={7} align="start">
            <DropdownMenu.Item className="menu-item" onSelect={() => props.onThemeChange(props.theme === "dark" ? "light" : "dark")}>
              {props.theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}{props.theme === "dark" ? "切换白天模式" : "切换黑夜模式"}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => setKeyDialog(true)}><KeyRound size={14} />API Key</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <ProjectDialog
        state={dialog}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          if (!dialog) return;
          if (dialog.mode === "create") await props.onCreateProject(name);
          if (dialog.mode === "rename" && dialog.project) await props.onRenameProject(dialog.project, name);
          if (dialog.mode === "delete" && dialog.project) await props.onDeleteProject(dialog.project);
          setDialog(null);
        }}
      />
      <ApiKeyDialog open={keyDialog} onClose={() => setKeyDialog(false)} />
      <div
        className={`sidebar-resize-handle ${resizing ? "active" : ""}`}
        role="separator"
        aria-label="调整侧边栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => { event.preventDefault(); setResizing(true); }}
        onKeyDown={resizeByKeyboard}
      />
    </aside>
  );
}

function ProjectRow({ project, active, generating, onSelect, onStatusChange, onDialog }: {
  project: Project;
  active: boolean;
  generating: boolean;
  onSelect: (id: string) => void;
  onStatusChange: (project: Project, status: ProjectStatus) => Promise<void>;
  onDialog: (dialog: { mode: "create" | "rename" | "delete"; project?: Project }) => void;
}) {
  return <div className={`project-row ${active ? "active" : ""}`}>
    <button className="project-select" title={project.name} onClick={() => onSelect(project.id)}><Folder size={15} /><span>{project.name}</span></button>
    {project.id !== "default" && <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={`project-status ${project.status === "上线归档" ? "archived" : project.status === "hold" ? "hold" : ""}`} aria-label={`${project.name}状态：${project.status || "未设置"}`}>
          {project.status || "设置状态"}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content project-status-menu" sideOffset={6} align="end">
          {PROJECT_STATUS_OPTIONS.map((status, index) => <div key={status}>
            {index === PROJECT_STATUS_OPTIONS.length - 1 && <DropdownMenu.Separator className="menu-separator" />}
            <DropdownMenu.Item className="menu-item project-status-option" onSelect={() => { void onStatusChange(project, status).catch(() => {}); }}>
              <span className="menu-check">{project.status === status && <Check size={13} />}</span><span>{status}</span>
            </DropdownMenu.Item>
          </div>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button className="row-menu" aria-label={`${project.name}项目菜单`}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content" sideOffset={6} align="start">
          <DropdownMenu.Item className="menu-item" onSelect={() => onDialog({ mode: "rename", project })}><Pencil size={14} />重命名</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item danger" disabled={project.id === "default" || generating} onSelect={() => onDialog({ mode: "delete", project })}><Trash2 size={14} />删除项目</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}

const API_KEY_VENDORS: Array<{ id: ApiKeyVendor; label: string; hint: string }> = [
  { id: "deepseek", label: "DeepSeek", hint: "sk-…" },
  { id: "anthropic", label: "Claude", hint: "sk-ant-…" },
  { id: "openai", label: "OpenAI", hint: "sk-proj-…" },
];

function ApiKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [vendor, setVendor] = useState<ApiKeyVendor>("deepseek");
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = API_KEY_VENDORS.find((item) => item.id === vendor) ?? API_KEY_VENDORS[0];
  const refresh = (next: ApiKeyVendor) => {
    setVendor(next); setKey(""); setError("");
    void api.getApiKeyStatus(next).then((value) => setConfigured(value.configured)).catch(() => setConfigured(false));
  };
  return <Dialog.Root open={open} onOpenChange={(value) => { if (!value && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content" onOpenAutoFocus={() => refresh(vendor)}>
      <div className="dialog-title-row"><Dialog.Title>API Key</Dialog.Title><Dialog.Close asChild><button className="ghost-icon"><X size={17} /></button></Dialog.Close></div>
      <Dialog.Description className="dialog-description">Key 只保存在这台电脑的项目 .env 中，界面不会读取或显示已经保存的内容。每家模型各自一把 Key。</Dialog.Description>
      <label className="field-label">模型厂商<select value={vendor} disabled={busy} onChange={(event) => refresh(event.target.value as ApiKeyVendor)}>
        {API_KEY_VENDORS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label className="field-label">{current.label} API Key<input type="password" autoComplete="off" placeholder={configured ? "已配置；输入新 Key 可替换" : current.hint} value={key} onChange={(event) => setKey(event.target.value)} /></label>
      {error && <div className="dialog-error">{error}</div>}
      <div className="dialog-actions">
        {configured && <button className="danger-text-button" disabled={busy} onClick={async () => { setBusy(true); try { await api.deleteApiKey(vendor); setConfigured(false); setKey(""); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}>移除 Key</button>}
        <Dialog.Close asChild><button className="secondary-button" disabled={busy}>取消</button></Dialog.Close>
        <button className="primary-button" disabled={busy || !key.trim()} onClick={async () => { setBusy(true); setError(""); try { const result = await api.saveApiKey(vendor, key); setConfigured(result.configured); onClose(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }}>保存</button>
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

function ProjectDialog({ state, onClose, onSubmit }: {
  state: { mode: "create" | "rename" | "delete"; project?: Project } | null;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mode = state?.mode;
  const title = mode === "create" ? "新建项目" : mode === "rename" ? "重命名项目" : "删除项目";
  return (
    <Dialog.Root open={Boolean(state)} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" onOpenAutoFocus={(event) => {
          setName(mode === "rename" ? state?.project?.name || "" : "");
          setError("");
          if (mode === "delete") event.preventDefault();
        }}>
          <div className="dialog-title-row"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button className="ghost-icon" aria-label="关闭"><X size={17} /></button></Dialog.Close></div>
          {mode === "delete" ? (
            <Dialog.Description className="dialog-description">将永久删除“{state?.project?.name}”的项目文件、会话、进度和项目索引。通用 Memory 与 Skills 不受影响。</Dialog.Description>
          ) : (
            <>
              <Dialog.Description className="dialog-description">{mode === "create" ? "项目用于隔离文档、会话、进度和检索索引。" : "只修改显示名称，不改变项目 ID 和磁盘目录。"}</Dialog.Description>
              <label className="field-label">项目名称<input form="project-dialog-form" autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
            </>
          )}
          {error && <div className="dialog-error">{error}</div>}
          <form id="project-dialog-form" className="dialog-actions" onSubmit={async (event) => {
            event.preventDefault();
            const value = mode === "delete" ? state?.project?.name || "" : name.trim();
            if (!value) { setError("请输入项目名称。"); return; }
            setBusy(true); setError("");
            try { await onSubmit(value); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
          }}>
            <Dialog.Close asChild><button type="button" className="secondary-button" disabled={busy}>取消</button></Dialog.Close>
            <button type="submit" className={mode === "delete" ? "danger-button" : "primary-button"} disabled={busy}>{busy ? "处理中…" : mode === "delete" ? "删除项目" : "保存"}</button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function formatRelative(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function readSidebarWidth(): number {
  const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (stored === null) return 268;
  const value = Number(stored);
  return Number.isFinite(value) ? clampSidebarWidth(value) : 268;
}

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));
}

function readExpandedMonths(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(EXPANDED_MONTHS_KEY) || "null");
    if (Array.isArray(stored)) return new Set(stored.filter((value): value is string => typeof value === "string"));
  } catch {}
  const now = new Date();
  return new Set([`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`]);
}
