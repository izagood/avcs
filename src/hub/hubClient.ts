// Network object-gossip client against an AVCS hub (see hubServer.ts).
//
// Content-addressed union semantics, mirroring Repo.pull: only transfer what's missing,
// never mutate an existing object. push = send objects the hub lacks; pull = fetch
// objects we lack. Uses the global fetch available in Node 22.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStore } from "../store/objectStore.ts";
import { keysOf } from "../reducer/reducer.ts";
import type { AnyObject, Operation } from "../objects/types.ts";

/** GET /have → the set of oids the hub holds. */
async function hubHave(hubUrl: string): Promise<Set<string>> {
  const res = await fetch(`${hubUrl.replace(/\/$/, "")}/have`);
  if (!res.ok) throw new Error(`GET /have failed: ${res.status} ${res.statusText}`);
  const oids = (await res.json()) as string[];
  return new Set(oids);
}

/** Per-hub sync cursors persisted under .avcs/sync-cursors.json (E5). */
async function readCursors(root: string): Promise<Record<string, number>> {
  const p = join(root, "sync-cursors.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(await readFile(p, "utf8")) as Record<string, number>; } catch { return {}; }
}

/**
 * Discover the oids to consider pulling. Tries the incremental `GET /sync?since=N`
 * endpoint (E5): only the oids appended since the client's last cursor, plus the new
 * cursor. Falls back to the full `GET /have` against an older hub (cursor stays null).
 * Correctness never depends on the cursor — a wrong/stale one at worst transfers more.
 */
async function discover(base: string, since: number): Promise<{ oids: string[]; cursor: number | null }> {
  try {
    const res = await fetch(`${base}/sync?since=${since}`);
    if (res.ok) {
      const j = (await res.json()) as { oids: string[]; cursor: number };
      return { oids: j.oids, cursor: j.cursor };
    }
  } catch {
    // fall through to /have
  }
  return { oids: [...(await hubHave(base))], cursor: null };
}

/** Mirror Repo.pull's import side-effect: maintain the entity index for imported ops. */
async function indexIfOperation(store: ObjectStore, obj: AnyObject, oid: string): Promise<void> {
  if (obj.type === "operation") {
    for (const k of keysOf(obj as Operation)) await store.appendEntityIndex(k, oid);
  }
}

/**
 * Push objects the hub lacks: diff our local oids against GET /have and POST the
 * missing ones. Private (stash) ops are local-only and never gossiped — same rule as
 * Repo.pull. Returns how many objects were pushed.
 */
export async function pushToHub(localRepoDir: string, hubUrl: string): Promise<{ pushed: number; rejected: number }> {
  const base = hubUrl.replace(/\/$/, "");
  const store = new ObjectStore(localRepoDir);
  const have = await hubHave(base);
  let pushed = 0;
  let rejected = 0;
  for await (const obj of store.list()) {
    const oid = obj.oid as string;
    if (have.has(oid)) continue;
    if (obj.type === "operation" && (obj as Operation).private) continue; // stash stays local
    const res = await fetch(`${base}/objects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(obj),
    });
    if (res.status === 403) {
      rejected++; // gated hub refused an unauthorized op
      continue;
    }
    if (!res.ok) throw new Error(`POST /objects failed for ${oid}: ${res.status} ${res.statusText}`);
    pushed++;
  }
  return { pushed, rejected };
}

/**
 * Pull objects the local store lacks: GET /have, then GET each missing /objects/:oid
 * and put it locally (idempotent, content-addressed). Returns how many were pulled.
 */
export async function pullFromHub(localRepoDir: string, hubUrl: string): Promise<{ pulled: number }> {
  const base = hubUrl.replace(/\/$/, "");
  const store = new ObjectStore(localRepoDir);
  await store.init(); // tolerate a fresh local repo dir
  // Incremental discovery (E5): only consider oids the hub added since our last pull.
  const cursors = await readCursors(store.root);
  const since = cursors[base] ?? 0;
  const { oids, cursor } = await discover(base, since);
  let pulled = 0;
  for (const oid of oids) {
    if (await store.has(oid)) continue;
    const res = await fetch(`${base}/objects/${encodeURIComponent(oid)}`);
    if (res.status === 404) continue; // raced eviction; skip
    if (!res.ok) throw new Error(`GET /objects/${oid} failed: ${res.status} ${res.statusText}`);
    const obj = (await res.json()) as AnyObject;
    await store.put(obj as never);
    await indexIfOperation(store, obj, oid);
    pulled++;
  }
  // Advance the cursor only after the loop completed (a throw aborts before this, so a
  // failed pull retries from the same cursor next time — never a permanent miss).
  if (cursor !== null) { cursors[base] = cursor; await store.writeAux("sync-cursors.json", JSON.stringify(cursors)); }

  // Governance distribution: adopt the hub's authoritative governance refs (policy,
  // membership, protection, protected heads). The objects they point to were just
  // pulled above, so the refs resolve. Working refs (view:*/checkpoint:*) stay local.
  const refsRes = await fetch(`${base}/refs`);
  if (refsRes.ok) {
    const { refs } = (await refsRes.json()) as { refs: Record<string, string> };
    for (const [name, refOid] of Object.entries(refs)) {
      if (!/^(policy$|member:|protection:|head:)/.test(name)) continue;
      if (await store.has(refOid)) await store.setRef(name, refOid);
    }
  }
  // Propagate redactions: evict plaintext for blobs redacted after we pulled them.
  const { applyRedactions } = await import("./../store/applyRedactions.ts");
  await applyRedactions(store);
  return { pulled };
}

/**
 * Request a finalize (= PR merge) on the hub (E6): POST /finalize with the view, the new
 * checkpoint, the parent head being compare-and-swapped, and the finalizer. The hub runs
 * the authoritative CAS+lock+gates. When `signWith` is given the request is signed so a
 * gated hub can authenticate the finalizer. Returns the HTTP status + the hub's verdict.
 */
export async function finalizeOnHub(
  hubUrl: string,
  args: { view: string; newCheckpoint: string; parentHead: string | null; by: string; signWith?: { keyId: string; privateKey: string } },
): Promise<{ status: number; finalized: boolean; head?: string; reason?: string }> {
  const base = hubUrl.replace(/\/$/, "");
  const body: Record<string, unknown> = { view: args.view, newCheckpoint: args.newCheckpoint, parentHead: args.parentHead, by: args.by };
  if (args.signWith) {
    const { signMessage } = await import("../core/identity.ts");
    const msg = `finalize:${args.view}:${args.newCheckpoint}:${args.parentHead ?? ""}`;
    body.sig = { keyId: args.signWith.keyId, alg: "ed25519", sig: signMessage(args.signWith.privateKey, msg) };
  }
  const res = await fetch(`${base}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { finalized?: boolean; head?: string; reason?: string };
  return { status: res.status, finalized: j.finalized ?? false, head: j.head, reason: j.reason };
}
