// Actor 에 git 스타일 name/email — 귀속·연락용이지 정체가 아니다.
// id 는 신뢰 검사가 쓰고, name/email 은 operation 콘텐츠에 실려 blame/history 로만 보인다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repo } from "../src/api/repo.ts";

async function freshRepo(): Promise<{ repo: Repo; dir: string; cfg: string }> {
  const dir = await mkdtemp(join(tmpdir(), "avcs-author-"));
  const cfg = await mkdtemp(join(tmpdir(), "avcs-cfg-"));
  const repo = await Repo.init(dir, { configHome: cfg });
  return { repo, dir, cfg };
}

test("localAuthor: config 의 authorName/authorEmail 을 id 와 함께 해석한다", async () => {
  const { repo, dir, cfg } = await freshRepo();
  try {
    await repo.setConfigValue("actorId", "human:jaebin");
    await repo.setConfigValue("authorName", "재빈");
    await repo.setConfigValue("authorEmail", "jaebin@example.com");

    const author = await repo.localAuthor();
    assert.deepEqual(author, { kind: "human", id: "human:jaebin", name: "재빈", email: "jaebin@example.com" });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(cfg, { recursive: true, force: true });
  }
});

test("localAuthor: env 가 config 를 이긴다, 명시가 env 를 이긴다", async () => {
  const { repo, dir, cfg } = await freshRepo();
  const saved = { n: process.env.AVCS_AUTHOR_NAME, e: process.env.AVCS_AUTHOR_EMAIL };
  try {
    await repo.setConfigValue("actorId", "human:jaebin");
    await repo.setConfigValue("authorEmail", "config@example.com");
    process.env.AVCS_AUTHOR_EMAIL = "env@example.com";

    const fromEnv = await repo.localAuthor();
    assert.equal(fromEnv?.email, "env@example.com", "env 가 config 를 이긴다");

    const explicit = await repo.localAuthor({ email: "explicit@example.com" });
    assert.equal(explicit?.email, "explicit@example.com", "명시가 env 를 이긴다");
  } finally {
    if (saved.n === undefined) delete process.env.AVCS_AUTHOR_NAME; else process.env.AVCS_AUTHOR_NAME = saved.n;
    if (saved.e === undefined) delete process.env.AVCS_AUTHOR_EMAIL; else process.env.AVCS_AUTHOR_EMAIL = saved.e;
    await rm(dir, { recursive: true, force: true });
    await rm(cfg, { recursive: true, force: true });
  }
});

test("name/email 은 operation 콘텐츠에 실려 blame 으로 보인다 (귀속)", async () => {
  const { repo, dir, cfg } = await freshRepo();
  try {
    await repo.setConfigValue("actorId", "human:jaebin");
    await repo.setConfigValue("authorName", "재빈");
    await repo.setConfigValue("authorEmail", "jaebin@example.com");
    const author = (await repo.localAuthor())!;

    const intent = await repo.createIntent({ title: "t", owner: author.id });
    const sess = await repo.startSession({ intentOid: intent, actor: author });
    const opOid = await repo.proposeFileWrite({ sessionOid: sess, intentOid: intent, actor: author, path: "a.txt", content: "x\n", declaredPurpose: "seed" });

    // operation 콘텐츠(producedBy)에 저자의 name/email 이 그대로 실린다
    const op = await repo.store.get(opOid) as { actor?: { id: string; name?: string; email?: string } };
    assert.ok(op.actor, "operation 에 actor 가 있어야 한다");
    assert.equal(op.actor.id, "human:jaebin");
    assert.equal(op.actor.name, "재빈");
    assert.equal(op.actor.email, "jaebin@example.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(cfg, { recursive: true, force: true });
  }
});

test("id 만 있는 actor 는 여전히 유효하다 (name/email 은 선택)", async () => {
  const { repo, dir, cfg } = await freshRepo();
  try {
    await repo.setConfigValue("actorId", "human:jaebin");
    const author = await repo.localAuthor();
    assert.deepEqual(author, { kind: "human", id: "human:jaebin" });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(cfg, { recursive: true, force: true });
  }
});
