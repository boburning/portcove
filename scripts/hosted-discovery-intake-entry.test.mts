import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { postgresFixture, postgresServer } from "./fixtures/postgres-cluster.mts";
import { migrate } from "./maintenance-store.mts";

// Spawns the executable runner exactly as the scheduled maintenance workflow
// invokes it. Imported unit tests cannot observe entry-module evaluation: a
// cycle back into the runner deadlocks its top-level await and Node exits 13
// before any receipt is written (#8417).

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts/hosted-discovery-intake-runner.mts");
const receiptFile = path.join(root, "work/hosted-discovery-intake/scheduled-receipts.json");
const server = postgresServer();

/** GET-only #177 fixture with an empty request queue; every other request is refused. */
const githubFixture = `globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = String(init.method ?? input.method ?? "GET").toUpperCase();
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" } });
  if (method === "GET" && url.origin === "https://api.github.com") {
    if (url.pathname === "/repos/boburning/portcove/issues/177")
      return json({ node_id: "I_fixture177", comments: 0, updated_at: "2026-11-23T00:00:00Z" });
    if (url.pathname === "/repos/boburning/portcove/issues/177/comments") return json([]);
  }
  throw new Error("fixture refuses " + method + " " + url.href);
};`;

function runScheduledReceipts(database: string, extra: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "hosted-intake-entry-"));
  try {
    const preload = path.join(directory, "github-fixture.mjs");
    writeFileSync(preload, githubFixture);
    const output = path.join(directory, "github-output");
    writeFileSync(output, "");
    rmSync(receiptFile, { force: true });
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, runner], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...extra,
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_REPOSITORY: "boburning/portcove",
        GITHUB_REF: "refs/heads/main",
        GITHUB_WORKFLOW_REF:
          "boburning/portcove/.github/workflows/maintenance-inventory.yml@refs/heads/main",
        GITHUB_RUN_ID: "8417",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "0".repeat(40),
        GITHUB_OUTPUT: output,
        REPOSITORY_TOKEN: "fixture-token",
        PORTCOVE_DISCOVERY_DATABASE_URL: database,
        PORTCOVE_MAINTENANCE_PURPOSE: "schedule",
        HOSTED_INTAKE_MODE: "scheduled-receipts",
      },
    });
    assert.ifError(result.error);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/u);
    assert.notEqual(result.status, 13, result.stderr);
    return {
      status: result.status,
      stderr: result.stderr,
      output: readFileSync(output, "utf8"),
      receipt: JSON.parse(readFileSync(receiptFile, "utf8")) as Record<string, unknown>,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

void test("scheduled receipt CLI reaches a terminal receipt when its store is unreachable", () => {
  // Port 1 refuses immediately: the run reads the fixture queue, then fails
  // closed at the store with a bounded receipt instead of hanging.
  const run = runScheduledReceipts("postgresql://fixture@127.0.0.1:1/unavailable");
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.output, "audit_continuations=[]\nreceipt_revision=\n");
  assert.deepEqual(run.receipt, {
    status: "failed",
    phase: "read-plans",
    reason: "store-error",
    eligible_audits: 0,
  });
});

void test(
  "scheduled receipt CLI admits and records a passed receipt against a migrated store",
  { skip: server.skip ?? false, timeout: 120_000 },
  (context) => {
    const fixture = postgresFixture(context, server.directory!);
    const { owner } = fixture.start("entry");
    migrate(owner);
    const database = new URL(`postgresql://owner@localhost:${owner.PGPORT}/postgres`);
    database.searchParams.set("host", owner.PGHOST!);
    const run = runScheduledReceipts(database.href, {
      PORTCOVE_POSTGRES_BIN: owner.PORTCOVE_POSTGRES_BIN,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.output, /^audit_continuations=\[\]\nreceipt_revision=[^\n]+\n$/u);
    assert.deepEqual(run.receipt, {
      status: "passed",
      inspected: 0,
      completed: [],
      pending: 0,
      eligible_audits: 0,
    });
  },
);
