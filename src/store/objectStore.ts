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

import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { canonicalize, computeOid } from "../core/canonical.ts";
import type { AnyObject, ObjectType } from "../objects/types.ts";

export class ObjectStore {
  readonly root: string; // the .avcs directory
  constructor(repoDir: string) {
    this.root = join(repoDir, ".avcs");
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, "objects"), { recursive: true });
    await mkdir(join(this.root, "refs"), { recursive: true });
    if (!existsSync(join(this.root, "HEAD"))) {
      await writeFile(join(this.root, "HEAD"), "main", "utf8");
    }
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
      await writeFile(p, canonicalize({ ...payload, oid }), "utf8");
    }
    return oid;
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
    await writeFile(join(this.root, "refs", name), oid, "utf8");
  }
  async getRef(name: string): Promise<string | null> {
    const p = join(this.root, "refs", name);
    if (!existsSync(p)) return null;
    return (await readFile(p, "utf8")).trim();
  }
  async setHead(viewName: string): Promise<void> {
    await writeFile(join(this.root, "HEAD"), viewName, "utf8");
  }
  async getHead(): Promise<string> {
    return (await readFile(join(this.root, "HEAD"), "utf8")).trim();
  }
}
