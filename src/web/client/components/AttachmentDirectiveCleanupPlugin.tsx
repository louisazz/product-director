import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, type LexicalNode } from "lexical";
import { $isDirectiveNode } from "@assistant-ui/react-lexical";

/** Removes only textual references whose draft attachment was explicitly removed. */
export function AttachmentDirectiveCleanupPlugin({ validAttachmentIds }: { validAttachmentIds: ReadonlySet<string> }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    editor.update(() => {
      const visit = (node: LexicalNode) => {
        if ($isDirectiveNode(node)) {
          const item = node.getDirectiveItem();
          if (["attachment", "session-attachment", "project-attachment"].includes(item.type) && !validAttachmentIds.has(item.id)) node.remove();
          return;
        }
        if ($isElementNode(node)) node.getChildren().forEach(visit);
      };
      visit($getRoot());
    });
  }, [editor, validAttachmentIds]);

  return null;
}
