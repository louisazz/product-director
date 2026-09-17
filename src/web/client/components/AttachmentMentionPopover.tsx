import { useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContextOptional,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { FileText } from "lucide-react";
import type { ImageAttachmentRef } from "../types";
import { attachmentTriggerMatcher } from "../attachment-trigger";

export { attachmentTriggerMatcher };

type AttachmentMentionScope = "current" | "session" | "project";

export function AttachmentMentionPopover({
  attachments,
  trigger,
  scope,
  currentSessionId,
  onInserted,
}: {
  attachments: ImageAttachmentRef[];
  trigger: "@" | "@@" | "@@@";
  scope: AttachmentMentionScope;
  currentSessionId?: string | null;
  onInserted?: (attachment: ImageAttachmentRef) => void;
}) {
  const byId = useMemo(() => new Map(attachments.map((attachment) => [attachment.id, attachment])), [attachments]);
  const adapter = useMemo(() => {
    const items: Unstable_TriggerItem[] = attachments.map((attachment) => ({
      id: attachment.id,
      type: scope === "current" ? "attachment" : scope === "session" ? "session-attachment" : "project-attachment",
      label: `${attachment.label || attachment.name}${sourceSuffix(attachment, currentSessionId)}`,
      description: attachment.name,
    }));
    return {
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        const normalized = query.trim().toLocaleLowerCase();
        if (!normalized) return items;
        return items.filter((item) => {
          const attachment = byId.get(item.id);
          return item.label.toLocaleLowerCase().includes(normalized)
            || Boolean(attachment?.name.toLocaleLowerCase().includes(normalized))
            || Boolean(attachment?.sourceSessionTitle?.toLocaleLowerCase().includes(normalized));
        });
      },
    };
  }, [attachments, byId, currentSessionId, scope]);

  const scopeLabel = scope === "current" ? "本轮附件" : scope === "session" ? "当前对话" : "当前项目";

  // An empty scope has nothing to offer, and `@` is ordinary punctuation in
  // Chinese prose. Registering the trigger anyway produced a bare header
  // floating over the transcript. Matching SkillTriggerPopover, the trigger
  // simply does not exist until this scope holds an attachment.
  if (!attachments.length) return null;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char={trigger}
      matcher={attachmentTriggerMatcher}
      adapter={adapter}
      aria-label={`${trigger} ${scopeLabel}`}
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive
        formatter={unstable_defaultDirectiveFormatter}
        onInserted={(item) => {
          const attachment = byId.get(item.id);
          if (attachment) onInserted?.(attachment);
        }}
      />
      <CaretPopoverSurface>
        <div className="attachment-mention-heading"><strong>{scopeLabel}</strong><span>{trigger}</span></div>
        <ComposerPrimitive.Unstable_TriggerPopoverItems className="attachment-mention-list">
          {(items) => items.length === 0
            ? <div className="attachment-mention-empty">没有匹配的附件</div>
            : items.map((item, index) => {
                const attachment = byId.get(item.id);
                if (!attachment) return null;
                const image = attachment.kind === "image" || attachment.mimeType.startsWith("image/");
                return (
                  <ComposerPrimitive.Unstable_TriggerPopoverItem
                    className="attachment-mention-item"
                    item={item}
                    index={index}
                    key={item.id}
                  >
                    {image
                      ? <img src={attachment.previewUrl || attachment.dataUrl} alt="" />
                      : <span className="attachment-mention-file"><FileText size={18} /></span>}
                    <span className="attachment-mention-copy">
                      <strong title={`${attachment.label || attachment.name}${sourceSuffix(attachment, currentSessionId)}`}>
                        <span>{attachment.label || attachment.name}</span>
                        {sourceSuffix(attachment, currentSessionId) && <em>{sourceSuffix(attachment, currentSessionId).replace(/^ · /, "")}</em>}
                      </strong>
                      <small>{attachment.name}</small>
                    </span>
                  </ComposerPrimitive.Unstable_TriggerPopoverItem>
                );
              })}
        </ComposerPrimitive.Unstable_TriggerPopoverItems>
      </CaretPopoverSurface>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

function sourceSuffix(attachment: ImageAttachmentRef, currentSessionId?: string | null): string {
  if (!attachment.referenceScope) return "";
  if (attachment.sourceSessionId && attachment.sourceSessionId === currentSessionId) return " · 来自本对话";
  const title = (attachment.sourceSessionTitle || "已删除的对话")
    .replace(/[\]\[{}\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ` · 来自「${title}」`;
}

/**
 * A portal keeps the transient picker out of document flow, so it never moves
 * the composer.
 *
 * `TriggerPopover` renders its children even while closed — it only drops the
 * `role="listbox"` wrapper. `TriggerPopoverItems` guards itself with its own
 * `open` check, so leaving this surface ungated produced a header-only ghost
 * panel pinned above the composer. The scope context is the authoritative
 * signal, so read it here rather than inferring state from the caret.
 */
function CaretPopoverSurface({ children }: { children: React.ReactNode }) {
  const scope = unstable_useTriggerPopoverScopeContextOptional();
  const open = scope?.open ?? false;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const input = document.querySelector<HTMLElement>(".composer-input .aui-lexical-input");
      // Without a composer there is nothing to anchor to. Selecting answer text
      // moves the document selection into the transcript, and anchoring there
      // would float the picker over the conversation.
      if (!input) return setStyle({ visibility: "hidden" });

      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const caretInsideComposer = Boolean(range && input.contains(range.startContainer));
      const caretRect = caretInsideComposer ? range!.getBoundingClientRect() : null;
      const rect = caretRect && (caretRect.width || caretRect.height) ? caretRect : input.getBoundingClientRect();

      const width = Math.min(390, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const openAbove = rect.top > 250;
      setStyle({
        position: "fixed",
        zIndex: 1400,
        width,
        left,
        top: openAbove ? Math.max(12, rect.top - 8) : Math.min(window.innerHeight - 12, rect.bottom + 8),
        transform: openAbove ? "translateY(-100%)" : undefined,
      });
    };
    place();
    document.addEventListener("selectionchange", place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("selectionchange", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(<div className="attachment-mention-surface" style={style}>{children}</div>, document.body);
}
