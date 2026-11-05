import type { JSONContent } from "@tiptap/core";

/** The canonical empty TipTap document used for new notes. */
export function emptyDoc(): JSONContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function inlineText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inlineText).join("");
}

function blockLines(node: JSONContent, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  switch (node.type) {
    case "doc":
      for (const c of node.content ?? []) blockLines(c, depth, out);
      return;
    case "bulletList":
    case "orderedList":
    case "taskList": {
      let n = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
      for (const item of node.content ?? []) {
        const marker =
          node.type === "bulletList"
            ? "•"
            : node.type === "orderedList"
              ? `${n++}.`
              : item.attrs?.checked
                ? "☑"
                : "☐";
        listItemLines(item, marker, depth, out);
      }
      return;
    }
    case "listItem":
    case "taskItem":
      listItemLines(node, node.type === "taskItem" ? (node.attrs?.checked ? "☑" : "☐") : "•", depth, out);
      return;
    default: {
      // paragraph, heading, blockquote, unknown blocks: flatten inline text
      if (node.content?.some((c) => c.type && !isInline(c))) {
        for (const c of node.content) blockLines(c, depth, out);
        return;
      }
      for (const line of inlineText(node).split("\n")) out.push(indent + line);
    }
  }
}

function isInline(node: JSONContent): boolean {
  return node.type === "text" || node.type === "hardBreak";
}

function listItemLines(item: JSONContent, marker: string, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  let first = true;
  for (const child of item.content ?? []) {
    if (first && !child.type?.endsWith("List")) {
      const [head, ...rest] = inlineText(child).split("\n");
      out.push(`${indent}${marker} ${head}`.trimEnd());
      for (const r of rest) out.push(`${indent}  ${r}`);
      first = false;
    } else {
      if (first) {
        out.push(`${indent}${marker}`);
        first = false;
      }
      blockLines(child, depth + 1, out);
    }
  }
  if (first) out.push(`${indent}${marker}`);
}

/**
 * Plain-text rendering of a TipTap doc for previews: one line per block,
 * list markers "•", "1.", task items "☐ / ☑". Leading/trailing blank lines and
 * runs of blank lines are collapsed. Truncated to `maxChars` with "…".
 */
export function docToPlainText(doc: JSONContent | null | undefined, maxChars = Infinity): string {
  if (!doc) return "";
  const lines: string[] = [];
  blockLines(doc, 0, lines);
  const compact: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "" && (compact.length === 0 || compact[compact.length - 1] === "")) continue;
    compact.push(line.trim() === "" ? "" : line);
  }
  while (compact.length && compact[compact.length - 1] === "") compact.pop();
  const text = compact.join("\n");
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

/** Inverse used by the fallback textarea editor: one paragraph per line. */
export function plainTextToDoc(text: string): JSONContent {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: lines.map((line) =>
      line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" },
    ),
  };
}
