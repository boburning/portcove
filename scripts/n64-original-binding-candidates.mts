import reviewedPackagedInputs from "./n64-reviewed-packaged-inputs.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";
import { orderedJsonSha256 } from "./json-values.mts";
import type { OriginalSourceProgress } from "./upstream-original-recognition.mts";

// The checked upstream xxh3.h wrapper and inline implementation used by the
// supported runtime family. Match their bytes, independent of the title or tag.
const reviewedHeaders = [
  ["xxh3.h", "a927ee0e6e0800835baed52b16bc981ec39f46287271a1a3f77c22cc48634430"],
  ["xxhash.h", "ccc7934d982bfd4f51624e7fdd93a6c40bc3d5c33f66463b54e70c21932d9129"],
] as const;

interface BindingCandidate {
  upstream_ref: string;
  artifact_sha256: string;
  game_id: string;
  rom_xxh3_64: string;
}

interface ArtifactCandidate {
  platform: string;
  artifact_sha256: string;
  state:
    | "awaiting-effective-build-proof"
    | "legacy-contract-migration-required"
    | "unsupported-source-contract"
    | "unsupported-runtime-hash"
    | "awaiting-runtime-evidence"
    | "unbound-native-game"
    | "awaiting-build"
    | "unbound-executable";
  proposed_input?: BindingCandidate;
  build_job_id?: number;
}

export function n64AuthoringScope(port: unknown, sourceCatalog: unknown) {
  if (
    !isRecord(port) ||
    port.adapter !== "n64-recomp-portable" ||
    typeof port.id !== "string" ||
    typeof port.source_profile !== "string" ||
    !isRecord(sourceCatalog) ||
    !Array.isArray(sourceCatalog.contracts) ||
    !Array.isArray(sourceCatalog.identities)
  )
    return;
  return orderedJsonSha256({
    port,
    contracts: (sourceCatalog.contracts as unknown[]).filter(
      (contract) => isRecord(contract) && contract.port_id === port.id,
    ),
    identities: (sourceCatalog.identities as unknown[]).filter(
      (profile) => isRecord(profile) && profile.id === port.source_profile,
    ),
  });
}

/** Derive the Core binding shape from existing observer facts. Placement in a
 * definition still belongs to catalog authoring and protected delivery. */
export function planN64OriginalBindings(
  port: unknown,
  sourceCatalog: unknown,
  evidence: OriginalSourceProgress,
) {
  const fact = evidence.last_complete?.fact;
  const scope = n64AuthoringScope(port, sourceCatalog);
  if (
    evidence.state !== "observed" ||
    !scope ||
    fact?.parser !== "n64-recomp-game-entry-v1" ||
    fact.authoring_scope_sha256 !== scope ||
    !isRecord(port) ||
    typeof port.id !== "string" ||
    port.adapter !== "n64-recomp-portable" ||
    !isRecord(port.release) ||
    port.release.repository !== fact.repository ||
    typeof port.source_profile !== "string"
  )
    return;

  const filename =
    typeof port.runtime_source_filename === "string"
      ? port.runtime_source_filename.split("/").at(-1)
      : undefined;
  const sameGame = fact.games.filter((game) => filename === game.game_id + ".z64");
  const game = sameGame.length === 1 ? sameGame[0] : undefined;
  const runtime =
    fact.runtime_source?.state === "observed" ? fact.runtime_source.source : undefined;
  const dependency = runtime?.hash_source?.state === "observed" ? runtime.hash_source : undefined;
  const hashSupported =
    runtime?.matched_input_blocks &&
    dependency &&
    dependency.headers.length === reviewedHeaders.length &&
    reviewedHeaders.every(
      ([path, sha], index) =>
        dependency.headers[index]?.source_path === path &&
        dependency.headers[index]?.source_sha256 === sha,
    );

  let contractState: ArtifactCandidate["state"] | undefined = "unsupported-source-contract";
  if (
    isRecord(sourceCatalog) &&
    Array.isArray(sourceCatalog.contracts) &&
    Array.isArray(sourceCatalog.identities)
  ) {
    const contracts = (sourceCatalog.contracts as unknown[]).filter(
      (contract) =>
        isRecord(contract) &&
        contract.port_id === port.id &&
        contract.role === "game" &&
        contract.profile_id === port.source_profile,
    );
    const profiles = (sourceCatalog.identities as unknown[]).filter(
      (profile) => isRecord(profile) && profile.id === port.source_profile,
    );
    const contract = contracts[0];
    if (
      contracts.length === 1 &&
      isRecord(contract) &&
      (contract.validator_contract_id === null || contract.validator_contract_id === undefined) &&
      profiles.length === 1 &&
      isRecord(profiles[0]) &&
      profiles[0].kind === "file"
    ) {
      if (contract.admission_mode === "enforced") {
        contractState =
          Array.isArray(contract.n64_recomp_inputs_v1) && contract.n64_recomp_inputs_v1.length > 0
            ? undefined
            : "legacy-contract-migration-required";
      } else if (
        contract.admission_mode === "informational" &&
        Array.isArray(contract.supported_variant_ids) &&
        (contract.supported_variant_ids.length === 0 ||
          contract.variant_list_recognition_only === true)
      )
        contractState = undefined;
    }
  }

  const platforms: (ArtifactCandidate | { platform: string; state: "no-current-artifact" })[] = [];
  for (const { platform, sha256 } of fact.artifacts) {
    const identity = { platform, artifact_sha256: sha256 };
    if (!game) {
      platforms.push({ ...identity, state: "unbound-native-game" });
      continue;
    }
    if (!hashSupported) {
      platforms.push({
        ...identity,
        state: dependency ? "unsupported-runtime-hash" : "awaiting-runtime-evidence",
      });
      continue;
    }
    const job = fact.build_jobs?.matches.find((match) => match.artifact_sha256 === sha256);
    if (!job?.compile) {
      platforms.push({ ...identity, state: "awaiting-build" });
      continue;
    }
    const hints = isRecord(port.executable_hints) ? port.executable_hints[platform] : undefined;
    if (!Array.isArray(hints) || !hints.includes(job.compile.executable)) {
      platforms.push({ ...identity, state: "unbound-executable" });
      continue;
    }
    const binding = {
      upstream_ref: fact.release_tag,
      artifact_sha256: sha256,
      game_id: game.game_id,
      rom_xxh3_64: game.rom_hash_u64,
    };
    platforms.push({
      ...identity,
      state: contractState ?? "awaiting-effective-build-proof",
      build_job_id: job.job_id,
      proposed_input: binding,
    });
  }
  const selectedPlatforms = new Set(fact.artifacts.map(({ platform }) => platform));
  if (Array.isArray(port.platforms)) {
    for (const platform of new Set(port.platforms as unknown[])) {
      if (typeof platform === "string" && !selectedPlatforms.has(platform))
        platforms.push({ platform, state: "no-current-artifact" });
    }
  }
  platforms.sort((left, right) => left.platform.localeCompare(right.platform));
  return {
    format_version: 1,
    port_id: port.id,
    authority: "authoring-input-only",
    repository_id: fact.repository_id,
    release_id: fact.release_id,
    source_commit: fact.source_commit,
    source_blob_sha1: fact.source_blob_sha1,
    platforms,
  } as const;
}

// A reviewed binary receipt ties the matching native entry and checked code
// paths to the deployed image, including individual universal-package slices.
type ReviewedPackagedInput = (typeof reviewedPackagedInputs.receipts)[number];

export function prepareN64OriginalContractAmendment(
  port: unknown,
  sourceCatalog: unknown,
  evidence: OriginalSourceProgress,
  receipts: readonly ReviewedPackagedInput[] = reviewedPackagedInputs.receipts,
) {
  const plan = planN64OriginalBindings(port, sourceCatalog, evidence);
  const complete = evidence.last_complete;
  const fact = complete?.fact;
  if (
    !complete ||
    !plan ||
    fact?.parser !== "n64-recomp-game-entry-v1" ||
    !isRecord(port) ||
    !isRecord(sourceCatalog) ||
    !Array.isArray(sourceCatalog.contracts) ||
    !Array.isArray(sourceCatalog.identities) ||
    !Array.isArray(sourceCatalog.evidence) ||
    fact.runtime_source?.state !== "observed" ||
    fact.runtime_source.source.hash_source?.state !== "observed"
  )
    return;

  const contract = (sourceCatalog.contracts as unknown[]).find(
    (entry) =>
      isRecord(entry) &&
      entry.port_id === port.id &&
      entry.role === "game" &&
      entry.profile_id === port.source_profile,
  );
  if (!isRecord(contract) || typeof contract.id !== "string") return;
  if (contract.admission_mode === "enforced") {
    const profile = (sourceCatalog.identities as unknown[]).find(
      (entry) => isRecord(entry) && entry.id === contract.profile_id,
    );
    if (
      !isRecord(profile) ||
      !Array.isArray(profile.variants) ||
      !(profile.variants as unknown[]).every(
        (variant) =>
          isRecord(variant) &&
          Array.isArray(variant.representations) &&
          (variant.representations as unknown[]).every(
            (representation) => isRecord(representation) && representation.kind === "canonical-n64",
          ),
      )
    )
      return;
  }

  const runtime = fact.runtime_source.source;
  const hashSource = runtime.hash_source;
  if (hashSource?.state !== "observed") return;
  const inputRows = plan.platforms.flatMap((row) => {
    if (
      !("proposed_input" in row) ||
      !row.proposed_input ||
      !["awaiting-effective-build-proof", "legacy-contract-migration-required"].includes(row.state)
    )
      return [];
    const input = row.proposed_input;
    const job = fact.build_jobs?.matches.find(
      (match) =>
        match.job_id === row.build_job_id && match.artifact_sha256 === input.artifact_sha256,
    );
    if (!job?.compile) return [];
    const matches = receipts.flatMap((receipt) => {
      if (
        receipt.repository_id !== fact.repository_id ||
        receipt.release_id !== fact.release_id ||
        receipt.source_commit !== fact.source_commit ||
        receipt.source_blob_sha1 !== fact.source_blob_sha1 ||
        receipt.runtime_revision !== runtime.revision ||
        receipt.hash_revision !== hashSource.revision ||
        receipt.game_id !== input.game_id ||
        receipt.rom_xxh3_64 !== input.rom_xxh3_64
      )
        return [];
      return receipt.packages
        .filter(
          (entry) =>
            entry.platform === row.platform &&
            entry.artifact_sha256 === input.artifact_sha256 &&
            entry.job_id === job.job_id &&
            entry.compile_sha256 === job.compile?.log_sha256 &&
            /^[a-f0-9]{64}$/u.test(entry.executable_sha256),
        )
        .map((entry) => ({
          ...entry,
          review_url: receipt.review_url,
          reviewed_at: receipt.reviewed_at,
        }));
    });
    return matches.length === 1 ? [{ input, proof: matches[0]! }] : [];
  });

  // Core keys a binding by release and artifact. For shared packages every
  // selected architecture must have proof before the binding can apply.
  const unprovedArtifacts = new Set(
    fact.artifacts
      .filter(({ platform }) => !inputRows.some(({ proof }) => proof.platform === platform))
      .map(({ sha256 }) => sha256),
  );
  const admittedRows = inputRows.filter(
    ({ input }) => !unprovedArtifacts.has(input.artifact_sha256),
  );
  const existing = contract.n64_recomp_inputs_v1 ?? [];
  if (!Array.isArray(existing) || !admittedRows.length) return;
  const bindings = new Map<string, unknown>();
  for (const entry of existing as unknown[]) {
    if (!isRecord(entry)) return;
    bindings.set(orderedJsonSha256([entry.upstream_ref, entry.artifact_sha256]), entry);
  }
  const originalCount = bindings.size;
  for (const { input } of admittedRows) {
    const key = orderedJsonSha256([input.upstream_ref, input.artifact_sha256]);
    const previous = bindings.get(key);
    if (previous && orderedJsonSha256(previous) !== orderedJsonSha256(input)) return;
    bindings.set(key, input);
  }
  if (bindings.size === originalCount || bindings.size > 64) return;
  return {
    format_version: 1,
    authority: "authoring-input-only",
    contract_id: contract.id,
    authoring_scope_sha256: fact.authoring_scope_sha256,
    requires_reader: contract.admission_mode === "enforced" ? 11 : 10,
    packages: admittedRows.map(({ proof }) => proof),
    upstream_support_evidence: {
      id: "n64-input-" + fact.repository_id + "-" + fact.release_id + "-" + fact.source_commit,
      role: "upstream_support",
      authority: fact.repository,
      authority_ref: fact.source_commit,
      reviewed_at: admittedRows[0]!.proof.reviewed_at,
      claim:
        "Declares the native game ID and normalized original-file digest for the selected release.",
      immutable_url:
        "https://github.com/" +
        fact.repository +
        "/blob/" +
        fact.source_commit +
        "/" +
        fact.source_path,
    },
    n64_recomp_inputs_v1: [...bindings.values()],
  } as const;
}
