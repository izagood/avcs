// Regression test for the `avcs mcp` CLI route — AVCS's primary, agent-facing entrypoint.
// The handler surface is covered by mcp-tools.test.ts; here we assert the OTHER half that
// was historically missing from the published artifact: that `avcs mcp` actually boots the
// stdio MCP server and answers the JSON-RPC handshake (initialize + tools/list). We drive
// the real CLI as a child process, exactly as Claude/agents spawn it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Repo } from "../src/api/repo.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Spawn `avcs mcp`, send the JSON-RPC frames, collect the parsed responses, then exit. */
function probe(repoDir: string, frames: object[]): Promise<Record<number, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "mcp"], {
      env: { ...process.env, AVCS_REPO: repoDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const byId: Record<number, any> = {};
    let buf = "";
    const want = frames.length;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timed out waiting for MCP responses")); }, 15_000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") byId[msg.id] = msg;
        } catch { /* ignore non-JSON banner lines */ }
        if (Object.keys(byId).length >= want) {
          clearTimeout(timer);
          child.kill("SIGTERM");
          resolve(byId);
        }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    for (const f of frames) child.stdin.write(JSON.stringify(f) + "\n");
  });
}

test("`avcs mcp` boots the stdio server and serves the tool surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avcs-mcp-cli-"));
  await Repo.init(dir);
  try {
    const res = await probe(dir, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    assert.equal(res[1]?.result?.serverInfo?.name, "avcs", "initialize returns the avcs server");
    const tools: { name: string }[] = res[2]?.result?.tools ?? [];
    assert.ok(tools.length >= 21, `tools/list returns the tool surface (got ${tools.length})`);
    assert.ok(tools.every((t) => t.name.startsWith("avcs.")), "tools are namespaced under avcs.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
