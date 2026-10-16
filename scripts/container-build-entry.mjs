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
import { assertCommittedWorkspace } from "./container-source.mjs";
import {
  assertFreshBuildOutputs,
  assertPackageExecutable,
  builtPackage,
  desktopFormats,
  validatePackageMetadata,
} from "./container-build-policy.mjs";

const root = "/workspace";
const output = path.join(root, "work/container-results");
const id = process.env.PORTCOVE_CONTAINER_RUN;
if (!/^[0-9a-f-]{36}$/u.test(id ?? "") || process.getuid() === 0)
  throw new Error("A labelled non-root browser task and run ID are required");
mkdirSync(output);
const log = path.join(output, "command.log");
writeFileSync(log, "", { flag: "wx" });
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
};
const [mode, ...files] = process.argv.slice(2);
if (!["check", "package"].includes(mode) || files.length)
  throw new Error("Expected check or package");
const commands = {
  check: [
    "scripts/run-rust-tests.mjs",
    "--guard-command",
    "cargo",
    "check",
    "--locked",
    "--offline",
    "--workspace",
    "--all-targets",
  ],
  package: [
    "scripts/run-rust-tests.mjs",
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
const report = {
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
let child;
let interrupted;
let force;
const stop = (signal) => {
  interrupted ??= signal;
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    force ??= setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
  }
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
let bytes = 0;
let exported = 0;
function capture(directory, target, suffix) {
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
async function execute(args, phase, executable = process.execPath, cwd = root) {
  let prefix = "";
  const result = await new Promise((resolve, reject) => {
    child = spawn(executable, args, {
      cwd,
      env: { ...process.env, CARGO_NET_OFFLINE: "true", CARGO_BUILD_JOBS: "2" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      stream.on("data", (data) => {
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
  report.tools = JSON.parse(readFileSync(path.join(output, "tool-versions.json"), "utf8"));
  const packageManager = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).packageManager;
  if (
    `pnpm@${report.tools.pnpm}` !== packageManager ||
    report.tools.node !== `v${process.versions.node}`
  )
    throw new Error("Prepared tool versions do not match selected Node/package-manager pins");
  const version = JSON.parse(
    readFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json")),
  ).version;
  const rustPin = /channel\s*=\s*"([^"]+)"/u.exec(
    readFileSync(path.join(root, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (!report.tools.rustc.startsWith(`rustc ${rustPin} `))
    throw new Error("Prepared Rust toolchain differs from selected source");
  report.os_release = readFileSync("/etc/os-release", "utf8");
  if (!/^VERSION_ID="22.04"$/mu.test(report.os_release))
    throw new Error("Builder requires Ubuntu 22.04");
  assertFreshBuildOutputs(root);
  const required = async (args, phase, executable, cwd) => {
    const result = await execute(args, phase, executable, cwd);
    if (result.code !== 0 || interrupted) throw new Error(`${phase} failed (${result.code})`);
    return result;
  };
  assertCommittedWorkspace(root, report.commit, report.tree);
  report.fresh_execution = true;
  await required(commands[mode], mode === "check" ? "workspace-check" : "cli-build");
  if (mode === "check")
    await required(["apps/desktop/scripts/build-frontend.mjs", "--fresh"], "frontend-build");
  else {
    await required(
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
    const archives = readdirSync(path.join(root, "release-assets")).filter((f) =>
      f.endsWith(".tar.gz"),
    );
    if (archives.length !== 1) throw new Error("Expected exactly one freshly produced CLI archive");
    await required(
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        "scripts/smoke-test-cli-archive.ps1",
        "-ArchivePath",
        path.join(root, "release-assets", archives[0]),
        "-PlatformLabel",
        "linux-x86_64",
        "-Version",
        version,
      ],
      "cli-smoke",
      "pwsh",
    );
    await required(["apps/desktop/scripts/build-frontend.mjs", "--fresh"], "frontend-build");
    report.formats = {};
    for (const format of desktopFormats) {
      if (interrupted) break;
      const phase = await execute(
        [
          "scripts/run-rust-tests.mjs",
          "--guard-command",
          "pnpm",
          "--dir",
          "apps/desktop",
          "tauri",
          "build",
          "--bundles",
          format,
          "--ci",
          "--no-sign",
        ],
        `desktop-${format}`,
      );
      report.formats[format] = {
        status: "failed",
        code: phase.code,
        signal: phase.signal,
      };
      try {
        const artifact = builtPackage(
          path.join(root, "target/release/bundle", format),
          format,
          phase,
        );
        report.formats[format].artifact = path.relative(root, artifact);
        if (format === "appimage") {
          const inspection = path.join(root, "work/appimage-inspection");
          mkdirSync(inspection);
          await required(["--appimage-extract"], "inspect-appimage", artifact, inspection);
          const binary = path.join(inspection, "squashfs-root/usr/bin/portcove-desktop");
          if (
            !existsSync(binary) ||
            !lstatSync(binary).isFile() ||
            !(lstatSync(binary).mode & 0o111)
          )
            throw new Error("AppImage lacks the selected desktop executable");
          await required(["--brief", binary], "inspect-appimage-elf", "file");
          if (!report.phases.at(-1).output_prefix.includes("x86-64"))
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
          await required(args, `inspect-${format}`, format === "deb" ? "dpkg-deb" : "rpm");
          report.formats[format].metadata = validatePackageMetadata(
            format,
            report.phases.at(-1).output_prefix,
            version,
          );
          await required(
            format === "deb" ? ["--contents", artifact] : ["-qp", "--dump", artifact],
            `inspect-${format}-contents`,
            format === "deb" ? "dpkg-deb" : "rpm",
          );
          assertPackageExecutable(format, report.phases.at(-1).output_prefix);
        }
        report.formats[format].status = "validated";
      } catch (error) {
        report.formats[format].error = error.message;
      }
    }
    if (
      Object.keys(report.formats).length !== 3 ||
      Object.values(report.formats).some((f) => f.status !== "validated")
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
  report.error = error.message;
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
    report.export_error = error.message;
    process.exitCode = 1;
  }
  report.finished_at = new Date().toISOString();
  save();
}
