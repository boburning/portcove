import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isRecord } from "./runtime-values.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
  exportCoordinatorCheckpoint,
  importCoordinatorCheckpoint,
} from "./release-coordinator-state.mts";
import { recoverRemoteCoordinator } from "./release-coordinator-recovery.mts";
import { CoordinatorRemoteError } from "./release-coordinator-remote.mts";
import childProcess from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { requestTrustedSemanticReview } from "./release-coordinator-driver.mts";
import { fileURLToPath } from "node:url";

import { recoveryFixture, gitObject } from "./fixtures/coordinator-state-fixtures.mts";

for (const scenario of ["seeded", "changed", "unseeded", "pending-context"] as const)
  void test(
    `trusted coordinator ${scenario === "changed" ? "refuses changed remote recovery before reading main" : scenario === "seeded" ? "recovers active candidate then requires actual resumption authority before reading main" : scenario === "pending-context" ? "routes unresolved context to GET-only recovery before bootstrap preparation" : "holds an unseeded active candidate at bootstrap before resumption or main"}`,
    { timeout: 60000 },
    async (t) => {
      // Real Git recovery through the production default transport, with the gh
      // subprocess provider simulated. No OIDC, credential or protected POST.
      const changed = scenario === "changed";
      const f = await recoveryFixture(
        t,
        false,
        ["seeded", "changed"].includes(scenario),
        scenario === "pending-context",
      );
      if (changed) f.faults.value = "changed";
      const projectRoot = fileURLToPath(new URL("..", import.meta.url));
      const parent = await mkdtemp(path.join(projectRoot, "work", "coordinator-fixture-"));
      t.after(() => rm(parent, { recursive: true, force: true }));
      const initialRefs = structuredClone(f.refs);
      const jobEnvironment = {
        GITHUB_RUN_ID: "12345",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: f.input.opportunity.source_commit,
      };
      const previousJobEnvironment = Object.fromEntries(
        Object.keys(jobEnvironment).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, jobEnvironment);
      t.after(() => {
        for (const [key, value] of Object.entries(previousJobEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });
      const previousAuthorities = process.env.PORTCOVE_RELEASE_AUTHORITIES;
      delete process.env.PORTCOVE_RELEASE_AUTHORITIES;
      t.after(() => {
        if (previousAuthorities === undefined) delete process.env.PORTCOVE_RELEASE_AUTHORITIES;
        else process.env.PORTCOVE_RELEASE_AUTHORITIES = previousAuthorities;
      });
      const original = childProcess.spawnSync;
      let mainReads = 0;
      let jobReads = 0;
      const mock = t.mock.method(
        childProcess,
        "spawnSync",
        (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
          if (command !== "gh") return original(command, args, options);
          if (
            args.includes(
              "repos/boburning/portcove/actions/runs/12345/jobs?filter=all&per_page=100&page=1",
            )
          ) {
            jobReads++;
            assert.equal(args[args.indexOf("--method") + 1], "GET");
            assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
            assert.equal(f.reads(), 0, "original job budget precedes recovery reads");
            return {
              status: 0,
              stdout: `HTTP/2.0 200 Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ total_count: 1, jobs: [{ id: 901, name: "Coordinate application release", run_id: 12345, run_attempt: 1, head_sha: jobEnvironment.GITHUB_SHA, status: "in_progress", started_at: new Date().toISOString() }] })}`,
              stderr: "",
            };
          }
          if (args.includes("repos/boburning/portcove/git/ref/heads/main")) {
            mainReads++;
            assert.ok(f.reads() >= 16, "complete recovery must precede live source selection");
            assert.equal(args[args.indexOf("--method") + 1], "GET");
            return {
              status: 0,
              stdout: `HTTP/2.0 200 Fixture\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ ref: "refs/heads/main", object: { type: "commit", sha: f.input.opportunity.source_commit } })}`,
              stderr: "",
            };
          }
          return f.transport.spawn(command, args, options);
        },
      );
      syncBuiltinESMExports();
      t.after(() => {
        mock.mock.restore();
        syncBuiltinESMExports();
      });
      const run = requestTrustedSemanticReview(parent, {
        remote_configuration: { schema_version: 1, namespace: "portcove-fixture" },
      });
      if (changed) {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof CoordinatorRemoteError);
          assert.ok(isRecord(error.evidence));
          assert.equal(error.evidence.phase, "remote-recovery");
          return true;
        });
        assert.equal(mainReads, 0);
      } else if (scenario === "seeded") {
        await assert.rejects(run, (error: unknown) => {
          assert.ok(error instanceof CoordinatorRemoteError);
          assert.ok(isRecord(error.evidence));
          assert.equal(error.evidence.phase, "actual-active-resumption-authority");
          assert.equal(error.evidence.checkpoint, f.saved.checkpoint);
          return true;
        });
        assert.equal(mainReads, 0);
      } else {
        const held = await run;
        assert.equal(
          held.decision,
          scenario === "pending-context" ? "held-context-readback-tools" : "held-bootstrap-tools",
        );
        assert.equal(held.checkpoint, f.saved.checkpoint);
        assert.equal(held.authority, "none");
        assert.equal(mainReads, 0);
      }
      assert.deepEqual(f.refs, initialRefs);
      assert.equal(jobReads, 1);
      assert.equal(
        mock.mock.calls.filter(
          (call) => call.arguments[0] === "gh" && call.arguments[1]?.includes("POST"),
        ).length,
        0,
      );
    },
  );

void test("bounded API recovery restores exact checkpoint and receipts without application files or history", async (t) => {
  for (const signed of [false, true]) {
    const f = await recoveryFixture(t, signed);
    const result = await recoverRemoteCoordinator(
      f.parent,
      { schema_version: 1, namespace: "portcove-fixture" },
      { transport: f.transport },
    );
    assert.equal(result.checkpoint, f.saved.checkpoint);
    assert.deepEqual(result.input, f.input);
    assert.equal(result.readiness, "recovery-only");
    assert.equal(result.complete_allocation_history, false);
    assert.equal(result.application_checkout_available, false);
    assert.equal(result.requests, 16);
    assert.equal(f.reads(), 16);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", result.repository, ...args], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    assert.equal(git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
    for (const ref of f.prepared.allocation_refs)
      assert.equal(git("rev-parse", ref), f.prepared.prepared_commit);
    assert.throws(() => git("cat-file", "-e", f.input.opportunity.source_tree));
    assert.throws(() => git("cat-file", "-e", `${f.input.opportunity.source_commit}:Cargo.toml`));
    const exported = await exportCoordinatorCheckpoint(result.repository, result.checkpoint);
    assert.equal(exported.required_commits.length, 2);
    assert.deepEqual(
      (await recoverReleaseOpportunity(result.repository, result.checkpoint)).input,
      f.input,
    );
  }
});

void test("sparse recovery uses raw parent headers when older checkpoint history is absent", async (t) => {
  const f = await recoveryFixture(t);
  const next = structuredClone(f.input);
  next.active_candidate!.phase = "qualifying";
  const saved = await checkpointReleaseOpportunity(f.repository, f.saved.checkpoint, next);
  f.refs.set("refs/heads/portcove-fixture-coordinator-state", saved.checkpoint);
  const result = await recoverRemoteCoordinator(
    f.parent,
    { schema_version: 1, namespace: "portcove-fixture" },
    { transport: f.transport },
  );
  assert.equal(result.previous, f.saved.checkpoint);
  assert.ok(isRecord(result.input.active_candidate));
  assert.equal(result.input.active_candidate.phase, "qualifying");
  assert.throws(() =>
    execFileSync("git", ["-C", result.repository, "cat-file", "-e", f.initial.checkpoint], {
      windowsHide: true,
      stdio: "pipe",
    }),
  );
  await writeFile(path.join(result.repository, "shallow"), `${f.prepared.prepared_commit}\n`);
  assert.equal(
    (await exportCoordinatorCheckpoint(result.repository, result.checkpoint)).required_commits[1]!
      .parent,
    f.input.opportunity.source_commit,
  );
});

void test("recovery refuses unavailable transport, changed snapshots and malformed objects before creating a repository", async (t) => {
  const f = await recoveryFixture(t);
  const config = { schema_version: 1, namespace: "portcove-fixture" };
  await assert.rejects(recoverRemoteCoordinator(f.parent, config), /unconfigured/u);
  assert.equal(f.reads(), 0);
  await assert.rejects(
    recoverRemoteCoordinator(
      f.parent,
      { ...config, namespace: "main" },
      { transport: f.transport },
    ),
    /configuration/u,
  );
  assert.equal(f.reads(), 0);
  for (const fault of ["message", "truncated", "size", "changed", "repository", "overflow"]) {
    f.faults.value = fault;
    await assert.rejects(recoverRemoteCoordinator(f.parent, config, { transport: f.transport }));
    assert.deepEqual(await readdir(f.parent), []);
  }
});

void test("shared journal refusal retains an identified partial repository with no installed refs", async (t) => {
  const f = await recoveryFixture(t);
  const run = (args: string[], input?: string) =>
    execFileSync("git", ["-C", f.repository, ...args], {
      input,
      encoding: "utf8",
      windowsHide: true,
    });
  const raw = run(["cat-file", "commit", f.saved.checkpoint]);
  const state = JSON.parse(run(["cat-file", "blob", `${f.saved.checkpoint}:state.json`])) as Record<
    string,
    unknown
  >;
  state.schema_version = 2;
  const blob = run(["hash-object", "-w", "--stdin"], JSON.stringify(state)).trim();
  const tree = run(["mktree"], `100644 blob ${blob}\tstate.json\n`).trim();
  const invalid = run(
    ["hash-object", "-w", "-t", "commit", "--stdin"],
    raw.replace(/^tree [a-f0-9]{40}/u, `tree ${tree}`),
  ).trim();
  f.refs.set("refs/heads/portcove-fixture-coordinator-state", invalid);
  await assert.rejects(
    recoverRemoteCoordinator(
      f.parent,
      { schema_version: 1, namespace: "portcove-fixture" },
      { transport: f.transport },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CoordinatorRemoteError);
      assert.ok(isRecord(error.evidence));
      assert.equal(error.evidence.phase, "validate-and-import");
      assert.equal(error.evidence.checkpoint, invalid);
      assert.equal(typeof error.evidence.repository, "string");
      const restored = error.evidence.repository as string;
      assert.equal(path.dirname(restored), f.parent);
      assert.equal(
        execFileSync("git", ["-C", restored, "for-each-ref"], {
          encoding: "utf8",
          windowsHide: true,
        }),
        "",
      );
      return true;
    },
  );
  assert.equal((await readdir(f.parent)).length, 1);
});

void test("inert import refuses forged bytes and leaves existing refs intact", async (t) => {
  const f = await recoveryFixture(t);
  const bytes = Buffer.from("independently expected bytes");
  const object = { kind: "blob" as const, oid: gitObject("blob", bytes), bytes };
  await assert.rejects(
    importCoordinatorCheckpoint(f.repository, f.saved.checkpoint, [object, object, object]),
    /duplicate/u,
  );
  await assert.rejects(
    importCoordinatorCheckpoint(f.repository, f.saved.checkpoint, [
      object,
      { ...object, bytes: Buffer.from("changed") },
      object,
    ]),
    /identity/u,
  );
  assert.equal(f.git("rev-parse", coordinatorStateRef), f.saved.checkpoint);
});
