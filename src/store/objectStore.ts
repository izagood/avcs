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
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Buffer } from "node:buffer";
import { computeOid, sha256hex } from "../core/canonical.ts";
import { encodeCbor, decodeCbor, looksLikeCbor } from "../core/cbor.ts";
import { withLock, type LockOptions } from "./lock.ts";
import type { AnyObject, ObjectType } from "../objects/types.ts";

/** Deserialize a stored object: CBOR (new format) or legacy canonical-JSON, sniffed by
 *  the first byte. oids are JSON-derived so both formats address identically (B1). */
function decodeObject<T>(raw: Buffer): T {
  return (looksLikeCbor(raw) ? decodeCbor(raw) : JSON.parse(raw.toString("utf8"))) as T;
}

interface PackLoc { file: string; offset: number; length: number; }

/** Opt-out of fsync for throughput-bound bulk loads (D1). Durability traded for speed. */
const NO_FSYNC = process.env.AVCS_NO_FSYNC === "1";

export class ObjectStore {
  readonly root: string; // the .avcs directory
  #wc = 0; // temp-file counter for atomic writes
  #packLoc: Map<string, PackLoc> | null = null; // lazy oid → pack location index (B2)
  constructor(repoDir: string) {
    this.root = join(repoDir, ".avcs");
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

  static isRepo(repoDir: string): boolean {
    return existsSync(join(repoDir, ".avcs", "objects"));
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
    const oid = computeOid(obj.type, payload as Record<string, unknown>);
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
    if (!existsSync(p)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of (await readFile(p, "utf8")).split("\n"))
      if (line && !seen.has(line)) { seen.add(line); out.push(line); }
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
    if (!existsSync(p)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of (await readFile(p, "utf8")).split("\n"))
      if (line && !seen.has(line)) { seen.add(line); out.push(line); }
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
    const p = this.#pathFor(oid);
    if (existsSync(p)) return decodeObject<T>(await readFile(p)); // loose shadows packs
    const loc = (await this.#packLocations()).get(oid);
    if (loc) return decodeObject<T>(await this.#readPackSlice(loc));
    return decodeObject<T>(await readFile(p)); // absent → throws ENOENT (prior behavior)
  }

  async has(oid: string): Promise<boolean> {
    return existsSync(this.#pathFor(oid)) || (await this.#packLocations()).has(oid);
  }

  /** Stream every object of a given type — loose objects first, then packed ones (B2). */
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
          yield decodeObject<T>(await readFile(join(shardDir, file)));
        }
      }
    }
    for (const [oid, loc] of await this.#packLocations()) {
      if (seen.has(oid)) continue; // a re-added loose copy already yielded
      if (type && !oid.startsWith(`${type}_`)) continue;
      yield decodeObject<T>(await this.#readPackSlice(loc));
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

  async collect<T extends AnyObject = AnyObject>(type?: ObjectType): Promise<T[]> {
    const out: T[] = [];
    for await (const o of this.list<T>(type)) out.push(o);
    return out;
  }

  // ── refs ────────────────────────────────────────────────────────────────
  async setRef(name: string, oid: string): Promise<void> {
    await this.#writeAtomic(join(this.root, "refs", name), oid);
  }
  async getRef(name: string): Promise<string | null> {
    const p = join(this.root, "refs", name);
    if (!existsSync(p)) return null;
    return (await readFile(p, "utf8")).trim();
  }
  /** All named refs as name → oid (for hub governance distribution). */
  async listRefs(): Promise<Map<string, string>> {
    const dir = join(this.root, "refs");
    if (!existsSync(dir)) return new Map();
    const out = new Map<string, string>();
    for (const name of await readdir(dir)) {
      out.set(name, (await readFile(join(dir, name), "utf8")).trim());
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
        obj = decodeObject<AnyObject & { redacted?: boolean }>(raw);
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
