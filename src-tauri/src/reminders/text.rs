//! Plain text from TipTap JSON (for the reminder notification body).

use serde_json::Value;

/// Block nodes that start (and end) a line.
const BLOCKS: &[&str] = &[
    "paragraph",
    "heading",
    "blockquote",
    "codeBlock",
    "listItem",
    "taskItem",
    "bulletList",
    "orderedList",
    "taskList",
    "horizontalRule",
];

struct Writer {
    out: String,
    line_start: bool,
    /// Task-item check box, written together with the item's first text.
    prefix: Option<&'static str>,
}

impl Writer {
    fn newline(&mut self) {
        if !self.line_start {
            self.out.push('\n');
            self.line_start = true;
        }
    }

    fn push(&mut self, s: &str) {
        if !s.is_empty() {
            if let Some(p) = self.prefix.take() {
                self.out.push_str(p);
            }
            self.out.push_str(s);
            self.line_start = false;
        }
    }
}

fn walk(node: &Value, w: &mut Writer, depth: usize) {
    // TipTap documents are shallow; the bound only guards against hostile input.
    if depth > 64 {
        return;
    }
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "text" => {
            if let Some(text) = node.get("text").and_then(Value::as_str) {
                w.push(text);
            }
            return;
        }
        "hardBreak" => {
            w.out.push('\n');
            w.line_start = true;
            return;
        }
        _ => {}
    }
    let block = BLOCKS.contains(&kind);
    if block {
        w.newline();
    }
    if kind == "taskItem" {
        let checked = node
            .get("attrs")
            .and_then(|a| a.get("checked"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        w.prefix = Some(if checked { "☑ " } else { "☐ " });
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            walk(child, w, depth + 1);
        }
    }
    if block {
        // an empty task item leaves no lonely check box behind
        w.prefix = None;
        w.newline();
    }
}

/// All text of a TipTap document, one line per block, empty lines dropped.
/// Task items are prefixed with „☐ “ / „☑ “.
pub fn plain_text(doc: &Value) -> String {
    let mut w = Writer {
        out: String::new(),
        line_start: true,
        prefix: None,
    };
    walk(doc, &mut w, 0);
    w.out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// At most `max` characters; „…“ appended when shortened.
pub fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{}…", head.trim_end())
    } else {
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(text: &str) -> Value {
        json!({"type": "paragraph", "content": [{"type": "text", "text": text}]})
    }

    #[test]
    fn paragraphs_become_lines() {
        let doc = json!({"type": "doc", "content": [
            p("Hallo"),
            {"type": "paragraph"},
            {"type": "heading", "attrs": {"level": 1}, "content": [
                {"type": "text", "text": "Fett", "marks": [{"type": "bold"}]},
                {"type": "text", "text": " und normal"}
            ]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "a"}, {"type": "hardBreak"}, {"type": "text", "text": "b"}
            ]}
        ]});
        assert_eq!(plain_text(&doc), "Hallo\nFett und normal\na\nb");
    }

    #[test]
    fn task_items_get_check_boxes() {
        let doc = json!({"type": "doc", "content": [
            {"type": "taskList", "content": [
                {"type": "taskItem", "attrs": {"checked": false}, "content": [p("Milch")]},
                {"type": "taskItem", "attrs": {"checked": true}, "content": [
                    p("Brot"),
                    {"type": "taskList", "content": [
                        {"type": "taskItem", "attrs": {"checked": false}, "content": [p("Vollkorn")]}
                    ]}
                ]},
                {"type": "taskItem", "attrs": {"checked": false}}
            ]},
            {"type": "bulletList", "content": [
                {"type": "listItem", "content": [p("Punkt")]}
            ]}
        ]});
        assert_eq!(plain_text(&doc), "☐ Milch\n☑ Brot\n☐ Vollkorn\nPunkt");
    }

    #[test]
    fn garbage_is_tolerated() {
        assert_eq!(plain_text(&json!(null)), "");
        assert_eq!(plain_text(&json!("text")), "");
        assert_eq!(plain_text(&json!({"type": "doc", "content": "x"})), "");
        assert_eq!(
            plain_text(&json!({"type": "doc", "content": [1, {"type": "text"}]})),
            ""
        );
        // nesting beyond the depth bound is ignored
        let mut deep = json!({"type": "text", "text": "x"});
        for _ in 0..200 {
            deep = json!({"type": "blockquote", "content": [deep]});
        }
        assert_eq!(plain_text(&deep), "");
    }

    #[test]
    fn truncation_counts_chars() {
        assert_eq!(truncate_chars("äöü", 3), "äöü");
        assert_eq!(truncate_chars("äöüß", 3), "äöü…");
        assert_eq!(truncate_chars("ab cd", 3), "ab…");
        assert_eq!(truncate_chars("", 3), "");
    }
}
