import { BookOpen, Brain, ChevronRight, FileText, Image as ImageIcon, MessageCircle, Paperclip, Search, Wrench } from "lucide-react";
import type { DataMessagePartProps } from "@assistant-ui/react";
import { buildTimeline, type TimelineAttachment, type TimelineTool } from "../timeline";
import type { TurnEvent } from "../types";

type TimelineData = { events: TurnEvent[]; status?: string };

export function TimelinePart({ data }: DataMessagePartProps<TimelineData>) {
  const entries = buildTimeline(data?.events || []);
  if (!entries.length) return null;
  return (
    <div className="agent-timeline" aria-label="执行过程">
      {entries.map((entry) => {
        if (entry.kind === "assistant_text") return <div className="timeline-assistant-text" key={entry.id}><MessageCircle size={14} /><div>{entry.body}</div></div>;
        if (entry.kind === "thinking") {
          return (
            <details className="timeline-item is-thinking" key={entry.id} open={entry.running}>
              <summary><Brain size={14} /><span>{entry.label}</span><ChevronRight className="timeline-chevron" size={14} /></summary>
              {entry.body && <pre className="timeline-body">{entry.body}</pre>}
            </details>
          );
        }
        if (entry.kind === "attachments") {
          return (
            <details className={`timeline-item is-context ${entry.ok ? "" : "is-error"}`} key={entry.id}>
              <summary><Paperclip size={14} /><span>{entry.label}</span><ChevronRight className="timeline-chevron" size={14} /></summary>
              <div className="timeline-body timeline-attachment-list">
                {entry.attachments.map((attachment, index) => <AttachmentRow attachment={attachment} key={`${attachment.label}-${attachment.name}-${index}`} />)}
              </div>
            </details>
          );
        }
        if (entry.kind === "tool_group") {
          return (
            <details className={`timeline-item is-tool is-tool-group ${entry.ok ? "" : "is-error"}`} key={entry.id}>
              <summary><ToolIcon category={entry.category} /><span>{entry.label}</span><ChevronRight className="timeline-chevron" size={14} /></summary>
              <div className="timeline-body timeline-tool-list">
                {entry.tools.map((tool) => <ToolRow tool={tool} key={tool.id} />)}
              </div>
            </details>
          );
        }
        const expandable = Boolean(entry.input || entry.result);
        return (
          <details className={`timeline-item is-tool ${entry.ok === false ? "is-error" : ""}`} key={entry.id}>
            <summary><ToolIcon category={entry.category} /><span>{entry.label}{entry.detail ? ` · ${entry.detail}` : ""}{entry.resultSummary ? ` · ${entry.resultSummary}` : ""}</span>{expandable && <ChevronRight className="timeline-chevron" size={14} />}</summary>
            {expandable && <ToolDetails tool={entry} />}
          </details>
        );
      })}
    </div>
  );
}

function ToolRow({ tool }: { tool: TimelineTool }) {
  const expandable = Boolean(tool.input || tool.result);
  if (!expandable) return <div className="timeline-tool-row"><ToolIcon category={tool.category} /><span>{tool.label}</span><strong>{tool.detail || "—"}</strong><small className={tool.ok === false ? "is-error" : ""}>{tool.running ? "进行中" : tool.resultSummary}</small></div>;
  return (
    <details className="timeline-tool-detail">
      <summary className="timeline-tool-row">
        <ToolIcon category={tool.category} />
        <span>{tool.label}</span>
        <strong>{tool.detail || "—"}</strong>
        <small className={tool.ok === false ? "is-error" : ""}>{tool.running ? "进行中" : tool.resultSummary}</small>
        <ChevronRight className="timeline-chevron" size={13} />
      </summary>
      <ToolDetails tool={tool} nested />
    </details>
  );
}

function ToolDetails({ tool, nested = false }: { tool: TimelineTool; nested?: boolean }) {
  return (
    <div className={nested ? "timeline-raw-detail" : "timeline-body timeline-raw-detail"}>
      {tool.input && <><strong>参数</strong><pre>{tool.input}</pre></>}
      {tool.result && <><strong>结果</strong><pre>{tool.result}</pre></>}
    </div>
  );
}

function AttachmentRow({ attachment }: { attachment: TimelineAttachment }) {
  return (
    <div className="timeline-attachment-row">
      {attachment.kind === "image" ? <ImageIcon size={15} /> : <FileText size={15} />}
      <span>{attachment.label}</span>
      <strong title={attachment.name}>{attachment.name}</strong>
      <small className={attachment.ok ? "" : "is-error"}>{attachment.detail}</small>
    </div>
  );
}

function ToolIcon({ category }: { category: TimelineTool["category"] }) {
  if (category === "search") return <Search size={14} />;
  if (category === "read") return <BookOpen size={14} />;
  return <Wrench size={14} />;
}
