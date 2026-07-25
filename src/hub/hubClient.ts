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
import { buildAuthHeader } from "./transportAuth.ts";
import type { AnyObject, Operation } from "../objects/types.ts";

/** The local actor key used to authenticate a write to a hub (SSH-style transport auth,
 *  see transportAuth.ts). Optional: omit against a read-public/ungated hub that requires
 *  no transport credential. The same keypair already used to sign objects is reused. */
export interface HubSigner {
  keyId: string;
  privateKey: string;
}

/** Build fetch headers for a hub write, attaching an AVCS-Sig Authorization header when a
 *  signer is supplied. `path` must equal the server's pathname or the signature won't verify. */
function writeHeaders(signer: HubSigner | undefined, method: string, path: string, body: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signer) headers["authorization"] = buildAuthHeader({ keyId: signer.keyId, privateKey: signer.privateKey, method, path, body });
  return headers;
}

/**
 * Headers for a hub READ (issue #50).
 *
 * The reference hub is read-public (D2), so reads went out bare and the omission was
 * invisible against it. It stops being invisible for an embedder with per-repo access
 * control, which necessarily gates reads — and the failure there is total rather than
 * partial, because `pushToHub` opens with GET /have, so a 401 on reads breaks push too.
 *
 * Best-effort by design: no signer, no header, and a read-public hub is unaffected. The
 * signature covers the method, so a captured GET credential cannot be replayed as a write.
 */
function readHeaders(signer: HubSigner | undefined, path: string): Record<string, string> {
  if (!signer) return {};
  return { authorization: buildAuthHeader({ keyId: signer.keyId, privateKey: signer.privateKey, method: "GET", path, body: "" }) };
}

/** GET /have → the set of oids the hub holds. */
async function hubHave(hubUrl: string, signer?: HubSigner): Promise<Set<string>> {
  const res = await fetch(`${hubUrl.replace(/\/$/, "")}/have`, { headers: readHeaders(signer, "/have") });
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
async function discover(base: string, since: number, signer?: HubSigner): Promise<{ oids: string[]; cursor: number | null }> {
  try {
    const res = await fetch(`${base}/sync?since=${since}`, { headers: readHeaders(signer, "/sync") });
    if (res.ok) {
      const j = (await res.json()) as { oids: string[]; cursor: number };
      return { oids: j.oids, cursor: j.cursor };
    }
  } catch {
    // fall through to /have
  }
  return { oids: [...(await hubHave(base, signer))], cursor: null };
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
export async function pushToHub(localRepoDir: string, hubUrl: string, signWith?: HubSigner): Promise<{ pushed: number; rejected: number }> {
  const base = hubUrl.replace(/\/$/, "");
  const store = new ObjectStore(localRepoDir);
  const have = await hubHave(base, signWith);
  let pushed = 0;
  let rejected = 0;
  for await (const obj of store.list()) {
    const oid = obj.oid as string;
    if (have.has(oid)) continue;
    if (obj.type === "operation" && (obj as Operation).private) continue; // stash stays local
    const body = JSON.stringify(obj);
    const res = await fetch(`${base}/objects`, {
      method: "POST",
      headers: writeHeaders(signWith, "POST", "/objects", body),
      body,
    });
    if (res.status === 401) {
      // Transport auth failed (no/invalid request signature): a write-auth hub refused the
      // connection itself. Distinct from 403 (signed in, but this object's role/signature
      // is insufficient). Surface it loudly — retrying object-by-object would all fail.
      throw new Error(`POST /objects unauthorized (401) for ${oid}: ${(await res.json().catch(() => ({})) as { error?: string }).error ?? "transport auth required"}`);
    }
    if (res.status === 403) {
      rejected++; // gated hub refused an unauthorized op (object-level role/signature)
      continue;
    }
    if (!res.ok) throw new Error(`POST /objects failed for ${oid}: ${res.status} ${res.statusText}`);
    pushed++;
  }
  return { pushed, rejected };
}

/**
 * Pull objects the local store lacks: GET /have, then GET each missing /objects/:oid
 * and put it locally (idempotent, content-addressed). Returns how many were pulled,
 * plus the highest Lamport timestamp among the imported operations (0 when none) so
 * the caller can advance its clock past the imported history (Phase 13.2
 * observe-on-import — subsequently issued lamports sort after what was pulled).
 */
export async function pullFromHub(localRepoDir: string, hubUrl: string, signWith?: HubSigner): Promise<{ pulled: number; maxLamport: number }> {
  const base = hubUrl.replace(/\/$/, "");
  const store = new ObjectStore(localRepoDir);
  await store.init(); // tolerate a fresh local repo dir
  // Incremental discovery (E5): only consider oids the hub added since our last pull.
  const cursors = await readCursors(store.root);
  const since = cursors[base] ?? 0;
  const { oids, cursor } = await discover(base, since, signWith);
  let pulled = 0;
  let maxLamport = 0;
  for (const oid of oids) {
    if (await store.has(oid)) continue;
    const res = await fetch(`${base}/objects/${encodeURIComponent(oid)}`, { headers: readHeaders(signWith, `/objects/${encodeURIComponent(oid)}`) });
    if (res.status === 404) continue; // raced eviction; skip
    if (!res.ok) throw new Error(`GET /objects/${oid} failed: ${res.status} ${res.statusText}`);
    const obj = (await res.json()) as AnyObject;
    await store.put(obj as never);
    await indexIfOperation(store, obj, oid);
    if (obj.type === "operation") maxLamport = Math.max(maxLamport, (obj as Operation).lamport);
    pulled++;
  }
  // Advance the cursor only after the loop completed (a throw aborts before this, so a
  // failed pull retries from the same cursor next time — never a permanent miss).
  if (cursor !== null) { cursors[base] = cursor; await store.writeAux("sync-cursors.json", JSON.stringify(cursors)); }

  // Governance distribution: adopt the hub's authoritative governance refs (policy,
  // membership, protection, protected heads). The objects they point to were just
  // pulled above, so the refs resolve. Working refs (view:*/checkpoint:*) stay local.
  const refsRes = await fetch(`${base}/refs`, { headers: readHeaders(signWith, "/refs") });
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
  return { pulled, maxLamport };
}

/**
 * Submit a draft checkpoint to the hub's integration queue (Phase 14, docs/17 §14.4):
 * push the local delta, POST /integrate, and on `needs_evidence` pull ONLY the
 * `missingLocally` oids the hub says are needed to reproduce the integrated tree.
 * NO retry loop, NO re-proposal, NO redo — the caller's next action is at most "run
 * validation once against exactly the integrated tree → attach evidence → resubmit the
 * same ticket". Returns the hub's structured verdict plus the HTTP status.
 */
export async function integrateWithHub(
  localRepoDir: string,
  hubUrl: string,
  args: { view: string; checkpoint: string; by: string; ticketId?: string; signWith?: HubSigner },
): Promise<{ status: number; verdict: string } & Record<string, unknown>> {
  const base = hubUrl.replace(/\/$/, "");
  // 1. Delta push: whatever the hub lacks (the draft checkpoint, its ops/blobs, evidence).
  await pushToHub(localRepoDir, hubUrl, args.signWith);
  // 2. One judgment call. Two signatures as with finalize: body.sig authenticates the
  // integrate INTENT (object layer), the Authorization header the REQUEST (transport).
  const body: Record<string, unknown> = { view: args.view, checkpoint: args.checkpoint, by: args.by, ...(args.ticketId ? { ticketId: args.ticketId } : {}) };
  if (args.signWith) {
    const { signMessage } = await import("../core/identity.ts");
    const msg = `integrate:${args.view}:${args.checkpoint}:${args.ticketId ?? ""}`;
    body.sig = { keyId: args.signWith.keyId, alg: "ed25519", sig: signMessage(args.signWith.privateKey, msg) };
  }
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/integrate`, { method: "POST", headers: writeHeaders(args.signWith, "POST", "/integrate", raw), body: raw });
  const j = (await res.json().catch(() => ({}))) as { verdict?: string; missingLocally?: string[] } & Record<string, unknown>;
  // 3. needs_evidence: fetch exactly the head-side delta so `materializeAt` can reproduce
  // the integrated tree locally (determinism guarantees the same treeHash).
  if (Array.isArray(j.missingLocally) && j.missingLocally.length) {
    const store = new ObjectStore(localRepoDir);
    for (const oid of j.missingLocally) {
      if (typeof oid !== "string" || (await store.has(oid))) continue;
      const or = await fetch(`${base}/objects/${encodeURIComponent(oid)}`);
      if (!or.ok) continue; // raced eviction — the resubmission will re-report it
      const obj = (await or.json()) as AnyObject;
      await store.put(obj as never);
      await indexIfOperation(store, obj, oid);
    }
  }
  return { status: res.status, verdict: j.verdict ?? "rejected", ...j };
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
  // The finalize request also carries a transport-auth header (write-auth hubs require it).
  // Two distinct signatures: body.sig authenticates the finalize INTENT (object layer), the
  // Authorization header authenticates the REQUEST (transport layer). Both use one keypair.
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/finalize`, { method: "POST", headers: writeHeaders(args.signWith, "POST", "/finalize", raw), body: raw });
  const j = (await res.json().catch(() => ({}))) as { finalized?: boolean; head?: string; reason?: string };
  return { status: res.status, finalized: j.finalized ?? false, head: j.head, reason: j.reason };
}
