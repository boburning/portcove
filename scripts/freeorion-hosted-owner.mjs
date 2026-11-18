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
assert.equal(
  path.resolve(path.join(environment.APPDATA, "FreeOrion")).toLowerCase(),
  path.resolve(config.roaming).toLowerCase(),
  "Observed profile and engine APPDATA differ",
);
// Existing hosted native precedent: this VM has no physical audio endpoint.
environment.SDL_RENDER_DRIVER = "software";
environment.GALLIUM_DRIVER = "llvmpipe";
environment.LIBGL_ALWAYS_SOFTWARE = "1";
environment.SDL_OPENGL_LIBRARY = path.join(config.player_root, "opengl32.dll");
await record("hosted-drivers", {
  audio: "Upstream audio.effects.enabled=false/audio.music.enabled=false; default-device dialog retained from first run; no audio acceptance",
  renderer: "Mesa26.2.7 x64 llvmpipe requested through isolated app-local SDL_OPENGL_LIBRARY",
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
  const separator = raw ? args.indexOf("--") : -1;
  const effective = [
    ...(raw ? [] : ["--json"]),
    "--library",
    config.library,
    ...(separator < 0 ? args : args.slice(0, separator)),
    ...(raw ? ["--request-id", request] : []),
    ...(separator < 0 ? [] : args.slice(separator)),
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
        count === 0 ? "fresh" : count === 1 ? "singleplayer" : "reopen",
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
      raw ? 240000 : 120000,
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
          total <= 2 * 1024 ** 3 && files.length < 10000,
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
config.port = "freeorion";
players.set(config.port, config.player);
const prior = await lstat(config.roaming).catch((e) => {
  if (e.code === "ENOENT") return null;
  throw e;
});
assert(prior === null, "Fresh VM already has FreeOrion data; preserve it and refuse native execution");
assert.equal(
  await lstat(config.profile).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  }),
  null,
  "Fresh external profile already exists; preserve it and refuse",
);
// Explicit upstream settings for an isolated VM without a physical audio endpoint.
// Upstream reads persistent_config.xml without a version check; ordinary config.xml
// remains absent so its creation is actual client evidence, not the seeded fixture.
await mkdir(config.profile);
const initialSettings = Buffer.from(`<?xml version="1.0"?>
<XMLDoc>
  <audio><effects><enabled>0</enabled></effects><music><enabled>0</enabled></music></audio>
  <video><fullscreen><enabled>0</enabled></fullscreen><windowed><width>960</width><height>640</height><left>20</left><top>20</top></windowed></video>
</XMLDoc>
`);
await writeFile(path.join(config.profile, "persistent_config.xml"), initialSettings, { flag: "wx" });
await record("initial-host-configuration", {
  file: path.join(config.profile, "persistent_config.xml"), contents: initialSettings.toString(), sha256: sha(initialSettings),
  reason: "First run44411472697 showed an OpenAL initialization modal; upstream audio flags disable Enable. Window960x640 fits observed runner desktop.",
  scope: "muted visual/client and companion observations, not default-device/physical audio or minimum-host acceptance",
});
let completed = false;
try {
  await record("external-before-play", await inventory(config.player_root));
  const args = [config.port, config.player, "--working-directory", config.player_root];
  const preview = await command(["external", "select-preview", ...args]);
  await command([
    "external",
    "select",
    ...args,
    "--expected-preview",
    preview.preview_sha256,
    "--yes",
  ]);
  const selected = await command(["status", config.port]);
  assert(selected.readiness.launchable && selected.successful_launches === 0);
  await command(["exec", config.port], { raw: true });
  const settings = await lstat(path.join(config.profile, "config.xml"));
  assert(settings.isFile() && settings.size > 32, "Actual client did not write its settings");
  await record("profile-after-first-play", await inventory(config.profile));
  const quickstartArguments = ["--quickstart", "--setup.star.count", "10", "--setup.ai.player.count", "1", "--quit.hotkey", "GGK_F11"];
  async function reviewArguments(values) {
    const coordinates = [config.port, config.player, "--working-directory", config.player_root, ...values.flatMap((value) => ["--arg", value])];
    const reviewed = await command(["external", "select-relink-preview", ...coordinates]);
    await command(["external", "select-relink", ...coordinates, "--expected-preview", reviewed.preview_sha256, "--yes"]);
    const current = await command(["status", config.port]);
    assert.deepEqual(current.external_runtime.user_selected.arguments, values, "Reviewed execution intent differs");
  }
  // Selected runtimes execute only reviewed arguments; do not forward unreviewed extras.
  await reviewArguments(quickstartArguments);
  await command(["exec", config.port], { raw: true });
  await reviewArguments([]);
  await command(["exec", config.port], { raw: true });

  const packageBefore = await inventory(config.player_root),
    profileBefore = await inventory(config.profile);
  assert.equal(
    sha(await readFile(config.player)),
    config.player_sha256,
    "Selected client identity changed",
  );
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
  assert(!removed.external_runtime);
  assert.deepEqual(await inventory(config.player_root), packageBefore);
  assert.deepEqual(await inventory(config.profile), profileBefore);
  await record("external-removal-preservation", {
    runtime: packageBefore,
    profile: profileBefore,
    unchanged: true,
  });
  completed = true;
  await record("result", {
    completed: true,
    scope:
      "Windows x64 FreeOrion0.5.1.2 native client; ordinary external registration, explicit Play with default arguments, one quickstart/AI observation, then default-argument reopen, normal owned window close, real settings and complete external byte preservation through registration-only removal. Client UI requires image inspection. Muted audio-disabled test configuration; no earned progress, load/save correctness, installed Desktop, default sound-device/physical audio, physical hardware or sibling-native claim. Companion observations are separately recorded; whole-family supervision is not offered.",
  });
} finally {
  await record("cleanup", {
    positive_managed_command_exit: positiveExit,
    completed,
    active_command: active?.pid ?? null,
  });
}
