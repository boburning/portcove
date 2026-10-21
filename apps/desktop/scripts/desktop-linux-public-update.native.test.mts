import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, link, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectLinuxPublicRuntime,
  assertLinuxPublicUserStatePreserved,
  inspectLinuxPublicPreNativeRequest,
  inspectRetainedLinuxPublicState,
  selectLinuxPublicRelaunch,
} from "./desktop-linux-public-update.mts";
void test("public integrity helpers import before desktop Selenium dependencies are installed", () => {
  const module = new URL("./desktop-linux-public-update.mts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {registerHooks} from 'node:module';
registerHooks({resolve(name,context,next){if(name==='selenium-webdriver')throw Error('desktop dependency unavailable');return next(name,context)}});
const value=await import(${JSON.stringify(module)});
if(typeof value.inspectLinuxPublicRuntime!=='function')throw Error('missing integrity helper');`,
    ],
    { encoding: "utf8", timeout: 15000, maxBuffer: 65536, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
});
void test("old restart preimage cannot conceal started, ambiguous or unrelated native effects", () => {
  const raw = {
    schema_version: 4,
    revision: 1,
    intent: { request: "restart-to-apply" },
    termination: "restart-to-apply",
    native_launch: null,
    native_replacement: null,
    native_exit_code: null,
  };
  const parsed = inspectLinuxPublicPreNativeRequest(raw);
  assert.equal(parsed.authority, "none");
  assert.equal(parsed.revision, 1);
  for (const changed of [
    { schema_version: 1 },
    { native_launch: "starting" },
    { native_launch: "failed" },
    { native_replacement: {} },
    { native_exit_code: 0 },
    { termination: "crash" },
    { intent: null },
    { revision: 0 },
    { intent: { request: "safe-exit" } },
  ])
    assert.throws(() => inspectLinuxPublicPreNativeRequest({ ...raw, ...changed }));
});
import {
  createNativePublicJourneyBudget,
  nativePublicRelayLimiter,
} from "./native-linux-isolated-session.mts";
import {
  createPublicUpdatePreimageStore,
  readBoundedPublicUpdateBytes,
  publicUpdateRawMetadataBytes,
  publicUpdateApplySchemaVersion,
  retainPublicUpdateProfile,
  restorePublicUpdateProfile,
  restoreParkedPublicUpdateCapture,
  retainDeduplicatedPublicUpdatePreimages,
  retainPublicContinuationPreimages,
} from "./desktop-public-update-files.mts";
void test("native raw apply inspector remains tied to the current shipping journal version", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../src-tauri/src/application_update_apply.rs", import.meta.url)),
    "utf8",
  );
  const declarations = [...source.matchAll(/^const APPLY_SCHEMA_VERSION: u32 = ([1-9][0-9]*);$/gm)];
  assert.equal(declarations.length, 1);
  assert.equal(publicUpdateApplySchemaVersion, Number(declarations[0]?.[1]));
});
void test("unchanged parked payload retains a new byte observation tied to original wire, while V2 is copied normally", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "public-old-payload-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(runtime, "staging"), { recursive: true });
  const old = Buffer.from([1, 2, 3, 4]);
  await writeFile(path.join(runtime, "staging/candidate-installer.exe"), old);
  const store = await createPublicUpdatePreimageStore(path.join(root, "store")),
    deadline = performance.now() + 10000;
  const prior = {
    invocation_id: "a".repeat(64),
    wire_sha256: "b".repeat(64),
    manifest_sha256: "c".repeat(64),
    package: { bytes: old.length, sha256: createHash("sha256").update(old).digest("hex") },
  };
  const first = await retainPublicContinuationPreimages(
    runtime,
    path.join(root, "old-observation"),
    store,
    deadline,
    prior,
  );
  assert.ok("historical_payload" in first);
  assert.equal(first.retained_bytes, 0);
  assert.equal(first.historical_payload.source.wire_sha256, prior.wire_sha256);
  assert.deepEqual(await readFile(path.join(runtime, "staging/candidate-installer.exe")), old);
  await writeFile(path.join(runtime, "staging/candidate-installer.exe"), Buffer.from([9, 8, 7, 6]));
  const next = await retainPublicContinuationPreimages(
    runtime,
    path.join(root, "new-observation"),
    store,
    deadline,
    prior,
  );
  assert.equal("historical_payload" in next, false);
  assert.equal(next.retained_bytes, 4);
  assert.equal(
    next.files.find((file) => file.path === "staging/candidate-installer.exe")?.absent,
    undefined,
  );
});

void test("ordinary relaunch observation requires exact original opaque package and changed process generation", () => {
  const identity = { bytes: 12, sha256: "a".repeat(64) };
  const raw = {
    schema_version: 1,
    authority: "none",
    scope: "ordinary-public-broker-mounted-runtime",
    namespace_owner_pid: 1,
    process: {
      role: "application",
      arguments: ["/tmp/.mount_App/usr/bin/portcove-desktop"],
      pid: 10,
      creation_ticks: "1234",
      opaque_mount: {
        runtime: { package: identity },
        mount: { filesystem: "fuse.AppImage", source: "/native/installation/Portcove.AppImage" },
      },
    },
  };
  assert.equal(inspectLinuxPublicRuntime(raw, identity).pid, 10);
  const previous = { pid: 10, creation_ticks: "1234" };
  assert.equal(selectLinuxPublicRelaunch(raw, identity, previous), null);
  assert.equal(
    selectLinuxPublicRelaunch({ ...raw, process: { ...raw.process, pid: 11 } }, identity, previous)
      ?.pid,
    11,
  );
  assert.equal(
    selectLinuxPublicRelaunch(
      { ...raw, process: { ...raw.process, creation_ticks: "1235" } },
      identity,
      previous,
    )?.creation_ticks,
    "1235",
  );
  assert.throws(() =>
    selectLinuxPublicRelaunch(
      { ...raw, process: { ...raw.process, role: "update-helper" } },
      identity,
      previous,
    ),
  );
  assert.throws(() =>
    inspectLinuxPublicRuntime(raw, identity, { pid: 10, creation_ticks: "1234" }),
  );
  assert.equal(
    inspectLinuxPublicRuntime(raw, identity, { pid: 10, creation_ticks: "1233" }).creation_ticks,
    "1234",
  );
  for (const changed of [
    { ...raw, process: { ...raw.process, role: "update-helper" } },
    { ...raw, process: { ...raw.process, arguments: ["/app", "--portcove-apply-update", "12"] } },
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
  ]) {
    assert.throws(() => inspectLinuxPublicRuntime(changed, identity));
    assert.throws(() => selectLinuxPublicRelaunch(changed, identity, previous));
  }
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
    // Use the actual retained profile/chunks through the same streamed capture
    // framing used by the guest export, with no claim of old invocation authority.
    const invocation = "a".repeat(64);
    const retained = new Map<string, Buffer>([
      [
        "public-journey/profile-snapshot/profile.json",
        await readFile(path.join(directory, "profile.json")),
      ],
    ]);
    for (const name of await readdir(path.join(root, "preimage-store")))
      if (name.endsWith(".bin"))
        retained.set(
          `public-journey/preimage-store/${name}`,
          await readFile(path.join(root, "preimage-store", name)),
        );
    const framing: Buffer[] = [];
    for (const [name, bytes] of [...retained].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      framing.push(
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            invocation_id: invocation,
            path: name,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          }) + "\n",
        ),
        bytes,
      );
    }
    framing.push(
      Buffer.from(
        JSON.stringify({
          schema_version: 1,
          invocation_id: invocation,
          count: retained.size,
          complete: true,
          authority: "none",
        }) + "\n",
      ),
    );
    const wire = Buffer.concat(framing),
      wirePath = path.join(root, "parked.wire");
    await writeFile(wirePath, wire, { mode: 0o600 });
    const expected = {
      invocation_id: invocation,
      wire_sha256: createHash("sha256").update(wire).digest("hex"),
      manifest_sha256: snapshot.sha256,
    };
    const transferredTarget = path.join(root, "transferred-restored");
    const transferred = await restoreParkedPublicUpdateCapture(
      wirePath,
      expected,
      path.join(root, "transferred-capture"),
      transferredTarget,
      deadline,
    );
    assert.equal(transferred.authority, "none");
    for (const [name, bytes] of originals)
      assert.deepEqual(await readFile(path.join(transferredTarget, name)), bytes);
    await assert.rejects(
      restoreParkedPublicUpdateCapture(
        wirePath,
        { ...expected, manifest_sha256: "b".repeat(64) },
        path.join(root, "wrong-profile-capture"),
        path.join(root, "wrong-profile-target"),
        deadline,
      ),
    );
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

void test("Linux semantic choices cannot conceal a moved WebKit or library profile", () => {
  const before = {
    application_origin: "null",
    application_url: "tauri://localhost/",
    app_local_data: "/native/profile/client-a/.local/share/portcove",
    application_version: "1.0.0-beta.1",
    library_root: "/native/profile/client-a/library",
    favorites: ["gen2-port"],
    theme_preference: "light",
    rendered_theme: "light",
    update_preferences: { schema_version: 1, choice: { channel: "preview", mode: "manual" } },
  };
  assert.deepEqual(inspectRetainedLinuxPublicState(before), before);
  for (const changed of [
    { application_url: "https://foreign.invalid/" },
    { application_origin: "http://tauri.localhost" },
    { favorites: [] },
    { update_preferences: null },
  ])
    assert.throws(() => inspectRetainedLinuxPublicState({ ...before, ...changed }));
  assert.doesNotThrow(() =>
    assertLinuxPublicUserStatePreserved(before, { ...before, application_version: "1.0.0-beta.2" }),
  );
  assert.throws(
    () =>
      assertLinuxPublicUserStatePreserved(before, {
        ...before,
        app_local_data: "/native/profile/client-a/other",
      }),
    /WebKit data path/u,
  );
  assert.throws(
    () =>
      assertLinuxPublicUserStatePreserved(before, {
        ...before,
        library_root: "/native/profile/client-b/library",
      }),
    /library path/u,
  );
});
