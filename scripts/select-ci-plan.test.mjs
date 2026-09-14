import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyChanges,
  discoverCiPlan,
  parseRawDiff,
  proseOnlyAllowlist,
  writeGithubOutputs,
} from "./select-ci-plan.mjs";
import { buildValidationPlan } from "./validation-plan.mjs";

const sha = (character) => character.repeat(40);
const raw = (...records) => Buffer.from(`${records.join("\0")}\0`);
const modified = (file, modes = ["100644", "100644"]) =>
  `:${modes[0]} ${modes[1]} ${sha("1").slice(0, 7)} ${sha("2").slice(0, 7)} M\0${file}`;

test("the prose allowlist is exact and excludes every normative documentation family", () => {
  assert.deepEqual(proseOnlyAllowlist, ["docs/GUI-COMPETITIVE-REVIEW.md", "docs/README.md"]);
  for (const protectedPath of [
    "AGENTS.md",
    "README.md",
    "SECURITY.md",
    "docs/ARCHITECTURE.md",
    "docs/CLI.md",
    "docs/DELIVERY.md",
    "docs/PROJECT-GOVERNANCE.md",
    "docs/QUALITY.md",
    "docs/RELEASING.md",
    "docs/REPOSITORY-SETTINGS.md",
    "docs/UPDATER-TRUST.md",
    "docs/archive/evidence.md",
    "docs/releases/notes.md",
  ]) {
    assert.equal(proseOnlyAllowlist.includes(protectedPath), false, protectedPath);
  }
});

test("parses NUL-delimited additions deletions and both sides of renames", () => {
  const changes = parseRawDiff(
    raw(
      `:000000 100644 ${sha("0").slice(0, 7)} ${sha("1").slice(0, 7)} A`,
      "docs/README.md",
      `:100644 000000 ${sha("1").slice(0, 7)} ${sha("0").slice(0, 7)} D`,
      "docs/GUI-COMPETITIVE-REVIEW.md",
      `:100644 100644 ${sha("1").slice(0, 7)} ${sha("2").slice(0, 7)} R100`,
      "docs/README.md",
      "docs/GUI-COMPETITIVE-REVIEW.md",
    ),
  );
  assert.deepEqual(
    changes.map((change) => change.status),
    ["A", "D", "R"],
  );
  assert.equal(changes[2].oldPath, "docs/README.md");
  assert.equal(changes[2].newPath, "docs/GUI-COMPETITIVE-REVIEW.md");
  assert.equal(classifyChanges(changes).mode, "prose");
});

test("approved prose additions modifications and deletions qualify", () => {
  for (const contents of [
    raw(`:000000 100644 0000000 1111111 A`, "docs/README.md"),
    raw(modified("docs/README.md")),
    raw(`:100644 000000 1111111 0000000 D`, "docs/README.md"),
  ]) {
    assert.equal(classifyChanges(parseRawDiff(contents)).mode, "prose");
  }
});

test("mixed paths route fast while mode, symlink, and unusual statuses require qualification", () => {
  const cases = [
    raw(modified("docs/README.md"), modified("src/product.rs")),
    raw(modified("docs/new informational file.md")),
    raw(modified("docs/README.md", ["100644", "100755"])),
    raw(`:000000 120000 0000000 1111111 A`, "docs/README.md"),
    raw(modified("docs/README\nworkflow.yml")),
    raw(`:100644 100644 1111111 2222222 T`, "docs/README.md"),
  ];
  assert.equal(classifyChanges(parseRawDiff(cases[0])).mode, "fast");
  assert.equal(classifyChanges(parseRawDiff(cases[1])).mode, "fast");
  for (const index of [2, 3, 5])
    assert.equal(classifyChanges(parseRawDiff(cases[index])).mode, "qualification");
  assert.equal(classifyChanges(parseRawDiff(cases[4])).mode, "fast");
});

test("malformed incomplete or empty change discovery fails closed", () => {
  assert.throws(() => parseRawDiff(Buffer.from("not-terminated")), /NUL terminated/u);
  assert.throws(() => parseRawDiff(raw(":bad", "docs/README.md")), /malformed/u);
  assert.equal(classifyChanges([]).mode, "blocked");
});

test("pull requests compare the complete merge-base range and record tested checkout", () => {
  const calls = [];
  const plan = discoverCiPlan(
    {
      eventName: "pull_request",
      baseSha: sha("a"),
      headSha: sha("b"),
      checkoutSha: sha("c"),
      proseOnlyEnabled: true,
    },
    (args) => {
      calls.push(args);
      return args[0] === "merge-base" ? `${sha("d")}\n` : raw(modified("docs/README.md"));
    },
  );
  assert.equal(plan.mode, "prose");
  assert.equal(plan.identities.merge_base, sha("d"));
  assert.equal(plan.identities.checkout, sha("c"));
  assert.deepEqual(calls[1], ["diff", "--raw", "-z", "--find-renames", sha("d"), sha("b")]);
});

test("prose selection requires qualification until independently activated", () => {
  const plan = discoverCiPlan(
    { eventName: "pull_request", baseSha: sha("a"), headSha: sha("b"), checkoutSha: sha("c") },
    (args) => (args[0] === "merge-base" ? `${sha("d")}\n` : raw(modified("docs/README.md"))),
  );
  assert.equal(plan.mode, "qualification");
  assert.equal(plan.reason, "prose-policy-awaiting-independent-activation");
  assert.deepEqual(plan.changed_files, ["docs/README.md"]);
});

test("missing refs and Git errors block rather than authorize guessed validation", () => {
  for (const fixture of [
    { baseSha: "missing", runner: () => assert.fail("git must not run") },
    {
      baseSha: sha("a"),
      runner: () =>
        Object.assign(new Error("missing ref"), { code: "ENOENT" }) &&
        (() => {
          throw Object.assign(new Error("missing ref"), { code: "ENOENT" });
        })(),
    },
  ]) {
    const plan = discoverCiPlan(
      {
        eventName: "pull_request",
        baseSha: fixture.baseSha,
        headSha: sha("b"),
        checkoutSha: sha("c"),
      },
      fixture.runner,
    );
    assert.equal(plan.mode, "blocked");
    assert.match(plan.reason, /diff-discovery-failed/u);
  }
});

test("main and explicit events run all fast groups without consulting a diff", () => {
  for (const eventName of ["push", "workflow_dispatch", "merge_group"])
    assert.equal(
      discoverCiPlan({ eventName, baseSha: "", headSha: "", checkoutSha: sha("c") }, () =>
        assert.fail("git must not run"),
      ).mode,
      "fast",
    );
});

test("reusable qualification forces the exhaustive plan on the exact checkout", () => {
  const plan = discoverCiPlan(
    {
      eventName: "workflow_call",
      baseSha: "",
      headSha: "",
      checkoutSha: sha("c"),
      forceQualification: true,
    },
    () => assert.fail("git must not run"),
  );
  assert.equal(plan.mode, "qualification");
  assert.equal(plan.reason, "explicit-reusable-qualification");
  assert.equal(plan.qualification_required, true);
  assert.equal(plan.identities.checkout, sha("c"));
});

test("GitHub outputs are complete single-line values", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-ci-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const plan = buildValidationPlan({
    changes: [
      {
        status: "M",
        oldMode: "100644",
        newMode: "100644",
        oldPath: "docs/README.md",
        newPath: "docs/README.md",
      },
    ],
    eventName: "pull_request",
    base: sha("a"),
    mergeBase: sha("d"),
    head: sha("b"),
    checkout: sha("c"),
  });
  await writeGithubOutputs(output, plan);
  const contents = await readFile(output, "utf8");
  for (const key of [
    "mode",
    "reason",
    "files_json",
    "groups_json",
    "platforms_json",
    "qualification_required",
    "plan_digest",
    "plan_json",
    "base",
    "merge_base",
    "head",
    "checkout",
  ])
    assert.match(contents, new RegExp(`^${key}=`, "m"));
});
