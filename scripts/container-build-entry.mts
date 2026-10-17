import type { ChildProcess } from "node:child_process";
import type { FileIdentity } from "./development-evidence.mts";
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
// Executed only in the prepared, non-root Ubuntu build container.
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
import {
  assertFreshBuildOutputs,
  assertPackageExecutable,
  builtPackage,
  desktopFormats,
  validatePackageMetadata,
} from "./container-build-policy.mts";

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
if ((mode !== "check" && mode !== "package") || files.length)
  throw new Error("Expected check or package");
const commands = {
  check: [
    "scripts/run-rust-tests.mts",
    "--guard-command",
    "cargo",
    "check",
    "--locked",
    "--offline",
    "--workspace",
    "--all-targets",
  ],
  package: [
    "scripts/run-rust-tests.mts",
    "--guard-command",
    "cargo",
    "build",
    "--locked",
    "--offline",
    "--release",
    "-p",
    "portcove-cli",
  ],
};
interface PhaseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}
interface BuildPhase extends PhaseResult {
  phase: string;
  command: string[];
  output_prefix: string;
}
interface FormatObservation extends PhaseResult {
  status: "failed" | "validated";
  artifact?: string;
  metadata?: ReturnType<typeof validatePackageMetadata>;
  error?: string;
}
interface BuildReport {
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
  mode: "check" | "package";
  files: string[];
  fresh_execution: boolean;
  status: "running" | "passed" | "interrupted" | "failed";
  artifacts: FileIdentity[];
  phases: BuildPhase[];
  tools?: { pnpm: string; node: string; rustc: string };
  os_release?: string;
  formats?: Record<string, FormatObservation>;
  command_exit?: number;
  signal?: NodeJS.Signals | null;
  interruption?: string | null;
  error?: string;
  export_error?: string;
  finished_at?: string;
}
function required<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined)
    throw new Error("Required build observation is missing");
  return value;
}
const report: BuildReport = {
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
let child: ChildProcess | undefined;
let interrupted: NodeJS.Signals | "log-budget" | undefined;
let force: ReturnType<typeof setTimeout> | undefined;
const stop = (signal: NodeJS.Signals | "log-budget") => {
  interrupted ??= signal;
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error;
    }
    force ??= setTimeout(() => {
      try {
        process.kill(-required(child?.pid), "SIGKILL");
      } catch {}
    }, 5000);
  }
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
let bytes = 0;
let exported = 0;
function capture(directory: string, target: string, suffix: string) {
  if (!existsSync(directory)) return;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    // AppDir/bundler intermediates remain recoverable in the owned container.
    // Export only final package candidates, including failed candidates as evidence.
    if (!item.name.endsWith(suffix)) continue;
    const source = path.join(directory, item.name);
    const destination = path.join(target, item.name);
    const details = lstatSync(source);
    if (details.isSymbolicLink() || !details.isFile())
      throw new Error(`Evidence refuses non-regular entry: ${source}`);
    {
      exported += details.size;
      if (exported > 1024 ** 3)
        throw new Error("Builder evidence exceeds 1 GiB; retain container for recovery");
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
async function execute(args: string[], phase: string, executable = process.execPath, cwd = root) {
  let prefix = "";
  const result = await new Promise<PhaseResult>((resolve) => {
    const current = spawn(executable, args, {
      cwd,
      env: { ...process.env, CARGO_NET_OFFLINE: "true", CARGO_BUILD_JOBS: "2" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = current;
    for (const [stream, destination] of [
      [current.stdout, process.stdout],
      [current.stderr, process.stderr],
    ] as const)
      stream.on("data", (data: Buffer) => {
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
    current.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    current.on("close", (code, signal) => {
      clearTimeout(force);
      force = undefined;
      resolve({ code, signal });
    });
  });
  report.phases.push({
    phase,
    command: [executable, ...args],
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
  const packageMetadata: unknown = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (
    !isRecord(tools) ||
    typeof tools.pnpm !== "string" ||
    typeof tools.node !== "string" ||
    typeof tools.rustc !== "string" ||
    !isRecord(packageMetadata) ||
    typeof packageMetadata.packageManager !== "string"
  )
    throw new Error("Prepared build tool metadata is invalid");
  report.tools = { ...tools, pnpm: tools.pnpm, node: tools.node, rustc: tools.rustc };
  const packageManager = packageMetadata.packageManager;
  if (
    `pnpm@${report.tools.pnpm}` !== packageManager ||
    report.tools.node !== `v${process.versions.node}`
  )
    throw new Error("Prepared tool versions do not match selected Node/package-manager pins");
  const configuration: unknown = JSON.parse(
    readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  if (!isRecord(configuration) || typeof configuration.version !== "string")
    throw new Error("Selected application version is missing");
  const version = configuration.version;
  const rustPin = /channel\s*=\s*"([^"]+)"/u.exec(
    readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (!report.tools.rustc.startsWith(`rustc ${rustPin} `))
    throw new Error("Prepared Rust toolchain differs from selected source");
  report.os_release = readFileSync("/etc/os-release", "utf8");
  if (!/^VERSION_ID="22.04"$/mu.test(report.os_release))
    throw new Error("Builder requires Ubuntu 22.04");
  assertFreshBuildOutputs(root);
  const runRequired = async (
    args: string[],
    phase: string,
    executable = process.execPath,
    cwd = root,
  ) => {
    const result = await execute(args, phase, executable, cwd);
    if (result.code !== 0 || interrupted) throw new Error(`${phase} failed (${result.code})`);
    return result;
  };
  assertCommittedWorkspace(root, report.commit, report.tree);
  report.fresh_execution = true;
  await runRequired(commands[mode], mode === "check" ? "workspace-check" : "cli-build");
  if (mode === "check")
    await runRequired(["apps/desktop/scripts/build-frontend.mts", "--fresh"], "frontend-build");
  else {
    await runRequired(
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        "scripts/package-cli.ps1",
        "-PlatformLabel",
        "linux-x86_64",
        "-TargetRoot",
        path.join(root, "target"),
      ],
      "cli-package",
      "pwsh",
    );
    const archives = readdirSync(path.join(root, "release-assets")).filter((f: string) =>
      f.endsWith(".tar.gz"),
    );
    if (archives.length !== 1) throw new Error("Expected exactly one freshly produced CLI archive");
    await runRequired(
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        "scripts/smoke-test-cli-archive.ps1",
        "-ArchivePath",
        path.join(root, "release-assets", required(archives[0])),
        "-PlatformLabel",
        "linux-x86_64",
        "-Version",
        version,
      ],
      "cli-smoke",
      "pwsh",
    );
    await runRequired(["apps/desktop/scripts/build-frontend.mts", "--fresh"], "frontend-build");
    const formats: Record<string, FormatObservation> = {};
    report.formats = formats;
    for (const format of desktopFormats) {
      if (interrupted) break;
      const phase = await execute(
        [
          "scripts/run-rust-tests.mts",
          "--guard-command",
          "pnpm",
          "--dir",
          "apps/desktop",
          "desktop:build",
          "--bundles",
          format,
          "--ci",
          "--no-sign",
        ],
        `desktop-${format}`,
      );
      const formatReport: FormatObservation = {
        status: "failed",
        code: phase.code,
        signal: phase.signal,
      };
      formats[format] = formatReport;
      try {
        const artifact = builtPackage(
          path.join(root, "target/release/bundle", format),
          format,
          phase,
        );
        formatReport.artifact = path.relative(root, artifact);
        if (format === "appimage") {
          const inspection = path.join(root, "work/appimage-inspection");
          mkdirSync(inspection);
          await runRequired(["--appimage-extract"], "inspect-appimage", artifact, inspection);
          const binary = path.join(inspection, "squashfs-root/usr/bin/portcove-desktop");
          if (
            !existsSync(binary) ||
            !lstatSync(binary).isFile() ||
            !(lstatSync(binary).mode & 0o111)
          )
            throw new Error("AppImage lacks the selected desktop executable");
          await runRequired(["--brief", binary], "inspect-appimage-elf", "file");
          if (!required(report.phases.at(-1)).output_prefix.includes("x86-64"))
            throw new Error("AppImage desktop executable is not x86-64");
        } else {
          const args =
            format === "deb"
              ? ["--show", "--showformat=${Package}\\n${Version}\\n${Architecture}\\n", artifact]
              : [
                  "-qp",
                  "--queryformat",
                  "%{NAME}\\n%{VERSION}\\n%{RELEASE}\\n%{ARCH}\\n",
                  artifact,
                ];
          await runRequired(args, `inspect-${format}`, format === "deb" ? "dpkg-deb" : "rpm");
          formatReport.metadata = validatePackageMetadata(
            format,
            required(report.phases.at(-1)).output_prefix,
            version,
          );
          await runRequired(
            format === "deb" ? ["--contents", artifact] : ["-qp", "--dump", artifact],
            `inspect-${format}-contents`,
            format === "deb" ? "dpkg-deb" : "rpm",
          );
          assertPackageExecutable(format, required(report.phases.at(-1)).output_prefix);
        }
        formatReport.status = "validated";
      } catch (error) {
        formatReport.error = errorMessage(error);
      }
    }
    if (
      Object.keys(formats).length !== 3 ||
      Object.values(formats).some((f) => f.status !== "validated")
    )
      throw new Error("One or more desktop formats did not build; see individual command logs");
  }
  report.command_exit = 0;
  report.signal = null;
  report.interruption = interrupted ?? null;
  report.status = interrupted ? "interrupted" : "passed";
  process.exitCode = interrupted ? 130 : 0;
} catch (error) {
  report.status = interrupted ? "interrupted" : "failed";
  report.error = errorMessage(error);
  report.command_exit = report.phases.findLast((phase) => phase.code !== 0)?.code ?? 1;
  report.interruption = interrupted ?? null;
  process.exitCode = interrupted ? 130 : 1;
} finally {
  clearTimeout(force);
  try {
    capture(path.join(root, "release-assets"), path.join(output, "artifacts/cli"), ".tar.gz");
    for (const format of desktopFormats)
      capture(
        path.join(root, "target/release/bundle", format),
        path.join(output, "artifacts/desktop", format),
        format === "appimage" ? ".AppImage" : `.${format}`,
      );
  } catch (error) {
    report.export_error = errorMessage(error);
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  save();
}
