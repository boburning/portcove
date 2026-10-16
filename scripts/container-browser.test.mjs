import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  command,
  validateEngine,
  validateDesktop,
  diskFromSettings,
  linuxStorage,
  cacheBytes,
  selectedSource,
  runtimeArguments,
  validateRuntime,
  verifyPublication,
  saveFailure,
  cleanup,
} from "./container-browser.mjs";
import { preflight, isWindowsSystemDrivePath } from "./dev-storage.mjs";
import { assertCommittedWorkspace } from "./container-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const info = {
  OSType: "linux",
  OperatingSystem: "Docker Desktop",
  KernelVersion: "6.18-microsoft-standard-WSL2",
  Architecture: "x86_64",
};
const context = { Endpoints: { docker: { Host: "npipe:////./pipe/dockerDesktopLinuxEngine" } } };
test("Desktop state rejects idle/stopped cached API readiness", () => {
  validateDesktop({ Status: "running", PauseType: "" });
  for (const state of [
    { Status: "stopped" },
    { Status: "running", PauseType: "resource-saver" },
    { Status: "paused" },
    {},
  ])
    assert.throws(() => validateDesktop(state), /stopped, paused or in Resource Saver/u);
});
test("host admission requires the actual local Desktop WSL 2 Linux x86-64 engine", () => {
  validateEngine(info, context);
  for (const patch of [
    { OSType: "windows" },
    { OperatingSystem: "Ubuntu" },
    { KernelVersion: "6.18-generic" },
    { Architecture: "arm64" },
  ])
    assert.throws(() => validateEngine({ ...info, ...patch }, context), /requires Docker Desktop/u);
  for (const Host of ["ssh://somewhere", "npipe:////./pipe/docker_engine", "tcp://127.0.0.1:2375"])
    assert.throws(
      () => validateEngine(info, { Endpoints: { docker: { Host } } }),
      /local Docker Desktop/u,
    );
});
test("disk discovery uses resolved settings and refuses unknown backend/folder authority", () => {
  const settings = {
    "vm.hypervisor.windows": "wsl2",
    "vm.resources.wslDataFolder": "<HOME>\\AppData\\Local\\Docker\\wsl",
  };
  assert.equal(
    diskFromSettings(settings, "C:\\Users\\fixture").vhd,
    "C:\\Users\\fixture\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx",
  );
  for (const patch of [
    { "vm.hypervisor.windows": "hyper-v" },
    { "vm.resources.wslDataFolder": "relative" },
    { "vm.resources.wslDataFolder": "<UNKNOWN>\\disk" },
    { "vm.resources.wslDataFolder": undefined },
  ])
    assert.throws(() => diskFromSettings({ ...settings, ...patch }, "C:\\Users\\fixture"));
  assert.throws(() => diskFromSettings({}, "C:\\Users\\fixture"));
});
test("Linux capacity uses exactly one actual Docker disk row and retains rejected observations", () => {
  const valid =
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sde 1000000000 10 900000000 1% /mnt/docker-desktop-disk\n";
  assert.equal(linuxStorage(valid), 900000000 * 1024);
  for (const output of ["", "not a disk", valid + valid, valid.replace("900000000", "1")])
    assert.throws(
      () => linuxStorage(output),
      (error) => error.observation === output,
    );
});
test("build-cache admission reads actual Docker JSON records and rejects unknown units", () => {
  assert.equal(
    cacheBytes('{"Type":"Images","Size":"100GB"}\n{"Type":"Build Cache","Size":"1.2GB"}\n'),
    1200000000,
  );
  assert.equal(cacheBytes('{"Type":"Build Cache","Size":"0B"}'), 0);
  assert.throws(() => cacheBytes('{"Type":"Build Cache","Size":"unavailable"}'), /Unknown/u);
  assert.throws(() => cacheBytes('{"Type":"Images","Size":"1GB"}'), /Unknown/u);
});
test(
  "backing storage follows junctions and enforces the physical system-volume policy",
  {
    skip: process.platform !== "win32" || isWindowsSystemDrivePath(root, process.env.SystemDrive),
  },
  () => {
    mkdirSync(path.join(root, "work"), { recursive: true });
    const nonSystem = mkdtempSync(path.join(root, "work/container-storage-"));
    const system = mkdtempSync(path.join(os.tmpdir(), "portcove-container-storage-"));
    try {
      symlinkSync(nonSystem, path.join(system, "to-non-system"), "junction");
      const accepted = preflight({ docker_disk: path.join(system, "to-non-system") }, 0.001, {
        blockSystemDrive: true,
      });
      assert.equal(accepted.paths.docker_disk.toLowerCase(), nonSystem.toLowerCase());
      symlinkSync(system, path.join(nonSystem, "to-system"), "junction");
      assert.throws(
        () =>
          preflight({ docker_disk: path.join(nonSystem, "to-system") }, 0.001, {
            blockSystemDrive: true,
          }),
        /system drive/u,
      );
      assert.throws(
        () => preflight({ docker_disk: nonSystem }, 1e12, { blockSystemDrive: false }),
        /free/u,
      );
    } finally {
      // Remove each owned junction itself before recursively removing its exact
      // verified fixture parent; neither target is traversed for deletion.
      rmSync(path.join(system, "to-non-system"));
      rmSync(path.join(nonSystem, "to-system"));
      assert.equal(path.dirname(nonSystem), path.join(root, "work"));
      assert.equal(path.dirname(system), path.resolve(os.tmpdir()));
      rmSync(nonSystem, { recursive: true });
      rmSync(system, { recursive: true });
    }
  },
);
test("an unpushed commit is selected exactly and dirty bytes/refs remain untouched", async () => {
  mkdirSync(path.join(root, "work"), { recursive: true });
  const fixture = mkdtempSync(path.join(root, "work/container-source-"));
  const git = async (...args) => (await command("git", args, { cwd: fixture })).stdout.trim();
  try {
    await git("init");
    writeFileSync(path.join(fixture, "source.txt"), "committed\n");
    await git("add", "source.txt");
    await git(
      "-c",
      "core.hooksPath=",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=Container fixture",
      "-c",
      "user.email=container@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const commit = await git("rev-parse", "HEAD"),
      tree = await git("rev-parse", "HEAD^{tree}");
    assert.equal(await git("remote"), "");
    assertCommittedWorkspace(fixture, commit, tree);
    assert.equal((await selectedSource(commit, false, fixture)).tree, tree);
    writeFileSync(path.join(fixture, "source.txt"), "dirty bytes\n");
    assert.throws(() => assertCommittedWorkspace(fixture, commit, tree), /committed bytes/u);
    writeFileSync(path.join(fixture, "source.txt"), "committed\n");
    writeFileSync(path.join(fixture, "excluded.txt"), "untracked bytes\n");
    assert.throws(() => assertCommittedWorkspace(fixture, commit, tree), /committed bytes/u);
    writeFileSync(path.join(fixture, "source.txt"), "dirty bytes\n");
    const before = await git("status", "--porcelain=v1"),
      branch = await git("symbolic-ref", "HEAD");
    await assert.rejects(selectedSource(commit, false, fixture), /Dirty current work/u);
    const admitted = await selectedSource(commit, true, fixture);
    assert.equal(admitted.commit, commit);
    assert.equal(admitted.tree, tree);
    assert.equal(admitted.excluded_changes.length, 2);
    await assert.rejects(selectedSource("HEAD", true, fixture), /full committed SHA/u);
    await assert.rejects(selectedSource("0".repeat(40), true, fixture));
    assert.equal(await git("status", "--porcelain=v1"), before);
    assert.equal(await git("symbolic-ref", "HEAD"), branch);
    assert.equal(readFileSync(path.join(fixture, "source.txt"), "utf8"), "dirty bytes\n");
  } finally {
    assert.equal(path.dirname(fixture), path.join(root, "work"));
    rmSync(fixture, { recursive: true });
  }
});
test("task argv is literal, bounded and excludes host mounts, privileges and proxy credentials", () => {
  const run = "30000000-0000-4000-8000-000000000000",
    file = "src/literal $(nope); name.browser.test.tsx";
  const args = runtimeArguments({
    name: `portcove-browser-${run}`,
    run,
    image: "sha256:owned",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    mode: "exact",
    files: [file],
  });
  assert.deepEqual(args.slice(-3), ["sha256:owned", "exact", file]);
  for (const forbidden of [
    "--privileged",
    "--mount",
    "--volume",
    "--cap-add",
    "--network=host",
    "/var/run/docker.sock",
  ])
    assert(!args.includes(forbidden));
  for (const expected of [
    "no-new-privileges:true",
    "--cap-drop=ALL",
    "HTTP_PROXY=",
    "https_proxy=",
    "--pull=never",
  ])
    assert(args.includes(expected));
});
const runtime = () => ({
  Config: {
    User: "1000:1000",
    Env: ["PATH=/known", "VP_HOME=/home/vp/.vite-plus", "HTTP_PROXY=", "CI=true"],
  },
  Mounts: [],
  HostConfig: {
    NetworkMode: "none",
    Memory: 6 * 1024 ** 3,
    MemorySwap: 6 * 1024 ** 3,
    NanoCpus: 4e9,
    ShmSize: 1024 ** 3,
    PidsLimit: 1024,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
  },
});
test("actual runtime readback rejects widened authority and credential-bearing environments", () => {
  validateRuntime(runtime());
  for (const patch of [
    { Privileged: true },
    { Memory: 0 },
    { CapAdd: ["SYS_ADMIN"] },
    { NetworkMode: "host" },
    { SecurityOpt: [] },
    { IpcMode: "host" },
    { Devices: [{ PathOnHost: "/dev/fuse" }] },
  ]) {
    const changed = runtime();
    Object.assign(changed.HostConfig, patch);
    assert.throws(() => validateRuntime(changed));
  }
  for (const entry of [
    "TAURI_SIGNING_PRIVATE_KEY=secret",
    "HTTPS_PROXY=https://user:secret@proxy",
    "TOKEN=secret",
  ]) {
    const changed = runtime();
    changed.Config.Env.push(entry);
    assert.throws(() => validateRuntime(changed), /Unexpected/u);
  }
  const changed = runtime();
  changed.Mounts.push({ Source: "host-home" });
  assert.throws(() => validateRuntime(changed));
});
test("published bytes must remain verifiable before recovery resources can be cleaned", () => {
  mkdirSync(path.join(root, "work"), { recursive: true });
  const directory = mkdtempSync(path.join(root, "work/container-publication-"));
  const expected = {
    run: "fixture",
    source: { commit: "a".repeat(40), tree: "b".repeat(40) },
    image: "sha256:owned",
  };
  const bytes = Buffer.from("retained failure evidence\n");
  const manifest = {
    format_version: 1,
    run: expected.run,
    commit: expected.source.commit,
    tree: expected.source.tree,
    image: expected.image,
    files: [
      {
        path: "trace.zip",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  try {
    writeFileSync(path.join(directory, "trace.zip"), bytes);
    writeFileSync(path.join(directory, "publication.json"), JSON.stringify(manifest));
    verifyPublication(directory, expected);
    writeFileSync(path.join(directory, "trace.zip"), "replaced");
    assert.throws(() => verifyPublication(directory, expected), /changed/u);
    writeFileSync(path.join(directory, "trace.zip"), bytes);
    manifest.files[0].path = "../escaped.zip";
    writeFileSync(path.join(directory, "publication.json"), JSON.stringify(manifest));
    assert.throws(() => verifyPublication(directory, expected));
    manifest.files[0].path = "trace.zip";
    manifest.commit = "c".repeat(40);
    writeFileSync(path.join(directory, "publication.json"), JSON.stringify(manifest));
    assert.throws(() => verifyPublication(directory, expected), /identity/u);
  } finally {
    assert.equal(path.dirname(directory), path.join(root, "work"));
    rmSync(directory, { recursive: true });
  }
});

test("child failures and finite timeout retain original status, arguments and streams", async () => {
  await assert.rejects(
    command(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('cause'); process.exit(23)",
    ]),
    (error) => {
      assert.equal(error.result.status, 23);
      assert.equal(error.result.stdout, "out");
      assert.equal(error.result.stderr, "cause");
      return true;
    },
  );
  await assert.rejects(
    command(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 200 }),
    (error) => {
      assert.match(error.message, /exceeded 200 ms/u);
      assert.equal(error.result.command, process.execPath);
      return true;
    },
  );
  await assert.rejects(cleanup(false, -1), /Cleanup age/u);
});

test("a failing diagnostic sink does not replace the actual child failure", async () => {
  mkdirSync(path.join(root, "work"), { recursive: true });
  const directory = mkdtempSync(path.join(root, "work/container-sink-"));
  try {
    const broken = path.join(directory, "not-a-directory");
    writeFileSync(broken, "owned sink control");
    let primary;
    try {
      await command(process.execPath, [
        "-e",
        "process.stdout.write('partial');process.stderr.write('original cause');process.exit(23)",
      ]);
    } catch (error) {
      primary = error;
    }
    assert(primary);
    const state = {};
    saveFailure(state, primary, broken, () => {
      throw new Error("secondary sink control");
    });
    assert.equal(state.error, primary.message);
    assert.equal(state.failed_command.status, 23);
    assert.equal(state.failed_command.stdout, "partial");
    assert.equal(state.failed_command.stderr, "original cause");
    assert(state.diagnostic_error);
    assert.equal(state.status, "incomplete");
  } finally {
    assert.equal(path.dirname(directory), path.join(root, "work"));
    rmSync(directory, { recursive: true });
  }
});
