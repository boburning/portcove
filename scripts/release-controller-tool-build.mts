/** Unprivileged fixed-source tool production. No role key or publication effect. */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { isRecord } from "./runtime-values.mts";
import { acquireWindowsWebviewDriver } from "./release-windows-webview-driver.mts";
import { acquireNativePnpm, nativePnpmVersion } from "./release-pnpm-runtime.mts";
import { runResourceCommand } from "./resource-command.mts";
import { prepareReleaseCompilerSourceClosure } from "./release-compiler-source.mts";
import { controllerNodeVersion } from "./controller-node-runtime.mts";
import { prepareRustSupportArtifact, rustSupportCompilerIdentity } from "./rust-support-cache.mts";
import {
  nativeRuntimeSupportProfile,
  inspectNativeRuntimeSupport,
} from "./release-native-runtime-support.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
import {
  controllerToolEntries,
  readControllerToolFile,
  inspectControllerToolManifest,
  controllerCompilerSourceAsset,
  controllerNativeDriverVersion,
  controllerToolSourceAssetMaximumBytes,
  controllerToolPlatformProfile,
  type ControllerToolPlatform,
} from "./release-controller-tools.mts";
/** Installed package API is the repository-pinned Vite+ Pack, not a downloaded
 * replacement. Resolve the canonical path to avoid Windows junction long paths. */
export async function bundleControllerEntries(
  sourceRoot: string,
  outputRoot: string,
  platform: ControllerToolPlatform = "linux-x86_64",
) {
  const profile = controllerToolPlatformProfile(platform);
  const installed = await realpath(fileURLToPath(import.meta.resolve("vite-plus/pack")));
  const pack = (await import(pathToFileURL(installed).href)) as typeof import("vite-plus/pack");
  const packageFile = await realpath(fileURLToPath(import.meta.resolve("vite-plus/package.json")));
  const version: unknown = JSON.parse(
    (await readControllerToolFile(packageFile, 64 * 1024)).toString("utf8"),
  );
  if (
    !version ||
    typeof version !== "object" ||
    !("version" in version) ||
    version.version !== "1.3.0"
  )
    throw new Error("repository-pinned pack version differs");
  await mkdir(path.join(outputRoot, "scripts"), { recursive: true, mode: 0o700 });
  const entries = [
    ...controllerToolEntries.map((name) => ({
      source: `scripts/${name === "production-controller-admission" ? "production-controller-admission-cli" : name}.mts`,
      output: `${name}.bundle.mjs`,
    })),
    ...profile.children.map((source) => ({ source, output: path.posix.basename(source) })),
  ];
  for (const definition of entries) {
    const entry = path.join(sourceRoot, definition.source);
    const commandOnly = [
      "scripts/release-hosted-native-worker.mts",
      "scripts/release-hosted-native-windows-source.mts",
    ].includes(definition.source);
    await pack.build({
      config: false,
      cwd: sourceRoot,
      entry: [entry],
      outDir: path.join(outputRoot, "scripts"),
      clean: false,
      format: "esm",
      platform: "node",
      target: "node24",
      dts: false,
      sourcemap: false,
      report: false,
      env: {},
      envPrefix: [],
      deps: { alwaysBundle: [/.*/] },
      // These workers are subprocess CLIs, never imported bundle APIs. Do not
      // preserve an unused entry export facade across its dynamic dependencies.
      inputOptions: commandOnly ? { preserveEntrySignatures: false } : {},
      outputOptions: { entryFileNames: definition.output, codeSplitting: false },
      plugins: [
        {
          name: "portcove-bundled-version-runtime",
          resolveId(specifier, importer) {
            if (
              specifier === "./release-version-runtime.mts" &&
              importer &&
              path.resolve(importer) ===
                path.join(sourceRoot, "apps/desktop/scripts/release-version-policy.mts")
            )
              return path.join(
                sourceRoot,
                "apps/desktop/scripts/release-version-bundled-runtime.mts",
              );
            return null;
          },
        },
        {
          name: "portcove-fixed-module-locations",
          transform(code, id) {
            if (!id.endsWith(".mts") || !code.includes("import.meta.url")) return null;
            const relative = path.relative(sourceRoot, id).split(path.sep).join("/");
            if (relative.startsWith("../") || path.isAbsolute(relative))
              throw new Error("repository module escaped fixed source");
            // The entry remains the direct CLI. Imported modules retain their own
            // source location: their CLI guards stay false and static paths keep
            // pointing at the checked/packaged fixed controller assets.
            if (path.resolve(id) === path.resolve(entry)) return null;
            const spans: [number, number][] = [];
            const visit = (node: unknown, depth = 0) => {
              if (depth > 256) throw new Error("source AST nesting exceeds bound");
              if (Array.isArray(node)) {
                for (const child of node) visit(child, depth + 1);
                return;
              }
              if (!isRecord(node)) return;
              if (
                node.type === "MemberExpression" &&
                node.computed === false &&
                isRecord(node.property) &&
                node.property.name === "url" &&
                isRecord(node.object) &&
                node.object.type === "MetaProperty" &&
                isRecord(node.object.meta) &&
                node.object.meta.name === "import" &&
                isRecord(node.object.property) &&
                node.object.property.name === "meta"
              ) {
                if (typeof node.start !== "number" || typeof node.end !== "number")
                  throw new Error("source AST location unavailable");
                spans.push([node.start, node.end]);
                return;
              }
              for (const child of Object.values(node)) visit(child, depth + 1);
            };
            visit(this.parse(code, { lang: "ts" }));
            for (const [start, end] of spans.sort((a, b) => b[0] - a[0]))
              code =
                code.slice(0, start) +
                `new URL(${JSON.stringify(`../${relative}`)}, import.meta.url).href` +
                code.slice(end);
            return { code, map: null };
          },
          generateBundle(_options, bundle) {
            if (commandOnly) {
              const worker = bundle[definition.output];
              if (!worker || worker.type !== "chunk" || worker.exports.length !== 0)
                throw new Error(
                  "opaque native worker must expose only its fixed command interface",
                );
            }
            for (const item of Object.values(bundle))
              if (
                item.type === "chunk" &&
                [...item.imports, ...item.dynamicImports].some(
                  (name) => !isBuiltin(name) && name !== item.fileName,
                )
              )
                throw new Error(
                  `controller bundle retained runtime dependencies: ${JSON.stringify({ file: item.fileName, code_splitting: _options.codeSplitting, inline_dynamic_imports: _options.inlineDynamicImports, imports: item.imports, dynamic_imports: item.dynamicImports })}`,
                );
          },
        },
      ],
    });
  }
}

/** Generated under the unprivileged bootstrap guard, never by a role job. */
export async function materializeControllerCompilerSource(
  sourceRoot: string,
  tools: string,
  expected: { commit: string; tree: string },
) {
  const closure = await prepareReleaseCompilerSourceClosure(sourceRoot, {
    source_commit: expected.commit,
    source_tree: expected.tree,
  });
  const bytes = Buffer.from(JSON.stringify(closure));
  if (bytes.length > 65536) throw new Error("generated compiler source closure exceeds bound");
  await writeFile(path.join(tools, controllerCompilerSourceAsset), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return { bytes: bytes.length, sha256: hash(bytes) };
}

export function controllerBootstrapEnvironment(home: string, target: string) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    RUNNER_TEMP: process.env.RUNNER_TEMP,
    PORTCOVE_RESOURCE_RESERVATION: process.env.PORTCOVE_RESOURCE_RESERVATION,
    PORTCOVE_RESOURCE_PROCESS_TOKEN: process.env.PORTCOVE_RESOURCE_PROCESS_TOKEN,
    PORTCOVE_HEAVY_RUST_LOCK_TOKEN: process.env.PORTCOVE_HEAVY_RUST_LOCK_TOKEN,

    HOME: home,
    USERPROFILE: home,
    TMP: home,
    TEMP: home,
    TMPDIR: home,
    CARGO_HOME: path.join(home, "cargo"),
    CARGO_TARGET_DIR: target,
    RUSTUP_HOME:
      process.env.RUSTUP_HOME ??
      path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".rustup"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
/** Runs one maintained Rust build in fresh private output under the existing
 * host resource supervisor. Public dependencies may be acquired only here. */
export async function buildControllerTools(
  sourceRoot: string,
  outputParent: string,
  expected: { commit: string; tree: string },
) {
  expected = structuredClone(expected);
  if (process.versions.node !== controllerNodeVersion)
    throw new Error("fixed Node runtime differs");
  if (
    (process.platform !== "linux" && process.platform !== "win32") ||
    process.arch !== "x64" ||
    !/^[a-f0-9]{40}$/.test(expected.commit) ||
    !/^[a-f0-9]{40}$/.test(expected.tree)
  )
    throw new Error("fixed Linux or Windows x64 controller source required");
  const platform = process.platform === "linux" ? "linux-x86_64" : "windows-x86_64";
  const profile = controllerToolPlatformProfile(platform);
  // The Windows MSVC linker also emits the supervisor support product below
  // this root. Keep its hash/attempt-qualified path below legacy tool limits.
  const directory = await mkdtemp(
    path.join(outputParent, platform === "linux-x86_64" ? "controller-tool-build-" : "ct-"),
  );
  const home = path.join(directory, platform === "linux-x86_64" ? "home" : "h");
  await mkdir(home, { mode: 0o700 });
  const target = path.join(directory, platform === "linux-x86_64" ? "target" : "t");
  const env = controllerBootstrapEnvironment(home, target);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: sourceRoot,
      env,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error)
      throw new Error("fixed bootstrap Git identity unavailable");
    return result.stdout.trim();
  };
  let phase = "source-before";
  try {
    const guard = () => {
      if (
        git(["rev-parse", "HEAD"]) !== expected.commit ||
        git(["rev-parse", "HEAD^{tree}"]) !== expected.tree ||
        git(["status", "--porcelain=v1", "--untracked-files=no"])
      )
        throw new Error("bootstrap checkout differs from independently fixed source");
    };
    guard();
    const tools = path.join(directory, "tools");
    phase = "source-assets";
    for (const name of profile.assets)
      await readControllerToolFile(
        path.join(sourceRoot, name),
        controllerToolSourceAssetMaximumBytes,
      );
    await mkdir(tools, { mode: 0o700 });
    phase = "fixed-native-package-manager";
    const packageMetadata: unknown = JSON.parse(
      (await readControllerToolFile(path.join(sourceRoot, "package.json"), 65536)).toString("utf8"),
    );
    if (
      !isRecord(packageMetadata) ||
      packageMetadata.packageManager !== `pnpm@${nativePnpmVersion}`
    )
      throw new Error("maintained package-manager pin differs");
    const pnpm = await acquireNativePnpm(platform);
    await mkdir(path.join(tools, "bin"), { mode: 0o700 });
    for (const [name, bytes] of [
      [`bin/pnpm${profile.suffix}`, pnpm.binary],
      ["pnpm-license.txt", pnpm.license],
      ["pnpm-notices.txt", pnpm.notices],
    ] as const)
      await writeFile(path.join(tools, name), bytes, {
        flag: "wx",
        mode: name.startsWith("bin/") ? 0o700 : 0o600,
      });
    if (platform === "windows-x86_64") {
      phase = "fixed-microsoft-webview-driver";
      await acquireWindowsWebviewDriver(sourceRoot, tools, env);
      guard();
    }
    phase = "fixed-node-bundles";
    await bundleControllerEntries(sourceRoot, tools, platform);
    phase = "fixed-rust-build";
    const status = await runResourceCommand(
      "rust",
      "cargo",
      [
        "build",
        "--locked",
        "--profile",
        "controller-tools",
        "-p",
        "portcove-release-tools",
        "-p",
        "portcove-cli",
      ],
      { cwd: sourceRoot, environment: env },
    );
    if (status !== 0) throw new Error(`fixed controller tool build refused; retain ${directory}`);
    phase = "fixed-native-webdriver-build";
    const bootstrap: unknown = JSON.parse(
      (
        await readControllerToolFile(path.join(sourceRoot, ".config/tool-bootstrap.json"), 65536)
      ).toString("utf8"),
    );
    if (
      !isRecord(bootstrap) ||
      !isRecord(bootstrap.desktop) ||
      bootstrap.desktop.tauri_driver !== controllerNativeDriverVersion
    )
      throw new Error("maintained native driver pin differs");
    const driverRoot = path.join(directory, "native-driver");
    // Public registry acquisition occurs only in this unprivileged, credential-
    // free source bootstrap. No role job runs Cargo or discovers a PATH driver.
    const driverStatus = await runResourceCommand(
      "rust",
      "cargo",
      [
        "install",
        "tauri-driver",
        "--locked",
        "--version",
        `=${controllerNativeDriverVersion}`,
        "--profile",
        "dev",
        "--jobs",
        "2",
        "--no-track",
        "--root",
        driverRoot,
      ],
      {
        cwd: sourceRoot,
        environment: { ...env, CARGO_NET_RETRY: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      },
    );
    if (driverStatus !== 0)
      throw new Error(`fixed native driver build refused; retain ${directory}`);
    guard();
    phase = "tool-inventory";
    const desktop = createRequire(path.join(sourceRoot, "apps/desktop/package.json"));
    const cliPackage = desktop.resolve("@tauri-apps/cli/package.json");
    const cli = createRequire(cliPackage);
    const addon = await realpath(
      cli.resolve(
        platform === "linux-x86_64"
          ? "@tauri-apps/cli-linux-x64-gnu"
          : "@tauri-apps/cli-win32-x64-msvc",
      ),
    );
    for (const filename of [cliPackage, path.join(path.dirname(addon), "package.json")]) {
      const metadata: unknown = JSON.parse(
        (await readControllerToolFile(filename, 65536)).toString("utf8"),
      );
      if (!isRecord(metadata) || metadata.version !== "2.12.2")
        throw new Error("fixed maintained Tauri CLI version differs");
    }
    for (const [name, filename] of [
      [`node${profile.suffix}`, process.execPath],
      [
        `portcove${profile.suffix}`,
        path.join(target, "controller-tools", `portcove${profile.suffix}`),
      ],
      [
        `portcove-release-tools${profile.suffix}`,
        path.join(target, "controller-tools", `portcove-release-tools${profile.suffix}`),
      ],
      ["tauri-addon.node", addon],
      [
        `tauri-driver${profile.suffix}`,
        path.join(driverRoot, "bin", `tauri-driver${profile.suffix}`),
      ],
    ])
      await writeFile(path.join(tools, "bin", name!), await readControllerToolFile(filename!), {
        flag: "wx",
        mode: 0o700,
      });
    for (const name of profile.assets) {
      await mkdir(path.dirname(path.join(tools, name)), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(tools, name),
        await readControllerToolFile(
          path.join(sourceRoot, name),
          controllerToolSourceAssetMaximumBytes,
        ),
        { flag: "wx", mode: 0o600 },
      );
    }
    phase = "fixed-native-support-product";
    await materializeControllerNativeSupport(sourceRoot, tools, env, platform);
    phase = "fixed-compiler-source-closure";
    await materializeControllerCompilerSource(sourceRoot, tools, expected);
    guard();
    const files = [];
    for (const name of profile.paths) {
      const bytes = await readControllerToolFile(path.join(tools, name));
      files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = inspectControllerToolManifest(
      {
        schema_version: profile.schema_version,
        source_commit: expected.commit,
        source_tree: expected.tree,
        platform,
        node_version: controllerNodeVersion,
        bundler: "vite-plus@1.3.0",
        tauri_cli_version: "2.12.2",
        files,
      },
      platform,
    );
    await writeFile(path.join(tools, "manifest.json"), JSON.stringify(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, tools, manifest, authority: "none" };
  } catch (error) {
    const failure = (error instanceof Error ? error.message : "unknown bootstrap refusal").slice(
      0,
      1024,
    );
    await writeFile(
      path.join(directory, "failure.json"),
      JSON.stringify({
        directory,
        phase,
        failure,
        diagnostic: isRecord(error) && isRecord(error.diagnostic) ? error.diagnostic : null,
        source: expected,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(
      `fixed controller bootstrap refused in ${phase}: ${failure}; retain ${directory}`,
      { cause: error },
    );
  }
}

/** Build only in the unprivileged source bootstrap. Protected native runtime
 * receives this product through the existing attested tool inventory. */
export async function materializeControllerNativeSupport(
  sourceRoot: string,
  tools: string,
  environment: NodeJS.ProcessEnv,
  platform: ControllerToolPlatform = "linux-x86_64",
) {
  const profile = nativeRuntimeSupportProfile(platform);
  const os = platform === "linux-x86_64" ? "linux" : "win32";
  if (process.platform !== os || process.arch !== "x64")
    throw new Error("fixed platform support build required");
  const compiler = rustSupportCompilerIdentity({ runSync: spawnSync, environment });
  const output = path.join(tools, profile.binary);
  const prepared = prepareRustSupportArtifact({
    root: sourceRoot,
    product: profile.product,
    source: profile.source,
    output,
    rustcArgs: profile.arguments,
    compiler,
    environment,
    platform: os,
    architecture: "x64",
    runSync: spawnSync,
  });
  await chmod(output, 0o700);
  const source = await readControllerToolFile(path.join(sourceRoot, profile.source), 65536);
  const binary = await readControllerToolFile(output, profile.maximumBinaryBytes);
  const metadata = {
    schema_version: 1,
    product: profile.product,
    platform,
    compiler,
    input_fingerprint: prepared.fingerprint,
    rustc_arguments: profile.arguments,
    source: { bytes: source.length, sha256: hash(source) },
    output: {
      bytes: binary.length,
      sha256: hash(binary),
      mode: platform === "linux-x86_64" ? 0o700 : 0o666,
    },
  };
  inspectNativeRuntimeSupport(metadata, source, binary, platform);
  const bytes = Buffer.from(JSON.stringify(metadata));
  if (bytes.length > 65536) throw new Error("native support metadata exceeds bound");
  await writeFile(path.join(tools, profile.metadata), bytes, {
    flag: "wx",
    mode: 0o600,
  });
}
