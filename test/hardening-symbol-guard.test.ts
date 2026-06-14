// Track D / D5 — symbol-merge safety. The symbol scanner is approximate (full AST is
// Track C / tree-sitter), but two silent-corruption vectors are fixable deterministically
// today and must never produce wrong code:
//   (a) renameSymbol rewriting an identifier inside a string / comment;
//   (b) spliceSymbol APPENDING a duplicate definition when the scanner mis-parses a file
//       that nonetheless contains the symbol (a "set" that silently duplicates).

import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSymbol, spliceSymbol, symbolNames } from "../src/semantic/symbols.ts";

// ── (a) renameSymbol skips strings & comments, renames code + interpolations ──

test("renameSymbol does not touch identifiers inside strings", () => {
  const src = `function helper() { return 1 }\nconst msg = "call helper here"\nconst c = helper()\n`;
  const out = renameSymbol(src, "helper", "compute");
  assert.match(out, /function compute\(\)/, "declaration renamed");
  assert.match(out, /const c = compute\(\)/, "code reference renamed");
  assert.match(out, /"call helper here"/, "string content untouched");
});

test("renameSymbol does not touch identifiers inside line/block comments", () => {
  const src = `// helper is great\nfunction helper() { return 1 }\n/* helper again */\nconst c = helper()\n`;
  const out = renameSymbol(src, "helper", "compute");
  assert.match(out, /\/\/ helper is great/, "line comment untouched");
  assert.match(out, /\/\* helper again \*\//, "block comment untouched");
  assert.match(out, /function compute\(\)/);
  assert.match(out, /const c = compute\(\)/);
});

test("renameSymbol renames inside template interpolation but not template text", () => {
  const src = "function helper(){return 1}\nconst s = `helper says ${helper()}`\n";
  const out = renameSymbol(src, "helper", "compute");
  assert.match(out, /function compute\(\)/);
  assert.ok(out.includes("`helper says ${compute()}`"), `interpolation renamed, text kept: ${out}`);
});

test("renameSymbol only matches whole identifiers (no substring)", () => {
  const src = `const help = 1\nconst helper = 2\nconst helperX = 3\n`;
  const out = renameSymbol(src, "helper", "compute");
  assert.match(out, /const help = 1/, "shorter name untouched");
  assert.match(out, /const compute = 2/, "exact match renamed");
  assert.match(out, /const helperX = 3/, "longer name untouched");
});

// ── (b) spliceSymbol never creates a duplicate definition ──

test("spliceSymbol replaces an existing parseable symbol (no duplicate)", () => {
  const src = `export function f() {\n  return 1\n}\n`;
  const out = spliceSymbol(src, "f", "export function f() {\n  return 2\n}");
  assert.equal(symbolNames(out).filter((n) => n === "f").length, 1, "still exactly one f");
  assert.match(out, /return 2/);
  assert.doesNotMatch(out, /return 1/);
});

test("spliceSymbol appends a genuinely new symbol", () => {
  const src = `export function f() { return 1 }\n`;
  const out = spliceSymbol(src, "g", "export function g() { return 9 }");
  assert.match(out, /function f\(\)/);
  assert.match(out, /function g\(\)/);
});

test("spliceSymbol does NOT duplicate when the scanner mis-parses but the decl exists", () => {
  // A template literal with a stray `}` throws off brace counting, so the scanner may
  // fail to surface `broken` as a clean span. A naive splice would append a 2nd copy.
  const src =
    "export function broken() {\n" +
    "  const t = `oops } unbalanced`\n" +
    "  return t\n" +
    "}\n" +
    "export function after() { return 0 }\n";
  const out = spliceSymbol(src, "broken", "export function broken() {\n  return 'fixed'\n}");
  // The decl is replaced in place — exactly one top-level `function broken` must remain.
  const count = (out.match(/function broken\(/g) ?? []).length;
  assert.equal(count, 1, `expected one definition of broken, got ${count}\n---\n${out}`);
  assert.match(out, /return 'fixed'/, "new body applied");
  assert.match(out, /function after\(\)/, "the following symbol is preserved");
});

test("spliceSymbol idempotency: re-splicing a symbol with its own text is a no-op", () => {
  const src = `import x from "y"\n\nexport function f() {\n  return 1\n}\n\nexport const z = 2\n`;
  const names = symbolNames(src);
  const fText = "export function f() {\n  return 1\n}";
  const out = spliceSymbol(src, "f", fText);
  assert.deepEqual(symbolNames(out), names, "symbol set unchanged");
  assert.match(out, /export const z = 2/, "other symbols preserved");
});
