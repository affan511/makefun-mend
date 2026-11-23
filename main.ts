// mend: one patch tool for every AI edit format (SPEC.md version 1). Node 22, the standard library alone.
// Run as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the
// lines each edit names at the first of three matching tiers, and changes every file or none, printing what it
// changed or why it failed. Sections 1 to 10 of SPEC.md are all implemented here.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC section 3). */
interface LineFile {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): LineFile {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(f: LineFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** An edit: it changes the tree, and returns the [old, new] pair when it moves a file. */
type Edit = (tree: Tree) => [string, string] | void;

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

// ---- matching lines (SPEC section 5) ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(lines: string[], O: string[], tier: number, at: number): boolean {
  for (let j = 0; j < O.length; j++) {
    if (normLine(lines[at + j]!, tier) !== normLine(O[j]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (matchesAt(lines, O, tier, i)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with every occurrence there. */
function firstTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, O, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

const wsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

/** One line of N: a context line names its index in O (written as the file's own line), the rest are new. */
interface NCell {
  text: string;
  ctx: number | null;
}

/** Replace the k matched lines at `pos` with N, context lines from the file, tier 2 re-indented. */
function applyReplace(lines: string[], pos: number, O: string[], N: NCell[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(lines[pos]!)?.[0] ?? '';
    P = /^[ \t]*/.exec(O[0]!)?.[0] ?? '';
  }
  for (const c of N) {
    if (c.ctx !== null) out.push(lines[pos + c.ctx]!);
    else if (tier === 2 && !wsOnly(c.text) && c.text.startsWith(P)) out.push(F + c.text.slice(P.length));
    else out.push(c.text);
  }
  out.push(...lines.slice(pos + O.length));
  return out;
}

// ---- JSON edits (SPEC section 9) ----

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

// ---- unified diffs (SPEC section 6) ----

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  backslash: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: up to the first tab, spaces removed, /dev/null means no file, a/ or b/ removed. */
function diffPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A hunk's body: lines from `start` until the first line that is not one, trailing empty lines dropped. */
function hunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  let end = start;
  while (end < lines.length) {
    const l = lines[end]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[end + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      end++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      end++;
      continue;
    }
    break;
  }
  while (end > start && lines[end - 1] === '') end--;
  const body: BodyLine[] = [];
  for (let i = start; i < end; i++) {
    const l = lines[i]!;
    if (l === '') {
      body.push({ kind: ' ', text: '', backslash: false });
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ kind: c, text: l.slice(1), backslash: false });
      continue;
    }
    if (body.length > 0) body[body.length - 1]!.backslash = true;
  }
  return { body, next: end };
}

/** O (context and `-` lines) and N (context and `+` lines) of a hunk or chunk body, in body order. */
function hunkON(body: BodyLine[]): { O: string[]; N: NCell[] } {
  const O: string[] = [];
  const N: NCell[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else {
      N.push({ text: b.text, ctx: null });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrPlusBackslash(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '+') return b.backslash;
  }
  return false;
}

/** Apply a section's hunks in order to the file's lines, tracking the `d` offset and the final break. */
function applyHunks(f: LineFile, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkON(h.body);
    if (O.length > 0) {
      const found = firstTier(f.lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + O.length === f.lines.length;
      f.lines = applyReplace(f.lines, best, O, N, found.tier);
      if (runsToEnd) f.final = !lastCtxOrPlusBackslash(h.body);
      d += N.length - O.length;
    } else {
      const oldLen = f.lines.length;
      const at = Math.max(0, Math.min(h.a + d, oldLen));
      const ins = N.map((c) => c.text);
      f.lines.splice(at, 0, ...ins);
      if (at === oldLen) f.final = !lastCtxOrPlusBackslash(h.body);
      d += N.length;
    }
  }
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const paths: string[] = [];
    if (sec.oldPath !== null) paths.push(sec.oldPath);
    if (sec.newPath !== null) paths.push(sec.newPath);
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    const isCreate = sec.oldPath === null || sec.isCreate;
    const isDelete = !isCreate && (sec.newPath === null || sec.isDelete);
    if (isCreate) {
      const np = sec.newPath;
      if (np === null) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            plus.push(b.text);
            noFinal = b.backslash;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = sec.oldPath;
      if (op === null) return;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = sec.oldPath!;
    const np = sec.newPath!;
    if (op === np) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      const f = splitFile(tree.get(op)!);
      applyHunks(f, sec.hunks, strict, op);
      tree.now.set(op, joinFile(f));
      return;
    }
    if (tree.get(op) === null) throw new Fail('missing', op);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const f = splitFile(tree.get(op)!);
    applyHunks(f, sec.hunks, strict, op);
    tree.now.set(op, null);
    tree.now.set(np, joinFile(f));
    return [op, np];
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let gitOld: string | null = null;
  let gitNew: string | null = null;
  let pairOld: string | null | undefined = undefined;
  let pairNew: string | null | undefined = undefined;
  let renOld: string | null | undefined = undefined;
  let renNew: string | null | undefined = undefined;
  let isCreate = false;
  let isDelete = false;
  let hunks: Hunk[] = [];
  let inSection = false;
  let inHeader = false;

  const flush = (): void => {
    if (!inSection) return;
    const oldPath = pairOld !== undefined ? pairOld : renOld !== undefined ? renOld : gitOld;
    const newPath = pairNew !== undefined ? pairNew : renNew !== undefined ? renNew : gitNew;
    edits.push(unifiedEdit({ oldPath, newPath, isCreate, isDelete, hunks }, strict));
    inSection = false;
  };
  const startSection = (gOld: string | null, gNew: string | null): void => {
    flush();
    gitOld = gOld;
    gitNew = gNew;
    pairOld = undefined;
    pairNew = undefined;
    renOld = undefined;
    renNew = undefined;
    isCreate = false;
    isDelete = false;
    hunks = [];
    inSection = true;
    inHeader = true;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!inSection) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = hunkBody(lines, i + 1);
      hunks.push({ a: parseInt(m[1]!, 10), body });
      inHeader = false;
      i = next;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inSection && inHeader) {
        if (pairOld === undefined) {
          pairOld = diffPath(l.slice(4));
          pairNew = diffPath(lines[i + 1]!.slice(4));
        }
        i += 2;
        continue;
      }
      const o = diffPath(l.slice(4));
      const n = diffPath(lines[i + 1]!.slice(4));
      startSection(null, null);
      pairOld = o;
      pairNew = n;
      i += 2;
      continue;
    }
    if (inSection && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        if (renOld === undefined) renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (renNew === undefined) renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush();
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = firstTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const N: NCell[] = newLines.map((t) => ({ text: t, ctx: null }));
    f.lines = applyReplace(f.lines, found.positions[0]!, oldLines, N, found.tier);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
}

/**
 * A V4A section's lines: from `start` until the next section start or `last` (the `*** End Patch` line),
 * with the blank lines at the end of the section dropped (they are not part of it).
 * Returns the raw end (where the next section starts) and the end after dropping those blanks.
 */
function v4aSectionRange(lines: string[], start: number, last: number): { rawEnd: number; end: number } {
  let rawEnd = start;
  while (rawEnd < last && !isV4aSectionStart(lines[rawEnd]!)) rawEnd++;
  let end = rawEnd;
  while (end > start && blank(lines[end - 1]!)) end--;
  return { rawEnd, end };
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < lines.length; j++) {
      if (normLine(lines[j]!, t) === normLine(anchor, t)) return j;
    }
  }
  return null;
}

function chunkON(body: string[]): { O: string[]; N: NCell[] } {
  const O: string[] = [];
  const N: NCell[] = [];
  for (const l of body) {
    if (l === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push({ text: l.slice(1), ctx: null });
    }
  }
  return { O, N };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = chunkON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = N.map((c) => c.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      if (ch.eof) {
        const want = f.lines.length - O.length;
        if (want < cursor) throw new Fail('no-match', path);
        let tierFound: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          if (matchesAt(f.lines, O, t, want)) {
            tierFound = t;
            break;
          }
        }
        if (tierFound === null) throw new Fail('no-match', path);
        f.lines = applyReplace(f.lines, want, O, N, tierFound);
        cursor = want + N.length;
        continue;
      }
      const found = firstTier(f.lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      f.lines = applyReplace(f.lines, pos, O, N, found.tier);
      cursor = pos + N.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      return [path, moveTo];
    }
    tree.now.set(path, out);
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:')) {
      const isAdd = l.startsWith('*** Add File:');
      const path = l.slice(isAdd ? '*** Add File:'.length : '*** Delete File:'.length).trim();
      const startIdx = i + 1;
      const { rawEnd, end } = v4aSectionRange(lines, startIdx, last);
      if (isAdd) {
        const fileLines: string[] = [];
        for (let k = startIdx; k < end; k++) {
          const ln = lines[k]!;
          if (ln === '') {
            fileLines.push('');
            continue;
          }
          if (ln.startsWith('+')) {
            fileLines.push(ln.slice(1));
            continue;
          }
          throw new Exit2(`error: parse ${k + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else {
        for (let k = startIdx; k < end; k++) {
          if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
        }
        edits.push(v4aDeleteEdit(path));
      }
      i = rawEnd;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const updateIdx = i;
      const startIdx = i + 1;
      const { rawEnd, end } = v4aSectionRange(lines, startIdx, last);
      let moveTo: string | null = null;
      let j = startIdx;
      if (j < end && lines[j]!.startsWith('*** Move to:')) {
        moveTo = lines[j]!.slice('*** Move to:'.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (j < end) {
        const ln = lines[j]!;
        if (ln.startsWith('@@')) {
          close();
          const anchor = ln.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          j++;
          continue;
        }
        if (ln === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          close();
          j++;
          continue;
        }
        if (ln === '' || ln[0] === ' ' || ln[0] === '-' || ln[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(ln);
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = rawEnd;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- running the patch (SPEC sections 1, 2 and 10) ----

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
