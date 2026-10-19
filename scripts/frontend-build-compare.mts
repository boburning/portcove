import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { CommandObservation, CommandEvidence } from "./report-summary.mts";
import { errorMessage, isRecord } from "./runtime-values.mts";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnCommand } from "./dev-storage.mts";
import { frontendEnvironment } from "../apps/desktop/scripts/build-frontend.mts";
import { introducedPackages } from "./pnpm-lock-inventory.mts";
import { validateDependencyDelta } from "./renovate-fast-lane.mts";
import { retainCommandEvidence, renderBoundedSummary } from "./report-summary.mts";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (root: string, args: readonly string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 16 * 1024 * 1024,
  });
const contains = (parent: string, child: string) => {
  const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return key(child) === key(parent) || key(child).startsWith(key(parent) + path.sep);
};

export function comparisonInputs(baseline: string, candidate: string, dependency: string) {
  const roots: [string, string] = [realpathSync(baseline), realpathSync(candidate)];
  if (contains(roots[0], roots[1]) || contains(roots[1], roots[0]))
    throw new Error("Comparison roots must be distinct and nonnested");
  const inputs = roots.map((root: string) => {
    if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root)
      throw new Error("Root must be a Git checkout root");
    const status = git(root, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);
    const contamination = status
      .split(/\r?\n/u)
      .filter(Boolean)
      .filter(
        (line) =>
          !/^!! (?:node_modules\/|apps\/desktop\/node_modules\/|work\/pnpm-store\/)/u.test(line),
      );
    if (contamination.length)
      throw new Error(
        `Dirty or contaminated checkout: ${root}: ${contamination.slice(0, 3).join(", ")}`,
      );
    if (existsSync(path.join(root, "apps/desktop/dist")))
      throw new Error("Preexisting build output must be preserved outside the comparison roots");
    const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
    const repositoryPackage: unknown = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const manager = isRecord(repositoryPackage) ? repositoryPackage.packageManager : undefined;
    if (typeof manager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/u.test(manager))
      throw new Error("Exact pinned pnpm authority required");
    if (
      existsSync(path.join(root, ".node-version")) &&
      readFileSync(path.join(root, ".node-version"), "utf8").trim().replace(/^v/u, "") !==
        process.versions.node
    )
      throw new Error("Comparison Node runtime differs from the repository pin");
    const hashes = Object.fromEntries(
      files.map((file: string) => [file, sha(readFileSync(path.join(root, file)))]),
    );
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"),
    );
    if (!isRecord(manifest)) throw new Error("Frontend manifest must be an object");
    const sections = ["dependencies", "devDependencies"].filter(
      (section) => isRecord(manifest[section]) && typeof manifest[section][dependency] === "string",
    );
    if (sections.length !== 1)
      throw new Error("Dependency must have one frontend manifest declaration");
    const section = sections[0];
    const declarations = section === undefined ? undefined : manifest[section];
    if (!isRecord(declarations) || typeof declarations[dependency] !== "string")
      throw new Error("Dependency declaration is incomplete");
    const version = declarations[dependency];
    declarations[dependency] = "<comparison-dependency>";
    hashes["apps/desktop/package.json"] = sha(JSON.stringify(manifest));
    delete hashes["pnpm-lock.yaml"];
    return {
      root,
      manager,
      head: git(root, ["rev-parse", "HEAD"]).trim(),
      hashes,
      version,
      lock: readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"),
    };
  });
  const base = inputs[0],
    head = inputs[1];
  if (!base || !head) throw new Error("Both comparison inputs are required");
  if (JSON.stringify(base.hashes) !== JSON.stringify(head.hashes))
    throw new Error("Source or build configuration differs beyond the declared dependency");
  const added = introducedPackages(base.lock, head.lock);
  const removed = introducedPackages(head.lock, base.lock);
  if ([...added, ...removed].some((item) => item.name !== dependency))
    throw new Error(
      "Lock graph differs beyond the declared dependency; use a separately reviewed comparison scope",
    );
  if (base.lock !== head.lock)
    validateDependencyDelta({
      manager: "npm",
      packageName: dependency,
      currentVersion: base.version.replace(/^[~^=]/u, ""),
      newVersion: head.version.replace(/^[~^=]/u, ""),
      baseManifest: readFileSync(path.join(base.root, "apps/desktop/package.json"), "utf8"),
      headManifest: readFileSync(path.join(head.root, "apps/desktop/package.json"), "utf8"),
      baseLock: base.lock,
      headLock: head.lock,
    });
  return inputs.map(({ lock, ...input }) => ({
    ...input,
    lockHash: sha(lock),
    dependencyChanges: { added, removed },
  }));
}

function assetInventory(root: string) {
  const entries: AssetObservation[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:js|css)$/u.test(file)) {
        const bytes = readFileSync(file);
        entries.push({
          path: path.relative(root, file).replaceAll("\\", "/"),
          type: path.extname(file).slice(1),
          raw: bytes.length,
          gzip: gzipSync(bytes).length,
          sha256: sha(bytes),
        });
      }
    }
  };
  walk(root);
  if (
    !entries.some((entry) => entry.type === "js") ||
    !entries.some((entry) => entry.type === "css")
  )
    throw new Error("Build has no complete JS/CSS asset inventory");
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

interface AssetObservation {
  path: string;
  type: string;
  raw: number;
  gzip: number;
  sha256: string;
}
export type ComparisonRunner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => CommandObservation & { status: number | null };
interface BuildObservation {
  root: string;
  head: string;
  commands: {
    executable: string;
    args: string[];
    status: number | null;
    evidence: CommandEvidence;
  }[];
  pnpm?: string;
  assets?: AssetObservation[];
}
interface ComparisonReport {
  schemaVersion: 1;
  observedAt: string;
  dependency: string;
  node: string;
  requestedInputs: { baseline: string; candidate: string };
  builds: BuildObservation[];
  state: "running" | "failed" | "complete";
  inputs?: ReturnType<typeof comparisonInputs>;
  totals?: { js: { raw: number; gzip: number }; css: { raw: number; gzip: number } }[];
  failure?: string;
}
export function compareBuilds({
  baseline,
  candidate,
  dependency,
  evidenceRoot,
  runner = spawnCommand,
}: {
  baseline: string;
  candidate: string;
  dependency: string;
  evidenceRoot: string;
  runner?: ComparisonRunner;
}) {
  const evidence = path.resolve(evidenceRoot);
  if ([baseline, candidate].some((root: string) => contains(path.resolve(root), evidence)))
    throw new Error("Evidence directory must be outside both comparison roots");
  const directory = path.join(evidence, randomUUID());
  mkdirSync(directory, { recursive: true });
  const report: ComparisonReport = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    dependency,
    node: process.version,
    requestedInputs: { baseline, candidate },
    builds: [],
    state: "running",
  };
  const file = path.join(directory, "report.json");
  const save = () => writeFileSync(file, JSON.stringify(report, null, 2));
  save();
  try {
    const inputs = comparisonInputs(baseline, candidate, dependency);
    report.inputs = inputs;
    save();
    for (const input of inputs) {
      const build: BuildObservation = { root: input.root, head: input.head, commands: [] };
      report.builds.push(build);
      for (const args of [
        ["--version"],
        ["install", "--frozen-lockfile"],
        ["--dir", "apps/desktop", "build", "--fresh"],
      ]) {
        const result = runner("pnpm", args, {
          cwd: input.root,
          env: frontendEnvironment(process.env),
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        });
        build.commands.push({
          executable: "pnpm",
          args,
          status: result.status,
          evidence: retainCommandEvidence(directory, result),
        });
        save();
        if (result.error || result.status !== 0)
          throw new Error(`Comparison command failed: pnpm ${args.join(" ")}`);
        if (args.includes("--version")) {
          build.pnpm = String(result.stdout).trim();
          if (`pnpm@${build.pnpm}` !== input.manager)
            throw new Error("Executed pnpm differs from the declared pin");
        }
      }
      build.assets = assetInventory(path.join(input.root, "apps/desktop/dist"));
      save();
    }
    if (report.builds[0]?.pnpm !== report.builds[1]?.pnpm)
      throw new Error("Package manager versions differ");
    report.totals = report.builds.map((build) => {
      const assets = build.assets;
      if (!assets) throw new Error("Completed build asset inventory missing");
      const total = (type: string) =>
        assets
          .filter((asset) => asset.type === type)
          .reduce((sum, asset) => ({ raw: sum.raw + asset.raw, gzip: sum.gzip + asset.gzip }), {
            raw: 0,
            gzip: 0,
          });
      return { js: total("js"), css: total("css") };
    });
    report.state = "complete";
  } catch (error) {
    report.state = "failed";
    report.failure = errorMessage(error);
    throw error;
  } finally {
    save();
  }
  if (!report.inputs || !report.totals) throw new Error("Comparison did not complete");
  return { report: { ...report, inputs: report.inputs, totals: report.totals }, reference: file };
}

function requiredArgument(args: readonly string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error("Missing comparison argument");
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 8 ||
      args[0] !== "--baseline" ||
      args[2] !== "--candidate" ||
      args[4] !== "--dependency" ||
      args[6] !== "--evidence-root"
    )
      throw new Error(
        "Usage: frontend-build-compare.mts --baseline ROOT --candidate ROOT --dependency NAME --evidence-root ROOT",
      );
    const { report, reference } = compareBuilds({
      baseline: requiredArgument(args, 1),
      candidate: requiredArgument(args, 3),
      dependency: requiredArgument(args, 5),
      evidenceRoot: requiredArgument(args, 7),
    });
    console.log(
      renderBoundedSummary(
        "Frontend comparison complete",
        report.totals.map(
          (total, index) =>
            `${report.inputs[index]?.head ?? "missing input"}: ${JSON.stringify(total)}`,
        ),
        { reference },
      ).text,
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
