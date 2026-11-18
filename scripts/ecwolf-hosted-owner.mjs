// Private, finite qualification helper; not a product entrypoint or planning authority.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const helper = fileURLToPath(import.meta.url);
const configFile = process.argv[2] ?? path.join(path.dirname(helper), "native-config.json");
const root = path.dirname(configFile);
const config = JSON.parse(await readFile(configFile, "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
if (config.player) {
  assert.equal(sha(await readFile(config.cli)), config.cli_sha256);
}
const within = (parent, child) => {
  const absolute = (value) =>
    process.platform === "win32" ? path.toNamespacedPath(path.resolve(value)) : path.resolve(value);
  const relative = path.relative(absolute(parent), absolute(child));
  return (
    relative !== "" &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};
if (config.player) {
  assert(
    within(root, config.library),
    "Qualification library must be below this private helper directory",
  );
  const existing = await lstat(config.library).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  assert(
    existing === null,
    "Fresh qualification library already exists; preserve it and select another private run",
  );
}
const evidence = config.evidence_dir ?? path.join(root, "evidence");
await mkdir(evidence, { recursive: true });
const record = async (name, value) =>
  writeFile(path.join(evidence, name + ".json"), JSON.stringify(value, null, 2) + "\n");
await record("identity", {
  ...config,
  started_at: new Date().toISOString(),
  os: process.platform,
  os_release: os.release(),
  os_version: os.version(),
  arch: process.arch,
  node: process.version,
  helper_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
});
const environment = {};
for (const key of [
  "SystemRoot",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PORTCOVE_RESOURCE_RESERVATION",
])
  if (process.env[key]) environment[key] = process.env[key];
if (config.ui_helper)
  assert(
    environment.PATHEXT?.split(";").some((x) => x.toLowerCase() === ".exe"),
    "Windows executable resolution environment is required for the owned UI observer",
  );
// Existing hosted native precedent: this VM has no physical audio endpoint.
environment.SDL_AUDIODRIVER = "dummy";
environment.SDL_RENDER_DRIVER = "software";
await record("hosted-drivers", {
  audio: "SDL dummy",
  renderer: "SDL software requested",
  scope: "visual/state lifecycle only; physical audio and hardware rendering not established",
});
environment.PORTCOVE_PREFERENCES = path.join(root, "preferences.json");
environment.PORTCOVE_APPLICATION_RUNTIME_LOCK = path.join(root, "application-runtime.lock");
let serial = 0,
  active = null,
  positiveExit = true;
const players = new Map(),
  launchCounts = new Map(),
  uiAttempts = [];
async function command(args, { raw = false, expectedUnsupported = false } = {}) {
  const name = String(++serial).padStart(2, "0") + "-" + args.slice(0, 2).join("-");
  const request = raw ? randomUUID() : null;
  const effective = [
    ...(raw ? [] : ["--json"]),
    "--library",
    config.library,
    ...args,
    ...(raw ? ["--request-id", request] : []),
  ];
  await record("phase", { name, args, request, started_at: new Date().toISOString() });
  if (raw && config.ui_helper) {
    uiAttempts.push(name);
    await record("ui-attempts", { prefixes: uiAttempts });
  }
  const out = [],
    err = [];
  let bytes = 0;
  const child = spawn(config.cli, effective, {
    env: environment,
    windowsHide: !raw,
    stdio: ["ignore", "pipe", "pipe"],
  });
  active = child;
  positiveExit = false;
  let rootExited = false;
  child.once("exit", () => {
    rootExited = true;
  });
  // Root exit and inherited pipe closure are distinct observations on Windows.
  const rootClosed = once(child, "close");
  let driver = null,
    driverOutcome = null;
  if (raw && config.ui_helper) {
    const title = { port: config.port, player_sha256: config.player_sha256 };
    const count = launchCounts.get(title.port) ?? 0;
    launchCounts.set(title.port, count + 1);
    driver = spawn(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        config.ui_helper,
        "-Cli",
        config.cli,
        "-Library",
        config.library,
        "-RequestId",
        request,
        "-RootPid",
        String(child.pid),
        "-ExpectedPlayer",
        players.get(title.port),
        "-ExpectedSha256",
        title.player_sha256,
        "-TitleMode",
        count === 0 ? "fresh" : "reopen",
        "-Evidence",
        evidence,
        "-Prefix",
        name,
      ],
      { env: environment, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    const errors = [];
    driver.stderr.on("data", (b) => errors.push(b));
    driverOutcome = once(driver, "close").then(async ([code, signal]) => {
      const bytes = Buffer.concat(errors);
      if (bytes.length) await writeFile(path.join(evidence, name + "-ui.stderr.log"), bytes);
      return { code, signal };
    });
  }
  child.stdout.on("data", (b) => {
    bytes += b.length;
    if (bytes < 16 * 1024 * 1024) out.push(b);
  });
  child.stderr.on("data", (b) => {
    bytes += b.length;
    if (bytes < 16 * 1024 * 1024) err.push(b);
  });
  let code, signal, driven, deadline;
  const timedOut = new Promise((_, reject) => {
    deadline = setTimeout(
      () => reject(new Error("Managed command/pipe drain deadline exceeded")),
      raw ? 150000 : 120000,
    );
  });
  const driverFailed = driverOutcome
    ? driverOutcome.then((outcome) => {
        if (outcome.code !== 0)
          throw new Error("Owned UI driver failed; descendant exit requires retained proof");
        return new Promise(() => {});
      })
    : new Promise(() => {});
  try {
    const outcomes = await Promise.race([
      Promise.all([rootClosed, driverOutcome]),
      driverFailed,
      timedOut,
    ]);
    [code, signal] = outcomes[0];
    driven = outcomes[1];
  } catch (error) {
    // Close only our reader handles. Never infer descendant exit from root exit,
    // or kill by PID/name to make cleanup appear complete.
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    if (driver) {
      driver.stderr.destroy();
      driver.unref();
    }
    await writeFile(path.join(evidence, name + ".stdout.log"), Buffer.concat(out));
    if (err.length) await writeFile(path.join(evidence, name + ".stderr.log"), Buffer.concat(err));
    await record(name + "-incomplete", {
      error: String(error),
      root_exited: rootExited,
      descendant_exit: "requires UI cleanup proof",
      observed_bytes: bytes,
    });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  active = null;
  positiveExit = true;
  const stdout = Buffer.concat(out),
    stderr = Buffer.concat(err);
  await writeFile(path.join(evidence, name + ".stdout.log"), stdout);
  if (stderr.length) await writeFile(path.join(evidence, name + ".stderr.log"), stderr);
  await record(name, {
    args,
    request,
    code,
    signal,
    driver: driven,
    stdout_sha256: sha(stdout),
    stderr_sha256: sha(stderr),
    observed_bytes: bytes,
    expected_unsupported: expectedUnsupported,
    finished_at: new Date().toISOString(),
  });
  assert(bytes < 16 * 1024 * 1024, "CLI evidence output bound exceeded");
  if (expectedUnsupported) {
    assert(
      !raw && args[0] === "profile" && args[1] === "activate",
      "Only the explicit profile activation refusal is an expected failure",
    );
    assert.notEqual(code, 0, "Unsupported deployment unexpectedly succeeded");
    const result = JSON.parse(stdout.toString());
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "unsupported");
    assert(result.error.message.includes("no reviewed mod package contract"));
    return result.error;
  }
  assert.equal(code, 0, `${name} failed; inspect retained logs`);
  if (raw) {
    if (driven) assert.equal(driven.code, 0, "Owned UI driver did not establish its outcome");
    return;
  }
  const result = JSON.parse(stdout.toString());
  assert.equal(result.ok, true, `${name} returned failure envelope`);
  return result.data;
}
async function inventory(directory) {
  const files = [];
  let total = 0;
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const p = path.join(relative, entry.name),
        info = await lstat(path.join(directory, p));
      assert(!info.isSymbolicLink(), "unexpected link in owned data");
      if (info.isDirectory()) await visit(p);
      else {
        assert(info.isFile() && info.nlink === 1, "unexpected nonregular or hardlinked owned data");
        total += info.size;
        assert(
          total <= 128 * 1024 * 1024 && files.length < 4096,
          "owned data inventory bound exceeded",
        );
        files.push({
          path: p,
          bytes: info.size,
          sha256: sha(await readFile(path.join(directory, p))),
        });
      }
    }
  }
  await visit();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
config.port = "ecwolf-wolfenstein3d";
players.set(config.port, config.player);
async function missing(directory) {
  const info = await lstat(directory).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  assert(
    info === null,
    "Fresh VM unexpectedly contains ECWolf profile; no existing data may be touched",
  );
}
for (const dir of [config.roaming, config.saves]) await missing(dir);
let success = false;
try {
  const inputsBefore = await inventory(config.player_root);
  await record("external-before", inputsBefore);
  const selectArgs = [
    config.port,
    config.player,
    "--working-directory",
    config.player_root,
    "--arg=--data",
    "--arg=WL1",
  ];
  const preview = await command(["external", "select-preview", ...selectArgs]);
  await command([
    "external",
    "select",
    ...selectArgs,
    "--expected-preview",
    preview.preview_sha256,
    "--yes",
  ]);
  const selected = await command(["status", config.port]);
  assert(selected.readiness.launchable && selected.successful_launches === 0);
  await command(["play", config.port], { raw: true });
  const savesAfterFirst = await inventory(config.saves);
  assert(
    savesAfterFirst.some((f) => /savegam[0-9]+\.ecs$/i.test(f.path) && f.bytes > 1000),
    "No engine-created ECWolf save",
  );
  await record("saves-after-first", savesAfterFirst);
  await command(["play", config.port], { raw: true });
  const saveBeforeRemove = await inventory(config.saves),
    profileBeforeRemove = await inventory(config.roaming),
    playerBeforeRemove = await inventory(config.player_root);
  assert.deepEqual(saveBeforeRemove, savesAfterFirst, "Reopen changed earned save bytes");
  const removal = await command(["external", "removal-preview", config.port]);
  await command([
    "external",
    "remove",
    config.port,
    "--expected-preview",
    removal.preview_sha256,
    "--yes",
  ]);
  const removed = await command(["status", config.port]);
  assert(!removed.external_runtime, "Registration remained after removal");
  assert.deepEqual(await inventory(config.saves), saveBeforeRemove);
  assert.deepEqual(await inventory(config.roaming), profileBeforeRemove);
  assert.deepEqual(await inventory(config.player_root), playerBeforeRemove);
  assert.deepEqual(playerBeforeRemove, inputsBefore, "External runtime or original inputs changed");
  await record("external-removal-preservation", {
    runtime: playerBeforeRemove,
    profile: profileBeforeRemove,
    saves: saveBeforeRemove,
    unchanged: true,
  });
  success = true;
  await record("result", {
    completed: true,
    scope:
      "Windows x64 ECWolf 1.4.2 public Wolfenstein 3D v1.4 shareware; external registration, explicit Play, save/reopen and registration-only removal; visual claim pending image inspection; no retail, managed maintenance, installed Desktop, physical hardware or sibling OS claim",
  });
} finally {
  await record("cleanup", {
    positive_managed_command_exit: positiveExit,
    completed: success,
    active_command: active?.pid ?? null,
  });
}
