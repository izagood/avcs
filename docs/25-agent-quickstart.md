# 25 — Agent quickstart: driving AVCS from Claude Code (MCP)

This is the walkthrough for the *other* first user of AVCS: not the human at the CLI
(that's the [first five minutes](../README.md#your-first-five-minutes-no-server-no-git-required)),
but an AI agent connected over MCP. Everything below was executed against a real repo;
oids are shortened for readability.

## Setup (once)

```bash
npm install -g @izagood/avcs
avcs mcp install          # = `claude mcp add avcs -- avcs mcp` (scope: user)
```

Then, in the project the agent will work on:

```bash
avcs init .
avcs import . -m "initial import"
```

Any MCP client works — point it at the `avcs mcp` stdio command; the target repo is
`$AVCS_REPO`, else the client's cwd. `--profile core` advertises the 13 loop tools
instead of all 36.

## The canonical loop

The agent's first call is always `avcs.guide` — it returns this loop plus the rules,
so an agent that has never seen AVCS can bootstrap from one tool call:

| # | tool | why |
|---|------|-----|
| 1 | `avcs.intent.read` | learn the declared goal and the scopes you may touch |
| 2 | `avcs.session.start` | bind your work to that intent under your actor identity |
| 3 | `avcs.context.build` | provenance, prior decisions and live risks in one bounded call |
| 4 | `avcs.lease.request` | claim the scopes you are about to write |
| 5 | `avcs.operation.propose` | submit the change as an operation — never write final files yourself |
| 6 | `avcs.validate.run` | produce evidence; a behavior change is not acceptable without it |
| 7 | `avcs.evidence.attach` | bind that evidence to the ops it justifies |
| 8 | `avcs.view.materialize` | check the work actually merges; read any open conflicts |
| 9 | `avcs.sync.land` | push + checkpoint + integrate in one call → `landed` or a conflict to decide |

A human (or an orchestrating agent) opens the intent the loop runs against with
`avcs.intent.create` — goal, constraints, allowed scopes.

## A worked pass

The task: fix an off-by-one in `src/pager.ts` of a TypeScript project. What the agent
actually calls, in order:

```jsonc
// 1–2. open work against the intent
avcs.intent.create  { title: "pager: last page drops one row", owner: "human:dev",
                      kind: "bugfix", allowedScopes: ["file:src/pager.ts"] }
→ "intent_a41f…"
avcs.session.start  { intentOid: "intent_a41f…",
                      actor: { id: "ai_agent:claude", kind: "ai_agent" } }
→ "session_09be…"

// 3–4. look before writing
avcs.context.build  { intentOid: "intent_a41f…" }
→ { scopes: ["file:src/pager.ts"], priorDecisions: [], liveRisks: [] }
avcs.contention.check { keys: ["file:src/pager.ts"], sessionOid: "session_09be…" }
→ []                                    // nobody else is in this file

// 5. the change is an operation, not a file write
avcs.operation.propose {
  sessionOid: "session_09be…", intentOid: "intent_a41f…",
  actor: { id: "ai_agent:claude", kind: "ai_agent" },
  path: "src/pager.ts", content: "<full new file text>",
  declaredPurpose: "clamp page end to row count (off-by-one)",
  effects: { changesBehavior: true, breaksPublicApi: false }   // honest — this gates
}
→ "operation_77c2…"

// 6. behaviour changed ⇒ evidence or the reducer blocks it at L3
avcs.validate.run {
  ops: ["operation_77c2…"],
  ciActor: { id: "ci_bot:runner", kind: "ci_bot" },
  checks: [{ kind: "test", command: "npm test" }]
}
→ ["evidence_5d10…"]                    // bound to the op's treeHash

// 8–9. merge-check, then land
avcs.view.materialize { view: "main" }
→ { conflicts: [], treeHash: "9f3a…" }
avcs.sync.land { by: "ai_agent:claude" }
→ { outcome: "landed", checkpoint: "checkpoint_c8e4…" }
```

Two details that differ from every git workflow:

- **Effects are declared, and the declaration is load-bearing.** `changesBehavior: true`
  with no trusted evidence grades the operation **L3 — blocked**. The agent's own
  validation run counts because the *ci actor* signs it, not the operation's author —
  an author vouching for their own change does not.
- **`sync.land` never says "pull first."** A stale head is absorbed on the hub side;
  the outcome is `landed` or a conflict packet a human decides. There is no
  rebase-and-retry loop to burn agent turns on.

## What the human sees afterwards

```bash
avcs log                      # [00N] ai_agent:claude  edit_file file:src/pager.ts — clamp page end…
avcs blame file:src/pager.ts  # who owns it, the why, the intent behind it
avcs conflicts                # decisions a human still owes (empty on this pass)
```

The review surface is not a text diff: it is intent → operations → evidence → decision,
each a signed object in the history.

## Solo vs team

`sync.land` pushes to a hub. Working alone, without a remote, stop after step 8 —
operations are already in the base view, and the human re-projects the tree with
`avcs checkout`. When a hub appears later (`avcs serve` on any machine, then
`avcs remote add origin <url>`), the same loop gains steps 9's push/integrate with no
change to the agent's code.

## Rules the server itself tells agents

`avcs.guide` returns these with the loop; they are the contract, not etiquette:

1. Never write final files directly — submit `avcs.operation.propose`.
2. Declare effects (`changesBehavior` / `breaksPublicApi`) honestly.
3. A behavior change cannot be accepted without passing-test evidence.
4. On a conflict, produce options for a human; do not silently overwrite.
5. Stay inside the intent's allowed scopes; widen the intent instead of exceeding it.
6. Read a failure's `nextActions` and follow them; do not improvise recovery from the message text.

## Run the same story yourself

[`izagood/avcs-demo`](https://github.com/izagood/avcs-demo) is the runnable counterpart to
this document: `./demo.sh` plays two humans through the identical scenario — a stale-head
land that is absorbed, a disjoint auto-merge, and a same-line collision resolved by a signed
decision — and its `agent-session.md` shows what that collision looks like from the agent's
side of the loop, including why rule 4 above means the agent stops and hands it to a human.
