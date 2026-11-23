// Fast drop-in replacement for makefun-site 1.0.0.
// Authored for site-generator-speed-01: templates are compiled once per case to
// generated JavaScript closures (includes inlined when acyclic), Markdown is
// rendered in a single pass over the body's lines, and slugs / link resolutions
// are memoised per case. Output is byte-for-byte the reference build's output.

const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text rules

const ESC_TEST = /[&<>"']/;

function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// Slug rule with a per-case memo (installed by run()).
let slugCache = new Map();

function slugifyInner(text) {
  // Pure-ASCII fast path: NFKD is the identity there and no marks exist.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifyInner(text);
    slugCache.set(text, v);
  }
  return v;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const TRAIL_WS = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Parse front matter over an already-split line array.
// Returns { data, bodyStart } or { error }.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(TRAIL_WS, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ----------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_TEST = /\s/;

function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering: a native scan jumps between construct openers; plain
// runs between them are flushed through one escape pass.
const INLINE_SCAN = /[`*[\\]/g;

function inlineInto(s, link, out) {
  const len = s.length;
  let i = 0;
  let run = 0;
  while (i < len) {
    INLINE_SCAN.lastIndex = i;
    const m = INLINE_SCAN.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < len && ESCAPABLE.has(s[j + 1])) {
        if (j > run) out.push(esc(s.slice(run, j)));
        out.push(esc(s[j + 1]));
        i = j + 2;
        run = i;
      } else i = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > run) out.push(esc(s.slice(run, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        run = i;
      } else i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > run) out.push(esc(s.slice(run, j)));
          out.push('<strong>', inlineStr(s.slice(j + 2, k), link), '</strong>');
          i = k + 2;
          run = i;
        } else i = j + 2;
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > run) out.push(esc(s.slice(run, j)));
          out.push('<em>', inlineStr(s.slice(j + 1, k), link), '</em>');
          i = k + 1;
          run = i;
        } else i = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const e = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = e === -1 ? '' : s.slice(k + 2, e);
    if (target !== '' && !WS_TEST.test(target)) {
      if (j > run) out.push(esc(s.slice(run, j)));
      out.push('<a href="', esc(link(target)), '">', inlineStr(s.slice(j + 1, k), link), '</a>');
      i = e + 1;
      run = i;
    } else i = j + 1;
  }
  if (len > run) out.push(esc(s.slice(run)));
}

const INLINE_SPECIAL = /[`*[\\]/;
const PLAIN_TEST = /[`*[\\&<>"']/;

function inlineStr(s, link) {
  // Fast paths: nothing to do at all, or plain text needing only escaping.
  if (!PLAIN_TEST.test(s)) return s;
  if (!INLINE_SPECIAL.test(s)) return esc(s);
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

function trimLineStr(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// Whitespace table matching the JS \s class, indexed by char code.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

function isWsCode(c) {
  return WS_TABLE[c] === 1;
}

// Fence opener: returns the language ('' allowed) or null when not a fence.
// `lang` may be '' — callers must compare against null, not truthiness.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Heading: returns { depth, text } or null.
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let p = n;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
  let end = line.length;
  while (end > p && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === p) return null;
  return { depth: n, text: line.slice(p, end) };
}

function isHr(line) {
  if (!(line.startsWith('---') || line.startsWith('***'))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

const ORDERED = /^(\d{1,9})\. (.*)$/;

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// Render the body (lines[start..]) to { html, toc, excerpt, words } in one
// pass; the word count (for reading_minutes) is taken over the raw body lines
// as each is consumed (blank lines contribute none).
function renderMarkdown(lines, start, link) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  const countLine = (line) => {
    let inWord = false;
    for (let k = 0; k < line.length; k++) {
      if (WS_TABLE[line.charCodeAt(k)] === 1) inWord = false;
      else if (!inWord) { inWord = true; words++; }
    }
  };
  const n = lines.length;
  let i = start;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    countLine(line);
    const lang = fenceLang(line);
    if (lang !== null) {
      out.push('<pre><code');
      if (lang !== '') out.push(' class="language-', esc(lang), '"');
      out.push('>');
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        countLine(lines[i]);
        out.push(esc(lines[i]), '\n');
        i++;
      }
      if (i < n) { countLine(lines[i]); i++; }
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // '>'
      const kept = [];
      i++;
      let t0 = line.slice(1);
      if (t0.charCodeAt(0) === 32) t0 = t0.slice(1);
      t0 = trimLineStr(t0);
      if (t0 !== '') kept.push(t0);
      while (i < n && lines[i].charCodeAt(0) === 62) {
        countLine(lines[i]);
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLineStr(t);
        if (t !== '') kept.push(t);
        i++;
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>', inlineStr(kept.join('\n'), link), '</p>\n</blockquote>\n');
      continue;
    }
    const isBullet = (line[0] === '-' || line[0] === '*') && line[1] === ' ';
    const ord = isBullet ? null : ORDERED.exec(line);
    if (isBullet || ord !== null) {
      const isOrd = ord !== null;
      const items = [];
      let first = true;
      while (i < n) {
        const l = lines[i];
        let itemText = null;
        if (isOrd) {
          const m = ORDERED.exec(l);
          if (m !== null) itemText = m[2];
        } else if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
          itemText = l.slice(2);
        }
        if (itemText !== null) {
          if (!first) countLine(l);
          items.push([trimLineStr(itemText)]);
          i++;
          first = false;
          continue;
        }
        // Continuation: >= 2 leading spaces then a non-whitespace char.
        let sp = 0;
        while (sp < l.length && l[sp] === ' ') sp++;
        if (sp >= 2 && sp < l.length && !isWsCode(l.charCodeAt(sp))) {
          countLine(l);
          items[items.length - 1].push(trimLineStr(l));
          i++;
          first = false;
          continue;
        }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      if (isOrd && Number(ord[1]) !== 1) out.push(`<ol start="${Number(ord[1])}">\n`);
      else out.push(`<${tag}>\n`);
      for (const parts of items) out.push('<li>', inlineStr(parts.join('\n'), link), '</li>\n');
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLineStr(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      countLine(lines[i]);
      body.push(trimLineStr(lines[i]));
      i++;
    }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const ONLY_WS = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 0 text {s}, 1 var {p}, 2 raw {p}, 3 for {name,p,body},
// 4 if {not,p,then,els}, 5 include {name}.
function parseTemplate(name, src) {
  // Tokenize first (all token-level errors surface before structural ones).
  const tokens = [];
  let text = '';
  let i = 0;
  const L = src.length;
  while (i < L) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === L - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, s: text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? L : nl;
    const standalone = ONLY_WS.test(src.slice(lineStart, open)) && ONLY_WS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, s: text });
    text = '';
    tokens.push({ t: 6, s: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? L : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, s: text });

  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 0) { body.push({ k: 0, s: tok.s }); continue; }
    if (tok.t === 1 || tok.t === 2) { body.push({ k: tok.t, p: tok.p }); continue; }
    const tag = tok.s;
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = { k: 3, kind: 'for', name: m[1], p: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = { k: 4, kind: 'if', not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.els ?? parent.then;
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
      body.push({ k: 5, name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- shared value helpers (also passed into generated functions) ---

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function escTextOf(v) {
  return esc(textOf(v));
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- fallback interpreter (only used for cyclic includes) ---

function lookupScope(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodesInterp(nodes, scope, nodesMap, depth, out) {
  for (const n of nodes) {
    if (n.k === 0) out.push(n.s);
    else if (n.k === 1) out.push(escTextOf(lookupScope(scope, n.p)));
    else if (n.k === 2) out.push(textOf(lookupScope(scope, n.p)));
    else if (n.k === 4) {
      const branch = truthy(lookupScope(scope, n.p)) !== n.not ? n.then : n.els;
      if (branch !== null) renderNodesInterp(branch, scope, nodesMap, depth, out);
    } else if (n.k === 3) {
      const xs = lookupScope(scope, n.p);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        renderNodesInterp(n.body, { vars, parent: scope }, nodesMap, depth, out);
      }
    } else if (n.k === 5) {
      const t = nodesMap.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodesInterp(t, scope, nodesMap, depth + 1, out);
    }
  }
}

function interpInclude(nodesMap, name, scope, depth) {
  const t = nodesMap.get(name);
  if (t === undefined) return '';
  const out = [];
  renderNodesInterp(t, scope, nodesMap, depth, out);
  return out.join('');
}

// --- template compiler: nodes -> generated function ---

const ROOT_KNOWN = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

function scanLoop(nodes, stack, depth, nodesMap) {
  for (const n of nodes) {
    if (n.k === 1 || n.k === 2) {
      if (n.p[0] === 'loop') return true;
    } else if (n.k === 4) {
      if (n.p[0] === 'loop') return true;
      if (scanLoop(n.then, stack, depth, nodesMap)) return true;
      if (n.els !== null && scanLoop(n.els, stack, depth, nodesMap)) return true;
    } else if (n.k === 3) {
      if (n.p[0] === 'loop') return true;
    } else if (n.k === 5) {
      if (depth >= INCLUDE_DEPTH) continue;
      const t = nodesMap.get(n.name);
      if (t === undefined) continue;
      if (stack.includes(n.name)) return true;
      stack.push(n.name);
      const r = scanLoop(t, stack, depth + 1, nodesMap);
      stack.pop();
      if (r) return true;
    }
  }
  return false;
}

function emitPath(path, bindings, code) {
  let base = null;
  let found = false;
  for (let f = bindings.length - 1; f >= 0; f--) {
    const fr = bindings[f];
    if (path[0] === 'loop') {
      // Every for binds `loop`; the innermost frame's record wins (it also
      // wins over an element variable itself named `loop`).
      base = fr.loop !== null ? fr.loop : fr.elem;
      found = true;
      break;
    }
    if (fr.name === path[0]) {
      base = fr.elem;
      found = true;
      break;
    }
  }
  if (!found) {
    base = ROOT_KNOWN.has(path[0]) ? `V.${path[0]}` : `(_h(V,'${path[0]}')?V.${path[0]}:undefined)`;
  }
  code.push(`_t=${base};`);
  for (let k = 1; k < path.length; k++) {
    const seg = path[k];
    // Direct access matches the own-property rule for every segment except
    // names Object.prototype itself carries; those keep the hasOwn guard.
    if (DANGER_SEG.has(seg)) code.push(`_t=_t!==null&&typeof _t==='object'&&_h(_t,'${seg}')?_t.${seg}:undefined;`);
    else code.push(`_t=_t!==null&&typeof _t==='object'?_t.${seg}:undefined;`);
  }
}

const DANGER_SEG = new Set(['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

function snapshotExpr(bindings) {
  let e = '{vars:V,parent:null}';
  for (const fr of bindings) {
    let vars;
    if (fr.name === 'loop') vars = fr.loop !== null ? `{loop:${fr.loop}}` : `{loop:${fr.elem}}`;
    else if (fr.loop !== null) vars = `{${fr.name}:${fr.elem},loop:${fr.loop}}`;
    else vars = `{${fr.name}:${fr.elem}}`;
    e = `{vars:${vars},parent:${e}}`;
  }
  return e;
}

function genNodes(nodes, bindings, depth, stack, ctx) {
  const code = ctx.code;
  let pend = '';
  const flush = () => {
    if (pend !== '') {
      code.push(`out.push(${JSON.stringify(pend)});`);
      pend = '';
    }
  };
  for (const n of nodes) {
    if (n.k === 0) { pend += n.s; continue; }
    flush();
    if (n.k === 1) {
      emitPath(n.p, bindings, code);
      code.push('out.push(_e(_t));');
    } else if (n.k === 2) {
      emitPath(n.p, bindings, code);
      code.push('out.push(_r(_t));');
    } else if (n.k === 4) {
      emitPath(n.p, bindings, code);
      code.push(`if(_y(_t)!==${n.not}){`);
      genNodes(n.then, bindings, depth, stack, ctx);
      if (n.els !== null) {
        code.push('}else{');
        genNodes(n.els, bindings, depth, stack, ctx);
      }
      code.push('}');
    } else if (n.k === 3) {
      emitPath(n.p, bindings, code);
      const id = ctx.counter++;
      const arr = `_a${id}`;
      const len = `_l${id}`;
      const idx = `_i${id}`;
      const elem = `_v${id}`;
      const loop = `_o${id}`;
      const useLoop = scanLoop(n.body, stack.slice(), depth, ctx.nodesMap);
      code.push(`if(Array.isArray(_t)){const ${arr}=_t;const ${len}=${arr}.length;for(let ${idx}=0;${idx}<${len};${idx}++){const ${elem}=${arr}[${idx}];${useLoop ? `const ${loop}={index:${idx}+1,first:${idx}===0,last:${idx}===${len}-1,length:${len}};` : ''}`);
      bindings.push({ name: n.name, elem, loop: useLoop ? loop : null });
      genNodes(n.body, bindings, depth, stack, ctx);
      bindings.pop();
      code.push('}}');
    } else if (n.k === 5) {
      const target = ctx.nodesMap.get(n.name);
      if (target === undefined || depth >= INCLUDE_DEPTH) continue;
      if (stack.includes(n.name)) {
        code.push(`out.push(_i(_n,${JSON.stringify(n.name)},${snapshotExpr(bindings)},${depth + 1}));`);
      } else {
        stack.push(n.name);
        genNodes(target, bindings, depth + 1, stack, ctx);
        stack.pop();
      }
    }
  }
  flush();
}

function compileTemplate(name, nodesMap) {
  const ctx = { code: [], counter: 0, nodesMap };
  genNodes(nodesMap.get(name), [], 0, [name], ctx);
  const src = `let _t;\n${ctx.code.join('\n')}`;
  return new Function('out', 'V', '_e', '_r', '_y', '_h', '_i', '_n', src);
}

// -------------------------------------------------------------------- build

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) {
  slugCache = new Map();
  const report = [];
  const nodesMap = new Map();
  for (const name of Object.keys(input.templates).sort()) {
    try {
      nodesMap.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  for (const name of nodesMap.keys()) compiled.set(name, compileTemplate(name, nodesMap));

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit path order; .md = source, anything else static.
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const statics = [];
  let sources = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push(f);
  }

  // Front matter and the refusal chain, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!nodesMap.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown with link resolution cached per (directory, target) for the
  // whole case; broken targets are reported per source through the shared set.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const resolveLink = (dir, target) => {
    if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null) {
      const dest = bySource.get(path);
      if (dest !== undefined) return `${dest.url}${frag}`;
      if (staticPaths.has(path)) return `${base}/${path}${frag}`;
    }
    return null;
  };
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const key = `${dir}\n${target}`;
      let v = linkCache.get(key);
      if (v === undefined) {
        v = resolveLink(dir, target);
        linkCache.set(key, v);
      }
      if (v === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      return v;
    };
    const md = renderMarkdown(s.lines, s.bodyStart, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const list = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        list.push(name);
      }
    }
    return list;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // Cards and pages.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  const output = {};
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn(out, vars, escTextOf, textOf, truthy, hasOwn, interpInclude, nodesMap);
    return out.join('');
  };
  for (const s of sources) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      site, tags: allTags, recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCU);
  const pageCount = sources.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
