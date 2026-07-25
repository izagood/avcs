// Phase 16 M4.1 (docs/18 §4.1) — MCP resources.
//
// Tools are the parameterized main path. Resources exist for one thing tools cannot do:
// be SUBSCRIBED to. A client that subscribes to `avcs://view/main/head` is told when the
// head moves instead of asking every few seconds.
//
// Every read goes through the same repo calls the equivalent tool uses, so a resource can
// never disagree with the tool that backs it — one source of truth, two doors to it.

import { buildGuide } from "./guide.ts";
import { buildContextPack } from "./context.ts";
import { keysOf } from "../reducer/reducer.ts";
import type { Repo } from "../api/repo.ts";
import type { Operation } from "../objects/types.ts";
import type { ToolDef } from "./server.ts";

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Advertised resources. `{view}` is a template segment filled by the client. */
export const RESOURCES: ResourceDef[] = [
  {
    uri: "avcs://view/{view}/head",
    name: "view head",
    description: "The protected head of a view and the tree it resolves to. Subscribe to learn when it advances.",
    mimeType: "application/json",
  },
  {
    uri: "avcs://view/{view}/conflicts",
    name: "open conflicts",
    description: "Conflicts awaiting a human decision on a view. Subscribe to learn when one opens.",
    mimeType: "application/json",
  },
  {
    uri: "avcs://view/{view}/context",
    name: "view context",
    description: "A default ContextPack scoped to the keys currently in play on the view.",
    mimeType: "application/json",
  },
  {
    uri: "avcs://guide",
    name: "guide",
    description: "The canonical loop, agent rules, tool index and error recovery.",
    mimeType: "application/json",
  },
];

/**
 * Read one resource. Returns the serialized body; throws on an unknown URI rather than
 * returning an empty document — a client that asked for something that does not exist has
 * a bug, and an empty body would read as "nothing here", which is a different fact.
 */
export async function readResource(repo: Repo, uri: string, tools: ToolDef[] = []): Promise<string> {
  if (uri === "avcs://guide") return JSON.stringify(buildGuide(tools));

  const m = /^avcs:\/\/view\/([^/]+)\/(head|conflicts|context)$/.exec(uri);
  if (!m) throw new Error(`unknown resource uri: ${uri}`);
  const view = decodeURIComponent(m[1]!);

  switch (m[2]) {
    case "head": {
      const [head, res] = await Promise.all([repo.protectedHead(view), repo.materialize(view)]);
      return JSON.stringify({ view, head, treeHash: res.treeHash });
    }
    case "conflicts": {
      const res = await repo.materialize(view);
      return JSON.stringify(res.conflicts);
    }
    default: {
      // context.build refuses an unscoped call by design, so a VIEW-level pack has to name
      // its own scope: the keys actually in play — anything contended, plus what the most
      // recent operations touched. That is the set an agent arriving at this view needs.
      const res = await repo.materialize(view);
      const keys = new Set<string>(res.conflicts.map((c) => c.key));
      const ops = await repo.store.collect<Operation>("operation");
      const recent = ops
        .filter((o) => (o.line ?? "main") === view)
        .sort((a, b) => a.lamport - b.lamport || String(a.oid).localeCompare(String(b.oid)))
        .slice(-20);
      for (const op of recent) for (const k of keysOf(op)) keys.add(k);
      if (!keys.size) return JSON.stringify({ v: 1, view, treeHash: res.treeHash, budget: { maxBytes: 8192, usedBytes: 0, truncated: [] }, symbols: [], decisions: [], policies: [], risks: [], evidence: [], history: [], suggestedOps: [] });
      return JSON.stringify(await buildContextPack(repo, { entityKeys: [...keys], view, maxBytes: 8192 }));
    }
  }
}
