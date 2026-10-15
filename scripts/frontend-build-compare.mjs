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
import { spawnCommand } from "./dev-storage.mjs";
import { frontendEnvironment } from "../apps/desktop/scripts/build-frontend.mjs";
import { introducedPackages } from "./pnpm-lock-inventory.mjs";
import { validateDependencyDelta } from "./renovate-fast-lane.mjs";
import { retainCommandEvidence, renderBoundedSummary } from "./report-summary.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe",
    maxBuffer: 16 * 1024 * 1024,
  });
const contains = (parent, child) => {
  const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  return key(child) === key(parent) || key(child).startsWith(key(parent) + path.sep);
};

export function comparisonInputs(baseline, candidate, dependency) {
  const roots = [baseline, candidate].map((root) => realpathSync(root));
  if (contains(roots[0], roots[1]) || contains(roots[1], roots[0]))
    throw new Error("Comparison roots must be distinct and nonnested");
  const inputs = roots.map((root) => {
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
    const manager = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ).packageManager;
    if (!/^pnpm@\d+\.\d+\.\d+$/u.test(manager ?? ""))
      throw new Error("Exact pinned pnpm authority required");
    if (
      existsSync(path.join(root, ".node-version")) &&
      readFileSync(path.join(root, ".node-version"), "utf8").trim().replace(/^v/u, "") !==
        process.versions.node
    )
      throw new Error("Comparison Node runtime differs from the repository pin");
    const hashes = Object.fromEntries(
      files.map((file) => [file, sha(readFileSync(path.join(root, file)))]),
    );
    const manifest = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
    const sections = ["dependencies", "devDependencies"].filter(
      (section) => typeof manifest[section]?.[dependency] === "string",
    );
    if (sections.length !== 1)
      throw new Error("Dependency must have one frontend manifest declaration");
    const version = manifest[sections[0]][dependency];
    manifest[sections[0]][dependency] = "<comparison-dependency>";
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
  if (JSON.stringify(inputs[0].hashes) !== JSON.stringify(inputs[1].hashes))
    throw new Error("Source or build configuration differs beyond the declared dependency");
  const added = introducedPackages(inputs[0].lock, inputs[1].lock);
  const removed = introducedPackages(inputs[1].lock, inputs[0].lock);
  if ([...added, ...removed].some((item) => item.name !== dependency))
    throw new Error(
      "Lock graph differs beyond the declared dependency; use a separately reviewed comparison scope",
    );
  if (inputs[0].lock !== inputs[1].lock)
    validateDependencyDelta({
      manager: "npm",
      packageName: dependency,
      currentVersion: inputs[0].version.replace(/^[~^=]/u, ""),
      newVersion: inputs[1].version.replace(/^[~^=]/u, ""),
      baseManifest: readFileSync(path.join(inputs[0].root, "apps/desktop/package.json"), "utf8"),
      headManifest: readFileSync(path.join(inputs[1].root, "apps/desktop/package.json"), "utf8"),
      baseLock: inputs[0].lock,
      headLock: inputs[1].lock,
    });
  return inputs.map(({ lock, ...input }) => ({
    ...input,
    lockHash: sha(lock),
    dependencyChanges: { added, removed },
  }));
}

export function assetInventory(root) {
  const entries = [];
  const walk = (directory) => {
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

export function compareBuilds({
  baseline,
  candidate,
  dependency,
  evidenceRoot,
  runner = spawnCommand,
}) {
  const evidence = path.resolve(evidenceRoot);
  if ([baseline, candidate].some((root) => contains(path.resolve(root), evidence)))
    throw new Error("Evidence directory must be outside both comparison roots");
  const directory = path.join(evidence, randomUUID());
  mkdirSync(directory, { recursive: true });
  const report = {
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
      const build = { root: input.root, head: input.head, commands: [] };
      report.builds.push(build);
      for (const args of [
        ["pnpm", "--version"],
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "--dir", "apps/desktop", "build"],
      ]) {
        const result = runner("corepack", args, {
          cwd: input.root,
          env: frontendEnvironment(process.env),
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        });
        build.commands.push({
          executable: "corepack",
          args,
          status: result.status,
          evidence: retainCommandEvidence(directory, result),
        });
        save();
        if (result.error || result.status !== 0)
          throw new Error(`Comparison command failed: corepack ${args.join(" ")}`);
        if (args.includes("--version")) {
          build.pnpm = String(result.stdout).trim();
          if (`pnpm@${build.pnpm}` !== input.manager)
            throw new Error("Executed pnpm differs from the declared pin");
        }
      }
      build.assets = assetInventory(path.join(input.root, "apps/desktop/dist"));
      save();
    }
    if (report.builds[0].pnpm !== report.builds[1].pnpm)
      throw new Error("Package manager versions differ");
    report.totals = report.builds.map((build) =>
      Object.fromEntries(
        ["js", "css"].map((type) => [
          type,
          build.assets
            .filter((a) => a.type === type)
            .reduce((total, a) => ({ raw: total.raw + a.raw, gzip: total.gzip + a.gzip }), {
              raw: 0,
              gzip: 0,
            }),
        ]),
      ),
    );
    report.state = "complete";
  } catch (error) {
    report.state = "failed";
    report.failure = error.message;
    throw error;
  } finally {
    save();
  }
  return { report, reference: file };
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
        "Usage: frontend-build-compare.mjs --baseline ROOT --candidate ROOT --dependency NAME --evidence-root ROOT",
      );
    const { report, reference } = compareBuilds({
      baseline: args[1],
      candidate: args[3],
      dependency: args[5],
      evidenceRoot: args[7],
    });
    console.log(
      renderBoundedSummary(
        "Frontend comparison complete",
        report.totals.map(
          (total, index) => `${report.inputs[index].head}: ${JSON.stringify(total)}`,
        ),
        { reference },
      ).text,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
