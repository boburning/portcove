import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";
import { orderedJsonSha256 as observationHash, orderedJsonValue } from "./json-values.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";

interface SourceRegion {
  role: "consumer" | "loader" | "storage" | "path" | "build";
  repository: string;
  submodule_path?: string;
  path: string;
  start: string;
  end: string;
  sha256: string;
  reviewed_alternatives?: string[];
}
export interface SettingsQualificationPolicy {
  format_version: 1;
  regions: SourceRegion[];
  samples: { file_id: string; document: string }[];
}
export interface SettingsSourceFile {
  repository: string;
  revision: string;
  path: string;
  content: string;
}
export interface SettingsBinding {
  version: string;
  platform: "windows-x86-64";
  archive_sha256: string;
  source_commit: string;
  evidence_urls: string[];
}
export interface SettingsQualificationObservation {
  format_version: 1;
  port_id: string;
  policy_sha256: string;
  contract_sha256: string;
  binding: SettingsBinding;
  source_regions: { repository: string; revision: string; path: string; sha256: string }[];
  probe: { input_sha256: string; validator_artifact_sha256: string; checks: unknown[] };
  package_receipt_sha256: string;
  consumer_probe: Record<string, unknown>;
}
const sha = (value: unknown, length = 64): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const repository = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) &&
  value.split("/").every((part) => part !== "." && part !== "..");
const relative = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length < 512 &&
  value
    .split("/")
    .every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..");

/** A maintained semantic boundary, not a version range or release inventory. */
export function checkSettingsPolicy(value: unknown): asserts value is SettingsQualificationPolicy {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !Array.isArray(value.regions) ||
    value.regions.length < 5 ||
    value.regions.length > 16 ||
    !Array.isArray(value.samples) ||
    value.samples.length < 1 ||
    value.samples.length > 8
  )
    throw new Error("Invalid bounded settings qualification policy.");
  const roles = new Set<string>();
  for (const region of value.regions) {
    if (
      !isRecord(region) ||
      !["consumer", "loader", "storage", "path", "build"].includes(String(region.role)) ||
      !repository(region.repository) ||
      !relative(region.path) ||
      !sha(region.sha256) ||
      (region.reviewed_alternatives !== undefined &&
        (!Array.isArray(region.reviewed_alternatives) ||
          region.reviewed_alternatives.length > 3 ||
          !region.reviewed_alternatives.every((value) => sha(value) && value !== region.sha256) ||
          new Set(region.reviewed_alternatives).size !== region.reviewed_alternatives.length)) ||
      (region.submodule_path !== undefined && !relative(region.submodule_path)) ||
      ![region.start, region.end].every(
        (marker) => typeof marker === "string" && marker.length > 0 && marker.length < 1024,
      )
    )
      throw new Error("Invalid settings source region.");
    roles.add(String(region.role));
  }
  if (["consumer", "loader", "storage", "path", "build"].some((role) => !roles.has(role)))
    throw new Error(
      "Settings qualification lacks consumer, loader, storage, path or build evidence.",
    );
  for (const sample of value.samples)
    if (
      !isRecord(sample) ||
      typeof sample.file_id !== "string" ||
      typeof sample.document !== "string" ||
      Buffer.byteLength(sample.document) > 1024 * 1024
    )
      throw new Error("Invalid bounded settings qualification sample.");
}

export function settingsSourceRegion(content: string, region: Pick<SourceRegion, "start" | "end">) {
  const start = content.indexOf(region.start);
  const end = content.indexOf(region.end, start + region.start.length);
  if (
    start < 0 ||
    end < 0 ||
    content.indexOf(region.start, start + 1) >= 0 ||
    content.indexOf(region.end, end + 1) >= 0 ||
    Buffer.byteLength(content) > 1024 * 1024
  )
    throw new Error("Settings source region is missing, ambiguous or exceeds its bound.");
  return digest(content.slice(start, end));
}

function matchesReviewedRegion(region: SourceRegion, observed: unknown) {
  return (
    typeof observed === "string" &&
    (observed === region.sha256 || region.reviewed_alternatives?.includes(observed) === true)
  );
}

/** Exact immutable contents through the configured shared SDK. Authored provider
 * identities bound every request; credentials never follow upstream URLs. */
export async function collectSettingsSource(
  record: AuthoredPort,
  revision: string | null,
  options: {
    token?: string | undefined;
    fetcher?: typeof fetch | undefined;
    releaseTag?: string | undefined;
  } = {},
): Promise<SettingsSourceFile[]> {
  const policy = record.settings_qualification_v1;
  checkSettingsPolicy(policy);
  const release = record.integration?.release;
  const rootRepository = isRecord(release) ? release.repository : undefined;
  if (!repository(rootRepository) || (revision !== null && !sha(revision, 40)))
    throw new Error(
      "Settings collection needs an explicit GitHub provider and exact source commit.",
    );
  const deadline = performance.now() + 120000;
  let requests = 0;
  let bytes = 0;
  const { createGitHubClient } = await import("./github-client.mts");
  const sdk = await createGitHubClient({
    credential:
      options.token === undefined
        ? { kind: "anonymous" }
        : { kind: "explicit", token: options.token },
    deadline,
    maxBytes: 2 * 1024 * 1024,
    requestTimeoutMs: 20000,
    ...(options.fetcher ? { fetch: options.fetcher } : {}),
    allowRequest: (method, url) =>
      method === "GET" &&
      url.origin === "https://api.github.com" &&
      /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:contents|commits)\/.*)?$/u.test(
        url.pathname,
      ),
    reserve: async () => {
      if (++requests > 24) throw new Error("Settings source request bound exhausted.");
      return {
        consumeBytes(size) {
          if ((bytes += size) > 8 * 1024 * 1024)
            throw new Error("Settings source byte bound exhausted.");
        },
        settle() {},
      };
    },
  });
  for (const repository of new Set([
    rootRepository,
    ...policy.regions.map((region) => region.repository),
  ])) {
    const metadata = await sdk.request({
      method: "GET",
      url: `/repos/${repository}`,
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    if (
      metadata.status !== 200 ||
      !isRecord(metadata.data) ||
      metadata.data.private !== false ||
      typeof metadata.data.full_name !== "string" ||
      metadata.data.full_name.toLowerCase() !== repository.toLowerCase()
    )
      throw new Error("Settings evidence requires the exact observed public upstream repository.");
  }
  if (!options.releaseTag || options.releaseTag.length > 255)
    throw new Error(
      "Settings qualification needs the observed release tag, not its mutable target branch.",
    );
  const selectedCommit = await sdk.request({
    method: "GET",
    url: `/repos/${rootRepository}/commits/${encodeURIComponent(options.releaseTag)}`,
    request: { portcove: { replay: "once", attempts: 0 } },
  });
  if (
    selectedCommit.status !== 200 ||
    !isRecord(selectedCommit.data) ||
    !sha(selectedCommit.data.sha, 40) ||
    (revision !== null && selectedCommit.data.sha !== revision)
  )
    throw new Error("Settings package source differs from the selected release tag.");
  const sourceRevision = selectedCommit.data.sha;
  const read = async (repo: string, path: string, ref: string) => {
    const response = await sdk.request({
      method: "GET",
      url: `/repos/${repo}/contents/${path}?ref=${ref}`,
      request: { portcove: { replay: "once", attempts: 0 } },
    });
    if (response.status !== 200 || !isRecord(response.data))
      throw new Error("Settings source is unavailable.");
    return response.data;
  };
  const revisions = new Map<string, string>();
  const files = new Map<string, SettingsSourceFile>();
  for (const region of policy.regions) {
    let selected = sourceRevision;
    if (region.submodule_path) {
      const key = `${region.submodule_path}:${region.repository}`;
      let bound = revisions.get(key);
      if (!bound) {
        const link = await read(rootRepository, region.submodule_path, sourceRevision);
        if (
          !sha(link.sha, 40) ||
          link.submodule_git_url !== `https://github.com/${region.repository}.git`
        )
          throw new Error("Settings submodule source identity differs from the authored provider.");
        bound = link.sha;
        revisions.set(key, bound);
      }
      selected = bound;
    } else if (region.repository !== rootRepository) {
      throw new Error("Settings source outside the root requires an exact declared Git submodule.");
    }
    const key = `${region.repository}:${selected}:${region.path}`;
    if (files.has(key)) continue;
    const value = await read(region.repository, region.path, selected);
    if (
      value.type !== "file" ||
      value.encoding !== "base64" ||
      typeof value.content !== "string" ||
      !Number.isSafeInteger(value.size) ||
      Number(value.size) < 1 ||
      Number(value.size) > 1024 * 1024 ||
      !sha(value.sha, 40)
    )
      throw new Error("Settings source is not a bounded regular blob.");
    const content = Buffer.from(value.content.replace(/\n/gu, ""), "base64");
    const oid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    if (
      oid !== value.sha ||
      content.length !== value.size ||
      !Buffer.from(content.toString("utf8")).equals(content)
    )
      throw new Error("Settings source blob identity or UTF-8 differs.");
    files.set(key, {
      repository: region.repository,
      revision: selected,
      path: region.path,
      content: content.toString("utf8"),
    });
  }
  return [...files.values()];
}

function contract(record: AuthoredPort) {
  const value = record.integration?.game_settings;
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.releases) ||
    !Array.isArray(record.integration?.persistent_paths)
  )
    throw new Error("Settings qualification requires the existing explicit settings contract.");
  return { ...value, files: value.files, releases: value.releases };
}

function qualificationInput(record: AuthoredPort, candidate: unknown) {
  return Buffer.from(
    JSON.stringify(
      orderedJsonValue({
        format_version: 1,
        contract: contract(record),
        persistent_paths: record.integration!.persistent_paths,
        candidate,
        samples: record.settings_qualification_v1!.samples,
      }),
    ),
  );
}

function expectedProbeChecks(record: AuthoredPort) {
  return (contract(record).files as Record<string, unknown>[]).flatMap((file) => {
    if (file.format !== "json" || !Array.isArray(file.settings))
      throw new Error(
        "Automatic native settings qualification currently supports bounded integer JSON controls only.",
      );
    return file.settings.filter(isRecord).map((setting) => {
      const value = setting.value;
      if (
        !isRecord(value) ||
        value.kind !== "integer" ||
        ![value.minimum, value.maximum, value.step, value.default].every(Number.isSafeInteger) ||
        Number(value.step) <= 0 ||
        Number(value.minimum) > Number(value.maximum)
      )
        throw new Error(
          "Automatic native settings qualification currently supports bounded integer JSON controls only.",
        );
      const values = [
        value.default,
        value.minimum,
        Number(value.maximum) -
          ((Number(value.maximum) - Number(value.minimum)) % Number(value.step)),
      ].filter((value, index, all) => !index || value !== all[index - 1]);
      return { file_id: file.id, setting_id: setting.id, values_tested: values.length, values };
    });
  });
}

/** The same completeness/input checks apply at production and every replayed
 * authoring projection. Shape-valid hashes alone cannot renew evidence. */
function checkQualificationProbes(
  record: AuthoredPort,
  binding: unknown,
  probe: unknown,
  consumer: unknown,
) {
  const expected = expectedProbeChecks(record);
  if (
    !isRecord(probe) ||
    probe.input_sha256 !== digest(qualificationInput(record, binding)) ||
    !sha(probe.validator_artifact_sha256) ||
    observationHash(probe.checks) !== observationHash(expected)
  )
    throw new Error("Core settings probe is incomplete or bound to different inputs.");
  if (
    !isRecord(binding) ||
    !isRecord(consumer) ||
    consumer.archive_sha256 !== binding.archive_sha256 ||
    consumer.source_commit !== binding.source_commit ||
    !sha(consumer.client_sha256) ||
    !sha(consumer.executable_sha256) ||
    !sha(consumer.evidence_sha256) ||
    !Array.isArray(consumer.observations) ||
    consumer.observations.length !== expected.length ||
    consumer.observations.some(
      (item, index) =>
        !isRecord(item) ||
        item.file_id !== expected[index]!.file_id ||
        item.setting_id !== expected[index]!.setting_id ||
        observationHash(item.requested_values) !== observationHash(expected[index]!.values) ||
        observationHash(item.observed_values) !== observationHash(expected[index]!.values),
    )
  )
    throw new Error(
      "Settings document checks passed, but exact-package native consumer evidence is missing or differs; qualify settings only after that existing native probe completes.",
    );
}

/** Relevant source identity only; this does not qualify or publish a package. */
export function settingsCandidateSource(
  record: AuthoredPort,
  binding: Omit<SettingsBinding, "evidence_urls">,
  files: readonly SettingsSourceFile[],
) {
  const policy = record.settings_qualification_v1;
  checkSettingsPolicy(policy);
  const sourceRegions = policy.regions.map((region) => {
    const matches = files.filter(
      (file) => file.repository === region.repository && file.path === region.path,
    );
    if (
      matches.length !== 1 ||
      !sha(matches[0]!.revision, 40) ||
      (!region.submodule_path && matches[0]!.revision !== binding.source_commit)
    )
      throw new Error("Settings source evidence is missing, ambiguous or bound to another source.");
    const file = matches[0]!;
    const observed = settingsSourceRegion(file.content, region);
    if (!matchesReviewedRegion(region, observed))
      throw new Error(
        `Settings ${region.role} contract changed; retain basic package availability and review settings only.`,
      );
    return {
      repository: file.repository,
      revision: file.revision,
      path: file.path,
      sha256: observed,
    };
  });
  const candidate = {
    ...binding,
    evidence_urls: [
      ...new Set(
        sourceRegions.map(
          (region) =>
            `https://github.com/${region.repository}/blob/${region.revision}/${region.path}`,
        ),
      ),
    ].slice(0, 8),
  };
  return { candidate, sourceRegions };
}

export function settingsDocumentInput(record: AuthoredPort, binding: SettingsBinding) {
  return qualificationInput(record, binding);
}

/** Produce exact generated definition data from independently verified package
 * evidence, relevant source regions and an actual Core document probe. The
 * result remains an unsigned proposal for the existing acceptance/publisher. */
export async function qualifySettingsObservation(
  record: AuthoredPort,
  binding: Omit<SettingsBinding, "evidence_urls">,
  packageReceipt: unknown,
  files: readonly SettingsSourceFile[],
  inspect: (input: Buffer) => Promise<Record<string, unknown>> | Record<string, unknown>,
  observeConsumer?: (binding: SettingsBinding, probe: Record<string, unknown>) => Promise<unknown>,
): Promise<SettingsQualificationObservation> {
  const policy = record.settings_qualification_v1;
  checkSettingsPolicy(policy);
  const settings = contract(record);
  if (
    !isRecord(packageReceipt) ||
    packageReceipt.id !== record.listing.id ||
    packageReceipt.source_revision !== binding.source_commit ||
    packageReceipt.expected_digest_matched !== true ||
    packageReceipt.observed_archive_sha256 !== binding.archive_sha256 ||
    !isRecord(packageReceipt.official_asset) ||
    packageReceipt.official_asset.digest !== `sha256:${binding.archive_sha256}` ||
    !sha(binding.source_commit, 40) ||
    !sha(binding.archive_sha256) ||
    binding.platform !== "windows-x86-64" ||
    !binding.version ||
    binding.version.length > 128
  )
    throw new Error(
      "Settings qualification requires the exact independently expected package and source.",
    );
  const { candidate, sourceRegions } = settingsCandidateSource(record, binding, files);
  const input = qualificationInput(record, candidate);
  const probe = await inspect(input);
  if (probe.format_version !== 1 || observationHash(probe.binding) !== observationHash(candidate))
    throw new Error("Core settings probe is incomplete or bound to different inputs.");
  const consumer = observeConsumer
    ? await observeConsumer(candidate, probe)
    : packageReceipt.settings_consumer;
  checkQualificationProbes(record, candidate, probe, consumer);
  if (
    !isRecord(consumer) ||
    !Array.isArray(packageReceipt.selected_executables) ||
    !packageReceipt.selected_executables.some(
      (member) => isRecord(member) && member.sha256 === consumer.executable_sha256,
    ) ||
    !sha(consumer.executable_sha256)
  )
    throw new Error(
      "Settings document checks passed, but exact-package native consumer evidence is missing or differs; qualify settings only after that existing native probe completes.",
    );
  return {
    format_version: 1,
    port_id: record.listing.id,
    policy_sha256: observationHash(policy),
    contract_sha256: observationHash({
      files: settings.files,
      persistent_paths: record.integration!.persistent_paths,
    }),
    binding: candidate,
    source_regions: sourceRegions,
    probe: {
      input_sha256: String(probe.input_sha256),
      validator_artifact_sha256: String(probe.validator_artifact_sha256),
      checks: expectedProbeChecks(record),
    },
    package_receipt_sha256: observationHash(packageReceipt),
    consumer_probe: structuredClone(consumer),
  };
}

/** Projection never edits the authored baseline or an existing installation.
 * Only new/update acceptance may retain this generated exact binding. */
export function projectSettingsQualification(record: AuthoredPort): AuthoredPort {
  const raw = record.settings_observation_v1;
  if (raw === undefined) return record;
  const policy = record.settings_qualification_v1;
  checkSettingsPolicy(policy);
  const settings = contract(record);
  if (
    !isRecord(raw) ||
    raw.format_version !== 1 ||
    raw.port_id !== record.listing.id ||
    raw.policy_sha256 !== observationHash(policy) ||
    raw.contract_sha256 !==
      observationHash({
        files: settings.files,
        persistent_paths: record.integration!.persistent_paths,
      }) ||
    !isRecord(raw.binding) ||
    !sha(raw.binding.archive_sha256) ||
    !sha(raw.binding.source_commit, 40) ||
    raw.binding.platform !== "windows-x86-64" ||
    typeof raw.binding.version !== "string" ||
    !Array.isArray(raw.binding.evidence_urls) ||
    raw.binding.evidence_urls.length < 1 ||
    raw.binding.evidence_urls.length > 8 ||
    !isRecord(raw.probe) ||
    !sha(raw.probe.validator_artifact_sha256) ||
    !sha(raw.probe.input_sha256) ||
    !isRecord(raw.consumer_probe) ||
    raw.consumer_probe.archive_sha256 !== raw.binding.archive_sha256 ||
    raw.consumer_probe.source_commit !== raw.binding.source_commit ||
    !sha(raw.consumer_probe.client_sha256) ||
    !sha(raw.consumer_probe.executable_sha256) ||
    !sha(raw.consumer_probe.evidence_sha256) ||
    !sha(raw.package_receipt_sha256) ||
    !Array.isArray(raw.source_regions) ||
    raw.source_regions.length !== policy.regions.length ||
    raw.source_regions.some(
      (source, index) =>
        !isRecord(source) ||
        !matchesReviewedRegion(policy.regions[index]!, source.sha256) ||
        source.repository !== policy.regions[index]!.repository ||
        source.path !== policy.regions[index]!.path ||
        !sha(source.revision, 40) ||
        (!policy.regions[index]!.submodule_path && source.revision !== raw.binding.source_commit),
    )
  )
    throw new Error(
      "Settings qualification no longer matches the accepted contract and policy; retain historical authority.",
    );
  const releases = settings.releases.filter(isRecord);
  const existing = releases.find(
    (release) =>
      release.version === raw.binding.version && release.platform === raw.binding.platform,
  );
  if (
    existing &&
    (existing.archive_sha256 !== raw.binding.archive_sha256 ||
      existing.source_commit !== raw.binding.source_commit)
  )
    throw new Error(
      "Settings qualification conflicts with an existing exact release; preserve historical binding.",
    );
  checkQualificationProbes(record, raw.binding, raw.probe, raw.consumer_probe);
  const projected = structuredClone(record);
  projected.integration!.game_settings = {
    ...settings,
    releases: existing ? releases : [...releases, raw.binding],
  };
  return projected;
}
