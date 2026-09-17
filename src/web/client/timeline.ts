import type { TurnEvent } from "./types.js";

export type TimelineTool = {
  id: string;
  kind: "tool";
  toolName: string;
  category: "search" | "read" | "skill" | "other";
  label: string;
  detail?: string;
  input?: string;
  result?: string;
  resultSummary?: string;
  ok?: boolean;
  running: boolean;
};

export type TimelineAttachment = {
  label: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
  detail: string;
  ok: boolean;
};

export type TimelineEntry =
  | { id: string; kind: "thinking"; label: string; body: string; duration?: number; running: boolean }
  | { id: string; kind: "assistant_text"; body: string }
  | { id: string; kind: "attachments"; label: string; attachments: TimelineAttachment[]; ok: boolean }
  | TimelineTool
  | { id: string; kind: "tool_group"; category: "search" | "read"; label: string; tools: TimelineTool[]; running: boolean; ok: boolean };

const toolLabels: Record<string, string> = {
  read: "读取文件",
  read_doc: "读取文件",
  skill: "使用 Skill",
  read_skill: "使用 Skill",
  grep: "搜索 Memory",
  semantic_search: "语义搜索 Memory",
  glob: "查找 Memory",
  search_workspace: "搜索 Memory",
  list_docs: "查找 Memory",
};

export function buildTimeline(events: TurnEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let thinking: Extract<TimelineEntry, { kind: "thinking" }> | null = null;
  const toolsById = new Map<string, TimelineTool>();
  const pendingByName = new Map<string, TimelineTool[]>();

  events.forEach((event, index) => {
    const id = `${event.at || "event"}-${index}`;
    const data = event.data || {};
    switch (event.type) {
      case "attachments_loaded": {
        const attachments = Array.isArray(data.items)
          ? data.items.flatMap((item): TimelineAttachment[] => {
              if (!item || typeof item !== "object") return [];
              const value = item as Record<string, unknown>;
              return [{
                label: String(value.label || (value.kind === "image" ? "图片" : "文件")),
                name: String(value.name || "未命名附件"),
                mimeType: String(value.mimeType || ""),
                kind: value.kind === "image" ? "image" : "file",
                detail: String(value.detail || "已进入上下文"),
                ok: value.ok !== false,
              }];
            })
          : [];
        if (attachments.length) {
          entries.push({
            id,
            kind: "attachments",
            label: formatAttachmentLabel(attachments),
            attachments,
            ok: attachments.every((attachment) => attachment.ok),
          });
        }
        break;
      }
      case "thinking_start": {
        thinking = { id, kind: "thinking", label: "思考", body: "", running: true };
        entries.push(thinking);
        break;
      }
      case "reasoning_token": {
        const text = String(data.text || "");
        if (thinking) thinking.body += text;
        else if (text) appendAssistantText(entries, id, text);
        break;
      }
      case "thinking_end": {
        if (!thinking) break;
        const storedBody = String(data.bodyText || "");
        if (storedBody && !thinking.body) thinking.body = storedBody;
        thinking.duration = Number(data.duration || 0) || undefined;
        thinking.running = false;
        thinking.label = thinking.duration ? `思考（${formatDuration(thinking.duration)}）` : "思考";
        thinking = null;
        break;
      }
      case "assistant_text": {
        appendAssistantText(entries, id, String(data.text || ""));
        break;
      }
      case "tool_call": {
        const toolName = String(data.toolName || "tool");
        if (toolName === "todo_write") break;
        let input: Record<string, unknown> = {};
        if (data.input && typeof data.input === "object" && !Array.isArray(data.input)) {
          input = data.input as Record<string, unknown>;
        } else {
          try { input = JSON.parse(String(data.inputPreview || "{}")); } catch { input = {}; }
        }
        const detail = toolName === "read" || toolName === "read_doc" ? input.file_path || input.path
          : toolName === "skill" || toolName === "read_skill" ? input.name || input.skill || input.skill_id || input.id
          : toolName === "grep" || toolName === "search_workspace" ? input.pattern || input.query
          : toolName === "semantic_search" ? input.query
          : toolName === "glob" || toolName === "list_docs" ? input.pattern : undefined;
        const rawDetail = detail ? String(detail) : undefined;
        const tool: TimelineTool = {
          id,
          kind: "tool",
          toolName,
          category: toolCategory(toolName),
          label: displayToolLabel(toolName, rawDetail),
          detail: rawDetail ? displayToolDetail(toolName, rawDetail) : undefined,
          input: Object.keys(input).length ? JSON.stringify(input, null, 2) : undefined,
          running: true,
        };
        entries.push(tool);
        const callId = String(data.toolCallId || "");
        if (callId) toolsById.set(callId, tool);
        const queue = pendingByName.get(toolName) || [];
        queue.push(tool);
        pendingByName.set(toolName, queue);
        break;
      }
      case "tool_result": {
        const toolName = String(data.toolName || "tool");
        if (toolName === "todo_write") break;
        const callId = String(data.toolCallId || "");
        let tool = callId ? toolsById.get(callId) : undefined;
        if (!tool) tool = (pendingByName.get(toolName) || []).find((item) => item.running);
        if (!tool) {
          tool = { id, kind: "tool", toolName, category: toolCategory(toolName), label: toolLabels[toolName] || toolName, running: false };
          entries.push(tool);
        }
        tool.result = data.contentPreview ? String(data.contentPreview) : undefined;
        tool.ok = data.ok !== false;
        tool.resultSummary = summarizeToolResult(tool.toolName, tool.result, tool.ok);
        tool.running = false;
        break;
      }
    }
  });
  return groupConsecutiveTools(entries);
}

function appendAssistantText(entries: TimelineEntry[], id: string, text: string) {
  if (!text) return;
  const last = entries.at(-1);
  if (last?.kind === "assistant_text") last.body += text;
  else entries.push({ id, kind: "assistant_text", body: text });
}

function groupConsecutiveTools(entries: TimelineEntry[]): TimelineEntry[] {
  const grouped: TimelineEntry[] = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (entry.kind !== "tool" || (entry.category !== "read" && entry.category !== "search")) {
      grouped.push(entry);
      index++;
      continue;
    }
    const category = entry.category;
    const tools: TimelineTool[] = [];
    let cursor = index;
    while (cursor < entries.length) {
      const next = entries[cursor];
      if (next.kind !== "tool" || next.category !== category) break;
      tools.push(next);
      cursor++;
    }
    if (tools.length === 1) grouped.push(entry);
    else grouped.push({
      id: entry.id,
      kind: "tool_group",
      category,
      label: groupLabel(category, tools),
      tools,
      running: tools.some((tool) => tool.running),
      ok: tools.every((tool) => tool.ok !== false),
    });
    index = cursor;
  }
  return grouped;
}

function displayToolLabel(toolName: string, detail?: string): string {
  if ((toolName === "read" || toolName === "read_doc") && detail) {
    const normalized = detail.replace(/\\/g, "/");
    if (normalized === "memory" || normalized.startsWith("memory/")) return "读取 Memory";
    if (normalized === "skills" || normalized.startsWith("skills/")) return "读取 Skill 参考";
  }
  return toolLabels[toolName] || toolName;
}

function displayToolDetail(toolName: string, detail: string): string {
  if (toolName !== "read" && toolName !== "read_doc") return detail;
  return detail.replace(/\\/g, "/").replace(/^memory\//, "").replace(/^skills\//, "");
}

function summarizeToolResult(toolName: string, result: string | undefined, ok: boolean): string {
  if (!ok) return "失败";
  if (!result) return "完成";
  if (toolName === "read" || toolName === "read_doc") {
    const range = result.match(/^\[[^\]]+ lines (\d+)-(\d+) of (\d+)\]/);
    if (range) {
      const [, start, end, total] = range.map(Number);
      return start === 1 && end >= total ? `完整 · 共 ${total} 行` : `第 ${start}–${end} 行 · 共 ${total} 行`;
    }
    if (/offset \d+ is past the end/.test(result)) return "读取位置超出文件范围";
    return "已读取";
  }
  if (toolName === "glob" || toolName === "list_docs") {
    if (/^No files found\./.test(result)) return "未找到文件";
    const count = result.split("\n").filter((line) => line.trim() && !line.startsWith("[")).length;
    return count ? `找到 ${count} 个文件` : "完成";
  }
  if (toolName === "grep" || toolName === "search_workspace") {
    return /^No matches found\./.test(result) ? "未找到匹配" : "已找到结果";
  }
  if (toolName === "semantic_search") {
    if (/^No semantic matches found\./.test(result)) return "未找到相关内容";
    const count = result.match(/^\d+\./gm)?.length || 0;
    return count ? `找到 ${count} 段相关内容` : "已找到结果";
  }
  if (toolName === "skill" || toolName === "read_skill") return "已载入";
  return "完成";
}

function groupLabel(category: "search" | "read", tools: TimelineTool[]): string {
  if (category === "search") return `查找 Memory · ${tools.length} 次`;
  const labels = new Set(tools.map((tool) => tool.label));
  if (labels.size === 1 && labels.has("读取 Memory")) return `读取 Memory · ${tools.length} 个文件`;
  if (labels.size === 1 && labels.has("读取 Skill 参考")) return `读取 Skill 参考 · ${tools.length} 个文件`;
  return `读取 ${tools.length} 个文件`;
}

function formatAttachmentLabel(attachments: TimelineAttachment[]): string {
  const images = attachments.filter((attachment) => attachment.kind === "image").length;
  const files = attachments.length - images;
  const parts = [images ? `${images} 张图片` : "", files ? `${files} 个文件` : ""].filter(Boolean);
  return `载入 ${parts.join("、")}`;
}

function toolCategory(toolName: string): TimelineTool["category"] {
  if (toolName === "read" || toolName === "read_doc") return "read";
  if (["glob", "grep", "semantic_search", "search_workspace", "list_docs"].includes(toolName)) return "search";
  if (toolName === "skill" || toolName === "read_skill") return "skill";
  return "other";
}

function formatDuration(seconds: number) {
  if (seconds < 1) return "<1 秒";
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}
