import type { Unstable_TriggerMatcher } from "@assistant-ui/react";

/**
 * Decides whether an `@` in the composer is a live attachment mention.
 *
 * Kept apart from the React component so the boundary rules stay verifiable
 * from plain Node (see `verify-attachments`) without pulling JSX into the
 * server-side type check.
 *
 * The rules exist because a stale match is not merely cosmetic: the picker is
 * anchored to an active trigger, so a match that never closes leaves an empty
 * panel floating over the transcript.
 */
export const attachmentTriggerMatcher: Unstable_TriggerMatcher = (text, trigger, cursorPosition) => {
  const beforeCursor = text.slice(0, cursorPosition);
  const offset = beforeCursor.lastIndexOf(trigger);
  if (offset < 0) return null;
  // Each @ count owns one scope. A shorter trigger must not capture the tail of
  // @@ or @@@, regardless of component registration order.
  if (beforeCursor[offset - 1] === "@" || beforeCursor[offset + trigger.length] === "@") return null;
  // `user@example.com` is an address, not a mention. An attachment reference
  // follows prose or starts a line, so a latin word character immediately
  // before `@` rules it out. CJK stays eligible: `先看@图1` is a real mention.
  if (/[A-Za-z0-9._-]/.test(beforeCursor[offset - 1] || "")) return null;
  const query = beforeCursor.slice(offset + trigger.length);
  // Whitespace or sentence punctuation means the user has moved on from the
  // mention. File names remain visible in the picker; typing the stable 图N / 文件N
  // label is the fast path and never depends on a clean original filename.
  if (!/^[\p{L}\p{N}._-]*$/u.test(query)) return null;
  // Chinese prose has no word breaks, so a literal `@` mid-sentence would keep
  // the trigger alive for the rest of the paragraph. A real query is a label
  // (图1) or the start of a filename, never a clause. Filenames stay reachable
  // because the picker also matches on a short prefix.
  if (query.length > 12) return null;
  return { query, offset, endOffset: cursorPosition };
};
