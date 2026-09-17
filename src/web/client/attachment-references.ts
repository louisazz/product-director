import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
import type { ImageAttachmentRef } from "./types.js";

/** Resolve the durable attachment payload represented by recalled composer chips. */
export function resolveComposerRecalledAttachments(
  text: string,
  available: ImageAttachmentRef[],
): ImageAttachmentRef[] {
  const byId = new Map(available.map((attachment) => [attachment.id, attachment]));
  const ids = new Set(unstable_defaultDirectiveFormatter.parse(text).flatMap((segment) =>
    segment.kind === "mention" && (segment.type === "session-attachment" || segment.type === "project-attachment")
      ? [segment.id]
      : [],
  ));
  return [...ids].flatMap((id) => {
    const attachment = byId.get(id);
    return attachment ? [attachment] : [];
  });
}
