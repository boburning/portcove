import { workflow } from "./ci-workflow-fixture.mts";
import { workflowJobSource } from "./ci-workflow-fixture.mts";
import { qualificationWorkflow } from "./ci-workflow-fixture.mts";
import { rustTests } from "./ci-workflow-fixture.mts";
import { rustWorkspaceTests } from "./ci-workflow-fixture.mts";
import { windowsStorage } from "./ci-workflow-fixture.mts";
import { nativeRust } from "./ci-workflow-fixture.mts";
import { intelBuild } from "./ci-workflow-fixture.mts";
import { intelTests } from "./ci-workflow-fixture.mts";
import { rustDocs } from "./ci-workflow-fixture.mts";
import { rustQuality } from "./ci-workflow-fixture.mts";
import { frontend } from "./ci-workflow-fixture.mts";
import { catalog } from "./ci-workflow-fixture.mts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyChanges,
  discoverCiPlan,
  fastPlatformMatrix,
  qualificationMatrices,
  parseRawDiff,
  isInformationalPath,
  writeGithubOutputs,
} from "./select-ci-plan.mts";
import {
  buildValidationPlan,
  fastGroups,
  qualificationPlatforms,
  validateValidationPlan,
} from "./validation-plan.mts";
import { nativeCompatibilitySourcePaths } from "./release-native-source-contract.mts";

const sha = (character: string) => character.repeat(40);

void test("GitHub outputs carry the conservative Linux diagnostics decision", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-linux-diagnostics-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, files, expected] of [
    [0, ["crates/portcove-release-tools/src/main.rs"], "false"],
    [1, ["crates/portcove-release-tools/src/main.rs", "crates/portcove-core/src/path.rs"], "true"],
    [2, ["crates/portcove-release-tools/Cargo.toml"], "true"],
  ] as const) {
    const plan = buildValidationPlan({
      changes: files.map((file) => ({
        status: "M",
        oldMode: "100644",
        newMode: "100644",
        oldPath: file,
        newPath: file,
      })),
      eventName: "pull_request",
      base: sha("a"),
      mergeBase: sha("a"),
      head: sha("b"),
      checkout: sha("b"),
    });
    const output = path.join(root, String(index));
    await writeGithubOutputs(output, plan);
    const values = new Map(
      (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          const split = line.indexOf("=");
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    assert.equal(values.get("linux_diagnostics"), expected);
    assert.equal(values.get("plan_digest"), plan.digest);
  }
});

void test("only an explicitly forced release reusable caller selects the beta qualification profile", async (t) => {
  const selected = {
    eventName: "workflow_dispatch",
    checkoutSha: sha("c"),
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-win-linux",
  };
  const beta = discoverCiPlan(selected, () => assert.fail("Git must not run"));
  validateValidationPlan(beta);
  assert.equal(beta.release_profile, "initial-beta-win-linux");
  assert.deepEqual(beta.groups, fastGroups);
  assert.deepEqual(beta.platforms, ["linux-x86_64", "windows-x86_64"]);
  assert.deepEqual(qualificationMatrices(beta), {
    native: [{ platform: "linux-x86_64", runner: "ubuntu-22.04", partition: "hash:1/1" }],
    docs: [
      { platform: "linux-x86_64", runner: "ubuntu-22.04" },
      { platform: "windows-x86_64", runner: "windows-latest" },
    ],
  });
  for (const override of [
    { forceQualification: false },
    { qualificationCaller: "nightly" },
    { callerWorkflow: "qualification.yml" },
    { eventName: "pull_request" },
    { eventName: "schedule" },
    { releaseProfile: "foreign" },
  ])
    assert.throws(() => discoverCiPlan({ ...selected, ...override }), /profile/);
  const full = discoverCiPlan({ ...selected, releaseProfile: "full" });
  const unchanged = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: sha("c"),
    forceQualification: true,
  });
  assert.deepEqual(full, unchanged);
  assert.equal(Object.hasOwn(full, "release_profile"), false);
  assert.deepEqual(full.platforms, qualificationPlatforms);
  assert.equal(qualificationMatrices(full).docs.length, 4);
  assert.equal(qualificationMatrices(full).native.length, 2);
  const root = await mkdtemp(path.join(tmpdir(), "portcove-beta-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  await writeGithubOutputs(output, beta);
  const values = Object.fromEntries(
    (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  assert.equal(values.release_profile, "initial-beta-win-linux");
  assert.equal(values.linux_diagnostics, "true");
  assert.deepEqual(
    JSON.parse(values.qualification_native_matrix_json!),
    qualificationMatrices(beta).native,
  );
  assert.deepEqual(
    JSON.parse(values.qualification_docs_matrix_json!),
    qualificationMatrices(beta).docs,
  );
});
void test("frontend tooling provisioning follows selected inputs and skips pure Rust and allowlisted prose", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-tool-provision-"));
  try {
    for (const [file, expected, workspace] of [
      ["crates/portcove-core/src/lib.rs", false, false],
      ["docs/README.md", false, false],
      ["Cargo.toml", true, false],
      ["scripts/report-summary.mts", true, true],
      ["apps/desktop/src/styles/index.css", true, true],
    ] as const) {
      const plan = buildValidationPlan({
        changes: [
          { status: "M", oldMode: "100644", newMode: "100644", oldPath: file, newPath: file },
        ],
        eventName: "pull_request",
        base: sha("a"),
        mergeBase: sha("a"),
        head: sha("b"),
        checkout: sha("b"),
      });
      const output = path.join(directory, `${expected}-${path.basename(file)}.txt`);
      await writeGithubOutputs(output, plan);
      assert.match(
        await readFile(output, "utf8"),
        new RegExp(`^frontend_tools=${expected}$`, "m"),
        file,
      );
      assert.match(
        await readFile(output, "utf8"),
        new RegExp(`^frontend_workspace=${workspace}$`, "m"),
        file,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const raw = (...records: string[]) => Buffer.from(`${records.join("\0")}\0`);
const modified = (file: string, modes: readonly [string, string] = ["100644", "100644"]) =>
  `:${modes[0]} ${modes[1]} ${sha("1").slice(0, 7)} ${sha("2").slice(0, 7)} M\0${file}`;

void test("informational selection is a category, while policy retains affected contracts", () => {
  for (const file of ["docs/new-guide.md", "docs/media/capture.png"])
    assert.ok(isInformationalPath(file));
  for (const file of ["AGENTS.md", "docs/QUALITY.md", ".agents/skills/example/SKILL.md"])
    assert.equal(isInformationalPath(file), false);
});

void test("parses NUL-delimited additions deletions and both sides of renames", () => {
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
  const renamed = changes[2];
  assert(renamed);
  assert.equal(renamed.oldPath, "docs/README.md");
  assert.equal(renamed.newPath, "docs/GUI-COMPETITIVE-REVIEW.md");
  assert.equal(classifyChanges(changes).mode, "prose");
});

void test("approved prose additions modifications and deletions qualify", () => {
  for (const contents of [
    raw(`:000000 100644 0000000 1111111 A`, "docs/README.md"),
    raw(modified("docs/README.md")),
    raw(`:100644 000000 1111111 0000000 D`, "docs/README.md"),
  ]) {
    assert.equal(classifyChanges(parseRawDiff(contents)).mode, "prose");
  }
});

void test("mixed paths route fast while mode, symlink, and unusual statuses require qualification", () => {
  const cases = [
    raw(modified("docs/README.md"), modified("src/product.rs")),
    raw(modified("docs/new informational file.md")),
    raw(modified("docs/README.md", ["100644", "100755"])),
    raw(`:000000 120000 0000000 1111111 A`, "docs/README.md"),
    raw(modified("docs/README\nworkflow.yml")),
    raw(`:100644 100644 1111111 2222222 T`, "docs/README.md"),
  ];
  assert.equal(classifyChanges(parseRawDiff(cases[0])).mode, "fast");
  assert.equal(classifyChanges(parseRawDiff(cases[1])).mode, "prose");
  assert.equal(classifyChanges(parseRawDiff(cases[2])).mode, "prose");
  for (const index of [3, 5])
    assert.equal(classifyChanges(parseRawDiff(cases[index])).mode, "blocked");
  assert.equal(classifyChanges(parseRawDiff(cases[4])).mode, "fast");
});

void test("malformed incomplete or empty change discovery fails closed", () => {
  assert.throws(() => parseRawDiff(Buffer.from("not-terminated")), /NUL terminated/u);
  assert.throws(() => parseRawDiff(raw(":bad", "docs/README.md")), /malformed/u);
  assert.equal(classifyChanges([]).mode, "blocked");
});

void test("pull requests compare the complete merge-base range and record tested checkout", () => {
  const calls: string[][] = [];
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

void test("prose selection requires qualification until independently activated", () => {
  const plan = discoverCiPlan(
    { eventName: "pull_request", baseSha: sha("a"), headSha: sha("b"), checkoutSha: sha("c") },
    (args) => (args[0] === "merge-base" ? `${sha("d")}\n` : raw(modified("docs/README.md"))),
  );
  assert.equal(plan.mode, "qualification");
  assert.equal(plan.reason, "prose-policy-awaiting-independent-activation");
  assert.deepEqual(plan.changed_files, ["docs/README.md"]);
});

void test("fast routing requires a separate trusted activation change", () => {
  const run = (fastValidationEnabled: boolean) =>
    discoverCiPlan(
      {
        eventName: "pull_request",
        baseSha: sha("a"),
        headSha: sha("b"),
        checkoutSha: sha("c"),
        proseOnlyEnabled: true,
        fastValidationEnabled,
      },
      (args) =>
        args[0] === "merge-base" ? `${sha("d")}\n` : raw(modified("apps/desktop/src/App.tsx")),
    );
  const staged = run(false);
  assert.equal(staged.mode, "qualification");
  assert.equal(staged.reason, "fast-validation-awaiting-independent-activation");
  assert.deepEqual(staged.groups, [
    "catalog",
    "dependency-review",
    "frontend",
    "rust",
    "rust-quality",
  ]);
  assert.equal(run(true).mode, "fast");
});

void test("missing refs and Git errors block rather than authorize guessed validation", () => {
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

void test("main pushes compare the complete before-to-after event diff", () => {
  const calls: string[][] = [];
  const p = discoverCiPlan(
    {
      eventName: "push",
      baseSha: sha("a"),
      headSha: sha("b"),
      checkoutSha: sha("b"),
      proseOnlyEnabled: true,
      fastValidationEnabled: true,
    },
    (args) => {
      calls.push(args);
      return Buffer.from(":100644 100644 aaaa bbbb M\0apps/desktop/src/App.tsx\0");
    },
  );
  assert.deepEqual(calls, [
    ["cat-file", "-e", `${sha("b")}^{commit}`],
    ["cat-file", "-e", `${sha("a")}^{commit}`],
    ["diff", "--raw", "-z", "--find-renames", sha("a"), sha("b")],
  ]);
  assert.deepEqual(p.groups, ["frontend", "rust-quality"]);
  assert.equal(p.identities.merge_base, sha("a"));
  const first = discoverCiPlan(
    { eventName: "push", baseSha: "0".repeat(40), checkoutSha: sha("b") },
    () => assert.fail(),
  );
  assert.deepEqual(first.groups, [
    "catalog",
    "dependency-review",
    "frontend",
    "rust",
    "rust-quality",
  ]);
});

void test("reusable qualification forces the exhaustive plan on the exact checkout", () => {
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

void test("focused platform plans map only exact maintained runners", () => {
  assert.deepEqual(fastPlatformMatrix({ platforms: ["windows-x86_64"] }), [
    { platform: "windows-x86_64", runner: "windows-latest" },
  ]);
  assert.deepEqual(fastPlatformMatrix({ platforms: ["macos-aarch64", "macos-x86_64"] }), [
    { platform: "macos-aarch64", runner: "macos-15" },
    { platform: "macos-x86_64", runner: "macos-15-intel" },
  ]);
  assert.deepEqual(fastPlatformMatrix({ platforms: ["primary-host"] }), []);
  // @ts-expect-error Deliberately malformed external platform identity.
  assert.throws(() => fastPlatformMatrix({ platforms: ["unknown"] }), /no runner/u);
});

void test("GitHub outputs are complete single-line values", async (t) => {
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
    "platform_matrix_json",
    "qualification_required",
    "plan_digest",
    "plan_json",
    "plan_gzip_base64",
    "base",
    "merge_base",
    "head",
    "checkout",
  ])
    assert.match(contents, new RegExp(`^${key}=`, "m"));
});

void test("containment discovery binds complete protected coverage for both rename sides", () => {
  const inputs = [
    "scripts/rust-test-tree-supervisor.mts",
    "scripts/rust-test-tree-supervisor.test.mts",
    "scripts/fixtures/linux-process-tree-reaper.rs.txt",
  ];
  const future = "new-subsystem/future-supervisor.mjs";
  for (const input of inputs) {
    for (const diff of [
      raw(modified(input)),
      raw(":000000 100644 0000000 1111111 A", input),
      raw(":100644 000000 1111111 0000000 D", input),
      raw(":100644 100644 1111111 2222222 R100", input, future),
      raw(":100644 100644 1111111 2222222 R100", future, input),
      raw(...inputs.map((file) => modified(file))),
    ]) {
      const selected = discoverCiPlan(
        {
          eventName: "pull_request",
          baseSha: sha("a"),
          headSha: sha("b"),
          checkoutSha: sha("c"),
          fastValidationEnabled: true,
        },
        (args) => (args[0] === "merge-base" ? `${sha("d")}\n` : diff),
      );
      assert.equal(selected.discovery, "complete");
      assert.equal(selected.mode, "fast", input);
      assert.equal(selected.qualification_required, false, input);
      assert.ok(selected.groups.includes("catalog") && selected.groups.includes("rust-quality"));
      assert.deepEqual(selected.platforms, ["primary-host"]);
      const selectedPath = selected.paths.find((entry) => entry.path === input);
      assert(selectedPath);
      assert.equal(selectedPath.unknown, false);
      assert.deepEqual(selected.identities, {
        base: sha("a"),
        merge_base: sha("d"),
        head: sha("b"),
        checkout: sha("c"),
      });
      assert.match(selected.digest, /^[a-f0-9]{64}$/u);
      if (selected.changed_files.includes(future)) {
        assert(selected.fallback);
        assert.ok(selected.fallback.paths.includes(future));
      }
    }
  }
});

void test("missing historical push base falls back to the whole baseline; current head and malformed diff block", () => {
  const options = {
    eventName: "push",
    baseSha: sha("a"),
    headSha: sha("b"),
    checkoutSha: sha("b"),
    fastValidationEnabled: true,
    proseOnlyEnabled: true,
  };
  const missing = discoverCiPlan(options, (args) => {
    if (args[0] === "cat-file" && args[2]?.startsWith(sha("a")))
      throw Object.assign(new Error("missing base"), { status: 128 });
    return Buffer.alloc(0);
  });
  assert.equal(missing.mode, "fast");
  assert.equal(missing.groups.length, 5);
  assert.deepEqual(missing.changed_files, []);
  for (const runner of [
    () => {
      throw Object.assign(new Error("missing head"), { status: 128 });
    },
    (args: string[]) => (args[0] === "diff" ? Buffer.from("truncated") : Buffer.alloc(0)),
  ])
    assert.equal(discoverCiPlan(options, runner).mode, "blocked");
});

void test("explicit qualification emits tool prerequisites without invoking ordinary-only selection", async () => {
  const plan = discoverCiPlan({
    eventName: "workflow_call",
    checkoutSha: sha("a"),
    forceQualification: true,
  });
  const directory = await mkdtemp(path.join(tmpdir(), "qualification-output-"));
  try {
    const file = path.join(directory, "output");
    await writeGithubOutputs(file, plan);
    assert.match(await readFile(file, "utf8"), /^contract_rust=true$/mu);
    assert.match(await readFile(file, "utf8"), /^contract_desktop=true$/mu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("hosted output provisions desktop dependencies for native source consumers without release qualification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "contract-dependencies-output-"));
  try {
    for (const [index, source] of [
      ...nativeCompatibilitySourcePaths,
      "crates/portcove-core/src/source_report.rs",
      "docs/README.md",
    ].entries()) {
      const plan = buildValidationPlan({
        changes: [
          { status: "M", oldPath: source, newPath: source, oldMode: "100644", newMode: "100644" },
        ],
        eventName: "pull_request",
        base: sha("a"),
        mergeBase: sha("a"),
        head: sha("b"),
        checkout: sha("c"),
      });
      const output = path.join(directory, String(index));
      await writeGithubOutputs(output, plan);
      const expected = nativeCompatibilitySourcePaths.some((file) => file === source);
      assert.match(
        await readFile(output, "utf8"),
        new RegExp(`^contract_desktop=${String(expected)}$`, "mu"),
        source,
      );
      assert.equal(plan.qualification_required, false, source);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("raw Git and plan admission share strict changed-path policy", () => {
  const header = ":100644 100644 aaaaaaa bbbbbbb M";
  for (const file of [
    "",
    "../outside",
    "nested/../outside",
    "/absolute",
    "dir\\file",
    "nul\0path",
  ]) {
    assert.throws(() => parseRawDiff(Buffer.from(`${header}\0${file}\0`)));
    assert.throws(() =>
      buildValidationPlan({
        eventName: "pull_request",
        checkout: sha("a"),
        changes: [{ status: "M", path: file }],
      }),
    );
  }
  const file = "docs/name with spaces.md";
  assert.equal(parseRawDiff(Buffer.from(`${header}\0${file}\0`))[0]?.newPath, file);
});

void test("release qualification profile connects bounded matrices and skips only absent macOS coverage", () => {
  assert.match(
    workflow,
    /PORTCOVE_RELEASE_PROFILE: \$\{\{ inputs\.release_profile \|\| 'full' \}\}/,
  );
  assert.match(
    workflow,
    /PORTCOVE_QUALIFICATION_CALLER: \$\{\{ inputs\.qualification_caller \|\| '' \}\}/,
  );
  assert.match(workflow, /PORTCOVE_CALLER_WORKFLOW: \$\{\{ inputs\.caller_workflow \|\| '' \}\}/);
  assert.match(
    qualificationWorkflow,
    /release_profile: \$\{\{ inputs\.release_profile \|\| 'full' \}\}/,
  );
  assert.match(
    rustDocs,
    /include: \$\{\{ fromJSON\(needs\.classify\.outputs\.qualification_docs_matrix_json\) \}\}/,
  );
  for (const body of [intelBuild, intelTests])
    assert.match(
      body,
      /if: needs\.classify\.outputs\.mode == 'qualification' && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-x86_64'\)/,
    );
  const portability = workflowJobSource(workflow, "frontend_portability");
  assert.match(
    portability,
    /if: \(needs\.classify\.outputs\.mode == 'qualification' && contains\(fromJSON\(needs\.classify\.outputs\.platforms_json\), 'macos-aarch64'\)\)/,
  );
  const beta = discoverCiPlan({
    eventName: "workflow_dispatch",
    checkoutSha: "a".repeat(40),
    forceQualification: true,
    qualificationCaller: "release",
    callerWorkflow: "release.yml",
    releaseProfile: "initial-beta-win-linux",
  });
  assert.deepEqual(
    qualificationMatrices(beta).native.map(({ platform }) => platform),
    ["linux-x86_64"],
  );
  assert.deepEqual(
    qualificationMatrices(beta).docs.map(({ platform }) => platform),
    ["linux-x86_64", "windows-x86_64"],
  );
  for (const body of [
    rustTests,
    rustWorkspaceTests,
    windowsStorage,
    nativeRust,
    rustDocs,
    rustQuality,
    frontend,
    catalog,
  ])
    assert.match(body, /if: needs\.classify\.outputs\.mode == 'qualification'/);
});
