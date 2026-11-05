import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { NOTE_SCHEMA_VERSION, type Note } from "../types";
import { plainTextToDoc } from "../windows/notes/docText";
import { normalizeForSearch, queryTerms, searchNotes, type SnippetPart } from "./search";

let seq = 0;
function note(title: string, text: string | JSONContent): Note {
  seq++;
  return {
    id: `id-${seq}`,
    title,
    color: "yellow",
    content: typeof text === "string" ? plainTextToDoc(text) : text,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: NOTE_SCHEMA_VERSION,
  };
}

const joined = (parts: SnippetPart[]) => parts.map((p) => p.text).join("");
const marks = (parts: SnippetPart[]) => parts.filter((p) => p.match).map((p) => p.text);

describe("normalizeForSearch / queryTerms", () => {
  it("lowercases, strips diacritics and maps ß to ss", () => {
    expect(normalizeForSearch("Müll ÄÖÜ Straße Café ẞ")).toBe("mull aou strasse cafe ss");
  });
  it("splits on whitespace, drops empties and duplicates", () => {
    expect(queryTerms("  Müll \t mull\nEinkauf ")).toEqual(["mull", "einkauf"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("searchNotes", () => {
  it("empty or whitespace query → []", () => {
    const notes = [note("A", "x")];
    expect(searchNotes(notes, "")).toEqual([]);
    expect(searchNotes(notes, "   ")).toEqual([]);
  });

  it("is case- and diacritic-insensitive in both directions", () => {
    const notes = [note("", "Müll rausbringen"), note("", "mull bandage")];
    expect(searchNotes(notes, "mull").map((r) => r.index)).toEqual([0, 1]);
    expect(searchNotes(notes, "MÜLL").map((r) => r.index)).toEqual([0, 1]);
    expect(searchNotes([note("", "Hauptstraße 5")], "strasse")).toHaveLength(1);
    expect(searchNotes([note("", "Hauptstrasse 5")], "straße")).toHaveLength(1);
  });

  it("highlights the original text (with umlauts) in the snippet", () => {
    const [r] = searchNotes([note("", "Bitte den Müll rausbringen")], "mull");
    expect(marks(r.snippet)).toEqual(["Müll"]);
    expect(joined(r.snippet)).toBe("Bitte den Müll rausbringen");
  });

  it("maps ß highlights back to the original character", () => {
    const [r] = searchNotes([note("", "Große Straße")], "strasse");
    expect(marks(r.snippet)).toEqual(["Straße"]);
  });

  it("ANDs multiple terms across title and text", () => {
    const notes = [note("Einkauf", "Milch und Brot"), note("Arbeit", "Milch kaufen"), note("", "Brot")];
    expect(searchNotes(notes, "milch brot").map((r) => r.index)).toEqual([0]);
    expect(searchNotes(notes, "einkauf milch").map((r) => r.index)).toEqual([0]);
    expect(searchNotes(notes, "milch xyz")).toEqual([]);
  });

  it("ranks title hits first, then number of hits, then original order", () => {
    const notes = [
      note("", "plan plan plan"), // 0: 3 body hits
      note("Plan", "nothing"), // 1: title hit
      note("", "plan"), // 2: 1 body hit
      note("", "plan"), // 3: 1 body hit
      note("Plan B", "plan"), // 4: title + body
    ];
    expect(searchNotes(notes, "plan").map((r) => r.index)).toEqual([4, 1, 0, 2, 3]);
    const scores = searchNotes(notes, "plan").map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("returns title parts with the match marked", () => {
    const [r] = searchNotes([note("Großer Plan", "")], "plan");
    expect(r.title).toBe("Großer Plan");
    expect(r.titleParts).toEqual([
      { text: "Großer ", match: false },
      { text: "Plan", match: true },
    ]);
    expect(r.snippet).toEqual([]);
  });

  it("title-only match shows the start of the text as snippet", () => {
    const long = "a".repeat(100);
    const [r] = searchNotes([note("Termin", long)], "termin");
    expect(joined(r.snippet)).toBe("a".repeat(80) + "…");
    expect(marks(r.snippet)).toEqual([]);
  });

  it("cuts the snippet ±40 chars around the first text hit with „…“", () => {
    const before = "x".repeat(60);
    const after = "y".repeat(60);
    const [r] = searchNotes([note("", `${before}ZIEL${after}`)], "ziel");
    expect(joined(r.snippet)).toBe(`…${"x".repeat(40)}ZIEL${"y".repeat(40)}…`);
    expect(r.snippet[1]).toEqual({ text: "ZIEL", match: true });
  });

  it("no ellipsis when the hit is near the start/end", () => {
    const [r] = searchNotes([note("", "Ziel am Anfang")], "ziel");
    expect(r.snippet[0]).toEqual({ text: "Ziel", match: true });
    expect(joined(r.snippet)).toBe("Ziel am Anfang");
  });

  it("marks all terms inside the snippet window, merges overlaps", () => {
    const [r] = searchNotes([note("", "Milch, Brot und Milchreis")], "milch milchr");
    expect(marks(r.snippet)).toEqual(["Milch", "Milchr"]);
  });

  it("collapses line breaks in the snippet", () => {
    const [r] = searchNotes([note("", "Zeile eins\n\nZeile zwei")], "zwei");
    expect(joined(r.snippet)).toBe("Zeile eins Zeile zwei");
  });

  it("finds text inside task items", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Zahnarzt anrufen" }] }] },
            { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Müll" }] }] },
          ],
        },
      ],
    };
    const [r] = searchNotes([note("", doc)], "zahnarzt");
    expect(marks(r.snippet)).toEqual(["Zahnarzt"]);
    expect(searchNotes([note("", doc)], "mull")).toHaveLength(1);
  });

  it("respects the limit option", () => {
    const notes = Array.from({ length: 10 }, () => note("", "treffer"));
    expect(searchNotes(notes, "treffer", { limit: 3 })).toHaveLength(3);
  });
});
