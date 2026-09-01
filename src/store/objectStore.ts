// Append-only, content-addressed object store.
//
// Physical layout (under <repo>/.avcs):
//   objects/<aa>/<oid>.json      immutable objects, sharded by oid prefix
//   refs/<name>                  named pointers (e.g. the default view), mutable
//   HEAD                         the active view name
//
// Objects are never modified or deleted. "Changing" the world means appending a new
// object (a new operation, a decision, a superseding op). This is what makes AVCS
// fully auditable: the entire causal history of how code reached its current state
// is replayable.

import { mkdir, readFile, readdir, stat, open, rename, appendFile, rm } from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { Buffer } from "node:buffer";
import { computeOid, sha256hex, assertInteropSafe } from "../core/canonical.ts";
import { encodeCbor, decodeCbor, looksLikeCbor } from "../core/cbor.ts";
import { withLock, type LockOptions } from "./lock.ts";
import { mapLimit } from "../concurrency/mapLimit.ts";
import type { AnyObject, ObjectType } from "../objects/types.ts";

/**
 * A stored object's bytes could not be decoded — bit-rot, truncation, or a torn write
 * that slipped past the atomic-write guarantee (D1). Typed (not an opaque `SyntaxError`)
 * and carries the offending `oid` so a decode failure deep in `materialize`/`pull` is
 * actionable: the caller knows exactly which object to `fsck`/repair. F1 (docs/13).
 */
export class CorruptObjectError extends Error {
  readonly oid?: string;
  constructor(message: string, opts?: { oid?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CorruptObjectError";
    this.oid = opts?.oid;
  }
}

/** Deserialize a stored object: CBOR (new format) or legacy canonical-JSON, sniffed by
 *  the first byte. oids are JSON-derived so both formats address identically (B1). Any
 *  malformed input (truncated CBOR, broken JSON, empty file) is normalized to a typed
 *  {@link CorruptObjectError} carrying `oid` — never an opaque parser throw (F1). */
function decodeObject<T>(raw: Buffer, oid?: string): T {
  try {
    return (looksLikeCbor(raw) ? decodeCbor(raw) : JSON.parse(raw.toString("utf8"))) as T;
  } catch (e) {
    const where = oid ? ` ${oid}` : "";
    throw new CorruptObjectError(`undecodable object${where}: ${(e as Error).message}`, { oid, cause: e });
  }
}

interface PackLoc { file: string; offset: number; length: number; }

/** Opt-out of fsync for throughput-bound bulk loads (D1). Durability traded for speed. */
const NO_FSYNC = process.env.AVCS_NO_FSYNC === "1";

export class ObjectStore {
  readonly root: string; // the .avcs directory
  #wc = 0; // temp-file counter for atomic writes
  #packLoc: Map<string, PackLoc> | null = null; // lazy oid → pack location index (B2)
  constructor(repoDir: string) {
    this.root = ObjectStore.resolveStoreDir(repoDir);
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, "objects"), { recursive: true });
    await mkdir(join(this.root, "refs"), { recursive: true });
    await mkdir(join(this.root, "locks"), { recursive: true });
    await mkdir(join(this.root, "indexes", "entity"), { recursive: true });
    if (!existsSync(join(this.root, "HEAD"))) {
      await this.#writeAtomic(join(this.root, "HEAD"), "main");
    }
  }

  /**
   * Crash- and concurrency-safe write: write a unique temp file in the same dir,
   * fsync it, then atomically rename over the target. A reader therefore sees either
   * the old file or the complete new one — never a torn/partial read. (H-5)
   *
   * After the rename we fsync the *containing directory* (D1): a fsync of the file
   * persists its bytes but not necessarily the directory entry created by the rename,
   * so a power loss could otherwise lose a just-written object/ref/HEAD even after
   * this call returned. Set AVCS_NO_FSYNC=1 to skip all fsyncs for throughput-bound
   * bulk loads (durability traded for speed).
   */
  async #writeAtomic(path: string, data: string | Buffer): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${++this.#wc}`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data);
      if (!NO_FSYNC) await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path); // atomic on the same filesystem
    await this.#fsyncDir(dirname(path)); // persist the new directory entry
  }

  /**
   * fsync a directory so a just-created/renamed/appended entry survives power loss.
   * Best-effort: some platforms reject opening a directory for fsync (EISDIR/EPERM/
   * EINVAL) — there the rename's own ordering is the durability guarantee, so we
   * swallow those rather than fail the write. No-op under AVCS_NO_FSYNC.
   */
  async #fsyncDir(dir: string): Promise<void> {
    if (NO_FSYNC) return;
    let dh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      dh = await open(dir, "r");
      await dh.sync();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code && !["EISDIR", "EPERM", "EINVAL", "ENOENT", "EACCES"].includes(code)) throw e;
    } finally {
      await dh?.close();
    }
  }

  /**
   * Durable append: append `line` to a file, fsync the file's data, and fsync its
   * directory (the first append also creates the directory entry). This is what keeps
   * the op-log and entity index from losing their last record(s) on a hard crash. (D1)
   */
  async #appendDurable(path: string, line: string): Promise<void> {
    await appendFile(path, line, "utf8");
    if (NO_FSYNC) return;
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(path, "r+");
      await fh.sync();
    } finally {
      await fh?.close();
    }
    await this.#fsyncDir(dirname(path));
  }

  /**
   * Atomically write a derived auxiliary file under the repo's `.avcs` root, reusing the
   * crash-safe temp→fsync→rename→fsync-dir path (D1/D2). For repo-managed caches the
   * store doesn't model as objects — e.g. the compaction snapshot. `relPath` is resolved
   * under root; parent dirs are created. Crash-safe: a reader sees old-or-complete, and
   * the file survives a hard crash once this returns.
   */
  async writeAux(relPath: string, data: string | Buffer): Promise<void> {
    const p = join(this.root, relPath);
    await mkdir(dirname(p), { recursive: true });
    await this.#writeAtomic(p, data);
  }

  /** Read an auxiliary file under the repo's `.avcs` root, or null when absent. The read
   *  counterpart of {@link writeAux}: atomic writes guarantee old-or-complete, so a plain
   *  read never observes a torn file. */
  async readAux(relPath: string): Promise<Buffer | null> {
    const p = join(this.root, relPath);
    if (!existsSync(p)) return null;
    return readFile(p);
  }

  /** Durably append a line to an auxiliary log under the repo's `.avcs` root (e.g. the
   *  hub audit log, E7). Reuses the fsync-file + fsync-dir append path. */
  async appendAux(relPath: string, line: string): Promise<void> {
    const p = join(this.root, relPath);
    await mkdir(dirname(p), { recursive: true });
    await this.#appendDurable(p, line);
  }

  /** Run a critical section under a named cross-process lock (see lock.ts). */
  async withLock<T>(name: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T> {
    return withLock(join(this.root, "locks"), name, fn, opts);
  }

  // ── entity index (Phase 9) ──────────────────────────────────────────────
  // An append-only secondary index: entity key → op oids, sharded by key hash, so
  // "history of this symbol" is O(ops-on-that-entity) instead of a full-store scan.
  // It is a rebuildable cache (O_APPEND keeps small records atomic across processes).
  #indexPathFor(key: string): string {
    const h = sha256hex(key);
    return join(this.root, "indexes", "entity", h.slice(0, 2), `${h.slice(0, 32)}.idx`);
  }
  async appendEntityIndex(key: string, oid: string): Promise<void> {
    if (this.#batch) { this.#batch.index.push([key, oid]); return; } // flushed grouped per key
    const p = this.#indexPathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await this.#appendDurable(p, `${oid}\n`);
  }
  async readEntityIndex(key: string): Promise<string[]> {
    const p = this.#indexPathFor(key);
    if (!existsSync(p)) return [];
    const seen = new Set<string>();
    for (const line of (await readFile(p, "utf8")).split("\n")) if (line) seen.add(line);
    return [...seen];
  }

  /**
   * Where `repoDir`'s store physically lives. Normally `<repoDir>/.avcs`. But `.avcs` may
   * instead be a *pointer file* holding a single `avcsdir: <path>` line, in which case the
   * store lives at that path and several working trees share ONE store — the same trick git
   * uses when a linked working tree's `.git` is a file saying `gitdir: <path>`.
   *
   * Deliberately git-free: the pointer is AVCS's own marker, so this works for any kind of
   * linked working tree, or for none at all. A relative path is resolved against the
   * directory holding the pointer. Pure/synchronous — every store open goes through it.
   * A malformed or unreadable pointer degrades to the plain path, so the caller's usual
   * "not an AVCS repo" error surfaces instead of a parse throw.
   */
  static resolveStoreDir(repoDir: string): string {
    const here = join(repoDir, ".avcs");
    try {
      if (!statSync(here).isFile()) return here;
      const m = /^avcsdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(here, "utf8"));
      if (!m?.[1]) return here;
      return isAbsolute(m[1]) ? m[1] : resolve(repoDir, m[1]);
    } catch {
      return here; // absent, unreadable, or a directory racing us — the plain path is right
    }
  }

  static isRepo(repoDir: string): boolean {
    return existsSync(join(ObjectStore.resolveStoreDir(repoDir), "objects"));
  }

  /**
   * Locate the AVCS repo that owns `startDir` by walking up the directory tree until a
   * directory satisfies {@link isRepo} (i.e. has `.avcs/objects`). This is AVCS's own
   * root-finding — analogous to how git ascends to find `.git`, but keyed entirely on
   * AVCS's own marker so it works with no git present. Returns the owning repo dir, or
   * `null` if no ancestor (including `startDir` itself) is a repo. Pure/synchronous so
   * the CLI and MCP server can both resolve a working dir to its store cheaply.
   */
  static findRepoRoot(startDir: string): string | null {
    let dir = resolve(startDir);
    // Ascend until the parent stops changing (filesystem root reached).
    for (;;) {
      if (ObjectStore.isRepo(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  #pathFor(oid: string): string {
    // shard by the first 2 hex chars after the type prefix
    const hexStart = oid.indexOf("_") + 1;
    const shard = oid.slice(hexStart, hexStart + 2) || "00";
    return join(this.root, "objects", shard, `${oid}.json`);
  }

  /**
   * Write an object. Returns its oid. Idempotent: writing identical content yields
   * the same oid and is a no-op if already present (append-only honored).
   */
  async put<T extends AnyObject>(obj: T): Promise<string> {
    const { oid: _ignore, ...payload } = obj as T & { oid?: string };
    void _ignore;
    // THE gate for the interop-safe subset, placed here because this is the single choke
    // point every object passes through — authoring, pull, importBundle, importObjects, a
    // hub push. A check on the authoring APIs alone would be a check with a bypass, and
    // `custom:<name>` evidence puts a user-chosen string into `Checkpoint.evidence` as an
    // object KEY, which is hashed material. See `assertInteropSafe`.
    assertInteropSafe(payload, obj.type);
    const oid = computeOid(obj.type, payload as Record<string, unknown>);
    if (this.#batch) {
      // Staged, not written: the enclosing batched() flushes via putMany. Skip what disk or
      // this batch already holds — the same idempotency as the disk path.
      if (!existsSync(this.#pathFor(oid)) && !this.#batch.byOid.has(oid)) {
        this.#batch.objs.push(obj);
        this.#batch.byOid.set(oid, { ...(payload as Record<string, unknown>), oid } as AnyObject);
      }
      return oid;
    }
    const p = this.#pathFor(oid);
    if (!existsSync(p)) {
      await mkdir(dirname(p), { recursive: true });
      // Atomic: concurrent writers of the same oid write distinct temp files and the
      // rename is a no-op overwrite with identical content; never a torn object.
      // Stored as canonical CBOR (B1) — oid stays JSON-derived, so this is oid-neutral.
      await this.#writeAtomic(p, encodeCbor({ ...payload, oid }));
      // Op-log (docs/11 A5): append the oid of every NEWLY-written operation to a single
      // append-only log, AFTER the object is durable. This is the choke point through
      // which every op enters the store — authoring, pull, importBundle, hub push — so
      // the log is automatically consistent with the op set regardless of ingress path.
      // It lets a reader tail only the ops added since its last read (incremental reduce)
      // instead of scanning every shard. O_APPEND keeps small records atomic across
      // processes (same pattern as the entity index).
      if (obj.type === "operation") await this.#appendDurable(join(this.root, "oplog"), `${oid}\n`);
      // Object-log (E5 / docs/13): append EVERY newly-written object's oid (all types)
      // to a single append-only log in arrival order. A hub serves `GET /sync?since=N`
      // from it so a client fetches only objects added since its last sync, instead of
      // diffing the whole oid set each time. Append-only (never reordered in normal
      // operation), so a numeric cursor is stable. Rebuildable cache; backfilled lazily.
      await this.#appendDurable(join(this.root, "objlog"), `${oid}\n`);
    }
    return oid;
  }

  /**
   * Op-log in authoring/arrival order (docs/11 A5). Returns oids of every operation ever
   * written, deduped, FIRST-WRITE order preserved. May include oids of operations later
   * removed by GC (the store is the source of truth — callers tolerate a missing object).
   * Empty for a store created before the op-log existed; `rebuildOpLog` backfills it.
   */
  async readOpLog(): Promise<string[]> {
    const p = join(this.root, "oplog");

    const seen = new Set<string>();
    const out: string[] = [];
    if (existsSync(p)) {
      for (const line of (await readFile(p, "utf8")).split("\n"))
        if (line && !seen.has(line)) { seen.add(line); out.push(line); }
    }
    // Read-your-writes extends to LOG-DERIVED reads, not just get/has. `contention()`'s
    // closure walks #allOpsTailed ← readOpLog to find "my ops"; if a batch's staged op is
    // invisible here, the closure misses it, and the very op it BUILT ON surfaces as a
    // foreign write — a spurious warning the sequential path never produced. Caught by
    // contention-across-lines.test.ts the first time batched() shipped without this.
    if (this.#batch) {
      for (const [oid, obj] of this.#batch.byOid)
        if (obj.type === "operation" && !seen.has(oid)) { seen.add(oid); out.push(oid); }
    }
    return out;
  }

  /**
   * Object-log in arrival order (E5): oids of EVERY object ever written, deduped,
   * first-write order preserved. A store predating the log (or one that just upgraded)
   * is backfilled once from a full scan — that scan order becomes this hub's stable
   * append base. Append-only afterward, so an index into it is a valid sync cursor.
   */
  async readObjLog(): Promise<string[]> {
    const p = join(this.root, "objlog");
    if (!existsSync(p)) await this.#backfillObjLog();

    const seen = new Set<string>();
    const out: string[] = [];
    if (existsSync(p)) {
      for (const line of (await readFile(p, "utf8")).split("\n"))
        if (line && !seen.has(line)) { seen.add(line); out.push(line); }
    }
    if (this.#batch) { // same read-your-writes rule as readOpLog above
      for (const oid of this.#batch.byOid.keys())
        if (!seen.has(oid)) { seen.add(oid); out.push(oid); }
    }
    return out;
  }

  /** One-time backfill of the object-log for a store that predates it. */
  async #backfillObjLog(): Promise<void> {
    const oids: string[] = [];
    for await (const o of this.list()) oids.push(o.oid as string);
    if (oids.length) await this.#writeAtomic(join(this.root, "objlog"), oids.map((o) => `${o}\n`).join(""));
  }

  /** Backfill the op-log from a full scan (for stores predating it, or after corruption).
   *  Rewrites it atomically to the current operation set in canonical oid order. */
  async rebuildOpLog(): Promise<number> {
    const oids: string[] = [];
    for await (const o of this.list("operation")) oids.push(o.oid as string);
    oids.sort();
    await this.#writeAtomic(join(this.root, "oplog"), oids.map((o) => `${o}\n`).join(""));
    return oids.length;
  }

  /**
   * Redaction exception (Phase 12): overwrite the object stored AT `oid` with new
   * content that no longer hashes to it. This is the ONE place append-only/content-
   * addressing yields — used only by an admin-signed Redaction to evict leaked bytes
   * while keeping the oid (and every reference to it) valid.
   */
  async overwriteAt(oid: string, obj: AnyObject): Promise<void> {
    const { oid: _drop, ...payload } = obj as AnyObject & { oid?: string };
    void _drop;
    const p = this.#pathFor(oid);
    await mkdir(dirname(p), { recursive: true }); // shard dir may not exist yet on a fresh clone
    await this.#writeAtomic(p, encodeCbor({ ...payload, oid }));
  }

  /**
   * GC exception: delete an object file. Used only by `repo.gc` to reclaim objects
   * that are unreachable from the authoritative graph (orphan blobs, expired
   * quarantined ops). The append-only audit history of accepted ops is never removed.
   */
  async deleteObject(oid: string): Promise<void> {
    const p = this.#pathFor(oid);
    if (existsSync(p)) await rm(p, { force: true });
  }

  async get<T extends AnyObject = AnyObject>(oid: string): Promise<T> {
    // Read-your-writes inside batched(): authoring code reads what it just staged.
    const staged = this.#batch?.byOid.get(oid);
    if (staged) return staged as T;
    const p = this.#pathFor(oid);
    if (existsSync(p)) return decodeObject<T>(await readFile(p), oid); // loose shadows packs
    const loc = (await this.#packLocations()).get(oid);
    if (loc) return decodeObject<T>(await this.#readPackSlice(loc), oid);
    return decodeObject<T>(await readFile(p), oid); // absent → throws ENOENT (prior behavior)
  }

  async has(oid: string): Promise<boolean> {
    if (this.#batch?.byOid.has(oid)) return true; // staged counts — read-your-writes
    return existsSync(this.#pathFor(oid)) || (await this.#packLocations()).has(oid);
  }

  /** Stream every object of a given type — loose objects first, then packed ones (B2). */
  /**
   * Every oid this store holds — WITHOUT reading a single object body.
   *
   * An oid is already the filename (loose) or the pack-index key (packed), yet the only
   * listing this store offered was `list()`, which reads and decodes every object just to
   * yield it. Callers that need only the set — `GET /have`, push negotiation — paid ~1ms per
   * object per call, so a no-change re-sync grew linearly with history (measured: 208 objects
   * 283ms, 3,208 objects 3.5s; a 39k-object repo pays ~40s per watch cycle).
   *
   * Same set as `list()` yields: loose shards by filename, plus packed entries not shadowed
   * by a re-added loose copy. Corrupt bodies do not throw here — nothing is read — which is
   * also why negotiation must not: announcing is not vouching, `get` still verifies.
   */
  /** In-flight authoring batch (see {@link batched}), or null outside one. */
  #batch: { objs: AnyObject[]; byOid: Map<string, AnyObject>; index: [string, string][] } | null = null;

  /**
   * Run `fn` with every `put`/`appendEntityIndex` STAGED in memory, then flush the lot as
   * one group commit (issue #33 / the third site of #55's perf finding).
   *
   * The authoring path — `commitWorkingTree` looping blob put + op put + index append per
   * file — paid the same serial-fsync amplification the transfer paths did: a 100-file
   * commit measured 4.69s on an idle machine, and the avcs hook stages the WHOLE worktree,
   * which is how pre-commit ingest reaches 30s under load (#33).
   *
   * Semantics:
   *  - read-your-writes: `has`/`get` serve staged objects, so authoring code that reads
   *    what it just wrote keeps working.
   *  - durability AT RETURN is unchanged — the flush is `putMany`'s group commit, so the
   *    oplog is appended only after every body is durable, exactly as `put` promises.
   *  - a throw inside `fn` leaves NOTHING on disk: a crash mid-commit becomes a clean
   *    no-op instead of a partial commit — strictly better than the sequential behavior.
   *  - lamport quality is unaffected: the in-process clock ticks per staged op, and
   *    `#maxLamportSeen` is a cross-process ordering QUALITY aid whose absence during the
   *    batch changes nothing the reducer depends on (it tie-breaks by (lamport, oid)).
   *  - contention checks inside the batch see pre-batch state only; same-batch ops share
   *    one actor, which the check never warns about anyway.
   *
   * Nesting is refused rather than flattened — a silently flattened inner batch would make
   * the outer one's "all or nothing" a lie.
   */
  async batched<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#batch) throw new Error("nested batched() is not supported — the outer batch's atomicity would silently stop holding");
    const b = { objs: [] as AnyObject[], byOid: new Map<string, AnyObject>(), index: [] as [string, string][] };
    this.#batch = b;
    let out: T;
    try {
      out = await fn();
    } finally {
      // Unset BEFORE flushing (putMany must take the disk path), and unconditionally — a
      // throw discards the staging so nothing lands.
      this.#batch = null;
    }
    if (b.objs.length) await this.putMany(b.objs);
    if (b.index.length) await this.appendEntityIndexMany(b.index);
    return out;
  }

  /**
   * Store many objects with GROUP-COMMITTED durability (issue #55's perf follow-up).
   *
   * `put` costs 4 serial fsyncs per object (tmp fsync + dir fsync + objlog append's file and
   * dir fsyncs; +2 more for an operation's oplog entry). On macOS each is milliseconds, so a
   * transfer paid ~25ms/object — a 1,602-object push took 145s with a 98.4%-idle CPU profile.
   * The bytes were never the cost; the round trips were.
   *
   * This keeps every durability guarantee and reorders the waiting:
   *
   *   1. bodies: tmp-write + fsync with bounded parallelism, then rename, then ONE dir
   *      fsync per distinct shard touched — same "old file or complete new file" atomicity.
   *   2. oplog: ONE append for the chunk's operations. Order is the contract: the reducer
   *      trusts every oplog line to resolve, so the append happens only after every body in
   *      the chunk is durable — the same "AFTER the object is durable" rule `put` documents.
   *   3. objlog: ONE append for everything new.
   *
   * Work is chunked (128) so a crash exposes at most one chunk's window — the same failure
   * class as a sequential loop dying between an object's rename and its log append, just
   * bounded instead of per-object. Both logs are rebuildable caches.
   *
   * Content addressing is unchanged: the incoming `oid` field is ignored and recomputed, so
   * a forged object lands at its own address here exactly as it does in `put`.
   */
  async putMany(objects: AnyObject[]): Promise<{ oid: string; existed: boolean }[]> {
    const results: { oid: string; existed: boolean }[] = new Array(objects.length);
    const CHUNK = 128;
    const PARALLEL = 8;

    for (let base = 0; base < objects.length; base += CHUNK) {
      const chunk = objects.slice(base, base + CHUNK);
      // Plan the chunk: compute addresses, drop what already exists (content-addressed, so
      // "existing" is decided by the oid alone), and de-dupe repeats within the batch.
      const plan: { at: number; oid: string; path: string; bytes: Buffer; isOp: boolean }[] = [];
      const inChunk = new Set<string>();
      for (let i = 0; i < chunk.length; i++) {
        const obj = chunk[i]!;
        const { oid: _ignore, ...payload } = obj as AnyObject & { oid?: string };
        void _ignore;
        // The interop-safe gate (docs/24) guards `put` as the single choke point — a second
        // ingress that skips it would be exactly the "check with a bypass" it exists to avoid.
        assertInteropSafe(payload, obj.type);
        const oid = computeOid(obj.type, payload as Record<string, unknown>);
        const p = this.#pathFor(oid);
        if (existsSync(p) || inChunk.has(oid)) {
          results[base + i] = { oid, existed: true };
          continue;
        }
        inChunk.add(oid);
        results[base + i] = { oid, existed: false };
        plan.push({ at: base + i, oid, path: p, bytes: encodeCbor({ ...payload, oid }) as Buffer, isOp: obj.type === "operation" });
      }
      if (!plan.length) continue;

      // 1. Bodies. Parallel fsyncs overlap in the device queue — the serial latency was the
      //    whole cost. Renames after every body is synced, then one fsync per shard dir.
      for (let i = 0; i < plan.length; i += PARALLEL) {
        await Promise.all(plan.slice(i, i + PARALLEL).map(async (w) => {
          await mkdir(dirname(w.path), { recursive: true });
          const tmp = `${w.path}.tmp-${process.pid}-${++this.#wc}`;
          const fh = await open(tmp, "w");
          try {
            await fh.writeFile(w.bytes);
            if (!NO_FSYNC) await fh.sync();
          } finally {
            await fh.close();
          }
          await rename(tmp, w.path);
        }));
      }
      const shards = new Set(plan.map((w) => dirname(w.path)));
      for (const d of shards) await this.#fsyncDir(d);

      // 2. oplog — only now, with every body in the chunk durable.
      const opLines = plan.filter((w) => w.isOp).map((w) => `${w.oid}
`).join("");
      if (opLines) await this.#appendDurable(join(this.root, "oplog"), opLines);
      // 3. objlog.
      await this.#appendDurable(join(this.root, "objlog"), plan.map((w) => `${w.oid}
`).join(""));
    }
    return results;
  }

  /**
   * Append many entity-index entries with one durable append PER KEY FILE instead of per
   * entry. A pull indexes every arriving operation, which was 2 more fsyncs each; grouping
   * by key keeps the per-key ORDER (blame reads it) while a 1,600-op pull touching 25 files
   * pays 25 appends instead of 1,600.
   */
  async appendEntityIndexMany(entries: [key: string, oid: string][]): Promise<void> {
    const byPath = new Map<string, string[]>();
    for (const [key, oid] of entries) {
      const p = this.#indexPathFor(key);
      let lines = byPath.get(p);
      if (!lines) { lines = []; byPath.set(p, lines); }
      lines.push(oid);
    }
    for (const [p, lines] of byPath) {
      await mkdir(dirname(p), { recursive: true });
      await this.#appendDurable(p, lines.map((o) => `${o}
`).join(""));
    }
  }

  async listOids(type?: ObjectType): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const objectsDir = join(this.root, "objects");
    if (existsSync(objectsDir)) {
      for (const shard of await readdir(objectsDir)) {
        const shardDir = join(objectsDir, shard);
        if (!(await stat(shardDir)).isDirectory()) continue;
        for (const file of await readdir(shardDir)) {
          if (!file.endsWith(".json")) continue;
          const oid = file.slice(0, -".json".length);
          if (type && !oid.startsWith(`${type}_`)) continue;
          seen.add(oid);
          out.push(oid);
        }
      }
    }
    for (const [oid] of await this.#packLocations()) {
      if (seen.has(oid)) continue;
      if (type && !oid.startsWith(`${type}_`)) continue;
      out.push(oid);
    }
    return out;
  }

  async *list<T extends AnyObject = AnyObject>(type?: ObjectType): AsyncGenerator<T> {
    const seen = new Set<string>();
    const objectsDir = join(this.root, "objects");
    if (existsSync(objectsDir)) {
      for (const shard of await readdir(objectsDir)) {
        const shardDir = join(objectsDir, shard);
        if (!(await stat(shardDir)).isDirectory()) continue;
        for (const file of await readdir(shardDir)) {
          if (!file.endsWith(".json")) continue;
          if (type && !file.startsWith(`${type}_`)) continue;
          seen.add(file.slice(0, -".json".length));
          yield decodeObject<T>(await readFile(join(shardDir, file)), file.slice(0, -".json".length));
        }
      }
    }
    for (const [oid, loc] of await this.#packLocations()) {
      if (seen.has(oid)) continue; // a re-added loose copy already yielded
      if (type && !oid.startsWith(`${type}_`)) continue;
      yield decodeObject<T>(await this.#readPackSlice(loc), oid);
    }
  }

  // ── packing (docs/11 B2) ──────────────────────────────────────────────────
  // Many tiny loose object files are inode-heavy and slow to scan. `pack` folds them
  // into a single append-only packfile + index (oid → offset,length). Reads check loose
  // first, then packs, so packing is a transparent read optimization. BLOBS are never
  // packed: redaction overwrites a blob's bytes in place (overwriteAt), and rewriting a
  // packfile to evict bytes is costly — keeping blobs loose makes redaction always able
  // to scrub plaintext. (Operations/evidence/decisions/etc. are append-only & immutable.)
  async #packLocations(): Promise<Map<string, PackLoc>> {
    if (this.#packLoc) return this.#packLoc;
    const m = new Map<string, PackLoc>();
    const dir = join(this.root, "packs");
    if (existsSync(dir)) {
      for (const f of await readdir(dir)) {
        if (!f.endsWith(".idx")) continue;
        const packFile = join(dir, `${f.slice(0, -".idx".length)}.pack`);
        for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
          if (!line) continue;
          const [oid, off, len] = line.split(" "); // oids contain no spaces
          if (oid) m.set(oid, { file: packFile, offset: Number(off), length: Number(len) });
        }
      }
    }
    this.#packLoc = m;
    return m;
  }

  async #readPackSlice(loc: PackLoc): Promise<Buffer> {
    const fh = await open(loc.file, "r");
    try {
      const buf = Buffer.alloc(loc.length);
      await fh.read(buf, 0, loc.length, loc.offset);
      return buf;
    } finally {
      await fh.close();
    }
  }

  /**
   * Fold all loose NON-blob objects into a new packfile (+ index), then delete the loose
   * copies. Idempotent in effect (already-packed objects have no loose file). Reads stay
   * correct throughout (loose-first, then packs). Returns how many objects were packed.
   */
  async pack(): Promise<{ packed: number }> {
    return this.withLock("pack", async () => {
      const objectsDir = join(this.root, "objects");
      if (!existsSync(objectsDir)) return { packed: 0 };
      const entries: { oid: string; bytes: Buffer }[] = [];
      for (const shard of await readdir(objectsDir)) {
        const shardDir = join(objectsDir, shard);
        if (!(await stat(shardDir)).isDirectory()) continue;
        for (const file of await readdir(shardDir)) {
          if (!file.endsWith(".json") || file.startsWith("blob_")) continue; // blobs stay loose
          entries.push({ oid: file.slice(0, -".json".length), bytes: await readFile(join(shardDir, file)) });
        }
      }
      if (entries.length === 0) return { packed: 0 };
      entries.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0)); // deterministic layout
      const packDir = join(this.root, "packs");
      await mkdir(packDir, { recursive: true });
      const n = (await readdir(packDir)).filter((f) => f.endsWith(".pack")).length;
      const base = `pack-${n}`;
      const idxLines: string[] = [];
      let offset = 0;
      for (const e of entries) {
        idxLines.push(`${e.oid} ${offset} ${e.bytes.length}`);
        offset += e.bytes.length;
      }
      // Write the packfile + index BEFORE removing loose copies (crash-safe: a crash
      // leaves both, and reads prefer loose — never a lost object).
      await this.#writeAtomic(join(packDir, `${base}.pack`), Buffer.concat(entries.map((e) => e.bytes)));
      await this.#writeAtomic(join(packDir, `${base}.idx`), `${idxLines.join("\n")}\n`);
      for (const e of entries) await rm(this.#pathFor(e.oid), { force: true });
      this.#packLoc = null; // invalidate the index cache
      return { packed: entries.length };
    });
  }

  /**
   * Every object of a type, as an array.
   *
   * Reads in a bounded fan-out rather than one at a time. This used to drain `list()` — a
   * generator that awaits one `readFile` per object — so gathering N objects cost N
   * round-trips of latency with the CPU idle between them, and every caller that wants a
   * whole type paid it: `gc` (operations, then blobs), evidence/decision gathering, intent
   * and lease listing, the MCP context and watch paths.
   *
   * `listOids` walks the same shards in the same order without reading a body, so the oids
   * are known up front and the reads are independent. Order and set are therefore identical
   * to `list()`'s — several callers index or diff the result — and a corrupt body still
   * throws rather than shortening the answer.
   *
   * `list` stays a generator on purpose: it is the memory-bounded streaming API, and a
   * caller that streams does not want the whole type buffered.
   */
  async collect<T extends AnyObject = AnyObject>(type?: ObjectType): Promise<T[]> {
    return mapLimit(await this.listOids(type), ObjectStore.READ_CONCURRENCY, (oid) => this.get<T>(oid));
  }

  /**
   * How many object reads a single `collect` keeps in flight.
   *
   * High enough that latency stops dominating, low enough to stay well inside a default
   * file-descriptor limit while other work also has files open.
   */
  static readonly READ_CONCURRENCY = 64;

  // ── refs ────────────────────────────────────────────────────────────────
  //
  // A ref name is an opaque string that addresses a FILE. `line:<branch>` derives from a
  // git branch, and `feature/x` is the convention most teams use, so a name routinely
  // contains `/`. Joining it straight onto the refs dir puts the write in a directory
  // nothing created — `git commit` then fails outright (issue #52).
  //
  // `mkdir -p` is NOT the fix: listRefs reads a flat directory, so a nested file would be
  // invisible to it, and listRefs is what feeds hub governance distribution. That trades a
  // loud failure for a silently missing ref, which is worse. Percent-encoding instead keeps
  // the name→file mapping total, reversible and flat. `%` is escaped first (and decoded
  // last) so the encoding stays unambiguous: `a/b` and the literal `a%2Fb` remain distinct.
  //
  // Names without these characters encode to themselves, so existing repos need no
  // migration and keep reading exactly as before.
  static #encodeRefName(name: string): string {
    return name.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/\\/g, "%5C");
  }
  static #decodeRefName(file: string): string {
    return file.replace(/%2F/g, "/").replace(/%5C/g, "\\").replace(/%25/g, "%");
  }

  async setRef(name: string, oid: string): Promise<void> {
    await this.#writeAtomic(join(this.root, "refs", ObjectStore.#encodeRefName(name)), oid);
  }
  async getRef(name: string): Promise<string | null> {
    const p = join(this.root, "refs", ObjectStore.#encodeRefName(name));
    if (!existsSync(p)) return null;
    return (await readFile(p, "utf8")).trim();
  }
  /** All named refs as name → oid (for hub governance distribution). */
  async listRefs(): Promise<Map<string, string>> {
    const dir = join(this.root, "refs");
    if (!existsSync(dir)) return new Map();
    const out = new Map<string, string>();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // Skip anything that is not a plain file: a directory here can only be debris from
      // a repo written before encoding existed, and reading it throws EISDIR.
      if (!entry.isFile()) continue;
      out.set(
        ObjectStore.#decodeRefName(entry.name),
        (await readFile(join(dir, entry.name), "utf8")).trim(),
      );
    }
    return out;
  }
  async setHead(viewName: string): Promise<void> {
    await this.#writeAtomic(join(this.root, "HEAD"), viewName);
  }
  async getHead(): Promise<string> {
    return (await readFile(join(this.root, "HEAD"), "utf8")).trim();
  }

  // ── integrity check (D3 / docs/12) ────────────────────────────────────────
  /**
   * Re-derive every stored object's content address and compare it to the address it
   * lives at — catching bit-rot, truncation, and a torn write that slipped past the
   * atomic-write guarantee. A redacted blob is exempt: its bytes were deliberately
   * overwritten by an admin Redaction and no longer hash to their oid (that's the one
   * sanctioned exception to content-addressing). Also reconciles the op-log against the
   * actual operation set: operation objects missing from the log are real drift (the
   * fast-path could skip them); log entries with no object are GC'd/lost (informational).
   * Read-only unless `rebuild` is set, which rewrites the op-log to match the object set.
   */
  async fsck(opts: { rebuild?: boolean } = {}): Promise<FsckReport> {
    const corrupt: { oid: string; reason: string }[] = [];
    let objectsChecked = 0;
    const verify = (oid: string, raw: Buffer): void => {
      objectsChecked++;
      let obj: AnyObject & { redacted?: boolean };
      try {
        obj = decodeObject<AnyObject & { redacted?: boolean }>(raw, oid);
      } catch (e) {
        corrupt.push({ oid, reason: `undecodable: ${(e as Error).message}` });
        return;
      }
      if (obj.type === "blob" && obj.redacted === true) return; // sanctioned overwrite
      const { oid: _drop, ...payload } = obj as AnyObject & { oid?: string };
      void _drop;
      let recomputed: string;
      try {
        recomputed = computeOid(obj.type, payload as Record<string, unknown>);
      } catch (e) {
        corrupt.push({ oid, reason: `unhashable content: ${(e as Error).message}` });
        return;
      }
      if (recomputed !== oid) corrupt.push({ oid, reason: `content hashes to ${recomputed}` });
    };

    // loose objects
    const objectsDir = join(this.root, "objects");
    if (existsSync(objectsDir)) {
      for (const shard of await readdir(objectsDir)) {
        const shardDir = join(objectsDir, shard);
        if (!(await stat(shardDir)).isDirectory()) continue;
        for (const file of await readdir(shardDir)) {
          if (!file.endsWith(".json")) continue;
          verify(file.slice(0, -".json".length), await readFile(join(shardDir, file)));
        }
      }
    }
    // packed objects (loose copies, if any, already covered above and shadow these)
    const looseChecked = new Set<string>(); // avoid double-count of a re-added loose copy
    for (const [oid, loc] of await this.#packLocations()) {
      if (looseChecked.has(oid) || existsSync(this.#pathFor(oid))) continue;
      verify(oid, await this.#readPackSlice(loc));
    }

    // op-log reconciliation — collect operation oids by ADDRESS (filename / pack index),
    // never by decoding, so a corrupt object (caught above) doesn't crash the log check.
    const logged = new Set(await this.readOpLog());
    const actualOps = new Set<string>();
    if (existsSync(objectsDir)) {
      for (const shard of await readdir(objectsDir)) {
        const shardDir = join(objectsDir, shard);
        if (!(await stat(shardDir)).isDirectory()) continue;
        for (const file of await readdir(shardDir))
          if (file.startsWith("operation_") && file.endsWith(".json")) actualOps.add(file.slice(0, -".json".length));
      }
    }
    for (const oid of (await this.#packLocations()).keys())
      if (oid.startsWith("operation_")) actualOps.add(oid);
    const opsMissingFromLog = [...actualOps].filter((o) => !logged.has(o)).sort();
    const logEntriesMissingObject = [...logged].filter((o) => !actualOps.has(o)).sort();

    let repaired: FsckReport["repaired"];
    if (opts.rebuild && opsMissingFromLog.length) {
      const n = await this.rebuildOpLog();
      repaired = { oplogRebuilt: true, oplogEntries: n };
    }

    return {
      objectsChecked,
      ok: corrupt.length === 0 && opsMissingFromLog.length === 0,
      corrupt,
      oplogDrift: { opsMissingFromLog, logEntriesMissingObject },
      repaired,
    };
  }
}

export interface FsckReport {
  objectsChecked: number;
  /** true iff no corrupt object and no operation missing from the op-log. */
  ok: boolean;
  /** Objects whose content no longer hashes to the address they live at. */
  corrupt: { oid: string; reason: string }[];
  oplogDrift: {
    /** operation objects absent from the op-log — real drift (fast-path could skip them). */
    opsMissingFromLog: string[];
    /** op-log entries with no backing object — GC'd quarantine ops or lost (informational). */
    logEntriesMissingObject: string[];
  };
  /** Present when `fsck({rebuild:true})` repaired op-log drift. */
  repaired?: { oplogRebuilt: boolean; oplogEntries: number };
}
