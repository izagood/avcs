// Performance benchmark (docs/10 WS-A): measure materialize cost at scale and find
// the hotspot before optimizing. Run: npm run bench
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

const ai = { kind: "ai_agent" as const, id: "ai:a" };
const ms = (n: number) => `${n.toFixed(1)}ms`;

async function build(n: number, dir: string): Promise<Repo> {
  const repo = await Repo.init(dir);
  const intent = await repo.createIntent({ title: "bench", owner: "human:h" });
  const sess = await repo.startSession({ intentOid: intent, actor: ai });
  const files = Math.ceil(n / 3);
  let made = 0;
  for (let f = 0; f < files && made < n; f++) {
    const path = `src/mod${f}.ts`;
    const base = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path, content: `export function g${f}() {\n  return "v0";\n}\n`, declaredPurpose: "scaffold" });
    made++;
    let prev = base;
    for (let e = 0; e < 2 && made < n; e++) {
      prev = await repo.proposeSymbolEdit({ sessionOid: sess, intentOid: intent, actor: ai, path, symbolName: `g${f}`, newText: `export function g${f}() {\n  return "v${e + 1}";\n}`, declaredPurpose: "edit", causalDeps: [prev] });
      made++;
    }
  }
  return repo;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

async function main() {
  for (const N of [500, 1500, 3000]) {
    const dir = await mkdtemp(join(tmpdir(), "avcs-bench-"));
    const [, buildMs] = await timed(() => build(N, dir));
    // cold: a fresh Repo instance has an empty reduce cache
    const cold = await Repo.open(dir);
    const [r1, coldMs] = await timed(() => cold.materialize());
    const [, warmMs] = await timed(() => cold.materialize()); // cache hit
    // incremental: add one op, materialize (cache miss → full re-reduce)
    const intent = (await cold.listIntents())[0]!.oid as string;
    const sess = await cold.startSession({ intentOid: intent, actor: ai });
    await cold.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: ai, path: "new.ts", content: "export const x=1\n", declaredPurpose: "new" });
    const [, incMs] = await timed(() => cold.materialize());
    console.log(`N=${String(N).padStart(4)} files=${r1.tree.size}  build=${ms(buildMs)}  cold=${ms(coldMs)}  warm=${ms(warmMs)}  +1op=${ms(incMs)}`);
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
