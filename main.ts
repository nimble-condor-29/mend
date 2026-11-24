// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, in order, as [old path, new path]; read back at output time (section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 5 to 8, written for this entry: three-tier line matching, and the
// unified, SEARCH/REPLACE and V4A readers. Each reader turns the patch into
// Edit closures over the starter's Tree; a closure throws Fail and changes
// nothing when its edit fails, and the parse itself throws Exit2 before any
// file is looked at.

/** A file as section 3 reads it: its line break, its lines, and whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** One comparison of section 5: tier 0 exact, tier 1 ignoring trailing blanks, tier 2 ignoring both ends. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every position at or after `from` where O matches at this tier, ascending. */
function positionsAt(lines: string[], O: string[], tier: number, from: number, filt?: (pos: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok && (filt === undefined || filt(i))) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`, passing `filt`), and its positions there. */
function findMatch(
  lines: string[],
  O: string[],
  strict: boolean,
  from: number,
  filt?: (pos: number) => boolean,
): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = positionsAt(lines, O, tier, from, filt);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A line of a replacement: `ctx` >= 0 marks a context line, the index into O whose file line is written. */
interface NewLine {
  text: string;
  ctx: number;
}

/**
 * The lines a match writes (section 5): a context line is the file's own
 * matched line; at tier 2 any other line is re-indented, the first matched
 * line's leading blanks F taking the place of O's first line's P wherever a
 * non-blank line of N starts with P.
 */
function buildNew(lines: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const F = leadWs(lines[pos]!);
  const P = leadWs(O[0]!);
  return N.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx]!;
    if (tier !== 2 || trimBoth(n.text) === '') return n.text;
    return n.text.startsWith(P) ? F + n.text.slice(P.length) : n.text;
  });
}

/** One body line of a unified hunk or a V4A chunk; `raw` marks a line that was empty in the patch. */
interface BodyLine {
  kind: string;
  text: string;
  slash: boolean;
  raw: boolean;
}

/** O and N of a hunk or chunk body, in body order (section 5's terms). */
function bodyON(body: BodyLine[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line (the no-newline marker). */
function slashAfterLastWrite(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') return body[i]!.slash;
  }
  return false;
}

// --- Section 6: unified diffs ----------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  hasPair: boolean;
  renameOld?: string;
  renameNew?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: up to the first tab, spaces removed, /dev/null as null, a/ b/ stripped. */
function headPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function newSection(): Section {
  return { hasPair: false, create: false, del: false, hunks: [] };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const pairAt = (j: number): boolean =>
    lines[j] !== undefined && lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (cur !== null && (cur.hasPair || cur.hunks.length > 0)) cur = null;
      if (cur === null) {
        cur = newSection();
        sections.push(cur);
      }
      cur.pairOld = headPath(line);
      cur.pairNew = headPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || pairAt(i)) break;
        if (b === '') {
          body.push({ kind: ' ', text: '', slash: false, raw: true });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          body.push({ kind: c, text: b.slice(1), slash: false, raw: false });
          i += 1;
          continue;
        }
        if (c === '\\') {
          if (body.length > 0) body[body.length - 1]!.slash = true;
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  return sections;
}

/** The text a creation's hunks build: the `+` lines of every hunk, in order. */
function createdText(hunks: Hunk[]): string {
  const texts: string[] = [];
  let lastPlus: BodyLine | null = null;
  for (const h of hunks) {
    for (const b of h.body) {
      if (b.kind === '+') {
        texts.push(b.text);
        lastPlus = b;
      }
    }
  }
  if (texts.length === 0) return '';
  return texts.join('\n') + (lastPlus !== null && lastPlus.slash ? '' : '\n');
}

/** Apply one section's hunks to a file's lines, in order (section 6). */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...N.map((n) => n.text));
      if (atEnd) f.final = !slashAfterLastWrite(h.body);
      d += N.length;
      continue;
    }
    const found = findMatch(f.lines, O, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const reachesEnd = pos + O.length === f.lines.length;
    const built = buildNew(f.lines, pos, O, N, found.tier);
    f.lines.splice(pos, O.length, ...built);
    if (reachesEnd) f.final = !slashAfterLastWrite(h.body);
    d += N.length - O.length;
  }
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.gitOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.gitNew;
    // Every path the edit names is checked for safety before anything else.
    for (const p of [oldP, newP]) {
      if (typeof p === 'string' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (sec.create || oldP === null) {
      if (typeof newP !== 'string') return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, createdText(sec.hunks));
      return;
    }
    if (sec.del || newP === null) {
      if (typeof oldP !== 'string') return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (typeof oldP !== 'string' || typeof newP !== 'string') return;
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    applyHunks(f, sec.hunks, strict, oldP);
    tree.now.set(newP, joinFile(f));
    if (newP !== oldP) {
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

// --- Section 7: SEARCH/REPLACE blocks ---------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // first line index after the previous block
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    let rp = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rp = j;
          break;
        }
      }
    }
    if (eq < 0 || rp < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    // The path is the nearest usable line before the block, not before the
    // previous block's end; failing that, the previous block's path.
    let path: string | null = null;
    for (let j = sIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rp);
    const atPath = path;
    edits.push((tree) => {
      if (!safe(atPath)) throw new Fail('unsafe', atPath);
      if (oldLines.length === 0) {
        if (tree.get(atPath) !== null) throw new Fail('exists', atPath);
        tree.now.set(atPath, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(atPath);
      if (before === null) throw new Fail('missing', atPath);
      const f = splitFile(before);
      const found = findMatch(f.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', atPath);
      if (found.at.length > 1) throw new Fail('ambiguous', atPath);
      const pos = found.at[0]!;
      const built = buildNew(f.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), found.tier);
      f.lines.splice(pos, oldLines.length, ...built);
      tree.now.set(atPath, joinFile(f));
    });
    prevPath = path;
    prevEnd = rp + 1;
    i = rp + 1;
  }
  return edits;
}

// --- Section 8: V4A patches --------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: string;
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  headLine: number;
}

const vHead = /^\*\*\* (Add File|Delete File|Update File): /;

function parseV4a(lines: string[]): VSection[] {
  const nonBlank: number[] = [];
  lines.forEach((l, idx) => {
    if (!blank(l)) nonBlank.push(idx);
  });
  if (nonBlank.length === 0) throw new Exit2('error: parse 1');
  const first = nonBlank[0]!;
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = nonBlank[nonBlank.length - 1]!;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const hm = vHead.exec(line);
    if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = {
      kind: hm[1]!,
      path: line.slice(hm[0].length).trim(),
      moveTo: null,
      addLines: [],
      chunks: [],
      headLine: i + 1,
    };
    i += 1;
    const raw: { text: string; line: number }[] = [];
    while (i < last && !vHead.test(lines[i]!)) {
      raw.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (sec.kind === 'Add File') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
    } else if (sec.kind === 'Delete File') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
    } else {
      parseVUpdate(sec, raw);
    }
    sections.push(sec);
  }
  return sections;
}

function parseVUpdate(sec: VSection, raw: { text: string; line: number }[]): void {
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    sec.moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  let chunk: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    if (r.text.startsWith('@@')) {
      chunk = { anchor: r.text.slice(2).trim() || null, eof: false, body: [] };
      sec.chunks.push(chunk);
    } else if (r.text.trim() === '*** End of File') {
      if (chunk === null) {
        chunk = { anchor: null, eof: true, body: [] };
        sec.chunks.push(chunk);
      } else chunk.eof = true;
      chunk = null;
    } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, body: [] };
        sec.chunks.push(chunk);
      }
      chunk.body.push({
        kind: r.text === '' ? ' ' : r.text[0]!,
        text: r.text === '' ? '' : r.text.slice(1),
        slash: false,
        raw: r.text === '',
      });
    } else {
      throw new Exit2(`error: parse ${r.line}`);
    }
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.headLine}`);
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const path = sec.path;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (sec.kind === 'Add File') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'Delete File') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    // Update File, with or without a move.
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findMatch(f.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.at[0]! + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...N.map((n) => n.text));
        cursor = at + N.length;
        continue;
      }
      const found = findMatch(f.lines, O, strict, cursor, ch.eof ? (p) => p + O.length === f.lines.length : undefined);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.at[0]!;
      const built = buildNew(f.lines, pos, O, N, found.tier);
      f.lines.splice(pos, O.length, ...built);
      cursor = pos + built.length;
    }
    const target = sec.moveTo ?? path;
    tree.now.set(target, joinFile(f));
    if (sec.moveTo !== null) {
      tree.now.set(path, null);
      tree.moves.push([path, sec.moveTo]);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec) => v4aEdit(sec, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byKey = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byKey.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  // A move that succeeded reports as one R line (section 2) when the before
  // and after states are exactly a move's: it replaces the pair's D and A
  // lines and sorts by the new path.
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      byKey.delete(o);
      byKey.set(n, `R ${o} -> ${n}`);
    }
  }
  const rows = [...byKey.entries()]
    .sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])))
    .map(([, v]) => v);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


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
