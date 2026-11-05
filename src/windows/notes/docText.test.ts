import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { docToPlainText, emptyDoc, plainTextToDoc } from "./docText";

const p = (text?: string): JSONContent =>
  text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };

describe("docToPlainText", () => {
  it("handles null and the empty doc", () => {
    expect(docToPlainText(null)).toBe("");
    expect(docToPlainText(emptyDoc())).toBe("");
  });

  it("joins paragraphs and marks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hallo " },
            { type: "text", text: "Welt", marks: [{ type: "bold" }] },
          ],
        },
        p("Zweite Zeile"),
      ],
    };
    expect(docToPlainText(doc)).toBe("Hallo Welt\nZweite Zeile");
  });

  it("renders task items as ☐ / ☑ and lists with markers", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [p("Milch kaufen")] },
            { type: "taskItem", attrs: { checked: true }, content: [p("Brot")] },
          ],
        },
        { type: "bulletList", content: [{ type: "listItem", content: [p("Punkt")] }] },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            { type: "listItem", content: [p("eins")] },
            {
              type: "listItem",
              content: [p("zwei"), { type: "bulletList", content: [{ type: "listItem", content: [p("tief")] }] }],
            },
          ],
        },
      ],
    };
    expect(docToPlainText(doc)).toBe("☐ Milch kaufen\n☑ Brot\n• Punkt\n1. eins\n2. zwei\n  • tief");
  });

  it("collapses blank lines and handles hard breaks", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        p(),
        p("a"),
        p(),
        p(),
        { type: "paragraph", content: [{ type: "text", text: "b" }, { type: "hardBreak" }, { type: "text", text: "c" }] },
        p(),
      ],
    };
    expect(docToPlainText(doc)).toBe("a\n\nb\nc");
  });

  it("truncates with an ellipsis", () => {
    const doc: JSONContent = { type: "doc", content: [p("abcdefghij")] };
    expect(docToPlainText(doc, 5)).toBe("abcd…");
    expect(docToPlainText(doc, 10)).toBe("abcdefghij");
  });
});

describe("plainTextToDoc", () => {
  it("round-trips through docToPlainText", () => {
    const text = "eins\n\nzwei";
    expect(docToPlainText(plainTextToDoc(text))).toBe(text);
    expect(plainTextToDoc("").content).toEqual([{ type: "paragraph" }]);
  });
});
