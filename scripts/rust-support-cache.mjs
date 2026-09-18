import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const formatVersion = 1;
const retainedEntriesPerProduct = 8;
const compilerEnvironmentNames = new Set([
  "AR",
  "CC",
  "CFLAGS",
  "CXX",
  "CXXFLAGS",
  "DEVELOPER_DIR",
  "INCLUDE",
  "LD",
  "LIB",
  "LIBPATH",
  "MACOSX_DEPLOYMENT_TARGET",
  "RUSTC_BOOTSTRAP",
  "RUSTFLAGS",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SDKROOT",
  "UNIVERSALCRTSDKDIR",
  "UCRTVERSION",
  "VCINSTALLDIR",
  "VCTOOLSINSTALLDIR",
  "WINDOWSSDKDIR",
  "WINDOWSSDKVERSION",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileIdentity = (file) => {
  const contents = readFileSync(file);
  return { bytes: contents.length, sha256: sha256(contents) };
};
const outputIdentity = (file) => ({
  ...fileIdentity(file),
  mode: statSync(file).mode & 0o777,
});

function compilerEnvironment(environment) {
  const selected = [];
  for (const [name, value] of Object.entries(environment)) {
    const canonical = name.toUpperCase();
    if (!compilerEnvironmentNames.has(canonical)) continue;
    selected.push({ name: canonical, value_sha256: sha256(String(value)) });
  }
  return selected.sort((left, right) => left.name.localeCompare(right.name));
}

function environmentValue(environment, wanted) {
  const key = Object.keys(environment).find((name) => name.toUpperCase() === wanted);
  return key ? environment[key] : undefined;
}

function resolveCommand(command, environment, platform) {
  if (path.isAbsolute(command)) return existsSync(command) ? realpathSync(command) : null;
  const search = String(environmentValue(environment, "PATH") ?? "").split(path.delimiter);
  const configuredExtensions = String(environmentValue(environment, "PATHEXT") ?? ".EXE;.CMD;.BAT")
    .split(";")
    .filter(Boolean);
  const extensions = platform === "win32" && !path.extname(command) ? configuredExtensions : [""];
  for (const directory of search) {
    const unquoted = directory.replace(/^"|"$/gu, "");
    if (!unquoted) continue;
    for (const extension of extensions) {
      const candidate = path.join(unquoted, `${command}${extension}`);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  return null;
}

function commandIdentity(command, environment, platform) {
  const resolved = resolveCommand(command, environment, platform);
  if (!resolved) return { command, resolved: null };
  return { command, resolved, ...fileIdentity(resolved) };
}

function checkedCompilerProbe(runSync, args, environment) {
  const result = runSync("rustc", args, {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !String(result.stdout ?? "").trim())
    throw new Error(`Could not establish rustc identity with: rustc ${args.join(" ")}`);
  return String(result.stdout).trim();
}

export function rustSupportCompilerIdentity({ runSync, environment, platform = process.platform }) {
  const linkerCommands =
    platform === "win32"
      ? [environmentValue(environment, "LD") ?? "link"]
      : [environmentValue(environment, "CC") ?? "cc", environmentValue(environment, "LD") ?? "ld"];
  return {
    verbose_version: checkedCompilerProbe(runSync, ["--version", "--verbose"], environment),
    sysroot: checkedCompilerProbe(runSync, ["--print", "sysroot"], environment),
    commands: [
      commandIdentity("rustc", environment, platform),
      ...linkerCommands.map((command) => commandIdentity(command, environment, platform)),
    ],
    environment: compilerEnvironment(environment),
  };
}

function cacheRootFor(root, environment) {
  const configured = environment.CARGO_TARGET_DIR;
  const target = configured
    ? path.resolve(root, configured)
    : path.join(path.resolve(root), "target");
  return path.join(target, "portcove-rust-support", `v${formatVersion}`);
}

function safeProductName(value) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))
    throw new Error(`invalid Rust support product name: ${value}`);
  return value;
}

function ensureOwnedCacheDirectory(directory) {
  mkdirSync(directory, { recursive: true });
  const state = lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error(`Rust support cache path is not an owned directory: ${directory}`);
}

function manifestFor({ product, source, compiler, rustcArgs, platform, architecture }) {
  const identity = {
    format_version: formatVersion,
    product,
    source: fileIdentity(source),
    compiler,
    rustc_arguments: rustcArgs,
    platform,
    architecture,
  };
  return { identity, fingerprint: sha256(JSON.stringify(identity)) };
}

function readValidatedEntry(directory, expectedFingerprint) {
  try {
    const directoryState = lstatSync(directory);
    if (!directoryState.isDirectory() || directoryState.isSymbolicLink())
      return { valid: false, reason: "unsafe-cache-directory" };
    const manifestPath = path.join(directory, "manifest.json");
    const artifactPath = path.join(directory, "artifact");
    const manifestState = lstatSync(manifestPath);
    const artifactState = lstatSync(artifactPath);
    if (
      !manifestState.isFile() ||
      manifestState.isSymbolicLink() ||
      !artifactState.isFile() ||
      artifactState.isSymbolicLink()
    )
      return { valid: false, reason: "unsafe-cache-entry" };
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest?.format_version !== formatVersion ||
      manifest?.input_fingerprint !== expectedFingerprint ||
      !manifest?.input ||
      sha256(JSON.stringify(manifest.input)) !== expectedFingerprint ||
      !/^[a-f0-9]{64}$/u.test(manifest?.output?.sha256 ?? "") ||
      !Number.isSafeInteger(manifest?.output?.bytes) ||
      manifest.output.bytes < 1 ||
      !Number.isSafeInteger(manifest?.output?.mode) ||
      manifest.output.mode < 0
    )
      return { valid: false, reason: "invalid-cache-manifest" };
    const output = outputIdentity(artifactPath);
    if (JSON.stringify(output) !== JSON.stringify(manifest.output))
      return { valid: false, reason: "cached-output-changed" };
    return { valid: true, artifactPath, manifest };
  } catch (error) {
    if (error.code === "ENOENT") return { valid: false, reason: "missing-cache-entry" };
    return { valid: false, reason: "unreadable-cache-entry", error };
  }
}

function copyVerified(entry, output) {
  copyFileSync(entry.artifactPath, output);
  const copied = outputIdentity(output);
  if (JSON.stringify(copied) !== JSON.stringify(entry.manifest.output))
    throw new Error("Rust support cache copy did not preserve verified output bytes");
}

function quarantineInvalidEntry(directory) {
  const rejected = `${directory}.rejected-${randomUUID()}`;
  try {
    renameSync(directory, rejected);
    return rejected;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not quarantine invalid Rust support cache entry: ${directory}`, {
      cause: error,
    });
  }
}

function pruneProductCache(productRoot, currentFingerprint) {
  const entries = [];
  const interrupted = [];
  try {
    for (const entry of readdirSync(productRoot, { withFileTypes: true })) {
      const absolute = path.join(productRoot, entry.name);
      if (entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name)) {
        entries.push({ name: entry.name, absolute, modified: statSync(absolute).mtimeMs });
      } else if (entry.isDirectory() && /\.(?:candidate|rejected)-[0-9a-f-]+$/iu.test(entry.name)) {
        interrupted.push({ absolute, modified: statSync(absolute).mtimeMs });
      }
    }
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const retained = entries
    .filter((entry) => entry.name !== currentFingerprint)
    .sort((left, right) => right.modified - left.modified)
    .slice(0, retainedEntriesPerProduct - 1);
  const keep = new Set([currentFingerprint, ...retained.map((entry) => entry.name)]);
  for (const entry of entries) {
    if (!keep.has(entry.name)) rmSync(entry.absolute, { recursive: true, force: true });
  }
  const staleBefore = Date.now() - 60 * 60 * 1_000;
  for (const entry of interrupted) {
    if (entry.modified < staleBefore) rmSync(entry.absolute, { recursive: true, force: true });
  }
}

export function prepareRustSupportArtifact({
  root,
  product,
  source,
  output,
  rustcArgs,
  compiler,
  environment,
  platform = process.platform,
  architecture = process.arch,
  runSync,
  now = () => performance.now(),
}) {
  const started = now();
  const checkedProduct = safeProductName(product);
  const absoluteSource = path.resolve(root, source);
  const absoluteOutput = path.resolve(output);
  const { identity, fingerprint } = manifestFor({
    product: checkedProduct,
    source: absoluteSource,
    compiler,
    rustcArgs,
    platform,
    architecture,
  });
  const cacheRoot = cacheRootFor(root, environment);
  const productRoot = path.join(cacheRoot, checkedProduct);
  const finalDirectory = path.join(productRoot, fingerprint);
  ensureOwnedCacheDirectory(path.dirname(cacheRoot));
  ensureOwnedCacheDirectory(cacheRoot);
  ensureOwnedCacheDirectory(productRoot);

  let entry = readValidatedEntry(finalDirectory, fingerprint);
  if (entry.valid) {
    copyVerified(entry, absoluteOutput);
    return {
      outcome: "hit",
      fingerprint,
      elapsed_ms: Math.max(0, Math.round(now() - started)),
      output: entry.manifest.output,
    };
  }

  const missReason = entry.reason;
  const rejected =
    missReason === "missing-cache-entry" ? null : quarantineInvalidEntry(finalDirectory);
  const candidate = `${finalDirectory}.candidate-${randomUUID()}`;
  mkdirSync(candidate, { recursive: false });
  const candidateArtifact = path.join(candidate, "artifact");
  try {
    const compiled = runSync("rustc", [...rustcArgs, absoluteSource, "-o", candidateArtifact], {
      stdio: "inherit",
      env: environment,
      windowsHide: true,
    });
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0)
      throw new Error(`Rust support product compilation failed: ${checkedProduct}`);
    const compiledOutput = outputIdentity(candidateArtifact);
    if (compiledOutput.bytes < 1)
      throw new Error(`Rust support product compilation was empty: ${checkedProduct}`);
    writeFileSync(
      path.join(candidate, "manifest.json"),
      `${JSON.stringify(
        {
          format_version: formatVersion,
          input_fingerprint: fingerprint,
          input: identity,
          output: compiledOutput,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    const candidateEntry = readValidatedEntry(candidate, fingerprint);
    if (!candidateEntry.valid)
      throw new Error(`Rust support candidate validation failed: ${candidateEntry.reason}`);
    try {
      renameSync(candidate, finalDirectory);
    } catch (error) {
      const concurrent = readValidatedEntry(finalDirectory, fingerprint);
      if (!concurrent.valid) throw error;
      rmSync(candidate, { recursive: true, force: true });
    }
    entry = readValidatedEntry(finalDirectory, fingerprint);
    if (!entry.valid)
      throw new Error(`Published Rust support cache entry is invalid: ${entry.reason}`);
    copyVerified(entry, absoluteOutput);
    pruneProductCache(productRoot, fingerprint);
    if (rejected) rmSync(rejected, { recursive: true, force: true });
    return {
      outcome: "built",
      reason: missReason,
      fingerprint,
      elapsed_ms: Math.max(0, Math.round(now() - started)),
      output: entry.manifest.output,
    };
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    throw error;
  }
}

export const rustSupportCacheContract = Object.freeze({
  formatVersion,
  retainedEntriesPerProduct,
});
