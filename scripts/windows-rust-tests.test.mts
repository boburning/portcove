import qualificationOracle from "./fixtures/windows-qualification-selection.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";
import { assertNoDuplicateRustSetup } from "./ci-workflow-fixture.mts";
import { workflowJob } from "./ci-workflow-fixture.mts";
import { workflowStep } from "./ci-workflow-fixture.mts";
import { rustTests } from "./ci-workflow-fixture.mts";
import { rustWorkspaceTests } from "./ci-workflow-fixture.mts";
import { rustClippy } from "./ci-workflow-fixture.mts";
import { windowsStorage } from "./ci-workflow-fixture.mts";
import { rust } from "./ci-workflow-fixture.mts";
import { rustQuality } from "./ci-workflow-fixture.mts";
import assert from "node:assert/strict";

import { readFile, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  partitionWindowsRustTests,
  runnableWindowsRustTests,
  validateRustTimingHints,
  validateWindowsRustManifest,
  validateWindowsQualificationCoreManifest,
  windowsPartitionConfig,
  readWindowsQualificationCorePacket,
  qualificationBinaryListDigest,
} from "./windows-rust-tests.mts";
import oracle from "./fixtures/windows-qualification-selection.json" with { type: "json" };
import {
  qualificationCoreWorkers,
  qualificationCoreScope,
  qualificationCoreProfile,
  reusedQualificationArguments,
  nextestListArguments,
} from "./windows-qualification-rust.mts";

void test("qualification Core retains the frozen pre-change executable argv for every worker and phase", () => {
  assert.equal(oracle.baseline, "34954b7358c4d8c73e4ec5b5dd2cbe7fdf6376dc");
  assert.equal(oracle.profile, qualificationCoreProfile);
  assert.deepEqual(
    qualificationCoreWorkers().map(({ name, phases }) => ({
      name,
      arguments: phases.map((phase) => phase.arguments),
    })),
    oracle.workers,
  );
  // Derive the old argv from the retained PowerShell, independently of the new policy.
  for (const worker of oracle.workers) {
    const body = oracle.core_shell_source.split(`"${worker.name}" {`)[1]?.split("\n  }")[0];
    assert.ok(body);
    const commands = [...body.matchAll(/Invoke-CargoTest @\(([^\n]+)\)/gu)].map((match) => [
      "--locked",
      ...[...match[1]!.matchAll(/"([^"]+)"/gu)].map((arg) => arg[1]!),
    ]);
    assert.deepEqual(commands, worker.arguments);
  }
  for (const worker of qualificationCoreWorkers())
    for (const phase of worker.phases) {
      assert.deepEqual(phase.arguments.slice(0, 3), qualificationCoreScope);
      assert.deepEqual(reusedQualificationArguments(phase), phase.arguments.slice(3));
      const listed = nextestListArguments(phase.arguments);
      const separator = listed.indexOf("--");
      assert.equal(
        listed.indexOf("--message-format"),
        separator < 0 ? listed.length - 2 : separator - 2,
      );
      assert.deepEqual(
        listed.filter(
          (_, index) =>
            index !== listed.indexOf("--message-format") &&
            index !== listed.indexOf("--message-format") + 1,
        ),
        phase.arguments,
      );
    }
  assert.throws(
    () => reusedQualificationArguments({ name: "foreign", arguments: ["--workspace"] }),
    /scope/u,
  );
});

function qualificationPacketFixture() {
  const identity = {
    source: "a".repeat(40),
    run: "123",
    attempt: "1",
    plan: "b".repeat(64),
    compiler: "rustc pinned",
    nextest: "nextest pinned",
    target: "x86_64-pc-windows-msvc",
    inputs: "c".repeat(64),
  };
  const workers = qualificationCoreWorkers().map((worker) => ({
    ...worker,
    phases: worker.phases.map((phase) => ({
      ...phase,
      tests: [JSON.stringify(["portcove-core", "portcove-core", `${worker.name}::${phase.name}`])],
    })),
  }));
  const packet = {
    format_version: 2,
    identity,
    profile: "default",
    scope: [...qualificationCoreScope],
    archive_sha256: "d".repeat(64),
    binaries_sha256: "e".repeat(64),
    complete: workers.flatMap(({ phases }) => phases.flatMap(({ tests }) => tests)),
    workers,
  };
  return packet;
}

void test("qualification Core manifests retain ordered phases and refuse wrong scope, provenance and missing coverage", () => {
  const packet = qualificationPacketFixture();
  const { identity, workers } = packet;
  assert.equal(validateWindowsQualificationCoreManifest(packet, identity), packet);
  for (const key of Object.keys(identity))
    assert.throws(
      () =>
        validateWindowsQualificationCoreManifest(
          { ...packet, identity: { ...identity, [key]: "substituted" } },
          identity,
        ),
      /identity/u,
    );
  for (const change of [
    { profile: "hosted-windows" },
    { scope: ["--locked", "--workspace"] },
    { archive_sha256: "" },
    { binaries_sha256: "" },
    { workers: workers.slice(1) },
    { workers: [...workers].reverse() },
    { complete: [] },
    {
      complete: [...packet.complete, JSON.stringify(["portcove-core", "portcove-core", "missing"])],
    },
  ])
    assert.throws(() =>
      validateWindowsQualificationCoreManifest({ ...packet, ...change }, identity),
    );
  for (const mutate of [
    (copy: typeof packet) => {
      copy.workers[2]!.phases.reverse();
    },
    (copy: typeof packet) => {
      copy.workers[0]!.phases[0]!.arguments.push("--ignored");
    },
    (copy: typeof packet) => {
      copy.workers[0]!.phases[0]!.tests = [];
    },
    (copy: typeof packet) => {
      copy.workers[0]!.phases[0]!.tests.push(copy.workers[0]!.phases[0]!.tests[0]!);
    },
    (copy: typeof packet) => {
      copy.workers[0]!.phases[0]!.tests = [JSON.stringify(["foreign", "foreign", "one"])];
    },
  ]) {
    const copy = structuredClone(packet);
    mutate(copy);
    assert.throws(() => validateWindowsQualificationCoreManifest(copy, identity));
  }
});

void test("qualification binary identity includes binaries without runnable cases and ignores machine paths", () => {
  const suite = (id: string, testcases: Record<string, unknown>) => ({
    "package-name": "portcove-core",
    "binary-id": id,
    status: "listed",
    testcases,
  });
  const inventory = {
    "test-count": 1,
    "rust-suites": {
      "portcove-core": suite("portcove-core", {
        one: { ignored: false, "filter-match": { status: "matches" } },
      }),
    },
  };
  const original = qualificationBinaryListDigest(inventory);
  const complete = {
    ...inventory,
    "rust-suites": {
      ...inventory["rust-suites"],
      "portcove-core::ignored-only": suite("portcove-core::ignored-only", {}),
    },
  };
  assert.deepEqual(
    [...runnableWindowsRustTests(inventory)],
    [...runnableWindowsRustTests(complete)],
  );
  assert.notEqual(original, qualificationBinaryListDigest(complete));
  const remapped = structuredClone(complete);
  Object.assign(remapped["rust-suites"]["portcove-core"], {
    "binary-path": "another-machine/target/core.exe",
  });
  assert.equal(qualificationBinaryListDigest(remapped), qualificationBinaryListDigest(complete));
  assert.throws(
    () => qualificationBinaryListDigest({ ...complete, "test-count": 2 }),
    /Truncated/u,
  );
  const foreign = structuredClone(complete);
  foreign["rust-suites"]["portcove-core::ignored-only"]["package-name"] = "foreign";
  assert.throws(() => qualificationBinaryListDigest(foreign), /Core binary/u);
});

void test("qualification packet custody refuses real-file substitution, truncation and stale attempts before extraction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-qualification-packet-"));
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const archive = Buffer.from(
    "inert archive custody control; native archive execution is separate",
  );
  const packet = { ...qualificationPacketFixture(), archive_sha256: hash(archive) };
  const manifest = JSON.stringify(packet);
  const manifestFile = path.join(directory, "manifest.json");
  const archiveFile = path.join(directory, "tests.tar.zst");
  try {
    await writeFile(manifestFile, manifest);
    await writeFile(archiveFile, archive);
    assert.deepEqual(
      readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      {
        manifest: packet,
        archive: archiveFile,
      },
    );
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, undefined),
      /producer's output/u,
    );
    assert.throws(
      () =>
        readWindowsQualificationCorePacket(
          directory,
          { ...packet.identity, attempt: "2" },
          hash(manifest),
        ),
      /identity/u,
    );
    await writeFile(manifestFile, manifest + " ");
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      /producer's output/u,
    );
    await writeFile(manifestFile, manifest.slice(0, -2));
    assert.throws(
      () =>
        readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest.slice(0, -2))),
      SyntaxError,
    );
    await writeFile(manifestFile, manifest);
    await writeFile(archiveFile, archive.subarray(0, archive.length - 1));
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      /archive digest/u,
    );
    await writeFile(archiveFile, Buffer.alloc(archive.length, 120));
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      /archive digest/u,
    );
    await writeFile(archiveFile, "");
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      /nonempty regular/u,
    );
    await rm(archiveFile);
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      { code: "ENOENT" },
    );
    await mkdir(archiveFile);
    assert.throws(
      () => readWindowsQualificationCorePacket(directory, packet.identity, hash(manifest)),
      /nonempty regular/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("qualification profile filtering preserves two threads, zero retries and every original override", async () => {
  const source = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  const generated = windowsPartitionConfig(
    source,
    [JSON.stringify(["portcove-core", "portcove-core", "one"])],
    "default",
  );
  assert.equal(generated.replace(/default-filter = .*\n/u, ""), source);
  assert.match(
    generated,
    /\[profile.default\]\ndefault-filter = [^\n]+\n(?:[^\n]*\n)*?test-threads = 2/u,
  );
  assert.match(generated, /retries = 0/u);
  assert.throws(
    () => windowsPartitionConfig(source, [JSON.stringify(["core", "core", "one"])], "unknown"),
    /Unsupported/u,
  );
});

void test("Windows Rust partitions use timing only for placement and retain every current identity", () => {
  const hints = validateRustTimingHints({
    format_version: 1,
    default_seconds: 1,
    families: [],
    tests: [["core", "slow", 1000]],
  });
  const testId = (name: string) => JSON.stringify(["core", "core", name]);
  const selected = [
    testId("slow"),
    ...Array.from({ length: 50 }, (_, index) => testId(`new_${index}`)),
  ];
  const partitions = partitionWindowsRustTests(selected, hints);
  assert.equal(partitions.length, 6);
  assert.deepEqual(partitions, partitionWindowsRustTests([...selected].reverse(), hints));
  assert.deepEqual(partitions.flatMap(({ tests }) => tests).sort(), [...selected].sort());
  assert.equal(partitionWindowsRustTests([testId("new")], hints).length, 1);
  assert.throws(
    () => partitionWindowsRustTests([testId("same"), testId("same")], hints),
    /Duplicate/u,
  );
  assert.throws(() => partitionWindowsRustTests([], hints), /nonempty/u);
  assert.throws(() => partitionWindowsRustTests(selected, hints, 9), /one and eight/u);
});

void test("Windows Rust filtered inventory accepts nextest default-filter exclusions without weakening complete coverage", () => {
  // Pinned nextest 0.9.100 lists a distinct status when a profile filter excludes
  // an entire binary; partially selected binaries still list their mismatches.
  const matched = { ignored: false, "filter-match": { status: "matches" } };
  const inventory = {
    "test-count": 2,
    "rust-suites": {
      "transfer-smoke": {
        "package-name": "transfer-smoke",
        "binary-id": "transfer-smoke",
        status: "listed",
        testcases: {
          one: matched,
          two: { ignored: false, "filter-match": { status: "mismatch" } },
        },
      },
      "transfer-smoke::outside": {
        "package-name": "transfer-smoke",
        "binary-id": "transfer-smoke::outside",
        status: "skipped-default-filter",
        testcases: {},
      },
    },
  };
  const original = structuredClone(inventory);
  assert.deepEqual(
    [...runnableWindowsRustTests(inventory, { allowSkipped: true })],
    [JSON.stringify(["transfer-smoke", "transfer-smoke", "one"])],
  );
  assert.deepEqual(inventory, original, "parsing must not rewrite retained inventory evidence");
  assert.throws(() => runnableWindowsRustTests(inventory), /identity or coverage/u);
  const changedSuite = (status: string, testcases = {}, binaryId = "transfer-smoke::outside") => ({
    ...inventory,
    "rust-suites": {
      ...inventory["rust-suites"],
      "transfer-smoke::outside": {
        ...inventory["rust-suites"]["transfer-smoke::outside"],
        "binary-id": binaryId,
        status,
        testcases,
      },
    },
  });
  for (const status of ["skipped", "skipped-default-filter"]) {
    assert.throws(() => runnableWindowsRustTests(changedSuite(status)), /identity or coverage/u);
    assert.throws(
      () =>
        runnableWindowsRustTests(changedSuite(status, { hidden: matched }), { allowSkipped: true }),
      /Skipped nextest suite contained test records/u,
    );
  }
  assert.throws(
    () => runnableWindowsRustTests(changedSuite("unexpected"), { allowSkipped: true }),
    /identity or coverage/u,
  );
  assert.throws(
    () =>
      runnableWindowsRustTests(changedSuite("skipped-default-filter", {}, "substituted"), {
        allowSkipped: true,
      }),
    /identity or coverage/u,
  );
  assert.throws(
    () => runnableWindowsRustTests({ ...inventory, "test-count": 3 }, { allowSkipped: true }),
    /Truncated/u,
  );
});

void test("Windows Rust archive refuses substituted provenance and incomplete or overlapping partitions", () => {
  const identity = {
    source: "a".repeat(40),
    run: "123",
    attempt: "1",
    plan: "b".repeat(64),
    compiler: "rustc pinned",
    nextest: "nextest pinned",
    target: "x86_64-pc-windows-msvc",
    inputs: "c".repeat(64),
  };
  const tests = [JSON.stringify(["core", "core", "one"]), JSON.stringify(["core", "core", "two"])];
  const packet = {
    format_version: 1,
    identity,
    archive_sha256: "d".repeat(64),
    complete: tests,
    selected: tests,
    partitions: [
      { id: 1, estimated_seconds: 1, tests: [tests[0]] },
      { id: 2, estimated_seconds: 1, tests: [tests[1]] },
    ],
  };
  assert.equal(validateWindowsRustManifest(packet, identity), packet);
  for (const key of Object.keys(identity))
    assert.throws(
      () =>
        validateWindowsRustManifest(
          { ...packet, identity: { ...identity, [key]: "substituted" } },
          identity,
        ),
      /identity/u,
    );
  assert.throws(
    () => validateWindowsRustManifest({ ...packet, partitions: [packet.partitions[0]] }, identity),
    /union/u,
  );
  assert.throws(
    () =>
      validateWindowsRustManifest(
        {
          ...packet,
          partitions: [packet.partitions[0], { ...packet.partitions[1], tests: [tests[0]] }],
        },
        identity,
      ),
    /overlap/u,
  );
  assert.throws(
    () =>
      validateWindowsRustManifest(
        { ...packet, selected: [JSON.stringify(["foreign", "foreign", "test"])] },
        identity,
      ),
    /escaped/u,
  );
  assert.throws(
    () => validateWindowsRustManifest({ ...packet, archive_sha256: "" }, identity),
    /identity/u,
  );
  assert.throws(
    () => validateWindowsRustManifest({ ...packet, complete: [] }, identity),
    /nonempty/u,
  );
});

void test("Windows Rust partition filters preserve original timeout and resource policy and escape identities", async () => {
  const source = await readFile(new URL("../.config/nextest.toml", import.meta.url), "utf8");
  const generated = windowsPartitionConfig(source, [
    JSON.stringify(["core", "core::test/binary", "names::case.[1](one)"]),
  ]);
  const inserted = generated.replace(/default-filter = .*\n/u, "");
  assert.equal(inserted, source);
  assert.match(generated, /default-filter = /u);
  assert.match(generated, /binary_id/u);
  assert.match(generated, /test-threads = 4/u);
  assert.throws(
    () =>
      windowsPartitionConfig(source + '\ndefault-filter = "all()"\n', [
        JSON.stringify(["core", "core", "one"]),
      ]),
    /existing default filter/u,
  );
});

void test("Windows Rust keeps exhaustive parallel gates without duplicate setup", () => {
  assert.equal(
    workflowStep("rust_workspace_tests", "Build and test the public Playnite reference consumer")
      .run,
    qualificationOracle.workspace_other.public_cli_source,
  );
  const workspace = workflowJob("rust_workspace_tests");
  assert.ok(Array.isArray(workspace.steps));
  assert.ok(
    workspace.steps.some(
      (step: unknown) =>
        isRecord(step) && step.run === "node scripts/qualification-nextest.mts workspace-other",
    ),
  );
  assert.match(rustTests, /^ {4}name: rust-test \(\$\{\{ matrix\.shard \}\}\)$/m);
  assert.match(rustTests, /runs-on: windows-latest/);
  const shardJob = workflowJob("rust_tests");
  assert.ok(isRecord(shardJob.strategy) && isRecord(shardJob.strategy.matrix));
  const shards = shardJob.strategy.matrix.shard;
  assert.ok(Array.isArray(shards));
  assert.deepEqual(
    shards
      .map((value: unknown) => {
        assert.equal(typeof value, "string");
        return String(value);
      })
      .toSorted(),
    [
      "core-service-1",
      "core-service-2",
      "core-recovery",
      "core-other-1",
      "core-other-2",
    ].toSorted(),
  );
  assert.ok(Array.isArray(shardJob.needs));
  assert.deepEqual(
    shardJob.needs
      .map((value: unknown) => {
        assert.equal(typeof value, "string");
        return String(value);
      })
      .toSorted(),
    ["classify", "qualification_core_archive"],
  );
  assert.match(rustTests, /windows-rust-tests\.mts run-qualification \$\{\{ matrix\.shard \}\}/u);
  assert.match(
    rustTests,
    /PORTCOVE_WINDOWS_MANIFEST_SHA256: \$\{\{ needs\.qualification_core_archive\.outputs\.manifest_sha256 \}\}/u,
  );
  assert.doesNotMatch(rustTests, /workspace-other|pnpm|cargo check|cargo fmt|cargo clippy/);

  assert.match(rustWorkspaceTests, /^ {4}name: rust-test \(workspace-other\)$/m);
  assert.match(rustWorkspaceTests, /runs-on: windows-latest/);
  assert.match(rustWorkspaceTests, /node scripts\/qualification-nextest\.mts workspace-other/);
  assert.doesNotMatch(rustWorkspaceTests, /matrix|cargo fmt|cargo clippy/);

  assert.match(rustClippy, /^ {4}name: rust-clippy$/m);
  assert.match(rustClippy, /runs-on: windows-latest/);
  assert.match(rustClippy, /cargo fmt --all -- --check/);
  assert.match(rustClippy, /cargo clippy --workspace --all-targets -- -D warnings/);
  assert.doesNotMatch(rustClippy, /cargo test|matrix/);

  assert.match(rustQuality, /runs-on: ubuntu-latest/);
  assert.match(rustQuality, /cargo clippy --workspace --all-targets -- -D warnings/);

  assert.match(windowsStorage, /^ {4}name: windows-storage$/m);
  assert.match(windowsStorage, /runs-on: windows-latest/);
  assert.match(windowsStorage, /scripts\/dev-storage\.test\.mts/);
  assert.match(windowsStorage, /--test-skip-pattern "pnpm uses\|direct just recipes"/);
  assert.match(windowsStorage, /scripts\/windows-qualification-session\.test\.mts/);
  assert.match(windowsStorage, /\.\/scripts\/run-windows-qualification\.ps1/);
  assert.match(
    windowsStorage,
    /--test-timeout=30000 --test-reporter=\.\/scripts\/required-node-test-reporter\.mts/,
  );
  assert.match(
    windowsStorage,
    /Install-PSResource -RequiredResourceFile \.config\/powershell-resources\.psd1 -Scope CurrentUser -TrustRepository/,
  );
  assert.match(windowsStorage, /run-powershell-lint\.mts/);
  assert.match(windowsStorage, /lint-tools\.integration\.mts psscriptanalyzer/);
  assertNoDuplicateRustSetup(workflowJob("windows_storage"));
  assert.doesNotMatch(windowsStorage, /continue-on-error/);

  assert.match(rust, /^ {4}if: always\(\)$/m);
  const rustGate = workflowJob("rust");
  assert.ok(Array.isArray(rustGate.needs));
  const dependencies: unknown[] = rustGate.needs;
  for (const dependency of [
    "classify",
    "prose_checks",
    "qualification_core_archive",
    "rust_tests",
    "rust_workspace_tests",
    "rust_clippy",
    "windows_storage",
    "native_rust",
    "intel_build",
    "intel_tests",
    "rust_docs",
  ])
    assert.ok(dependencies.includes(dependency), `Rust aggregate must require ${dependency}`);
  for (const dependency of [
    "qualification_core_archive",
    "rust_tests",
    "rust_workspace_tests",
    "rust_clippy",
    "windows_storage",
    "native_rust",
    "intel_build",
    "intel_tests",
    "rust_docs",
  ])
    assert.ok(rust.includes(`"${dependency}":"` + "${{ needs." + dependency + '.result }}"'));
  assert.doesNotMatch(rust, /continue-on-error/);
});

void test("ordinary Windows Rust compiles once and joins every execution and live transport producer", () => {
  const build = workflowJob("fast_rust");
  const execution = workflowJob("fast_rust_tests");
  const transport = workflowJob("fast_rust_transport");
  for (const producer of [build, execution, transport]) {
    assert.equal(producer["runs-on"], "windows-latest");
    assert.equal(
      producer.if,
      "needs.classify.outputs.mode == 'fast' && contains(fromJSON(needs.classify.outputs.groups_json), 'rust')",
    );
    assert.equal(producer["continue-on-error"], undefined);
  }
  assert.deepEqual(execution.needs, ["classify", "fast_rust"]);
  assert.equal(transport.needs, "classify");
  assert.ok(isRecord(build.outputs));
  assert.equal(build.outputs.manifest_sha256, "${{ steps.archive.outputs.manifest_sha256 }}");
  assert.ok(isRecord(execution.strategy) && isRecord(execution.strategy.matrix));
  assert.equal(execution.strategy["fail-fast"], false);
  assert.equal(
    execution.strategy.matrix.include,
    "${{ fromJSON(needs.fast_rust.outputs.matrix) }}",
  );
  assert.ok(isRecord(execution.env));
  assert.equal(
    execution.env.PORTCOVE_WINDOWS_MANIFEST_SHA256,
    "${{ needs.fast_rust.outputs.manifest_sha256 }}",
  );
  assert.equal(
    workflowStep("fast_rust", "Compile workspace targets and archive balanced test partitions").run,
    "node scripts/run-rust-tests.mts --guard-command node scripts/windows-rust-tests.mts build",
  );
  assert.match(
    workflowStep("fast_rust_tests", "Execute the verified Windows test partition").run,
    /run-rust-tests\.mts --guard-command node scripts\/windows-rust-tests\.mts run/u,
  );
  assert.equal(
    workflowStep(
      "fast_rust_transport",
      "Compare live CLI and headless and native Desktop serialization",
    ).run,
    "node scripts/run-rust-tests.mts --guard-command node scripts/check-transport-contract.mts",
  );
  const aggregate = workflowJob("rust");
  assert.ok(Array.isArray(aggregate.needs));
  const gate: Record<string, unknown> = workflowStep("rust", "Require every Rust lane");
  assert.ok(isRecord(gate.env) && typeof gate.env.PORTCOVE_FAST_RESULTS === "string");
  const results: unknown = JSON.parse(gate.env.PORTCOVE_FAST_RESULTS);
  assert.ok(isRecord(results));
  assert.deepEqual(Object.keys(results).sort(), [
    "fast_rust",
    "fast_rust_tests",
    "fast_rust_transport",
  ]);
  for (const id of Object.keys(results)) {
    assert.ok(aggregate.needs.includes(id));
    assert.equal(results[id], `\${{ needs.${id}.result }}`);
  }
  assert.ok(Array.isArray(build.steps) && Array.isArray(execution.steps));
  const buildSteps: unknown[] = build.steps;
  const executionSteps: unknown[] = execution.steps;
  const uploaded = buildSteps.find(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@") &&
      isRecord(step.with) &&
      String(step.with.name).startsWith("windows-rust-tests-"),
  );
  const downloaded = executionSteps.find(
    (step: unknown) =>
      isRecord(step) &&
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/download-artifact@"),
  );
  assert.ok(
    isRecord(uploaded) &&
      isRecord(uploaded.with) &&
      isRecord(downloaded) &&
      isRecord(downloaded.with),
  );
  assert.equal(
    uploaded.with.name,
    "windows-rust-tests-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(downloaded.with.name, uploaded.with.name);
  assert.match(String(uploaded.with.path), /tests\.tar\.zst/u);
  assert.match(String(uploaded.with.path), /manifest\.json/u);
  assert.equal(uploaded.with["if-no-files-found"], "error");
});
