/** Unprivileged fixed-source tool production. No role key or publication effect. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, isBuiltin } from "node:module";
import { spawnSync } from "node:child_process";
import { isRecord } from "./runtime-values.mts";
import { runResourceCommand } from "./resource-command.mts";
import { prepareReleaseCompilerSourceClosure } from "./release-compiler-source.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
import {
  controllerToolEntries,
  controllerToolAssets,
  controllerToolPaths,
  readControllerToolFile,
  inspectControllerToolManifest,
  controllerCompilerSourceAsset,
} from "./release-controller-tools.mts";
/** Installed package API is the repository-pinned Vite+ Pack, not a downloaded
 * replacement. Resolve the canonical path to avoid Windows junction long paths. */
export async function bundleControllerEntries(sourceRoot: string, outputRoot: string) {
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
  for (const name of controllerToolEntries) {
    const entry = path.join(sourceRoot, "scripts", `${name}.mts`);
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
      outputOptions: { entryFileNames: `${name}.bundle.mjs`, codeSplitting: false },
      plugins: [
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
            for (const item of Object.values(bundle))
              if (
                item.type === "chunk" &&
                [...item.imports, ...item.dynamicImports].some(
                  (name) => !isBuiltin(name) && name !== item.fileName,
                )
              )
                throw new Error(
                  `controller bundle retained runtime dependencies: ${JSON.stringify({ file: item.fileName, imports: item.imports, dynamic_imports: item.dynamicImports })}`,
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
  if (process.versions.node !== "24.22.0") throw new Error("fixed Node runtime differs");
  if (
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    !/^[a-f0-9]{40}$/.test(expected.commit) ||
    !/^[a-f0-9]{40}$/.test(expected.tree)
  )
    throw new Error("fixed Linux controller source required");
  const directory = await mkdtemp(path.join(outputParent, "controller-tool-build-"));
  const home = path.join(directory, "home");
  await mkdir(home, { mode: 0o700 });
  const target = path.join(directory, "target");
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
    await mkdir(tools, { mode: 0o700 });
    phase = "fixed-node-bundles";
    await bundleControllerEntries(sourceRoot, tools);
    phase = "fixed-rust-build";
    const status = await runResourceCommand(
      "rust",
      "cargo",
      ["build", "--locked", "--release", "-p", "portcove-release-tools", "-p", "portcove-cli"],
      { cwd: sourceRoot, environment: env },
    );
    if (status !== 0) throw new Error(`fixed controller tool build refused; retain ${directory}`);
    phase = "tool-inventory";
    await mkdir(path.join(tools, "bin"), { mode: 0o700 });
    const desktop = createRequire(path.join(sourceRoot, "apps/desktop/package.json"));
    const cliPackage = desktop.resolve("@tauri-apps/cli/package.json");
    const cli = createRequire(cliPackage);
    const addon = await realpath(cli.resolve("@tauri-apps/cli-linux-x64-gnu"));
    for (const filename of [cliPackage, path.join(path.dirname(addon), "package.json")]) {
      const metadata: unknown = JSON.parse(
        (await readControllerToolFile(filename, 65536)).toString("utf8"),
      );
      if (!isRecord(metadata) || metadata.version !== "2.12.2")
        throw new Error("fixed maintained Tauri CLI version differs");
    }
    for (const [name, filename] of [
      ["node", process.execPath],
      ["portcove", path.join(target, "release", "portcove")],
      ["portcove-release-tools", path.join(target, "release", "portcove-release-tools")],
      ["tauri-addon.node", addon],
    ])
      await writeFile(path.join(tools, "bin", name!), await readControllerToolFile(filename!), {
        flag: "wx",
        mode: 0o700,
      });
    for (const name of controllerToolAssets) {
      await mkdir(path.dirname(path.join(tools, name)), { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(tools, name),
        await readControllerToolFile(path.join(sourceRoot, name), 64 * 1024),
        { flag: "wx", mode: 0o600 },
      );
    }
    phase = "fixed-compiler-source-closure";
    await materializeControllerCompilerSource(sourceRoot, tools, expected);
    guard();
    const files = [];
    for (const name of controllerToolPaths) {
      const bytes = await readControllerToolFile(path.join(tools, name));
      files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    const manifest = inspectControllerToolManifest({
      schema_version: 2,
      source_commit: expected.commit,
      source_tree: expected.tree,
      platform: "linux-x86_64",
      node_version: "24.22.0",
      bundler: "vite-plus@1.3.0",
      tauri_cli_version: "2.12.2",
      files,
    });
    await writeFile(path.join(tools, "manifest.json"), JSON.stringify(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, tools, manifest, authority: "none" };
  } catch {
    await writeFile(
      path.join(directory, "failure.json"),
      JSON.stringify({
        directory,
        phase,
        source: expected,
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw new Error(`fixed controller bootstrap refused; retain ${directory}`);
  }
}
