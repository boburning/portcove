import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { renderBoundedSummary } from "./report-summary.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixturePath = fileURLToPath(
  new URL("./fixtures/serde-json-renovate-44.156.3.json", import.meta.url),
);

export function freezeProbeClock(observedAt) {
  const OriginalDate = globalThis.Date,
    now = OriginalDate.parse(observedAt);
  assert.ok(Number.isFinite(now), "Invalid probe clock");
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  return () => {
    globalThis.Date = OriginalDate;
  };
}

export function validateEngine(engine, fixture) {
  const version = JSON.parse(readFileSync(path.join(engine, "package.json"), "utf8")).version;
  assert.equal(
    version,
    fixture.engine.version,
    "Engine version mismatch: fresh deployed-engine capture and adapter review required",
  );
  const sources = Object.fromEntries(
    Object.keys(fixture.engine.sources).map((source) => [
      source,
      hash(readFileSync(path.join(engine, "dist", source))),
    ]),
  );
  assert.deepEqual(
    sources,
    fixture.engine.sources,
    "Engine source mismatch: fresh capture required",
  );
  return { version, sources };
}

export function normalizeExtraction(extraction) {
  assert.ok(Array.isArray(extraction?.deps), "Extractor must return deps");
  const deps = extraction.deps.filter((dep) => ["serde_json", "semver"].includes(dep.depName));
  assert.equal(deps.length, 2, "Expected serde_json and nearby semver control");
  assert.equal(new Set(deps.map((dep) => dep.depName)).size, 2, "Duplicate extracted identities");
  return deps.map((dep) => {
    assert.equal(dep.datasource, "crate");
    assert.equal(typeof dep.currentValue, "string");
    assert.equal(typeof dep.lockedVersion, "string");
    return {
      ...dep,
      packageName: dep.packageName ?? dep.depName,
      manager: "cargo",
      packageFile: "Cargo.toml",
      versioning: "cargo",
      currentVersion: dep.lockedVersion,
    };
  });
}

export function validatePresetResult(result) {
  assert.ok(
    result?.config && typeof result.config === "object",
    "Preset result must contain config",
  );
  assert.ok(result.visitedPresets, "Preset result must retain visitedPresets");
  return result.config;
}

export function validateLookupResult(result) {
  assert.equal(result?.res?.ok, true, "Lookup must return a successful Result");
  assert.ok(Array.isArray(result.res.val?.updates), "Lookup Result must contain updates");
  return result.res.val.updates;
}

export function validateCommandRecords(records) {
  const commands = records
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

export function validateArtifactResult(artifacts) {
  assert.ok(
    artifacts?.length && artifacts.every((item) => !item.artifactError),
    "Artifact failure",
  );
  const additions = artifacts.filter(
    (item) => item.file?.type === "addition" && item.file.path === "Cargo.lock",
  );
  assert.equal(additions.length, 1, "Exactly one Cargo lock addition required");
  const contents = additions[0].file.contents;
  assert.ok(
    typeof contents === "string" || Buffer.isBuffer(contents),
    "Unsupported artifact content shape",
  );
  return Buffer.isBuffer(contents) ? contents.toString("utf8") : contents;
}

const locked = (text, name) =>
  text.match(new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`))?.[1];
const otherEntries = (text) =>
  text
    .split(/(?=^\[\[package\]\]$)/mu)
    .filter((block) => !/^name = "serde_json"$/mu.test(block))
    .join("");

export async function runEngineProbe({ engine, workspace, configFile, observedAt, evidenceRoot }) {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
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
    config = JSON.parse(configBytes);
  const report = {
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
  const mod = (source) => import(pathToFileURL(path.join(engine, "dist", source)));
  let restoreClock = () => {},
    loggerStream;
  try {
    process.env.LOG_LEVEL = "fatal";
    const { init, addStream } = await mod("logger/index.js");
    await init();
    const records = [];
    let pending = "";
    loggerStream = new Writable({
      write(chunk, encoding, done) {
        writeFileSync(path.join(directory, "execution.jsonl"), chunk, { flag: "a" });
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines.filter(Boolean)) records.push(JSON.parse(line));
        done();
      },
    });
    addStream({ name: "portcove-probe", level: "debug", stream: loggerStream });
    const { GlobalConfig } = await mod("config/global.js");
    const { setUserEnv } = await mod("util/env.js");
    const names = ["PATH", "USERPROFILE", "CARGO_HOME", "RUSTUP_HOME", "TEMP", "TMP", "SYSTEMROOT"];
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
    const { resolveConfigPresets } = await mod("config/presets/index.js"),
      { applyPackageRules } = await mod("util/package-rules/index.js"),
      { extractPackageFile } = await mod("modules/manager/cargo/extract.js"),
      { lookupUpdates } = await mod("workers/repository/process/lookup/index.js"),
      { filterInternalChecks, resolveUpdateTypeConfig } = await mod(
        "workers/repository/process/lookup/filter-checks.js",
      ),
      { generateUpdate } = await mod("workers/repository/process/lookup/generate.js"),
      { get } = await mod("modules/versioning/index.js");
    const deps = normalizeExtraction(await extractPackageFile(manifest, "Cargo.toml", {}));
    report.extraction = deps;
    const resolved = validatePresetResult(await resolveConfigPresets(config));
    const effective = await Promise.all(
      deps.map((dep) => applyPackageRules({ ...resolved, ...dep }, "pre-lookup")),
    );
    const serde = effective.find((dep) => dep.depName === "serde_json"),
      control = effective.find((dep) => dep.depName === "semver");
    assert.equal(serde.rangeStrategy, "update-lockfile");
    assert.equal(control.rangeStrategy, "bump");
    for (const dep of effective) {
      assert.equal(dep.minimumReleaseAge, "3 days");
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
    const registry = await response.json();
    writeFileSync(path.join(directory, "registry.json"), JSON.stringify(registry));
    const api = get("cargo"),
      releases = registry.versions
        .filter(
          (v) =>
            !v.yanked &&
            api.matches(v.num, serde.currentValue) &&
            api.isGreaterThan(v.num, serde.lockedVersion),
        )
        .map((v) => ({ version: v.num, releaseTimestamp: v.created_at }))
        .sort((a, b) => api.sortVersions(a.version, b.version));
    restoreClock = freezeProbeClock(observedAt);
    const selection = await filterInternalChecks(serde, api, "latest", structuredClone(releases));
    assert.ok(
      selection.release && !selection.pendingChecks,
      "Selected release must satisfy strict age checks",
    );
    const newer = releases.filter((release) =>
      api.isGreaterThan(release.version, selection.release.version),
    );
    assert.ok(
      newer.some((release) => Date.parse(release.releaseTimestamp) + 3 * 86400000 > Date.now()),
      "Probe needs a newer ineligible compatible release",
    );
    const lookup = await lookupUpdates(serde);
    writeFileSync(path.join(directory, "lookup.json"), JSON.stringify(lookup));
    const updates = validateLookupResult(lookup),
      update = updates.find((item) => item.newVersion === selection.release.version);
    assert.ok(update && !update.pendingChecks, "Eligible generated lookup update missing");
    assert.equal(update.newValue, serde.currentValue);
    assert.equal(update.isLockfileUpdate, true);
    report.selection = { releases, selection, update };
    const unknown = await filterInternalChecks(serde, api, "latest", [{ version: "1.0.999" }]);
    assert.equal(unknown.pendingChecks, true);
    const minor = await generateUpdate(
      serde,
      serde.currentValue,
      api,
      serde.rangeStrategy,
      serde.lockedVersion,
      "minor",
      { version: "1.1.0", releaseTimestamp: "2026-01-01T00:00:00Z" },
      [serde.lockedVersion, "1.1.0"],
    );
    assert.equal(minor.newValue, serde.currentValue);
    assert.equal(minor.isLockfileUpdate, true);
    const major = await resolveUpdateTypeConfig(serde, "major");
    assert.equal(major.dependencyDashboardApproval, true);
    const security = await applyPackageRules(
      {
        ...resolved,
        ...deps.find((d) => d.depName === "serde_json"),
        isVulnerabilityAlert: true,
        force: { ...config.vulnerabilityAlerts },
      },
      "security",
    );
    assert.equal(security.minimumReleaseAge, null);
    assert.equal(security.automerge, false);
    assert.equal(
      (await resolveUpdateTypeConfig(security, "major")).dependencyDashboardApproval,
      false,
    );
    const securitySelection = await filterInternalChecks(
      security,
      api,
      "latest",
      structuredClone(releases),
    );
    assert.ok(api.isGreaterThan(securitySelection.release.version, selection.release.version));
    const negativeControls = [];
    for (const override of [
      { manager: "npm" },
      { datasource: "npm" },
      { packageName: "semver", depName: "semver" },
      { packageName: "serde_json_extra", depName: "serde_json_extra" },
    ]) {
      const effectiveControl = await applyPackageRules(
        { ...resolved, ...deps.find((d) => d.depName === "serde_json"), ...override },
        "pre-lookup",
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
        selected: securitySelection.release.version,
      },
    };
    save();
    restoreClock();
    const { updateArtifacts } = await mod("modules/manager/cargo/artifacts.js");
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
      commands.some((command) => command.includes(`--precise ${update.newVersion}`)),
      "Selected precise artifact command missing",
    );
    assert.ok(
      commands.some((command) => command.includes("--workspace")),
      "Workspace artifact command missing",
    );
    report.artifact = {
      locked: update.newVersion,
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
      filter: (file) => !path.relative(localDir, file).split(path.sep).includes("target"),
    });
    writeFileSync(path.join(maintenanceDir, "Cargo.lock"), before);
    GlobalConfig.set({ ...GlobalConfig.get(), localDir: maintenanceDir.replaceAll("\\", "/") });
    const start = records.length;
    const maintenance = await updateArtifacts({
      packageFileName: "Cargo.toml",
      updatedDeps: [{ ...serde, ...update }],
      newPackageFileContent: manifest,
      config: { constraints: { rust: "1.98.0" }, isLockFileMaintenance: true },
    });
    writeFileSync(path.join(directory, "maintenance-artifacts.json"), JSON.stringify(maintenance));
    assert.ok(maintenance?.length && maintenance.every((item) => !item.artifactError));
    const maintenanceLock = readFileSync(path.join(maintenanceDir, "Cargo.lock"), "utf8"),
      maintenanceCommands = validateCommandRecords(records.slice(start));
    assert.ok(
      maintenanceCommands.every(
        (command) => !command.includes("--precise") && !command.includes("--workspace"),
      ),
      "Full maintenance must use the general artifact path",
    );
    assert.ok(
      api.isGreaterThan(locked(maintenanceLock, "serde_json"), update.newVersion),
      "Maintenance boundary needs the newer compatible artifact",
    );
    report.fullLockfileMaintenance = {
      locked: locked(maintenanceLock, "serde_json"),
      nearby: locked(maintenanceLock, "semver"),
      commands: maintenanceCommands,
      universalTransitiveAgeGuarantee: false,
    };
    report.state = "complete";
  } catch (error) {
    report.state = "failed";
    report.failure = error.message;
    throw error;
  } finally {
    restoreClock();
    save();
    if (loggerStream) await new Promise((resolve) => loggerStream.end(resolve));
  }
  return { report, reference: reportPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2),
      flags = ["--engine", "--workspace", "--config", "--observed-at", "--evidence-root"];
    if (args.length !== 10 || flags.some((flag, index) => args[index * 2] !== flag))
      throw new Error(
        `Usage: renovate-engine-probe.mjs ${flags.map((flag) => `${flag} VALUE`).join(" ")}`,
      );
    const { report, reference } = await runEngineProbe({
      engine: args[1],
      workspace: args[3],
      configFile: args[5],
      observedAt: args[7],
      evidenceRoot: args[9],
    });
    console.log(
      renderBoundedSummary(
        `Renovate ${report.engine.version} probe complete`,
        [
          `Selected and locked ${report.artifact.locked}; nearby ${report.artifact.nearby} unchanged`,
          "Local replay only; naturally occurring hosted proposal/readback still required",
        ],
        { reference },
      ).text,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
