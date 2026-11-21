// One-shot, deterministic migration of the two untyped acquisition holds to
// typed restrictions (#8538). Every row is re-expressed at the scope and
// operation set Core enforces today: explanations are carried verbatim and no
// hold is narrowed, cleared or reworded. Reason codes are descriptive data from
// the reviewed per-row classification below; they never change a decision.
//
// Usage: node scripts/migrate-acquisition-restrictions.mts [--check]
// Then format the written port files with the repository formatter.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkAcquisitionRestrictions,
  replaceKey,
  restrictionsFromManagedHold,
} from "./catalog-acquisition-restrictions.mts";
import type {
  AcquisitionRestriction,
  LegacyManagedHold,
} from "./catalog-acquisition-restrictions.mts";
import { isRecord } from "./runtime-values.mts";

type Carrier = "listing" | "integration";

/** [port id, carrier, reason code, tracking issue] from the reviewed classification. */
const reviewedRows: readonly (readonly [string, Carrier, string, number | null])[] = [
  ["abuse-abuse-2025", "listing", "bundled-game-data", 2913],
  ["ace-of-spades-openspades", "listing", "legacy-rights-review", 5755],
  ["ambermoon-ambermoon-net", "listing", "bundled-game-data", 2625],
  ["armagetron-advanced", "listing", "upstream-owned-route", 6458],
  ["banjo-kazooie-nuts-bolts-renut", "listing", "package-facts-unresolved", 161],
  ["bips-blips", "listing", "bundled-game-data", 6132],
  ["blizz127-parasite-eve-decomp-port", "listing", "legacy-rights-review", 1865],
  ["blizz127-xenogears-decomp-port", "listing", "bundled-game-data", 1909],
  ["brawl-recompiled", "listing", "bundled-game-data", 2434],
  ["btfighter-super-mario-world-remastered-plus", "listing", "bundled-game-data", 2841],
  ["buzz-aldrins-race-into-space-native", "listing", "bundled-game-data", 6133],
  ["c-dogs-sdl", "listing", "bundled-game-data", 6048],
  ["c7-game-openciv3", "listing", "third-party-component-terms", 1850],
  ["call-to-power-ii-apolyton-edition", "listing", "bundled-game-data", 6125],
  ["cannonball-dx-outrun", "listing", "bundled-game-data", 1132],
  ["cannonball-outrun", "listing", "package-facts-unresolved", 120],
  ["captain-claw-pjasicek-openclaw", "listing", "bundled-game-data", 5913],
  ["cave-story-nxengine-evo", "listing", "bundled-game-data", 2647],
  ["cbfd-recompiled-sciaschi", "listing", "bundled-game-data", 1216],
  ["chameleon-twist-recompiled", "listing", "bundled-game-data", 125],
  ["colobot", "listing", "upstream-owned-route", 6526],
  ["commander-keen-4-omnispeak", "listing", "bundled-game-data", 2648],
  ["condemned-2-bloodshot-condemned2recomp", "listing", "bundled-game-data", 361],
  ["conker64-recompiled", "listing", "no-useful-route", 123],
  ["crazyriddler-finesthourremastered", "listing", "bundled-game-data", 2785],
  ["crownpark-xbox360-native-ports-collection", "listing", "bundled-game-data", 6005],
  ["dante-s-inferno-hells-gate-recomp", "listing", "bundled-game-data", 367],
  ["ddnet", "listing", "upstream-owned-route", 6435],
  ["dead-rising-2-case-west-recomp", "listing", "bundled-game-data", 1122],
  ["dead-rising-2-case-zero-recomp", "listing", "bundled-game-data", 1121],
  ["deadly-premonition-dprecomp", "listing", "bundled-game-data", 812],
  [
    "destinity13-timesplitters-2-ps2-slus20314-native-linux",
    "listing",
    "upstream-owned-route",
    4759,
  ],
  ["digger-remastered", "listing", "package-facts-unresolved", 6740],
  ["dirt-dash-namco22", "listing", "bundled-game-data", 1568],
  ["djultra64-blocksphere", "integration", "upstream-transition-unreviewed", 1802],
  ["djultra64-clayfighter64", "listing", "package-facts-unresolved", 2830],
  ["doom-doom-retro", "listing", "package-facts-unresolved", 5664],
  ["doom-dsda-doom", "listing", "third-party-component-terms", 5665],
  ["doom-odamex", "listing", "package-facts-unresolved", 5669],
  ["doom-the-eternity-engine", "listing", "bundled-game-data", 5689],
  ["dune-ii-henricj-dune-legacy", "listing", "bundled-game-data", 5909],
  ["dungeon-keeper-keeperfx-tux-edition", "listing", "upstream-owned-route", 6110],
  ["dungeon-siege-joshspeakman-macos", "listing", "upstream-owned-route", 6104],
  ["egg-of-time-chrono-trigger-nds", "listing", "upstream-owned-route", 3740],
  ["elmasas-lcs-recomp", "listing", "legacy-rights-review", 1836],
  ["empire-earth-gold-apple-silicon", "listing", "upstream-owned-route", 6117],
  ["espn-nfl-2k5-remade", "listing", "package-facts-unresolved", 6003],
  [
    "eternal-darkness-sanity-s-requiem-eternal-darkness-recomp",
    "listing",
    "legacy-rights-review",
    2570,
  ],
  ["extreme-tux-racer", "listing", "upstream-owned-route", 6474],
  ["f-zero-snes-recomp", "integration", "upstream-transition-unreviewed", 1114],
  ["fatal-frame-mikupan", "listing", "bundled-game-data", 346],
  ["final-fantasy-tactics-finfantacrecomp", "listing", "legacy-rights-review", 327],
  ["freeciv", "listing", "upstream-owned-route", 6502],
  ["freecol", "listing", "upstream-owned-route", 6520],
  ["gh3-segovia-no-macos-recomp", "listing", "upstream-owned-route", 6106],
  ["gnu-freedink", "listing", "upstream-owned-route", 6536],
  ["go-go-ackman-go-go-ackman-recompiled", "listing", "package-facts-unresolved", 2881],
  ["goldeneye-007-xbla-recomp", "listing", "no-useful-route", 163],
  ["grand-theft-auto-san-andreas-unity", "listing", "bundled-game-data", 6134],
  [
    "granturismo2recomp-vulob1-gran-turismo-2-arcade-mode-v1-0",
    "listing",
    "package-facts-unresolved",
    3480,
  ],
  [
    "granturismo2simrecomp-vulob1-gran-turismo-2-simulation-mode-v1-0",
    "listing",
    "package-facts-unresolved",
    3479,
  ],
  ["gta-iii-re3", "listing", "package-facts-unresolved", 2852],
  ["gta-vice-city-revc", "listing", "package-facts-unresolved", 2853],
  [
    "guitar-hero-classic-noahbaxter-guitar-hero-ii-plus-classic-harmonix-song-imports",
    "listing",
    "package-facts-unresolved",
    3000,
  ],
  ["gzh0821-pvzg-site", "listing", "bundled-game-data", 1874],
  ["hedgewars", "listing", "upstream-owned-route", 6423],
  ["igawa6-dualsouls", "listing", "bundled-game-data", 1829],
  ["jhdev2006-super-mario-world-remastered-public", "listing", "bundled-game-data", 1891],
  ["jiggle-or-physics-3dge7161-dead-or-alive", "listing", "bundled-game-data", 3507],
  ["kameo-repowered", "listing", "upstream-prohibition", 129],
  ["kens-labyrinth-sacredbanana-lab3d-sdl", "listing", "bundled-game-data", 6129],
  ["kenshi-meitou-client", "listing", "upstream-owned-route", 6062],
  ["kingdom-hearts-chain-of-memories-gba-rekhcom", "listing", "bundled-game-data", 2586],
  ["la-pingvino-the-puzzle-pits", "listing", "bundled-game-data", 6079],
  ["linewars-ii-sdl3", "listing", "bundled-game-data", 6090],
  ["lodilorenzo-cybermage-darklight-re-awakening", "listing", "bundled-game-data", 2836],
  ["lollipop-chainsaw-re-cherry", "listing", "package-facts-unresolved", 162],
  ["lords-of-the-realm-ii-open-lords2", "listing", "upstream-owned-route", 6085],
  ["lost-odyssey-recomp", "listing", "upstream-owned-route", 744],
  ["lostartefacts-trx", "listing", "bundled-game-data", 1898],
  ["magic-ball-2-openmb2", "listing", "bundled-game-data", 5434],
  ["mega-man-x-snes-recomp", "listing", "package-facts-unresolved", 146],
  [
    "mercenaries-playground-of-destruction-kraftmacandchee",
    "listing",
    "legacy-rights-review",
    1672,
  ],
  ["meteo-dream-mf-community-edition", "listing", "bundled-game-data", 2729],
  ["might-and-magic-ix-macos", "listing", "upstream-owned-route", 6109],
  ["mindustry", "listing", "upstream-owned-route", 6506],
  ["monster-hunter-generations-ultimate-mhgurecomp", "listing", "legacy-rights-review", 2950],
  ["mstan-battle-arena-toshinden-recomp", "listing", "legacy-rights-review", 826],
  [
    "mythologykombat-paumedes-mortal-kombat-mythologies-sub-zero",
    "listing",
    "package-facts-unresolved",
    3402,
  ],
  ["naev", "listing", "upstream-owned-route", 6817],
  ["neverball", "listing", "upstream-owned-route", 6400],
  ["nevercookfirst-dimensionsrecomp", "listing", "legacy-rights-review", 1817],
  ["nfl-head-coach-09-nfl-head-coach-09-static-recomp", "listing", "upstream-owned-route", 2696],
  ["novapowers0-bloody-roar-ii-recomp", "listing", "legacy-rights-review", 827],
  ["oceantrirecomp-krisztsa-monster-hunter-tri", "listing", "bundled-game-data", 3419],
  ["odrannnn-metroidprimeport", "listing", "legacy-rights-review", 1846],
  ["omegakatana92-battle-arena-toshinden-gb-recomp", "listing", "bundled-game-data", 1796],
  ["one-must-fall-2097-omf-remastered", "listing", "bundled-game-data", 5721],
  ["open-nectar-pikmin", "integration", "upstream-transition-unreviewed", 742],
  ["openarena", "listing", "upstream-owned-route", 6385],
  ["openclonk", "listing", "upstream-owned-route", 6529],
  ["opengtps1-gran-turismo-2", "listing", "no-useful-route", 743],
  ["petarov-alleycat-exe", "listing", "bundled-game-data", 2827],
  ["petarov-saboteur2", "listing", "bundled-game-data", 2722],
  ["pod-gold-sp00nznet-recomp", "listing", "upstream-owned-route", 6091],
  ["pokemon-platinum-pokeplatinum-pc-port-lead", "listing", "bundled-game-data", 373],
  ["pokemon-yellow-recomp", "listing", "bundled-game-data", 174],
  ["populous-the-beginning-openpoptb", "listing", "upstream-owned-route", 6100],
  ["prehistorik-2-pre2-port", "listing", "bundled-game-data", 5673],
  ["project-iron-6-genrythefox0-tekken-6", "listing", "package-facts-unresolved", 3130],
  ["prop-cycle-namco22", "listing", "bundled-game-data", 1565],
  ["quake-ii-q2repro", "listing", "upstream-owned-route", 6102],
  ["r-e-l-i-v-e-oddworld-abe-s-exoddus", "listing", "package-facts-unresolved", 122],
  ["r-e-l-i-v-e-oddworld-abe-s-oddysee", "listing", "package-facts-unresolved", 133],
  ["rage-racer-rage-racer-pc", "listing", "legacy-rights-review", 349],
  ["rages4calm-earthbound-companion", "listing", "third-party-component-terms", 2861],
  ["rave-racer-namco22", "listing", "bundled-game-data", 1566],
  ["red-alert-2-and-yuri-s-revenge-red-alert-2-recomp", "listing", "upstream-owned-route", 5744],
  ["redguard-maiko", "listing", "upstream-owned-route", 6668],
  ["ridgeracertype4recomp-tetrisgm-r4-ridge-racer-type-4", "listing", "legacy-rights-review", 3400],
  ["ring-racers", "listing", "upstream-owned-route", 6412],
  [
    "sarpbc-recompiled-snufflyyy-supersonic-acrobatic-rocket-powered-battle-cars",
    "listing",
    "legacy-rights-review",
    3371,
  ],
  ["sauerbraten", "listing", "upstream-owned-route", 6417],
  ["scottjco-wetrix-n64-usa-rev0-recomp", "listing", "bundled-game-data", 4262],
  ["silent-hill-downpour-downpourrecomp", "listing", "upstream-prohibition", 358],
  ["silent-hill-silent-hill-decomp-pc-branch", "listing", "third-party-component-terms", 351],
  ["skate-3-recomp", "listing", "package-facts-unresolved", 150],
  ["sonic-free-riders-recompiled", "listing", "legacy-rights-review", 1450],
  ["sonic-robo-blast-2", "listing", "upstream-owned-route", 6738],
  ["spelunky-classic-hd", "listing", "bundled-game-data", 6056],
  ["star-control-ii-uqm-megamod", "listing", "upstream-owned-route", 6061],
  ["star-fox-enhanced", "integration", "upstream-transition-unreviewed", 124],
  ["star-wars-shadows-of-the-empire-n64-sote-recomp", "listing", "bundled-game-data", 343],
  ["star-wars-tie-fighter-opentie", "listing", "bundled-game-data", 1975],
  ["supaplex-opensupaplex", "listing", "bundled-game-data", 5684],
  ["super-metroid-recomp", "integration", "known-defective-artifact", 164],
  ["teeworlds", "listing", "upstream-owned-route", 6509],
  ["thandor-the-invasion-open-thandor", "listing", "legacy-rights-review", 6121],
  ["the-powder-toy", "listing", "upstream-owned-route", 6491],
  ["time-crisis-namco22", "listing", "bundled-game-data", 1569],
  ["tobal-2-tobal2recomp", "listing", "package-facts-unresolved", 6008],
  ["tokyo-wars-namco22", "listing", "bundled-game-data", 1567],
  ["tomba-2-recompiled", "listing", "bundled-game-data", 169],
  [
    "toystory2-recompiled-periblugaming-toy-story-2-buzz-lightyear-to-the-rescue",
    "listing",
    "legacy-rights-review",
    3401,
  ],
  ["unchiga-yu-gi-oh-forbidden-memories-recompiled", "listing", "bundled-game-data", 1910],
  [
    "untildawn-pc-supercatelvis-supercatelvis-until-dawn-2015-ps4-original",
    "listing",
    "bundled-game-data",
    3461,
  ],
  ["unvanquished", "listing", "upstream-owned-route", 6468],
  ["ur-quan-masters", "listing", "upstream-owned-route", 6376],
  ["vandal-hearts-vandalhearts-pcport", "listing", "bundled-game-data", 347],
  ["wave-race-64-recompiled", "listing", "no-useful-route", 168],
  ["wesnoth", "listing", "upstream-owned-route", 6447],
  ["widelands", "listing", "upstream-owned-route", 6518],
  ["wii-play-tanks-rebirth", "listing", "package-facts-unresolved", 6004],
  ["wing-commander-privateer-openprivateer", "listing", "safety-evidence-mismatch", 6119],
  ["x-men-mutant-academy-2-xmen-mutant-academy-2-pc", "listing", "package-facts-unresolved", 356],
  ["xonotic", "listing", "upstream-owned-route", 6394],
  ["zelda-link-s-awakening-dx-hd", "listing", "no-useful-route", 128],
];

export const reasonTable: ReadonlyMap<
  string,
  { carrier: Carrier; reason: string; trackingIssue: number | null }
> = new Map(
  reviewedRows.map(([id, carrier, reason, trackingIssue]) => [
    id,
    { carrier, reason, trackingIssue },
  ]),
);

/** The shape a managed hold already has decides its descriptive code. */
function managedReason(hold: LegacyManagedHold) {
  return hold.excluded_artifacts?.length
    ? "known-defective-artifact"
    : "upstream-transition-unreviewed";
}

export interface MigratedRecord {
  record: Record<string, unknown>;
  listing: boolean;
  integration: boolean;
}

/** Typed form of one authored port; refuses anything it does not expect. */
export function migrateRecord(id: string, input: unknown): MigratedRecord {
  if (!isRecord(input) || !isRecord(input.listing))
    throw new Error(`${id}: expected an authored port with a listing.`);
  let record: Record<string, unknown> = structuredClone(input);
  let listing = record.listing as Record<string, unknown>;
  const entry = reasonTable.get(id);
  let migratedListing = false;
  let migratedIntegration = false;
  if (Object.hasOwn(listing, "download_block_reason")) {
    const legacy = listing.download_block_reason;
    if (typeof legacy !== "string" || Object.hasOwn(listing, "restrictions"))
      throw new Error(`${id}: unexpected listing restriction shape.`);
    if (entry?.carrier !== "listing")
      throw new Error(`${id}: listing restriction is missing from the reviewed reason table.`);
    const restriction: AcquisitionRestriction = {
      id: "download",
      effect: "hold",
      operations: ["download"],
      reason: entry.reason,
      explanation: legacy,
      ...(entry.trackingIssue === null ? {} : { tracking_issue: entry.trackingIssue }),
    };
    listing = replaceKey(listing, "download_block_reason", [["restrictions", [restriction]]]);
    record = replaceKey(record, "listing", [["listing", listing]]);
    migratedListing = true;
  }
  const integration = record.integration;
  if (isRecord(integration) && Object.hasOwn(integration, "managed_acquisition_hold")) {
    const hold = integration.managed_acquisition_hold;
    if (!isRecord(hold) || Object.hasOwn(integration, "acquisition_restrictions"))
      throw new Error(`${id}: unexpected managed hold shape.`);
    const legacy = hold as unknown as LegacyManagedHold;
    if (entry?.carrier !== "integration" || entry.reason !== managedReason(legacy))
      throw new Error(`${id}: managed hold disagrees with the reviewed reason table.`);
    // A managed tracking issue has no legacy field, so it would not round-trip.
    record = replaceKey(record, "integration", [
      [
        "integration",
        replaceKey(integration, "managed_acquisition_hold", [
          ["acquisition_restrictions", restrictionsFromManagedHold(legacy)],
        ]),
      ],
    ]);
    migratedIntegration = true;
  }
  const typed = record.listing as Record<string, unknown>;
  if (typed.restrictions !== undefined)
    checkAcquisitionRestrictions(id, typed.restrictions, "listing", { hasReleaseRoute: true });
  if (isRecord(record.integration) && record.integration.acquisition_restrictions !== undefined)
    checkAcquisitionRestrictions(id, record.integration.acquisition_restrictions, "integration");
  return { record, listing: migratedListing, integration: migratedIntegration };
}

export function migrateCatalogSource(portsDirectory: string, write: boolean) {
  const seen = new Set<string>();
  const counts = { listing: 0, integration: 0, alreadyTyped: 0, files: 0 };
  for (const file of readdirSync(portsDirectory).sort()) {
    if (!file.endsWith(".json")) throw new Error(`Unexpected port source ${file}.`);
    const id = file.slice(0, -5);
    const path = join(portsDirectory, file);
    const input: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = migrateRecord(id, input);
    const typedListing =
      isRecord(result.record.listing) && result.record.listing.restrictions !== undefined;
    const typedIntegration =
      isRecord(result.record.integration) &&
      result.record.integration.acquisition_restrictions !== undefined;
    if (typedListing || typedIntegration) seen.add(id);
    if (!result.listing && !result.integration) {
      if (typedListing || typedIntegration) counts.alreadyTyped++;
      continue;
    }
    counts.listing += Number(result.listing);
    counts.integration += Number(result.integration);
    counts.files++;
    if (write) writeFileSync(path, `${JSON.stringify(result.record, null, 2)}\n`);
  }
  const missing = [...reasonTable.keys()].filter((id) => !seen.has(id));
  if (missing.length)
    throw new Error(`Reviewed rows have no authored restriction: ${missing.join(", ")}.`);
  return counts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const check = process.argv.includes("--check");
  const counts = migrateCatalogSource(join(root, "crates/portcove-core/catalog/ports"), !check);
  if (check && counts.files)
    throw new Error(`${counts.files} port files still carry untyped restrictions.`);
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}
