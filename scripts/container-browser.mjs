import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimumFreeGiB, preflight, resolvePhysicalPath } from "./dev-storage.mjs";
import {
  ensureRetainedEvidenceStore,
  retainedEvidenceRoot,
  validateEvidenceStore,
} from "./retained-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const workspace = hash(resolvePhysicalPath(root).toLowerCase());
const tool = "browser-v1";
const stageRoot = path.join(root, "work/container-browser");
const evidenceRoot = path.join(
  retainedEvidenceRoot(path.join(root, "outputs")),
  "container-browser",
);
const recipe = path.join(root, "tools/containers/browser/Dockerfile");
const entry = path.join(root, "scripts/container-entry.mjs");
const GiB = 1024 ** 3;
export const budgets = Object.freeze({
  timeout_ms: 30 * 60_000,
  setup_ms: 30 * 60_000,
  cpus: 4,
  memory: "6g",
  shm: "1g",
  pids: 1024,
  bundle_bytes: 256 * 1024 ** 2,
  staging_bytes: 10 * GiB,
  evidence_bytes: 10 * GiB,
  images_bytes: 40 * GiB,
  global_images_bytes: 80 * GiB,
  image_bytes: 10 * GiB,
  build_cache_bytes: 40 * GiB,
  command_output_bytes: 16 * 1024 ** 2,
  retention_hours: 72,
});

export function command(commandName, args, { cwd = root, timeout = 15_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [[], []];
    let bytes = 0;
    let problem;
    let force;
    const stop = (reason) => {
      problem ??= reason;
      child.kill();
      force ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(
      () => stop(new Error(`${commandName} exceeded ${timeout} ms`)),
      timeout,
    );
    const abort = () => stop(new Error(`${commandName} interrupted`));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const [index, stream] of [child.stdout, child.stderr].entries())
      stream.on("data", (data) => {
        bytes += data.length;
        if (bytes > budgets.command_output_bytes)
          stop(new Error(`${commandName} output exceeded 16 MiB`));
        else chunks[index].push(data);
      });
    child.on("error", (error) => {
      problem ??= error;
    });
    child.on("close", (status, childSignal) => {
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      const result = {
        command: commandName,
        args,
        cwd,
        status,
        signal: childSignal,
        stdout: Buffer.concat(chunks[0]).toString("utf8"),
        stderr: Buffer.concat(chunks[1]).toString("utf8"),
      };
      if (problem || status !== 0)
        reject(
          Object.assign(
            problem ?? new Error(`${commandName} failed (${status}): ${result.stderr.trim()}`),
            { result },
          ),
        );
      else resolve(result);
    });
  });
}
const docker = (args, options) =>
  command("docker", ["--context", "desktop-linux", ...args], options);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const record = (file, value) => {
  writeFileSync(`${file}.next`, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  renameSync(`${file}.next`, file);
};
const git = async (args, cwd = root) => (await command("git", args, { cwd })).stdout.trim();

export function validateEngine(info, context) {
  if (
    context?.Endpoints?.docker?.Host?.toLowerCase() !== "npipe:////./pipe/dockerdesktoplinuxengine"
  )
    throw new Error(
      "Use the local Docker Desktop desktop-linux context; remote and alternate engines are excluded",
    );
  if (
    info.OSType !== "linux" ||
    info.OperatingSystem !== "Docker Desktop" ||
    !/microsoft.*WSL2/iu.test(info.KernelVersion ?? "") ||
    !["x86_64", "amd64"].includes(info.Architecture)
  )
    throw new Error("This browser adapter requires Docker Desktop's WSL 2 Linux x86-64 engine");
}

export function validateDesktop(status) {
  if (status?.Status !== "running" || status.PauseType)
    throw new Error(
      "Docker Desktop engine is stopped, paused or in Resource Saver. Explicitly exit Resource Saver in Desktop before execution; starting an already-running UI may not resume the engine. The preflight never wakes it or changes global settings",
    );
}

// Use the running Desktop backend's resolved settings, rather than guessing a
// default disk or accepting an unrelated user-supplied path as backing evidence.
export function diskFromSettings(log, settingsModified, home) {
  for (const line of log.split("\n").reverse()) {
    if (!line.includes("GET /app/settings/gui") || !line.includes("): {")) continue;
    const timestamp = /^\[([^\]]+)\]/u.exec(line)?.[1];
    if (!(Date.parse(timestamp) >= settingsModified))
      throw new Error(
        "Docker resolved settings predate its saved configuration; refresh Desktop settings before retrying",
      );
    const current = JSON.parse(line.slice(line.indexOf("): {") + 3)).settings;
    if (current?.["vm.hypervisor.windows"] !== "wsl2")
      throw new Error("Docker Desktop is not configured for WSL 2");
    let folder = current["vm.resources.wslDataFolder"];
    if (typeof folder !== "string") throw new Error("Docker did not report its WSL data folder");
    folder = folder.replace(/^<HOME>/u, home);
    if (!path.win32.isAbsolute(folder) || folder.includes("<"))
      throw new Error("Unknown Docker WSL data-folder form");
    return {
      settings_at: timestamp,
      folder,
      vhd: path.win32.join(folder, "disk/docker_data.vhdx"),
    };
  }
  throw new Error(
    "Cannot establish Docker's active WSL disk from resolved settings; open Desktop Settings to refresh the read-only record",
  );
}

function tail(file, limit = 2 * 1024 ** 2) {
  // Backend logs rotate at about 1 MiB. Refuse unexpectedly large input rather
  // than loading a growing diagnostic archive into the preflight.
  if (statSync(file).size > limit) throw new Error(`Docker settings log exceeds ${limit} bytes`);
  return readFileSync(file, "utf8");
}
function size(directory) {
  if (!existsSync(directory)) return 0;
  let total = 0;
  let files = 0;
  function visit(current) {
    const details = lstatSync(current);
    if (details.isSymbolicLink())
      throw new Error(`Owned storage refuses linked entries: ${current}`);
    if (details.isFile()) {
      total += details.size;
      if (++files > 100_000) throw new Error("Owned storage inventory exceeds 100000 files");
    } else if (details.isDirectory())
      for (const name of readdirSync(current)) visit(path.join(current, name));
    else throw new Error(`Owned storage refuses special entry: ${current}`);
  }
  visit(directory);
  return total;
}
async function network() {
  const endpoints = [
    ["https://ghcr.io/v2/", [200, 401], "GET"],
    ["https://registry.npmjs.org/", [200]],
    ["https://nodejs.org/dist/index.json", [200]],
    ["https://cdn.playwright.dev/", [400]],
    ["https://deb.debian.org/debian/dists/bookworm/Release", [200]],
    ["https://security.debian.org/debian-security/dists/bookworm-security/Release", [200]],
  ];
  const observations = await Promise.all(
    endpoints.map(async ([url, allowed, method = "HEAD"]) => {
      try {
        const response = await fetch(url, { method, signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        return {
          url,
          method,
          status: response.status,
          reachable: allowed.includes(response.status),
          purpose:
            "HTTPS service reachability only; frozen preparation verifies actual payload availability",
        };
      } catch (error) {
        return { url, reachable: false, error: error.message };
      }
    }),
  );
  if (observations.some((item) => !item.reachable))
    throw Object.assign(
      new Error(
        "Required container download endpoints are unreachable; no host configuration was changed",
      ),
      { observations },
    );
  return observations;
}

export function linuxStorage(output, floor = minimumFreeGiB()) {
  const matches = output
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((columns) => columns.at(-1) === "/mnt/docker-desktop-disk");
  const available = matches.length === 1 ? Number(matches[0][3]) * 1024 : NaN;
  if (!Number.isFinite(available) || available < floor * GiB)
    throw Object.assign(
      new Error("Docker Linux backing filesystem is unknown or below the storage floor"),
      { observation: output },
    );
  return available;
}
export function cacheBytes(output, kind = "Build Cache") {
  const rows = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const row = rows.find((item) => item.Type === kind);
  const size = /^(\d+(?:\.\d+)?)(B|kB|MB|GB|TB)$/u.exec(row?.Size ?? "");
  if (!size) throw new Error("Unknown Docker build-cache usage; preparation refused");
  return Math.ceil(Number(size[1]) * 1000 ** ["B", "kB", "MB", "GB", "TB"].indexOf(size[2]));
}
export async function doctor({ networkRequired = true } = {}) {
  if (process.versions.node !== readFileSync(path.join(root, ".node-version"), "utf8").trim())
    throw new Error("Use the repository-pinned Node version for the optional host adapter");
  if (process.platform !== "win32")
    throw new Error(
      "Run this optional host adapter from Windows; native Linux development remains separate",
    );
  let info;
  let context;
  let desktop;
  try {
    desktop = JSON.parse((await docker(["desktop", "status", "--format", "json"])).stdout);
    validateDesktop(desktop);
    info = JSON.parse((await docker(["info", "--format", "json"])).stdout);
    context = JSON.parse((await docker(["context", "inspect", "desktop-linux"])).stdout)[0];
  } catch (error) {
    throw new Error(
      `Docker Desktop is missing, stopped or inaccessible. Start the installed WSL 2 Linux engine explicitly; this preflight changes no host settings. ${error.message}`,
      { cause: error },
    );
  }
  validateEngine(info, context);
  if (
    !Number.isFinite(Date.parse(info.SystemTime)) ||
    Math.abs(Date.now() - Date.parse(info.SystemTime)) > 60_000
  )
    throw new Error(
      "Docker info is stale or its clock is unknown; do not admit work from Resource Saver's cached API response",
    );
  const local = path.join(process.env.LOCALAPPDATA, "Docker");
  const settings = path.join(process.env.APPDATA, "Docker/settings-store.json");
  const disk = diskFromSettings(
    tail(path.join(local, "log/host/com.docker.backend.exe.log")),
    statSync(settings).mtimeMs,
    os.homedir(),
  );
  const physical = realpathSync.native(disk.vhd);
  if (!lstatSync(physical).isFile())
    throw new Error("Docker's resolved virtual disk is not a regular file");
  const storage = preflight(
    {
      workspace: root,
      staging: stageRoot,
      exports: evidenceRoot,
      docker_disk: path.dirname(physical),
    },
    minimumFreeGiB(),
  );
  await validateEvidenceStore(evidenceRoot);
  const linux = await command("wsl.exe", [
    "--distribution",
    "docker-desktop",
    "--exec",
    "df",
    "-Pk",
    "/mnt/docker-desktop-disk",
  ]);
  const linuxFree = linuxStorage(linux.stdout);
  const stagingBytes = size(stageRoot);
  const evidenceBytes = size(evidenceRoot);
  if (stagingBytes >= budgets.staging_bytes || evidenceBytes >= budgets.evidence_bytes)
    throw new Error(
      "Owned container staging/evidence budget exhausted; inspect scoped cleanup and retained failures",
    );
  return {
    format_version: 1,
    read_only: true,
    observed_at: new Date().toISOString(),
    desktop,
    engine: {
      version: info.ServerVersion,
      os: info.OSType,
      architecture: info.Architecture,
      kernel: info.KernelVersion,
    },
    disk: { ...disk, physical, file_length_bytes: statSync(physical).size },
    storage,
    linux: { available_bytes: linuxFree, observation: linux.stdout },
    network: networkRequired
      ? await network()
      : { checked: false, reason: "Recovery export requires no downloads" },
    budgets,
    usage: { staging_bytes: stagingBytes, evidence_bytes: evidenceBytes },
  };
}

export async function selectedSource(commit, excludeDirty = false, repository = root) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? ""))
    throw new Error(
      "Select one full committed SHA with --commit; dirty/current work is not synchronized",
    );
  if ((await git(["rev-parse", "--verify", `${commit}^{commit}`], repository)) !== commit)
    throw new Error("Selected source is not the requested commit");
  const excluded = (
    await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repository })
  ).stdout.trimEnd();
  if (excluded && !excludeDirty)
    throw new Error(
      "Dirty current work is excluded: pass --exclude-dirty with an explicit committed selection, or finish your own work normally",
    );
  return {
    commit,
    tree: await git(["rev-parse", `${commit}^{tree}`], repository),
    checkout_head: await git(["rev-parse", "HEAD"], repository),
    excluded_changes: excluded.split("\n").filter(Boolean),
  };
}
function owned(info, run) {
  const labels = info.Config?.Labels ?? info.Labels ?? {};
  if (
    labels["io.portcove.tool"] !== tool ||
    labels["io.portcove.workspace"] !== workspace ||
    (run && labels["io.portcove.run"] !== run)
  )
    throw new Error("Container/image ownership does not match this workspace and run");
  return labels;
}
async function inspectContainer(id, run) {
  const info = JSON.parse((await docker(["container", "inspect", id])).stdout)[0];
  owned(info, run);
  return info;
}
export function runtimeArguments({ name, run, image, commit, tree, mode, files = [] }) {
  if (!/^portcove-browser-[0-9a-f-]{36}$/u.test(name))
    throw new Error("Invalid owned container name");
  return [
    "create",
    "--name",
    name,
    "--pull=never",
    "--platform",
    "linux/amd64",
    "--user",
    "1000:1000",
    "--init",
    "--network",
    "none",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--cpus",
    String(budgets.cpus),
    "--memory",
    budgets.memory,
    "--memory-swap",
    budgets.memory,
    "--shm-size",
    budgets.shm,
    "--pids-limit",
    String(budgets.pids),
    "--label",
    `io.portcove.tool=${tool}`,
    "--label",
    `io.portcove.workspace=${workspace}`,
    "--label",
    `io.portcove.run=${run}`,
    ...[
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
    ].flatMap((key) => ["--env", `${key}=`]),
    "--env",
    `PORTCOVE_CONTAINER_RUN=${run}`,
    "--env",
    `PORTCOVE_CONTAINER_IMAGE=${image}`,
    "--env",
    `PORTCOVE_CONTAINER_COMMIT=${commit}`,
    "--env",
    `PORTCOVE_CONTAINER_TREE=${tree}`,
    image,
    mode,
    ...files,
  ];
}

export function validateRuntime(info) {
  const host = info.HostConfig;
  if (
    info.Config.User !== "1000:1000" ||
    info.Mounts.length ||
    host.Privileged ||
    host.CapAdd?.length ||
    host.NetworkMode !== "none" ||
    host.PidMode ||
    host.IpcMode === "host" ||
    host.Devices?.length ||
    host.Memory !== 6 * GiB ||
    host.MemorySwap !== 6 * GiB ||
    host.NanoCpus !== 4e9 ||
    host.ShmSize !== GiB ||
    host.PidsLimit !== budgets.pids ||
    !host.CapDrop?.includes("ALL") ||
    !host.SecurityOpt?.includes("no-new-privileges:true")
  )
    throw new Error(
      "Actual container isolation/resource configuration differs from the browser contract",
    );
  const allowed = new Set([
    "PATH",
    "VP_HOME",
    "CI",
    "VP_GIT_HOOKS",
    "PORTCOVE_CONTAINER_RUN",
    "PORTCOVE_CONTAINER_IMAGE",
    "PORTCOVE_CONTAINER_COMMIT",
    "PORTCOVE_CONTAINER_TREE",
  ]);
  for (const variable of info.Config.Env) {
    const separator = variable.indexOf("="),
      key = variable.slice(0, separator),
      value = variable.slice(separator + 1);
    if (/^(?:https?|all|no)_proxy$/iu.test(key) && value === "") continue;
    if (
      (key === "HOME" && value === "/home/vp") ||
      (key === "HOSTNAME" && value === info.Config.Hostname)
    )
      continue;
    if (!allowed.has(key)) throw new Error(`Unexpected runtime environment key: ${key}`);
  }
}

function initializeStage(create = true) {
  const marker = path.join(stageRoot, "owner.json");
  if (existsSync(stageRoot)) {
    const owner = json(marker);
    if (owner.tool !== tool || owner.workspace !== workspace)
      throw new Error("Unknown container staging owner");
  } else {
    if (!create) return false;
    mkdirSync(stageRoot, { recursive: true });
    writeFileSync(marker, JSON.stringify({ tool, workspace }), { flag: "wx" });
  }
  return true;
}
async function imageUsage() {
  const ids = (
    await docker([
      "image",
      "ls",
      "--filter",
      `label=io.portcove.tool=${tool}`,
      "--filter",
      `label=io.portcove.workspace=${workspace}`,
      "--no-trunc",
      "--quiet",
    ])
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  const images = [];
  for (const id of new Set(ids)) {
    const info = JSON.parse((await docker(["image", "inspect", id])).stdout)[0];
    owned(info);
    images.push(info);
  }
  return { images, bytes: images.reduce((sum, info) => sum + info.Size, 0) };
}

async function exportRun(state, directory) {
  await ensureRetainedEvidenceStore(evidenceRoot);
  const container = await inspectContainer(state.container, state.run);
  if (container.State.Running)
    throw new Error("Refusing export while the task container is active");
  const destination = path.join(evidenceRoot, state.run);
  if (existsSync(destination))
    throw new Error("An evidence destination already exists; refusing overwrite");
  const partial = path.join(directory, `export-partial-${randomUUID()}`);
  mkdirSync(partial);
  const logs = await docker(["logs", "--timestamps", state.container]);
  writeFileSync(path.join(partial, "docker.stdout.log"), logs.stdout);
  writeFileSync(path.join(partial, "docker.stderr.log"), logs.stderr);
  if (existsSync(path.join(directory, "build.log")))
    copyFileSync(path.join(directory, "build.log"), path.join(partial, "build.log"));
  await docker(["cp", `${state.container}:/workspace/work/container-results/.`, partial], {
    timeout: 60_000,
  });
  if (size(partial) > GiB)
    throw new Error("Export exceeds 1 GiB; recover the labelled container and partial directory");
  const result = json(path.join(partial, "result.json"));
  if (
    result.run !== state.run ||
    result.commit !== state.source.commit ||
    result.tree !== state.source.tree ||
    result.image !== state.image
  )
    throw new Error("Exported run/source/image identity mismatch");
  if (!["passed", "failed", "interrupted"].includes(result.status))
    throw new Error("Container report is incomplete; retain it for recovery");
  if (result.export_error)
    throw new Error(
      `Container evidence capture was incomplete: ${result.export_error}; retain raw task paths for recovery`,
    );
  if (
    result.uid !== 1000 ||
    result.platform !== "linux" ||
    result.architecture !== "x64" ||
    (result.status === "passed" && (!result.fresh_execution || result.command_exit !== 0))
  )
    throw new Error("Container execution identity or fresh-result contract failed");
  for (const artifact of result.artifacts) {
    const file = path.resolve(partial, artifact.path);
    const relative = path.relative(partial, file);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !lstatSync(file).isFile() ||
      statSync(file).size !== artifact.bytes ||
      hash(readFileSync(file)) !== artifact.sha256
    )
      throw new Error("Exported artifact identity/containment failed");
  }
  writeFileSync(
    path.join(partial, "host.json"),
    JSON.stringify({ ...state, container_inspection: container }, null, 2),
  );
  // Destination and staging were physically checked; publishing copies bytes,
  // rather than moving across volumes or deleting the sole recoverable source.
  const publishing = path.join(evidenceRoot, `${state.run}.partial-${randomUUID()}`);
  mkdirSync(publishing);
  function publish(from, to) {
    for (const item of readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, item.name),
        b = path.join(to, item.name);
      if (item.isDirectory()) {
        mkdirSync(b);
        publish(a, b);
      } else copyFileSync(a, b, 1);
    }
  }
  publish(partial, publishing);
  const inventory = [];
  function inventoryFiles(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) inventoryFiles(file);
      else
        inventory.push({
          path: path.relative(publishing, file),
          bytes: statSync(file).size,
          sha256: hash(readFileSync(file)),
        });
    }
  }
  inventoryFiles(publishing);
  writeFileSync(
    path.join(publishing, "publication.json"),
    JSON.stringify(
      {
        format_version: 1,
        run: state.run,
        commit: state.source.commit,
        tree: state.source.tree,
        image: state.image,
        files: inventory,
      },
      null,
      2,
    ),
  );
  if (existsSync(destination))
    throw new Error("Evidence publication destination appeared; refusing overwrite");
  renameSync(publishing, destination);
  state.export_complete = true;
  state.export = destination;
  state.result = result;
  return result;
}

export function verifyPublication(directory, expected) {
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Published evidence directory is linked");
  const manifest = json(path.join(directory, "publication.json"));
  if (
    manifest.format_version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.run !== expected.run ||
    manifest.commit !== expected.source.commit ||
    manifest.tree !== expected.source.tree ||
    manifest.image !== expected.image
  )
    throw new Error("Published evidence identity is unavailable or changed");
  for (const item of manifest.files) {
    const file = path.resolve(directory, item.path),
      relative = path.relative(directory, file);
    const physical = path.relative(realpathSync.native(directory), realpathSync.native(file));
    if (physical.startsWith("..") || path.isAbsolute(physical))
      throw new Error("Published evidence escapes physical containment");
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      lstatSync(file).isSymbolicLink() ||
      !lstatSync(file).isFile() ||
      statSync(file).size !== item.bytes ||
      hash(readFileSync(file)) !== item.sha256
    )
      throw new Error(
        "Published evidence bytes or containment changed; preserve recovery resources",
      );
  }
  return manifest;
}

export function saveFailure(state, error, directory, save) {
  state.execution_status = state.status ?? null;
  state.status = "incomplete";
  state.error = error.message;
  if (error.result) {
    let saved = false;
    try {
      writeFileSync(
        path.join(directory, "failed-command.log"),
        error.result.stdout + error.result.stderr,
      );
      saved = true;
    } catch (sink) {
      state.diagnostic_error = sink.message;
    }
    state.failed_command = {
      ...error.result,
      stdout: saved ? undefined : error.result.stdout,
      stderr: saved ? undefined : error.result.stderr,
    };
  }
  try {
    save();
  } catch (sink) {
    console.error(`Secondary state-write failure: ${sink.message}`);
  }
}

export async function browser({
  commit,
  excludeDirty = false,
  mode = "suite",
  files = [],
  timeout = budgets.timeout_ms,
}) {
  if (
    !["suite", "probe", "exact"].includes(mode) ||
    (mode === "exact" ? !files.length : files.length) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 100 ||
    timeout > budgets.timeout_ms
  )
    throw new Error("Use suite, probe or exact files and a finite timeout of 100..1800000 ms");
  const source = await selectedSource(commit, excludeDirty);
  if (source.excluded_changes.length)
    console.error(`Excluded dirty work (not tested): ${JSON.stringify(source.excluded_changes)}`);
  const host = await doctor();
  initializeStage();
  await ensureRetainedEvidenceStore(evidenceRoot);
  const run = randomUUID();
  const directory = path.join(stageRoot, run);
  mkdirSync(directory);
  const state = {
    format_version: 1,
    tool,
    workspace,
    run,
    created_at: new Date().toISOString(),
    source,
    host,
    mode,
    files,
    timeout,
    export_complete: false,
  };
  state.driver = {
    commit: await git(["rev-parse", "HEAD"]),
    host_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    recipe_sha256: hash(readFileSync(recipe)),
    entry_sha256: hash(readFileSync(entry)),
  };
  const stateFile = path.join(directory, "host.json");
  const save = () => record(stateFile, state);
  save();
  let interrupted;
  const abort = new AbortController();
  const onInterrupt = () => {
    interrupted = "SIGINT";
    abort.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  try {
    const text = readFileSync(recipe, "utf8");
    const base =
      /^FROM (ghcr\.io\/voidzero-dev\/vite-plus:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64})$/mu.exec(text);
    if (!base) throw new Error("Browser image requires an exact Vite+ tag and digest");
    const { parse } = await import("yaml");
    const selectedWorkspace = parse(await git(["show", `${commit}:pnpm-workspace.yaml`]));
    if (selectedWorkspace.catalog?.["vite-plus"] !== base[2])
      throw new Error(
        "Selected source's Vite+ pin is incompatible with the prepared image; coordinate the upgrade",
      );
    const preparation = hash(
      JSON.stringify({
        commit: source.commit,
        tree: source.tree,
        base: base[1],
        recipe: hash(text),
        entry: hash(readFileSync(entry)),
        platform: "linux/amd64",
        workspace,
      }),
    );
    const tag = `portcove-browser:${preparation}`;
    state.preparation = preparation;
    state.base = base[1];
    state.tag = tag;
    const usage = await imageUsage();
    if (usage.bytes > budgets.images_bytes)
      throw new Error("Owned image budget exhausted; inspect scoped cleanup");
    const preparing = Date.now();
    let image = usage.images.find((candidate) => candidate.RepoTags?.includes(tag));
    if (!image) {
      const diskUsage = (await docker(["system", "df", "--format", "json"], { timeout: 30_000 }))
        .stdout;
      const cache = cacheBytes(diskUsage);
      state.global_images_before_bytes = cacheBytes(diskUsage, "Images");
      if (
        usage.bytes + budgets.image_bytes > budgets.images_bytes ||
        state.global_images_before_bytes + 2 * budgets.image_bytes > budgets.global_images_bytes
      )
        throw new Error(
          "Image preparation admission budget exhausted; no shared images were deleted",
        );
      if (cache + budgets.image_bytes > budgets.build_cache_bytes)
        throw new Error("Build-cache admission budget exhausted; no global cache was pruned");
      state.build_cache_before_bytes = cache;
      console.error(`Preparing ${tag} from committed ${commit}`);
      const snapshot = path.join(directory, "snapshot");
      await command("git", ["clone", "--shared", "--no-checkout", root, snapshot], {
        timeout: 60_000,
      });
      await git(["update-ref", "refs/heads/container-selected", commit], snapshot);
      const bundle = path.join(directory, "source.bundle");
      await command("git", ["bundle", "create", bundle, "refs/heads/container-selected"], {
        cwd: snapshot,
        timeout: 120_000,
      });
      if (statSync(bundle).size > budgets.bundle_bytes)
        throw new Error("Committed-source bundle exceeds 256 MiB");
      await git(["bundle", "verify", bundle], snapshot);
      state.bundle = { bytes: statSync(bundle).size, sha256: hash(readFileSync(bundle)) };
      copyFileSync(recipe, path.join(directory, "Dockerfile"));
      copyFileSync(entry, path.join(directory, "container-entry.mjs"));
      writeFileSync(
        path.join(directory, ".dockerignore"),
        "**\n!Dockerfile\n!source.bundle\n!container-entry.mjs\n",
      );
      if (size(stageRoot) > budgets.staging_bytes)
        throw new Error("Owned staging exceeds its 10 GiB budget");
      const build = await docker(
        [
          "build",
          "--platform",
          "linux/amd64",
          "--progress=plain",
          "--tag",
          tag,
          "--build-arg",
          `SOURCE_COMMIT=${commit}`,
          "--build-arg",
          `SOURCE_TREE=${source.tree}`,
          "--build-arg",
          `WORKSPACE_OWNER=${workspace}`,
          "--build-arg",
          `PREPARATION=${preparation}`,
          ...[
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "no_proxy",
          ].flatMap((key) => ["--build-arg", `${key}=`]),
          directory,
        ],
        { timeout: budgets.setup_ms, signal: abort.signal },
      );
      writeFileSync(path.join(directory, "build.log"), build.stdout + build.stderr);
      image = JSON.parse((await docker(["image", "inspect", tag])).stdout)[0];
      state.build_cache_after_bytes = cacheBytes(
        (await docker(["system", "df", "--format", "json"], { timeout: 30_000 })).stdout,
      );
      if (state.build_cache_after_bytes > budgets.build_cache_bytes)
        throw new Error(
          "Build cache exceeded its observed admission budget; retain diagnostics and stop preparation",
        );
      state.prepared_reused = false;
    } else state.prepared_reused = true;
    const labels = owned(image);
    if (
      labels["io.portcove.source"] !== commit ||
      labels["io.portcove.tree"] !== source.tree ||
      labels["io.portcove.preparation"] !== preparation ||
      image.Os !== "linux" ||
      image.Architecture !== "amd64" ||
      image.Config.User !== "vp" ||
      image.Size > budgets.image_bytes
    )
      throw new Error("Prepared image identity, non-root user, platform or size is incompatible");
    state.image = image.Id;
    state.image_inspection = image;
    state.preparation_ms = Date.now() - preparing;
    save();
    const name = `portcove-browser-${run}`;
    state.container = (
      await docker(
        runtimeArguments({ name, run, image: image.Id, commit, tree: source.tree, mode, files }),
      )
    ).stdout.trim();
    save();
    state.runtime_inspection = await inspectContainer(state.container, run);
    validateRuntime(state.runtime_inspection);
    save();
    const started = Date.now();
    await docker(["start", state.container]);
    try {
      state.container_exit = Number(
        (await docker(["wait", state.container], { timeout, signal: abort.signal })).stdout.trim(),
      );
      if (
        !Number.isInteger(state.container_exit) ||
        state.container_exit < 0 ||
        state.container_exit > 255
      )
        throw new Error("Docker wait returned an invalid exit status");
    } catch (error) {
      state.interruption = interrupted ?? "timeout-or-wait-failure";
      state.wait_error = error.message;
      await inspectContainer(state.container, run);
      await docker(["stop", "--time", "10", state.container], { timeout: 20_000 });
      state.container_exit = (await inspectContainer(state.container, run)).State.ExitCode;
    }
    state.runtime_ms = Date.now() - started;
    state.status = state.interruption
      ? "interrupted"
      : state.container_exit === 0
        ? "passed"
        : "failed";
    save();
    state.storage_after = await doctor({ networkRequired: false });
    await exportRun(state, directory);
    save();
    return { ...state, exit_code: state.interruption ? 124 : state.container_exit };
  } catch (error) {
    saveFailure(state, error, directory, save);
    throw Object.assign(
      new Error(
        `${error.message}; recoverable state: ${stateFile}${state.container ? `; container ${state.container}` : ""}`,
      ),
      { state },
    );
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    try {
      appendFileSync(
        path.join(directory, "events.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          status: state.status,
          export_complete: state.export_complete,
        }) + "\n",
      );
    } catch (sink) {
      console.error(`Secondary event-write failure: ${sink.message}`);
    }
  }
}

export async function cleanup(apply = false, minAgeHours = budgets.retention_hours) {
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0 || minAgeHours > 8760)
    throw new Error("Cleanup age must be 0..8760 hours");
  if (!initializeStage(false)) return { apply, candidates: [], images: [] };
  await validateEvidenceStore(evidenceRoot);
  const candidates = [];
  const protectedImages = new Set();
  for (const name of readdirSync(stageRoot)) {
    if (!/^[0-9a-f-]{36}$/u.test(name)) continue;
    const directory = path.join(stageRoot, name);
    const state = json(path.join(directory, "host.json"));
    if (state.tool !== tool || state.workspace !== workspace || state.run !== name)
      throw new Error("Unknown run ownership; cleanup refused");
    if (!Number.isFinite(Date.parse(state.created_at)))
      throw new Error("Unknown run age; cleanup refused");
    if (
      state.status !== "passed" ||
      !state.export_complete ||
      Date.now() - Date.parse(state.created_at) < minAgeHours * 3600_000
    ) {
      protectedImages.add(state.image);
      continue;
    }
    const info = await inspectContainer(state.container, name);
    if (info.State.Running || info.State.ExitCode !== 0) {
      protectedImages.add(state.image);
      continue;
    }
    if (path.resolve(state.export) !== path.join(evidenceRoot, name))
      throw new Error("Unknown published evidence location; cleanup refused");
    verifyPublication(state.export, state);
    candidates.push({
      run: name,
      container: state.container,
      staging: directory,
      image_retained: state.image,
      evidence_retained: state.export,
    });
    if (apply) {
      await inspectContainer(state.container, name);
      await docker(["container", "rm", state.container]);
      const physical = realpathSync.native(directory);
      if (
        path.dirname(physical) !== realpathSync.native(stageRoot) ||
        path.basename(physical) !== name
      )
        throw new Error("Cleanup escaped its exact owned staging directory");
      rmSync(physical, { recursive: true });
    }
  }
  const images = [];
  const eligibleContainers = new Set(candidates.map((item) => item.container));
  for (const image of (await imageUsage()).images) {
    if (!Number.isFinite(Date.parse(image.Created)))
      throw new Error("Unknown image age; cleanup refused");
    if (
      protectedImages.has(image.Id) ||
      Date.now() - Date.parse(image.Created) < minAgeHours * 3600_000
    )
      continue;
    const referenced = (
      await docker([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `ancestor=${image.Id}`,
        "--quiet",
      ])
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    if (referenced.some((id) => !eligibleContainers.has(id))) continue;
    images.push({ image: image.Id, bytes: image.Size });
    if (apply) {
      owned(JSON.parse((await docker(["image", "inspect", image.Id])).stdout)[0]);
      await docker(["image", "rm", image.Id]);
    }
  }
  return {
    apply,
    candidates,
    images,
    retained:
      "Active runs, failures and published evidence are preserved; global builder caches and foreign resources are never pruned",
  };
}

async function recover(run) {
  if (!/^[0-9a-f-]{36}$/u.test(run ?? "")) throw new Error("Recovery requires an exact run UUID");
  initializeStage(false);
  const directory = path.join(stageRoot, run),
    file = path.join(directory, "host.json");
  const state = json(file);
  if (state.tool !== tool || state.workspace !== workspace || state.run !== run)
    throw new Error("Recovery ownership mismatch");
  if (state.export_complete) {
    verifyPublication(state.export, state);
    return { run, export: state.export, unchanged: true };
  }
  await doctor({ networkRequired: false });
  const result = await exportRun(state, directory);
  state.status = state.execution_status ?? result.status;
  record(file, state);
  return { run, export: state.export, status: state.status };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log(
      "usage: container-browser.mjs doctor | run --commit <40-hex> [--exclude-dirty] [--mode suite|probe|exact] [--timeout-ms <100..1800000>] [--files <literal desktop test files>...] | export --run <UUID> | clean [--apply] [--older-than-hours <0..8760>]",
    );
    return;
  }
  const action = args.shift();
  if (action === "doctor" && !args.length) console.log(JSON.stringify(await doctor()));
  else if (action === "clean") {
    let apply = false,
      age = budgets.retention_hours;
    while (args.length) {
      const flag = args.shift();
      if (flag === "--apply") apply = true;
      else if (flag === "--older-than-hours") age = Number(args.shift());
      else throw new Error(`Unknown cleanup argument ${flag}`);
    }
    console.log(JSON.stringify(await cleanup(apply, age)));
  } else if (action === "export" && args.length === 2 && args[0] === "--run")
    console.log(JSON.stringify(await recover(args[1])));
  else if (action === "run") {
    const options = {};
    while (args.length) {
      const flag = args.shift();
      if (flag === "--commit") options.commit = args.shift();
      else if (flag === "--exclude-dirty") options.excludeDirty = true;
      else if (flag === "--mode") options.mode = args.shift();
      else if (flag === "--timeout-ms") options.timeout = Number(args.shift());
      else if (flag === "--files") {
        options.files = args.splice(0);
      } else throw new Error(`Unknown container argument ${flag}`);
    }
    const result = await browser(options);
    console.log(
      JSON.stringify({
        run: result.run,
        commit: result.source.commit,
        tree: result.source.tree,
        image: result.image,
        prepared_reused: result.prepared_reused,
        status: result.status,
        exit_code: result.exit_code,
        export: result.export,
        state: path.join(stageRoot, result.run, "host.json"),
      }),
    );
    process.exitCode = result.exit_code;
  } else throw new Error("Unknown container command; use --help");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: error.message,
        observations: error.observations,
        observation: error.observation,
      }),
    );
    process.exitCode = 1;
  });
