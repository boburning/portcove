import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, "crates", "portcove-core", "catalog", "catalog.json");
const fixturePath = join(root, "crates", "portcove-core", "catalog", "catalog-schema1-fixture.json");
const legacy = JSON.parse(readFileSync(fixturePath, "utf8"));
if (legacy.schema_version !== 1) throw new Error("schema-1 fixture is not schema 1");

const portcoveEvidence = "alpha1-schema1-source-contracts";
const portcoveRef = "9d16cf7085ad34b995bbdc2a5763beb67c7e1190";
const portcoveUrl = `https://github.com/boburning/portcove/blob/${portcoveRef}/crates/portcove-core/catalog/catalog.json`;
const bombermanEvidence = "bomberman-party-edition-disc-contract";
const bombermanRef = "0aef0b66186b3f8f29d1bd9a3ba15b6307739c7b";

const evidence = [
  {
    id: portcoveEvidence,
    role: "byte_identity",
    authority: "Portcove Alpha 1 source catalog",
    authority_ref: portcoveRef,
    reviewed_at: "2026-09-05",
    claim: "Frozen schema-1 source admission contract used for equivalence migration",
    immutable_url: portcoveUrl,
  },
  {
    id: bombermanEvidence,
    role: "upstream_support",
    authority: "BombermanPartyEditionRecomp",
    authority_ref: bombermanRef,
    reviewed_at: "2026-09-05",
    claim: "Distinguishes the supported raw MODE2/2352 disc image from its cooked 2048-byte ISO representation",
    immutable_url: `https://github.com/TechnicallyComputers/BombermanPartyEditionRecomp/blob/${bombermanRef}/DISC.md`,
    live_url: "https://github.com/TechnicallyComputers/BombermanPartyEditionRecomp/blob/main/DISC.md",
  },
];

function digest(scope, sha1, sha256, crc32) {
  return { scope, sha1: sha1 ?? null, sha256: sha256 ?? null, crc32: crc32 ?? null };
}

function legacyIdentities(profile, scope) {
  const sha1 = profile.accepted_sha1 ?? [];
  const sha256 = profile.accepted_sha256 ?? [];
  if (sha1.length === 1 && sha256.length === 1) return [digest(scope, sha1[0], sha256[0])];
  if (sha1.length && sha256.length) {
    if (profile.id !== "bomberman-party-edition-psx") {
      throw new Error(`cannot infer legacy digest pairing for ${profile.id}`);
    }
    return [digest(scope, sha1[0], sha256[0]), digest(scope, sha1[1])];
  }
  return [
    ...sha1.map(value => digest(scope, value)),
    ...sha256.map(value => digest(scope, undefined, value)),
  ];
}

function memberIdentities(member) {
  const sha1 = member.accepted_sha1 ?? [];
  const sha256 = member.accepted_sha256 ?? [];
  const crc32 = member.accepted_crc32 ?? [];
  if (sha1.length <= 1 && sha256.length <= 1 && crc32.length <= 1) {
    return [digest("file-set-member", sha1[0], sha256[0], crc32[0])];
  }
  if ((sha1.length > 0) + (sha256.length > 0) + (crc32.length > 0) > 1) {
    throw new Error(`cannot infer file-set digest pairing for ${member.id}`);
  }
  return [
    ...sha1.map(value => digest("file-set-member", value)),
    ...sha256.map(value => digest("file-set-member", undefined, value)),
    ...crc32.map(value => digest("file-set-member", undefined, undefined, value)),
  ];
}

function representation(profile) {
  const extensions = (profile.accepted_extensions ?? []).map(value => value.toLowerCase());
  if (profile.kind === "file-set") {
    return {
      id: "file-set",
      extensions,
      kind: "file-set",
      members: profile.members.map(member => ({
        id: member.id,
        label: member.label,
        filenames: member.accepted_filenames,
        identities: memberIdentities(member),
      })),
      evidence_ids: [portcoveEvidence],
    };
  }
  if (profile.kind === "gamecube-disc") {
    return {
      id: "normalized-gamecube-iso",
      extensions,
      kind: "gamecube-normalized-iso",
      identities: legacyIdentities(profile, "gamecube-normalized-iso"),
      evidence_ids: [portcoveEvidence],
    };
  }
  if (profile.kind === "psx-disc") {
    const discs = profile.disc?.discs ?? [];
    if (discs.length) {
      return {
        id: "disc-set",
        extensions,
        kind: "multi-disc-set",
        discs: discs.map((disc, index) => ({
          id: `disc-${index + 1}`,
          label: disc.label,
          track_counts: disc.track_counts,
          volume_ids: disc.accepted_volume_ids ?? [],
          identities: legacyIdentities(disc, "disc-set-member"),
        })),
        evidence_ids: [portcoveEvidence],
      };
    }
    return {
      id: "normalized-track-set",
      extensions,
      kind: "optical-track-set",
      track_counts: profile.disc.track_counts,
      identities: legacyIdentities(profile, "psx-normalized-track-set"),
      evidence_ids: profile.id === "bomberman-party-edition-psx"
        ? [portcoveEvidence, bombermanEvidence]
        : [portcoveEvidence],
    };
  }
  if (profile.kind === "upstream-validated-disc") {
    return {
      id: "pinned-upstream-validator",
      extensions,
      kind: "pinned-validator",
      validator_contract_id: `${profile.id}-validator-v1`,
      evidence_ids: [portcoveEvidence],
    };
  }
  const identities = legacyIdentities(
    profile,
    extensions.some(value => ["z64", "n64", "v64"].includes(value))
      ? "canonical-n64-big-endian"
      : "normalized-content",
  );
  if (!identities.length) {
    return {
      id: "informational-extension",
      extensions,
      kind: "informational-extension",
      evidence_gap: "Schema 1 admits this source by extension and structural checks without deterministic identity evidence.",
      evidence_ids: [portcoveEvidence],
    };
  }
  if (profile.id === "sotn-xbla") {
    return {
      id: "stfs-live-package",
      extensions,
      kind: "compound",
      format: "stfs-live",
      identities,
      evidence_ids: [portcoveEvidence],
    };
  }
  return {
    id: "normalized-source",
    extensions,
    kind: extensions.some(value => ["z64", "n64", "v64"].includes(value))
      ? "canonical-n64"
      : "raw-file",
    identities,
    evidence_ids: [portcoveEvidence],
  };
}

const identities = legacy.source_profiles.map(profile => {
  const rep = representation(profile);
  const informational = rep.kind === "informational-extension";
  return {
    id: profile.id,
    label: profile.label,
    kind: profile.kind === "file-set" ? "file-set"
      : profile.kind === "gamecube-disc" || profile.kind === "psx-disc" || profile.kind === "upstream-validated-disc" ? "optical-disc"
      : profile.id === "sotn-xbla" ? "compound" : "file",
    variants: [{
      id: "legacy-accepted",
      title: profile.label,
      region: null,
      revision: null,
      product_codes: [],
      representations: [rep],
      evidence_ids: profile.id === "bomberman-party-edition-psx"
        ? [portcoveEvidence, bombermanEvidence]
        : [portcoveEvidence],
    }],
    aliases: [],
    tombstones: [],
    evidence_gap: informational ? rep.evidence_gap : null,
  };
});

const validators = legacy.source_profiles
  .filter(profile => profile.kind === "upstream-validated-disc")
  .map(profile => ({
    id: `${profile.id}-validator-v1`,
    tool_id: "opengoal-launcher",
    protocol_version: "schema1-upstream-validator",
    evidence_ids: [portcoveEvidence],
  }));

const profiles = new Map(identities.map(profile => [profile.id, profile]));
const contracts = [];
for (const port of legacy.ports) {
  for (const [role, field] of [["game", "source_profile"], ["bios", "bios_source_profile"]]) {
    const profileId = port[field];
    if (!profileId) continue;
    const profile = profiles.get(profileId);
    if (!profile) throw new Error(`${port.id} references missing ${profileId}`);
    const rep = profile.variants[0].representations[0];
    const informational = rep.kind === "informational-extension";
    const validator = rep.kind === "pinned-validator" ? rep.validator_contract_id : null;
    contracts.push({
      id: `${port.id}-${role}-source`,
      port_id: port.id,
      role,
      profile_id: profileId,
      admission_mode: informational ? "informational" : "enforced",
      supported_variant_ids: informational || validator ? [] : ["legacy-accepted"],
      validator_contract_id: validator,
      evidence_ids: profileId === "bomberman-party-edition-psx"
        ? [portcoveEvidence, bombermanEvidence]
        : [portcoveEvidence],
      authority_ref: portcoveRef,
      reviewed_at: "2026-09-05",
      immutable_review_url: portcoveUrl,
      live_review_url: null,
      evidence_gap: informational ? rep.evidence_gap : null,
      applicability: [],
      aliases: [],
      tombstones: [],
    });
  }
}

const migrated = {
  schema_version: 2,
  source_catalog: { evidence, identities, contracts, validators },
  ports: legacy.ports,
};
const output = `${JSON.stringify(migrated, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(catalogPath, "utf8") !== output) {
    throw new Error("catalog schema-2 output is stale; run node scripts/migrate-catalog-schema2.mjs");
  }
} else {
  writeFileSync(catalogPath, output);
}
