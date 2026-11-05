import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import {
  openSettingsProbeListener,
  requireSettingsVerification,
  initializeSettingsProbeFiles,
  assertRetainedSettingsConfiguration,
  writeSettingsProbeConfiguration,
  readSettingsProbeConfiguration,
} from "./settings-consumer-qualification.mts";

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
  const paths = await initializeSettingsProbeFiles(root, scope, "preferences", "exact", sample);
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
