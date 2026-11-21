import { isDeepStrictEqual } from "node:util";
import type { AuthoredPort } from "./catalog-authoring.mts";
import observedSource from "../crates/portcove-core/catalog/v64recomp-source-guidance.json" with { type: "json" };
import { isRecord } from "./runtime-values.mts";
import {
  v64recompCurrentLayout,
  v64recompLegacyLayout,
  observeV64recompProfiles,
  v64recompGitId,
  v64recompProfileId,
  v64recompRepository,
  v64recompRepositoryId,
} from "./v64recomp-source-observation.mts";
import type { V64recompLayout, V64recompObservation } from "./v64recomp-source-observation.mts";

const projectUrl = `https://github.com/${v64recompRepository}`;
const sha256 = /^[a-f0-9]{64}$/u;
const profiles = new Map(Object.entries(observedSource.profiles));

export function projectV64recompSetup(record: AuthoredPort): AuthoredPort {
  const profile = record.v64recomp_setup_v1;
  if (profile === undefined) return record;
  const { listing, upstream_lineage: lineage } = record;
  const setup = listing.manual_setup;
  const facts = typeof profile === "string" ? profiles.get(profile) : undefined;
  const source = lineage?.origin.repository;
  const originalStep = listing.original_game?.source_editions.length
    ? "Check the required game files"
    : "Check the upstream profile";
  if (
    !facts ||
    !v64recompProfileId.test(profile) ||
    observedSource.format_version !== 1 ||
    observedSource.repository !== v64recompRepository ||
    observedSource.repository_id !== v64recompRepositoryId ||
    !v64recompGitId.test(observedSource.revision) ||
    !v64recompGitId.test(observedSource.tree) ||
    observedSource.layout !== "rt64-release-msvc-deck" ||
    !v64recompGitId.test(facts.blob) ||
    !v64recompGitId.test(facts.target_blob) ||
    !sha256.test(facts.sha256) ||
    !v64recompGitId.test(facts.sha1) ||
    !/^local\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.z64$/u.test(facts.rom) ||
    !Number.isSafeInteger(facts.size) ||
    facts.size < 1 ||
    facts.size > 64 * 1024 * 1024 ||
    !listing.id.startsWith(`v64recomp-${profile}-polaco1782-`) ||
    listing.project_url !== projectUrl ||
    listing.setup_url !== projectUrl ||
    lineage?.origin.project_url !== projectUrl ||
    source?.host !== "github.com" ||
    source.id !== String(v64recompRepositoryId) ||
    !(
      listing.original_game?.source_editions.some((edition) => edition.system === "nintendo-64") ||
      (listing.original_game?.source_editions.length === 0 &&
        record.original_game_review?.disposition === "separate")
    ) ||
    record.integration !== undefined ||
    record.route_facts_v1 !== undefined ||
    !isRecord(setup) ||
    setup.help_url !== projectUrl ||
    setup.references !== undefined ||
    !Array.isArray(setup.steps) ||
    setup.steps.length !== 1 ||
    !isRecord(setup.steps[0]) ||
    setup.steps[0].title !== originalStep ||
    typeof setup.steps[0].instruction !== "string" ||
    !setup.steps[0].instruction.includes(`games/${profile}/profile.toml`)
  )
    throw new Error(
      `${listing.id} requires a reviewed v64recomp source profile and original-file step.`,
    );

  const { v64recomp_setup_v1: _recipe, ...explicit } = record;
  const original = setup.steps[0];
  const manual_setup = listing.platforms?.includes("linux-x86-64")
    ? {
        ...setup,
        steps: [original, linuxStep(profile, v64recompCurrentLayout)],
        references: [windowsReference(profile), deckReference(profile)],
      }
    : {
        ...setup,
        steps: [
          original,
          {
            title: "Review the upstream build options",
            instruction:
              "Check the upstream guide for hosts and build options that apply to this profile before preparing a source build.",
          },
        ],
      };
  return { ...explicit, listing: { ...listing, manual_setup } };
}

function linuxStep(profile: string, layout: V64recompLayout) {
  const command =
    layout === v64recompCurrentLayout
      ? `python3 tools/build.py ${profile} --release --rt64`
      : `cmake --workflow --preset ${profile}-release`;
  return {
    title: "Build from source on Linux",
    instruction:
      `Follow the upstream Linux prerequisites. From the checkout root, run .venv/bin/python tools/import_rom.py --profile games/${profile}/profile.toml --rom "/path/to/your-ROM.z64" with your own .z64, .n64 or .v64 file. ` +
      `Run ${command}, then ./build/${profile}-release/bin/${profile}. The default keeps the ROM external. Keep the ROM and any locally generated game code private, including builds that embed it.`,
  };
}

function windowsReference(profile: string) {
  return {
    title: "Build from source on Windows x64",
    instruction:
      `For upstream-supported Windows builds, follow its Visual Studio, Python and vcpkg instructions. Use the same ROM profile with the Windows Python environment. From the checkout root, run .\\tools\\build_msvc_project.ps1 -Game ${profile} -Configuration Release in PowerShell. ` +
      `Start the resulting build/msvc/${profile}/release/bin/Release/${profile}.exe from the checkout root and keep its dependency DLLs beside it. Preserve the checkout’s private local/ directory and any custom data paths before rebuilding.`,
  };
}

const genericDeckRom = "the local/ path named in its included instructions";
const deckRomPattern = /^local\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.z64$/u;
function deckReference(profile: string, rom?: string) {
  const placement = rom ? rom : genericDeckRom;
  return {
    title: "Prepare a private Steam Deck copy",
    instruction:
      `For upstream-supported Deck builds, use the x86-64 Linux container guide and run ./tools/build_steamdeck.sh ${profile} after importing your ROM. Keep the resulting package folder together. ` +
      `Supply your matching ROM at ${placement}, then add launch.sh to Steam as a non-Steam game with compatibility tools disabled. Preserve local/ from the old copy before rebuilding or replacing it. Keep private packages and generated game code to yourself. Portcove has not observed Deck setup or gameplay.`,
  };
}

function reviewedGuide(listing: Record<string, unknown>) {
  const { id, project_url, setup_url, platforms, manual_setup: setup } = listing;
  if (
    typeof id !== "string" ||
    project_url !== projectUrl ||
    setup_url !== projectUrl ||
    !Array.isArray(platforms) ||
    !platforms.includes("linux-x86-64") ||
    !isRecord(setup) ||
    setup.help_url !== projectUrl ||
    !Array.isArray(setup.steps) ||
    setup.steps.length !== 2 ||
    !Array.isArray(setup.references) ||
    setup.references.length !== 2 ||
    !isRecord(setup.steps[0])
  )
    return;
  const profile = /^v64recomp-([a-z0-9-]+)-polaco1782-/u.exec(id)?.[1];
  const original = setup.steps[0];
  if (
    !profile ||
    !profiles.has(profile) ||
    original.title !== "Check the required game files" ||
    typeof original.instruction !== "string" ||
    !original.instruction.includes(`games/${profile}/profile.toml`) ||
    !isDeepStrictEqual(setup.steps[1], linuxStep(profile, v64recompCurrentLayout)) ||
    !isDeepStrictEqual(setup.references[0], windowsReference(profile)) ||
    !isDeepStrictEqual(setup.references[1], deckReference(profile))
  )
    return;
  return { profile, setup, original, windows: windowsReference(profile) };
}

function projectedGuide(
  guide: NonNullable<ReturnType<typeof reviewedGuide>>,
  layout: V64recompLayout,
  rom?: string,
) {
  return {
    ...guide.setup,
    steps: [guide.original, linuxStep(guide.profile, layout)],
    references: [guide.windows, deckReference(guide.profile, rom)],
  };
}

function retainedGuide(
  listing: Record<string, unknown>,
  prior: Record<string, unknown>,
  guide: NonNullable<ReturnType<typeof reviewedGuide>>,
) {
  if (
    prior.id !== listing.id ||
    prior.project_url !== listing.project_url ||
    prior.setup_url !== listing.setup_url ||
    !isDeepStrictEqual(prior.platforms, listing.platforms) ||
    !isDeepStrictEqual(prior.original_game, listing.original_game)
  )
    return;
  const setup = prior.manual_setup;
  if (
    !isRecord(setup) ||
    !Array.isArray(setup.references) ||
    !isRecord(setup.references[1]) ||
    typeof setup.references[1].instruction !== "string"
  )
    return;
  const rom =
    /Supply your matching ROM at (local\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.z64), then/u.exec(
      setup.references[1].instruction,
    )?.[1];
  if (rom && (rom !== profiles.get(guide.profile)?.rom || rom.length > genericDeckRom.length))
    return;
  for (const layout of [v64recompCurrentLayout, v64recompLegacyLayout] as const) {
    if (isDeepStrictEqual(setup, projectedGuide(guide, layout, rom))) return setup;
  }
}

export function withoutV64recompObservation(
  prior: Record<string, unknown>,
  listing: Record<string, unknown>,
) {
  const guide = reviewedGuide(listing);
  return guide && retainedGuide(listing, prior, guide)
    ? { ...prior, manual_setup: listing.manual_setup }
    : prior;
}

export function reconcileV64recompGuide(
  listing: Record<string, unknown>,
  prior: Record<string, unknown> | undefined,
  observation: V64recompObservation | undefined,
  held: Set<string>,
) {
  const guide = reviewedGuide(listing);
  if (!guide) return false;
  const reviewed = profiles.get(guide.profile)!;
  const live = observation?.profiles[guide.profile];
  if (
    observation?.repository_id === v64recompRepositoryId &&
    observation.repository === v64recompRepository &&
    observation.format_version === 1 &&
    live &&
    live.target_blob === reviewed.target_blob &&
    live.sha1 === reviewed.sha1 &&
    live.size === reviewed.size &&
    live.rom === reviewed.rom &&
    deckRomPattern.test(live.rom) &&
    live.rom.length <= genericDeckRom.length &&
    (observation.layout === v64recompCurrentLayout || observation.layout === v64recompLegacyLayout)
  ) {
    listing.manual_setup = projectedGuide(guide, observation.layout, live.rom);
    return true;
  }
  if (observation) held.add(guide.profile);
  const retained = prior && retainedGuide(listing, prior, guide);
  if (retained) listing.manual_setup = retained;
  return false;
}

export async function observeV64recompGuides(listings: readonly Record<string, unknown>[]) {
  const scope = listings.flatMap((listing) => {
    const guide = reviewedGuide(listing);
    return guide ? [guide.profile] : [];
  });
  if (!scope.length) return undefined;
  // The reviewed baseline is reused only where the complete official tree still
  // supplies exactly the same Git blob IDs.
  return observeV64recompProfiles(scope, undefined, undefined, {
    ...observedSource,
    layout: v64recompCurrentLayout,
  });
}
