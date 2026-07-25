// Phase 16 M3 (docs/18 §M3) — ContextPack.
//
// Without this an agent reconstructs its working context by hand — blame here, history
// there, decisions somewhere else — and pays a round trip for each. context.build assembles
// the whole picture once, under a byte budget.
//
// Two decisions shape it:
//
//  - **No content.** Symbols carry provenance and a blobOid, never the file text. Text is
//    the one thing an agent can fetch precisely (object.show with lines/maxBytes), so
//    spending the pack's budget on it would crowd out the things it cannot cheaply derive.
//
//  - **Deterministic truncation.** Section priority is fixed, ordering inside a section is
//    fixed, and the greedy fill measures compact serialization bytes. The same input
//    therefore yields byte-identical output — the same determinism AVCS demands of reduce,
//    applied to context. What was dropped is recorded in `budget.truncated`, never silently
//    missing: an agent that cannot tell a thin repo from a truncated pack will make
//    confident decisions on partial information.

import { keysOf } from "../reducer/reducer.ts";
import type { Repo } from "../api/repo.ts";
import type { Intent, Operation, Session } from "../objects/types.ts";

export interface ContextPackArgs {
  intentOid?: string;
  entityKeys?: string[];
  paths?: string[];
  view?: string;
  maxBytes?: number;
}

/** Section fill order = priority order. Risks first: a pack that omits "someone else holds
 *  a lease on this key" is worse than no pack, because it reads as an all-clear. History is
 *  last because it is the most reconstructible from other tools. */
const SECTIONS = ["risks", "decisions", "policies", "symbols", "evidence", "history", "suggestedOps"] as const;
type Section = (typeof SECTIONS)[number];

export async function buildContextPack(repo: Repo, args: ContextPackArgs): Promise<Record<string, unknown>> {
  const view = args.view ?? "main";
  const maxBytes = Math.max(1, Math.floor(args.maxBytes ?? 8192));

  const keys = await resolveScope(repo, args);
  if (!keys.length) {
    throw new Error(
      "context.build needs a scope: pass intentOid, entityKeys or paths. " +
        "Refusing to pack the whole repo — an unbounded context is the problem this tool exists to solve.",
    );
  }

  const res = await repo.materialize(view);
  const [leases, policies, quarantined] = await Promise.all([
    repo.activeLeases(),
    repo.learnedPolicies(),
    repo.quarantinedOps(view).catch(() => [] as string[]),
  ]);
  const quarantinedSet = new Set(quarantined);

  const symbols: Record<string, unknown>[] = [];
  const decisions: Record<string, unknown>[] = [];
  const risks: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown>[] = [];

  for (const key of keys) {
    const blame = await repo.blame(key, view);
    if (blame) {
      symbols.push({
        key,
        blobOid: res.tree.get(key.replace(/^file:/, "")) ?? null,
        owner: blame.actor.id,
        intent: blame.intentTitle ?? null,
        purpose: blame.purpose,
      });
    }
    for (const d of await repo.recallDecisions(key)) {
      decisions.push({ key, reason: d.reason, futurePolicy: d.futurePolicy ?? null, by: d.decidedBy });
    }
    // Recency-first, then oid — a total order, so the greedy fill is reproducible.
    const hist = (await repo.historyOf(key)).slice(-3).reverse();
    for (const op of hist) {
      history.push({ key, op: op.oid, actor: op.actor.id, purpose: op.declaredPurpose });
      if (quarantinedSet.has(op.oid as string)) {
        risks.push({ kind: "quarantine", key, detail: `op ${String(op.oid).slice(0, 16)} is quarantined pending review` });
      }
    }
    for (const c of res.conflicts) {
      if (c.key === key) risks.push({ kind: "conflict", key, detail: c.reason });
    }
    for (const l of leases) {
      if (l.writeScopes.some((s) => s === key)) {
        risks.push({ kind: "lease", key, detail: `held by ${l.actor.id} until ${l.expiresAt}` });
      }
    }
  }

  // Byte sizes must be read off the same tree the pack is pinned to.
  const files = await repo.materializedBytes(res).catch(() => [] as { path: string; bytes: Buffer }[]);
  const sizeOf = new Map(files.map((f) => [f.path, f.bytes.length]));
  for (const s of symbols) s.bytes = sizeOf.get(String(s.key).replace(/^file:/, "")) ?? null;

  // v1 is deliberately thin (docs/18 §3.1): derived from learned policies and failed
  // evidence, not invented. A confident wrong suggestion is worse than none.
  const suggestedOps = policies.map((p) => `learned policy: ${p}`);

  const built: Record<Section, unknown[]> = {
    risks: dedupe(risks),
    decisions,
    policies,
    symbols,
    evidence,
    history,
    suggestedOps,
  };

  // Greedy fill in priority order over COMPACT bytes — the same serialization the transport
  // will send, so the budget means what it says.
  const out: Record<string, unknown> = { v: 1, view, treeHash: res.treeHash };
  const truncated: string[] = [];
  const envelopeCost = JSON.stringify({ ...out, budget: { maxBytes, usedBytes: maxBytes, truncated: SECTIONS } }).length;
  let used = envelopeCost;
  for (const name of SECTIONS) {
    const cost = JSON.stringify(built[name]).length + name.length + 4;
    if (used + cost <= maxBytes) {
      out[name] = built[name];
      used += cost;
    } else {
      out[name] = [];
      if (built[name].length) truncated.push(name);
    }
  }
  out.budget = { maxBytes, usedBytes: JSON.stringify(out).length, truncated };
  return out;
}

/** Resolve the requested scope to entity keys, sorted for a stable fill order. */
async function resolveScope(repo: Repo, args: ContextPackArgs): Promise<string[]> {
  const keys = new Set<string>(args.entityKeys ?? []);
  for (const p of args.paths ?? []) keys.add(`file:${p}`);

  if (args.intentOid) {
    // The intent's declared scopes, plus what its sessions' ops ACTUALLY touched — the
    // declaration is the plan, the ops are the reality, and an agent needs both.
    const intent = await repo.readIntent(args.intentOid).catch(() => null as Intent | null);
    for (const s of intent?.allowedScopes ?? []) keys.add(String(s));
    const sessions = await repo.store.collect<Session>("session");
    const mine = new Set(sessions.filter((s) => s.intentOid === args.intentOid).map((s) => s.oid as string));
    for (const op of await repo.store.collect<Operation>("operation")) {
      if (op.sessionOid && mine.has(op.sessionOid)) for (const k of keysOf(op)) keys.add(k);
    }
  }
  return [...keys].sort();
}

/** Stable de-dup preserving first occurrence — two sources can report the same risk. */
function dedupe(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const k = JSON.stringify(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
