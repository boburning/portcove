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
if (config.titles.length) {
  assert.equal(sha(await readFile(config.cli)), config.cli_sha256);
  assert(config.global_chocolate_root, "Observed Windows roaming Known Folder is required");
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
if (config.titles.length) {
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
  for (const title of config.titles)
    assert(
      within(path.join(root, "originals"), title.original),
      "Qualification original must be a verified private copy",
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
  positiveExit = true,
  globalBefore = null;
const dataRoots = new Map(),
  players = new Map(),
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
  if (raw) {
    const dataRoot = dataRoots.get(args[1]);
    assert(dataRoot, "Missing observed managed data root");
    const marker = path.join(
      path.dirname(dataRoot),
      ".portcove-profiles",
      args[1],
      "restore-pending",
    );
    const state = await lstat(marker).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    assert(state === null, "Unreviewed profile state is outside this title scenario");
    await record(name + "-pre-spawn", {
      profile_marker_absent: true,
      canonical_data_root: dataRoot,
    });
  }
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
    const title = config.titles.find((t) => t.port === args[1]);
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
  if (raw) {
    const state = await globalState();
    await record(name + "-shared-profile", state);
    assert.deepEqual(state, globalBefore, "Shared Chocolate roaming profile changed");
  }
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
async function globalState() {
  if (!config.global_chocolate_root) return null;
  const root = config.global_chocolate_root;
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    "Shared profile root must be an ordinary directory for this observation",
  );
  const directories = [];
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true }))
      if (entry.isDirectory()) {
        const p = path.join(relative, entry.name),
          s = await lstat(path.join(root, p));
        assert(!s.isSymbolicLink());
        directories.push(p);
        assert(directories.length <= 4096);
        await visit(p);
      }
  }
  await visit();
  return { exists: true, directories: directories.sort(), files: await inventory(root) };
}
try {
  globalBefore = await globalState();
  await record("shared-profile-before", globalBefore);
  if (config.core_test) {
    assert.equal(sha(await readFile(config.core_test)), config.core_test_sha256);
    await mkdir(config.alias_temp, { recursive: false });
    for (const test of [
      "a_windows_short_file_alias_keeps_the_target_separate",
      "a_windows_short_directory_alias_is_not_a_publication_parent",
    ]) {
      const out = [],
        err = [];
      const child = spawn(
        config.core_test,
        ["carry_step::tests::" + test, "--exact", "--nocapture"],
        {
          env: { ...environment, TEMP: config.alias_temp, TMP: config.alias_temp },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      active = child;
      positiveExit = false;
      child.stdout.on("data", (b) => out.push(b));
      child.stderr.on("data", (b) => err.push(b));
      const [code, signal] = await once(child, "close");
      active = null;
      positiveExit = true;
      const stdout = Buffer.concat(out).toString(),
        stderr = Buffer.concat(err).toString();
      assert(stdout.length + stderr.length < 1024 * 1024, "alias fixture output exceeds bound");
      await writeFile(path.join(evidence, test + ".stdout.log"), stdout);
      await writeFile(path.join(evidence, test + ".stderr.log"), stderr);
      await record(test, {
        code,
        signal,
        test_binary_sha256: config.core_test_sha256,
        temporary_root: config.alias_temp,
        observed_alias: stderr.includes("PORTCOVE_CARRY_83_OBSERVED:"),
        preserved: stderr.includes(
          test.includes("_file_")
            ? "PORTCOVE_CARRY_83_FILE_PRESERVED"
            : "PORTCOVE_CARRY_83_DIRECTORY_PRESERVED",
        ),
        scope:
          "two explicit fixture replays; a passing skip does not establish the native alias branch",
      });
      assert.equal(code, 0, "alias fixture failed");
      assert(/1 passed/.test(stdout), "requested fixture did not execute");
      assert(
        stderr.includes("PORTCOVE_CARRY_83_OBSERVED:") &&
          stderr.includes(
            test.includes("_file_")
              ? "PORTCOVE_CARRY_83_FILE_PRESERVED"
              : "PORTCOVE_CARRY_83_DIRECTORY_PRESERVED",
          ),
        "Actual alias observation and preservation markers are mandatory; a conditional skip is not acceptance",
      );
    }
  }
  for (const title of config.titles) {
    assert.equal(sha(await readFile(title.original)), title.original_sha256);
    await command([
      "source",
      "add",
      title.profile,
      title.original,
      "--expected-sha256",
      title.original_sha256,
    ]);
    await command(["plan", title.port]);
    await command(["install", title.port]);
    const installed = await command(["status", title.port]);
    assert(
      installed.active?.path && installed.user_data_root,
      "missing managed installation/data ownership",
    );
    assert(
      within(config.library, installed.active.path) &&
        within(config.library, installed.user_data_root),
      "Managed paths escaped the private qualification library",
    );
    dataRoots.set(title.port, installed.user_data_root);
    players.set(title.port, path.join(installed.active.path, title.player));
    assert.equal(
      installed.active.artifact.sha256,
      title.package_sha256,
      "Installed publisher artifact differs",
    );
    await record(title.port + "-installed", installed);
    const preparedBefore = await inventory(installed.active.path);
    const profile = await command(["profile", "ensure-default", title.port]);
    assert(
      profile.is_default === true &&
        profile.port_id === title.port &&
        typeof profile.id === "string",
    );
    await command(["profile", "activate", title.port, profile.id], { expectedUnsupported: true });
    assert.deepEqual(
      await inventory(installed.active.path),
      preparedBefore,
      "Metadata creation or refused deployment changed prepared files",
    );
    await record(title.port + "-profile-boundary", {
      default_metadata_created: true,
      deployment_refused: true,
      prepared_files_unchanged: true,
    });
    await command(["exec", title.port], { raw: true });
    const after = await command(["status", title.port]);
    // Backup performs the maintained collection from the live runtime into canonical data.
    const backup = await command(["backup", "create", title.port]);
    assert(typeof backup.id === "string");
    const populated = await inventory(after.user_data_root);
    await record(title.port + "-collected", populated);
    assert(
      populated.some(
        (f) =>
          f.path.startsWith("savegames" + path.sep + title.original_sha256 + path.sep) &&
          f.bytes > 0 &&
          new RegExp(title.save_pattern, "i").test(f.path),
      ),
      "real populated save not observed",
    );
    await record(title.port + "-populated", populated);
    await command(["backup", "list", title.port]);
    await command(["exec", title.port], { raw: true });
    await command(["backup", "restore", title.port, backup.id, "--yes"]);
    const restored = await inventory(after.user_data_root);
    assert.deepEqual(restored, populated, "backup restore differs from populated data");
    await command(["check", title.port]);
    await command(["remove", title.port, "--yes"]);
    assert.deepEqual(
      await inventory(after.user_data_root),
      restored,
      "preserving removal changed managed data",
    );
    await command(["install", title.port]);
    await command(["exec", title.port], { raw: true });
    await command(["status", title.port]);
    assert.equal(sha(await readFile(title.original)), title.original_sha256);
    await record(title.port + "-result", {
      result: "completed",
      source_unchanged: true,
      backup_id: backup.id,
      scope:
        "actual Core CLI/public original lifecycle; visual save/menu observations require inspected screenshots; no retail/installed Desktop/update-switch acceptance",
    });
  }
  await record("result", {
    result: "completed",
    title_count: config.titles.length,
    scope: config.titles.length
      ? "public-original Core CLI lifecycle"
      : "two native filesystem fixtures only; no title execution",
    finished_at: new Date().toISOString(),
  });
} catch (error) {
  await record("result", {
    result: "failed",
    error: String(error),
    finished_at: new Date().toISOString(),
  });
  process.exitCode = 1;
} finally {
  await record("cleanup", {
    positive_managed_command_exit: active === null && positiveExit,
    native_release: "outer maintained supervisor owns admission until positive process-tree drain",
  });
}
