// Phase 4: lightweight contract analysis for semantic-conflict detection.
//
// The dangerous merge in agentic coding is the one with NO text overlap: agent A
// changes a function's contract while agent B, blind to that, adds a caller under
// the old contract. Line-based VCS pass it; the build then breaks. This module
// extracts exported symbol signatures and finds references to a symbol, so the
// reducer can escalate "broke a contract + someone depends on it" to a human.
//
// MVP scope: a TS/JS-shaped heuristic over the symbol spans from `symbols.ts`. It is
// intentionally conservative (favors flagging) and pluggable per language, to be
// replaced by real type analysis in a later phase.

import { tsIndexer, type EntityIndexer } from "./symbols.ts";
import type { Evidence, Operation } from "../objects/types.ts";
import type { ReductionResult, SemanticConflict } from "../reducer/reducer.ts";

export interface SymbolSignature {
  name: string;
  /** Normalized parameter list, e.g. "a,b" — enough to detect arity/shape drift. */
  params: string;
  /** Declared return type if present, else "". */
  returns: string;
  exported: boolean;
}

const SIG =
  /^(export\s+(default\s+)?)?(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*([^={]+))?/;

/** Extract top-level function signatures from a file's content. */
export function signatures(content: string, indexer: EntityIndexer = tsIndexer): Map<string, SymbolSignature> {
  const out = new Map<string, SymbolSignature>();
  for (const span of indexer.parse(content)) {
    if (span.kind !== "symbol") continue;
    const m = SIG.exec(span.text.trim().split("\n")[0] ?? "");
    if (!m) continue;
    out.set(m[4]!, {
      name: m[4]!,
      params: normalizeParams(m[5] ?? ""),
      returns: (m[6] ?? "").trim(),
      exported: !!m[1],
    });
  }
  return out;
}

function normalizeParams(raw: string): string {
  return raw
    .split(",")
    .map((p) => p.trim().split(":")[0]!.trim().replace(/[?=].*$/, "").trim())
    .filter(Boolean)
    .join(",");
}

/** Did the public contract of `name` change between two file versions? */
export function contractChanged(beforeContent: string, afterContent: string, name: string): boolean {
  const a = signatures(beforeContent).get(name);
  const b = signatures(afterContent).get(name);
  if (!a || !b) return false; // appeared/disappeared handled elsewhere
  return a.params !== b.params || a.returns !== b.returns;
}

/**
 * Does `content` reference symbol `name` as a call or member access? Excludes the
 * symbol's own declaration line so a function doesn't "reference itself".
 */
export function referencesSymbol(content: string, name: string): boolean {
  const re = new RegExp(`(?<![A-Za-z0-9_$.])${escapeRe(name)}\\s*\\(`);
  for (const line of content.split("\n")) {
    if (new RegExp(`function\\s+${escapeRe(name)}\\b`).test(line)) continue; // its own decl
    if (re.test(line)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Localize the symbol a breaking op changed, if it can be pinned down. */
function brokenSymbol(op: Operation): { file: string; name: string } | null {
  if (op.target.entityKind === "symbol" && op.target.entityId.includes("#")) {
    const [file, name] = op.target.entityId.split("#");
    if (file && name) return { file, name };
  }
  if (op.body.kind === "set_symbol" && op.body.path && op.body.symbolName) {
    return { file: op.body.path, name: op.body.symbolName };
  }
  return null;
}

/**
 * Find contract breaks: an accepted op actually CHANGED a symbol's signature (params
 * or return), while another accepted op references that symbol — a text-clean but
 * meaning-broken merge. Crucially this works whether or not the author declared
 * `breaksPublicApi`: it compares signatures, so it catches the *undeclared* break
 * the policy gate would otherwise miss. An op with trusted `api_compat=pass`
 * evidence is exonerated.
 *
 * `evidence` should already be the trust-filtered set. Pure over its inputs.
 */
export function detectSemanticConflicts(
  ops: Operation[],
  result: ReductionResult,
  evidence: Evidence[],
  blobContent: Map<string, string>,
): SemanticConflict[] {
  const accepted = ops.filter((o) => result.statuses.get(o.oid as string) === "accepted");
  const contentOf = (path: string | undefined): string => {
    if (!path) return "";
    const oid = result.tree.get(path);
    if (!oid) return "";
    return result.synthBlobs.get(oid) ?? blobContent.get(oid) ?? "";
  };
  const blob = (oid: string | undefined): string => (oid ? blobContent.get(oid) ?? "" : "");
  const hasApiCompat = (opOid: string) =>
    evidence.some((e) => e.forOps.includes(opOid) && e.kind === "api_compat" && e.result === "pass");

  // Base signature of a symbol in a file = its signature in the put_file that
  // established that file (the scaffold), so we can see what a later edit changed.
  const baseSigFor = (file: string, name: string): SymbolSignature | undefined => {
    const baseOp = accepted.find((o) => o.body.kind === "put_file" && o.body.path === file);
    if (!baseOp) return undefined;
    return signatures(blob(baseOp.body.blobOid)).get(name);
  };

  const out: SemanticConflict[] = [];
  for (const O of accepted) {
    // Localize the symbol this op edits and the new signature it installs.
    let file: string | undefined;
    let name: string | undefined;
    let newSig: SymbolSignature | undefined;
    if (O.body.kind === "set_symbol" && O.body.path && O.body.symbolName) {
      file = O.body.path;
      name = O.body.symbolName;
      newSig = signatures(blob(O.body.blobOid)).get(name);
    } else {
      const sym = brokenSymbol(O);
      if (sym) {
        file = sym.file;
        name = sym.name;
        newSig = signatures(contentOf(file)).get(name);
      }
    }
    if (!file || !name || !newSig) continue;

    const baseSig = baseSigFor(file, name);
    const changed = baseSig
      ? baseSig.params !== newSig.params || baseSig.returns !== newSig.returns
      : !!O.effects?.breaksPublicApi; // no base to diff → trust the declared flag
    if (!changed) continue;
    if (hasApiCompat(O.oid as string)) continue;

    const dependentOps = accepted
      .filter((P) => P !== O && P.body.path !== file && referencesSymbol(contentOf(P.body.path), name!))
      .map((P) => P.oid as string);
    if (dependentOps.length === 0) continue;

    out.push({
      kind: "contract_break",
      symbol: `${file}#${name}`,
      breakingOp: O.oid as string,
      dependentOps,
      reason: `${name}'s signature changed (${baseSig?.params ?? "?"} → ${newSig.params}), but ${dependentOps.length} accepted op(s) call it under the old contract, with no api_compat=pass evidence`,
    });
  }
  return out;
}
