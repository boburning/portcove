import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import {
  openSettingsProbeListener,
  requireSettingsVerification,
  requireSettingsTransitionMirrors,
  settingsTransitionProof,
  initializeSettingsProbeFiles,
  assertRetainedSettingsConfiguration,
  writeSettingsProbeConfiguration,
  readSettingsProbeConfiguration,
  waitForSettingsProbeSave,
} from "./settings-consumer-qualification.mts";

void test("active Save polling waits past torn JSON and requires the new engine nonce", async () => {
  const nonce = 195;
  const expected = { CVars: { portcoveQualificationSentinel: nonce }, setting: 100 };
  const reads = [
    Buffer.from('{"CVars":'),
    Buffer.from(JSON.stringify({ CVars: { portcoveQualificationSentinel: 12 } })),
    Buffer.from(JSON.stringify(expected)),
  ];
  const torn = reads[0]!;
  const saved = await waitForSettingsProbeSave(
    async () => reads.shift() ?? Buffer.from(""),
    nonce,
    performance.now() + 5000,
    () => {},
  );
  assert.deepEqual(saved, {
    document: expected,
    incomplete: 1,
    lastIncomplete: {
      size: torn.length,
      sha256: createHash("sha256").update(torn).digest("hex"),
    },
  });
  assert.equal(reads.length, 0);
});

void test("persistently incomplete Save reaches its deadline and read failures remain fatal", async () => {
  await assert.rejects(
    waitForSettingsProbeSave(
      async () => Buffer.from(""),
      195,
      performance.now() + 300,
      () => {},
    ),
    /deadline.*Incomplete runtime JSON reads: [1-9]\d*; last size 0, SHA-256 e3b0c442/u,
  );
  await assert.rejects(
    waitForSettingsProbeSave(
      async () => {
        throw new Error("Mutable file no longer has one link.");
      },
      195,
      performance.now() + 5000,
      () => {},
    ),
    /one link/u,
  );
});

void test("native settings verification requires positive exact-install evidence", () => {
  const report = { install_id: "retained-install", checked_files: 183, valid: true, failures: [] };
  assert.equal(requireSettingsVerification(report, "retained-install"), report);
  for (const invalid of [
    undefined,
    { ...report, valid: false },
    { ...report, checked_files: 0 },
    { ...report, checked_files: -1 },
    { ...report, checked_files: 1.5 },
    { ...report, checked_files: undefined, verified_files: 183 },
    { ...report, install_id: "another-install" },
    { ...report, failures: ["immutable file differs"] },
    { ...report, failures: undefined },
  ])
    assert.throws(
      () => requireSettingsVerification(invalid, "retained-install"),
      /positive exact-install/,
    );
  assert.throws(() => requireSettingsVerification(report, undefined), /positive exact-install/);
});

void test("a transition witness refuses a changed or missing mirror without seeding it", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "settings-transition-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, "canonical.json");
  const runtime = join(root, "runtime.json");
  const markerKey = "PortcoveQualification_" + "a".repeat(32);
  const bytes = JSON.stringify({
    volume: 100,
    [markerKey]: { text: "keep this unrelated value", flag: true, array: [3, false, "unknown"] },
  });
  const witness = {
    baseline_install_id: "12345678-0000-0000-0000-123456789abc",
    settings_sha256: createHash("sha256").update(bytes).digest("hex"),
    value: 100,
    marker_key: markerKey,
  };
  assert.deepEqual(settingsTransitionProof(witness), witness);
  await writeFile(canonical, bytes);
  await assert.rejects(requireSettingsTransitionMirrors([canonical, runtime], witness), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(runtime), { code: "ENOENT" });
  await writeFile(runtime, bytes.replace("100", "40"));
  await assert.rejects(
    requireSettingsTransitionMirrors([canonical, runtime], witness),
    /changed before probe setup/,
  );
  assert.equal(await readFile(canonical, "utf8"), bytes);
  await writeFile(runtime, bytes);
  await requireSettingsTransitionMirrors([canonical, runtime], witness);
});

void test("native probe listener owns the first connection and rejects/closes reconnects", async () => {
  const listener = await openSettingsProbeListener();
  const first = connect(listener.port, "127.0.0.1");
  first.on("error", () => {});
  const owned = await listener.connection(1000);
  const second = connect(listener.port, "127.0.0.1");
  second.on("error", () => {});
  await once(second, "close");
  assert.equal(owned.destroyed, false);
  const closed = once(first, "close");
  await listener.close();
  await closed;
  assert.equal(owned.destroyed, true);
});

void test("native probe connection timeout closes the server and leaves no live listener", async () => {
  const listener = await openSettingsProbeListener();
  await assert.rejects(listener.connection(10), /finite deadline/);
  await listener.close();
  const late = connect(listener.port, "127.0.0.1");
  const error = await once(late, "error");
  const failure: unknown = error[0];
  assert.ok(failure instanceof Error && "code" in failure);
  assert.equal(failure.code, "ECONNREFUSED");
  late.destroy();
});

void test("native probe reset is retained as a checked failure instead of an uncaught event", async () => {
  const listener = await openSettingsProbeListener();
  const peer = connect(listener.port, "127.0.0.1");
  peer.on("error", () => {});
  const owned = await listener.connection(1000);
  const closed = new Promise<void>((done) => owned.once("close", () => done()));
  peer.resetAndDestroy();
  await closed;
  assert.throws(() => listener.check(), /ECONNRESET|closed/);
  await listener.close();
});

void test("native probe drains but bounds an oversized upstream response before shutdown", async () => {
  const listener = await openSettingsProbeListener();
  const peer = connect(listener.port, "127.0.0.1");
  peer.on("error", () => {});
  const owned = await listener.connection(1000);
  const closed = new Promise<void>((done) => owned.once("close", () => done()));
  peer.write(Buffer.alloc(1024 * 1024 + 1));
  await closed;
  assert.throws(() => listener.check(), /bounded response allowance/);
  peer.destroy();
  await listener.close();
});

void test("qualification initializes Core-retained mirrors and refuses later divergence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "settings-mirrors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, "user", "settings.json"),
    runtime = join(root, "runtime", "settings.json");
  const scope = {
    install_id: "exact",
    definition_sha256: "a".repeat(64),
    files: [{ file_id: "preferences", canonical_path: canonical, runtime_path: runtime }],
  };
  const sample = '{"control":37,"unknown":{"keep":[true,3]}}';
  const paths = await initializeSettingsProbeFiles(
    root,
    scope,
    "preferences",
    "exact",
    sample,
    "working-directory-mirror",
  );
  assert.deepEqual(paths.paths, [toNamespacedPath(canonical), toNamespacedPath(runtime)]);
  assert.equal(await readFile(canonical, "utf8"), sample);
  assert.equal(await readFile(runtime, "utf8"), sample);
  await assertRetainedSettingsConfiguration(paths.canonical, toNamespacedPath(canonical));
  await assert.rejects(
    assertRetainedSettingsConfiguration(paths.canonical, toNamespacedPath(runtime)),
    /differs from Core's retained canonical file/,
  );
  await writeSettingsProbeConfiguration(runtime, '{"control":40,"unknown":{"keep":[true,3]}}');
  await assert.rejects(
    initializeSettingsProbeFiles(root, scope, "preferences", "exact", sample),
    /mirrors differ/,
  );
  assert.equal(await readFile(canonical, "utf8"), sample);
  const saved: unknown = JSON.parse(await readFile(runtime, "utf8"));
  assert.deepEqual(saved, { control: 40, unknown: { keep: [true, 3] } });
  await assert.rejects(
    initializeSettingsProbeFiles(root, scope, "preferences", "foreign-install", sample),
    /exact retained installation/,
  );
});

void test("a working-directory consumer without a retained runtime copy refuses before seeding", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "settings-direct-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const canonical = join(root, "settings.json");
  const scope = {
    install_id: "exact",
    definition_sha256: "a".repeat(64),
    files: [{ file_id: "preferences", canonical_path: canonical, runtime_path: null }],
  };
  await assert.rejects(
    initializeSettingsProbeFiles(
      root,
      scope,
      "preferences",
      "exact",
      "{}",
      "working-directory-mirror",
    ),
    /no synchronized runtime copy/,
  );
  await assert.rejects(readFile(canonical), { code: "ENOENT" });
});

void test("mutable qualification configuration refuses a hardlink without changing foreign bytes", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "settings-hardlink-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "owned"),
    foreign = join(temporary, "foreign.json");
  await mkdir(root);
  const bytes = '{"foreign":"preserve"}';
  await writeFile(foreign, bytes);
  const configuration = join(root, "settings.json");
  await link(foreign, configuration);
  await assert.rejects(
    writeSettingsProbeConfiguration(configuration, '{"mutated":true}'),
    /unlinked regular file/,
  );
  await assert.rejects(readSettingsProbeConfiguration(configuration), /one link/);
  const scope = {
    install_id: "exact",
    definition_sha256: "a".repeat(64),
    files: [{ file_id: "preferences", canonical_path: configuration, runtime_path: null }],
  };
  await assert.rejects(
    initializeSettingsProbeFiles(root, scope, "preferences", "exact", "{}"),
    /one link/,
  );
  assert.equal(await readFile(foreign, "utf8"), bytes);
  assert.equal(await readFile(configuration, "utf8"), bytes);
});
