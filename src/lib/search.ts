/**
 * Pure full-text search over notes (title + plain text). No React, no api.
 *
 * Matching is case- and diacritic-insensitive („Müll“ ⇄ „mull“, „Straße“ ⇄ „strasse“);
 * whitespace-separated terms are ANDed (each must occur in the title or the text).
 */
import type { Note } from "../types";
import { docToPlainText } from "../windows/notes/docText";

export interface SnippetPart {
  text: string;
  match: boolean;
}

export interface SearchResult {
  noteId: string;
  /** Index of the note in the input array. */
  index: number;
  title: string;
  /** Title split into highlighted / plain parts (empty title → []). */
  titleParts: SnippetPart[];
  /** ±`context` chars around the first text hit (or the start of the text), „…“ where cut. */
  snippet: SnippetPart[];
  /** Higher is better: title hits dominate, then the total number of hits. */
  score: number;
}

export interface SearchOptions {
  /** Max. results (default 50). */
  limit?: number;
  /** Characters of context on each side of the first text hit (default 40). */
  context?: number;
}

const ELLIPSIS = "…";
const COMBINING = /\p{M}/gu;

interface Normalized {
  text: string;
  /** For every char of `text`: [start, end) of the source code point in the original. */
  start: number[];
  end: number[];
}

/** Lowercase, strip diacritics (NFD + combining marks), ß → ss. */
export function normalizeForSearch(s: string): string {
  return normalizeMapped(s).text;
}

function normalizeChar(c: string): string {
  return c.toLowerCase().normalize("NFD").replace(COMBINING, "").replace(/ß/g, "ss");
}

function normalizeMapped(s: string): Normalized {
  let text = "";
  const start: number[] = [];
  const end: number[] = [];
  let pos = 0;
  for (const c of s) {
    const n = normalizeChar(c);
    for (let k = 0; k < n.length; k++) {
      start.push(pos);
      end.push(pos + c.length);
    }
    text += n;
    pos += c.length;
  }
  return { text, start, end };
}

/** Splits the query into normalized, de-duplicated terms. */
export function queryTerms(query: string): string[] {
  const terms = query
    .split(/\s+/)
    .map(normalizeForSearch)
    .filter((t) => t.length > 0);
  return [...new Set(terms)];
}

type Range = [number, number];

/** Non-overlapping occurrences of every term, mapped back to original-string ranges, merged. */
function findRanges(norm: Normalized, terms: string[]): { ranges: Range[]; hitsPerTerm: number[] } {
  const raw: Range[] = [];
  const hitsPerTerm = terms.map((term) => {
    let count = 0;
    let from = 0;
    for (;;) {
      const i = norm.text.indexOf(term, from);
      if (i < 0) break;
      raw.push([norm.start[i], norm.end[i + term.length - 1]]);
      count++;
      from = i + term.length;
    }
    return count;
  });
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranges: Range[] = [];
  for (const r of raw) {
    const last = ranges[ranges.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else ranges.push([r[0], r[1]]);
  }
  return { ranges, hitsPerTerm };
}

/** Splits `text[from, to)` into plain / match parts according to `ranges`. */
function partsOf(text: string, ranges: Range[], from = 0, to = text.length): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let pos = from;
  for (const [a0, b0] of ranges) {
    const a = Math.max(a0, from);
    const b = Math.min(b0, to);
    if (b <= a) continue;
    if (a > pos) parts.push({ text: text.slice(pos, a), match: false });
    parts.push({ text: text.slice(a, b), match: true });
    pos = b;
  }
  if (pos < to) parts.push({ text: text.slice(pos, to), match: false });
  return parts;
}

function buildSnippet(text: string, ranges: Range[], context: number): SnippetPart[] {
  if (!text) return [];
  const first = ranges[0];
  let from = first ? Math.max(0, first[0] - context) : 0;
  let to = first ? Math.min(text.length, first[1] + context) : Math.min(text.length, context * 2);
  // never cut a surrogate pair
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from])) from--;
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to])) to++;
  // drop whitespace at the cut edges
  while (from < to && text[from] === " ") from++;
  while (to > from && text[to - 1] === " ") to--;
  const parts = partsOf(text, ranges, from, to);
  if (parts.length === 0) return [];
  if (from > 0) {
    if (parts[0].match) parts.unshift({ text: ELLIPSIS, match: false });
    else parts[0] = { ...parts[0], text: ELLIPSIS + parts[0].text };
  }
  if (to < text.length) {
    const last = parts[parts.length - 1];
    if (last.match) parts.push({ text: ELLIPSIS, match: false });
    else parts[parts.length - 1] = { ...last, text: last.text + ELLIPSIS };
  }
  return parts;
}

/** One-line plain text of a note (all whitespace runs collapsed to a single space). */
export function noteSearchText(note: Note): string {
  return docToPlainText(note.content).replace(/\s+/g, " ").trim();
}

export function searchNotes(notes: Note[], query: string, opts: SearchOptions = {}): SearchResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const limit = opts.limit ?? 50;
  const context = opts.context ?? 40;

  const results: SearchResult[] = [];
  notes.forEach((note, index) => {
    const title = note.title ?? "";
    const body = noteSearchText(note);
    const titleNorm = normalizeMapped(title);
    const bodyNorm = normalizeMapped(body);
    const t = findRanges(titleNorm, terms);
    const b = findRanges(bodyNorm, terms);
    // AND: every term somewhere in title or text
    if (!terms.every((_, k) => t.hitsPerTerm[k] + b.hitsPerTerm[k] > 0)) return;
    const titleHits = t.hitsPerTerm.reduce((s, x) => s + x, 0);
    const bodyHits = b.hitsPerTerm.reduce((s, x) => s + x, 0);
    results.push({
      noteId: note.id,
      index,
      title,
      titleParts: partsOf(title, t.ranges),
      snippet: buildSnippet(body, b.ranges, context),
      score: Math.min(titleHits, 999) * 10_000 + Math.min(titleHits + bodyHits, 9_999),
    });
  });
  results.sort((x, y) => y.score - x.score || x.index - y.index);
  return results.slice(0, limit);
}
