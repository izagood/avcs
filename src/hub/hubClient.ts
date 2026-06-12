// Network object-gossip client against an AVCS hub (see hubServer.ts).
//
// Content-addressed union semantics, mirroring Repo.pull: only transfer what's missing,
// never mutate an existing object. push = send objects the hub lacks; pull = fetch
// objects we lack. Uses the global fetch available in Node 22.

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
  const have = await hubHave(base);
  let pulled = 0;
  for (const oid of have) {
    if (await store.has(oid)) continue;
    const res = await fetch(`${base}/objects/${encodeURIComponent(oid)}`);
    if (res.status === 404) continue; // raced eviction; skip
    if (!res.ok) throw new Error(`GET /objects/${oid} failed: ${res.status} ${res.statusText}`);
    const obj = (await res.json()) as AnyObject;
    await store.put(obj as never);
    await indexIfOperation(store, obj, oid);
    pulled++;
  }

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
  return { pulled };
}
