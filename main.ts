// mend: one patch tool for every AI edit format.
//
// A model writes an edit as a unified diff, a SEARCH/REPLACE block, a V4A
// patch or a JSON tool call. mend reads any of the four, finds the lines each
// edit names at the first of three matching tiers (exact, trailing whitespace,
// both sides), and writes every change or none at all.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// The working directory is the root of the tree of text files. PATCH is a
// patch file, or standard input when it is absent or `-`. See SPEC.md for
// the contract this implements. Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A fault in the patch itself: the CLI answers `error: parse <line>`. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit's failure: the CLI answers `error: <code> <path>`. */
class EditFailure {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const isBlank = (s: string): boolean => s.trim() === '';

/**
 * A patch's lines: split at line feeds, one trailing carriage return removed
 * from each, and no empty piece after a final line feed.
 */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no backslash, and none of its segments is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function leadingWhitespace(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------------------------------------------------------------------------
// A file as lines
// ---------------------------------------------------------------------------

interface Doc {
  lines: string[];
  br: '\n' | '\r\n';
  finalBreak: boolean;
}

/**
 * Read a file's text as lines. Its line break is CRLF when its first line
 * feed follows a carriage return, LF otherwise. It ends with a line break
 * when its text ends with that break; the last, empty piece is not a line.
 * An empty file has no lines and no final break.
 */
function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

/** Write a document back: its own break between lines, a final one exactly when it had one. A document of no lines is empty. */
function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it
// ---------------------------------------------------------------------------

/**
 * `before` is what a path held on disk (null: no such file); `current` holds
 * the paths the edits have touched (null: deleted). Nothing is written to
 * disk until every edit has run. `moves` records the move edits that
 * succeeded, for the R lines of the report.
 */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly current = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];

  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  at(p: string): string | null {
    return this.current.has(p) ? this.current.get(p)! : this.before(p);
  }

  set(p: string, text: string | null): void {
    this.current.set(p, text);
  }
}

/** One edit: a function of the tree that throws EditFailure when it fails. A failed edit leaves the tree untouched. */
type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(a) === trimBoth(b);
}

/** Positions, at or after `from`, where `pat` occurs in `lines` at `tier`. Occurrences may overlap. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!linesEqualAt(lines[i + j]!, pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, 1, 2; with --strict only 0) at which `pat` occurs in
 * `lines` at or after `from`, with every occurrence at that tier. Null when
 * it occurs at no tier.
 */
function firstTier(lines: string[], pat: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const at = occurrences(lines, pat, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: a context line names its index in the matched old lines; any other line is a new line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines that replace a match. A context line is written as the file's
 * own matched line, never the patch's. At tier 2 every other line is
 * re-indented: the leading whitespace of the old lines' first line is
 * replaced by that of the file's first matched line. At tiers 0 and 1 the
 * new lines are written as they are.
 */
function replacementLines(fileLines: string[], at: number, oldLines: string[], items: NewLine[], tier: number): string[] {
  if (tier !== 2) {
    return items.map((it) => (it.ctx !== null ? fileLines[at + it.ctx]! : it.text));
  }
  const f = leadingWhitespace(fileLines[at]!);
  const p = leadingWhitespace(oldLines[0]!);
  return items.map((it) => {
    if (it.ctx !== null) return fileLines[at + it.ctx]!;
    const t = it.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  /** The file's current text, after the path's safety and existence are checked. */
  const existing = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const t = tree.at(p);
    if (t === null) throw new EditFailure('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.at(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      // In a CRLF file the text and both strings are read with every \r\n as \n, and the result is written back with \r\n.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const doc = readDoc(before);
      if (line < 0 || line > doc.lines.length) throw new EditFailure('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...added);
      // The file's final break stays as it was.
      tree.set(p, writeDoc({ lines, br: doc.br, finalBreak: doc.finalBreak }));
    };
  }

  return null;
}

/** The JSON edits of a patch: one array of edit objects, or one edit object a line. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface HunkLine {
  /** ' ' context, '-' old, '+' new, '\' a backslash line. `raw` is the patch line as written. */
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface Hunk {
  /** The old start line A of `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: HunkLine[];
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A `--- ` or `+++ ` path: the text after the four characters, up to the first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  const p = rest.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A line is a `diff --git` line when it is `diff --git` or starts with `diff --git `. */
const isDiffGitLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');

/** Read a unified diff patch into its sections' edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let hunk: Hunk | null = null;
  /** True while the current section has had no hunk yet. */
  let inHeader = false;
  /** True while the current section's header already holds its ---/+++ pair. */
  let hasPair = false;

  const freshSection = (): UnifiedSection => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    create: false,
    remove: false,
    hunks: [],
  });

  /** End the hunk being collected, dropping empty lines at the end of its body. */
  const endBody = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
      cur.hunks.push(hunk);
    }
    hunk = null;
  };

  /** End the section being collected. */
  const endSection = (): void => {
    endBody();
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
    hasPair = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (hunk !== null) {
      // The body ends at a --- line followed by a +++ line: a new section starts there.
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endBody();
        // Fall through and handle this line outside a body.
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        // Inside a hunk body: context, old, new, backslash lines, or an empty context line.
        const kind = (line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'));
        hunk.body.push({ kind, text: line === '' ? '' : line.slice(1), raw: line });
        continue;
      } else {
        // The body ends here: at a diff --git line, or at any other line.
        endBody();
        // Fall through and handle this line outside a body.
      }
    }

    if (isDiffGitLine(line)) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      endSection();
      cur = freshSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      continue;
    }

    if (line.startsWith('@@')) {
      // A hunk before any section, and any other @@ line, is a parse fault.
      const m = HUNK_HEAD.exec(line);
      if (cur === null || m === null) throw new ParseFault(i + 1);
      hunk = { a: Number.parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      continue;
    }

    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && inHeader && !hasPair) {
          // This section's own header pair.
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
          hasPair = true;
        } else {
          // A new section.
          endSection();
          cur = freshSection();
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
          hasPair = true;
          inHeader = true;
        }
        i += 1;
        continue;
      }
      // A --- line not followed by a +++ line, inside a section's header.
      if (cur !== null && inHeader) throw new ParseFault(i + 2);
      // Otherwise prose: ignored.
      continue;
    }

    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) {
        cur.pairNew = headerPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice(12).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice(10).trim();
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.create = true;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.remove = true;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
      continue;
    }

    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
  }
  endSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    // The paths: the ---/+++ pair names them, else rename from/to, else the diff --git line. /dev/null means no file.
    const oldRaw = s.pairOld ?? s.renameOld ?? s.diffOld;
    const newRaw = s.pairNew ?? s.renameNew ?? s.diffNew;
    const oldPath = oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw;
    const newPath = newRaw === null || newRaw === '/dev/null' ? null : newRaw;
    const isCreate = s.create || oldRaw === '/dev/null';
    const isDelete = s.remove || newRaw === '/dev/null';
    edits.push(unifiedEdit(oldPath, newPath, isCreate, isDelete, s.hunks, strict));
  }
  return edits;
}

/** Does a backslash line follow the hunk's last context or + line? That decides whether the result ends with a line break. */
function hunkEndsBare(hunk: Hunk): boolean {
  for (let k = hunk.body.length - 1; k >= 0; k--) {
    const bl = hunk.body[k]!;
    if (bl.kind === ' ' || bl.kind === '+') {
      return k + 1 < hunk.body.length && hunk.body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks, in order, to a document. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let lines = [...doc.lines];
  let finalBreak = doc.finalBreak;
  // d is the sum over this section's hunks applied so far of (new lines minus old lines).
  let d = 0;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newItems: NewLine[] = [];
    for (const bl of hunk.body) {
      if (bl.kind === ' ') {
        oldLines.push(bl.text);
        newItems.push({ text: bl.text, ctx: oldLines.length - 1 });
      } else if (bl.kind === '-') {
        oldLines.push(bl.text);
      } else if (bl.kind === '+') {
        newItems.push({ text: bl.text, ctx: null });
      }
    }
    const bare = hunkEndsBare(hunk);
    if (oldLines.length === 0) {
      // Insert the new lines after the first A + d lines (all of them when the file has fewer).
      const at = Math.max(0, Math.min(hunk.a + d, lines.length));
      const inserted = newItems.map((it) => it.text);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...inserted);
      if (atEnd) finalBreak = !bare;
      d += inserted.length;
      continue;
    }
    const found = firstTier(lines, oldLines, strict, 0);
    if (found === null) throw new EditFailure('no-match', path);
    // Of the occurrences at that tier, take the one nearest to A - 1 + d; of two equally near, the earlier.
    const target = hunk.a - 1 + d;
    let at = found.at[0]!;
    for (const pos of found.at) {
      if (Math.abs(pos - target) < Math.abs(at - target)) at = pos;
    }
    const atEnd = at + oldLines.length === lines.length;
    const made = replacementLines(lines, at, oldLines, newItems, found.tier);
    lines.splice(at, oldLines.length, ...made);
    if (atEnd) finalBreak = !bare;
    d += newItems.length - oldLines.length;
  }
  return { lines, br: doc.br, finalBreak };
}

/** One unified diff section as an edit. */
function unifiedEdit(
  oldPath: string | null,
  newPath: string | null,
  isCreate: boolean,
  isDelete: boolean,
  hunks: Hunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (isCreate) {
      const p = newPath ?? '';
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.at(p) !== null) throw new EditFailure('exists', p);
      // The file is the + lines of all its hunks, in order.
      const added: string[] = [];
      for (const h of hunks) for (const bl of h.body) if (bl.kind === '+') added.push(bl.text);
      let bare = false;
      outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
        const h = hunks[hi]!;
        for (let k = h.body.length - 1; k >= 0; k--) {
          if (h.body[k]!.kind === '+') {
            bare = k + 1 < h.body.length && h.body[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      // A created file is written with LF breaks, and ends with a line break unless a \ line follows its last + line.
      tree.set(p, added.length === 0 ? '' : added.join('\n') + (bare ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath ?? '';
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.at(p) === null) throw new EditFailure('missing', p);
      // Its hunks are not read.
      tree.set(p, null);
      return;
    }
    if (oldPath !== newPath) {
      // A move: the hunks apply to the old file's lines, the result is written at the new path, the old path deleted.
      const o = oldPath ?? '';
      const n = newPath ?? '';
      if (!isSafePath(o)) throw new EditFailure('unsafe', o);
      if (!isSafePath(n)) throw new EditFailure('unsafe', n);
      const before = tree.at(o);
      if (before === null) throw new EditFailure('missing', o);
      if (tree.at(n) !== null) throw new EditFailure('exists', n);
      const doc = applyHunks(readDoc(before), hunks, strict, o);
      tree.set(o, null);
      tree.set(n, writeDoc(doc));
      tree.moves.push({ from: o, to: n });
      return;
    }
    const p = oldPath ?? '';
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const before = tree.at(p);
    if (before === null) throw new EditFailure('missing', p);
    const doc = applyHunks(readDoc(before), hunks, strict, p);
    tree.set(p, writeDoc(doc));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

const SEARCH_MARK = '<<<<<<< SEARCH';
const DIVIDE_MARK = '=======';
const REPLACE_MARK = '>>>>>>> REPLACE';

/** Read SEARCH/REPLACE blocks into their edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  // The end of the previous block's >>>>>>> REPLACE line (or the start of the patch).
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SEARCH_MARK) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The ======= after the SEARCH line...
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== DIVIDE_MARK) j += 1;
    if (j >= lines.length) throw new ParseFault(searchLine);
    // ...and then the >>>>>>> REPLACE after it.
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== REPLACE_MARK) k += 1;
    if (k >= lines.length) throw new ParseFault(searchLine);
    // The path: the nearest line before the SEARCH line, after the previous block, that is not blank and does not
    // start with three backticks; that line with its surrounding whitespace removed.
    let path: string | null = null;
    for (let q = i - 1; q > prevEnd; q--) {
      const l = lines[q]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchLine);
    const oldLines = lines.slice(i + 1, j);
    const newLines = lines.slice(j + 1, k);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k;
    i = k + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      // The file is created with the new lines.
      if (tree.at(path) !== null) throw new EditFailure('exists', path);
      tree.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.at(path);
    if (before === null) throw new EditFailure('missing', path);
    const doc = readDoc(before);
    const found = firstTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new EditFailure('no-match', path);
    // The old lines occur at their tier exactly once, or the block fails with ambiguous.
    if (found.at.length > 1) throw new EditFailure('ambiguous', path);
    const at = found.at[0]!;
    const items: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const made = replacementLines(doc.lines, at, oldLines, items, found.tier);
    const lines = [...doc.lines];
    lines.splice(at, oldLines.length, ...made);
    // A changed file keeps its own line break and its final break.
    tree.set(path, writeDoc({ lines, br: doc.br, finalBreak: doc.finalBreak }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aLine {
  kind: ' ' | '-' | '+';
  text: string;
}

interface V4aChunk {
  /** The anchor text after @@, surrounding spaces removed; empty means no anchor. */
  anchor: string;
  body: V4aLine[];
  /** True when a *** End of File line ended this chunk. */
  eof: boolean;
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** A section's lines with their patch line numbers. Blank lines at the end of a section are not part of it. */
function v4aSectionLines(lines: string[], start: number, last: number): { text: string; no: number }[] {
  const raw: { text: string; no: number }[] = [];
  let j = start;
  while (j < last && !isV4aSectionStart(lines[j]!)) {
    raw.push({ text: lines[j]!, no: j + 1 });
    j += 1;
  }
  while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
  return raw;
}

/** Read a V4A patch into its sections' edits. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      // Blank lines between sections are ignored.
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const raw = v4aSectionLines(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseFault(r.no);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = i + 1 + raw.length;
      // Skip the trailing blank lines the section dropped, so the next section starts cleanly.
      while (i < last && isBlank(lines[i]!)) i += 1;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      const raw = v4aSectionLines(lines, i + 1, last);
      // A Delete File section has no lines.
      if (raw.length > 0) throw new ParseFault(raw[0]!.no);
      edits.push(v4aDeleteEdit(path));
      i = i + 1 + raw.length;
      while (i < last && isBlank(lines[i]!)) i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const headerNo = i + 1;
      const raw = v4aSectionLines(lines, i + 1, last);
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let chunk: V4aChunk | null = null;
      let seenChunk = false;
      for (const r of raw) {
        const t = r.text;
        if (moveTo === null && chunk === null && !seenChunk && t.startsWith('*** Move to: ')) {
          moveTo = t.slice(13).trim();
          continue;
        }
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim(), body: [], eof: false };
          chunks.push(chunk);
          seenChunk = true;
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new ParseFault(r.no);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            // Only the first chunk may start at a body line.
            if (seenChunk) throw new ParseFault(r.no);
            chunk = { anchor: '', body: [], eof: false };
            chunks.push(chunk);
            seenChunk = true;
          }
          const kind = (t === '' ? ' ' : (t[0] as ' ' | '-' | '+'));
          chunk.body.push({ kind, text: t === '' ? '' : t.slice(1) });
          continue;
        }
        throw new ParseFault(r.no);
      }
      // An Update File section with no chunk and no *** Move to: is a parse fault at its Update File line.
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(headerNo);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = i + 1 + raw.length;
      while (i < last && isBlank(lines[i]!)) i += 1;
      continue;
    }
    // Any other line is a parse fault at its line.
    throw new ParseFault(i + 1);
  }
  return edits;
}

/** One V4A Add File section as an edit: the file is the section's lines, ended by a line break. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.at(path) !== null) throw new EditFailure('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

/** One V4A Delete File section as an edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (tree.at(path) === null) throw new EditFailure('missing', path);
    tree.set(path, null);
  };
}

/** Apply a V4A Update File section's chunks, in order, to a document. */
function applyV4aChunks(doc: Doc, chunks: V4aChunk[], strict: boolean, path: string): Doc {
  let lines = [...doc.lines];
  // The cursor starts at line 0.
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== '') {
      // First find the first line at or after the cursor equal to the anchor at the first tier where one is.
      const anchorAt = firstTier(lines, [chunk.anchor], strict, cursor);
      if (anchorAt === null) throw new EditFailure('no-match', path);
      // The cursor moves past it.
      cursor = anchorAt.at[0]! + 1;
    }
    const oldLines: string[] = [];
    const newItems: NewLine[] = [];
    for (const bl of chunk.body) {
      if (bl.kind === ' ') {
        oldLines.push(bl.text);
        newItems.push({ text: bl.text, ctx: oldLines.length - 1 });
      } else if (bl.kind === '-') {
        oldLines.push(bl.text);
      } else {
        newItems.push({ text: bl.text, ctx: null });
      }
    }
    if (oldLines.length === 0) {
      // Insert the new lines at the cursor, or at the end of the file for an end-of-file chunk.
      const at = chunk.eof ? lines.length : cursor;
      const inserted = newItems.map((it) => it.text);
      lines.splice(at, 0, ...inserted);
      cursor = at + inserted.length;
      continue;
    }
    // The chunk takes the first occurrence of the old lines at or after the cursor, at the first tier with one.
    const found = firstTier(lines, oldLines, strict, cursor);
    if (found === null) throw new EditFailure('no-match', path);
    const at = found.at[0]!;
    // An end-of-file chunk takes only an occurrence that ends at the file's last line.
    if (chunk.eof && at + oldLines.length !== lines.length) throw new EditFailure('no-match', path);
    const made = replacementLines(lines, at, oldLines, newItems, found.tier);
    lines.splice(at, oldLines.length, ...made);
    // The cursor then moves to just after the lines written.
    cursor = at + made.length;
  }
  // A changed file keeps its own line break and its final break.
  return { lines, br: doc.br, finalBreak: doc.finalBreak };
}

/** One V4A Update File section as an edit. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFailure('unsafe', moveTo);
    const before = tree.at(path);
    if (before === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.at(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const doc = applyV4aChunks(readDoc(before), chunks, strict, path);
    if (moveTo !== null) {
      // The result is written at the new path and the old path deleted.
      tree.set(path, null);
      tree.set(moveTo, writeDoc(doc));
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.set(path, writeDoc(doc));
    }
  };
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(argv: string[]): { code: number; out: string[] } {
  // Options and PATCH may come in any order. -- ends the options.
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return { code: 2, out: ['error: usage'] };
        const v = a.slice(9);
        if (!FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  // PATCH is the patch file, or standard input when it is absent or -.
  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);

  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  // A parse error is reported before any file is looked at.
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  // Edits apply in the patch's order to the tree as earlier edits left it. A failed edit changes nothing, and the
  // edits after it still run, so every failure is reported.
  const tree = new Tree();
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const savedCurrent = new Map(tree.current);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.current.clear();
      for (const [k, v] of savedCurrent) tree.current.set(k, v);
      tree.moves.length = savedMoves;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  // One line for each path whose state changed, in byte order of the paths, then ok: <n> files.
  const rows: { key: string; text: string }[] = [];
  for (const p of tree.current.keys()) {
    const was = tree.before(p);
    const now = tree.current.get(p)!;
    if (was === now) continue;
    if (was === null) rows.push({ key: p, text: `A ${p}` });
    else if (now === null) rows.push({ key: p, text: `D ${p}` });
    else rows.push({ key: p, text: `M ${p}` });
  }
  // A move that succeeded replaces that pair's D and A lines with one R line, sorting by the new path.
  for (const mv of tree.moves) {
    const oldWas = tree.before(mv.from);
    const oldNow = tree.at(mv.from);
    const newWas = tree.before(mv.to);
    const newNow = tree.at(mv.to);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      const kept = rows.filter((r) => r.text !== `D ${mv.from}` && r.text !== `A ${mv.to}`);
      rows.length = 0;
      rows.push(...kept, { key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  // When none failed, every change is written, or with --check none is.
  if (!check) {
    for (const p of tree.current.keys()) {
      const was = tree.before(p);
      const now = tree.current.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
