import { isRecord } from "./runtime-values.mts";
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

interface PlatformCandidate {
  platform: string;
  artifact_sha256: string;
  state:
    | "candidate"
    | "legacy-contract-migration-required"
    | "unsupported-source-contract"
    | "unsupported-runtime-hash"
    | "awaiting-runtime-evidence"
    | "unbound-native-game"
    | "awaiting-build"
    | "unbound-executable";
  binding?: BindingCandidate;
  build_job_id?: number;
}

/** Derive the Core binding shape from existing observer facts. Placement in a
 * definition still belongs to catalog authoring and protected delivery. */
export function planN64OriginalBindings(
  port: unknown,
  sourceCatalog: unknown,
  evidence: OriginalSourceProgress,
) {
  const fact = evidence.last_complete?.fact;
  if (
    evidence.state !== "observed" ||
    fact?.parser !== "n64-recomp-game-entry-v1" ||
    !isRecord(port) ||
    typeof port.id !== "string" ||
    port.adapter !== "n64-recomp-portable" ||
    !isRecord(port.release) ||
    port.release.repository !== fact.repository ||
    typeof port.source_profile !== "string"
  )
    return;

  const filename = port.runtime_source_filename;
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

  let contractState: PlatformCandidate["state"] | undefined = "unsupported-source-contract";
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
      profiles.length === 1 &&
      isRecord(profiles[0]) &&
      profiles[0].kind === "file"
    ) {
      if (contract.admission_mode === "enforced")
        contractState = "legacy-contract-migration-required";
      else if (
        contract.admission_mode === "informational" &&
        (contract.validator_contract_id === null || contract.validator_contract_id === undefined) &&
        Array.isArray(contract.supported_variant_ids) &&
        (contract.supported_variant_ids.length === 0 ||
          contract.variant_list_recognition_only === true)
      )
        contractState = undefined;
    }
  }

  const platforms: PlatformCandidate[] = [];
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
    platforms.push({
      ...identity,
      state: contractState ?? "candidate",
      build_job_id: job.job_id,
      binding: {
        upstream_ref: fact.release_tag,
        artifact_sha256: sha256,
        game_id: game.game_id,
        rom_xxh3_64: game.rom_hash_u64,
      },
    });
  }
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
