import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectNativeLinuxHomeMount,
  requireFreshNativeLinuxOutput,
  inspectNativeLinuxStagePlan,
} from "./release-native-linux-driver.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { replaceNativeLinuxPackage } from "./release-native-linux-package.mts";
import { mkdtemp, mkdir, rm, lstat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const home = "/home/qualification/portcove-native/invocations/" + "a".repeat(64) + "/work/home";
const mount = `101 12 0:44 / ${home} rw,nosuid,nodev - tmpfs tmpfs rw,size=524288k\n`;
const filesystem = { type: 0x01021994, bsize: 4096, blocks: 131072 };
void test(
  "Linux portable package replacement retains actual inputs/state and refuses wrong prior or retained partial",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-package-"));
    await mkdir(path.join(root, "packages"), { mode: 0o700 });
    await mkdir(path.join(root, "install"), { mode: 0o700 });
    await mkdir(path.join(root, "home"), { mode: 0o700 });
    const prior = Buffer.from("inert predecessor bytes"),
      candidate = Buffer.from("inert signed candidate bytes");
    const identity = (data: Buffer) => ({
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    await writeFile(path.join(root, "packages/Predecessor.AppImage"), prior, { mode: 0o500 });
    await writeFile(path.join(root, "packages/Candidate.AppImage"), candidate, { mode: 0o500 });
    await writeFile(path.join(root, "home/preferences.json"), "retained original state", {
      mode: 0o600,
    });
    await replaceNativeLinuxPackage({
      attempt: root,
      slot: "predecessor",
      step: "predecessor",
      expected: identity(prior),
      previous: null,
    });
    await assert.rejects(
      replaceNativeLinuxPackage({
        attempt: root,
        slot: "candidate",
        step: "candidate",
        expected: identity(candidate),
        previous: identity(candidate),
      }),
    );
    assert.deepEqual(await readFile(path.join(root, "install/Portcove.AppImage")), prior);
    await replaceNativeLinuxPackage({
      attempt: root,
      slot: "candidate",
      step: "candidate",
      expected: identity(candidate),
      previous: identity(prior),
    });
    await replaceNativeLinuxPackage({
      attempt: root,
      slot: "predecessor",
      step: "rollback",
      expected: identity(prior),
      previous: identity(candidate),
    });
    assert.deepEqual(await readFile(path.join(root, "install/Portcove.AppImage")), prior);
    assert.deepEqual(await readFile(path.join(root, "packages/Candidate.AppImage")), candidate);
    assert.equal(
      await readFile(path.join(root, "home/preferences.json"), "utf8"),
      "retained original state",
    );
    await writeFile(path.join(root, "install/.package-candidate.partial"), "retained partial", {
      mode: 0o500,
    });
    await assert.rejects(
      replaceNativeLinuxPackage({
        attempt: root,
        slot: "candidate",
        step: "candidate",
        expected: identity(candidate),
        previous: identity(prior),
      }),
    );
    assert.equal(
      await readFile(path.join(root, "install/.package-candidate.partial"), "utf8"),
      "retained partial",
    );
  },
);
void test("post-sign guest recipe is a finite same-home package sequence and cannot select legacy or changed journeys", () => {
  const root = "/home/qualification/portcove-native",
    id = "a".repeat(64),
    attempt = `${root}/invocations/${id}`;
  const binding = {
    schema_version: 1,
    invocation_id: id,
    linux_root: root,
    account: { uid: 1002, gid: 1002 },
    application: {
      path: `${attempt}/install/Portcove.AppImage`,
      bytes: 123,
      sha256: "b".repeat(64),
    },
    controller: {
      root: `${root}/controller`,
      source_commit: "c".repeat(40),
      source_tree: "d".repeat(40),
      init_sha256: "e".repeat(64),
    },
    tools: Object.fromEntries(
      Object.entries({
        bwrap: "/usr/bin/bwrap",
        driver: `${root}/tools/tauri-driver`,
        git: "/usr/bin/git",
        node: `${root}/tools/node`,
        python: "/usr/bin/python3",
        webkit_driver: "/usr/bin/WebKitWebDriver",
        xvfb: "/usr/bin/Xvfb",
      }).map(([name, path]) => [name, { path, sha256: "f".repeat(64) }]),
    ),
    unit: {
      name: `portcove-native-${id}.service`,
      invocation_id: "a".repeat(32),
      control_group: `/user.slice/user-1002.slice/user@1002.service/app.slice/portcove-native-${id}.service`,
    },
    capture_root: `${attempt}/capture`,
    home: `${attempt}/work/home`,
    deadline_utc: "2026-11-01T00:00:00.000Z",
  };
  const candidate = {
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    run_id: "123",
    run_attempt: 1,
    artifact_id: 456,
    package: { filename: "Portcove.AppImage", bytes: 123, sha256: "b".repeat(64) },
  };
  const predecessor = {
    ...candidate,
    artifact_id: 455,
    package: { ...candidate.package, bytes: 100, sha256: "9".repeat(64) },
  };
  const request = {
    native_report_schema_version: 2,
    native_prepublication_profile: "signed-package-compatibility-v1",
    invocation_id: id,
    stage: "release-publication",
    platform_label: "linux-x86_64",
    candidate,
    journey: {
      predecessor,
      signed_context_sha256: "8".repeat(64),
      signatures_sha256: "7".repeat(64),
    },
  };
  const raw = {
    schema_version: 2,
    stage: "release-publication",
    binding,
    invocation_id: id,
    stage_request: request,
    stage_request_sha256: releaseCanonicalDigest(request),
    predecessor: { bytes: 100, sha256: "9".repeat(64), version: "0.4.0-beta.1" },
  };
  const plan = inspectNativeLinuxStagePlan(raw);
  assert.deepEqual(
    plan.steps.map((x) => x.id),
    ["predecessor", "candidate", "rollback"],
  );
  assert.equal(new Set(plan.steps.map((x) => x.binding.home)).size, 1);
  assert.equal(
    plan.steps[0]!.binding.application.sha256,
    plan.steps[2]!.binding.application.sha256,
  );
  assert.notEqual(
    plan.steps[0]!.binding.application.sha256,
    plan.steps[1]!.binding.application.sha256,
  );
  const initialRequest = {
    ...request,
    journey: {
      kind: "initial-empty-feed",
      metadata_bootstrap_sha256: "1".repeat(64),
      setup_plan_sha256: "2".repeat(64),
      initial_site_preimage_sha256: "3".repeat(64),
      empty_records_sha256: releaseCanonicalDigest([]),
      signed_context_sha256: "8".repeat(64),
      signatures_sha256: "7".repeat(64),
    },
  };
  const initial = {
    ...raw,
    stage_request: initialRequest,
    stage_request_sha256: releaseCanonicalDigest(initialRequest),
    predecessor: null,
  };
  assert.deepEqual(
    inspectNativeLinuxStagePlan(initial).steps.map((x) => x.id),
    ["candidate"],
  );
  assert.throws(() => inspectNativeLinuxStagePlan({ ...initial, predecessor: raw.predecessor }));
  for (const wrong of [
    { ...raw, schema_version: 1 },
    { ...raw, stage_request_sha256: "0".repeat(64) },
    { ...raw, predecessor: { ...raw.predecessor, sha256: "0".repeat(64) } },
  ])
    assert.throws(() => inspectNativeLinuxStagePlan(wrong));
});
await import("../apps/desktop/scripts/node-contracts/native-linux-stream-capture.native.test.mts");
void test("guest driver leaves fresh desktop output creation to the actual harness and refuses retained state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "desktop");
  assert.equal(await requireFreshNativeLinuxOutput(output), output);
  await assert.rejects(lstat(output), { code: "ENOENT" });
  await mkdir(output);
  await assert.rejects(requireFreshNativeLinuxOutput(output), /already exists/u);
});
void test("native stage state remains in one exact independently bounded tmpfs across inner launches", () => {
  const observed = inspectNativeLinuxHomeMount(mount, home, filesystem);
  assert.equal(observed.maximum_bytes, 512 * 1024 * 1024);
  assert.equal(observed.mount_id, "101");
  assert.equal(observed.authority, "none");
  assert.ok(Object.isFrozen(observed));
});
void test("host-disk home, oversized or aliased mounts cannot substitute for the hard native storage bound", () => {
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home, { ...filesystem, type: 0xef53 }));
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home, { ...filesystem, blocks: 131073 }));
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home, { ...filesystem, blocks: NaN }));
  assert.throws(() =>
    inspectNativeLinuxHomeMount(mount.replace(" / ", " /subtree "), home, filesystem),
  );
  assert.throws(() => inspectNativeLinuxHomeMount(mount + mount, home, filesystem));
  assert.throws(() => inspectNativeLinuxHomeMount(mount, home + "/nested", filesystem));
  assert.throws(() =>
    inspectNativeLinuxHomeMount(mount.replace("rw,nosuid", "ro,nosuid"), home, filesystem),
  );
});
