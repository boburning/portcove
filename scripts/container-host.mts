import type { ResourceLease } from "./resource-capacity.mts";
import { restartedNativePreparation } from "./container-recovery.mts";
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";

/** Preserve the causal command status and adapter diagnostic fields. */
export function containerFailure(failure: unknown) {
  const error = isRecord(failure) ? failure : {};
  const state = isRecord(error.state) ? error.state : {};
  return {
    report: {
      error: error.message,
      observations: error.observations,
      observation: error.observation,
    },
    exitCode: typeof state.causal_exit === "number" && state.causal_exit ? state.causal_exit : 1,
  };
}

import { runRustTests } from "./run-rust-tests.mts";
import { EventEmitter } from "node:events";
import {
  acquireSourceBoundCapacity,
  reconcileExternalCapacity,
  capacityChildrenStopped,
} from "./resource-capacity.mts";
import { fallowSource } from "./fallow-source.mts";
import { spawn, spawnSync } from "node:child_process";
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
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minimumFreeGiB, preflight, resolvePhysicalPath } from "./dev-storage.mts";
import {
  ensureRetainedEvidenceStore,
  retainedEvidenceRoot,
  validateEvidenceStore,
} from "./retained-evidence.mts";

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Container observation must be an object");
  return value;
}
function parseJson(value: string): unknown {
  return JSON.parse(value);
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Container ${label} must be a string`);
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Container ${label} must be an array`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map((entry) => string(entry, label));
}
function firstObservation(value: unknown): Record<string, unknown> {
  const first = array(value, "inspection")[0];
  return object(first);
}
function diagnosticText(value: unknown): string {
  return String(value);
}
interface DockerState {
  Running: boolean;
  ExitCode: number;
}
interface DockerContainer {
  Id: string;
  State: DockerState;
}
function containerObservation(value: unknown): DockerContainer {
  const info = object(value),
    state = object(info.State);
  if (
    typeof state.Running !== "boolean" ||
    typeof state.ExitCode !== "number" ||
    !Number.isInteger(state.ExitCode)
  )
    throw new Error("Container execution state is invalid");
  const Id = string(info.Id, "ID");
  return { ...info, Id, State: { ...state, Running: state.Running, ExitCode: state.ExitCode } };
}
interface DockerImage {
  Id: string;
  Size: number;
  RepoTags?: string[] | null;
  Created: string;
  Os: string;
  Architecture: string;
  Config: { User: string };
}
function imageObservation(value: unknown): DockerImage {
  const info = object(value),
    config = object(info.Config);
  if (typeof info.Size !== "number" || !Number.isFinite(info.Size) || info.Size < 0)
    throw new Error("Container image size is invalid");
  return {
    ...info,
    Id: string(info.Id, "image ID"),
    Size: info.Size,
    Created: string(info.Created, "image creation time"),
    Os: string(info.Os, "image OS"),
    Architecture: string(info.Architecture, "image architecture"),
    Config: { ...config, User: string(config.User, "image user") },
    ...(info.RepoTags === undefined
      ? {}
      : { RepoTags: info.RepoTags === null ? null : strings(info.RepoTags, "image tags") }),
  };
}
export interface ContainerCommandResult {
  command: string;
  args: readonly string[];
  cwd: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  termination?:
    | {
        pid: number;
        status: number | null;
        signal: NodeJS.Signals | null;
        error: string | undefined;
        stdout: string | undefined;
        stderr: string | undefined;
      }
    | undefined;
}
function assertFinishedResult(
  value: unknown,
): asserts value is Record<string, unknown> & { status: "passed" | "failed" | "interrupted" } {
  if (
    !isRecord(value) ||
    (value.status !== "passed" && value.status !== "failed" && value.status !== "interrupted")
  )
    throw new Error("Container report is incomplete; retain it for recovery");
}
interface SourceSelection {
  commit: string;
  tree: string;
  checkout_head?: string;
  excluded_changes: string[];
}
interface ArtifactIdentity {
  path: string;
  bytes: number;
  sha256: string;
}
interface FailureState {
  status?: string | undefined;
  execution_status?: string | null;
  causal_exit?: number;
  error?: string;
  diagnostic_error?: string;
  failed_command?: Record<string, unknown>;
}
interface RunState extends FailureState {
  format_version: number;
  tool: string;
  workspace: string;
  run: string;
  created_at: string;
  source: SourceSelection;
  host?: unknown;
  mode?: string;
  files?: readonly string[];
  timeout?: number;
  export_complete: boolean;
  driver?: unknown;
  preparation?: string;
  base?: string | undefined;
  bases?: (string | undefined)[];
  selected_bootstrap_sha256?: string;
  tag?: string;
  queue_ms?: number;
  capacity?: unknown;
  capacity_external?: unknown;
  capacity_phase?: string;
  global_images_before_bytes?: number;
  build_cache_before_bytes?: number;
  build_cache_after_bytes?: number;
  build_name?: string;
  bundle?: { bytes: number; sha256: string };
  image?: string;
  image_inspection?: unknown;
  prepared_reused?: boolean;
  preparation_ms?: number;
  container_name?: string;
  container?: string;
  runtime_inspection?: unknown;
  container_exit?: number;
  interruption?: string;
  wait_error?: string;
  wait_failure?: unknown;
  runtime_ms?: number;
  capacity_released?: boolean;
  storage_after?: unknown;
  export?: string;
  result?: unknown;
  creation_readback?: unknown;
  creation_readback_error?: string;
  capacity_cleanup_error?: string;
  capacity_retained?: string;
  capacity_recovery_journal?: unknown;
  build_completion?: unknown;
  daemon_restart_proof?: unknown;
}
interface BrowserOptions {
  commit: unknown;
  excludeDirty?: boolean;
  mode?: string | undefined;
  files?: readonly string[];
  timeout?: number;
}
interface PublicationBinding {
  run: string;
  source: { commit: string; tree: string };
  image?: string;
}
function assertRunState(value: unknown): asserts value is RunState {
  const raw = object(value),
    source = object(raw.source);
  if (typeof raw.format_version !== "number" || typeof raw.export_complete !== "boolean")
    throw new Error("Container state format is incomplete");
  for (const key of ["tool", "workspace", "run", "created_at"]) string(raw[key], `state ${key}`);
  for (const key of ["commit", "tree"]) string(source[key], `source ${key}`);
  strings(source.excluded_changes, "excluded changes");
  if (source.checkout_head !== undefined) string(source.checkout_head, "checkout head");
  for (const key of [
    "status",
    "error",
    "diagnostic_error",
    "mode",
    "preparation",
    "base",
    "selected_bootstrap_sha256",
    "tag",
    "capacity_phase",
    "build_name",
    "image",
    "container_name",
    "container",
    "interruption",
    "wait_error",
    "export",
    "creation_readback_error",
    "capacity_cleanup_error",
    "capacity_retained",
  ])
    if (raw[key] !== undefined) string(raw[key], `state ${key}`);
  if (raw.execution_status !== undefined && raw.execution_status !== null)
    string(raw.execution_status, "execution status");
  for (const key of [
    "causal_exit",
    "timeout",
    "queue_ms",
    "global_images_before_bytes",
    "build_cache_before_bytes",
    "build_cache_after_bytes",
    "preparation_ms",
    "container_exit",
    "runtime_ms",
  ])
    if (raw[key] !== undefined && typeof raw[key] !== "number")
      throw new Error(`Container state ${key} must be numeric`);
  for (const key of ["prepared_reused", "capacity_released"])
    if (raw[key] !== undefined && typeof raw[key] !== "boolean")
      throw new Error(`Container state ${key} must be boolean`);
  for (const key of ["files", "bases"])
    if (raw[key] !== undefined) strings(raw[key], `state ${key}`);
  if (raw.bundle !== undefined) {
    const bundle = object(raw.bundle);
    string(bundle.sha256, "bundle digest");
    if (typeof bundle.bytes !== "number") throw new Error("Container bundle size is invalid");
  }
  if (raw.failed_command !== undefined) object(raw.failed_command);
}
function runState(value: unknown): RunState {
  assertRunState(value);
  return value;
}
function artifact(value: unknown): ArtifactIdentity {
  const raw = object(value);
  if (typeof raw.bytes !== "number" || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0)
    throw new Error("Container artifact size is invalid");
  return {
    ...raw,
    path: string(raw.path, "artifact path"),
    bytes: raw.bytes,
    sha256: string(raw.sha256, "artifact digest"),
  };
}
function requiredState(value: string | undefined, label: string): string {
  return string(value, label);
}
interface CommandOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}
// Completed failures prove quiescence without converting a failed build to success.
export function completedContainerPreparation(records: readonly unknown[], name: unknown) {
  const matches = records.filter((item) => object(item).name === name);
  const raw = matches[0];
  if (matches.length !== 1 || !isRecord(raw)) return null;
  return typeof raw.ref === "string" &&
    /^desktop-linux\/desktop-linux\/[a-z0-9]+$/u.test(raw.ref) &&
    ["completed", "error", "canceled"].includes(diagnosticText(raw.status).toLowerCase()) &&
    typeof raw.created_at === "string" &&
    typeof raw.completed_at === "string" &&
    Number.isFinite(Date.parse(raw.created_at)) &&
    Number.isFinite(Date.parse(raw.completed_at)) &&
    Date.parse(raw.completed_at) >= Date.parse(raw.created_at)
    ? raw
    : null;
}

// Shared Windows transport; profiles are selected only by repository-owned adapters.
export function createContainerHost(profile: string) {
  if (!["browser", "build"].includes(profile)) throw new Error("Unknown container profile");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const workspace = hash(resolvePhysicalPath(root).toLowerCase());
  const builder = profile === "build";
  const tool = builder ? "build-v1" : "browser-v1";
  const namespace = builder ? "container-build" : "container-browser";
  const prefix = builder ? "portcove-build" : "portcove-browser";
  const stageRoot = path.join(root, "work", namespace);
  const evidenceRoot = path.join(retainedEvidenceRoot(path.join(root, "outputs")), namespace);
  const recipe = path.join(
    root,
    builder ? "tools/containers/build/Dockerfile" : "tools/containers/browser/Dockerfile",
  );
  const entry = path.join(
    root,
    builder ? "scripts/container-build-entry.mts" : "scripts/container-entry.mts",
  );
  const guard = path.join(root, "scripts/container-source.mts");
  const policy = builder ? path.join(root, "scripts/container-build-policy.mts") : null;
  const GiB = 1024 ** 3;
  const budgets = Object.freeze({
    timeout_ms: (builder ? 90 : 30) * 60_000,
    setup_ms: (builder ? 120 : 30) * 60_000,
    ...(builder ? { bundle_ms: 45 * 60_000 } : {}),
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

  function command(
    commandName: string,
    args: readonly string[],
    { cwd = root, timeout = 15_000, signal }: CommandOptions = {},
  ): Promise<ContainerCommandResult> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          Object.assign(new Error(`${commandName} interrupted before launch`), {
            result: {
              command: commandName,
              args,
              cwd,
              status: null,
              signal: null,
              stdout: "",
              stderr: "",
              interruption: "already-aborted",
            },
          }),
        );
        return;
      }
      const child = spawn(commandName, args, {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: [Buffer[], Buffer[]] = [[], []];
      let bytes = 0;
      let problem: Error | undefined;
      let force: ReturnType<typeof setTimeout> | undefined;
      let exited = false;
      let stopping = false;
      let termination: ContainerCommandResult["termination"];
      child.on("exit", () => {
        exited = true;
      });
      const stop = (reason: Error) => {
        problem ??= reason;
        if (exited || stopping) return;
        stopping = true;
        if (process.platform === "win32" && child.pid) {
          // Git and Docker's Windows launchers own companion processes. Stop the
          // still-owned live tree before its parent disappears and loses custody.
          const drained = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 10_000,
            encoding: "utf8",
          });
          termination = {
            pid: child.pid,
            status: drained.status,
            signal: drained.signal,
            error: drained.error?.message,
            stdout: drained.stdout?.slice(-8192),
            stderr: drained.stderr?.slice(-8192),
          };
        }
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
        stream.on("data", (data: Buffer) => {
          bytes += data.length;
          if (bytes > budgets.command_output_bytes)
            stop(new Error(`${commandName} output exceeded 16 MiB`));
          else {
            const output = chunks[index];
            if (output) output.push(data);
          }
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
          termination,
          stdout: Buffer.concat(chunks[0]).toString("utf8"),
          stderr: Buffer.concat(chunks[1]).toString("utf8"),
        };
        if (problem || status !== 0)
          reject(
            Object.assign(
              problem ??
                new Error(
                  `${commandName} failed (${status}): ${Buffer.from(result.stderr.trim()).subarray(-8192).toString("utf8")}`,
                ),
              { result },
            ),
          );
        else resolve(result);
      });
    });
  }
  const docker = (args: readonly string[], options?: CommandOptions) =>
    command("docker", ["--context", "desktop-linux", ...args], options);
  const json = (file: string): unknown => parseJson(readFileSync(file, "utf8"));
  const record = (file: string, value: unknown) => {
    writeFileSync(`${file}.next`, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(`${file}.next`, file);
  };
  const git = async (args: readonly string[], cwd = root) =>
    (await command("git", args, { cwd })).stdout.trim();

  function validateEngine(input: unknown, contextInput: unknown) {
    const info = object(input),
      context = object(contextInput);
    if (
      string(object(object(context.Endpoints).docker).Host, "engine endpoint").toLowerCase() !==
      "npipe:////./pipe/dockerdesktoplinuxengine"
    )
      throw new Error(
        "Use the local Docker Desktop desktop-linux context; remote and alternate engines are excluded",
      );
    if (
      info.OSType !== "linux" ||
      info.OperatingSystem !== "Docker Desktop" ||
      !(typeof info.KernelVersion === "string" && /microsoft.*WSL2/iu.test(info.KernelVersion)) ||
      (info.Architecture !== "x86_64" && info.Architecture !== "amd64")
    )
      throw new Error("This browser adapter requires Docker Desktop's WSL 2 Linux x86-64 engine");
  }

  function validateDesktop(input: unknown) {
    const status = object(input);
    if (status?.Status !== "running" || status.PauseType)
      throw new Error(
        "Docker Desktop engine is stopped, paused or in Resource Saver. Explicitly exit Resource Saver in Desktop before execution; starting an already-running UI may not resume the engine. The preflight never wakes it or changes global settings",
      );
  }

  // Query the same read-only resolved-settings endpoint used by Desktop's UI.
  // Saved overrides omit defaults; log rotation and startup writes are not authority.
  function diskFromSettings(input: unknown, home: string) {
    const current = object(input);
    if (current?.["vm.hypervisor.windows"] !== "wsl2")
      throw new Error("Docker Desktop is not configured for WSL 2");
    const rawFolder = current["vm.resources.wslDataFolder"];
    if (typeof rawFolder !== "string") throw new Error("Docker did not report its WSL data folder");
    const folder = rawFolder.replace(/^<HOME>/u, home);
    if (!path.win32.isAbsolute(folder) || folder.includes("<"))
      throw new Error("Unknown Docker WSL data-folder form");
    return {
      observed_at: new Date().toISOString(),
      folder,
      vhd: path.win32.join(folder, "disk/docker_data.vhdx"),
    };
  }
  async function desktopSettings(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = http.get(
        { socketPath: "\\\\.\\pipe\\dockerBackendApiServer", path: "/app/settings/gui" },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (data: Buffer) => {
            bytes += data.length;
            if (bytes > 2 * 1024 ** 2)
              request.destroy(new Error("Desktop settings response exceeds 2 MiB"));
            else chunks.push(data);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              if (response.statusCode !== 200)
                throw new Error("Desktop resolved settings request failed: " + response.statusCode);
              resolve(object(parseJson(Buffer.concat(chunks).toString("utf8"))).settings);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      const timer = setTimeout(
        () => request.destroy(new Error("Desktop resolved settings request exceeded 10 seconds")),
        10_000,
      );
      request.on("error", reject);
      request.on("close", () => clearTimeout(timer));
    });
  }
  function size(directory: string) {
    if (!existsSync(directory)) return 0;
    let total = 0;
    let files = 0;
    function visit(current: string) {
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
    const endpoints: [string, number[], string?][] = [
      ["https://ghcr.io/v2/", [200, 401], "GET"],
      ["https://registry.npmjs.org/", [200]],
      ["https://nodejs.org/dist/index.json", [200]],
    ];
    if (builder)
      endpoints.push(
        ["https://github.com/PowerShell/PowerShell/releases", [200]],
        ["https://archive.ubuntu.com/ubuntu/dists/jammy/Release", [200]],
        ["https://static.rust-lang.org/dist/channel-rust-stable.toml", [200]],
        ["https://index.crates.io/config.json", [200]],
        ["https://registry-1.docker.io/v2/", [200, 401], "GET"],
      );
    else
      endpoints.push(
        ["https://cdn.playwright.dev/", [400]],
        ["https://deb.debian.org/debian/dists/bookworm/Release", [200]],
        ["https://security.debian.org/debian-security/dists/bookworm-security/Release", [200]],
      );
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
          return { url, reachable: false, error: errorMessage(error) };
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

  function linuxStorage(output: string, floor = minimumFreeGiB()) {
    const matches = output
      .trim()
      .split(/\r?\n/u)
      .map((line: string) => line.trim().split(/\s+/u))
      .filter((columns) => columns.at(-1) === "/mnt/docker-desktop-disk");
    const available = matches.length === 1 ? Number(matches[0]?.[3]) * 1024 : NaN;
    if (!Number.isFinite(available) || available < floor * GiB)
      throw Object.assign(
        new Error("Docker Linux backing filesystem is unknown or below the storage floor"),
        { observation: output },
      );
    return available;
  }
  function cacheBytes(output: string, kind = "Build Cache") {
    const rows = output
      .trim()
      .split("\n")
      .map((line) => object(parseJson(line)));
    const row = rows.find((item) => item.Type === kind);
    const size = /^(\d+(?:\.\d+)?)(B|kB|MB|GB|TB)$/u.exec(
      typeof row?.Size === "string" ? row.Size : "",
    );
    if (!size) throw new Error("Unknown Docker build-cache usage; preparation refused");
    return Math.ceil(
      Number(size[1]) * 1000 ** ["B", "kB", "MB", "GB", "TB"].indexOf(size[2] ?? ""),
    );
  }
  async function doctor({ networkRequired = true } = {}) {
    if (process.versions.node !== readFileSync(path.join(root, ".node-version"), "utf8").trim())
      throw new Error("Use the repository-pinned Node version for the optional host adapter");
    if (process.platform !== "win32")
      throw new Error(
        "Run this optional host adapter from Windows; native Linux development remains separate",
      );
    let info: Record<string, unknown>;
    let context: unknown;
    let desktop: unknown;
    try {
      desktop = parseJson((await docker(["desktop", "status", "--format", "json"])).stdout);
      validateDesktop(desktop);
      info = object(parseJson((await docker(["info", "--format", "json"])).stdout));
      context = firstObservation(
        parseJson((await docker(["context", "inspect", "desktop-linux"])).stdout),
      );
    } catch (error) {
      throw new Error(
        `Docker Desktop is missing, stopped or inaccessible. Start the installed WSL 2 Linux engine explicitly; this preflight changes no host settings. ${errorMessage(error)}`,
        { cause: error },
      );
    }
    validateEngine(info, context);
    if (
      typeof info.SystemTime !== "string" ||
      !Number.isFinite(Date.parse(info.SystemTime)) ||
      Math.abs(Date.now() - Date.parse(info.SystemTime)) > 60_000
    )
      throw new Error(
        "Docker info is stale or its clock is unknown; do not admit work from Resource Saver's cached API response",
      );
    const disk = diskFromSettings(await desktopSettings(), os.homedir());
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
    const linux = await command(
      "wsl.exe",
      ["--distribution", "docker-desktop", "--exec", "df", "-Pk", "/mnt/docker-desktop-disk"],
      { timeout: 60_000 },
    );
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

  async function selectedSource(
    commit: unknown,
    excludeDirty = false,
    repository = root,
  ): Promise<SourceSelection> {
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/u.test(commit))
      throw new Error(
        "Select one full committed SHA with --commit; dirty/current work is not synchronized",
      );
    if ((await git(["rev-parse", "--verify", `${commit}^{commit}`], repository)) !== commit)
      throw new Error("Selected source is not the requested commit");
    const excluded = (
      await command("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: repository,
      })
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
  function owned(input: unknown, run?: unknown) {
    const info = object(input);
    const config = info.Config == null ? {} : object(info.Config);
    const labels = object(config.Labels ?? info.Labels ?? {});
    if (
      labels["io.portcove.tool"] !== tool ||
      labels["io.portcove.workspace"] !== workspace ||
      (run && labels["io.portcove.run"] !== run)
    )
      throw new Error("Container/image ownership does not match this workspace and run");
    return labels;
  }
  async function inspectContainer(id: string, run?: string) {
    const info = containerObservation(
      firstObservation(parseJson((await docker(["container", "inspect", id])).stdout)),
    );
    owned(info, run);
    return info;
  }
  function runtimeArguments({
    name,
    run,
    image,
    commit,
    tree,
    mode,
    files = [],
  }: {
    name: string;
    run: string;
    image: string;
    commit: string;
    tree: string;
    mode: string;
    files?: readonly string[];
  }) {
    if (!new RegExp(`^${prefix}-[0-9a-f-]{36}$`, "u").test(name))
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
      builder ? "bridge" : "none",
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
      "PORTCOVE_CONTAINER_GUEST=1",
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

  function validateRuntime(input: unknown) {
    const raw = object(input),
      config = object(raw.Config),
      host = object(raw.HostConfig);
    const mounts = array(raw.Mounts, "mounts");
    const environment = strings(config.Env, "environment");
    const capAdd = host.CapAdd == null ? null : array(host.CapAdd, "additional capabilities");
    const devices = host.Devices == null ? null : array(host.Devices, "devices");
    const capDrop =
      host.CapDrop == null ? undefined : strings(host.CapDrop, "dropped capabilities");
    const security =
      host.SecurityOpt == null ? undefined : strings(host.SecurityOpt, "security options");
    if (
      config.User !== "1000:1000" ||
      mounts.length ||
      host.Privileged ||
      capAdd?.length ||
      host.NetworkMode !== (builder ? "bridge" : "none") ||
      (builder && (Object.keys(host.PortBindings ?? {}).length || host.PublishAllPorts === true)) ||
      host.PidMode ||
      host.IpcMode === "host" ||
      devices?.length ||
      host.Memory !== 6 * GiB ||
      host.MemorySwap !== 6 * GiB ||
      host.NanoCpus !== 4e9 ||
      host.ShmSize !== GiB ||
      host.PidsLimit !== budgets.pids ||
      !capDrop?.includes("ALL") ||
      !security?.includes("no-new-privileges:true")
    )
      throw new Error(
        "Actual container isolation/resource configuration differs from the browser contract",
      );
    const allowed = new Set([
      "PATH",
      "VP_HOME",
      "CI",
      "VP_GIT_HOOKS",
      ...(builder
        ? ["RUSTUP_HOME", "CARGO_HOME", "CARGO_NET_OFFLINE", "APPIMAGE_EXTRACT_AND_RUN"]
        : []),
      "PORTCOVE_CONTAINER_RUN",
      "PORTCOVE_CONTAINER_IMAGE",
      "PORTCOVE_CONTAINER_COMMIT",
      "PORTCOVE_CONTAINER_TREE",
    ]);
    for (const variable of environment) {
      const separator = variable.indexOf("="),
        key = variable.slice(0, separator),
        value = variable.slice(separator + 1);
      if (/^(?:https?|all|no)_proxy$/iu.test(key) && value === "") continue;
      if (
        (key === "PORTCOVE_CONTAINER_GUEST" && value === "1") ||
        (key === "HOME" && value === "/home/vp") ||
        (key === "HOSTNAME" && value === config.Hostname)
      )
        continue;
      if (!allowed.has(key)) throw new Error(`Unexpected runtime environment key: ${key}`);
    }
  }

  function initializeStage(create = true) {
    const marker = path.join(stageRoot, "owner.json");
    if (existsSync(stageRoot)) {
      const owner = object(json(marker));
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
      const info = imageObservation(
        firstObservation(parseJson((await docker(["image", "inspect", id])).stdout)),
      );
      owned(info);
      images.push(info);
    }
    return { images, bytes: images.reduce((sum, info) => sum + info.Size, 0) };
  }

  async function exportRun(state: RunState, directory: string) {
    await ensureRetainedEvidenceStore(evidenceRoot);
    const container = await inspectContainer(
      requiredState(state.container, "container ID"),
      state.run,
    );
    if (container.State.Running)
      throw new Error("Refusing export while the task container is active");
    const destination = path.join(evidenceRoot, state.run);
    if (existsSync(destination))
      throw new Error("An evidence destination already exists; refusing overwrite");
    const partial = path.join(directory, `export-partial-${randomUUID()}`);
    mkdirSync(partial);
    const logs = await docker([
      "logs",
      "--timestamps",
      requiredState(state.container, "container ID"),
    ]);
    writeFileSync(path.join(partial, "docker.stdout.log"), logs.stdout);
    writeFileSync(path.join(partial, "docker.stderr.log"), logs.stderr);
    if (existsSync(path.join(directory, "build.log")))
      copyFileSync(path.join(directory, "build.log"), path.join(partial, "build.log"));
    await docker(["cp", `${state.container}:/workspace/work/container-results/.`, partial], {
      timeout: 60_000,
    });
    if (size(partial) > GiB)
      throw new Error("Export exceeds 1 GiB; recover the labelled container and partial directory");
    const result = object(json(path.join(partial, "result.json")));
    if (
      result.run !== state.run ||
      result.commit !== state.source.commit ||
      result.tree !== state.source.tree ||
      result.image !== state.image
    )
      throw new Error("Exported run/source/image identity mismatch");
    assertFinishedResult(result);
    if (result.export_error)
      throw new Error(
        `Container evidence capture was incomplete: ${diagnosticText(result.export_error)}; retain raw task paths for recovery`,
      );
    if (
      result.uid !== 1000 ||
      result.platform !== "linux" ||
      result.architecture !== "x64" ||
      (result.status === "passed" && (!result.fresh_execution || result.command_exit !== 0))
    )
      throw new Error("Container execution identity or fresh-result contract failed");
    for (const entry of array(result.artifacts, "result artifacts")) {
      const artifactIdentity = artifact(entry);
      const file = path.resolve(partial, artifactIdentity.path);
      const relative = path.relative(partial, file);
      if (
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !lstatSync(file).isFile() ||
        statSync(file).size !== artifactIdentity.bytes ||
        hash(readFileSync(file)) !== artifactIdentity.sha256
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
    function publish(from: string, to: string) {
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
    const inventory: ArtifactIdentity[] = [];
    function inventoryFiles(directory: string) {
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

  function verifyPublication(directory: string, expected: PublicationBinding) {
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("Published evidence directory is linked");
    const manifest = object(json(path.join(directory, "publication.json")));
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
    for (const rawItem of array(manifest.files, "publication files")) {
      const item = artifact(rawItem);
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

  function saveFailure(state: FailureState, error: unknown, directory: string, save: () => void) {
    state.execution_status = state.status ?? null;
    state.status =
      errorCode(error) === "PORTCOVE_RESOURCE_QUEUE_TIMEOUT" ? "admission-failed" : "incomplete";
    if (errorCode(error) === "PORTCOVE_RESOURCE_QUEUE_TIMEOUT") state.causal_exit = 75;
    state.error = errorMessage(error);
    const result = isRecord(error) && isRecord(error.result) ? error.result : undefined;
    if (result) {
      let saved = false;
      try {
        writeFileSync(
          path.join(directory, "failed-command.log"),
          diagnosticText(result.stdout) + diagnosticText(result.stderr),
        );
        saved = true;
      } catch (sink) {
        state.diagnostic_error = errorMessage(sink);
      }
      state.failed_command = {
        ...result,
        stdout: saved ? undefined : result.stdout,
        stderr: saved ? undefined : result.stderr,
      };
    }
    try {
      save();
    } catch (sink) {
      console.error(`Secondary state-write failure: ${errorMessage(sink)}`);
    }
  }

  async function browser({
    commit,
    excludeDirty = false,
    mode = builder ? "check" : "suite",
    files = [],
    timeout = budgets.timeout_ms,
  }: BrowserOptions) {
    if (
      !(builder ? ["check", "package"] : ["suite", "probe", "exact"]).includes(mode) ||
      (mode === "exact" ? !files.length : files.length) ||
      !Number.isSafeInteger(timeout) ||
      timeout < 100 ||
      timeout > budgets.timeout_ms
    )
      throw new Error(
        builder
          ? "Use check or package and a finite timeout of 100..5400000 ms"
          : "Use suite, probe or exact files and a finite timeout of 100..1800000 ms",
      );
    const source = await selectedSource(commit, excludeDirty);
    const selectedCommit = source.commit;
    const intendedDriverSource = fallowSource(root, undefined, { includeAll: true });
    if (source.excluded_changes.length)
      console.error(`Excluded dirty work (not tested): ${JSON.stringify(source.excluded_changes)}`);
    const host = await doctor();
    initializeStage();
    await ensureRetainedEvidenceStore(evidenceRoot);
    const run = randomUUID();
    const directory = path.join(stageRoot, run);
    mkdirSync(directory);
    const state: RunState = {
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
      resource_sources: Object.fromEntries(
        [
          "resource-capacity.mts",
          "resource-paths.mts",
          "heavy-rust-test-lock.mts",
          "process-lock.mts",
          "fallow-source.mts",
          "container-recovery.mts",
        ].map((name) => [name, hash(readFileSync(path.join(root, "scripts", name)))]),
      ),
      wrapper_sha256: hash(readFileSync(path.join(root, `scripts/${namespace}.mts`))),
      recipe_sha256: hash(readFileSync(recipe)),
      entry_sha256: hash(readFileSync(entry)),
      guard_sha256: hash(readFileSync(guard)),
      runtime_values_sha256: hash(readFileSync(path.join(root, "scripts/runtime-values.mts"))),
      ...(builder
        ? { policy_sha256: hash(readFileSync(requiredState(policy ?? undefined, "build policy"))) }
        : {}),
    };
    const stateFile = path.join(directory, "host.json");
    const save = () => record(stateFile, state);
    save();
    let interrupted: string | undefined;
    let reservation: ResourceLease | null | undefined;
    let external: unknown;
    const abort = new AbortController();
    const onInterrupt = (signal: string) => {
      interrupted ??= signal;
      abort.abort();
    };
    const onSigint = () => onInterrupt("SIGINT");
    const onSigterm = () => onInterrupt("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    try {
      const text = readFileSync(recipe, "utf8");
      const base = (
        builder
          ? /^FROM (ghcr\.io\/voidzero-dev\/vite-plus:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64}) AS vite$/mu
          : /^FROM (ghcr\.io\/voidzero-dev\/vite-plus:(\d+\.\d+\.\d+)@sha256:[a-f0-9]{64})$/mu
      ).exec(text);
      if (!base) throw new Error("Browser image requires an exact Vite+ tag and digest");
      const { parse } = await import("yaml");
      const selectedWorkspace = object(
        parse(await git(["show", `${selectedCommit}:pnpm-workspace.yaml`])),
      );
      if (object(selectedWorkspace.catalog)["vite-plus"] !== base[2])
        throw new Error(
          "Selected source's Vite+ pin is incompatible with the prepared image; coordinate the upgrade",
        );
      if (builder) {
        const rustPin = /channel\s*=\s*"([^"]+)"/u.exec(
          await git(["show", `${selectedCommit}:rust-toolchain.toml`]),
        )?.[1];
        const rustImage = /^FROM rust:([^@]+)-slim-bookworm@sha256:[a-f0-9]{64} AS rust$/mu.exec(
          text,
        )?.[1];
        if (rustPin !== rustImage)
          throw new Error(
            "Selected Rust pin differs from the immutable builder toolchain; coordinate the upgrade",
          );
      }
      const bootstrap = builder
        ? (
            await command("git", [
              "show",
              `${selectedCommit}:scripts/install-linux-desktop-prerequisites.sh`,
            ])
          ).stdout
        : null;
      const preparation = hash(
        JSON.stringify({
          commit: source.commit,
          tree: source.tree,
          base: base[1],
          recipe: hash(text),
          entry: hash(readFileSync(entry)),
          guard: hash(readFileSync(guard)),
          ...(builder
            ? { policy: hash(readFileSync(requiredState(policy ?? undefined, "build policy"))) }
            : {}),
          ...(builder
            ? { bootstrap: hash(requiredState(bootstrap ?? undefined, "bootstrap")) }
            : {}),
          platform: "linux/amd64",
          workspace,
        }),
      );
      const tag = `${prefix}:${preparation}`;
      state.preparation = preparation;
      state.base = base[1];
      if (builder)
        state.bases = [...text.matchAll(/^FROM ([^\s]+)(?:\s|$)/gmu)].map((match) => match[1]);
      if (builder)
        state.selected_bootstrap_sha256 = hash(requiredState(bootstrap ?? undefined, "bootstrap"));
      state.tag = tag;
      reservation = await acquireSourceBoundCapacity(
        "container",
        { workspace: root, command: `${namespace} ${mode} ${run}` },
        {
          signal: abort.signal,
          expectedSource: intendedDriverSource,
        },
      );
      state.queue_ms = reservation.queueMs;
      state.capacity = reservation.reference ?? null;
      external = {
        kind: "docker",
        run,
        workspace,
        container_name: `${prefix}-${run}`,
        preparation,
      };
      state.capacity_external = external;
      state.capacity_phase = "admitted";
      // Persist custody before publishing markers or dispatching any owned work.
      save();
      const usage = await imageUsage();
      if (usage.bytes > budgets.images_bytes)
        throw new Error("Owned image budget exhausted; inspect scoped cleanup");
      const preparing = Date.now();
      const setupTimeout = (limit = budgets.setup_ms) => {
        const remaining = budgets.setup_ms - (Date.now() - preparing);
        if (remaining <= 0)
          throw new Error(
            builder
              ? "Builder preparation exceeded its 120-minute budget"
              : "Browser preparation exceeded its 30-minute budget",
          );
        return Math.min(limit, remaining);
      };
      let image = usage.images.find((candidate) => candidate.RepoTags?.includes(tag));
      if (!image) {
        const diskUsage = (
          await docker(["system", "df", "--format", "json"], {
            timeout: setupTimeout(120_000),
            signal: abort.signal,
          })
        ).stdout;
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
        console.error(`Preparing ${tag} from committed ${selectedCommit}`);
        const snapshot = path.join(directory, "snapshot");
        await command("git", ["clone", "--shared", "--no-checkout", root, snapshot], {
          timeout: setupTimeout(60_000),
          signal: abort.signal,
        });
        await git(["update-ref", "refs/heads/container-selected", selectedCommit], snapshot);
        const bundle = path.join(directory, "source.bundle");
        state.capacity_phase = "local-preparation";
        save();
        if (reservation.registerExternal) await reservation.registerExternal(external);
        const cancellation = new EventEmitter();
        const cancel = () => cancellation.emit("SIGTERM");
        const timer = setTimeout(cancel, setupTimeout(budgets.bundle_ms ?? 300_000));
        abort.signal.addEventListener("abort", cancel, { once: true });
        const bundleLease = reservation;
        if (!bundleLease) throw new Error("Owned bundle preparation has no capacity reservation");
        let bundled;
        try {
          bundled = await runRustTests(
            [
              "--guard-command",
              "git",
              "-c",
              "pack.threads=2",
              "bundle",
              "create",
              "--progress",
              bundle,
              "refs/heads/container-selected",
            ],
            {
              cwd: snapshot,
              environment: { ...process.env, ...reservation.childEnvironment },
              signalTarget: cancellation,
              acquireLock: async () => ({
                ...bundleLease,
                inherited: false,
                release: async () => {},
              }),
            },
          );
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", cancel);
        }
        if (bundled !== 0)
          throw new Error(`Owned bundle preparation failed (${bundled}); retain its diagnostics`);
        if (statSync(bundle).size > budgets.bundle_bytes)
          throw new Error("Committed-source bundle exceeds 256 MiB");
        await git(["bundle", "verify", bundle], snapshot);
        state.bundle = { bytes: statSync(bundle).size, sha256: hash(readFileSync(bundle)) };
        copyFileSync(recipe, path.join(directory, "Dockerfile"));
        copyFileSync(entry, path.join(directory, "container-entry.mts"));
        copyFileSync(guard, path.join(directory, "container-source.mts"));
        copyFileSync(
          path.join(root, "scripts/runtime-values.mts"),
          path.join(directory, "runtime-values.mts"),
        );
        if (builder)
          copyFileSync(
            requiredState(policy ?? undefined, "build policy"),
            path.join(directory, "container-build-policy.mts"),
          );
        if (builder)
          writeFileSync(
            path.join(directory, "linux-prerequisites.sh"),
            requiredState(bootstrap ?? undefined, "bootstrap"),
          );
        writeFileSync(
          path.join(directory, ".dockerignore"),
          "**\n!Dockerfile\n!source.bundle\n!container-entry.mts\n!container-source.mts\n!runtime-values.mts\n" +
            (builder ? "!container-build-policy.mts\n!linux-prerequisites.sh\n" : ""),
        );
        if (size(stageRoot) > budgets.staging_bytes)
          throw new Error("Owned staging exceeds its 10 GiB budget");
        const buildTimeout = setupTimeout();
        abort.signal.throwIfAborted();
        state.capacity_phase = "image-build";
        state.build_name = `${prefix}-${run}`;
        save();
        const build = await docker(
          [
            "build",
            "--platform",
            "linux/amd64",
            "--progress=plain",
            "--build-arg",
            `BUILDKIT_BUILD_NAME=${state.build_name}`,
            "--tag",
            tag,
            "--build-arg",
            `SOURCE_COMMIT=${selectedCommit}`,
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
          { timeout: buildTimeout, signal: abort.signal },
        );
        state.capacity_phase = "prepared";
        save();
        writeFileSync(path.join(directory, "build.log"), build.stdout + build.stderr);
        image = imageObservation(
          firstObservation(parseJson((await docker(["image", "inspect", tag])).stdout)),
        );
        state.image = image.Id;
        state.image_inspection = image;
        save();
        state.build_cache_after_bytes = cacheBytes(
          (
            await docker(["system", "df", "--format", "json"], {
              timeout: setupTimeout(120_000),
              signal: abort.signal,
            })
          ).stdout,
        );
        if (state.build_cache_after_bytes > budgets.build_cache_bytes)
          throw new Error(
            "Build cache exceeded its observed admission budget; retain diagnostics and stop preparation",
          );
        state.prepared_reused = false;
      } else state.prepared_reused = true;
      const labels = owned(image);
      if (
        labels["io.portcove.source"] !== selectedCommit ||
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
      state.capacity_phase = "prepared";
      save();
      // Cached-image runs have not needed a remote marker until this boundary.
      if (state.prepared_reused && reservation.registerExternal)
        await reservation.registerExternal(external);
      const name = `${prefix}-${run}`;
      state.container_name = name;
      state.capacity_phase = "container-create";
      save();
      state.container = (
        await docker(
          runtimeArguments({
            name,
            run,
            image: image.Id,
            commit: selectedCommit,
            tree: source.tree,
            mode,
            files,
          }),
          { timeout: setupTimeout(120_000), signal: abort.signal },
        )
      ).stdout.trim();
      save();
      state.runtime_inspection = await inspectContainer(
        requiredState(state.container, "container ID"),
        run,
      );
      validateRuntime(state.runtime_inspection);
      save();
      const started = Date.now();
      try {
        await docker(["start", requiredState(state.container, "container ID")], {
          timeout: Math.min(timeout, 60_000),
          signal: abort.signal,
        });
        const remaining = timeout - (Date.now() - started);
        if (remaining <= 0) throw new Error("Container startup exhausted the execution deadline");
        state.container_exit = Number(
          (
            await docker(["wait", requiredState(state.container, "container ID")], {
              timeout: remaining,
              signal: abort.signal,
            })
          ).stdout.trim(),
        );
        if (
          !Number.isInteger(state.container_exit) ||
          state.container_exit < 0 ||
          state.container_exit > 255
        )
          throw new Error("Docker wait returned an invalid exit status");
      } catch (error) {
        state.interruption = interrupted ?? "timeout-or-wait-failure";
        state.wait_error = errorMessage(error);
        state.wait_failure = isRecord(error) ? error.result : undefined;
        const current = await inspectContainer(requiredState(state.container, "container ID"), run);
        if (current.State.Running)
          await docker(["stop", "--time", "10", requiredState(state.container, "container ID")], {
            timeout: 20_000,
          });
        state.container_exit = (
          await inspectContainer(requiredState(state.container, "container ID"), run)
        ).State.ExitCode;
      }
      state.runtime_ms = Date.now() - started;
      const stopped = await inspectContainer(requiredState(state.container, "container ID"), run);
      if (stopped.State.Running)
        throw new Error("Container remains active; retaining host capacity");
      await reservation.release();
      reservation = null;
      state.capacity_released = true;
      state.status = state.interruption
        ? "interrupted"
        : state.container_exit === 0
          ? "passed"
          : "failed";
      state.causal_exit = state.interruption ? 124 : state.container_exit;
      save();
      state.storage_after = await doctor({ networkRequired: false });
      await exportRun(state, directory);
      save();
      return { ...state, exit_code: state.interruption ? 124 : state.container_exit };
    } catch (error) {
      // A timed-out client may have completed creation on the daemon. Read back
      // the exact previously recorded name; never repeat that mutation blindly.
      if (state.container_name && !state.container) {
        try {
          const existing = await inspectContainer(state.container_name, run);
          state.container = existing.Id;
          state.creation_readback = existing;
        } catch (readback) {
          state.creation_readback_error = errorMessage(readback);
        }
      }
      if (
        state.capacity_phase === "image-build" &&
        ((isRecord(error) &&
          isRecord(error.result) &&
          error.result.interruption === "already-aborted") ||
          errorCode(error) === "ENOENT")
      )
        state.capacity_phase = "prepared";
      if (reservation) {
        try {
          if (await preparationStopped(state)) {
            await reservation.release();
            reservation = null;
            state.capacity_released = true;
          }
        } catch (cleanup) {
          state.capacity_cleanup_error = errorMessage(cleanup);
        }
      }
      if (reservation)
        state.capacity_retained =
          "Preparation or remote-engine quiescence is not proven; no automatic release";
      if (interrupted && !state.capacity) {
        state.status = "admission-cancelled";
        state.causal_exit = interrupted === "SIGINT" ? 130 : 143;
      }
      saveFailure(state, error, directory, save);
      throw Object.assign(
        new Error(
          `${errorMessage(error)}; recoverable state: ${stateFile}${state.container ? `; container ${state.container}` : ""}`,
        ),
        { state, code: errorCode(error) },
      );
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
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
        console.error(`Secondary event-write failure: ${errorMessage(sink)}`);
      }
    }
  }

  async function cleanup(apply = false, minAgeHours: number = budgets.retention_hours) {
    if (!Number.isFinite(minAgeHours) || minAgeHours < 0 || minAgeHours > 8760)
      throw new Error("Cleanup age must be 0..8760 hours");
    if (!initializeStage(false)) return { apply, candidates: [], images: [] };
    await validateEvidenceStore(evidenceRoot);
    const candidates = [];
    const protectedImages = new Set();
    for (const name of readdirSync(stageRoot)) {
      if (!/^[0-9a-f-]{36}$/u.test(name)) continue;
      const directory = path.join(stageRoot, name);
      const state = runState(json(path.join(directory, "host.json")));
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
      const info = await inspectContainer(requiredState(state.container, "container ID"), name);
      if (info.State.Running || info.State.ExitCode !== 0) {
        protectedImages.add(state.image);
        continue;
      }
      if (
        path.resolve(requiredState(state.export, "published export")) !==
        path.join(evidenceRoot, name)
      )
        throw new Error("Unknown published evidence location; cleanup refused");
      verifyPublication(requiredState(state.export, "published export"), state);
      candidates.push({
        run: name,
        container: state.container,
        staging: directory,
        image_retained: state.image,
        evidence_retained: state.export,
      });
      if (apply) {
        await inspectContainer(requiredState(state.container, "container ID"), name);
        await docker(["container", "rm", requiredState(state.container, "container ID")]);
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
    const eligibleImages = new Set(candidates.map((item) => item.image_retained));
    const eligibleContainers = new Set(candidates.map((item) => item.container));
    for (const image of (await imageUsage()).images) {
      if (!Number.isFinite(Date.parse(image.Created)))
        throw new Error("Unknown image age; cleanup refused");
      if (
        !eligibleImages.has(image.Id) ||
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
        owned(
          imageObservation(
            firstObservation(parseJson((await docker(["image", "inspect", image.Id])).stdout)),
          ),
        );
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

  async function preparationStopped(state: RunState, recoveryHost?: unknown, directory?: string) {
    if (state.capacity_phase === "local-preparation")
      return capacityChildrenStopped(state.capacity);
    if (["admitted", "prepared"].includes(state.capacity_phase ?? "")) return true;
    if (state.capacity_phase === "image-build") {
      const result = await docker(
        ["buildx", "history", "ls", "--builder", "desktop-linux", "--format", "json", "--no-trunc"],
        { timeout: 30_000 },
      );
      const records: unknown[] = result.stdout
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(parseJson);
      const completion = completedContainerPreparation(records, state.build_name);
      if (completion) {
        state.build_completion = completion;
        return true;
      }
      // An absent history record is never proof by itself. Recovery may use an
      // actual native-daemon replacement after the preserved terminal failure.
      if (
        !recoveryHost ||
        !directory ||
        records.some((item) => object(item).name === state.build_name) ||
        !(await capacityChildrenStopped(state.capacity))
      )
        return false;
      const inspection = (await docker(["buildx", "inspect", "desktop-linux"])).stdout;
      if (
        !/^Driver:[ \t]+docker[ \t]*\r?$/mu.test(inspection) ||
        !/^Status:[ \t]+running[ \t]*\r?$/mu.test(inspection)
      )
        return false;
      const logRoot = path.join(
        string(process.env.LOCALAPPDATA, "Local AppData"),
        "Docker",
        "log",
        "vm",
      );
      if (lstatSync(logRoot).isSymbolicLink())
        throw new Error("Docker lifecycle log directory is linked");
      if (realpathSync.native(logRoot).toLowerCase() !== path.resolve(logRoot).toLowerCase())
        throw new Error("Docker lifecycle log directory resolves elsewhere");
      const names = [
        "init.log",
        ...readdirSync(logRoot)
          .filter((name) => /^init\.log\.\d{8}-\d{6}\.\d{3}$/u.test(name))
          .sort()
          .reverse()
          .slice(0, 15),
      ];
      const contents = new Map<string, string>();
      const events: unknown[] = [];
      let bytes = 0;
      for (const name of names) {
        const file = path.join(logRoot, name),
          info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 ** 2)
          throw new Error("Docker lifecycle log is not an ordinary bounded file");
        bytes += info.size;
        if (bytes > 16 * 1024 ** 2) throw new Error("Docker lifecycle log read exceeds 16 MiB");
        const content = readFileSync(file, "utf8");
        contents.set(name, content);
        for (const line of content.split(/\r?\n/u)) {
          if (!line.trim()) continue;
          try {
            const event: unknown = JSON.parse(line);
            if (isRecord(event)) events.push({ ...event, source_file: name });
          } catch {
            /* Non-JSON diagnostics cannot establish lifecycle proof. */
          }
        }
      }
      const dispatchFile = path.join(directory, "failed-command.log"),
        terminalFile = path.join(directory, "events.jsonl");
      for (const file of [dispatchFile, terminalFile]) {
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 ** 2)
          throw new Error("Preparation failure evidence is not an ordinary bounded file");
      }
      const dispatch = readFileSync(dispatchFile, "utf8"),
        terminal = readFileSync(terminalFile, "utf8");
      const proof = restartedNativePreparation({
        state,
        observation: recoveryHost,
        dispatch,
        terminal: terminal.trim().split(/\r?\n/u).filter(Boolean).map(parseJson),
        lifecycle: events,
      });
      if (!proof) return false;
      const proofRoot = path.join(directory, `daemon-restart-proof-${randomUUID()}`);
      mkdirSync(proofRoot, { recursive: true });
      if (lstatSync(proofRoot).isSymbolicLink())
        throw new Error("Recovery proof directory is linked");
      const sources = [];
      for (const name of new Set([proof.stopped.source_file, proof.started.source_file])) {
        const file = string(name, "lifecycle source"),
          content = contents.get(file);
        if (content === undefined) throw new Error("Lifecycle source was not collected");
        writeFileSync(path.join(proofRoot, file), content, { flag: "wx" });
        sources.push({ file, bytes: Buffer.byteLength(content), sha256: hash(content) });
      }
      state.daemon_restart_proof = {
        ...proof,
        sources,
        dispatch_sha256: hash(dispatch),
        terminal_sha256: hash(terminal),
        observation: recoveryHost,
        proof_directory: path.basename(proofRoot),
        recovery_driver: {
          commit: await git(["rev-parse", "HEAD"]),
          host_sha256: hash(readFileSync(fileURLToPath(import.meta.url))),
          policy_sha256: hash(readFileSync(path.join(root, "scripts/container-recovery.mts"))),
        },
      };
      writeFileSync(
        path.join(proofRoot, "proof.json"),
        JSON.stringify(state.daemon_restart_proof, null, 2),
        { flag: "wx" },
      );
      return true;
    }
    const inspected = await inspectContainer(
      requiredState(state.container ?? state.container_name, "container identity"),
      state.run,
    );
    return !inspected.State.Running;
  }

  async function recover(run: string) {
    if (!/^[0-9a-f-]{36}$/u.test(run ?? "")) throw new Error("Recovery requires an exact run UUID");
    initializeStage(false);
    const directory = path.join(stageRoot, run),
      file = path.join(directory, "host.json");
    const state = runState(json(file));
    if (state.tool !== tool || state.workspace !== workspace || state.run !== run)
      throw new Error("Recovery ownership mismatch");
    const recoveryHost = await doctor({ networkRequired: false });
    if (state.capacity && !state.capacity_released) {
      state.capacity_recovery_journal = await reconcileExternalCapacity(
        state.capacity,
        state.capacity_external,
        () => preparationStopped(state, recoveryHost, directory),
      );
      state.capacity_released = true;
      record(file, state);
    }
    if (state.export_complete) {
      verifyPublication(requiredState(state.export, "published export"), state);
      return { run, export: state.export, unchanged: true };
    }
    if (!state.container)
      return {
        run,
        status: state.status,
        capacity_released: state.capacity_released,
        retained: file,
      };
    const result = await exportRun(state, directory);
    state.status = state.execution_status ?? result.status;
    record(file, state);
    return { run, export: state.export, status: state.status };
  }

  async function main() {
    const args = process.argv.slice(2);
    if (!args.length || args.includes("--help")) {
      console.log(
        builder
          ? "usage: container-build.mts doctor | run --commit <40-hex> [--exclude-dirty] [--mode check|package] [--timeout-ms <100..5400000>] | export --run <UUID> | clean [--apply] [--older-than-hours <0..8760>]"
          : "usage: container-browser.mts doctor | run --commit <40-hex> [--exclude-dirty] [--mode suite|probe|exact] [--timeout-ms <100..1800000>] [--files <literal desktop test files>...] | export --run <UUID> | clean [--apply] [--older-than-hours <0..8760>]",
      );
      return;
    }
    const action = args.shift();
    if (action === "doctor" && !args.length) console.log(JSON.stringify(await doctor()));
    else if (action === "clean") {
      let apply = false,
        age: number = budgets.retention_hours;
      while (args.length) {
        const flag = args.shift();
        if (flag === "--apply") apply = true;
        else if (flag === "--older-than-hours") age = Number(args.shift());
        else throw new Error(`Unknown cleanup argument ${flag}`);
      }
      console.log(JSON.stringify(await cleanup(apply, age)));
    } else if (action === "export" && args.length === 2 && args[0] === "--run")
      console.log(JSON.stringify(await recover(requiredState(args[1], "recovery run"))));
    else if (action === "run") {
      const options: BrowserOptions = { commit: undefined };
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
  return {
    budgets,
    command,
    validateEngine,
    validateDesktop,
    diskFromSettings,
    linuxStorage,
    cacheBytes,
    doctor,
    selectedSource,
    runtimeArguments,
    validateRuntime,
    verifyPublication,
    saveFailure,
    browser,
    cleanup,
    main,
  };
}
