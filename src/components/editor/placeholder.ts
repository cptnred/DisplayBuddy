import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface EmptyPlaceholderOptions {
  text: string;
}

/**
 * Minimal placeholder: while the document is a single empty text block, that block
 * gets `class="is-editor-empty"` and `data-placeholder="…"`. The text itself is
 * rendered by CSS (`::before { content: attr(data-placeholder) }`).
 * (`@tiptap/extensions` – home of the official Placeholder – is not a direct dependency.)
 */
export const EmptyPlaceholder = Extension.create<EmptyPlaceholderOptions>({
  name: "emptyPlaceholder",
  addOptions() {
    return { text: "" };
  },
  addProseMirrorPlugins() {
    const text = this.options.text;
    return [
      new Plugin({
        key: new PluginKey("emptyPlaceholder"),
        props: {
          decorations: ({ doc }) => {
            const first = doc.firstChild;
            if (!text || doc.childCount !== 1 || !first?.isTextblock || first.content.size > 0) {
              return null;
            }
            return DecorationSet.create(doc, [
              Decoration.node(0, first.nodeSize, {
                class: "is-editor-empty",
                "data-placeholder": text,
              }),
            ]);
          },
        },
      }),
    ];
  },
});
