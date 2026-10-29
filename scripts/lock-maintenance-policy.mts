import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, errorMessage } from "./runtime-values.mts";
import {
  MaintenanceRegistry,
  maintenanceLimits,
  maintenanceAgePolicy,
} from "./lock-maintenance-registry.mts";
import type { MaintenanceArtifact, RegistryObservation } from "./lock-maintenance-registry.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const locks = new Set(["Cargo.lock", "pnpm-lock.yaml"]);
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function record(value: unknown) {
  if (!isRecord(value)) throw new Error("Incomplete maintenance event identity");
  return value;
}
export function maintenanceIdentity(event: unknown) {
  const pull = record(record(event).pull_request),
    head = record(pull.head),
    base = record(pull.base);
  if (
    typeof head.sha !== "string" ||
    typeof base.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(head.sha) ||
    !/^[a-f0-9]{40}$/u.test(base.sha)
  )
    throw new Error("Maintenance source revisions are invalid");
  const expected = head.ref === "renovate/lock-file-maintenance";
  if (!expected) {
    if (
      record(pull.user).login === "renovate[bot]" &&
      /lockFileMaintenance/u.test(String(pull.body))
    )
      throw new Error("Maintenance kind conflicts with configured branch identity");
    return {
      applicable: false as const,
      head: head.sha,
      target: base.sha,
      reason: "not a canonical Renovate maintenance candidate",
    };
  }
  if (
    record(pull.user).login !== "renovate[bot]" ||
    base.ref !== "main" ||
    record(head.repo).full_name !== "boburning/portcove" ||
    record(base.repo).full_name !== "boburning/portcove" ||
    typeof pull.body !== "string" ||
    (pull.body.match(/^\|\s*lockFileMaintenance\s*\|/gmu) ?? []).length !== 1
  )
    throw new Error("Expected maintenance candidate has ambiguous author/repository/kind");
  return { applicable: true as const, head: head.sha, target: base.sha };
}
function git(cwd: string, args: string[], trim = true) {
  const bytes = execFileSync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: maintenanceLimits.lockBytes,
  });
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return trim ? value.trimEnd() : value;
}
export function maintenanceSource(cwd: string, identity: ReturnType<typeof maintenanceIdentity>) {
  for (const revision of [identity.head, identity.target])
    if (git(cwd, ["rev-parse", `${revision}^{commit}`]) !== revision)
      throw new Error("Source object mismatch");
  const base = git(cwd, ["merge-base", identity.target, identity.head]);
  const paths = git(cwd, ["diff", "--name-only", base, identity.head]).split("\n").filter(Boolean);
  git(cwd, ["merge-base", "--is-ancestor", identity.head, "HEAD"]);
  if (identity.applicable && paths.some((file) => !locks.has(file)))
    throw new Error("Maintenance changes more than supported locks");
  return { ...identity, base, paths };
}
function blob(cwd: string, revision: string, file: string) {
  const bytes = git(cwd, ["show", `${revision}:${file}`], false);
  if (Buffer.byteLength(bytes) > maintenanceLimits.lockBytes)
    throw new Error("Lock byte budget exceeded");
  return bytes;
}
function cargoInventory(text: string): Record<string, unknown>[] {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", fileURLToPath(new URL("./cargo-lock-inventory.py", import.meta.url))],
    {
      input: text,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: maintenanceLimits.lockBytes,
    },
  );
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `Cargo inventory failed (exit ${result.status ?? "unknown"}, diagnostic sha256 ${sha(result.stderr ?? "")})`,
    );
  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value) || !value.every(isRecord))
    throw new Error("Invalid Cargo inventory output");
  return value;
}
export function introducedCargo(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
) {
  const identity = (p: Record<string, unknown>) =>
    JSON.stringify([p.name, p.version, p.source, p.checksum]);
  const known = new Set(before.map(identity));
  const artifacts: MaintenanceArtifact[] = [];
  for (const p of after) {
    if (known.has(identity(p))) continue;
    if (
      p.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
      typeof p.name !== "string" ||
      typeof p.version !== "string" ||
      typeof p.checksum !== "string"
    )
      throw new Error("Changed local/Git/custom Cargo identity needs controlled source review");
    artifacts.push({
      manager: "cargo",
      name: p.name,
      version: p.version,
      integrity: `sha256-${Buffer.from(p.checksum, "hex").toString("base64")}`,
    });
  }
  return artifacts;
}
async function inventory(cwd: string, base: string, head: string) {
  const { lockInventory, validateRootPnpmToolchain, introducedPackages, registrySnapshotCoverage } =
    await import("./pnpm-lock-inventory.mts");
  const texts = [base, head].map((revision) => ({
    cargo: blob(cwd, revision, "Cargo.lock"),
    pnpm: blob(cwd, revision, "pnpm-lock.yaml"),
    manifest: blob(cwd, revision, "package.json"),
    workspace: blob(cwd, revision, "pnpm-workspace.yaml"),
  }));
  const [beforeText, afterText] = texts;
  if (!beforeText || !afterText) throw new Error("Incomplete base/head lock pair");
  const parsed = texts.map((source) => {
    const manifest = record(JSON.parse(source.manifest));
    if (typeof manifest.packageManager !== "string")
      throw new Error("Missing package-manager identity");
    validateRootPnpmToolchain(source.pnpm, manifest.packageManager, source.workspace);
    const cargo = cargoInventory(source.cargo),
      pnpm = lockInventory(source.pnpm);
    if (cargo.length + pnpm.size > maintenanceLimits.entries)
      throw new Error("Inventory item budget exceeded");
    return { cargo, pnpm, closure: registrySnapshotCoverage(source.pnpm, beforeText.pnpm) };
  });
  const [before, after] = parsed;
  if (!before || !after) throw new Error("Incomplete parsed base/head inventory");
  const artifacts = introducedCargo(before.cargo, after.cargo);
  for (const p of introducedPackages(beforeText.pnpm, afterText.pnpm)) {
    if (p.unsupported !== undefined)
      throw new Error(`Unsupported changed pnpm source (sha256 ${sha(p.unsupported)})`);
    artifacts.push({ manager: "npm", name: p.name, version: p.version, integrity: p.integrity });
  }
  if (artifacts.length > maintenanceLimits.artifacts)
    throw new Error("Introduced artifact budget exceeded");
  return {
    artifacts,
    sourceHashes: texts.map((s) => ({ cargo: sha(s.cargo), pnpm: sha(s.pnpm) })),
    inventories: parsed.map((p) => ({
      cargo: p.cargo.length,
      pnpm: p.pnpm.size,
      closure: p.closure,
    })),
  };
}
export async function runMaintenancePolicy(mode: string, cwd = root) {
  if (!new Set(["classify", "check"]).has(mode))
    throw new Error("maintenance requires classify or check");
  const directory = path.join(cwd, "work", "dependency-policy");
  mkdirSync(directory, { recursive: true });
  const report: Record<string, unknown> & { execution: string; acceptance: boolean } = {
    format_version: 1,
    kind: "lock-maintenance-policy",
    execution: "incomplete",
    observations: [],
    acceptance: false,
    limits: maintenanceLimits,
    age_policy: maintenanceAgePolicy,
  };
  const file = path.join(directory, `${randomUUID()}.json`);
  try {
    const eventFile = process.env.GITHUB_EVENT_PATH;
    if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !eventFile)
      throw new Error("PR event authority unavailable");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(eventFile));
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("PR event exceeds budget");
    report.event_sha256 = sha(raw);
    const identity = maintenanceSource(cwd, maintenanceIdentity(JSON.parse(raw)));
    const executingHead = git(cwd, ["rev-parse", "HEAD"]);
    const policyFiles = [
      "dependency-security.mts",
      "lock-maintenance-policy.mts",
      "lock-maintenance-registry.mts",
      "pnpm-lock-inventory.mts",
      "cargo-lock-inventory.py",
    ];
    const policyHashes = () =>
      Object.fromEntries([
        ...policyFiles.map((name): [string, string] => [
          name,
          sha(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")),
        ]),
        ["renovate.json", sha(readFileSync(new URL("../renovate.json", import.meta.url), "utf8"))],
      ]);
    const hashes = policyHashes();
    report.policy_source = { checkout: executingHead, files: hashes };
    report.identity = identity;
    report.execution = identity.applicable ? "classified-only" : "not-applicable";
    if (process.env.GITHUB_OUTPUT && mode === "classify")
      appendFileSync(process.env.GITHUB_OUTPUT, `maintenance=${identity.applicable}\n`);
    if (identity.applicable && mode === "check") {
      report.execution = "incomplete";
      const source = await inventory(cwd, identity.base, identity.head);
      Object.assign(report, source);
      const registry = new MaintenanceRegistry();
      report.observed_at = new Date(registry.observedAt).toISOString();
      const observations: RegistryObservation[] = [];
      report.observations = observations;
      for (const artifact of source.artifacts) {
        report.active_artifact = artifact;
        observations.push(await registry.verify(artifact));
      }
      delete report.active_artifact;
      if (
        JSON.stringify(await inventory(cwd, identity.base, identity.head)) !==
        JSON.stringify(source)
      )
        throw new Error("Source inventory changed during verification");
      if (
        git(cwd, ["rev-parse", "HEAD"]) !== executingHead ||
        JSON.stringify(policyHashes()) !== JSON.stringify(hashes) ||
        sha(readFileSync(eventFile, "utf8")) !== sha(raw)
      )
        throw new Error("Policy or event changed during verification");
      report.execution = source.artifacts.length ? "age-check-executed" : "no-introduced-artifacts";
      report.acceptance =
        observations.length > 0 &&
        observations.every((p) => p.age === "eligible" && p.archiveVerified);
      if (observations.some((p) => p.age === "young"))
        throw new Error(
          "Introduced artifact has not reached its exact 24-hour-plus-30-minute boundary",
        );
    } else if (identity.applicable) report.execution = "classified-only";
  } catch (error) {
    report.failure = errorMessage(error);
    throw error;
  } finally {
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(
      `Dependency maintenance evidence: ${file}; ${report.execution}; age acceptance ${report.acceptance}`,
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nDependency maintenance: ${report.execution}; age acceptance ${report.acceptance}. Evidence: ${path.relative(cwd, file)}\n`,
      );
  }
}
