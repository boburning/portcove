import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve, extname, relative, isAbsolute, dirname, toNamespacedPath } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "./runtime-values.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { fileIdentity } from "./development-evidence.mts";
import { acquireOwnedProcessLock } from "./process-lock.mts";
import { coreProposalInspector } from "./catalog-authoring-inspector.mts";
import { projectObservedFacts } from "./observe-configured-upstream.mts";
import { assetFact, releaseFact, repositoryFact } from "./upstream-observer.mts";
import type { ProviderObservation } from "./upstream-observer.mts";
import { orderedJsonSha256 as hash } from "./json-values.mts";
import {
  collectSettingsSource,
  settingsCandidateSource,
  settingsDocumentInput,
  qualifySettingsObservation,
} from "./settings-qualification.mts";
import {
  qualifySettingsConsumer,
  requireSettingsVerification,
  initializeSettingsProbeFiles,
} from "./settings-consumer-qualification.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import { collectPortFacts } from "./port-upstream-facts.mts";
import type { PortFactsOptions } from "./port-upstream-facts.mts";

const execute = promisify(execFile);
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function contained(root: string, file: string) {
  const part = relative(root, file);
  return (
    part !== "" &&
    !isAbsolute(part) &&
    part !== ".." &&
    !part.startsWith("../") &&
    !part.startsWith("..\\")
  );
}
async function json(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  return file;
}

export async function assertPreparedInputParent(userData: string, destination: string) {
  const parent = toNamespacedPath(await realpath(dirname(destination)));
  if (!releasePathContains(toNamespacedPath(userData), parent))
    throw new Error("Prepared input parent escaped its retained root.");
}

/** Disposable probe authority, never an authored or publishable catalog. */
export function settingsQualificationCatalog(
  catalog: Record<string, unknown>,
  portId: string,
  candidate: unknown,
) {
  const fixture = structuredClone(catalog);
  if (!Array.isArray(fixture.ports))
    throw new Error("Settings candidate needs the existing complete catalog.");
  const ports: unknown[] = fixture.ports;
  const port: unknown = ports.find((entry) => isRecord(entry) && entry.id === portId);
  if (!isRecord(port) || !isRecord(port.game_settings))
    throw new Error("Settings candidate declaration is absent.");
  // Deliberately discard historical rows: only this machine-derived package can
  // grant disposable probe access, so an old authored binding cannot pass it.
  port.game_settings = { ...port.game_settings, releases: [candidate] };
  return fixture;
}

/** One maintained per-candidate join. The profile is provisioned once; release,
 * source, package, provisional fixture and native case data are all derived.
 * No candidate data is installed outside the marked qualification library. */
export async function prepareSettingsCandidate(options: {
  record: AuthoredPort;
  catalog: Record<string, unknown>;
  facts: Awaited<ReturnType<typeof collectPortFacts>>;
  scope: unknown;
  cli: string;
  checkpoint: string;
  releaseTag?: string | undefined;
  sourceOptions?: Pick<PortFactsOptions, "token" | "fetcher"> | undefined;
}) {
  const { record } = options;
  let facts = options.facts;
  const scope = options.scope;
  if (
    !isRecord(scope) ||
    scope.format_version !== 1 ||
    typeof scope.isolation_root !== "string" ||
    typeof scope.isolation_token !== "string" ||
    typeof scope.baseline_installer !== "string" ||
    !sha(scope.baseline_installer_sha256) ||
    !isRecord(scope.original) ||
    typeof scope.original.path !== "string" ||
    !sha(scope.original.sha256) ||
    !Array.isArray(scope.prepared_files) ||
    scope.prepared_files.length > 8
  )
    throw new Error(
      "Settings qualification needs its once-provisioned private source and compiled-installer profile.",
    );
  const original = { path: scope.original.path, sha256: scope.original.sha256 };
  const root = toNamespacedPath(await realpath(scope.isolation_root));
  const markerPath = join(root, ".portcove-settings-qualification.json");
  const markerInfo = await lstat(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096)
    throw new Error("Settings qualification ownership marker is not bounded regular evidence.");
  const markerBytes = await readFile(markerPath);
  if (markerBytes.length > 4096)
    throw new Error("Settings qualification ownership marker exceeds its bound.");
  const marker: unknown = JSON.parse(markerBytes.toString("utf8"));
  if (
    !isRecord(marker) ||
    marker.owner !== "portcove-settings-qualification" ||
    marker.token !== scope.isolation_token
  )
    throw new Error("Settings qualification profile is not the selected owned disposable scope.");
  if ((await fileIdentity(scope.baseline_installer)).sha256 !== scope.baseline_installer_sha256)
    throw new Error("Settings baseline installer changed; preserve the previous evidence.");
  const checkpoint = join(options.checkpoint, "settings-candidate-" + randomUUID());
  await mkdir(checkpoint);
  const inspector = coreProposalInspector(options.cli, checkpoint);

  const lease = await acquireOwnedProcessLock(
    join(root, "settings-candidate-owner"),
    { workspace: process.cwd(), command: "prepare-settings-candidate" },
    { canReclaim: false },
  );
  let retainOwnership = false;
  const calls: unknown[] = [];
  const executeRecorded = async (
    command: string,
    args: string[],
    environment: NodeJS.ProcessEnv,
  ) => {
    try {
      const result = await execute(command, args, {
        env: environment,
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      calls.push({ command, args, ...result, outcome: "succeeded" });
      return result;
    } catch (error) {
      calls.push({
        command,
        args,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
        stdout: isRecord(error) ? error.stdout : undefined,
        stderr: isRecord(error) ? error.stderr : undefined,
      });
      throw error;
    }
  };
  try {
    const library = await assertOwnedUnlinkedPath(root, join(root, "library"), "Settings library");
    const ownedCandidate = join(root, "candidate-" + randomUUID());
    await mkdir(ownedCandidate);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PORTCOVE_PREFERENCES: join(root, "preferences.json"),
      PORTCOVE_APPLICATION_RUNTIME_LOCK: join(root, "application-runtime"),
    };
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
    ])
      delete environment[name];
    const run = async (args: string[]) => {
      const response = await executeRecorded(
        options.cli,
        ["--library", library, "--json", "--non-interactive", ...args],
        environment,
      );
      const envelope: unknown = JSON.parse(response.stdout);
      if (!isRecord(envelope) || envelope.ok !== true)
        throw new Error("Settings candidate Core operation failed.");
      return envelope.data;
    };
    let planned: Record<string, unknown> | undefined;
    if (options.releaseTag === undefined) {
      const planCatalog = await json(join(ownedCandidate, "plan-catalog.json"), options.catalog);
      environment.PORTCOVE_QUALIFICATION_CATALOG = planCatalog;
      const plan = await run(["plan", record.listing.id, "--channel", "stable"]);
      if (
        !isRecord(plan) ||
        plan.platform !== "windows-x86-64" ||
        plan.channel !== "stable" ||
        !isRecord(plan.release) ||
        typeof plan.release.version !== "string" ||
        !isRecord(plan.release.asset) ||
        typeof plan.release.asset.url !== "string"
      )
        throw new Error("Core did not discover an exact stable Windows settings candidate.");
      planned = plan.release;
      facts = await collectPortFacts({
        ...options.sourceOptions,
        projectUrl: record.listing.project_url,
        releaseUrl: plan.release.asset.url,
        releaseTag: plan.release.version,
        route: "download",
        cacheDirectory: join(options.checkpoint, "facts"),
      });
    }
    if (
      !facts.assets_complete ||
      !isRecord(facts.release?.body) ||
      typeof facts.release.body.tag_name !== "string" ||
      !isRecord(facts.release_project?.body) ||
      typeof facts.release_repository !== "string"
    )
      throw new Error(
        "Settings qualification needs one fully observed exact release and asset inventory.",
      );
    const project = facts.release_project.body;
    const repository = facts.release_repository;
    const tag = facts.release.body.tag_name;
    if (!Number.isSafeInteger(project.id) || Number(project.id) < 1)
      throw new Error("Settings release provider identity is missing.");
    const clock = facts.release.observed_at ?? new Date().toISOString();
    const normalizedFacts = {
      repository: repositoryFact(project, { repository, repository_id: Number(project.id) }),
      releases: [
        {
          ...releaseFact(facts.release.body),
          assets: facts.assets.map((asset) => assetFact(asset, { repository }, tag)),
        },
      ],
    };
    const observation: ProviderObservation = {
      format: 1,
      authority: "provider-observation-only",
      port_id: record.listing.id,
      config_sha256: hash({ id: record.listing.id, repository, repository_id: project.id }),
      started_at: clock,
      completed_at: clock,
      facts_sha256: hash(normalizedFacts),
      facts: normalizedFacts,
      consumed: {
        requests: facts.usage.requests,
        response_bytes: facts.usage.bytes,
        conditional_hits: 0,
      },
    };
    const projection = await projectObservedFacts(
      inspector.artifact,
      { port_id: record.listing.id, repository_id: Number(project.id) },
      checkpoint,
      observation,
    );
    if (!isRecord(projection) || !Array.isArray(projection.projections))
      throw new Error("Core did not select settings candidate metadata.");
    const projections: unknown[] = projection.projections;
    const selected: unknown = projections.find(
      (row) => isRecord(row) && row.platform === "windows-x86-64" && row.channel === "stable",
    );
    const eligible = isRecord(selected) ? selected.latest_eligible : undefined;
    const release = isRecord(eligible) ? eligible.release : undefined;
    const asset = isRecord(release) ? release.asset : undefined;
    if (
      !isRecord(release) ||
      typeof release.version !== "string" ||
      !isRecord(asset) ||
      !sha(asset.sha256) ||
      !isRecord(eligible) ||
      !Number.isSafeInteger(eligible.asset_id)
    )
      throw new Error(
        "Core did not establish an eligible exact settings package with independently expected integrity.",
      );
    const officialAsset = facts.assets.find(
      (entry) => isRecord(entry) && entry.id === eligible.asset_id,
    );
    if (!isRecord(officialAsset) || officialAsset.digest !== "sha256:" + asset.sha256)
      throw new Error("Settings candidate asset is not bound to the observed provider digest.");
    if (
      planned &&
      (planned.version !== release.version ||
        !isRecord(planned.asset) ||
        !["url", "name", "size", "sha256"].every(
          (field) => asset[field] === (planned.asset as Record<string, unknown>)[field],
        ))
    )
      throw new Error("Observed candidate changed after normal Core release selection.");
    const sources = await collectSettingsSource(record, null, {
      ...options.sourceOptions,
      releaseTag: tag,
    });
    const source = sources.find((file) => file.repository === facts.release_repository);
    if (!source) throw new Error("Settings candidate lacks its exact root source.");
    const binding = {
      version: release.version,
      platform: "windows-x86-64" as const,
      archive_sha256: asset.sha256,
      source_commit: source.revision,
    };
    const preflight = settingsCandidateSource(record, binding, sources);
    const probeInput = settingsDocumentInput(record, preflight.candidate);
    const probe: Record<string, unknown> = inspector.inspectSettings(
      "settings-document-probe",
      probeInput,
    );
    await json(join(checkpoint, "source-evidence.json"), sources);
    await json(join(checkpoint, "selection.json"), {
      observation,
      projection,
      release,
      scope: "local provider facts and Core selection; not scheduled or protected publication",
    });

    const fixture = settingsQualificationCatalog(
      options.catalog,
      record.listing.id,
      preflight.candidate,
    );
    const fixturePath = await json(
      join(ownedCandidate, "qualification-only-catalog.json"),
      fixture,
    );
    await json(join(checkpoint, "qualification-only-catalog.json"), fixture);
    inspector.inspect("qualification-only-proposal", Buffer.from(JSON.stringify(fixture)));
    environment.PORTCOVE_QUALIFICATION_CATALOG = fixturePath;
    const inputRoot = await assertOwnedUnlinkedPath(
      root,
      join(root, "inputs"),
      "Settings input root",
    );
    await mkdir(inputRoot, { recursive: true });
    const copiedOriginal = await assertOwnedUnlinkedPath(
      root,
      join(inputRoot, original.sha256 + extname(original.path)),
      "Settings copied original",
    );
    const sourceIdentity = await fileIdentity(original.path);
    if (sourceIdentity.sha256 !== original.sha256)
      throw new Error("The provisioned lawful original changed.");
    try {
      await copyFile(original.path, copiedOriginal, constants.COPYFILE_EXCL);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    if ((await fileIdentity(copiedOriginal)).sha256 !== original.sha256)
      throw new Error("The copied lawful original differs.");
    const info = await lstat(library).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      return null;
    });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Settings library is not its owned directory.");
      const before = await run(["status", record.listing.id]);
      await json(join(checkpoint, "before-update.json"), before);
      if (!isRecord(before)) throw new Error("Core settings candidate status is absent.");
      if (planned && before.active === null && before.staged === null && before.previous === null) {
        const args = ["install", record.listing.id, "--yes"];
        if (typeof record.integration?.source_profile === "string")
          args.push("--source", copiedOriginal);
        await run(args);
      } else {
        if (!isRecord(before.active) || !isRecord(before.active.artifact))
          throw new Error("Settings candidate library has no retained managed baseline.");
        if (before.active.artifact.sha256 !== asset.sha256)
          await run(["update", record.listing.id, "--yes"]);
      }
    } else {
      const baseline = await json(join(checkpoint, "baseline-release.json"), release);
      const args = [record.listing.id, baseline, library, "--baseline-only"];
      if (typeof record.integration?.source_profile === "string")
        args.push("--source", copiedOriginal);
      const result = await executeRecorded(scope.baseline_installer, args, environment);
      const initialized: unknown = JSON.parse(result.stdout);
      await json(join(checkpoint, "baseline-install.json"), {
        stdout: result.stdout,
        stderr: result.stderr,
        result: initialized,
      });
      if (
        !isRecord(initialized) ||
        !isRecord(initialized.baseline) ||
        typeof initialized.baseline.id !== "string"
      )
        throw new Error("Baseline settings installation identity is absent.");
      requireSettingsVerification(initialized.baseline_verification, initialized.baseline.id);
    }
    const status = await run(["status", record.listing.id]);
    if (
      !isRecord(status) ||
      !isRecord(status.active) ||
      !isRecord(status.active.artifact) ||
      status.active.artifact.sha256 !== asset.sha256 ||
      status.active.version !== release.version ||
      typeof status.user_data_root !== "string" ||
      typeof status.active.path !== "string" ||
      typeof status.active.selected_executable !== "string"
    )
      throw new Error("Installed settings candidate differs from the exact observed package.");
    const install = status.active;
    const userDataPath = await assertOwnedUnlinkedPath(
      root,
      toNamespacedPath(status.user_data_root),
      "Settings user data root",
    );
    await mkdir(userDataPath, { recursive: true });
    const userData = toNamespacedPath(await realpath(userDataPath));
    if (!contained(root, userData))
      throw new Error("Settings candidate user data escaped its marked root.");
    for (const input of scope.prepared_files) {
      if (
        !isRecord(input) ||
        typeof input.path !== "string" ||
        typeof input.destination !== "string" ||
        !sha(input.sha256) ||
        !Array.isArray(record.integration?.persistent_paths) ||
        !record.integration.persistent_paths.includes(input.destination)
      )
        throw new Error(
          "Prepared settings input is outside its explicit existing persistent contract.",
        );
      const destination = await assertOwnedUnlinkedPath(
        userData,
        resolve(userData, input.destination),
        "Settings prepared input",
      );
      if (
        !contained(userData, destination) ||
        (await fileIdentity(input.path)).sha256 !== input.sha256
      )
        throw new Error("Prepared settings input changed or escaped.");
      await mkdir(dirname(destination), { recursive: true });
      await assertPreparedInputParent(userData, destination);
      try {
        await copyFile(input.path, destination, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isRecord(error) || error.code !== "EEXIST") throw error;
      }
      if ((await fileIdentity(destination)).sha256 !== input.sha256)
        throw new Error("Prepared settings input copy differs.");
    }
    const settings = record.integration?.game_settings;
    if (
      !isRecord(settings) ||
      !Array.isArray(settings.files) ||
      settings.files.length !== 1 ||
      !Array.isArray(record.settings_qualification_v1?.samples)
    )
      throw new Error("Native settings preparation supports one declared JSON file.");
    const files: unknown[] = settings.files;
    const file: unknown = files[0];
    if (!isRecord(file) || typeof file.path !== "string" || !Array.isArray(file.settings))
      throw new Error("Native settings declaration is incomplete.");
    if (typeof status.active.id !== "string" || typeof file.id !== "string")
      throw new Error("Settings scope identity is absent.");
    const retainedScope = await run(["game-settings", "qualification-scope", record.listing.id]);
    await json(join(checkpoint, "retained-settings-scope.json"), retainedScope);
    const initialized = await initializeSettingsProbeFiles(
      root,
      retainedScope,
      file.id,
      status.active.id,
      record.settings_qualification_v1.samples[0]!.document,
      record.settings_qualification_v1.configuration_scope,
    );
    const configuration = initialized.canonical;
    const executable = toNamespacedPath(
      await realpath(resolve(status.active.path, status.active.selected_executable)),
    );
    if (!contained(root, executable))
      throw new Error("Settings candidate player escaped the marked root.");
    const player = await fileIdentity(executable);
    const verification = await run(["verify", record.listing.id]);
    if (typeof status.active.id !== "string")
      throw new Error("Settings installation identity is absent.");
    requireSettingsVerification(verification, status.active.id);
    const packageReceipt = {
      id: record.listing.id,
      source_revision: source.revision,
      official_asset: officialAsset,
      expected_digest_matched: true,
      observed_archive_sha256: asset.sha256,
      selected_executables: [{ path: status.active.selected_executable, sha256: player.sha256 }],
    };
    const checks: unknown[] = Array.isArray(probe.checks) ? probe.checks : [];
    const declarations: unknown[] = file.settings;
    const probes = checks.filter(isRecord).map((check) => {
      const setting = declarations.find(
        (entry) => isRecord(entry) && entry.id === check.setting_id,
      );
      if (!isRecord(setting) || check.file_id !== file.id)
        throw new Error("Settings probe differs from its explicit control.");
      return { file_id: file.id, setting_id: setting.id, key: setting.key, values: check.values };
    });
    const nativeCase = await json(join(checkpoint, "native-case.json"), {
      format_version: 1,
      protocol: "libultraship-sail-v1",
      configuration_scope: record.settings_qualification_v1.configuration_scope,
      isolation_root: root,
      isolation_token: scope.isolation_token,
      port_id: record.listing.id,
      source_commit: source.revision,
      archive_sha256: asset.sha256,
      cli_sha256: (await fileIdentity(options.cli)).sha256,
      executable_sha256: player.sha256,
      configuration_path: configuration,
      probes,
    });
    const native = await qualifySettingsConsumer({
      cli: options.cli,
      library,
      output: join(root, "native-settings-" + randomUUID()),
      caseFile: nativeCase,
      qualificationCatalog: fixturePath,
    });
    const qualified = await qualifySettingsObservation(
      record,
      binding,
      { ...packageReceipt, settings_consumer: native },
      sources,
      () => probe,
    );
    if ((await fileIdentity(original.path)).sha256 !== original.sha256)
      throw new Error("Qualification changed the original input.");
    await json(join(checkpoint, "verified-installation.json"), { verification, install });
    await json(join(checkpoint, "qualified-settings-observation.json"), qualified);
    return {
      observation: qualified,
      checkpoint,
      native,
      status: "qualified-proposal",
      scope:
        "automatic observed candidate selection, private Core provision/update, actual native consumer and exact generated binding; no production publication",
    };
  } catch (error) {
    retainOwnership = isRecord(error) && error.code === "PORTCOVE_NATIVE_OWNER_UNSETTLED";
    throw error;
  } finally {
    try {
      await json(join(checkpoint, "core-operations.json"), {
        calls,
        retained_unsettled_owner: retainOwnership,
      });
    } finally {
      if (!retainOwnership) await lease.release();
    }
  }
}
