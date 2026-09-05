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
const reviewedSources = {
  ghostship: {
    evidenceId: "ghostship-2-0-0-source-contract",
    repository: "HarbourMasters/Ghostship",
    ref: "762ce4a6dff8d69b934a41a326ae41e78431e6cd",
    tag: "2.0.0",
    liveRef: "develop",
    path: "config.yml",
  },
  lighthouse: {
    evidenceId: "lighthouse-1-1-0-source-contract",
    repository: "HarbourMasters/Lighthouse",
    ref: "9c39b49574388f1656a53a518257f399b5368062",
    tag: "1.1.0",
    liveRef: "develop",
    path: "config.yml",
  },
  shipwright: {
    evidenceId: "shipwright-9-2-3-source-contract",
    repository: "HarbourMasters/Shipwright",
    ref: "cb71e22a79bc5d1f688fa881795bbd93094895fc",
    tag: "9.2.3",
    liveRef: "develop",
    path: "docs/supportedHashes.json",
  },
  twoShip: {
    evidenceId: "2ship2harkinian-5-0-1-source-contract",
    repository: "HarbourMasters/2ship2harkinian",
    ref: "8a24047fbce8915993804e7819f4df4fa591551f",
    tag: "5.0.1",
    liveRef: "develop",
    path: "docs/supportedHashes.json",
  },
  starship: {
    evidenceId: "starship-2-0-0-source-contract",
    repository: "HarbourMasters/Starship",
    ref: "cb19785b51698185a688e17ba1a34c7889195bdb",
    tag: "v2.0.0",
    liveRef: "main",
    path: "config.yml",
  },
  banjoRecomp: {
    evidenceId: "banjo-recompiled-1-0-2-source-contract",
    repository: "BanjoRecomp/BanjoRecomp",
    ref: "ec859632cfa584e2272d32e46051543429a2baf4",
    tag: "v1.0.2",
    liveRef: "main",
    path: "README.md",
  },
  zelda64Recomp: {
    evidenceId: "zelda64-recompiled-1-2-2-source-contract",
    repository: "Zelda64Recomp/Zelda64Recomp",
    ref: "54950a10408599d1d63802ee21cc2c4b05bfd378",
    tag: "v1.2.2",
    liveRef: "dev",
    path: "README.md",
  },
};

function upstreamEvidence(source, claim) {
  return {
    id: source.evidenceId,
    role: "upstream_support",
    authority: source.repository,
    authority_ref: source.ref,
    reviewed_at: "2026-09-05",
    claim,
    immutable_url: `https://github.com/${source.repository}/blob/${source.ref}/${source.path}`,
    live_url: `https://github.com/${source.repository}/blob/${source.liveRef}/${source.path}`,
  };
}

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
  upstreamEvidence(reviewedSources.ghostship, "Lists the Japanese and US Super Mario 64 sources accepted by Ghostship 2.0.0"),
  upstreamEvidence(reviewedSources.lighthouse, "Lists the US 1.0, US 1.1, PAL, and Japanese Banjo-Kazooie sources accepted by Lighthouse 1.1.0"),
  upstreamEvidence(reviewedSources.shipwright, "Lists the Ocarina of Time sources accepted by Ship of Harkinian 9.2.3"),
  upstreamEvidence(reviewedSources.twoShip, "Lists the Majora's Mask NTSC-U 1.0 and GameCube sources accepted by 2Ship2Harkinian 5.0.1"),
  upstreamEvidence(reviewedSources.starship, "Lists the compressed and decompressed US 1.0 and US 1.1 Star Fox 64 sources accepted by Starship 2.0.0"),
  upstreamEvidence(reviewedSources.banjoRecomp, "Limits Banjo: Recompiled 1.0.2 to the North American 1.0 Banjo-Kazooie source"),
  upstreamEvidence(reviewedSources.zelda64Recomp, "Limits Zelda 64: Recompiled 1.2.2 to the US Majora's Mask source"),
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

function canonicalN64Representation(id, hashes, evidenceId) {
  return {
    id,
    extensions: ["z64", "n64", "v64"],
    kind: "canonical-n64",
    identities: hashes.map(({ sha1, sha256 }) => digest(
      "canonical-n64-big-endian",
      sha1,
      sha256,
    )),
    evidence_ids: [evidenceId],
  };
}

function n64Variant(id, title, region, revision, hashes, evidenceId, representations) {
  return {
    id,
    title,
    region,
    revision,
    product_codes: [],
    representations: representations ?? [canonicalN64Representation("canonical-rom", hashes, evidenceId)],
    evidence_ids: [evidenceId],
  };
}

function applyReviewedVariants(profileId, variants) {
  const profile = identities.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error(`missing corrected profile ${profileId}`);
  const legacyVariant = profile.variants[0];
  legacyVariant.legacy_projection_only = true;
  profile.variants = [legacyVariant, ...variants];
  profile.evidence_gap = null;
}

applyReviewedVariants("ghostship-source", [
  n64Variant("super-mario-64-us", "Super Mario 64", "USA", "1.0", [{
    sha1: "9bef1128717f958171a4afac3ed78ee2bb4e86ce",
    sha256: "17ce077343c6133f8c9f2d6d6d9a4ab62c8cd2aa57c40aea1f490b4c8bb21d91",
  }], reviewedSources.ghostship.evidenceId),
  n64Variant("super-mario-64-jp", "Super Mario 64", "Japan", "1.0", [{
    sha1: "8a20a5c83d6ceb0f0506cfc9fa20d8f438cafe51",
  }], reviewedSources.ghostship.evidenceId),
]);

applyReviewedVariants("banjo-kazooie", [
  n64Variant("usa-rev0", "Banjo-Kazooie", "USA", "Rev 0", [{
    sha1: "1fe1632098865f639e22c11b9a81ee8f29c75d7a",
    sha256: "59875835b9a5128bb0054315a7f929e2071c2001e528d70bf543e1d6680e6eff",
  }], reviewedSources.lighthouse.evidenceId),
  n64Variant("usa-rev1", "Banjo-Kazooie", "USA", "Rev 1", [{
    sha1: "ded6ee166e740ad1bc810fd678a84b48e245ab80",
  }], reviewedSources.lighthouse.evidenceId),
  n64Variant("pal-rev0", "Banjo-Kazooie", "PAL", "Rev 0", [{
    sha1: "bb359a75941df74bf7290212c89fbc6e2c5601fe",
  }], reviewedSources.lighthouse.evidenceId),
  n64Variant("japan-rev0", "Banjo-Kazooie", "Japan", "Rev 0", [{
    sha1: "90726d7e7cd5bf6cdfd38f45c9acbf4d45bd9fd8",
  }], reviewedSources.lighthouse.evidenceId),
]);

const shipwrightHashes = [
  ["pal-1-0", "PAL 1.0", "PAL", "1.0", "328a1f1beba30ce5e178f031662019eb32c5f3b5"],
  ["pal-1-1", "PAL 1.1", "PAL", "1.1", "cfbb98d392e4a9d39da8285d10cbef3974c2f012"],
  ["pal-gamecube", "PAL GameCube", "PAL", "GameCube", "0227d7c0074f2d0ac935631990da8ec5914597b4"],
  ["pal-master-quest", "PAL Master Quest", "PAL", "Master Quest", "f46239439f59a2a594ef83cf68ef65043b1bffe2"],
  ["pal-gamecube-debug", "PAL GameCube Debug", "PAL", "GameCube Debug", "cee6bc3c2a634b41728f2af8da54d9bf8cc14099"],
  ["pal-master-quest-debug-1", "PAL Master Quest Debug", "PAL", "Master Quest Debug 1", "079b855b943d6ad8bd1eb026c0ed169ecbdac7da"],
  ["pal-master-quest-debug-2", "PAL Master Quest Debug", "PAL", "Master Quest Debug 2", "50bebedad9e0f10746a52b07239e47fa6c284d03"],
  ["pal-master-quest-debug-3", "PAL Master Quest Debug", "PAL", "Master Quest Debug 3", "cfecfdc58d650e71a200c81f033de4e6d617a9f6"],
  ["usa-1-0", "NTSC 1.0 (US)", "USA", "1.0", "ad69c91157f6705e8ab06c79fe08aad47bb57ba7"],
  ["usa-1-1", "NTSC 1.1 (US)", "USA", "1.1", "d3ecb253776cd847a5aa63d859d8c89a2f37b364"],
  ["usa-1-2", "NTSC 1.2 (US)", "USA", "1.2", "41b3bdc48d98c48529219919015a1af22f5057c2"],
  ["japan-1-0", "NTSC 1.0 (JP)", "Japan", "1.0", "c892bbda3993e66bd0d56a10ecd30b1ee612210f"],
  ["japan-1-1", "NTSC 1.1 (JP)", "Japan", "1.1", "dbfc81f655187dc6fefd93fa6798face770d579d"],
  ["japan-1-2", "NTSC 1.2 (JP)", "Japan", "1.2", "fa5f5942b27480d60243c2d52c0e93e26b9e6b86"],
  ["usa-gamecube", "NTSC GameCube (US)", "USA", "GameCube", "b82710ba2bd3b4c6ee8aa1a7e9acf787dfc72e9b"],
  ["usa-master-quest", "NTSC Master Quest (US)", "USA", "Master Quest", "8b5d13aac69bfbf989861cfdc50b1d840945fc1d"],
  ["japan-gamecube", "NTSC GameCube (JP)", "Japan", "GameCube", "0769c84615422d60f16925cd859593cdfa597f84"],
  ["japan-gamecube-collectors", "NTSC GameCube (JP) Collector's Edition", "Japan", "GameCube Collector's Edition", "2ce2d1a9f0534c9cd9fa04ea5317b80da21e5e73"],
  ["japan-master-quest", "NTSC Master Quest (JP)", "Japan", "Master Quest", "dd14e143c4275861fe93ea79d0c02e36ae8c6c2f"],
];
applyReviewedVariants("ocarina-of-time", shipwrightHashes.map(([id, title, region, revision, sha1]) =>
  n64Variant(id, title, region, revision, [{ sha1 }], reviewedSources.shipwright.evidenceId)));

applyReviewedVariants("majoras-mask", [
  n64Variant("ntsc-u-1-0", "The Legend of Zelda: Majora's Mask", "USA", "1.0", [{
    sha1: "d6133ace5afaa0882cf214cf88daba39e266c078",
  }], reviewedSources.twoShip.evidenceId),
  n64Variant("ntsc-u-gamecube", "The Legend of Zelda: Majora's Mask", "USA", "GameCube", [{
    sha1: "9743aa026e9269b339eb0e3044cd5830a440c1fd",
  }], reviewedSources.twoShip.evidenceId),
]);

applyReviewedVariants("star-fox-64", [
  n64Variant("usa-1-0", "Star Fox 64", "USA", "1.0", [], reviewedSources.starship.evidenceId, [
    canonicalN64Representation("compressed-rom", [{ sha1: "d8b1088520f7c5f81433292a9258c1184afa1457" }], reviewedSources.starship.evidenceId),
    canonicalN64Representation("decompressed-rom", [{ sha1: "63b69f0ef36306257481afc250f9bc304c7162b2" }], reviewedSources.starship.evidenceId),
  ]),
  n64Variant("usa-1-1", "Star Fox 64", "USA", "1.1", [], reviewedSources.starship.evidenceId, [
    canonicalN64Representation("compressed-rom", [{ sha1: "09f0d105f476b00efa5303a3ebc42e60a7753b7a" }], reviewedSources.starship.evidenceId),
    canonicalN64Representation("decompressed-rom", [{ sha1: "f7475fb11e7e6830f82883412638e8390791ab87" }], reviewedSources.starship.evidenceId),
  ]),
]);

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

function reviewContract(portId, source, supportedVariantIds, extraEvidenceIds = []) {
  const contract = contracts.find(candidate => candidate.port_id === portId && candidate.role === "game");
  if (!contract) throw new Error(`missing corrected contract for ${portId}`);
  contract.supported_variant_ids = supportedVariantIds;
  contract.evidence_ids = [...new Set([source.evidenceId, ...extraEvidenceIds])];
  contract.authority_ref = source.ref;
  contract.reviewed_at = "2026-09-05";
  contract.immutable_review_url = `https://github.com/${source.repository}/blob/${source.ref}/${source.path}`;
  contract.live_review_url = `https://github.com/${source.repository}/blob/${source.liveRef}/${source.path}`;
  contract.applicability = [{ upstream_ref: source.tag, artifact_sha256: null }];
}

reviewContract("ghostship", reviewedSources.ghostship, [
  "super-mario-64-us",
  "super-mario-64-jp",
]);
reviewContract("lighthouse", reviewedSources.lighthouse, [
  "usa-rev0",
  "usa-rev1",
  "pal-rev0",
  "japan-rev0",
]);
reviewContract(
  "banjo-recomp",
  reviewedSources.banjoRecomp,
  ["usa-rev0"],
  [reviewedSources.lighthouse.evidenceId],
);
reviewContract(
  "shipwright",
  reviewedSources.shipwright,
  shipwrightHashes.map(([id]) => id),
);
reviewContract("2ship2harkinian", reviewedSources.twoShip, [
  "ntsc-u-1-0",
  "ntsc-u-gamecube",
]);
reviewContract(
  "zelda64-recomp",
  reviewedSources.zelda64Recomp,
  ["ntsc-u-1-0"],
  [reviewedSources.twoShip.evidenceId],
);
reviewContract("starship", reviewedSources.starship, ["usa-1-0", "usa-1-1"]);

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
