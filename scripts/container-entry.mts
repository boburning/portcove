import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
// Executed only in the prepared, non-root browser container.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import { assertCommittedWorkspace } from "./container-source.mts";

const root = "/workspace";
const output = path.join(root, "work/container-results");
const id = process.env.PORTCOVE_CONTAINER_RUN;
if (
  typeof id !== "string" ||
  !/^[0-9a-f-]{36}$/u.test(id) ||
  !process.getuid ||
  process.getuid() === 0
)
  throw new Error("A labelled non-root browser task and run ID are required");
mkdirSync(output);
const log = path.join(output, "command.log");
writeFileSync(log, "", { flag: "wx" });
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
};
const [mode, ...files] = process.argv.slice(2);
const commands = {
  suite: ["scripts/run-viteplus.mts", "run", "--no-cache", "frontend:browser"],
  probe: ["apps/desktop/scripts/browser-runtime.mts", "probe"],
  exact: ["scripts/run-ui-tests.mts", "exact", ...files],
};
if (
  (mode !== "suite" && mode !== "probe" && mode !== "exact") ||
  (mode === "exact" ? !files.length : files.length)
)
  throw new Error("Expected suite, probe, or exact <literal desktop test files>");
interface PhaseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}
interface Phase extends PhaseResult {
  phase: string;
  command: string[];
  output_prefix: string;
}
interface Report {
  format_version: number;
  run: string;
  started_at: string;
  commit: string;
  tree: string;
  image: string | undefined;
  platform: NodeJS.Platform;
  architecture: string;
  uid: number;
  node: string;
  command: string[];
  cwd: string;
  mode: "suite" | "probe" | "exact";
  files: string[];
  fresh_execution: boolean;
  status: "running" | "interrupted" | "passed" | "failed";
  artifacts: { path: string; bytes: number; sha256: string }[];
  phases: Phase[];
  tools?: { node: string; pnpm: string };
  chromium?: string | undefined;
  command_exit?: number | null;
  signal?: NodeJS.Signals | null;
  interruption?: string | null;
  error?: string;
  export_error?: string;
  finished_at?: string;
}
const report: Report = {
  format_version: 1,
  run: id,
  started_at: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  image: process.env.PORTCOVE_CONTAINER_IMAGE,
  platform: process.platform,
  architecture: process.arch,
  uid: process.getuid(),
  node: process.versions.node,
  command: [process.execPath, ...commands[mode]],
  cwd: root,
  mode,
  files,
  fresh_execution: false,
  status: "running",
  artifacts: [],
  phases: [],
};
if (
  report.commit !== process.env.PORTCOVE_CONTAINER_COMMIT ||
  report.tree !== process.env.PORTCOVE_CONTAINER_TREE
)
  throw new Error("Requested and executed source identity differ");
const save = () =>
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
let child: ReturnType<typeof spawn> | undefined;
let interrupted: string | undefined;
let force: ReturnType<typeof setTimeout> | undefined;
const stop = (signal: string) => {
  interrupted ??= signal;
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error;
    }
    const pid = child.pid;
    force ??= setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 5000);
  }
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
let bytes = 0;
let exported = 0;
function capture(directory: string, target: string) {
  if (!existsSync(directory)) return;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const source = path.join(directory, item.name);
    const destination = path.join(target, item.name);
    const details = lstatSync(source);
    if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile()))
      throw new Error(`Evidence refuses non-regular entry: ${source}`);
    if (details.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      capture(source, destination);
    } else {
      exported += details.size;
      if (exported > 1024 ** 3)
        throw new Error("Browser evidence exceeds 1 GiB; retain container for recovery");
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      report.artifacts.push({
        path: path.relative(output, destination),
        bytes: details.size,
        sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"),
      });
    }
  }
}
async function execute(args: string[], phase: string) {
  let prefix = "";
  const result = await new Promise<PhaseResult>((resolve, reject) => {
    child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const streams = [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ] as const;
    for (const [stream, destination] of streams)
      stream?.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 100 * 1024 ** 2) {
          stop("log-budget");
          return;
        }
        appendFileSync(log, data);
        destination.write(data);
        if (prefix.length < 64 * 1024)
          prefix += data.toString("utf8").slice(0, 64 * 1024 - prefix.length);
      });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(force);
      force = undefined;
      resolve({ code, signal });
    });
  });
  report.phases.push({
    phase,
    command: [process.execPath, ...args],
    ...result,
    output_prefix: prefix,
  });
  return result;
}
try {
  const capacity = statfsSync(root);
  if (Number(capacity.bavail) * Number(capacity.bsize) < 20 * 1024 ** 3)
    throw new Error("Container filesystem has less than 20 GiB available");
  if (existsSync("/usr/bin/sudo") || existsSync("/var/run/docker.sock"))
    throw new Error("Task runtime contains sudo or a Docker socket");
  if (readFileSync(path.join(root, ".node-version"), "utf8").trim() !== process.versions.node)
    throw new Error("Resolved Node does not match the selected source pin");
  for (const file of [
    "installed-system-packages.txt",
    "installed-npm-packages.json",
    "tool-versions.json",
  ])
    copyFileSync(path.join("/portcove", file), path.join(output, file));
  const tools: unknown = JSON.parse(readFileSync(path.join(output, "tool-versions.json"), "utf8"));
  const metadata: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (
    !isRecord(tools) ||
    typeof tools.pnpm !== "string" ||
    typeof tools.node !== "string" ||
    !isRecord(metadata) ||
    typeof metadata.packageManager !== "string"
  )
    throw new Error("Prepared tool metadata is invalid");
  report.tools = { ...tools, pnpm: tools.pnpm, node: tools.node };
  const packageManager = metadata.packageManager;
  if (
    `pnpm@${report.tools.pnpm}` !== packageManager ||
    report.tools.node !== `v${process.versions.node}`
  )
    throw new Error("Prepared tool versions do not match selected Node/package-manager pins");
  const bootstrap = await execute(
    ["apps/desktop/scripts/browser-runtime.mts", "bootstrap"],
    "browser-readiness",
  );
  if (bootstrap.code !== 0 || interrupted)
    throw new Error("Contained browser readiness failed or was interrupted");
  report.chromium = /Browser ready: Chromium headless ([^\s]+)/u.exec(
    report.phases[0]?.output_prefix ?? "",
  )?.[1];
  if (!report.chromium)
    throw new Error("Canonical bootstrap did not identify the actual Chromium version");
  assertCommittedWorkspace(root, report.commit, report.tree);
  report.fresh_execution = true;
  const result = await execute(commands[mode], "required-execution");
  report.command_exit = result.code;
  report.signal = result.signal;
  report.interruption = interrupted ?? null;
  report.status = interrupted ? "interrupted" : result.code === 0 ? "passed" : "failed";
  process.exitCode = interrupted ? 130 : (result.code ?? 1);
} catch (error) {
  report.status = interrupted ? "interrupted" : "failed";
  report.error = errorMessage(error);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  clearTimeout(force);
  try {
    capture(path.join(root, "work/bt"), path.join(output, "traces"));
    capture(path.join(root, ".vitest/attachments"), path.join(output, "attachments/root"));
    capture(
      path.join(root, "apps/desktop/.vitest/attachments"),
      path.join(output, "attachments/desktop"),
    );
  } catch (error) {
    report.export_error = errorMessage(error);
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  save();
}
