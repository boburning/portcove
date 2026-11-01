import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  prepareMergeSnapshot,
  verifyMergeSnapshotReadback,
  readDeliverySnapshot,
} from "./pr-delivery-snapshot.mts";
import type { MergeSnapshotExpectation } from "./pr-delivery-snapshot.mts";

const repository = "boburning/portcove";
const head = "a".repeat(40),
  target = "b".repeat(40),
  tree = "c".repeat(40);
const preview = "d".repeat(40),
  merged = "e".repeat(40),
  oldBase = "f".repeat(40);
const contexts = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];
const now = Date.parse("2026-10-22T20:00:00Z");
const message = { title: "fix(repo): improve delivery", body: "Closes #123." };
const intent = { format_version: 1, allowed_targets: [repository + "#123"] };
const expected = {
  number: 7,
  head,
  target,
  tree,
  contexts,
  run: 42,
  attempt: 1,
  closureIntent: intent,
  mergeMessage: message,
  now: () => now,
};

function fixture(clock = now) {
  const pull = {
    number: 7,
    title: message.title,
    body: "Closes #123.",
    commits: 1,
    head: { sha: head },
    base: { sha: oldBase, ref: "main", repo: { full_name: repository } },
    state: "open",
    draft: false,
    merged: false,
    mergeable: true as boolean | null,
    merge_commit_sha: preview as string | null,
  };
  const branch = { name: "main", commit: { sha: target } };
  const run = {
    id: 42,
    run_attempt: 1,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
  };
  const closing = {
    number: 7,
    head,
    title: pull.title,
    body: pull.body,
    complete: true,
    method: "direct-ui-with-bracketing-rest",
    total_count: 1,
    relationships: [repository + "#123"],
  };
  return {
    format_version: 1,
    phase: "prepare-merge",
    repository,
    collection: {
      started_at: new Date(clock - 1000).toISOString(),
      completed_at: new Date(clock - 100).toISOString(),
    },
    pull_before: structuredClone(pull),
    pull_after: structuredClone(pull),
    target_before: structuredClone(branch),
    target_after: structuredClone(branch),
    run_before: structuredClone(run),
    run_after: structuredClone(run),
    preview: { sha: preview, parents: [{ sha: target }, { sha: head }], tree: { sha: tree } },
    checks: {
      total_count: contexts.length,
      check_runs: contexts.map((name, index) => ({
        id: index + 1,
        name,
        head_sha: head,
        status: "completed",
        conclusion: "success" as string | null,
      })),
    },
    statuses: {
      sha: head,
      total_count: 0,
      statuses: [] as { id: number; context: string; state: string }[],
    },
    jobs: {
      total_count: contexts.length,
      jobs: contexts.map((name, index) => ({
        id: 100 + index,
        name,
        run_id: 42,
        run_attempt: 1,
        head_sha: head,
        status: "completed",
        conclusion: "success",
        check_run_url: `https://api.github.com/repos/${repository}/check-runs/${index + 1}`,
      })),
    },
    commits: [{ sha: head, commit: { message: message.title } }],
    closing_before: {
      ...structuredClone(closing),
      observed_at: new Date(clock - 900).toISOString(),
    },
    closing_after: {
      ...structuredClone(closing),
      observed_at: new Date(clock - 200).toISOString(),
    },
  };
}

function readback(clock = now) {
  const original = fixture(clock);
  const prepared = prepareMergeSnapshot(original, { ...expected, now: () => clock });
  const pull = { ...original.pull_before, state: "closed", merged: true, merge_commit_sha: merged };
  const branch = { name: "main", commit: { sha: merged } };
  return {
    ...original,
    phase: "merge-readback",
    prepared,
    pull_before: structuredClone(pull),
    pull_after: structuredClone(pull),
    target_before: structuredClone(branch),
    target_after: structuredClone(branch),
    actual_commit: {
      sha: merged,
      parents: [{ sha: target }],
      tree: { sha: tree },
      message: `${message.title}\n\n${message.body}`,
    },
  };
}

function localGitFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-delivery-git-"));
  const git = (args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Delivery fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const save = (name: string, body: string) => {
    writeFileSync(path.join(directory, name), body);
    git(["add", name]);
    git(["commit", "-m", name]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "-b", "main"]);
  save("shared.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
  const base = save(".gitattributes", "*.txt merge=fixture-driver\n");
  git(["checkout", "-b", "candidate"]);
  const source = save("shared.txt", "source\ntwo\nthree\nfour\nfive\nsix\n");
  git(["checkout", "main"]);
  const previousTarget = save("before.txt", "earlier target\n");
  const previewTree = git(["merge-tree", "--write-tree", previousTarget, source]);
  const preview = git([
    "commit-tree",
    previewTree,
    "-p",
    previousTarget,
    "-p",
    source,
    "-m",
    "Historical preview",
  ]);
  const currentTarget = save("shared.txt", "one\ntwo\nthree\nfour\nfive\ntarget\n");
  const currentTree = git(["merge-tree", "--write-tree", currentTarget, source]);
  git(["checkout", "candidate"]);
  const snapshot = fixture(Date.now());
  for (const pull of [snapshot.pull_before, snapshot.pull_after]) {
    pull.head.sha = source;
    pull.base.sha = previousTarget;
    pull.merge_commit_sha = preview;
  }
  for (const branch of [snapshot.target_before, snapshot.target_after])
    branch.commit.sha = currentTarget;
  for (const run of [snapshot.run_before, snapshot.run_after]) run.head_sha = source;
  for (const closing of [snapshot.closing_before, snapshot.closing_after]) closing.head = source;
  for (const check of snapshot.checks.check_runs) check.head_sha = source;
  for (const job of snapshot.jobs.jobs) job.head_sha = source;
  snapshot.statuses.sha = source;
  snapshot.commits[0]!.sha = source;
  snapshot.preview = {
    sha: preview,
    parents: [{ sha: previousTarget }, { sha: source }],
    tree: { sha: previewTree },
  };
  return {
    directory,
    git,
    save,
    base,
    snapshot,
    expected: {
      ...expected,
      head: source,
      target: currentTarget,
      tree: currentTree,
      now: Date.now,
    },
  };
}

void test("local composition admits a historical provider preview only after checking actual stored Git objects", () => {
  const value = localGitFixture();
  try {
    assert.throws(
      () => prepareMergeSnapshot(value.snapshot, value.expected),
      /composition differs/,
    );
    assert.throws(
      () =>
        prepareMergeSnapshot(
          { ...value.snapshot, composition: { method: "local-git-merge-tree", verified: true } },
          value.expected,
        ),
      /composition differs/,
    );
    const result = prepareMergeSnapshot(value.snapshot, value.expected, value.directory);
    assert.equal(result.head, value.expected.head);
    assert.equal(result.target, value.expected.target);
    assert.equal(result.tree, value.expected.tree);
    assert.equal(result.preview, value.snapshot.preview.sha);
    assert.deepEqual(result.composition, {
      method: "local-git-merge-tree",
      preview_target: value.snapshot.preview.parents[0]!.sha,
      preview_tree: value.snapshot.preview.tree.sha,
    });
    const clock = Date.now();
    let clockReads = 0;
    assert.throws(
      () =>
        prepareMergeSnapshot(
          value.snapshot,
          {
            ...value.expected,
            now: () => (clockReads++ < 2 ? clock : clock + 60_001),
          },
          value.directory,
        ),
      /stale/,
    );
    const snapshotFile = path.join(value.directory, "snapshot.json"),
      intentFile = path.join(value.directory, "intent.json"),
      messageFile = path.join(value.directory, "message.json");
    writeFileSync(snapshotFile, JSON.stringify(value.snapshot));
    writeFileSync(intentFile, JSON.stringify(intent));
    writeFileSync(messageFile, JSON.stringify(message));
    const cli = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./pr-delivery.mts", import.meta.url)),
        "prepare-merge",
        "--pr",
        "7",
        "--head",
        value.expected.head,
        "--target",
        value.expected.target,
        "--tree",
        value.expected.tree,
        "--run",
        "42",
        "--attempt",
        "1",
        "--snapshot-file",
        snapshotFile,
        "--closure-intent-file",
        intentFile,
        "--merge-message-file",
        messageFile,
        "--verify-local-composition",
        "--json",
      ],
      { cwd: value.directory, encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const output: unknown = JSON.parse(cli.stdout);
    assert.ok(output && typeof output === "object" && "tree" in output);
    assert.equal(output.tree, value.expected.tree);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

void test("local composition refuses wrong source, tree, preview objects, missing history and target conflicts", () => {
  const value = localGitFixture();
  try {
    for (const target of [value.base, "1".repeat(40)]) {
      const snapshot = structuredClone(value.snapshot);
      snapshot.target_before.commit.sha = snapshot.target_after.commit.sha = target;
      assert.throws(() =>
        prepareMergeSnapshot(snapshot, { ...value.expected, target }, value.directory),
      );
    }
    assert.throws(
      () =>
        prepareMergeSnapshot(
          value.snapshot,
          { ...value.expected, tree: value.base },
          value.directory,
        ),
      /reviewed tree/,
    );
    for (const mutate of [
      (snapshot: typeof value.snapshot) => {
        snapshot.preview.tree.sha = value.expected.tree;
      },
      (snapshot: typeof value.snapshot) => {
        snapshot.preview.parents[1]!.sha = value.base;
      },
      (snapshot: typeof value.snapshot) => {
        snapshot.preview.parents[0]!.sha = value.base;
      },
      (snapshot: typeof value.snapshot) => {
        snapshot.preview.sha =
          snapshot.pull_before.merge_commit_sha =
          snapshot.pull_after.merge_commit_sha =
            "1".repeat(40);
      },
    ]) {
      const snapshot = structuredClone(value.snapshot);
      mutate(snapshot);
      assert.throws(() => prepareMergeSnapshot(snapshot, value.expected, value.directory));
    }
    assert.throws(() => prepareMergeSnapshot(value.snapshot, value.expected, "."), /absolute/);
    const shallow = path.join(value.directory, ".git", "shallow");
    writeFileSync(shallow, value.expected.head + "\n");
    assert.throws(
      () => prepareMergeSnapshot(value.snapshot, value.expected, value.directory),
      /complete stored history/,
    );
    rmSync(shallow);
    value.git(["checkout", "main"]);
    assert.throws(
      () => prepareMergeSnapshot(value.snapshot, value.expected, value.directory),
      /checkout head/,
    );
    const conflict = value.save("shared.txt", "conflicting target\ntwo\nthree\nfour\nfive\nsix\n");
    value.git(["checkout", "candidate"]);
    const snapshot = structuredClone(value.snapshot);
    snapshot.target_before.commit.sha = snapshot.target_after.commit.sha = conflict;
    assert.throws(
      () =>
        prepareMergeSnapshot(snapshot, { ...value.expected, target: conflict }, value.directory),
      /Git merge-tree failed/,
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

void test("local composition ignores external merge drivers, replacement refs and inherited Git overrides", () => {
  const value = localGitFixture();
  try {
    const sentinel = path.join(value.directory, "driver-ran");
    value.git([
      "config",
      "merge.fixture-driver.driver",
      `echo forbidden > '${sentinel.replaceAll("\\", "/")}'`,
    ]);
    value.git(["replace", value.expected.target, value.expected.head]);
    const prior = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = path.join(value.directory, "not-a-repository");
      assert.equal(
        prepareMergeSnapshot(value.snapshot, value.expected, value.directory).tree,
        value.expected.tree,
      );
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prior;
    }
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

void test("connector preparation preserves independently expected head, target, tree and exact squash request", () => {
  const result = prepareMergeSnapshot(fixture(), expected);
  assert.deepEqual(result.merge_request, {
    repository_full_name: repository,
    pr_number: 7,
    expected_head_sha: head,
    merge_method: "squash",
    commit_title: message.title,
    commit_message: message.body,
  });
  assert.equal(result.target, target);
  assert.equal(result.tree, tree);
  assert.deepEqual(result.closure_targets, [repository + "#123"]);
  assert.match(result.boundary, /does not establish the CI checkout/);
  assert.match(result.boundary, /authentic complete collection.*independent review.*authorization/);
  assert.equal(Object.hasOwn(result, "approved"), false);
});

void test("preparation refuses partial or duplicate check, status, job and commit inventories", () => {
  const cases: ((value: ReturnType<typeof fixture>) => void)[] = [
    (value) => {
      value.checks.total_count++;
    },
    (value) => {
      value.statuses.total_count++;
    },
    (value) => {
      value.jobs.total_count++;
    },
    (value) => {
      value.checks.check_runs[1]!.id = 1;
    },
    (value) => {
      value.jobs.jobs[1]!.id = 100;
    },
    (value) => {
      value.commits = [];
    },
    (value) => {
      value.commits.push(structuredClone(value.commits[0]!));
      value.pull_before.commits++;
      value.pull_after.commits++;
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => prepareMergeSnapshot(value, expected), /inventory/);
  }
  for (const name of ["checks", "statuses", "jobs", "commits", "closing_before", "closing_after"])
    assert.throws(() => prepareMergeSnapshot({ ...fixture(), [name]: undefined }, expected));
});

void test("preparation brackets raw body, title, state, preview and current target", () => {
  const cases: ((value: ReturnType<typeof fixture>) => void)[] = [
    (value) => {
      value.pull_after.body += "\nRelated to #456.";
    },
    (value) => {
      value.pull_after.title += " changed";
    },
    (value) => {
      value.pull_after.draft = true;
    },
    (value) => {
      value.pull_after.head.sha = target;
    },
    (value) => {
      value.pull_after.merge_commit_sha = target;
    },
    (value) => {
      value.target_after.commit.sha = oldBase;
    },
    (value) => {
      value.target_before.name = "other";
    },
    (value) => {
      value.preview.tree.sha = oldBase;
    },
    (value) => {
      value.preview.parents.reverse();
    },
    (value) => {
      value.preview.sha = oldBase;
    },
    (value) => {
      value.pull_before.base.repo.full_name = "other/repo";
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => prepareMergeSnapshot(value, expected));
  }
  for (const overrides of [{ head: target }, { target: oldBase }, { tree: oldBase }, { number: 8 }])
    assert.throws(() => prepareMergeSnapshot(fixture(), { ...expected, ...overrides }));
});

void test("complete direct closing observations never default missing relationships to an empty inventory", () => {
  for (const change of [
    { complete: false },
    { total_count: 2 },
    { relationships: undefined },
    { relationships: [], total_count: 0 },
    { body: "unreviewed" },
    { head: target },
    { method: "assumed-from-body" },
    { number: 8 },
    { relationships: [repository + "#123", repository.toUpperCase() + "#123"], total_count: 2 },
  ])
    assert.throws(() =>
      prepareMergeSnapshot(
        { ...fixture(), closing_after: { ...fixture().closing_after, ...change } },
        expected,
      ),
    );
  assert.throws(
    () =>
      prepareMergeSnapshot(fixture(), {
        ...expected,
        closureIntent: { format_version: 1, allowed_targets: [] },
      }),
    /Undeclared/,
  );
});

void test("snapshot freshness covers start, completion, validation and both closing observations", () => {
  for (const change of [
    { started_at: "2026-10-22T19:58:59Z" },
    { completed_at: "2026-10-22T20:00:01Z" },
    { started_at: "2026-10-22T20:00:00Z" },
    { started_at: "2026-02-30T20:00:00Z" },
    { started_at: "2026-10-22T19:59:59+00:00" },
  ])
    assert.throws(() =>
      prepareMergeSnapshot(
        { ...fixture(), collection: { ...fixture().collection, ...change } },
        expected,
      ),
    );
  assert.throws(
    () => prepareMergeSnapshot(fixture(), { ...expected, now: () => now + 60_000 }),
    /stale/,
  );
  for (const change of [
    { observed_at: "2026-10-22T19:59:58Z" },
    { observed_at: "2026-10-22T20:00:00Z" },
  ])
    assert.throws(() =>
      prepareMergeSnapshot(
        { ...fixture(), closing_after: { ...fixture().closing_after, ...change } },
        expected,
      ),
    );
  const reversed = fixture();
  [reversed.closing_before.observed_at, reversed.closing_after.observed_at] = [
    reversed.closing_after.observed_at,
    reversed.closing_before.observed_at,
  ];
  assert.throws(() => prepareMergeSnapshot(reversed, expected), /out of order/);
});

void test("required checks must map to the latest successful jobs in the exact identified execution", () => {
  const cases: ((value: ReturnType<typeof fixture>) => void)[] = [
    (value) => {
      value.run_after.run_attempt++;
    },
    (value) => {
      value.run_before.repository.full_name = "other/repo";
    },
    (value) => {
      value.run_after.status = "in_progress";
    },
    (value) => {
      value.jobs.jobs[0]!.run_id++;
    },
    (value) => {
      value.jobs.jobs[0]!.head_sha = target;
    },
    (value) => {
      value.jobs.jobs[0]!.conclusion = "failure";
    },
    (value) => {
      value.jobs.jobs[0]!.check_run_url = "https://api.github.com/repos/other/repo/check-runs/1";
    },
    (value) => {
      value.checks.check_runs[0]!.head_sha = target;
    },
    (value) => {
      value.checks.check_runs[0]!.conclusion = "failure";
    },
    (value) => {
      value.checks.check_runs[0]!.status = "in_progress";
      value.checks.check_runs[0]!.conclusion = null;
    },
    (value) => {
      value.statuses.statuses.push({ id: 99, context: "catalog", state: "success" });
      value.statuses.total_count++;
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => prepareMergeSnapshot(value, expected));
  }
  for (const overrides of [{ run: 43 }, { attempt: 2 }])
    assert.throws(() => prepareMergeSnapshot(fixture(), { ...expected, ...overrides }));
  for (const key of ["run", "attempt"] as const) {
    const incomplete: MergeSnapshotExpectation = { ...expected };
    delete incomplete[key];
    assert.throws(() => prepareMergeSnapshot(fixture(), incomplete));
  }
});

void test("selective retry retains independent successful earlier jobs but never superseded results", () => {
  const value = fixture();
  value.run_before.run_attempt = value.run_after.run_attempt = 2;
  assert.equal(prepareMergeSnapshot(value, { ...expected, attempt: 2 }).attempt, 2);
  const replacement = {
    ...value.jobs.jobs[0]!,
    id: 300,
    run_attempt: 2,
    conclusion: "failure",
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/300`,
  };
  value.jobs.jobs.push(replacement);
  value.jobs.total_count++;
  assert.throws(
    () => prepareMergeSnapshot(value, { ...expected, attempt: 2 }),
    /job has no check observation/,
  );
});

void test("raw optional checks and jobs also reject unknown or contradictory completion fields", () => {
  for (const change of [
    { status: "invented" },
    { status: "in_progress", conclusion: "success" },
    { status: "completed", conclusion: null },
    { conclusion: "invented" },
    { conclusion: ["success"] },
    { status: ["pending"], conclusion: null },
    { conclusion: undefined },
    { name: "" },
  ]) {
    const value = fixture();
    const check = { ...value.checks.check_runs[0], id: 99, name: "optional", ...change };
    assert.throws(
      () =>
        prepareMergeSnapshot(
          {
            ...value,
            checks: {
              total_count: value.checks.total_count + 1,
              check_runs: [...value.checks.check_runs, check],
            },
          },
          expected,
        ),
      /state or completion/,
    );
    const job = { ...value.jobs.jobs[0], id: 199, name: "optional", ...change };
    assert.throws(
      () =>
        prepareMergeSnapshot(
          {
            ...value,
            jobs: {
              total_count: value.jobs.total_count + 1,
              jobs: [...value.jobs.jobs, job],
            },
          },
          expected,
        ),
      /state or completion/,
    );
  }
  const value = fixture();
  assert.throws(
    () =>
      prepareMergeSnapshot({ ...value, statuses: { ...value.statuses, sha: target } }, expected),
    /status source/,
  );
  for (const state of ["invented", ["success"]])
    assert.throws(
      () =>
        prepareMergeSnapshot(
          {
            ...value,
            statuses: {
              ...value.statuses,
              total_count: 1,
              statuses: [{ id: 99, context: "optional", state }],
            },
          },
          expected,
        ),
      /identity or state/,
    );
});

void test("independent closure intent covers commit text and the actual single-line squash message", () => {
  const value = fixture();
  value.commits[0]!.commit.message += "\n\nCloses #456.";
  assert.throws(() => prepareMergeSnapshot(value, expected), /Undeclared/);
  for (const mergeMessage of [
    { ...message, title: message.title + "\nCloses #456" },
    { ...message, body: "Fixes #456." },
    { ...message, body: "Does not close #123." },
  ])
    assert.throws(() => prepareMergeSnapshot(fixture(), { ...expected, mergeMessage }));
});

void test("postmerge checks bind actual source, single parent, tree, message, branch and closures", () => {
  const result = verifyMergeSnapshotReadback(readback(), expected);
  assert.equal(result.merge_commit_sha, merged);
  assert.deepEqual(result.closure_targets, [repository + "#123"]);
  assert.match(result.boundary, /Never retry/);
  const cases: ((value: ReturnType<typeof readback>) => void)[] = [
    (value) => {
      value.actual_commit.parents.push({ sha: head });
    },
    (value) => {
      value.actual_commit.parents[0]!.sha = oldBase;
    },
    (value) => {
      value.actual_commit.tree.sha = oldBase;
    },
    (value) => {
      value.actual_commit.message += "\nCloses #456.";
    },
    (value) => {
      value.target_after.commit.sha = oldBase;
    },
    (value) => {
      value.prepared.closing_fingerprint = "0".repeat(64);
    },
    (value) => {
      value.prepared.merge_request.expected_head_sha = target;
    },
    (value) => {
      value.pull_after.merged = false;
    },
    (value) => {
      value.prepared.target = oldBase;
    },
  ];
  for (const mutate of cases) {
    const value = readback();
    mutate(value);
    assert.throws(() => verifyMergeSnapshotReadback(value, expected));
  }
  assert.throws(
    () =>
      verifyMergeSnapshotReadback(readback(), {
        ...expected,
        closureIntent: { format_version: 1, allowed_targets: [] },
      }),
    /Undeclared/,
  );
});

void test("snapshot reader rejects missing, nonregular, relative, oversized and malformed UTF-8 inputs", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-delivery-snapshot-"));
  try {
    const file = path.join(directory, "snapshot.json");
    writeFileSync(file, JSON.stringify(fixture()));
    assert.deepEqual(await readDeliverySnapshot(file), fixture());
    await assert.rejects(readDeliverySnapshot("snapshot.json"), /absolute/);
    await assert.rejects(readDeliverySnapshot(directory), /regular file/);
    await assert.rejects(readDeliverySnapshot(path.join(directory, "missing.json")));
    if (process.platform !== "win32") {
      const link = path.join(directory, "linked.json");
      symlinkSync(file, link);
      await assert.rejects(readDeliverySnapshot(link), /regular file/);
    }
    writeFileSync(file, Buffer.from([0xff]));
    await assert.rejects(readDeliverySnapshot(file), /encoded data/);
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(readDeliverySnapshot(file), /16 MiB/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("snapshot CLI prepares and verifies offline without gh or a mutation path", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portcove-delivery-cli-"));
  try {
    const snapshotFile = path.join(directory, "snapshot.json"),
      intentFile = path.join(directory, "intent.json"),
      messageFile = path.join(directory, "message.json");
    writeFileSync(intentFile, JSON.stringify(intent));
    writeFileSync(messageFile, JSON.stringify(message));
    const cli = fileURLToPath(new URL("./pr-delivery.mts", import.meta.url));
    for (const command of ["prepare-merge", "verify-merge"]) {
      writeFileSync(
        snapshotFile,
        JSON.stringify(command === "prepare-merge" ? fixture(Date.now()) : readback(Date.now())),
      );
      const args = [
        cli,
        command,
        "--pr",
        "7",
        "--head",
        head,
        "--target",
        target,
        "--tree",
        tree,
        "--snapshot-file",
        snapshotFile,
        "--closure-intent-file",
        intentFile,
        "--merge-message-file",
        messageFile,
        "--json",
        ...(command === "prepare-merge" ? ["--run", "42", "--attempt", "1"] : []),
      ];
      const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: { ...process.env, PATH: directory },
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const output: unknown = JSON.parse(result.stdout);
      assert.ok(
        output &&
          typeof output === "object" &&
          "observation" in output &&
          output.observation === "complete",
      );
      assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024);
      if (command === "verify-merge") {
        const failures: (() => void)[] = [
          () => {
            const changed = readback(Date.now());
            changed.actual_commit.tree.sha = oldBase;
            writeFileSync(snapshotFile, JSON.stringify(changed));
          },
          () => rmSync(snapshotFile),
          () => writeFileSync(snapshotFile, "{"),
          () => writeFileSync(snapshotFile, Buffer.from([0xff])),
          () => rmSync(intentFile),
          () => rmSync(messageFile),
        ];
        if (process.platform !== "win32")
          failures.push(() => {
            rmSync(snapshotFile);
            symlinkSync(intentFile, snapshotFile);
          });
        for (const fail of failures) {
          writeFileSync(snapshotFile, JSON.stringify(readback(Date.now())));
          writeFileSync(intentFile, JSON.stringify(intent));
          writeFileSync(messageFile, JSON.stringify(message));
          fail();
          const failed = spawnSync(process.execPath, args, {
            encoding: "utf8",
            env: { ...process.env, PATH: directory },
            timeout: 15_000,
          });
          assert.equal(failed.status, 1);
          const evidence: unknown = JSON.parse(failed.stdout);
          assert.ok(
            evidence &&
              typeof evidence === "object" &&
              "status" in evidence &&
              evidence.status === "unknown",
          );
          assert.match(failed.stderr, /do not retry automatically/);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("complete replay snapshot retains both attempts and selects exact authoritative checks", () => {
  const value = fixture();
  value.run_before.run_attempt = value.run_after.run_attempt = 2;
  const newer = {
    ...value.jobs.jobs[0]!,
    id: 300,
    run_attempt: 2,
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/300`,
  };
  value.jobs.jobs.push(newer);
  value.jobs.total_count++;
  value.checks.check_runs.push({ ...value.checks.check_runs[0]!, id: 300 });
  value.checks.total_count++;
  const original = structuredClone(value);
  const result = prepareMergeSnapshot(value, { ...expected, attempt: 2 });
  assert.equal(result.attempt, 2);
  assert.deepEqual(value, original, "complete raw snapshot must remain unchanged");
  const cases: ((v: typeof value) => void)[] = [
    (v) => {
      v.checks.check_runs.at(-1)!.conclusion = v.jobs.jobs.at(-1)!.conclusion = "failure";
    },
    (v) => {
      v.checks.check_runs.at(-1)!.conclusion = v.jobs.jobs.at(-1)!.conclusion = "cancelled";
    },
    (v) => {
      v.checks.check_runs.at(-1)!.status = v.jobs.jobs.at(-1)!.status = "in_progress";
      v.checks.check_runs.at(-1)!.conclusion = null;
      v.jobs.jobs.at(-1)!.conclusion = "";
    },
    (v) => {
      v.jobs.jobs.at(-1)!.run_id++;
    },
    (v) => {
      v.jobs.jobs.at(-1)!.head_sha = target;
    },
    (v) => {
      v.jobs.jobs.at(-1)!.run_attempt = 3;
    },
    (v) => {
      v.jobs.jobs.at(-1)!.run_attempt = 0;
    },
    (v) => {
      v.jobs.jobs.at(-1)!.run_attempt = 1;
    },
    (v) => {
      v.jobs.jobs.at(-1)!.check_run_url = "https://api.github.com/repos/other/repo/check-runs/300";
    },
    (v) => {
      v.jobs.jobs.at(-1)!.id = v.jobs.jobs[0]!.id;
    },
    (v) => {
      v.checks.check_runs.at(-1)!.id = 999;
    },
    (v) => {
      v.statuses.statuses.push({ id: 99, context: "catalog", state: "success" });
      v.statuses.total_count++;
    },
    (v) => {
      v.jobs.total_count++;
    },
    (v) => {
      v.checks.total_count++;
    },
    (v) => {
      v.checks.check_runs.splice(4, 1);
      v.checks.total_count--;
      v.jobs.jobs.splice(4, 1);
      v.jobs.total_count--;
    },
  ];
  for (const mutate of cases) {
    const rejected = structuredClone(original);
    mutate(rejected);
    assert.throws(() => prepareMergeSnapshot(rejected, { ...expected, attempt: 2 }));
  }
});
