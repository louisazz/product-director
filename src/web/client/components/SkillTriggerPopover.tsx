import { useMemo } from "react";
import { ComposerPrimitive, type Unstable_TriggerItem } from "@assistant-ui/react";
import { Sparkles } from "lucide-react";
import type { SkillSummary } from "../types";

/**
 * Codex-style slash panel for explicitly invoking a Skill.
 *
 * Built on assistant-ui's trigger-popover primitives, which already own the
 * hard parts: detecting `/` only at a word boundary, filtering as the user
 * types, arrow-key navigation, Enter/Tab to pick, Escape to dismiss, and the
 * combobox ARIA wiring on the textarea.
 *
 * Picking a Skill rewrites the composer text to `/<skill-id>` but does not send
 * anything. It intentionally remains ordinary text rather than an attachment
 * chip; the backend reads the leading command when the user sends the message.
 */
export function SkillTriggerPopover({ skills }: { skills: SkillSummary[] }) {
  // The panel is a flat searchable list: with a handful of Skills, a category
  // level would add a keystroke without adding information.
  const adapter = useMemo(() => {
    const items: Unstable_TriggerItem[] = skills.map((skill) => ({
      id: skill.id,
      type: "skill",
      label: skill.id,
      description: skill.description || skill.title,
    }));
    return {
      categories: () => [],
      categoryItems: () => [],
      search: (query: string) => {
        const lower = query.trim().toLowerCase();
        if (!lower) return items;
        return items.filter((item) =>
          item.id.toLowerCase().includes(lower)
          || item.label.toLowerCase().includes(lower)
          || (item.description?.toLowerCase().includes(lower) ?? false),
        );
      },
    };
  }, [skills]);

  if (!skills.length) return null;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={adapter}
      className="skill-popover"
      aria-label="选择一个 Skill"
    >
      {/* `/skill-id ` is what the backend parses, so the serialized form must be
          the bare id — not the attachment directive syntax. */}
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        formatter={{
          serialize: (item) => `/${item.id}`,
          parse: (text) => [{ kind: "text", text }],
        }}
        onExecute={() => undefined}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="skill-popover-list">
        {(items) => items.length === 0
          ? <div className="skill-popover-empty">没有匹配的 Skill</div>
          : items.map((item) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              className="skill-popover-item"
              item={item}
              key={item.id}
            >
              <Sparkles size={14} />
              <span className="skill-popover-id">/{item.id}</span>
              {item.description && <span className="skill-popover-desc">{item.description}</span>}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
