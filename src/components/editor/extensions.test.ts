import { describe, expect, it } from "vitest";
import { Editor, generateHTML, getSchema, type JSONContent } from "@tiptap/core";
import { createExtensions, EMPTY_DOC, FONT_SIZES, TEXT_COLORS } from "./extensions";
// Realistic doc produced by `editor.getJSON()` (marks incl. textStyle color/fontSize,
// 3-level nested task list, ordered list with start, hard break, emoji/umlauts).
// Shared with the Rust storage roundtrip test (src-tauri/src/storage/mod.rs).
import richDoc from "../../test/fixtures/rich-note-content.json";

describe("rich document roundtrip", () => {
  it("a stored editor document loads back into the editor unchanged", () => {
    const editor = new Editor({ extensions: createExtensions(), content: richDoc as JSONContent });
    try {
      // JSON → schema → JSON is lossless: nothing gets dropped or normalised away,
      // so a note saved by the editor and reloaded from disk shows exactly the same.
      expect(editor.getJSON()).toEqual(richDoc);
      expect(editor.getText()).toContain("vom Bäcker");
    } finally {
      editor.destroy();
    }
  });

  it("previews render marks and nested checked task items", () => {
    const html = generateHTML(richDoc as JSONContent, createExtensions());
    expect(html).toContain("font-size: 32px");
    expect(html).toMatch(/color: (#1F5FBF|rgb\(31, 95, 191\))/i);
    expect(html).toContain("<strong>Freitag</strong>");
    expect(html).toContain("<u>unterstrichen</u>");
    expect(html).toContain("<s>alt</s>");
    expect(html).toContain('<ol start="3">');
    expect(html.match(/data-type="taskList"/g)).toHaveLength(3);
    expect(html.match(/data-checked="true"/g)).toHaveLength(2);
    expect(html).toContain("&lt;tag&gt;");
  });
});

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
