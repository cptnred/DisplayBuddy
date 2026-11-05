import { Extension, type Extensions, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { TaskItem, TaskList } from "@tiptap/extension-list";

/** Font sizes offered in the toolbar (px). */
export const FONT_SIZES = [12, 14, 16, 18, 24, 32] as const;

/**
 * Text colours offered in the toolbar. All values have a contrast ratio of
 * at least ~4.9:1 against every pastel note colour in `NOTE_COLORS`.
 */
export const TEXT_COLORS: ReadonlyArray<{ name: string; value: string }> = [
  { name: "Schwarz", value: "#1F2328" },
  { name: "Grau", value: "#5B6170" },
  { name: "Rot", value: "#B8232A" },
  { name: "Orange", value: "#A04400" },
  { name: "Grün", value: "#1A7030" },
  { name: "Blau", value: "#1F5FBF" },
  { name: "Lila", value: "#6B3FA0" },
  { name: "Pink", value: "#B0226B" },
];

/** An empty TipTap document (one empty paragraph). */
export const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/**
 * Keeps Tab / Shift+Tab inside the editor while the cursor is in a list.
 *
 * ListItem / TaskItem already bind Tab → sinkListItem and Shift+Tab → liftListItem
 * (default priority 100). When those commands cannot apply (e.g. Tab on the first
 * item of a list) they return false and the browser would move focus out of the
 * editor. This lower-priority binding swallows the key in that case. Outside of
 * lists it returns false, so Tab moves focus normally (accessibility).
 */
export const ListTabKeymap = Extension.create({
  name: "listTabKeymap",
  priority: 50,
  addKeyboardShortcuts() {
    const inList = () => this.editor.isActive("listItem") || this.editor.isActive("taskItem");
    return {
      Tab: () => inList(),
      "Shift-Tab": () => inList(),
    };
  },
});

/**
 * Extensions shared by the note editor and read-only previews (`generateHTML`).
 *
 * Keyboard shortcuts are TipTap 3 defaults: Ctrl+B/I/U, Ctrl+Shift+S (strike),
 * Ctrl+Shift+7/8/9 (ordered/bullet/task list), Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z.
 * Ctrl+Arrow keys are not bound, so they bubble to the window (carousel).
 */
export function createExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: false,
      code: false,
      codeBlock: false,
      blockquote: false,
      heading: false,
      horizontalRule: false,
    }),
    TextStyle,
    Color,
    FontSize,
    TaskList,
    TaskItem.configure({ nested: true }),
    ListTabKeymap,
  ];
}
