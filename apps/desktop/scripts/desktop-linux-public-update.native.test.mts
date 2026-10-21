import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectLinuxPublicRuntime } from "./desktop-linux-public-update.mts";
import {
  createNativePublicJourneyBudget,
  nativePublicRelayLimiter,
} from "./native-linux-isolated-session.mts";
import {
  createPublicUpdatePreimageStore,
  readBoundedPublicUpdateBytes,
  publicUpdateRawMetadataBytes,
  retainPublicUpdateProfile,
  restorePublicUpdateProfile,
  retainDeduplicatedPublicUpdatePreimages,
} from "./desktop-public-update-files.mts";

void test("ordinary relaunch observation requires exact original opaque package and changed process generation", () => {
  const identity = { bytes: 12, sha256: "a".repeat(64) };
  const raw = {
    schema_version: 1,
    authority: "none",
    scope: "ordinary-public-broker-mounted-runtime",
    namespace_owner_pid: 1,
    process: {
      pid: 10,
      creation_ticks: "1234",
      opaque_mount: {
        runtime: { package: identity },
        mount: { filesystem: "fuse.AppImage", source: "/native/installation/Portcove.AppImage" },
      },
    },
  };
  assert.equal(inspectLinuxPublicRuntime(raw, identity).pid, 10);
  assert.throws(() =>
    inspectLinuxPublicRuntime(raw, identity, { pid: 10, creation_ticks: "1234" }),
  );
  assert.equal(
    inspectLinuxPublicRuntime(raw, identity, { pid: 10, creation_ticks: "1233" }).creation_ticks,
    "1234",
  );
  for (const changed of [
    { ...raw, scope: "manual-package-compatibility" },
    { ...raw, namespace_owner_pid: 2 },
    {
      ...raw,
      process: {
        ...raw.process,
        opaque_mount: {
          ...raw.process.opaque_mount,
          runtime: { package: { ...identity, sha256: "b".repeat(64) } },
        },
      },
    },
    {
      ...raw,
      process: {
        ...raw.process,
        opaque_mount: {
          ...raw.process.opaque_mount,
          mount: { ...raw.process.opaque_mount.mount, source: "/other.AppImage" },
        },
      },
    },
  ])
    assert.throws(() => inspectLinuxPublicRuntime(changed, identity));
});

void test("all namespace reopens share the original wire and connection ceilings", () => {
  const budget = createNativePublicJourneyBudget();
  for (let index = 0; index < 6; index++) {
    budget.start();
    budget.charge("upload", 10, 10);
    budget.charge("download", 10);
  }
  assert.deepEqual(budget.snapshot(), {
    sessions: 6,
    mounts: 0,
    opens: 60,
    uploaded_wire_bytes: 60,
    downloaded_wire_bytes: 60,
  });
  assert.throws(() => budget.start());
  for (let index = 0; index < 8; index++) {
    assert.equal(budget.remainingMounts(), 8 - index);
    budget.chargeMount();
  }
  assert.throws(() => budget.chargeMount());
  assert.throws(() => budget.remainingMounts());
  assert.throws(() => budget.charge("upload", 1, 5));
  assert.throws(() => budget.charge("download", 0));
  for (const [direction, maximum] of [
    ["upload", 16 * 1024 * 1024],
    ["download", 1024 * 1024 * 1024],
  ] as const) {
    const current = createNativePublicJourneyBudget();
    current.start();
    current.charge(direction, maximum);
    assert.throws(() => current.charge(direction, 1));
    assert.throws(() => current.charge(direction, 0));
  }
});

void test("raw identical-byte reuse preserves each observation, distinct fault bytes and original retained custody", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-public-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(runtime, "staging"), { recursive: true });
  const payload = path.join(runtime, "staging", "candidate-installer.exe");
  await writeFile(payload, Buffer.from([77, 90, 1, 2]));
  await writeFile(path.join(runtime, "update-schedule.json"), "");
  const store = await createPublicUpdatePreimageStore(path.join(root, "store"));
  const deadline = performance.now() + 10000;
  const first = await retainDeduplicatedPublicUpdatePreimages(
    runtime,
    path.join(root, "first"),
    store,
    deadline,
  );
  const second = await retainDeduplicatedPublicUpdatePreimages(
    runtime,
    path.join(root, "second"),
    store,
    deadline,
  );
  assert.equal(first.retained_bytes, 4);
  assert.equal(second.retained_bytes, 4);
  assert.equal(second.files.find((item) => item.path === "update-schedule.json")?.bytes, 0);
  await writeFile(payload, Buffer.from([76, 90, 1, 2]));
  const fault = await retainDeduplicatedPublicUpdatePreimages(
    runtime,
    path.join(root, "fault"),
    store,
    deadline,
  );
  assert.equal(fault.retained_bytes, 8);
  const original = first.files.find((item) => item.path.endsWith("candidate-installer.exe"))!;
  assert.ok(original.chunks?.length);
  const retainedPath = path.resolve(root, "first", original.chunks[0]!.retained);
  assert.deepEqual(await readFile(retainedPath), Buffer.from([77, 90, 1, 2]));
  await assert.rejects(
    retainDeduplicatedPublicUpdatePreimages(
      runtime,
      path.join(root, "imported"),
      structuredClone(store),
      deadline,
    ),
  );
  await writeFile(retainedPath, Buffer.from([78, 90, 1, 2]));
  await writeFile(payload, Buffer.from([77, 90, 1, 2]));
  await assert.rejects(
    retainDeduplicatedPublicUpdatePreimages(runtime, path.join(root, "changed"), store, deadline),
    /retained preimage bytes changed/u,
  );
});

void test("one-byte payload corruption retains reconstructable lossless chunks without a second full payload copy", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "portcove-public-chunks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(runtime, "staging"), { recursive: true });
  const payload = Buffer.concat([
    Buffer.alloc(1024 * 1024, 1),
    Buffer.alloc(1024 * 1024, 2),
    Buffer.alloc(1024 * 1024, 3),
  ]);
  const source = path.join(runtime, "staging", "candidate-installer.exe");
  await writeFile(source, payload);
  const store = await createPublicUpdatePreimageStore(path.join(root, "store")),
    deadline = performance.now() + 10000;
  const first = await retainDeduplicatedPublicUpdatePreimages(
    runtime,
    path.join(root, "first"),
    store,
    deadline,
  );
  const changed = Buffer.from(payload);
  changed[0] = 0;
  await writeFile(source, changed);
  const second = await retainDeduplicatedPublicUpdatePreimages(
    runtime,
    path.join(root, "second"),
    store,
    deadline,
  );
  assert.equal(first.retained_bytes, 3 * 1024 * 1024);
  assert.equal(second.retained_bytes, 4 * 1024 * 1024);
  for (const [name, observed, expected] of [
    ["first", first, payload],
    ["second", second, changed],
  ] as const) {
    const row = observed.files.find((item) => item.path.endsWith("candidate-installer.exe"))!;
    assert.ok(row.chunks);
    const reconstructed = Buffer.concat(
      await Promise.all(
        row.chunks.map((chunk) => readFile(path.resolve(root, name, chunk.retained))),
      ),
    );
    assert.ok(reconstructed.equals(expected));
  }
});

void test("actual relay stream refuses an over-budget write before any downstream bytes are forwarded", async () => {
  const budget = createNativePublicJourneyBudget();
  budget.start();
  budget.charge("download", 1024 * 1024 * 1024 - 2);
  const limiter = nativePublicRelayLimiter("download", budget);
  let forwarded = 0;
  limiter.on("data", (chunk: Buffer) => {
    forwarded += chunk.length;
  });
  const error = new Promise<Error>((resolve) => limiter.once("error", resolve));
  limiter.end(Buffer.alloc(3));
  assert.match((await error).message, /budget exhausted/u);
  assert.equal(forwarded, 0);
  const opens = createNativePublicJourneyBudget();
  opens.start();
  opens.charge("upload", 0, 64);
  const upload = nativePublicRelayLimiter("upload", opens);
  let uploadForwarded = 0;
  upload.on("data", (chunk: Buffer) => {
    uploadForwarded += chunk.length;
  });
  const refused = new Promise<Error>((resolve) => upload.once("error", resolve));
  upload.end(Buffer.from('{"kind":"open"}\n'));
  assert.match((await refused).message, /budget exhausted/u);
  assert.equal(uploadForwarded, 0);
});

void test(
  "actual Linux profile snapshot restores full library/WebView bytes and refuses changed or imported paths",
  { skip: process.platform !== "linux" },
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "portcove-public-profile-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const runtime = path.join(root, "runtime");
    await mkdir(path.join(runtime, ".local", "share", "app"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(runtime, "library"), { mode: 0o700 });
    await mkdir(path.join(runtime, "staging"), { mode: 0o700 });
    await chmod(runtime, 0o700);
    const originals = new Map([
      ["library/catalog-state.sqlite3", Buffer.from("actual retained component bytes")],
      [".local/share/app/webview-state", Buffer.from([0, 1, 2, 255])],
      ["update-schedule.json", Buffer.from('{"original_time":"2026-10-21T00:00:00Z"}')],
      ["empty", Buffer.alloc(0)],
      ["staging/candidate-installer.exe", Buffer.from([77, 90, 1, 2])],
    ]);
    for (const [name, bytes] of originals)
      await writeFile(path.join(runtime, name), bytes, { mode: 0o600 });
    const payload = originals.get("staging/candidate-installer.exe")!;
    const identity = {
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
    const store = await createPublicUpdatePreimageStore(path.join(root, "preimage-store"));
    const directory = path.join(root, "snapshot"),
      deadline = performance.now() + 10000;
    const snapshot = await retainPublicUpdateProfile(runtime, directory, store, deadline, identity);
    const target = path.join(root, "restored");
    const copied = await restorePublicUpdateProfile(directory, snapshot.sha256, target, deadline);
    assert.equal(copied.authority, "none");
    for (const [name, bytes] of originals)
      assert.deepEqual(await readFile(path.join(target, name)), bytes);
    await writeFile(path.join(target, "retained-marker"), "partial effects remain");
    await assert.rejects(
      restorePublicUpdateProfile(directory, snapshot.sha256, target, deadline),
      /EEXIST/u,
    );
    assert.equal(
      await readFile(path.join(target, "retained-marker"), "utf8"),
      "partial effects remain",
    );
    const manifestPath = path.join(directory, "profile.json"),
      originalManifest = await readFile(manifestPath);
    const malformed = JSON.parse(originalManifest.toString()) as { files: { path: string }[] };
    malformed.files[0]!.path = "../escape";
    const altered = Buffer.from(JSON.stringify(malformed));
    await writeFile(manifestPath, altered);
    await assert.rejects(
      restorePublicUpdateProfile(
        directory,
        createHash("sha256").update(altered).digest("hex"),
        path.join(root, "escape-refused"),
        deadline,
      ),
    );
    await writeFile(manifestPath, originalManifest);
    await assert.rejects(
      restorePublicUpdateProfile(
        directory,
        "0".repeat(64),
        path.join(root, "wrong-digest"),
        deadline,
      ),
    );
    await link(path.join(runtime, "empty"), path.join(runtime, "alias"));
    await assert.rejects(
      retainPublicUpdateProfile(
        runtime,
        path.join(root, "linked-refused"),
        store,
        deadline,
        identity,
      ),
    );
  },
);

void test("actual bounded reader refuses growth between metadata and open without an unbounded parse read", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "portcove-public-growth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "profile.json");
  await writeFile(filename, "1234");
  const originalOpen = fsPromises.open;
  let intercepted = 0;
  fsPromises.open = async (file, flags, mode) => {
    if (file === filename && intercepted++ === 0)
      await fsPromises.appendFile(filename, Buffer.alloc(2 * 1024 * 1024));
    return originalOpen(file, flags, mode);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      readBoundedPublicUpdateBytes(filename, 1024 * 1024, performance.now() + 10000),
      /grew during observation/u,
    );
    assert.equal(intercepted, 1);
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

void test("Linux raw metadata accounting enforces the actual five shipping parser ceilings", async (context) => {
  assert.equal(publicUpdateRawMetadataBytes, 3 * 65536 + 2 * 524288);
  const root = await mkdtemp(path.join(tmpdir(), "portcove-public-metadata-cap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await mkdir(runtime);
  await writeFile(path.join(runtime, "update-schedule.json"), Buffer.alloc(65537));
  const store = await createPublicUpdatePreimageStore(path.join(root, "preimage-store"));
  await assert.rejects(
    retainDeduplicatedPublicUpdatePreimages(
      runtime,
      path.join(root, "refused"),
      store,
      performance.now() + 10000,
    ),
  );
});
