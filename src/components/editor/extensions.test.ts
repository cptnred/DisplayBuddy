import { describe, expect, it } from "vitest";
import { generateHTML, getSchema } from "@tiptap/core";
import { createExtensions, EMPTY_DOC, FONT_SIZES, TEXT_COLORS } from "./extensions";

describe("extensions", () => {
  it("registers the expected nodes and marks only", () => {
    const schema = getSchema(createExtensions());
    const nodes = Object.keys(schema.nodes);
    const marks = Object.keys(schema.marks);
    for (const n of ["doc", "paragraph", "text", "bulletList", "orderedList", "listItem", "taskList", "taskItem"]) {
      expect(nodes).toContain(n);
    }
    for (const n of ["heading", "blockquote", "codeBlock", "horizontalRule"]) {
      expect(nodes).not.toContain(n);
    }
    for (const m of ["bold", "italic", "underline", "strike", "textStyle"]) {
      expect(marks).toContain(m);
    }
    expect(marks).not.toContain("link");
    expect(marks).not.toContain("code");
  });

  it("renders preview HTML with generateHTML", () => {
    const html = generateHTML(
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Rot",
                marks: [{ type: "textStyle", attrs: { color: "#B8232A", fontSize: "18px" } }],
              },
            ],
          },
          {
            type: "taskList",
            content: [
              { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Fertig" }] }] },
            ],
          },
        ],
      },
      createExtensions(),
    );
    expect(html).toMatch(/color: (#B8232A|rgb\(184, 35, 42\))/i);
    expect(html).toContain("font-size: 18px");
    expect(html).toContain('data-checked="true"');
    expect(generateHTML(EMPTY_DOC, createExtensions())).toBe("<p></p>");
  });

  it("exports the toolbar constants", () => {
    expect(FONT_SIZES).toEqual([12, 14, 16, 18, 24, 32]);
    expect(TEXT_COLORS.map((c) => c.name)).toEqual(["Schwarz", "Grau", "Rot", "Orange", "Grün", "Blau", "Lila", "Pink"]);
    TEXT_COLORS.forEach((c) => expect(c.value).toMatch(/^#[0-9A-F]{6}$/));
  });
});
