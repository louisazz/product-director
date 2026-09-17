/** Languages whose content can be rendered directly in a sandboxed iframe. */
const PREVIEWABLE = new Set(["html", "htm", "xhtml", "svg", "vue"]);

/**
 * Whether a fenced code block should offer a live preview.
 *
 * An explicit markup language always previews. A block with no language tag
 * only previews when its content clearly is a document or markup root, so
 * prose and loose fragments are not mistaken for renderable pages.
 */
export function isPreviewableCode(language: string, code: string): boolean {
  const normalized = language.trim().toLowerCase();
  if (PREVIEWABLE.has(normalized)) return true;
  if (normalized) return false;
  const head = code.trimStart().slice(0, 400).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<svg");
}
