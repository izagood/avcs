// Phase 2: structured (symbol-granular) view of a source file.
//
// This is the seam that turns "same file" conflicts into "same symbol" conflicts.
// A file is parsed into an ordered list of spans — named top-level symbols and the
// gaps between them (imports, blank lines). Two operations that edit *different*
// symbols of the same file then occupy different conflict keys and auto-merge (L1),
// while two edits to the *same* symbol still contend.
//
// MVP scope: a brace/line scanner for TS/JS-shaped code. It is deliberately a
// pluggable `EntityIndexer` so a Tree-sitter backend can replace it per language
// without touching the reducer. It is approximate (well-formatted code), and falls
// back to whole-file semantics when a file does not parse into named symbols.

export interface Span {
  kind: "symbol" | "gap";
  /** Stable key within the file: the symbol name, or `@gap:<index>` for gaps. */
  key: string;
  name?: string;
  text: string;
}

export interface EntityIndexer {
  language: string;
  parse(content: string): Span[];
  reassemble(spans: Span[]): string;
}

const DECL =
  /^(export\s+(default\s+)?)?(async\s+)?(function|class|interface|enum|namespace|type|const|let|var)\s+([A-Za-z0-9_$]+)/;

/** Top-level declaration kinds that own a brace-delimited body. */
const BRACE_FORMS = new Set(["function", "class", "interface", "enum", "namespace"]);

/**
 * Split TS/JS source into symbol + gap spans. Brace depth is tracked across the
 * whole text so nested braces inside a symbol don't end it early. Strings and line
 * comments are handled well enough for ordinary code.
 */
function parse(content: string): Span[] {
  const lines = content.split("\n");
  const spans: Span[] = [];
  let gapBuf: string[] = [];
  let gapIdx = 0;
  const flushGap = () => {
    if (gapBuf.length) {
      spans.push({ kind: "gap", key: `@gap:${gapIdx++}`, text: gapBuf.join("\n") });
      gapBuf = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = DECL.exec(line.trim());
    if (!m) {
      gapBuf.push(line);
      i++;
      continue;
    }
    const keyword = m[4]!;
    const name = m[5]!;
    flushGap();
    if (BRACE_FORMS.has(keyword) || /[{(]/.test(line)) {
      // Consume lines until brace depth returns to 0 after having opened.
      let depth = 0;
      let opened = false;
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        body.push(l);
        depth += braceDelta(l);
        if (depth > 0) opened = true;
        i++;
        if (opened && depth <= 0) break;
        if (!opened && /;\s*$/.test(l)) break; // e.g. `const x = 1;` with parens but no block
      }
      spans.push({ kind: "symbol", key: name, name, text: body.join("\n") });
    } else {
      // Single-line / statement form (const/type/let), may span to a `;`.
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        body.push(l);
        i++;
        if (/;\s*$/.test(l) || !lines[i] || DECL.test((lines[i] ?? "").trim())) break;
      }
      spans.push({ kind: "symbol", key: name, name, text: body.join("\n") });
    }
  }
  flushGap();
  return spans;
}

/** Net `{`+`(` minus `}`+`)` on a line, ignoring those in strings/line comments. */
function braceDelta(line: string): number {
  let depth = 0;
  let str: string | null = null;
  for (let j = 0; j < line.length; j++) {
    const c = line[j]!;
    if (str) {
      if (c === "\\") j++;
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") str = c;
    else if (c === "/" && line[j + 1] === "/") break;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

function reassemble(spans: Span[]): string {
  return spans.map((s) => s.text).join("\n");
}

export const tsIndexer: EntityIndexer = { language: "typescript", parse, reassemble };

/** List the symbol names in a file (stable ids), in source order. */
export function symbolNames(content: string, indexer: EntityIndexer = tsIndexer): string[] {
  return indexer.parse(content).filter((s) => s.kind === "symbol").map((s) => s.name!);
}

/** A top-level declaration line starts at column 0 (no leading whitespace). This is the
 *  fallback used when the brace scanner fails to surface a symbol that nonetheless exists
 *  in the text — replacing its declaration in place instead of blindly appending a
 *  duplicate. Returns null if no top-level declaration of `name` is found. */
function replaceTopLevelDecl(content: string, name: string, newText: string): string | null {
  const lines = content.split("\n");
  const topDeclName = (line: string): string | null => {
    if (!/^\S/.test(line)) return null; // must be column 0
    const m = DECL.exec(line.trim());
    return m && m[5] === name ? name : null;
  };
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (topDeclName(lines[i]!) === name) { start = i; break; }
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (/^\S/.test(l) && DECL.test(l.trim())) { end = j; break; } // next top-level decl
  }
  return [...lines.slice(0, start), newText, ...lines.slice(end)].join("\n");
}

/**
 * Replace one symbol's text, returning the new file content. If the symbol does not
 * exist, it is appended. Pure and deterministic.
 *
 * D5 duplicate-guard: when the brace scanner can't find the symbol as a span but a
 * top-level declaration of that name DOES exist in the text (the scanner mis-parsed —
 * e.g. a template literal containing `}`), blindly appending would create a SECOND
 * definition of the symbol: a `set_symbol` meant to UPDATE silently duplicates instead.
 * We fall back to a column-0 declaration scan and replace the existing decl in place. A
 * genuinely-new symbol (no existing decl) is still appended.
 */
export function spliceSymbol(
  content: string,
  symbolName: string,
  newText: string,
  indexer: EntityIndexer = tsIndexer,
): string {
  const spans = indexer.parse(content);
  const idx = spans.findIndex((s) => s.kind === "symbol" && s.name === symbolName);
  if (idx !== -1) {
    spans[idx] = { kind: "symbol", key: symbolName, name: symbolName, text: newText };
    return indexer.reassemble(spans);
  }
  // Not found as a span. Avoid a duplicate definition if the decl actually exists.
  const replaced = replaceTopLevelDecl(content, symbolName, newText);
  if (replaced !== null) return replaced;
  spans.push({ kind: "symbol", key: symbolName, name: symbolName, text: newText });
  return indexer.reassemble(spans);
}

const isIdChar = (c: string): boolean => c >= "a" && c <= "z" || c >= "A" && c <= "Z" || c >= "0" && c <= "9" || c === "_" || c === "$";

/**
 * M3 AST op: rename a top-level symbol — its declaration AND its references WITHIN
 * the same file. Renames only whole-identifier occurrences in CODE, deliberately
 * skipping strings, template-literal text, and comments (a regex `\bfrom\b` would
 * also rewrite `from` inside a comment or a "from" string — silent corruption; D5).
 * Template interpolations `${…}` are treated as code, so identifiers there ARE renamed.
 * Cross-file references need real reference analysis (tree-sitter) — Track C. Pure.
 */
export function renameSymbol(content: string, from: string, to: string): string {
  if (!from || !to || from === to) return content;
  type Mode =
    | { k: "code"; interp: boolean; depth: number }
    | { k: "line" } | { k: "block" } | { k: "sq" } | { k: "dq" } | { k: "tmpl" };
  const stack: Mode[] = [{ k: "code", interp: false, depth: 0 }];
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const m = stack[stack.length - 1]!;
    const c = content[i]!;
    const c2 = content[i + 1];
    if (m.k === "code") {
      if (c === "/" && c2 === "/") { out += "//"; i += 2; stack.push({ k: "line" }); continue; }
      if (c === "/" && c2 === "*") { out += "/*"; i += 2; stack.push({ k: "block" }); continue; }
      if (c === "'") { out += c; i++; stack.push({ k: "sq" }); continue; }
      if (c === '"') { out += c; i++; stack.push({ k: "dq" }); continue; }
      if (c === "`") { out += c; i++; stack.push({ k: "tmpl" }); continue; }
      if (m.interp && c === "{") { m.depth++; out += c; i++; continue; }
      if (m.interp && c === "}") {
        if (m.depth === 0) { stack.pop(); out += c; i++; continue; } // closes ${…} → back to tmpl
        m.depth--; out += c; i++; continue;
      }
      if (isIdChar(c) && !(c >= "0" && c <= "9")) {
        let j = i;
        while (j < n && isIdChar(content[j]!)) j++;
        const word = content.slice(i, j);
        out += word === from ? to : word;
        i = j;
        continue;
      }
      if (isIdChar(c)) { // a numeric/identifier run starting with a digit — never a rename target
        let j = i;
        while (j < n && isIdChar(content[j]!)) j++;
        out += content.slice(i, j);
        i = j;
        continue;
      }
      out += c; i++; continue;
    }
    if (m.k === "line") { out += c; i++; if (c === "\n") stack.pop(); continue; }
    if (m.k === "block") { if (c === "*" && c2 === "/") { out += "*/"; i += 2; stack.pop(); continue; } out += c; i++; continue; }
    if (m.k === "sq" || m.k === "dq") {
      const q = m.k === "sq" ? "'" : '"';
      if (c === "\\") { out += content.slice(i, i + 2); i += 2; continue; }
      out += c; i++; if (c === q) stack.pop(); continue;
    }
    // template literal
    if (c === "\\") { out += content.slice(i, i + 2); i += 2; continue; }
    if (c === "`") { out += c; i++; stack.pop(); continue; }
    if (c === "$" && c2 === "{") { out += "${"; i += 2; stack.push({ k: "code", interp: true, depth: 0 }); continue; }
    out += c; i++;
  }
  return out;
}

/**
 * M3 AST op support: extract one top-level symbol's text and return it together with
 * the file content that remains (symbol removed). Returns null if the symbol is absent.
 */
export function extractSymbol(
  content: string,
  symbolName: string,
  indexer: EntityIndexer = tsIndexer,
): { text: string; rest: string } | null {
  const spans = indexer.parse(content);
  const idx = spans.findIndex((s) => s.kind === "symbol" && s.name === symbolName);
  if (idx === -1) return null;
  const text = spans[idx]!.text;
  const rest = indexer.reassemble(spans.filter((_, i) => i !== idx));
  return { text, rest };
}
