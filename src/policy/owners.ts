// Phase 5: code ownership.
//
// A `require_human` decision shouldn't go to "any human" — public-API and schema
// changes have *owners*. Owner rules map a scope pattern to the actor ids that must
// sign off, so the conflict queue can route a break to the right person instead of
// a generic prompt.

import type { OwnerRule, ScopeRef } from "../objects/types.ts";
export type { OwnerRule };

function matches(rule: ScopeRef, key: string): boolean {
  const pat = rule.replace(/\*+$/, "");
  const isPrefix = rule.endsWith("*") || pat.endsWith("/");
  if (pat === key) return true;
  if (isPrefix && key.startsWith(pat)) return true;
  // A file scope also owns symbols within (or under) it: rewrite the symbol key to
  // its file form and match again, so "file:src/api/" covers "symbol:src/api/x.ts#f".
  if (pat.startsWith("file:") && key.startsWith("symbol:")) {
    const symFile = key.slice("symbol:".length).split("#")[0] ?? "";
    const fileScope = `file:${symFile}`;
    if (pat === fileScope) return true;
    if (isPrefix && fileScope.startsWith(pat)) return true;
  }
  return false;
}

/** The distinct owners responsible for a contended key, most specific rules first. */
export function ownersFor(key: string, rules: OwnerRule[]): string[] {
  const hits = rules
    .filter((r) => matches(r.scope, key))
    // longer (more specific) scope patterns win ordering
    .sort((a, b) => b.scope.length - a.scope.length);
  const seen = new Set<string>();
  for (const h of hits) for (const o of h.owners) seen.add(o);
  return [...seen];
}
