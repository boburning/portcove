import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildPlan,
  classifyChanges,
  deduplicateCommands,
  executePlan,
  executePlanWithReceipts,
  fingerprintLocalStage,
  formatCommand,
  localChangesFromRaw,
  packagesWithDoctests,
  parseNameStatus,
  requireFocusedArguments,
  storageScopeForPlan,
  untrackedFileMode,
  buildExecutionPreflight,
  selectedPlanInventory,
  inspectHostedLocalRoute,
  inspectPreChangeAudit,
  readDoctestPackages,
  main,
} from "./local-validation.mjs";
import { isExcludedOxfmtPath } from "./oxfmt-ownership.mjs";
import { buildValidationPlan } from "./validation-plan.mjs";

const allFilesExist = () => true;

test("review inventory keeps command arguments while making candidate-root paths portable", () => {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const entry = {
    id: "owned",
    executable: process.execPath,
    args: [source + "scripts/check.mjs", "--all", "/other/input"],
    cwd: source + "apps/desktop",
  };
  assert.deepEqual(selectedPlanInventory([entry]), [
    {
      id: "owned",
      executable: "$NODE",
      args: ["$SOURCE/scripts/check.mjs", "--all", "/other/input"],
      cwd: "$SOURCE/apps/desktop",
    },
  ]);
  assert.equal(entry.executable, process.execPath);
  assert.equal(entry.args[0], source + "scripts/check.mjs");
});

function preflightFixture() {
  const context = { headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeBase: "b".repeat(40) };
  const validationPlan = buildValidationPlan({
    changes: [
      {
        status: "M",
        oldPath: "apps/desktop/src/App.tsx",
        newPath: "apps/desktop/src/App.tsx",
        oldMode: "100644",
        newMode: "100644",
      },
    ],
    eventName: "pull_request",
    head: context.headSha,
    base: context.baseSha,
    mergeBase: context.mergeBase,
    checkout: context.headSha,
  });
  const plan = [
    {
      id: "rust-clippy:portcove-desktop",
      reason: "compile the actual native target",
      executable: "cargo",
      args: ["clippy", "--locked", "-p", "portcove-desktop"],
      cwd: "/source",
    },
  ];
  const prerequisites = ["node", "rustc", "cargo", "clippy-component"]
    .map((id) => ({ id, status: "ok" }))
    .concat({
      id: "native-desktop-build",
      status: "unavailable",
      remediation: "use an approved capable route",
    });
  return { context, validationPlan, plan, prerequisites };
}

test("preflight selects the approved capable route without claiming execution or CI", () => {
  const inputs = preflightFixture();
  const hosted = { status: "eligible", command: "exact frozen hosted dispatch" };
  const report = buildExecutionPreflight({ ...inputs, hosted });
  assert.equal(report.obligations[0].route, "hosted-local-check");
  assert.deepEqual(report.obligations[0].missing, ["native-desktop-build"]);
  assert.equal(report.obligations[0].next_action, hosted.command);
  assert.match(report.local_profile, /full-debug/);
  assert.match(report.hosted_ci.role, /mandatory exact-head CI/);
  assert.match(report.limits, /No dispatch or acceptance/);
  const blocked = buildExecutionPreflight({
    ...inputs,
    hosted: { status: "blocked", reason: "authority changed" },
  });
  assert.equal(blocked.obligations[0].route, "blocked");
  const local = buildExecutionPreflight({
    ...inputs,
    prerequisites: inputs.prerequisites.map((item) => ({ ...item, status: "ok" })),
    hosted,
  });
  assert.equal(local.obligations[0].route, "local");
  assert.equal(local.obligations[0].command, formatCommand(inputs.plan[0]));
  assert.throws(
    () =>
      buildExecutionPreflight({
        ...inputs,
        context: { ...inputs.context, headSha: "c".repeat(40) },
        hosted,
      }),
    /current complete comparison/,
  );
});

test("preflight reports local prerequisites of the already selected audit stages", () => {
  const inputs = preflightFixture();
  const audit = {
    profile: "complete",
    route: "hosted-deep-audit",
    stages: [
      { id: "rust", command: "just check-rust" },
      { id: "release-unit", command: "just release-check" },
    ],
    local_stages: [
      { id: "rust", command: "just check-rust" },
      { id: "release-unit", command: "just release-check" },
    ],
  };
  const prerequisites = inputs.prerequisites.concat([
    { id: "complete-audit-prerequisites", status: "unverified" },
    { id: "aqua-state", status: "ok" },
    { id: "pwsh", status: "unavailable", remediation: "provide bare pwsh" },
    { id: "unix-socket-path", status: "unavailable", remediation: "shorten temporary path" },
  ]);
  const report = buildExecutionPreflight({
    ...inputs,
    prerequisites,
    hosted: { status: "blocked" },
    audit,
    platform: "linux",
  });
  assert.equal(report.pre_change_audit.profile, "complete");
  assert.equal(report.pre_change_audit.route, "hosted-deep-audit");
  assert.deepEqual(report.pre_change_audit.missing_local_prerequisites, [
    "complete-audit-prerequisites",
    "pwsh",
    "unix-socket-path",
  ]);
  assert.deepEqual(
    report.pre_change_audit.local_prerequisites.map((entry) => entry.id),
    ["node", "complete-audit-prerequisites", "aqua-state", "pwsh", "unix-socket-path"],
  );
});

test("hosted preflight requires exact available ancestor authorities and a frozen clean source", () => {
  const { context } = preflightFixture();
  const sha = "b".repeat(40);
  const invoke =
    (paths = "", dirty = "") =>
    (args) => {
      if (args[0] === "status") return dirty;
      if (args[0] === "for-each-ref") return "refs/remotes/origin/ci/selected-check";
      if (args[0] === "rev-parse") return args[1].includes(":") ? "c".repeat(40) : sha;
      if (args[0] === "show") return "hosted-local-check controller\nhosted-local-check run";
      if (args[0] === "diff")
        return paths.startsWith(":")
          ? paths
          : paths
              .split("\0")
              .filter(Boolean)
              .map((name) => `:100644 100644 ${"b".repeat(40)} ${"a".repeat(40)} M\0${name}\0`)
              .join("");
      return "";
    };
  assert.equal(inspectHostedLocalRoute(context).status, "unverified");
  assert.throws(() => inspectHostedLocalRoute(context, "main", sha), /exact authority/);
  assert.equal(
    inspectHostedLocalRoute(context, sha, sha, invoke("", " M source")).status,
    "blocked",
  );
  for (const changed of [
    "Cargo.lock",
    "scripts/local-validation.mjs",
    "scripts/dev-doctor.mjs",
    "apps/desktop/scripts/new-helper.mjs",
    "docs/QUALITY.md",
  ]) {
    assert.equal(
      inspectHostedLocalRoute(context, sha, sha, invoke(changed + "\0")).status,
      "blocked",
      changed,
    );
  }
  const eligible = inspectHostedLocalRoute(
    context,
    sha,
    sha,
    invoke("apps/desktop/src-tauri/src/cli_context.rs\0scripts/example.test.mjs\0"),
    "ci/selected-check",
  );
  assert.equal(eligible.status, "eligible");
  assert.match(eligible.command, new RegExp(`source_sha=${context.headSha}`));
  assert.match(eligible.dispatch_authority, /not established/);
  assert.match(eligible.command, /--ref ci\/selected-check /);
  assert.match(eligible.command, new RegExp(`controller_sha=${sha}`));
  assert.equal(inspectHostedLocalRoute(context, sha, sha, invoke()).status, "unverified");
  for (const name of [
    sha,
    sha.toUpperCase(),
    "B" + sha.slice(1),
    "main;echo",
    "main$(echo)",
    "--main",
    "main'quoted",
  ])
    assert.throws(() => inspectHostedLocalRoute(context, sha, sha, invoke(), name), /safe branch/);
  for (const refs of ["", "refs/remotes/origin/ci/selected-check\nrefs/tags/ci/selected-check"])
    assert.equal(
      inspectHostedLocalRoute(
        context,
        sha,
        sha,
        (args) => (args[0] === "for-each-ref" ? refs : invoke()(args)),
        "ci/selected-check",
      ).status,
      "blocked",
    );
  assert.equal(
    inspectHostedLocalRoute(
      context,
      sha,
      sha,
      (args) =>
        args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes/")
          ? "d".repeat(40)
          : invoke()(args),
      "ci/selected-check",
    ).status,
    "blocked",
  );
  assert.equal(
    inspectHostedLocalRoute(
      context,
      sha,
      sha,
      (args) =>
        args[0] === "for-each-ref"
          ? "refs/remotes/origin/ci/selected-check\trefs/remotes/origin/main"
          : invoke()(args),
      "ci/selected-check",
    ).status,
    "blocked",
  );
  const tagged = inspectHostedLocalRoute(
    context,
    sha,
    sha,
    (args) => (args[0] === "for-each-ref" ? "refs/tags/ci/selected-check" : invoke()(args)),
    "ci/selected-check",
  );
  assert.equal(tagged.status, "eligible");

  const renamed = `:100644 100644 ${"b".repeat(40)} ${"a".repeat(40)} R100\0scripts/owned-authority.mjs\0docs/moved.txt\0`;
  assert.equal(inspectHostedLocalRoute(context, sha, sha, invoke(renamed)).status, "blocked");
  assert.equal(
    inspectHostedLocalRoute(context, sha, sha, (args) =>
      args[0] === "rev-parse" && args[1] === `${context.headSha}:scripts/workflow-provenance.mjs`
        ? "d".repeat(40)
        : invoke()(args),
    ).status,
    "blocked",
  );
  assert.throws(
    () =>
      inspectHostedLocalRoute(context, sha, sha, () => {
        throw new Error("unavailable comparison authority");
      }),
    /unavailable/,
  );
});

test("hosted dispatch-ref arguments fail before discovery when missing or outside preflight", async () => {
  const options = {
    readContext: () => {
      throw new Error("unexpected discovery");
    },
  };
  await assert.rejects(main(["check", "--hosted-ref"], options), /requires a branch or tag/);
  await assert.rejects(
    main(["check", "--preflight", "--hosted-ref", "--json"], options),
    /requires a branch or tag/,
  );
  await assert.rejects(
    main(["check", "--hosted-ref", "ci/selected-check"], options),
    /require --preflight/,
  );
});

test("missing Cargo is a bounded non-provisioning planning failure", () => {
  assert.throws(
    () =>
      readDoctestPackages({
        observeOnly: true,
        spawn: (command, args, options) => {
          assert.equal(command, "cargo");
          assert.ok(args.includes("--offline") && args.includes("--locked"));
          assert.equal(options.timeout, 15000);
          assert.equal(options.env.RUSTUP_AUTO_INSTALL, "0");
          assert.equal(options.env.CARGO_NET_OFFLINE, "true");
          return { error: Object.assign(new Error("unavailable fixture"), { code: "ENOENT" }) };
        },
      }),
    /unavailable fixture/,
  );
});

test("a missing Windows/MSBuild Playnite capability cannot route to Ubuntu", () => {
  const inputs = preflightFixture();
  const plan = [
    {
      id: "playnite-contract",
      reason: "execute actual Windows consumer",
      executable: "pwsh",
      args: ["integrations/playnite/check.ps1"],
      cwd: "/source",
    },
  ];
  const prerequisites = ["node", "rustc", "cargo", "pwsh"]
    .map((id) => ({ id, status: "ok" }))
    .concat([
      { id: "windows-host", status: "unavailable" },
      { id: "msbuild", status: "unavailable" },
    ]);
  const report = buildExecutionPreflight({
    ...inputs,
    plan,
    prerequisites,
    platform: "linux",
    hosted: { status: "eligible", command: "Ubuntu dispatch" },
  });
  assert.equal(report.obligations[0].route, "blocked");
  assert.ok(report.obligations[0].missing.includes("windows-host"));
});

test("missing Cargo emits a named JSON planning blocker without pretending to select a complete plan", async (t) => {
  const previous = process.exitCode;
  t.after(() => {
    process.exitCode = previous;
  });
  const outputs = [];
  await main(["check", "--preflight", "--json"], {
    readContext: () => ({
      base: "origin/main",
      baseSha: "b".repeat(40),
      mergeBase: "b".repeat(40),
      headSha: "a".repeat(40),
      changes: [
        {
          status: "M",
          path: "crates/portcove-core/src/lib.rs",
          oldMode: "100644",
          newMode: "100644",
        },
      ],
    }),
    metadataProvider: () => {
      throw Object.assign(new Error("private output must not leak"), { code: "ENOENT" });
    },
    log: (value) => outputs.push(value),
  });
  assert.equal(outputs.length, 1);
  const report = JSON.parse(outputs[0]);
  assert.equal(report.status, "planning-blocked");
  assert.equal(report.selected_plan, null);
  assert.equal(report.blocker.id, "cargo-metadata");
  assert.match(report.hosted_ci.role, /mandatory exact-head/);
  assert.ok(!outputs[0].includes("private output"));
  assert.equal(process.exitCode, 1);
});

test("missing Cargo in a mixed Playnite change does not recommend an incapable Ubuntu route", async (t) => {
  const previous = process.exitCode;
  t.after(() => {
    process.exitCode = previous;
  });
  const outputs = [];
  await main(["check", "--preflight", "--json"], {
    readContext: () => ({
      base: "origin/main",
      baseSha: "b".repeat(40),
      mergeBase: "b".repeat(40),
      headSha: "a".repeat(40),
      changes: [
        "crates/portcove-core/src/lib.rs",
        "integrations/playnite/Portcove.Playnite.csproj",
      ].map((path) => ({ status: "M", path, oldMode: "100644", newMode: "100644" })),
    }),
    metadataProvider: () => {
      throw Error("unavailable");
    },
    hostedInspector: () => ({ status: "eligible", command: "incapable Ubuntu dispatch" }),
    log: (value) => outputs.push(value),
  });
  const report = JSON.parse(outputs[0]);
  assert.equal(report.selected_plan, null);
  assert.ok(!report.blocker.next_action.includes("Ubuntu dispatch"));
  assert.equal(report.status, "planning-blocked");
});

test("normal metadata selection keeps its existing execution contract", () => {
  assert.deepEqual(
    [
      ...readDoctestPackages({
        spawn: (_command, args, options) => {
          assert.equal(options.timeout, undefined);
          assert.ok(!args.includes("--offline"));
          return { status: 0, stdout: JSON.stringify({ packages: [] }) };
        },
      }),
    ],
    [],
  );
});

test("preflight keeps policy qualification and Linux audit scope separate from selected local and Windows evidence", () => {
  const head = "a".repeat(40),
    base = "b".repeat(40);
  const name = "scripts/workflow-provenance.mjs";
  const changes = [
    { status: "M", oldPath: name, newPath: name, oldMode: "100644", newMode: "100644" },
  ];
  const context = {
    headSha: head,
    baseSha: base,
    mergeBase: base,
    changes: [{ status: "M", path: name, oldMode: "100644", newMode: "100644" }],
  };
  const validationPlan = buildValidationPlan({
    changes,
    eventName: "pull_request",
    head,
    base,
    mergeBase: base,
    checkout: head,
  });
  const inventory = {
    head,
    files: [
      {
        path: name,
        kind: "file",
        headBlob: "same",
        indexBlob: "same",
        gitBlob: "same",
        headMode: "100644",
        indexMode: "100644",
      },
    ],
  };
  const command =
    (diff = "", dirty = "") =>
    (args) =>
      args[0] === "status"
        ? dirty
        : args[0] === "diff"
          ? diff
          : args[0] === "branch"
            ? "feature/candidate"
            : "";
  const hosted = inspectPreChangeAudit(context, validationPlan, base, base, {
    inventory,
    platform: "win32",
    git: command(),
  });
  assert.equal(hosted.route, "hosted-deep-audit");
  assert.equal(hosted.profile, "complete");
  assert.ok(hosted.local_stages.some((stage) => stage.id === "windows-qualification"));
  assert.ok(!hosted.stages.some((stage) => stage.id === "windows-qualification"));
  assert.match(hosted.limit, /not equivalent to selected local-check/);
  for (const input of [{ git: command("scripts/audit.mjs") }, { git: command("", " M source") }]) {
    assert.equal(
      inspectPreChangeAudit(context, validationPlan, base, base, { inventory, ...input }).route,
      "local-prerequisites-unverified",
    );
  }
  assert.equal(
    inspectPreChangeAudit(context, validationPlan, undefined, undefined, {
      inventory,
      git: command(),
    }).route,
    "local-prerequisites-unverified",
  );
});
const change = (path, options = {}) => ({ status: "M", path, ...options });
const ids = (plan) => plan.map((entry) => entry.id);

function planFor(paths) {
  const selection = classifyChanges(
    paths.map((path) => (typeof path === "string" ? change(path) : path)),
    { fileExists: allFilesExist },
  );
  return {
    selection,
    plan: buildPlan(selection, {
      mergeBase: "base-sha",
      doctestPackages: new Set(["portcove-core", "portcove-release-tools", "portcove-desktop"]),
    }),
  };
}

test("the maintained default-cover harness selects native scenario contracts without Rust execution", () => {
  const cover = "apps/desktop/scripts/desktop-default-cover-test.mjs";
  for (const status of ["A", "M", "D"]) {
    const { selection, plan } = planFor([{ status, path: cover }]);
    assert.ok(selection.nodeTests.has("scripts/desktop-scenarios.test.mjs"));
    assert.ok(ids(plan).includes("node-tests"));
    assert.ok(!ids(plan).some((id) => id.startsWith("rust-tests")));
    assert.ok(!plan.map(formatCommand).join("\n").includes("desktop-test"));
  }
  const mixed = planFor([cover, "crates/portcove-core/src/artwork.rs"]);
  assert.ok(ids(mixed.plan).some((id) => id.startsWith("rust-tests")));
});

test("source-dialog consumer selects scenario contracts without running native or Rust acceptance", () => {
  const consumer = "apps/desktop/scripts/desktop-source-dialog-test.mjs";
  for (const status of ["A", "M", "D"]) {
    const { selection, plan } = planFor([{ status, path: consumer }]);
    assert.ok(selection.nodeTests.has("scripts/desktop-scenarios.test.mjs"));
    assert.ok(ids(plan).includes("node-tests"));
    assert.ok(!ids(plan).some((id) => id.startsWith("rust-tests")));
    assert.ok(!plan.map(formatCommand).join("\n").includes("desktop-test"));
  }
  const mixed = planFor([consumer, "crates/portcove-core/src/game_file_roots.rs"]);
  assert.ok(ids(mixed.plan).some((id) => id.startsWith("rust-tests")));
});

test("selected local resource scope follows actual commands and mixed or unknown work is conservative", () => {
  assert.equal(storageScopeForPlan([{ id: "diff-check" }, { id: "node-tests" }]), "tooling");
  assert.equal(storageScopeForPlan([{ id: "node-syntax:tool.mjs" }]), "tooling");
  assert.equal(storageScopeForPlan(planFor(["docs/QUALITY.md"]).plan), "frontend");
  assert.equal(
    storageScopeForPlan(planFor(["apps/desktop/src/features/game-details/detail-actions.ts"]).plan),
    "frontend",
  );
  assert.equal(
    storageScopeForPlan([{ id: "rust-core-tests" }, { id: "dependency-policy" }]),
    "rust",
  );
  assert.equal(storageScopeForPlan([{ id: "rust-core-tests" }, { id: "ui-build" }]), "all");
  assert.equal(storageScopeForPlan([{ id: "new-unclassified-stage" }]), "all");
});

test("parses modified, deleted, renamed, and copied Git records", () => {
  const records = parseNameStatus(
    Buffer.from("M\0docs/QUALITY.md\0D\0old.md\0R100\0old.rs\0new.rs\0C090\0a.ts\0b.ts\0"),
  );
  assert.deepEqual(records, [
    { status: "M", path: "docs/QUALITY.md" },
    { status: "D", path: "old.md" },
    { status: "R100", path: "new.rs", previousPath: "old.rs" },
    { status: "C090", path: "b.ts", previousPath: "a.ts" },
  ]);
});

test("also accepts name-status records with an embedded tab", () => {
  assert.deepEqual(parseNameStatus(Buffer.from("M\tdocs/QUALITY.md\0")), [
    { status: "M", path: "docs/QUALITY.md" },
  ]);
});

test("incomplete diff discovery fails closed before selecting tests", () => {
  assert.throws(
    () => parseNameStatus(Buffer.from("R100\0crates/portcove-core/src/old.rs\0")),
    /incomplete git rename\/copy record/u,
  );
  assert.throws(
    () =>
      localChangesFromRaw(
        Buffer.from(":100644 100644 1111111 2222222 R100\0crates/portcove-core/src/old.rs\0"),
      ),
    /unsafe changed path|raw diff ended/u,
  );
});

test("shared local planning retains raw file modes and both rename paths", () => {
  const raw = Buffer.from(
    ":100644 100755 1111111 2222222 M\0docs/QUALITY.md\0" +
      ":100644 100644 1111111 2222222 R100\0old.rs\0new.rs\0",
  );
  assert.deepEqual(localChangesFromRaw(raw), [
    {
      status: "M",
      path: "docs/QUALITY.md",
      previousPath: undefined,
      oldMode: "100644",
      newMode: "100755",
    },
    {
      status: "R",
      path: "new.rs",
      previousPath: "old.rs",
      oldMode: "100644",
      newMode: "100644",
    },
  ]);
});

test("active instruction changes run their semantic contracts", () => {
  const { selection, plan } = planFor(["docs/QUALITY.md", "AGENTS.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation", "tooling"]);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/repository-settings.test.mjs",
    "scripts/repository-skills.test.mjs",
  ]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

test("documentation targets run the dynamic link contract", () => {
  const { selection, plan } = planFor(["docs/ARCHITECTURE.md"]);
  assert.deepEqual([...selection.scopes].sort(), ["documentation", "tooling"]);
  assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mjs"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

test("archived documents retain documentation checks without an excluded formatter target", () => {
  for (const status of ["A", "M"]) {
    const { selection, plan } = planFor([{ status, path: "docs/archive/2026-09-25-audit.md" }]);
    assert.deepEqual([...selection.oxfmtFiles], []);
    assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mjs"]);
    assert.deepEqual(ids(plan), ["diff-check", "node-tests"]);
  }
});

test("active and archived Markdown changes format only the active document", () => {
  const active = "docs/ARCHITECTURE.md";
  assert.deepEqual([...planFor([active]).selection.oxfmtFiles], [active]);
  const { selection, plan } = planFor([active, "docs/archive/2026-09-25-audit.md"]);
  assert.deepEqual([...selection.oxfmtFiles], [active]);
  const formatter = plan.find((entry) => entry.id === "oxfmt");
  assert.ok(formatter);
  assert.ok(formatter.args.some((argument) => argument.endsWith("ARCHITECTURE.md")));
  assert.ok(
    !formatter.args.some((argument) => argument.replaceAll("\\", "/").includes("docs/archive/")),
  );
});

test("formatter exclusions cover numbered release evidence and generated or fixture files", () => {
  const excluded = [
    "docs/releases/2026.md",
    "docs/releases/0.1.0-alpha.2-release-notes.md",
    "crates/portcove-core/catalog/catalog.json",
    "crates/portcove-core/tests/fixtures/legacy.json",
    "scripts/example.generated.json",
  ];
  for (const file of excluded) assert.equal(isExcludedOxfmtPath(file), true, file);
  const selection = classifyChanges(excluded.map(change), { fileExists: allFilesExist });
  assert.deepEqual([...selection.oxfmtFiles], []);
  assert.equal(isExcludedOxfmtPath("docs/ARCHITECTURE.md"), false);
  assert.equal(isExcludedOxfmtPath("docs/releases/README.md"), false);
});

test("archive renames and deletions keep active formatter ownership precise", () => {
  const toActive = planFor([
    { status: "R100", previousPath: "docs/archive/old.md", path: "docs/new.md" },
  ]);
  assert.deepEqual([...toActive.selection.oxfmtFiles], ["docs/new.md"]);
  const toArchive = planFor([
    { status: "R100", previousPath: "docs/old.md", path: "docs/archive/new.md" },
  ]);
  assert.deepEqual([...toArchive.selection.oxfmtFiles], []);
  assert.deepEqual(ids(toArchive.plan), ["diff-check", "node-tests"]);
  const deletion = planFor([{ status: "D", path: "docs/archive/old.md" }]);
  assert.deepEqual([...deletion.selection.oxfmtFiles], []);
  assert.deepEqual(ids(deletion.plan), ["diff-check", "node-tests"]);
});

test("current and historical catalog authorities select their generator contracts", () => {
  const current = planFor([
    "crates/portcove-core/catalog/catalog-current-authoring.json",
  ]).selection;
  assert.deepEqual([...current.nodeTests], ["scripts/generate-catalog.test.mjs"]);

  const embedded = planFor(["crates/portcove-core/catalog/catalog.json"]).selection;
  assert.deepEqual([...embedded.nodeTests].sort(), [
    "scripts/generate-catalog.test.mjs",
    "scripts/repository-skills.test.mjs",
  ]);

  for (const path of [
    "crates/portcove-core/catalog/catalog-schema1-fixture.json",
    "crates/portcove-core/catalog/catalog-schema2-migration-fixture.json",
  ]) {
    const historical = planFor([path]).selection;
    assert.equal(historical.nodeTests.has("scripts/migrate-catalog-schema2.test.mjs"), true, path);
  }
});

test("repository skill changes run the dynamic skill contract", () => {
  const { selection, plan } = planFor([".agents/skills/portcove-release-validation/SKILL.md"]);
  assert.deepEqual([...selection.nodeTests], ["scripts/repository-skills.test.mjs"]);
  assert.deepEqual(ids(plan), ["diff-check", "oxfmt", "node-tests"]);
});

test("a Rust source change checks and tests only its affected package", () => {
  const { selection, plan } = planFor(["crates/portcove-core/src/database.rs"]);
  assert.deepEqual([...selection.packages], ["portcove-core"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-clippy:portcove-core",
    "rust-tests:portcove-core",
    "rust-docs:portcove-core",
  ]);
});

test("mapped module-local Rust changes run the owned focused group", () => {
  const { plan } = planFor(["crates/portcove-core/src/source_report.rs"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-clippy:portcove-core",
    "rust-tests:portcove-core:source-inspection",
    "rust-docs:portcove-core",
  ]);
  const tests = plan.find((entry) => entry.id.endsWith(":source-inspection"));
  assert.equal(tests.args.at(-2), "-E");
  assert.match(tests.args.at(-1), /source_report/u);
  assert.match(tests.reason, /explicit test-impact ownership/u);
});

test("mapped Rust responsibilities run one attributable guarded union", () => {
  const { plan } = planFor([
    "crates/portcove-core/src/source_report.rs",
    "crates/portcove-core/src/release/observation.rs",
  ]);
  const union = plan.find((entry) => entry.id === "rust-tests:portcove-core:union");
  assert.deepEqual(union.args, [
    "scripts/run-rust-tests.mjs",
    "--impact-union",
    "portcove-core",
    "release-discovery",
    "source-inspection",
  ]);
  assert.match(union.reason, /release-discovery/u);
  assert.match(union.reason, /source-inspection/u);
  assert.ok(!ids(plan).includes("rust-tests:portcove-core"));
});

test("private backup fixture feedback keeps complete family, Clippy and doctests", () => {
  const path = "crates/portcove-core/src/service/tests/backups.rs";
  const { plan } = planFor([path]);
  const tests = plan.find((entry) => entry.id === "rust-tests:portcove-core:backup-fixtures");
  assert.ok(tests);
  assert.equal(tests.args.at(-1), "test(/^service::tests::backups::/)");
  assert.ok(ids(plan).includes("rust-clippy:portcove-core"));
  assert.ok(ids(plan).includes("rust-docs:portcove-core"));
  assert.ok(!ids(plan).includes("rust-tests:portcove-core"));
  for (const shared of [
    "service/backups.rs",
    "recovery.rs",
    "service.rs",
    "database.rs",
    "lib.rs",
  ]) {
    assert.ok(
      ids(planFor([path, `crates/portcove-core/src/${shared}`]).plan).includes(
        "rust-tests:portcove-core",
      ),
      shared,
    );
  }
});

test("artwork fixture edits select their families but storage and decoding stay broad", () => {
  for (const [file, packageName, filter] of [
    ["crates/portcove-core/src/artwork_tests.rs", "portcove-core", "artwork_tests"],
    ["crates/portcove-cli/tests/machine_contract/artwork.rs", "portcove-cli", "artwork_contract"],
  ]) {
    const { plan } = planFor([file]);
    const stage = plan.find((entry) => entry.id === `rust-tests:${packageName}:artwork-fixtures`);
    assert.ok(stage, file);
    assert.ok(stage.args.at(-1).includes(filter));
    assert.ok(!ids(plan).includes(`rust-tests:${packageName}`));
  }
  for (const file of [
    "crates/portcove-core/src/artwork_store.rs",
    "crates/portcove-core/src/artwork_image.rs",
    "crates/portcove-cli/src/main.rs",
  ]) {
    const { plan } = planFor([file]);
    const packageName = file.includes("portcove-cli") ? "portcove-cli" : "portcove-core";
    assert.ok(ids(plan).includes(`rust-tests:${packageName}`), file);
  }
});

test("artwork resolution selects complete transfer families and the public CLI consumer", () => {
  const { plan } = planFor(["crates/portcove-core/src/artwork.rs"]);
  const core = plan.find((entry) => entry.id === "rust-tests:portcove-core:artwork-resolution");
  assert.ok(core);
  for (const family of ["artwork_tests", "import_execution", "library_move", "library_transfer"])
    assert.ok(core.args.at(-1).includes(family), family);
  assert.ok(ids(plan).includes("rust-clippy:portcove-core"));
  assert.ok(ids(plan).includes("rust-docs:portcove-core"));
  const cli = plan.find((entry) => entry.id === "rust-tests:portcove-cli:catalog-artwork-consumer");
  assert.ok(cli);
  assert.match(cli.args.at(-1), /artwork_contract/u);
});

test("embedded catalog feedback includes both core artwork and the public CLI consumer", () => {
  for (const file of [
    "crates/portcove-core/catalog/catalog-current-authoring.json",
    "crates/portcove-core/catalog/catalog.json",
  ]) {
    const { plan } = planFor([file]);
    const core = plan.find((entry) => entry.id === "rust-tests:portcove-core:catalog-contract");
    assert.match(core.args.at(-1), /artwork_tests/);
    const cli = plan.find(
      (entry) => entry.id === "rust-tests:portcove-cli:catalog-artwork-consumer",
    );
    assert.deepEqual(cli.args.slice(0, -2), [
      "scripts/run-rust-tests.mjs",
      "--locked",
      "-p",
      "portcove-cli",
    ]);
    assert.equal(cli.args.at(-2), "-E");
    assert.match(cli.args.at(-1), /artwork_contract/);
    assert.equal(storageScopeForPlan(plan), "rust");
    assert.ok(!plan.some((entry) => entry.id.startsWith("ui-")));
  }
});

test("uncertain artwork module changes preserve broad core and CLI evidence", () => {
  const path = "crates/portcove-core/src/artwork.rs";
  for (const change of [
    { status: "D", path },
    { status: "R100", path, previousPath: "crates/portcove-core/src/old_artwork.rs" },
    { status: "R100", path: "crates/portcove-core/src/new_artwork.rs", previousPath: path },
  ]) {
    const { plan } = planFor([change]);
    assert.ok(ids(plan).includes("rust-tests:portcove-core"));
    const cli = plan.find(
      (entry) => entry.id === "rust-tests:portcove-cli:catalog-artwork-consumer",
    );
    assert.ok(cli);
    assert.ok(!cli.args.includes("-E"));
  }
  const { selection } = planFor([path]);
  const unavailable = buildPlan(selection, { rustTestImpactMap: null });
  assert.ok(ids(unavailable).includes("rust-tests:portcove-core"));
  assert.ok(
    !unavailable
      .find((entry) => entry.id === "rust-tests:portcove-cli:catalog-artwork-consumer")
      .args.includes("-E"),
  );
  for (const cliPath of [
    "crates/portcove-cli/tests/machine_contract/artwork.rs",
    "crates/portcove-cli/src/main.rs",
  ]) {
    const { plan } = planFor([path, cliPath]);
    assert.equal(plan.filter((entry) => entry.id.startsWith("rust-tests:portcove-cli")).length, 1);
  }
});

test("catalog consumer coverage coalesces with an existing CLI family or broad run", () => {
  for (const cliPath of [
    "crates/portcove-cli/tests/machine_contract/artwork.rs",
    "crates/portcove-cli/src/main.rs",
  ]) {
    const { plan } = planFor(["crates/portcove-core/catalog/catalog.json", cliPath]);
    const cliTests = plan.filter(
      (entry) =>
        entry.id.startsWith("rust-tests:portcove-cli:") || entry.id === "rust-tests:portcove-cli",
    );
    assert.equal(cliTests.length, 1);
    assert.ok(!ids(plan).includes("rust-tests:portcove-cli:catalog-artwork-consumer"));
  }
});

test("uncertain catalog changes and unavailable impact maps keep the broad CLI fallback", () => {
  const file = "crates/portcove-core/catalog/catalog.json";
  for (const input of [
    { status: "D", path: file },
    { status: "R100", previousPath: file, path: "crates/portcove-core/catalog/renamed.json" },
  ]) {
    const { plan } = planFor([input]);
    const cli = plan.find(
      (entry) => entry.id === "rust-tests:portcove-cli:catalog-artwork-consumer",
    );
    assert.ok(cli);
    assert.ok(!cli.args.includes("-E"));
    for (const cliPath of [
      "crates/portcove-cli/tests/machine_contract/artwork.rs",
      "crates/portcove-cli/src/main.rs",
    ]) {
      const mixed = planFor([input, cliPath]).plan.filter((entry) =>
        entry.id.startsWith("rust-tests:portcove-cli"),
      );
      assert.equal(mixed.length, 1);
      assert.equal(mixed[0].id, "rust-tests:portcove-cli");
      assert.ok(!mixed[0].args.includes("-E"));
      assert.ok(!mixed[0].args.includes("--impact-union"));
    }
  }
  const selection = classifyChanges([change(file)], { fileExists: allFilesExist });
  const plan = buildPlan(selection, { mergeBase: "base-sha", rustTestImpactMap: null });
  const cli = plan.find((entry) => entry.id === "rust-tests:portcove-cli:catalog-artwork-consumer");
  assert.ok(!cli.args.includes("-E"));
  const workspace = planFor(["Cargo.toml", file]).plan;
  assert.ok(ids(workspace).includes("rust-workspace-tests"));
  assert.ok(!ids(workspace).includes("rust-tests:portcove-cli:catalog-artwork-consumer"));
});

test("mapped renames and an unavailable impact contract use the broad package fallback", () => {
  const renamed = planFor([
    change("crates/portcove-core/src/source_report.rs", {
      status: "R100",
      previousPath: "crates/portcove-core/src/source_summary.rs",
    }),
  ]).plan;
  assert.ok(ids(renamed).includes("rust-tests:portcove-core"));
  assert.ok(!ids(renamed).some((id) => id.endsWith(":source-inspection")));

  const selection = classifyChanges([change("crates/portcove-core/src/source_report.rs")], {
    fileExists: allFilesExist,
  });
  const unavailable = buildPlan(selection, {
    mergeBase: "base-sha",
    rustTestImpactMap: null,
    rustTestImpactLoadError: "impact map could not be read",
  });
  const tests = unavailable.find((entry) => entry.id === "rust-tests:portcove-core");
  assert.ok(tests);
  assert.match(tests.reason, /complete portcove-core test inventory/u);
  assert.match(tests.reason, /impact map could not be read/u);
});

test("bin-only Rust packages do not schedule an invalid doctest command", () => {
  const { plan } = planFor(["crates/portcove-cli/src/main.rs"]);
  assert.ok(ids(plan).includes("rust-tests:portcove-cli"));
  assert.ok(!ids(plan).includes("rust-docs:portcove-cli"));
});

test("doctest capability comes from Cargo target metadata", () => {
  const packages = packagesWithDoctests({
    packages: [
      { name: "library", targets: [{ kind: ["lib"], doctest: true }] },
      { name: "binary", targets: [{ kind: ["bin"], doctest: false }] },
    ],
  });
  assert.deepEqual([...packages], ["library"]);
});

test("Clippy owns equivalent Rust compilation before the broad workspace test fallback", () => {
  const { plan } = planFor(["Cargo.toml"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "toml-format",
    "rustfmt",
    "node-tests",
    "rust-workspace-clippy",
    "dependency-policy",
    "rust-workspace-tests",
  ]);
});

test("supported local Rust compilation and tests acquire admission before starting work", () => {
  const focused = planFor(["crates/portcove-core/src/database.rs"]).plan;
  assert.ok(!ids(focused).includes("rust-check:portcove-core"));
  for (const id of ["rust-clippy:portcove-core", "rust-docs:portcove-core"]) {
    const entry = focused.find((candidate) => candidate.id === id);
    assert.ok(entry, `missing ${id}`);
    assert.equal(entry.executable, process.execPath);
    assert.deepEqual(entry.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--guard-command"]);
  }
  const focusedTests = focused.find((candidate) => candidate.id === "rust-tests:portcove-core");
  assert.ok(focusedTests);
  assert.equal(focusedTests.executable, process.execPath);
  assert.deepEqual(focusedTests.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--locked"]);

  const workspace = planFor(["Cargo.toml"]).plan;
  assert.ok(!ids(workspace).includes("rust-workspace-check"));
  for (const id of ["rust-workspace-clippy"]) {
    const entry = workspace.find((candidate) => candidate.id === id);
    assert.ok(entry, `missing ${id}`);
    assert.equal(entry.executable, process.execPath);
    assert.deepEqual(entry.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--guard-command"]);
  }
  const workspaceTests = workspace.find((candidate) => candidate.id === "rust-workspace-tests");
  assert.ok(workspaceTests);
  assert.equal(workspaceTests.executable, process.execPath);
  assert.deepEqual(workspaceTests.args.slice(0, 2), ["scripts/run-rust-tests.mjs", "--locked"]);
});

test("lockfile edits retain workspace compilation and policy while CI owns dependency-wide tests", () => {
  const { plan } = planFor(["Cargo.lock"]);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "rustfmt",
    "rust-workspace-clippy",
    "dependency-policy",
  ]);
  const mixed = planFor(["Cargo.lock", "apps/desktop/src-tauri/Cargo.toml"]).plan;
  assert.ok(ids(mixed).includes("rust-tests:portcove-desktop"));
  assert.ok(!ids(mixed).includes("rust-workspace-tests"));
  assert.ok(!ids(mixed).includes("rust-tests:portcove-core"));
  assert.ok(!ids(mixed).includes("rust-clippy:portcove-desktop"));
  for (const root of ["Cargo.toml", "rust-toolchain.toml", "deny.toml", ".config/nextest.toml"]) {
    assert.ok(ids(planFor(["Cargo.lock", root]).plan).includes("rust-workspace-tests"), root);
  }
  assert.ok(
    ids(planFor([{ path: "Cargo.lock", status: "D" }]).plan).includes("rust-workspace-tests"),
  );
});

test("UI sources build, lint, and run import-related tests", () => {
  const { selection, plan } = planFor(["apps/desktop/src/view-model.ts"]);
  assert.equal(selection.uiFullTests, false);
  assert.equal(selection.fallow, true);
  assert.deepEqual(ids(plan), [
    "diff-check",
    "oxfmt",
    "ui-build",
    "ui-oxlint",
    "ui-related-tests",
    "ui-related-durations",
    "ui-browser-tests",
    "ui-theme-copy",
    "ui-copy",
    "fallow",
  ]);
  const uiBuild = plan.find((entry) => entry.id === "ui-build");
  assert.equal(uiBuild.executable, "corepack");
  assert.equal(uiBuild.args[0], "pnpm");
  const durations = plan.find((entry) => entry.id === "ui-related-durations");
  assert.ok(durations.args.includes("--allow-empty"));
});

test("browser composition, transport, and config changes select the real-browser stage", () => {
  for (const file of [
    "apps/desktop/src/browser/adoption.browser.test.tsx",
    "apps/desktop/src/components/AdoptionModal.tsx",
    "apps/desktop/src/components/ui.tsx",
    "apps/desktop/src/features/installation/use-installation-planning.ts",
    "apps/desktop/src/shared/concurrency-state.ts",
    "apps/desktop/src/components/ui/dialog.tsx",
    "apps/desktop/src/api.ts",
    "apps/desktop/src/view-model.ts",
    "apps/desktop/vitest.browser.config.ts",
    "apps/desktop/scripts/browser-runtime.mjs",
    "apps/desktop/package.json",
    "pnpm-lock.yaml",
  ]) {
    const { selection, plan } = planFor([file]);
    assert.deepEqual([...selection.unknown], [], file);
    assert.equal(selection.browser, true, file);
    assert.ok(ids(plan).includes("ui-browser-tests"), file);
  }
  const { selection, plan } = planFor(["apps/desktop/src/artwork-cache.ts"]);
  assert.equal(selection.browser, false);
  assert.ok(!ids(plan).includes("ui-browser-tests"));
});

test("frontend script and test changes retain the same analyzer as frontend source", () => {
  for (const path of [
    "apps/desktop/scripts/desktop-install-fixture.test.mjs",
    "apps/desktop/scripts/desktop-install-fixture.mjs",
    "apps/desktop/test/process-fixture.test.mjs",
  ]) {
    for (const status of ["A", "M", "D"]) {
      const { plan } = planFor([{ status, path }]);
      assert.ok(ids(plan).includes("fallow"), `${status} ${path}`);
      assert.equal(storageScopeForPlan(plan), "frontend");
      assert.ok(!ids(plan).some((id) => id.startsWith("rust-")));
    }
  }
  const renamed = planFor([
    {
      status: "R100",
      previousPath: "apps/desktop/scripts/desktop-install-fixture.test.mjs",
      path: "docs/former-fixture.md",
    },
  ]).plan;
  assert.ok(ids(renamed).includes("fallow"));
  assert.ok(!ids(planFor(["docs/README.md"]).plan).includes("fallow"));
});

test("frontend configuration changes use the complete small UI suite", () => {
  for (const path of ["package.json", "pnpm-lock.yaml"]) {
    const { selection, plan } = planFor([path]);
    assert.equal(selection.uiFullTests, true, path);
    assert.equal(selection.fallow, true, path);
    assert.ok(selection.nodeTests.has("scripts/check-fallow-report.test.mjs"), path);
    assert.ok(ids(plan).includes("ui-tests"), path);
    assert.ok(ids(plan).includes("fallow"), path);
    assert.ok(!ids(plan).includes("ui-related-tests"), path);
    assert.ok(!ids(plan).includes("ui-theme-copy"), path);
    assert.ok(!ids(plan).includes("ui-copy"), path);
  }
  const { selection } = planFor(["package.json"]);
  assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mjs"));
  const scripts = JSON.parse(
    readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  ).scripts;
  const aggregateCommands = scripts.test.split(/\s*&&\s*/u);
  assert.ok(aggregateCommands.includes("node scripts/check-theme.mjs"));
  assert.ok(aggregateCommands.includes("node scripts/check-copy.mjs"));
});

for (const manifest of ["package.json", "apps/desktop/package.json"]) {
  test(`${manifest} selects its direct workflow pin and script contract`, () => {
    const { selection, plan } = planFor([manifest]);
    assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mjs"));
    const node = plan.find((entry) => entry.id === "node-tests");
    assert.ok(node.args.includes("scripts/ci-workflow.test.mjs"));
    assert.ok(selection.nodeTests.has("scripts/local-validation.test.mjs"));
    assert.equal(selection.ui, true);
    assert.equal(selection.uiFullTests, true);
    assert.equal(selection.fallow, manifest === "package.json");
    assert.equal(selection.browser, manifest === "apps/desktop/package.json");
    assert.ok(ids(plan).includes("ui-tests"));
    if (manifest === "package.json") {
      assert.ok(selection.nodeTests.has("scripts/dependency-automation.test.mjs"));
      assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mjs"));
      assert.ok(ids(plan).includes("fallow"));
    } else {
      assert.ok(ids(plan).includes("ui-browser-tests"));
    }
  });
}

test("manifest consumers coalesce in mixed plans without widening lock-only contracts", () => {
  const { selection, plan } = planFor([
    "package.json",
    "apps/desktop/package.json",
    "scripts/quality-tools.mjs",
  ]);
  assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/quality-tools.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mjs"));
  const node = plan.find((entry) => entry.id === "node-tests");
  assert.equal(node.args.filter((arg) => arg === "scripts/ci-workflow.test.mjs").length, 1);
  assert.ok(ids(plan).includes("ui-tests"));
  assert.ok(ids(plan).includes("ui-browser-tests"));
  assert.ok(ids(plan).includes("fallow"));
  for (const lock of ["pnpm-lock.yaml", "apps/desktop/pnpm-lock.yaml"]) {
    const selected = planFor([lock]);
    assert.equal(selected.selection.nodeTests.has("scripts/ci-workflow.test.mjs"), false);
    assert.ok(selected.selection.nodeTests.has("scripts/dependency-automation.test.mjs"));
  }
});

test("localization configuration changes use the complete UI and i18n suite", () => {
  for (const path of ["apps/desktop/i18next.config.ts", "apps/desktop/i18next.invalid.config.ts"]) {
    const { selection, plan } = planFor([path]);
    assert.equal(selection.uiFullTests, true, path);
    assert.deepEqual([...selection.unknown], [], path);
    assert.ok(ids(plan).includes("ui-tests"), path);
  }
});

test("retired desktop-local pnpm authorities remain owned on deletion", () => {
  for (const path of ["apps/desktop/pnpm-lock.yaml", "apps/desktop/pnpm-workspace.yaml"]) {
    const { selection, plan } = planFor([{ status: "D", path }]);
    assert.equal(selection.uiFullTests, true, path);
    assert.deepEqual([...selection.unknown], [], path);
    assert.ok(ids(plan).includes("ui-tests"), path);
    assert.ok(
      plan.some(
        (entry) =>
          entry.id === "node-tests" &&
          entry.args.includes("scripts/dependency-automation.test.mjs"),
      ),
      path,
    );
  }
});

test("the exact Fallow boundary configuration selects the complete UI suite", () => {
  for (const status of ["M", "A", "D"]) {
    const { selection, plan } = planFor([{ status, path: "apps/desktop/.fallowrc.json" }]);
    assert.equal(selection.uiFullTests, true);
    assert.equal(selection.fallow, true);
    assert.ok(ids(plan).includes("ui-tests"));
    assert.ok(ids(plan).includes("fallow"));
    assert.ok(!ids(plan).includes("ui-related-tests"));
    assert.deepEqual([...selection.unknown], []);
  }
});

test("command-identical obligations execute once while retaining every selection reason", () => {
  const duplicate = {
    id: "second-lint",
    reason: "second owner",
    executable: "lint",
    args: ["--all"],
    cwd: ".",
    obligation: "complete-lint",
  };
  const plan = deduplicateCommands([
    { ...duplicate, id: "first-lint", reason: "first owner" },
    duplicate,
    { id: "tests", reason: "tests", executable: "test", args: [], cwd: "." },
  ]);
  assert.deepEqual(ids(plan), ["first-lint", "tests"]);
  assert.deepEqual(plan[0].selectedIds, ["first-lint", "second-lint"]);
  assert.match(plan[0].reason, /first owner; also selected as second-lint: second owner/u);

  const seen = [];
  executePlan(plan, {
    spawn(executable) {
      seen.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(seen, ["lint", "test"]);
});

test("command-identical stages with different evidence roles remain distinct", () => {
  const plan = deduplicateCommands([
    {
      id: "first",
      reason: "first role",
      executable: "same",
      args: [],
      cwd: ".",
      obligation: "first-evidence",
    },
    {
      id: "second",
      reason: "second role",
      executable: "same",
      args: [],
      cwd: ".",
      obligation: "second-evidence",
    },
  ]);
  assert.deepEqual(ids(plan), ["first", "second"]);
});

test("a reused stage id cannot hide conflicting commands or obligations", () => {
  assert.throws(
    () =>
      deduplicateCommands([
        { id: "same", reason: "one", executable: "one", args: [], cwd: "." },
        { id: "same", reason: "two", executable: "two", args: [], cwd: "." },
      ]),
    /selected conflicting commands or obligations/u,
  );
  assert.throws(
    () =>
      deduplicateCommands([
        {
          id: "same",
          reason: "compile",
          executable: "same",
          args: [],
          cwd: ".",
          obligation: "compile",
        },
        {
          id: "same",
          reason: "security",
          executable: "same",
          args: [],
          cwd: ".",
          obligation: "security",
        },
      ]),
    /selected conflicting commands or obligations/u,
  );
});

test("an exactly repeated stage id retains every selection reason", () => {
  const plan = deduplicateCommands([
    { id: "same", reason: "first", executable: "same", args: [], cwd: "." },
    { id: "same", reason: "second", executable: "same", args: [], cwd: "." },
  ]);
  assert.deepEqual(ids(plan), ["same"]);
  assert.deepEqual(plan[0].selectedIds, ["same"]);
  assert.match(plan[0].reason, /first; also selected as same: second/u);
});

test("Oxc configuration changes retain formatting, lint, UI, fixture, and workflow contracts", () => {
  for (const config of [".oxfmtrc.json", ".oxlintrc.json"]) {
    const { selection, plan } = planFor([config]);
    const selected = ids(plan);
    assert.equal(selection.uiFullTests, true);
    assert.ok(selected.includes("oxfmt"));
    assert.ok(selected.includes("ui-build"));
    assert.ok(selected.includes("ui-oxlint"));
    assert.ok(selected.includes("ui-tests"));
    assert.ok(selected.includes("lint-tool-fixtures"));
    assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mjs"));
    const fixtures = plan.find((entry) => entry.id === "lint-tool-fixtures");
    assert.ok(fixtures.args.includes(config === ".oxfmtrc.json" ? "oxfmt" : "oxlint"));
  }
});

test("lint fixture harness changes execute every maintained behavioral fixture", () => {
  const { plan } = planFor(["scripts/lint-tools.integration.mjs"]);
  const fixtures = plan.find((entry) => entry.id === "lint-tool-fixtures");
  assert.ok(fixtures);
  assert.deepEqual(fixtures.args, [
    "scripts/lint-tools.integration.mjs",
    "actionlint",
    "oxfmt",
    "oxlint",
    "psscriptanalyzer",
    "ruff",
    "shellcheck",
    "stylelint",
  ]);
});

test("transport changes select both language scopes and contract comparators", () => {
  const { selection, plan } = planFor([
    "apps/desktop/src/transport-types.generated.d.ts",
    "crates/portcove-core/src/types.rs",
  ]);
  assert.equal(selection.transport, true);
  assert.ok(selection.packages.has("portcove-core"));
  assert.ok(selection.nodeTests.has("scripts/transport-types.test.mjs"));
  assert.ok(ids(plan).includes("transport-export"));
  assert.ok(ids(plan).includes("transport-policy"));
});

test("workflow and justfile changes select exact contract tests and actionlint", () => {
  const { selection, plan } = planFor([".github/workflows/ci.yml", "justfile"]);
  assert.ok(selection.nodeTests.has("scripts/ci-workflow.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/dev-storage.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mjs"));
  assert.ok(ids(plan).includes("actionlint"));
  const nodeTests = plan.find((entry) => entry.id === "node-tests");
  assert.ok(nodeTests.args.includes("--test-reporter=./scripts/test-duration-reporter.mjs"));
});

test("changed Node implementations select sibling tests and syntax checks", () => {
  const { selection, plan } = planFor(["scripts/ci-health.mjs"]);
  assert.ok(selection.nodeTests.has("scripts/ci-health.test.mjs"));
  assert.ok(selection.nodeSyntax.has("scripts/ci-health.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/ci-health.mjs"));
  assert.ok(ids(plan).includes("oxlint"));
  assert.ok(ids(plan).includes("node-tests"));
});

test("competing Windows package lifecycle fixtures run serially", () => {
  const { plan } = planFor([
    "scripts/updater-artifact-inventory.test.mjs",
    "scripts/windows-qualification-session.integration.test.mjs",
  ]);
  const nodeTests = plan.find((entry) => entry.id === "node-tests");
  assert.ok(nodeTests);
  assert.ok(nodeTests.args.includes("--test-concurrency=1"));
  assert.match(nodeTests.reason, /serialize competing Windows package lifecycle fixtures/u);
});

test("heavy Rust runner and lock changes select both guarded execution contracts", () => {
  const { selection, plan } = planFor([
    "scripts/heavy-rust-test-lock.mjs",
    "scripts/run-rust-tests.mjs",
    "scripts/rust-support-cache.mjs",
    "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  ]);
  assert.ok(selection.nodeTests.has("scripts/heavy-rust-test-lock.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/run-rust-tests.test.mjs"));
  assert.ok(selection.nodeTests.has("scripts/rust-support-cache.test.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/heavy-rust-test-lock.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/run-rust-tests.mjs"));
  assert.ok(ids(plan).includes("node-syntax:scripts/rust-support-cache.mjs"));
  assert.ok(ids(plan).includes("node-tests"));

  const fixtureOnly = planFor(["scripts/fixtures/windows-process-tree-supervisor.rs.txt"]);
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/heavy-rust-test-lock.test.mjs"));
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/run-rust-tests.test.mjs"));
  assert.ok(fixtureOnly.selection.nodeTests.has("scripts/rust-support-cache.test.mjs"));

  const hostFixtureOnly = planFor(["crates/portcove-core/src/testdata/host_tool_probe.rs.txt"]);
  assert.ok(hostFixtureOnly.selection.nodeTests.has("scripts/run-rust-tests.test.mjs"));
  assert.ok(hostFixtureOnly.selection.nodeTests.has("scripts/rust-support-cache.test.mjs"));
});

test("changed shell scripts run shellcheck across the maintained shell set", () => {
  const { plan } = planFor(["scripts/install-linux-desktop-prerequisites.sh"]);
  const shellLint = plan.find((entry) => entry.id === "shell-lint");
  assert.ok(shellLint);
  assert.ok(shellLint.args.includes("scripts/install-linux-desktop-prerequisites.sh"));
  assert.ok(shellLint.args.includes("scripts/bootstrap-quality-tools.sh"));
  assert.ok(shellLint.args.includes("scripts/test-linux-package-ownership.sh"));
});

test("release-script changes select deterministic release contracts without packaged qualification", () => {
  const { selection, plan } = planFor(["scripts/release-preflight.ps1"]);
  for (const contract of [
    "scripts/check-release-metadata.test.mjs",
    "scripts/release-package-policy.test.mjs",
    "scripts/release-coordinator.test.mjs",
    "scripts/release-workflow.test.mjs",
    "scripts/windows-qualification-session.test.mjs",
    "scripts/ci-workflow.test.mjs",
  ])
    assert.ok(selection.nodeTests.has(contract));
  const rendered = plan.map(formatCommand).join("\n");
  assert.ok(!rendered.includes("windows-qualification-session.integration.test.mjs"));
  assert.ok(!rendered.includes("desktop-test"));
});

test("bootstrap manifest changes select cache, doctor, and quality contracts", () => {
  const { selection, plan } = planFor([".config/tool-bootstrap.json"]);
  assert.deepEqual([...selection.unknown], []);
  for (const file of [
    "scripts/tool-cache.test.mjs",
    "scripts/quality-tools.test.mjs",
    "scripts/dev-doctor.test.mjs",
  ])
    assert.ok(selection.nodeTests.has(file));
  assert.ok(ids(plan).includes("node-tests"));
});

test("renames classify both the old and new ownership paths", () => {
  const { selection, plan } = planFor([
    change("docs/moved.md", {
      status: "R100",
      previousPath: "crates/portcove-cli/src/removed.rs",
    }),
  ]);
  assert.ok(selection.scopes.has("documentation"));
  assert.ok(selection.packages.has("portcove-cli"));
  assert.ok(selection.oxfmtFiles.has("docs/moved.md"));
  assert.ok(!selection.oxfmtFiles.has("crates/portcove-cli/src/removed.rs"));
  assert.ok(!plan.map(formatCommand).join("\n").includes("removed.rs"));
});

test("deleted files affect scope without becoming command arguments", () => {
  const { selection, plan } = planFor([{ status: "D", path: "scripts/retired-tool.test.mjs" }]);
  assert.ok(selection.scopes.has("tooling"));
  assert.ok(!selection.nodeTests.has("scripts/retired-tool.test.mjs"));
  assert.ok(!plan.map(formatCommand).join("\n").includes("retired-tool"));
});

test("retired frontend tool configuration remains owned after deletion", () => {
  const retired = [
    ".prettierignore",
    "prettier.config.mjs",
    "eslint.config.mjs",
    "apps/desktop/eslint.config.mjs",
  ];
  const selection = classifyChanges(
    retired.map((path) => ({ status: "D", path })),
    { fileExists: () => false },
  );
  assert.deepEqual([...selection.unknown], []);
  assert.equal(selection.ui, true);
  assert.equal(selection.uiFullTests, true);
});

test("retired GitHub policy JSON remains owned without a file-specific tombstone", () => {
  const selection = classifyChanges([{ status: "D", path: ".github/retired-policy.json" }], {
    fileExists: () => false,
  });
  assert.deepEqual([...selection.unknown], []);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/ci-workflow.test.mjs",
    "scripts/repository-settings.test.mjs",
    "scripts/validation-plan.test.mjs",
  ]);
});

test("retired root TOML policy remains owned without a file-specific tombstone", () => {
  const selection = classifyChanges([{ status: "D", path: "retired-policy.toml" }], {
    fileExists: () => false,
  });
  assert.deepEqual([...selection.unknown], []);
  assert.equal(selection.toml, true);
  assert.deepEqual([...selection.nodeTests].sort(), [
    "scripts/local-validation.test.mjs",
    "scripts/validation-plan.test.mjs",
  ]);
});

test("non-ignored untracked files use the same deterministic mapping", () => {
  const selection = classifyChanges([{ status: "?", path: "scripts/local-validation.test.mjs" }], {
    fileExists: allFilesExist,
  });
  assert.ok(selection.nodeTests.has("scripts/local-validation.test.mjs"));
});

test("every tracked repository path has an explicit local selection owner", () => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: new URL("../", import.meta.url),
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const selection = classifyChanges(files.map((path) => ({ status: "M", path })));
  assert.deepEqual([...selection.unknown].sort(), []);
});

test("the exact development scenario entry selects full UI coverage without admitting other HTML", () => {
  for (const status of ["M", "A", "D"]) {
    const { selection } = planFor([{ status, path: "apps/desktop/scenarios.html" }]);
    assert.equal(selection.ui, true);
    assert.equal(selection.uiFullTests, true);
    assert.equal(selection.unknown.size, 0);
  }
  const renamed = classifyChanges(
    [
      {
        status: "R100",
        previousPath: "apps/desktop/scenarios.html",
        path: "apps/desktop/unknown.html",
      },
    ],
    { fileExists: allFilesExist },
  );
  assert.equal(renamed.uiFullTests, true);
  assert.ok(renamed.unknown.has("apps/desktop/unknown.html"));
});

test("design-system configuration and native compatibility tests have UI owners", () => {
  const configuration = planFor(["apps/desktop/components.json"]).selection;
  assert.equal(configuration.ui, true);
  assert.equal(configuration.uiFullTests, true);
  assert.equal(configuration.unknown.size, 0);

  const nativeTest = planFor(["apps/desktop/test/native-compatibility.mjs"]).selection;
  assert.equal(nativeTest.ui, true);
  assert.ok(nativeTest.uiRelatedFiles.has("apps/desktop/test/native-compatibility.mjs"));
  assert.equal(nativeTest.unknown.size, 0);
});

function fallbackContext(changes) {
  const headSha = "a".repeat(40);
  const mergeBase = "b".repeat(40);
  return {
    changes,
    headSha,
    baseSha: mergeBase,
    mergeBase,
    validationPlan: buildValidationPlan({
      changes,
      eventName: "pull_request",
      base: mergeBase,
      mergeBase,
      head: headSha,
      checkout: headSha,
    }),
  };
}

test("safe complete unknown input impact selects one fresh full-debug fallback rather than requiring another selector", () => {
  for (const changes of [
    [change("new-subsystem/input.bin", { oldMode: "100644", newMode: "100644" })],
    [change("new-subsystem/new.dat", { status: "A", oldMode: "000000", newMode: "100644" })],
    [change("new-subsystem/local.bin", { status: "?", oldMode: "000000", newMode: "100644" })],
    [change("new-subsystem/old.txt", { status: "D", oldMode: "100644", newMode: "000000" })],
    [
      change("new-subsystem/new.png", {
        status: "R100",
        previousPath: "old-input/image.png",
        oldMode: "100644",
        newMode: "100644",
      }),
    ],
    [
      change("new-subsystem/input.bin", { oldMode: "100644", newMode: "100644" }),
      change("crates/portcove-core/src/adapter.rs", { oldMode: "100644", newMode: "100644" }),
    ],
    [
      change("README.md", { oldMode: "100644", newMode: "100644" }),
      change("new-subsystem/input.bin", { oldMode: "100644", newMode: "100644" }),
    ],
  ]) {
    const plan = buildPlan(
      classifyChanges(changes, { fileExists: allFilesExist }),
      fallbackContext(changes),
    );
    assert.equal(plan[0].id, "diff-check");
    assert.equal(plan.at(-1).id, "conservative-audit");
    assert.deepEqual(plan.at(-1).args, ["audit", "--fresh"]);
    if (changes.some(({ path }) => path.endsWith("adapter.rs")))
      assert.ok(ids(plan).includes("rust-clippy:portcove-core"));
    assert.equal(storageScopeForPlan(plan), "all");
  }
});

test("untracked modes preserve executable/type facts rather than treating every non-symlink as regular", () => {
  const file = { isSymbolicLink: () => false, isFile: () => true, mode: 0o100755 };
  assert.equal(untrackedFileMode(file, "linux"), "100755");
  assert.equal(untrackedFileMode(file, "win32"), "100644");
  assert.equal(untrackedFileMode({ ...file, mode: 0o100644 }, "linux"), "100644");
  assert.equal(untrackedFileMode({ isSymbolicLink: () => true }, "linux"), "120000");
  assert.throws(
    () => untrackedFileMode({ isSymbolicLink: () => false, isFile: () => false }),
    /non-regular/,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "portcove-untracked-mode-"));
  try {
    assert.throws(() => untrackedFileMode(lstatSync(directory)), /non-regular/);
    const input = path.join(directory, "input.bin");
    writeFileSync(input, "untracked data");
    chmodSync(input, 0o644);
    assert.equal(untrackedFileMode(lstatSync(input)), "100644");
    if (process.platform !== "win32") {
      chmodSync(input, 0o755);
      assert.equal(untrackedFileMode(lstatSync(input)), "100755");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown fallback preserves known specialist consumers rather than assuming aggregate equivalence", () => {
  const changes = [
    change("new-subsystem/input.bin", { oldMode: "100644", newMode: "100644" }),
    change("integrations/playnite/PortcoveLibrary/Library.cs", {
      oldMode: "100644",
      newMode: "100644",
    }),
  ];
  const selection = classifyChanges(changes, { fileExists: allFilesExist });
  const ordinary = buildPlan({ ...selection, unknown: new Set() }, fallbackContext(changes));
  const fallback = buildPlan(selection, fallbackContext(changes));
  assert.deepEqual(fallback.slice(0, -1), ordinary);
  assert.ok(ids(fallback).includes("playnite-contract"));
  assert.equal(fallback.at(-1).id, "conservative-audit");
});

test("unknown impact cannot use incomplete, stale, non-regular or untrusted executable/configuration discovery", () => {
  const ordinary = change("new-subsystem/input.bin", { oldMode: "100644", newMode: "100644" });
  const selection = classifyChanges([ordinary], { fileExists: allFilesExist });
  assert.throws(() => buildPlan(selection), /validation plan/);
  for (const altered of [
    { headSha: "c".repeat(40) },
    { baseSha: "c".repeat(40) },
    { mergeBase: "c".repeat(40) },
    { changes: [] },
    { changes: [{ ...ordinary, oldMode: undefined }] },
    { changes: [{ ...ordinary, oldMode: "000000" }] },
    { changes: [{ ...ordinary, newMode: "100755" }] },
    { changes: [{ ...ordinary, newMode: "120000" }] },
    { changes: [{ ...ordinary, newMode: "160000" }] },
    { changes: [{ ...ordinary, status: "C100" }] },
    { changes: [{ ...ordinary, path: "other/input.bin" }] },
  ])
    assert.throws(() => buildPlan(selection, { ...fallbackContext([ordinary]), ...altered }));
  const failed = {
    ...fallbackContext([ordinary]),
    validationPlan: buildValidationPlan({
      changes: [ordinary],
      checkout: "a".repeat(40),
      discovery: "failed",
      blockedReason: "missing comparison authority",
    }),
  };
  assert.throws(() => buildPlan(selection, failed), /complete bound/);
  const wrongCheckout = {
    ...fallbackContext([ordinary]),
    validationPlan: buildValidationPlan({
      changes: [ordinary],
      eventName: "pull_request",
      base: "b".repeat(40),
      mergeBase: "b".repeat(40),
      head: "a".repeat(40),
      checkout: "c".repeat(40),
    }),
  };
  assert.throws(() => buildPlan(selection, wrongCheckout), /complete bound/);
  const executable = [
    change("new-subsystem/local.bin", {
      status: "?",
      oldMode: "000000",
      newMode: untrackedFileMode(
        { isSymbolicLink: () => false, isFile: () => true, mode: 0o100755 },
        "linux",
      ),
    }),
  ];
  assert.throws(
    () =>
      buildPlan(
        classifyChanges(executable, { fileExists: allFilesExist }),
        fallbackContext(executable),
      ),
    /regular-file modes/,
  );
  for (const file of [
    "new-subsystem/program.rs",
    "new-subsystem/script.py",
    "new-subsystem/settings.json",
    ".untrusted/input.bin",
  ]) {
    const changes = [change(file, { oldMode: "100644", newMode: "100644" })];
    assert.throws(
      () =>
        buildPlan(
          classifyChanges(changes, { fileExists: allFilesExist }),
          fallbackContext(changes),
        ),
      /ownership blocks/,
    );
  }
  assert.throws(() => fallbackContext([change("../input.bin")]), /path/);
});

test("ordinary plans never invoke aggregate, deep, release, installer, or native gates", () => {
  const { plan } = planFor([
    "docs/QUALITY.md",
    "crates/portcove-core/src/database.rs",
    "apps/desktop/src/view-model.ts",
    "scripts/ci-health.mjs",
    ".github/workflows/ci.yml",
  ]);
  const rendered = plan.map(formatCommand).join("\n");
  for (const forbidden of [
    "just check",
    "just audit",
    "just deep",
    "release-preflight",
    "windows-qualification-session.integration",
    "desktop-test",
  ]) {
    assert.ok(!rendered.includes(forbidden), `unexpected ${forbidden}`);
  }
});

test("focused wrappers require an explicit selection", () => {
  assert.throws(() => requireFocusedArguments("test-rust", []), /requires an explicit/);
  assert.throws(
    () => requireFocusedArguments("test-node", ["--test-name-pattern", "x"]),
    /requires an explicit/,
  );
  assert.doesNotThrow(() =>
    requireFocusedArguments("test-rust", ["-p", "portcove-core", "database::"]),
  );
});

test("execution stops on the first failing stage", () => {
  const seen = [];
  const plan = [
    { id: "one", reason: "first", executable: "one", args: [], cwd: "." },
    { id: "two", reason: "second", executable: "two", args: [], cwd: "." },
    { id: "three", reason: "third", executable: "three", args: [], cwd: "." },
  ];
  assert.throws(
    () =>
      executePlan(plan, {
        spawn(executable) {
          seen.push(executable);
          return { status: executable === "two" ? 7 : 0 };
        },
      }),
    /two failed with exit code 7/,
  );
  assert.deepEqual(seen, ["one", "two"]);
});

const receiptRuntime = Object.freeze({
  platform: "win32",
  architecture: "x64",
  osRelease: "test",
  node: "v24.21.0",
  git: "git test",
  just: "just test",
  rustc: "rustc test",
  cargo: "cargo test",
  cargoNextest: "nextest test",
  cargoShear: "shear test",
  rscheck: "rscheck test",
  aqua: "aqua test",
  powershell: "pwsh test",
  packageManager: "pnpm@12.4.1",
  packageManagerVersion: "12.4.1",
  environment: {},
});

function receiptInventory(repositoryIdentity = "repo-a") {
  const file = (filePath, domain, identity) => ({
    path: filePath,
    kind: "file",
    headBlob: identity,
    headMode: "100644",
    indexBlob: identity,
    indexMode: "100644",
    worktreeMode: "100644",
    gitBlob: identity,
    sha256: identity,
    domains: [domain],
    ambiguous: false,
  });
  return {
    head: "a".repeat(40),
    objectFormat: "sha1",
    files: [
      file("crates/portcove-core/src/lib.rs", "rust", "rust-a"),
      file("scripts/repository-settings.mjs", "repository", repositoryIdentity),
    ],
  };
}

test("Node receipt fingerprints include the domain of each selected test", () => {
  const stage = {
    id: "node-tests",
    reason: "selector contract",
    executable: process.execPath,
    args: ["--test", "scripts/rust-test-impact.test.mjs"],
    cwd: process.cwd(),
    obligation: "repository",
  };
  const first = receiptInventory();
  first.files.push({
    path: "scripts/rust-test-impact.mjs",
    kind: "file",
    headBlob: "impact-a",
    headMode: "100644",
    indexBlob: "impact-a",
    indexMode: "100644",
    worktreeMode: "100644",
    gitBlob: "impact-a",
    sha256: "impact-a",
    domains: ["development", "format"],
    ambiguous: false,
  });
  const second = structuredClone(first);
  second.files.at(-1).headBlob = "impact-b";
  second.files.at(-1).indexBlob = "impact-b";
  second.files.at(-1).gitBlob = "impact-b";
  second.files.at(-1).sha256 = "impact-b";

  assert.notEqual(
    fingerprintLocalStage(stage, first, receiptRuntime),
    fingerprintLocalStage(stage, second, receiptRuntime),
  );

  const syntaxStage = {
    ...stage,
    id: "node-syntax:scripts/rust-test-impact.mjs",
    args: ["--check", "scripts/rust-test-impact.mjs"],
  };
  assert.notEqual(
    fingerprintLocalStage(syntaxStage, first, receiptRuntime),
    fingerprintLocalStage(syntaxStage, second, receiptRuntime),
  );
});

test("local receipts reuse proven independent stages while repository-wide Oxlint reruns", (t) => {
  const receiptRoot = mkdtempSync(path.join(tmpdir(), "portcove-local-receipts-"));
  t.after(() => rmSync(receiptRoot, { recursive: true, force: true }));
  const plan = [
    {
      id: "rust-clippy:portcove-core",
      reason: "rust",
      executable: "cargo",
      args: ["clippy"],
      cwd: process.cwd(),
      obligation: "rust",
    },
    {
      id: "node-tests",
      reason: "tooling",
      executable: "node",
      args: ["--test", "scripts/repository-settings.test.mjs"],
      cwd: process.cwd(),
      obligation: "repository",
    },
    {
      id: "oxlint",
      reason: "lint",
      executable: "corepack",
      args: ["pnpm", "run", "lint:oxlint"],
      cwd: process.cwd(),
      obligation: "repository-oxlint",
    },
  ];
  const first = [];
  executePlanWithReceipts(plan, {
    receiptRoot,
    inventory: receiptInventory(),
    runtime: receiptRuntime,
    spawn(executable) {
      first.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(first, ["cargo", "node", "corepack"]);

  const second = [];
  const result = executePlanWithReceipts(plan, {
    receiptRoot,
    inventory: receiptInventory("repo-b"),
    runtime: receiptRuntime,
    spawn(executable) {
      second.push(executable);
      return { status: 0 };
    },
  });
  assert.deepEqual(second, ["node", "corepack"]);
  assert.equal(result.timings[0].status, "reused");
  assert.equal(result.timings[1].status, "executed");
  assert.equal(result.timings[2].status, "executed");
});

test("failed, interrupted, invalid, missing, and fresh local stages cannot claim reuse", (t) => {
  const receiptRoot = mkdtempSync(path.join(tmpdir(), "portcove-local-failure-"));
  t.after(() => rmSync(receiptRoot, { recursive: true, force: true }));
  const stage = {
    id: "node-tests",
    reason: "tooling",
    executable: "node",
    args: ["--test", "scripts/repository-settings.test.mjs"],
    cwd: process.cwd(),
    obligation: "repository",
  };
  assert.throws(
    () =>
      executePlanWithReceipts([stage], {
        receiptRoot,
        inventory: receiptInventory(),
        runtime: receiptRuntime,
        spawn: () => ({ status: 9 }),
      }),
    /failed with exit code 9/u,
  );
  let executions = 0;
  const run = (options = {}) =>
    executePlanWithReceipts([stage], {
      receiptRoot,
      inventory: receiptInventory(),
      runtime: receiptRuntime,
      spawn: () => {
        executions += 1;
        return { status: 0 };
      },
      ...options,
    });
  run();
  assert.equal(executions, 1);
  run();
  assert.equal(executions, 1);

  const receiptFile = readdirSync(receiptRoot, { recursive: true })
    .map(String)
    .find((file) => file.endsWith(".json"));
  assert.ok(receiptFile);
  writeFileSync(path.join(receiptRoot, receiptFile), "{}\n");
  run();
  assert.equal(executions, 2);
  run({ fresh: true });
  assert.equal(executions, 3);
});

test("selected validation uses the shared capability authority without narrowing Node obligations", async () => {
  const { selectedPrerequisites } = await import("./dev-doctor.mjs");
  const { validationCapabilities, profileCapabilities } =
    await import("./development-capabilities.mjs");
  assert.equal(selectedPrerequisites, validationCapabilities);
  assert.ok(!profileCapabilities("core").includes("node"));
  assert.deepEqual(selectedPrerequisites({ id: "rust-tests:portcove-cli" }), [
    "node",
    "rustc",
    "cargo",
    "cargo-nextest",
  ]);
  assert.deepEqual(selectedPrerequisites({ id: "oxfmt" }), [
    "node",
    "pnpm",
    "frontend-dependencies",
  ]);
});

test("containment inputs select every execution contract and preserve unknown refusal", () => {
  const consumers = [
    "scripts/heavy-rust-test-lock.test.mjs",
    "scripts/run-rust-tests.test.mjs",
    "scripts/rust-support-cache.test.mjs",
    "scripts/rust-test-tree-supervisor.test.mjs",
  ];
  const inputs = [
    ...consumers,
    ...consumers.map((file) => file.replace(".test.mjs", ".mjs")),
    "scripts/fixtures/linux-process-tree-reaper.rs.txt",
    "scripts/fixtures/windows-process-tree-supervisor.rs.txt",
  ];
  const future = "new-subsystem/future-supervisor.mjs";
  for (const input of inputs) {
    for (const entry of [
      change(input),
      change(input, { status: "A" }),
      change(input, { status: "D" }),
      change(future, { status: "R100", previousPath: input, oldMode: "100644", newMode: "100644" }),
      change(input, { status: "R100", previousPath: future, oldMode: "100644", newMode: "100644" }),
    ]) {
      const selection = classifyChanges([entry], { fileExists: allFilesExist });
      for (const consumer of consumers)
        assert.ok(selection.nodeTests.has(consumer), `${input} -> ${consumer}`);
      if (entry.previousPath) {
        assert.ok(selection.unknown.has(future));
        // Mixed unknown/platform paths may be refused by the unchanged bound
        // inventory validator before the executable-ownership guard. Neither
        // refusal permits the renamed executable to run.
        assert.throws(
          () => buildPlan(selection, fallbackContext([entry])),
          /unknown executable or configuration ownership|routed validation plan does not match its path inventory/,
        );
      } else {
        const selected = buildPlan(selection);
        const contracts = selected.find((command) => command.id === "node-tests");
        for (const consumer of consumers) assert.ok(contracts.args.includes(consumer));
        if (entry.status === "D") assert.ok(!selection.nodeSyntax.has(input));
      }
    }
  }
  const mixed = planFor([...inputs, "docs/QUALITY.md"]);
  assert.ok(mixed.selection.nodeTests.has("scripts/repository-settings.test.mjs"));
  for (const consumer of consumers) assert.ok(mixed.selection.nodeTests.has(consumer));
  const unknown = [change(future, { oldMode: "100644", newMode: "100644" })];
  assert.throws(
    () => buildPlan(classifyChanges(unknown), fallbackContext(unknown)),
    /unknown executable or configuration ownership/,
  );
});

test("containment selector changes retain their dependent audit and hosted contracts", () => {
  const consumers = [
    "scripts/validation-plan.test.mjs",
    "scripts/local-validation.test.mjs",
    "scripts/audit.test.mjs",
    "scripts/select-ci-plan.test.mjs",
  ];
  for (const input of [
    "scripts/validation-plan.mjs",
    "scripts/validation-plan.test.mjs",
    "scripts/local-validation.mjs",
    "scripts/local-validation.test.mjs",
  ]) {
    for (const status of ["M", "D"]) {
      const { selection } = planFor([change(input, { status })]);
      for (const consumer of consumers)
        assert.ok(selection.nodeTests.has(consumer), `${input} -> ${consumer}`);
    }
  }
});
