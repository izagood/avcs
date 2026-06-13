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
import { canonicalize, computeOid, sha256hex } from "../core/canonical.ts";
import { withLock, type LockOptions } from "./lock.ts";
import type { AnyObject, ObjectType } from "../objects/types.ts";

export class ObjectStore {
  readonly root: string; // the .avcs directory
  #wc = 0; // temp-file counter for atomic writes
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
   */
  async #writeAtomic(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${++this.#wc}`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(data, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path); // atomic on the same filesystem
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
    await appendFile(p, `${oid}\n`, "utf8");
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
      await this.#writeAtomic(p, canonicalize({ ...payload, oid }));
    }
    return oid;
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
    await this.#writeAtomic(p, canonicalize({ ...payload, oid }));
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
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw) as T;
  }

  async has(oid: string): Promise<boolean> {
    return existsSync(this.#pathFor(oid));
  }

  /** Stream every object of a given type. */
  async *list<T extends AnyObject = AnyObject>(type?: ObjectType): AsyncGenerator<T> {
    const objectsDir = join(this.root, "objects");
    if (!existsSync(objectsDir)) return;
    const shards = await readdir(objectsDir);
    for (const shard of shards) {
      const shardDir = join(objectsDir, shard);
      if (!(await stat(shardDir)).isDirectory()) continue;
      for (const file of await readdir(shardDir)) {
        if (!file.endsWith(".json")) continue;
        if (type && !file.startsWith(`${type}_`)) continue;
        const obj = JSON.parse(await readFile(join(shardDir, file), "utf8")) as T;
        yield obj;
      }
    }
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
}
