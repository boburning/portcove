import type { BinaryLike } from "node:crypto";
import { errorMessage, isRecord } from "./runtime-values.mts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { renderBoundedSummary } from "./report-summary.mts";

interface ProbeOptions {
  engine: string;
  workspace: string;
  configFile: string;
  observedAt: string;
  evidenceRoot: string;
}
interface ProbeDependency extends Record<string, unknown> {
  depName: string;
  currentValue: string;
  lockedVersion: string;
}
interface ReleaseObservation {
  version: string;
  releaseTimestamp: string;
}
interface ProbeReport {
  schemaVersion: number;
  engine: { version: string; sources: Record<string, string> };
  observedAt: string;
  observationKind: string;
  inputs: { manifestSha256: string; lockSha256: string; configSha256: string };
  state: "running" | "complete" | "failed";
  extraction?: ReturnType<typeof normalizeExtraction>;
  preLookup?: {
    depName: string;
    rangeStrategy: unknown;
    minimumReleaseAge: unknown;
    minimumReleaseAgeBehaviour: unknown;
    internalChecksFilter: unknown;
    automerge: unknown;
  }[];
  selection?: {
    releases: ReleaseObservation[];
    selection: Record<string, unknown>;
    update: Record<string, unknown>;
  };
  syntheticBoundaries?: {
    unknownTimestampPending: unknown;
    minor: Record<string, unknown>;
    majorApproval: unknown;
    negativeControls: Record<string, unknown>[];
    security: { minimumReleaseAge: unknown; automerge: unknown; selected: string };
  };
  artifact?: {
    locked: string;
    nearby: string | undefined;
    commands: string[];
    manifestUnchanged: boolean;
    otherLockEntriesUnchanged: boolean;
    afterLockSha256: string;
  };
  fullLockfileMaintenance?: {
    locked: string | undefined;
    nearby: string | undefined;
    commands: string[];
    universalTransitiveAgeGuarantee: boolean;
  };
  failure?: string;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected engine object");
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string", "Expected engine text");
  return value;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected engine collection");
  return value;
}
function required<Value>(value: Value | undefined): Value {
  assert.ok(value !== undefined);
  return value;
}
// Pinned deployed Renovate internals are loaded by file URL, outside this project's dependency graph.
// Check export callability and keep results unknown until their consumed contract is validated.
function callable(value: unknown, receiver?: object) {
  assert.ok(typeof value === "function", "Expected callable pinned engine export");
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(value, receiver, args);
    return result;
  };
}
function dependency(value: unknown): ProbeDependency {
  const raw = object(value);
  return {
    ...raw,
    depName: text(raw.depName),
    currentValue: text(raw.currentValue),
    lockedVersion: text(raw.lockedVersion),
  };
}
const hash = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");
const fixturePath = fileURLToPath(
  new URL("./fixtures/serde-json-renovate-44.156.3.json", import.meta.url),
);

export function freezeProbeClock(observedAt: string) {
  const OriginalDate = globalThis.Date,
    now = OriginalDate.parse(observedAt);
  assert.ok(Number.isFinite(now), "Invalid probe clock");
  globalThis.Date = new Proxy(OriginalDate, {
    apply() {
      return new OriginalDate(now).toString();
    },
    construct(target, args, newTarget) {
      const date: unknown = Reflect.construct(target, args.length ? args : [now], newTarget);
      assert.ok(date instanceof OriginalDate);
      return date;
    },
    get(target, key, receiver) {
      if (key === "now") return () => now;
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });
  return () => {
    globalThis.Date = OriginalDate;
  };
}

export function validateEngine(engine: string, fixture: unknown) {
  const expected = object(object(fixture).engine);
  const raw: unknown = JSON.parse(readFileSync(path.join(engine, "package.json"), "utf8"));
  const version = text(object(raw).version);
  assert.equal(
    version,
    expected.version,
    "Engine version mismatch: fresh deployed-engine capture and adapter review required",
  );
  const expectedSources = object(expected.sources);
  const sources = Object.fromEntries(
    Object.keys(expectedSources).map((source) => [
      source,
      hash(readFileSync(path.join(engine, "dist", source))),
    ]),
  );
  assert.deepEqual(sources, expectedSources, "Engine source mismatch: fresh capture required");
  return { version, sources };
}

export function normalizeExtraction(extraction: unknown) {
  const raw = object(extraction);
  assert.ok(Array.isArray(raw.deps), "Extractor must return deps");
  const entries: unknown[] = raw.deps;
  const deps = entries
    .map(object)
    .filter((dep) => ["serde_json", "semver"].some((name) => name === dep.depName));
  assert.equal(deps.length, 2, "Expected serde_json and nearby semver control");
  assert.equal(new Set(deps.map((dep) => dep.depName)).size, 2, "Duplicate extracted identities");
  return deps.map((raw) => {
    const dep = dependency(raw);
    assert.equal(dep.datasource, "crate");
    return {
      ...dep,
      packageName: text(dep.packageName ?? dep.depName),
      manager: "cargo",
      packageFile: "Cargo.toml",
      versioning: "cargo",
      currentVersion: dep.lockedVersion,
    };
  });
}

/** Renovate exports a class with static methods; its receiver is part of the contract. */
export function validateGlobalConfig(value: unknown) {
  assert.ok(
    value !== null && (typeof value === "object" || typeof value === "function"),
    "GlobalConfig export required",
  );
  const set: unknown = Reflect.get(value, "set");
  const get: unknown = Reflect.get(value, "get");
  return { set: callable(set, value), get: callable(get, value) };
}

export function validatePresetResult(value: unknown) {
  const result = object(value);
  assert.ok(isRecord(result.config), "Preset result must contain config");
  assert.ok(result.visitedPresets, "Preset result must retain visitedPresets");
  return result.config;
}
export function validateLookupResult(value: unknown) {
  const result = isRecord(value) ? value : {};
  const res = isRecord(result.res) ? result.res : {};
  assert.equal(res.ok, true, "Lookup must return a successful Result");
  const val = isRecord(res.val) ? res.val : {};
  assert.ok(Array.isArray(val.updates), "Lookup Result must contain updates");
  const updates: unknown[] = val.updates;
  return updates.map(object);
}
export function validateCommandRecords(records: readonly unknown[]) {
  const commands = records
    .map(object)
    .filter((record) => record.msg === "Executing command")
    .map((record) => {
      const command = record.command ?? record.cmd;
      assert.ok(
        typeof command === "string" && command.trim().length > 0,
        "Empty artifact command record",
      );
      return command;
    });
  assert.ok(commands.length > 0, "Artifact command records missing");
  return commands;
}
export function validateArtifactResult(value: unknown) {
  const artifacts = array(value).map(object);
  assert.ok(artifacts.length && artifacts.every((item) => !item.artifactError), "Artifact failure");
  const additions = artifacts.filter(
    (item) =>
      isRecord(item.file) && item.file.type === "addition" && item.file.path === "Cargo.lock",
  );
  assert.equal(additions.length, 1, "Exactly one Cargo lock addition required");
  const contents = object(required(additions[0]).file).contents;
  assert.ok(
    typeof contents === "string" || Buffer.isBuffer(contents),
    "Unsupported artifact content shape",
  );
  return Buffer.isBuffer(contents) ? contents.toString("utf8") : contents;
}
export function probeFailureSummary(error: unknown) {
  const message = isRecord(error) ? (error.message ?? error) : error;
  const reference =
    isRecord(error) && typeof error.reportReference === "string" ? error.reportReference : null;
  return renderBoundedSummary("Renovate probe failed", [String(message).slice(0, 2000)], {
    reference,
  }).text;
}

const locked = (text: string, name: string) =>
  text.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1];
const otherEntries = (text: string) =>
  text
    .split(/(?=^\[\[package\]\]$)/mu)
    .filter((block) => !/^name = "serde_json"$/mu.test(block))
    .join("");

/** Retain one probe outcome and drain its original logger without replacing
 * frozen or primitive failures with best-effort evidence metadata. */
export async function retainProbeEvidence(
  report: Pick<ProbeReport, "state" | "failure">,
  reference: string,
  observe: () => Promise<void>,
  finalizers: {
    restoreClock: () => void;
    save: () => void;
    loggerStream: () => Writable | undefined;
  },
) {
  try {
    await observe();
  } catch (error) {
    report.state = "failed";
    report.failure = errorMessage(error);
    try {
      if (isRecord(error)) error.reportReference = reference;
    } catch {
      // Evidence metadata is best effort; it must never replace the primary failure.
    }
    throw error;
  } finally {
    finalizers.restoreClock();
    finalizers.save();
    const stream = finalizers.loggerStream();
    if (stream) await new Promise<void>((resolve) => stream.end(resolve));
  }
}

async function runEngineProbe({
  engine,
  workspace,
  configFile,
  observedAt,
  evidenceRoot,
}: ProbeOptions) {
  const fixture: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
  const engineIdentity = validateEngine(engine, fixture);
  assert.ok(Number.isFinite(Date.parse(observedAt)), "Explicit valid observation time required");
  const source = realpathSync(workspace),
    destination = path.resolve(evidenceRoot);
  assert.ok(
    destination !== source && !destination.startsWith(source + path.sep),
    "Evidence must be outside the input workspace",
  );
  const directory = path.join(destination, randomUUID());
  mkdirSync(directory, { recursive: true });
  const localDir = path.join(directory, "workspace");
  cpSync(source, localDir, {
    recursive: true,
    filter: (file) =>
      !path
        .relative(source, file)
        .split(path.sep)
        .some((part) => [".git", "target", "node_modules", "work", "dist"].includes(part)),
  });
  const manifest = readFileSync(path.join(localDir, "Cargo.toml"), "utf8"),
    before = readFileSync(path.join(localDir, "Cargo.lock"), "utf8");
  const configBytes = readFileSync(configFile, "utf8"),
    configValue: unknown = JSON.parse(configBytes);
  const config = object(configValue);
  const report: ProbeReport = {
    schemaVersion: 1,
    engine: engineIdentity,
    observedAt,
    observationKind:
      "registry lookup at an explicit clock; real Cargo artifacts; synthetic policy boundaries separately labelled",
    inputs: {
      manifestSha256: hash(manifest),
      lockSha256: hash(before),
      configSha256: hash(configBytes),
    },
    state: "running",
  };
  const reportPath = path.join(directory, "report.json");
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
  save();
  const mod = async (source: string) => {
    const value: unknown = await import(pathToFileURL(path.join(engine, "dist", source)).href);
    return object(value);
  };
  const load = async (source: string, name: string) => callable((await mod(source))[name]);
  let restoreClock = () => {};
  let loggerStream: Writable | undefined;
  await retainProbeEvidence(
    report,
    reportPath,
    async () => {
      process.env.LOG_LEVEL = "fatal";
      const init = await load("logger/index.js", "init"),
        addStream = await load("logger/index.js", "addStream");
      await init();
      const records: unknown[] = [];
      let pending = "";
      loggerStream = new Writable({
        write(
          chunk: Buffer | string,
          _encoding: BufferEncoding,
          done: (error?: Error | null) => void,
        ) {
          writeFileSync(path.join(directory, "execution.jsonl"), chunk, { flag: "a" });
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines.filter(Boolean)) {
            const record: unknown = JSON.parse(line);
            records.push(record);
          }
          done();
        },
      });
      addStream({ name: "portcove-probe", level: "debug", stream: loggerStream });
      const GlobalConfig = validateGlobalConfig((await mod("config/global.js")).GlobalConfig);
      const setUserEnv = await load("util/env.js", "setUserEnv");
      const names = [
        "PATH",
        "USERPROFILE",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
      ];
      GlobalConfig.set({
        localDir: localDir.replaceAll("\\", "/"),
        cacheDir: path.join(directory, "cache").replaceAll("\\", "/"),
        binarySource: "global",
        executionTimeout: 5,
        allowScripts: false,
        platform: "github",
        allowedEnv: names,
        userAgent: "Portcove-version-bound-policy-probe",
      });
      setUserEnv(
        Object.fromEntries(
          names.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
        ),
      );
      const resolveConfigPresets = await load("config/presets/index.js", "resolveConfigPresets"),
        applyPackageRules = await load("util/package-rules/index.js", "applyPackageRules"),
        extractPackageFile = await load("modules/manager/cargo/extract.js", "extractPackageFile"),
        lookupUpdates = await load("workers/repository/process/lookup/index.js", "lookupUpdates"),
        filterInternalChecks = await load(
          "workers/repository/process/lookup/filter-checks.js",
          "filterInternalChecks",
        ),
        resolveUpdateTypeConfig = await load(
          "workers/repository/process/lookup/filter-checks.js",
          "resolveUpdateTypeConfig",
        ),
        generateUpdate = await load(
          "workers/repository/process/lookup/generate.js",
          "generateUpdate",
        ),
        get = await load("modules/versioning/index.js", "get");
      const deps = normalizeExtraction(await extractPackageFile(manifest, "Cargo.toml", {}));
      report.extraction = deps;
      const resolved = validatePresetResult(await resolveConfigPresets(config));
      const effective = await Promise.all(
        deps.map(async (dep) =>
          dependency(await applyPackageRules({ ...resolved, ...dep }, "pre-lookup")),
        ),
      );
      const serde = required(effective.find((dep) => dep.depName === "serde_json")),
        control = required(effective.find((dep) => dep.depName === "semver"));
      assert.equal(serde.rangeStrategy, "update-lockfile");
      assert.equal(control.rangeStrategy, "bump");
      for (const dep of effective) {
        assert.equal(dep.minimumReleaseAge, "1 day");
        assert.equal(dep.minimumReleaseAgeBehaviour, "timestamp-required");
        assert.equal(dep.internalChecksFilter, "strict");
        assert.equal(dep.automerge, false);
      }
      report.preLookup = effective.map((dep) => ({
        depName: dep.depName,
        rangeStrategy: dep.rangeStrategy,
        minimumReleaseAge: dep.minimumReleaseAge,
        minimumReleaseAgeBehaviour: dep.minimumReleaseAgeBehaviour,
        internalChecksFilter: dep.internalChecksFilter,
        automerge: dep.automerge,
      }));
      save();
      const response = await fetch("https://crates.io/api/v1/crates/serde_json", {
        headers: { "User-Agent": "Portcove-policy-validation" },
        signal: AbortSignal.timeout(20000),
      });
      assert.ok(response.ok, "Crates registry unavailable");
      const registry: unknown = await response.json();
      writeFileSync(path.join(directory, "registry.json"), JSON.stringify(registry));
      const rawApi = object(get("cargo"));
      const booleanMethod =
        (name: string) =>
        (...args: string[]) => {
          const result = callable(rawApi[name], rawApi)(...args);
          assert.ok(typeof result === "boolean");
          return result;
        };
      const api = {
        ...rawApi,
        matches: booleanMethod("matches"),
        isGreaterThan: booleanMethod("isGreaterThan"),
        sortVersions: (left: string, right: string) => {
          const result = callable(rawApi.sortVersions, rawApi)(left, right);
          assert.ok(typeof result === "number");
          return result;
        },
      };
      const releases = array(object(registry).versions)
        .map(object)
        .filter(
          (v) =>
            !v.yanked &&
            api.matches(text(v.num), serde.currentValue) &&
            api.isGreaterThan(text(v.num), serde.lockedVersion),
        )
        .map((v) => ({ version: text(v.num), releaseTimestamp: text(v.created_at) }))
        .sort((a, b) => api.sortVersions(a.version, b.version));
      restoreClock = freezeProbeClock(observedAt);
      const selection = object(
        await filterInternalChecks(serde, rawApi, "latest", structuredClone(releases)),
      );
      assert.ok(
        selection.release && !selection.pendingChecks,
        "Selected release must satisfy strict age checks",
      );
      const selectedVersion = text(object(selection.release).version);
      const newer = releases.filter((release) =>
        api.isGreaterThan(release.version, selectedVersion),
      );
      assert.ok(
        newer.some((release) => Date.parse(release.releaseTimestamp) + 3 * 86400000 > Date.now()),
        "Probe needs a newer ineligible compatible release",
      );
      const lookup = await lookupUpdates(serde);
      writeFileSync(path.join(directory, "lookup.json"), JSON.stringify(lookup));
      const updates = validateLookupResult(lookup),
        update = updates.find((item) => item.newVersion === selectedVersion);
      assert.ok(update && !update.pendingChecks, "Eligible generated lookup update missing");
      assert.equal(update.newValue, serde.currentValue);
      assert.equal(update.isLockfileUpdate, true);
      report.selection = { releases, selection, update };
      const unknown = object(
        await filterInternalChecks(serde, rawApi, "latest", [{ version: "1.0.999" }]),
      );
      assert.equal(unknown.pendingChecks, true);
      const minor = object(
        await generateUpdate(
          serde,
          serde.currentValue,
          rawApi,
          serde.rangeStrategy,
          serde.lockedVersion,
          "minor",
          { version: "1.1.0", releaseTimestamp: "2026-01-01T00:00:00Z" },
          [serde.lockedVersion, "1.1.0"],
        ),
      );
      assert.equal(minor.newValue, serde.currentValue);
      assert.equal(minor.isLockfileUpdate, true);
      const major = object(await resolveUpdateTypeConfig(serde, "major"));
      assert.equal(major.dependencyDashboardApproval, true);
      const security = dependency(
        await applyPackageRules(
          {
            ...resolved,
            ...deps.find((d) => d.depName === "serde_json"),
            isVulnerabilityAlert: true,
            force: {
              ...(config.vulnerabilityAlerts == null ? {} : object(config.vulnerabilityAlerts)),
            },
          },
          "security",
        ),
      );
      assert.equal(security.minimumReleaseAge, null);
      assert.equal(security.automerge, false);
      assert.equal(
        object(await resolveUpdateTypeConfig(security, "major")).dependencyDashboardApproval,
        false,
      );
      const securitySelection = object(
        await filterInternalChecks(security, rawApi, "latest", structuredClone(releases)),
      );
      assert.ok(
        api.isGreaterThan(text(object(securitySelection.release).version), selectedVersion),
      );
      const negativeControls = [];
      for (const override of [
        { manager: "npm" },
        { datasource: "npm" },
        { packageName: "semver", depName: "semver" },
        { packageName: "serde_json_extra", depName: "serde_json_extra" },
      ]) {
        const effectiveControl = object(
          await applyPackageRules(
            { ...resolved, ...deps.find((d) => d.depName === "serde_json"), ...override },
            "pre-lookup",
          ),
        );
        assert.equal(effectiveControl.rangeStrategy, "bump");
        negativeControls.push({ ...override, rangeStrategy: effectiveControl.rangeStrategy });
      }
      report.syntheticBoundaries = {
        unknownTimestampPending: unknown.pendingChecks,
        minor,
        majorApproval: major.dependencyDashboardApproval,
        negativeControls,
        security: {
          minimumReleaseAge: security.minimumReleaseAge,
          automerge: security.automerge,
          selected: text(object(securitySelection.release).version),
        },
      };
      save();
      restoreClock();
      const updateArtifacts = await load("modules/manager/cargo/artifacts.js", "updateArtifacts");
      const artifacts = await updateArtifacts({
        packageFileName: "Cargo.toml",
        updatedDeps: [{ ...serde, ...update }],
        newPackageFileContent: manifest,
        config: { constraints: { rust: "1.98.0" }, isLockFileMaintenance: false },
      });
      writeFileSync(path.join(directory, "artifacts.json"), JSON.stringify(artifacts));
      const generatedLock = validateArtifactResult(artifacts);
      const after = readFileSync(path.join(localDir, "Cargo.lock"), "utf8");
      assert.equal(generatedLock, after, "Returned artifact differs from actual Cargo output");
      assert.equal(locked(after, "serde_json"), update.newVersion);
      assert.equal(locked(after, "semver"), locked(before, "semver"));
      assert.equal(otherEntries(after), otherEntries(before));
      assert.equal(readFileSync(path.join(localDir, "Cargo.toml"), "utf8"), manifest);
      const commands = validateCommandRecords(records);
      assert.ok(
        commands.some((command) => command.includes(`--precise ${text(update.newVersion)}`)),
        "Selected precise artifact command missing",
      );
      assert.ok(
        commands.some((command) => command.includes("--workspace")),
        "Workspace artifact command missing",
      );
      report.artifact = {
        locked: text(update.newVersion),
        nearby: locked(after, "semver"),
        commands,
        manifestUnchanged: true,
        otherLockEntriesUnchanged: true,
        afterLockSha256: hash(after),
      };
      save();
      const maintenanceDir = path.join(directory, "maintenance");
      cpSync(localDir, maintenanceDir, {
        recursive: true,
        filter: (file: string) => !path.relative(localDir, file).split(path.sep).includes("target"),
      });
      writeFileSync(path.join(maintenanceDir, "Cargo.lock"), before);
      GlobalConfig.set({
        ...object(GlobalConfig.get()),
        localDir: maintenanceDir.replaceAll("\\", "/"),
      });
      const start = records.length;
      const maintenance = await updateArtifacts({
        packageFileName: "Cargo.toml",
        updatedDeps: [{ ...serde, ...update }],
        newPackageFileContent: manifest,
        config: { constraints: { rust: "1.98.0" }, isLockFileMaintenance: true },
      });
      writeFileSync(
        path.join(directory, "maintenance-artifacts.json"),
        JSON.stringify(maintenance),
      );
      const maintenanceEntries = array(maintenance).map(object);
      assert.ok(
        maintenanceEntries.length && maintenanceEntries.every((item) => !item.artifactError),
      );
      const maintenanceLock = readFileSync(path.join(maintenanceDir, "Cargo.lock"), "utf8"),
        maintenanceCommands = validateCommandRecords(records.slice(start));
      assert.ok(
        maintenanceCommands.every(
          (command) => !command.includes("--precise") && !command.includes("--workspace"),
        ),
        "Full maintenance must use the general artifact path",
      );
      assert.ok(
        api.isGreaterThan(required(locked(maintenanceLock, "serde_json")), text(update.newVersion)),
        "Maintenance boundary needs the newer compatible artifact",
      );
      report.fullLockfileMaintenance = {
        locked: locked(maintenanceLock, "serde_json"),
        nearby: locked(maintenanceLock, "semver"),
        commands: maintenanceCommands,
        universalTransitiveAgeGuarantee: false,
      };
      report.state = "complete";
    },
    {
      restoreClock: () => restoreClock(),
      save,
      loggerStream: () => loggerStream,
    },
  );
  return { report, reference: reportPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      flags = ["--engine", "--workspace", "--config", "--observed-at", "--evidence-root"];
    if (args.length !== 10 || flags.some((flag, index) => args[index * 2] !== flag))
      throw new Error(
        `Usage: renovate-engine-probe.mts ${flags.map((flag) => `${flag} VALUE`).join(" ")}`,
      );
    const { report, reference } = await runEngineProbe({
      engine: required(args[1]),
      workspace: required(args[3]),
      configFile: required(args[5]),
      observedAt: required(args[7]),
      evidenceRoot: required(args[9]),
    });
    const artifact = required(report.artifact);
    console.log(
      renderBoundedSummary(
        `Renovate ${report.engine.version} probe complete`,
        [
          `Selected and locked ${artifact.locked}; nearby ${artifact.nearby} unchanged`,
          "Local replay only; naturally occurring hosted proposal/readback still required",
        ],
        { reference },
      ).text,
    );
  } catch (error) {
    console.error(probeFailureSummary(error));
    process.exitCode = 1;
  }
}
