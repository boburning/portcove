import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readdir,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  prepareReleasePublicBuildInputs,
  readBoundedPublicBuildInputFile,
} from "./release-public-build-inputs.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { runResourceCommand } from "./resource-command.mts";
import { collectReleaseArtifacts } from "./write-release-checksums.mts";
import { projectWindowsNsisExecutable } from "./release-compiler-desktop.mts";

const project = fileURLToPath(new URL("..", import.meta.url));
const members = [
  "root.json",
  "updater-public.key",
  "packaging.json",
  "bundle.json",
  "tauri.release-public.conf.json",
  "build-inputs.json",
];

async function identity(
  root: string,
  filename: string,
  maximum: number,
  kind: "public-input" | "tool" = "public-input",
) {
  const absolute = await assertOwnedUnlinkedPath(
    root,
    path.resolve(root, filename),
    "compiler input",
  );
  const stat = await lstat(absolute);
  if (
    !stat.isFile() ||
    (kind === "tool" ? stat.nlink < 1 : stat.nlink !== 1) ||
    stat.size < 1 ||
    stat.size > maximum
  )
    throw new Error("compiler input is not a bounded regular unlinked file");
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      before.nlink !== stat.nlink ||
      before.size !== stat.size
    )
      throw new Error("compiler input identity changed before capture");
    const bytes = Buffer.alloc(64 * 1024);
    const digest = createHash("sha256");
    let length = 0;
    while (length <= maximum) {
      const read = await handle.read(bytes, 0, Math.min(bytes.length, maximum + 1 - length), null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
      digest.update(bytes.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (
      length !== stat.size ||
      length > maximum ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.nlink !== before.nlink
    )
      throw new Error("compiler input changed during capture");
    const finalPath = await lstat(absolute);
    if (
      finalPath.dev !== after.dev ||
      finalPath.ino !== after.ino ||
      finalPath.nlink !== after.nlink
    )
      throw new Error("compiler input path identity changed during capture");
    return {
      filename,
      bytes: length,
      sha256: digest.digest("hex"),
      ...(kind === "tool"
        ? {
            file_identity: {
              dev: after.dev,
              ino: after.ino,
              nlink: after.nlink,
              mtime_ms: after.mtimeMs,
              ctime_ms: after.ctimeMs,
            },
          }
        : {}),
    };
  } finally {
    await handle.close();
  }
}

/** Keep toolchain/public inputs and resource inheritance. Do not pass build-job
 * credentials, the OIDC endpoint/token, signing material or arbitrary secrets. */
export function releaseCompilerEnvironment(environment: NodeJS.ProcessEnv) {
  const result: NodeJS.ProcessEnv = {};
  const allowed =
    /^(?:PATH|Path|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|SystemRoot|WINDIR|COMSPEC|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_ALL|CI|GITHUB_ACTIONS|RUNNER_OS|CARGO_HOME|RUSTUP_HOME|RUSTUP_TOOLCHAIN|RUSTUP_AUTO_INSTALL|CARGO_BUILD_JOBS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|CC|CXX|AR|PKG_CONFIG_PATH|LD_LIBRARY_PATH|LIB|INCLUDE|LIBPATH|VSINSTALLDIR|VCINSTALLDIR|WindowsSdkDir|WindowsSDKVersion|VCToolsInstallDir|VisualStudioVersion|VSCMD_ARG_TGT_ARCH|VSCMD_ARG_HOST_ARCH|PORTCOVE_RESOURCE_[A-Z_]+|PORTCOVE_HEAVY_RUST_LOCK_TOKEN)$/u;
  for (const [name, value] of Object.entries(environment))
    if (allowed.test(name) && value !== undefined) result[name] = value;
  return result;
}

export interface CompilerCaptureOptions {
  interface: "cli" | "desktop";
  inputDirectory: string;
  outputRoot: string;
  platform: "windows-x86_64" | "linux-x86_64";
  expectedRevision: string;
  expectedTree: string;
  configurationRevision: string;
  manifestSha256: string;
  runId: string;
  runAttempt: number;
  targetDirectory?: string;
  retainDirectory?: (directory: string, targetDirectory: string) => Promise<void>;
  /** Test seam never yields original compiler acceptance. */
  invoke?: (
    executable: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<number>;
}

/** Bounded post-bundling file observation only, never compiler acceptance. */
export async function captureWindowsDesktopExecutable(targetDirectory: string) {
  if (!path.isAbsolute(targetDirectory)) throw new Error("exact compiler target required");
  const filename = path.join("release", "portcove-desktop.exe");
  const before = await identity(targetDirectory, filename, 256 * 1024 * 1024);
  const bytes = await readBoundedPublicBuildInputFile(targetDirectory, filename, 256 * 1024 * 1024);
  const projected = projectWindowsNsisExecutable(bytes);
  if (
    projected.bytes !== before.bytes ||
    projected.sha256 !== before.sha256 ||
    !isDeepStrictEqual(before, await identity(targetDirectory, filename, 256 * 1024 * 1024))
  )
    throw new Error("desktop compiler executable changed during final capture");
  return projected;
}

/** Direct parent invocation observation. Candidate compilation remains untrusted:
 * this captures use of the fixed recipe, not protected semantic/native acceptance.
 * The existing resource supervisor owns descendant teardown and host admission. */
export async function captureReleaseCompiler(root: string, options: CompilerCaptureOptions) {
  if (
    [root, options.inputDirectory, options.outputRoot].some(
      (value) => !path.isAbsolute(value) || /[\r\n\0]/u.test(value),
    )
  )
    throw new Error("compiler capture requires exact absolute private paths");
  if (
    !/^[a-f0-9]{40}$/u.test(options.expectedRevision) ||
    !/^[a-f0-9]{40}$/u.test(options.expectedTree) ||
    !/^[1-9][0-9]{0,15}$/u.test(options.runId) ||
    !Number.isSafeInteger(options.runAttempt) ||
    options.runAttempt < 1 ||
    !["cli", "desktop"].includes(options.interface) ||
    !["windows-x86_64", "linux-x86_64"].includes(options.platform)
  )
    throw new Error("compiler exact source/run/platform identities unavailable");
  if (
    !options.invoke &&
    (process.arch !== "x64" ||
      (options.platform === "windows-x86_64"
        ? process.platform !== "win32"
        : process.platform !== "linux"))
  )
    throw new Error("compiler native host differs from the selected platform");
  const gitEnvironment = {
    ...releaseCompilerEnvironment(process.env),
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-C", root, ...args],
      {
        env: gitEnvironment,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 64 * 1024,
      },
    ).trim();
  if (
    git(["rev-parse", "HEAD"]) !== options.expectedRevision ||
    git(["rev-parse", "HEAD^{tree}"]) !== options.expectedTree
  )
    throw new Error("compiler checkout differs from exact reviewed source/tree");
  git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
  // A beta build never consumes a restored/shared Cargo target. The CLI creates
  // this private attempt directory; desktop must reuse that exact owned target.
  const targetParent = path.join(root, "target");
  await assertOwnedUnlinkedPath(root, targetParent, "private compiler target parent");
  await mkdir(targetParent, { recursive: true });
  const targetOwner = {
    source_commit: options.expectedRevision,
    source_tree: options.expectedTree,
    run_id: options.runId,
    run_attempt: options.runAttempt,
    producer_job: process.env.GITHUB_JOB ?? null,
    platform: options.platform,
  };
  let targetDirectory: string;
  if (options.targetDirectory) {
    targetDirectory = await assertOwnedUnlinkedPath(
      targetParent,
      options.targetDirectory,
      "private compiler target",
    );
    const owner: unknown = JSON.parse(
      (
        await readBoundedPublicBuildInputFile(targetDirectory, "compiler-target-owner.json", 4096)
      ).toString("utf8"),
    );
    if (!isDeepStrictEqual(owner, targetOwner))
      throw new Error("compiler target belongs to a different source/run/attempt");
    if (options.interface !== "desktop")
      throw new Error("CLI compilation requires a new private target");
  } else {
    if (options.interface !== "cli" && !options.invoke)
      throw new Error("desktop compilation requires the same attempt's CLI target");
    targetDirectory = await mkdtemp(path.join(targetParent, "release-attempt-"));
    await writeFile(
      path.join(targetDirectory, "compiler-target-owner.json"),
      JSON.stringify(targetOwner),
      { flag: "wx", mode: 0o600 },
    );
  }
  const directory = await mkdtemp(path.join(options.outputRoot, "release-compiler-"));
  const before = await Promise.all(
    members.map((name) => identity(options.inputDirectory, name, 512 * 1024)),
  );
  const configurationRoot = path.join(directory, "configuration");
  await mkdir(configurationRoot);
  for (const name of ["root.json", "updater-public.key", "packaging.json", "bundle.json"])
    await writeFile(
      path.join(configurationRoot, name),
      await readBoundedPublicBuildInputFile(options.inputDirectory, name, 512 * 1024),
      { flag: "wx", mode: 0o600 },
    );
  const prepared = await prepareReleasePublicBuildInputs({
    configurationRoot,
    observedRevision: options.configurationRevision,
    expectedRevision: options.configurationRevision,
    expectedManifestSha256: options.manifestSha256,
    outputRoot: directory,
    projectRoot: root,
  });
  const reconstructed = await Promise.all(
    members.map((name) => identity(prepared.output, name, 512 * 1024)),
  );
  if (!isDeepStrictEqual(before, reconstructed))
    throw new Error("compiler public inputs differ from ratified reconstruction");
  const cli = await realpath(path.join(root, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js"));
  const readToolJson = async (filename: string): Promise<unknown> => {
    const absolute = await realpath(filename);
    return JSON.parse(
      (
        await readBoundedPublicBuildInputFile(
          path.dirname(absolute),
          path.basename(absolute),
          64 * 1024,
        )
      ).toString("utf8"),
    );
  };
  const cliManifest = path.join(path.dirname(cli), "package.json");
  const cliPackage = await readToolJson(cliManifest);
  if (
    !cliPackage ||
    typeof cliPackage !== "object" ||
    !("version" in cliPackage) ||
    cliPackage.version !== "2.12.2"
  )
    throw new Error("compiler requires repository-pinned Tauri CLI 2.12.2");
  // Dependency links may resolve to the owned shared dependency tree. Bind actual
  // executable bytes without pretending that this supplies OS isolation.
  if ((await readdir(path.dirname(cli))).some((name) => name.endsWith(".node")))
    throw new Error("local native CLI override is outside the fixed package route");
  const nativePackage =
    options.platform === "windows-x86_64"
      ? "@tauri-apps/cli-win32-x64-msvc"
      : "@tauri-apps/cli-linux-x64-gnu";
  const native = createRequire(cli).resolve(nativePackage);
  const nativeManifestPath = createRequire(cli).resolve(`${nativePackage}/package.json`);
  const nativeManifest = await readToolJson(nativeManifestPath);
  if (
    !nativeManifest ||
    typeof nativeManifest !== "object" ||
    !("version" in nativeManifest) ||
    nativeManifest.version !== "2.12.2"
  )
    throw new Error("native Tauri binding does not match pinned CLI 2.12.2");
  const environment: NodeJS.ProcessEnv = {
    ...releaseCompilerEnvironment(process.env),
    ...prepared.environment,
    RUSTUP_AUTO_INSTALL: "0",
    CARGO_TARGET_DIR: targetDirectory,
    CARGO_BUILD_JOBS: "4",
    CARGO_INCREMENTAL: "0",
  };
  const channelText = (
    await readBoundedPublicBuildInputFile(root, "rust-toolchain.toml", 16 * 1024)
  ).toString("utf8");
  const channel = /^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/mu.exec(channelText)?.[1];
  if (!channel) throw new Error("compiler requires exact repository Rust channel");
  environment.RUSTUP_TOOLCHAIN = channel;
  const toolchainProbe = (command: string, args: string[]) =>
    execFileSync(command, args, {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 64 * 1024,
    }).trim();
  const toolchain = options.invoke
    ? null
    : {
        channel,
        cargo: toolchainProbe("rustup", ["which", "cargo"]),
        rustc: toolchainProbe("rustup", ["which", "rustc"]),
        cargo_version: toolchainProbe("cargo", ["-Vv"]),
        rustc_version: toolchainProbe("rustc", ["-vV"]),
      };
  const toolPaths: [string, string][] = [
    ["node", process.execPath],
    ["tauri-entrypoint", cli],
    ["tauri-main", path.join(path.dirname(cli), "main.js")],
    ["tauri-loader", path.join(path.dirname(cli), "index.js")],
    ["tauri-native", native],
    ["tauri-manifest", cliManifest],
    ["tauri-native-manifest", nativeManifestPath],
    ["js-lock", path.join(root, "pnpm-lock.yaml")],
    ["rust-lock", path.join(root, "Cargo.lock")],
    ["rust-channel", path.join(root, "rust-toolchain.toml")],
    ...(toolchain
      ? ([
          ["cargo", toolchain.cargo],
          ["rustc", toolchain.rustc],
        ] as [string, string][])
      : []),
  ];
  const tools = async () =>
    Promise.all(
      toolPaths.map(async ([role, filename]) => {
        const absolute = await realpath(filename);
        return {
          role,
          ...(await identity(
            path.dirname(absolute),
            path.basename(absolute),
            256 * 1024 * 1024,
            "tool",
          )),
        };
      }),
    );
  const observedTools = await tools();
  const args =
    options.interface === "cli"
      ? ["build", "--release", "-p", "portcove-cli"]
      : [
          cli,
          "build",
          "--bundles",
          options.platform === "windows-x86_64" ? "nsis" : "appimage,deb,rpm",
          "--no-sign",
          "--config",
          prepared.environment.PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION,
        ];
  const executable = options.interface === "cli" ? (toolchain?.cargo ?? "cargo") : process.execPath;
  const workingDirectory = options.interface === "cli" ? root : path.join(root, "apps/desktop");
  const started = new Date().toISOString();
  const report = {
    schema_version:
      options.interface === "desktop" && options.platform === "windows-x86_64" ? 3 : 2,
    authority: "none",
    evidence_scope: options.invoke ? "injected-executor" : "direct-build-process",
    producer_job: process.env.GITHUB_JOB ?? null,
    source_commit: options.expectedRevision,
    source_tree: options.expectedTree,
    run_id: options.runId,
    run_attempt: options.runAttempt,
    platform: options.platform,
    interface: options.interface,
    target_directory: targetDirectory,
    cargo_resource_policy: { jobs: 4, incremental: false, shared_target_cache: false },
    capture_module_sha256: (
      await identity(root, "scripts/release-compiler-capture.mts", 256 * 1024)
    ).sha256,
    outputs: [] as { filename: string; bytes: number; sha256: string }[],
    ...(options.interface === "desktop" && options.platform === "linux-x86_64"
      ? { linux_risk_assessment: null as unknown }
      : {}),
    ...(options.interface === "desktop" && options.platform === "windows-x86_64"
      ? { desktop_executable: null as ReturnType<typeof projectWindowsNsisExecutable> | null }
      : {}),
    public_input_use:
      options.interface === "cli"
        ? "updater inputs not applicable to CLI compilation"
        : "reconstructed updater root/configuration passed to actual Tauri invocation",
    public_inputs: prepared.receipt,
    input_members: before,
    node: { version: process.version },
    tauri: { version: "2.12.2", native_package: nativePackage },
    rust_toolchain: toolchain,
    tools: observedTools,
    invocation: {
      executable,
      args,
      cwd: workingDirectory,
      started_at: started,
      finished_at: null as string | null,
    },
    state: "started",
    exit_code: null as number | null,
    failure: null as string | null,
    original_compiler_acceptance:
      "unproven; build-job process observation is not independent authenticated execution acceptance",
  };
  const suffix = `${options.interface}-${options.platform}`;
  const filename = path.join(directory, `compiler-observation-${suffix}.json`);
  await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await options.retainDirectory?.(directory, targetDirectory);
  try {
    const code = await (
      options.invoke ??
      ((executable, args, cwd, environment) =>
        runResourceCommand("rust", executable, args, { cwd, environment }))
    )(executable, args, workingDirectory, environment);
    report.exit_code = code;
    const after = await Promise.all(
      members.map((name) => identity(prepared.output, name, 512 * 1024)),
    );
    if (
      !isDeepStrictEqual(after, reconstructed) ||
      !isDeepStrictEqual(await tools(), observedTools)
    )
      throw new Error("compiler tool or public input changed during actual invocation");
    git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    if (
      git(["rev-parse", "HEAD"]) !== options.expectedRevision ||
      git(["rev-parse", "HEAD^{tree}"]) !== options.expectedTree
    )
      throw new Error("compiler checkout source/tree changed during actual invocation");
    if (code !== 0)
      throw new Error(`compiler process exited ${code}; partial outputs remain unaccepted`);
    if (!options.invoke) {
      const outputFiles =
        options.interface === "cli"
          ? [
              path.join(
                targetDirectory,
                "release",
                options.platform === "windows-x86_64" ? "portcove.exe" : "portcove",
              ),
            ]
          : (
              await collectReleaseArtifacts(root, options.platform, undefined, targetDirectory)
            ).filter((filename) => !filename.endsWith(".zip") && !filename.endsWith(".tar.gz"));
      report.outputs = await Promise.all(
        outputFiles.map(async (filename) => {
          const captured = await identity(
            targetDirectory,
            path.relative(targetDirectory, filename),
            512 * 1024 * 1024,
            "tool",
          );
          return {
            filename: path.basename(filename),
            bytes: captured.bytes,
            sha256: captured.sha256,
          };
        }),
      );
      if (!report.outputs.length)
        throw new Error("actual compiler produced no complete selected outputs");
      if (options.interface === "desktop" && options.platform === "windows-x86_64") {
        // Capture only after the actual Tauri process and final NSIS package
        // discovery. Tauri has restored its unbundled output slot by this point.
        if (report.outputs.length !== 1 || !report.outputs[0]!.filename.endsWith(".exe"))
          throw new Error("desktop compiler executable lacks its exact single NSIS package slot");
        report.desktop_executable = await captureWindowsDesktopExecutable(targetDirectory);
      }
      if (options.interface === "desktop" && options.platform === "linux-x86_64") {
        const { candidate706, assessDispatchedBuild706, inspectCompilerRiskAssessment706 } =
          await import("./linux-beta-risk-706.mts");
        const { scanDependencies } = await import("./dependency-security.mts");
        const { withCoordinatorDeadline } = await import("./release-coordinator-deadline.mts");
        const { performance } = await import("node:perf_hooks");
        // The raw scan is retained first; embedding it does not alter its FAIL.
        // Its scratch receipt stays outside the exact two-member report archive.
        report.linux_risk_assessment = await withCoordinatorDeadline(
          performance.now() + 120000,
          async () => {
            const candidate = await candidate706(root);
            const { scan } = scanDependencies(root, undefined, (raw) => {
              const serialized = Buffer.from(
                JSON.stringify({ candidate, scan: raw, assessment: null }),
              );
              if (serialized.length > 128 * 1024) {
                report.linux_risk_assessment = {
                  assessment: null,
                  overflow: {
                    bytes: serialized.length,
                    sha256: createHash("sha256").update(serialized).digest("hex"),
                    scope:
                      "oversized raw receipt remains in producing job logs; this digest is not complete scanner data",
                  },
                };
                throw new Error("compiler scanner diagnostic exceeds existing 128KiB tuple bound");
              }
              // Executed after raw file/stdout/stderr retention but before any
              // post-scan drift refusal can unwind this producing process.
              report.linux_risk_assessment = { candidate, scan: raw, assessment: null };
            });
            const assessment = assessDispatchedBuild706({
              candidate,
              scan,
              policy: scan.sourceConfig,
              now: scan.completedAt,
            });
            return inspectCompilerRiskAssessment706(
              { candidate, scan, assessment },
              {
                source_commit: options.expectedRevision,
                lock_sha256: observedTools.find((tool) => tool.role === "rust-lock")!.sha256,
                started: Date.parse(started),
                finished: Date.now(),
              },
            );
          },
        );
      }
    }
    // The assessment is part of this producing process, so its complete interval
    // must retain the same compiler tools, public inputs and prepared source.
    if (
      !isDeepStrictEqual(await tools(), observedTools) ||
      !isDeepStrictEqual(
        await Promise.all(members.map((name) => identity(prepared.output, name, 512 * 1024))),
        reconstructed,
      ) ||
      git(["rev-parse", "HEAD"]) !== options.expectedRevision ||
      git(["rev-parse", "HEAD^{tree}"]) !== options.expectedTree
    )
      throw new Error("compiler source/tools/public inputs changed during assessment");
    git(["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    report.state = "completed";
  } catch (error) {
    report.state = "failed";
    report.failure = error instanceof Error ? error.message : "compiler invocation failed";
  }
  report.invocation.finished_at = new Date().toISOString();
  await writeFile(
    path.join(directory, `compiler-result-${suffix}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { directory, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2)
    throw new Error("compiler capture accepts only fixed workflow environment inputs");
  const env = process.env;
  const result = await captureReleaseCompiler(project, {
    inputDirectory: env.PORTCOVE_RELEASE_PUBLIC_BUILD_INPUT_DIRECTORY ?? "",
    interface: env.PORTCOVE_RELEASE_INTERFACE as CompilerCaptureOptions["interface"],
    outputRoot: env.RUNNER_TEMP ?? "",
    platform: env.PORTCOVE_RELEASE_PLATFORM as CompilerCaptureOptions["platform"],
    expectedRevision: env.GITHUB_SHA ?? "",
    expectedTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: project,
      encoding: "utf8",
    }).trim(),
    configurationRevision: env.PORTCOVE_APPLICATION_PUBLIC_INPUTS_REVISION ?? "",
    manifestSha256: env.PORTCOVE_APPLICATION_PUBLIC_INPUTS_SHA256 ?? "",
    runId: env.GITHUB_RUN_ID ?? "",
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    ...(env.PORTCOVE_RELEASE_TARGET_ROOT
      ? { targetDirectory: env.PORTCOVE_RELEASE_TARGET_ROOT }
      : {}),
    retainDirectory: async (directory, targetDirectory) => {
      if (!env.GITHUB_ENV || /[\r\n\0]/u.test(directory))
        throw new Error("compiler receipt handoff unavailable");
      if (!["cli", "desktop"].includes(env.PORTCOVE_RELEASE_INTERFACE ?? ""))
        throw new Error("compiler interface handoff differs");
      await appendFile(
        env.GITHUB_ENV,
        `PORTCOVE_RELEASE_COMPILER_${env.PORTCOVE_RELEASE_INTERFACE!.toUpperCase()}_DIRECTORY=${directory}\n`,
      );
      await appendFile(env.GITHUB_ENV, `PORTCOVE_RELEASE_TARGET_ROOT=${targetDirectory}\n`);
    },
  });
  if (result.report.state !== "completed") process.exitCode = 1;
}
