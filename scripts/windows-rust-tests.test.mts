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
