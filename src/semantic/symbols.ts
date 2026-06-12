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

/**
 * Replace one symbol's text, returning the new file content. If the symbol does
 * not exist, it is appended. Pure and deterministic.
 */
export function spliceSymbol(
  content: string,
  symbolName: string,
  newText: string,
  indexer: EntityIndexer = tsIndexer,
): string {
  const spans = indexer.parse(content);
  const idx = spans.findIndex((s) => s.kind === "symbol" && s.name === symbolName);
  if (idx === -1) {
    spans.push({ kind: "symbol", key: symbolName, name: symbolName, text: newText });
  } else {
    spans[idx] = { kind: "symbol", key: symbolName, name: symbolName, text: newText };
  }
  return indexer.reassemble(spans);
}
