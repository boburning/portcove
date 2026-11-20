import type { AuthoredPort } from "./catalog-authoring.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "openmoh/openmohaa";
const projectUrl = `https://github.com/${repository}`;
const game = "medal-of-honor-allied-assault";
const editions = {
  base: { game, directories: ["main"] },
  breakthrough: { game: `${game}-breakthrough`, directories: ["main", "maintt"] },
  spearhead: { game: `${game}-spearhead`, directories: ["main", "mainta"] },
};
type Edition = keyof typeof editions;

const windows = "windows-x86-64";
const linux = "linux-x86-64";
const macIntel = "macos-x86-64";
const macArm = "macos-aarch64";
const platforms = [windows, linux, macIntel, macArm];
const macArchiveSuffix = "-macos-multiarch-arm64-x86_64.zip";
const windowsExecutables = [
  ...Object.keys(editions).map((edition) => `launch_openmohaa_${edition}.exe`),
  "omohaaded.exe",
  "openmohaa.exe",
];
const explicitFields = new Set([
  "support_tier",
  "automated_tested_platforms",
  "manually_validated_platforms",
  "presentation",
]);

function reviewedEdition(record: AuthoredPort): Edition | undefined {
  const origin = record.upstream_lineage?.origin;
  if (
    record.listing.project_url !== projectUrl ||
    origin?.project_url !== projectUrl ||
    origin.repository?.host !== "github.com" ||
    origin.repository.id !== "29029846" ||
    record.route_facts_v1 !== undefined ||
    record.package_observation_v1 !== undefined ||
    record.settings_qualification_v1 !== undefined ||
    record.settings_observation_v1 !== undefined
  )
    return undefined;
  return (Object.keys(editions) as Edition[]).find(
    (edition) =>
      record.listing.id === `${editions[edition].game}-openmohaa` &&
      record.listing.original_game?.id === editions[edition].game,
  );
}

export function projectOpenMohaaPortable(record: AuthoredPort): AuthoredPort {
  if (record.openmohaa_portable_v1 === undefined) return record;
  const edition = reviewedEdition(record);
  if (!edition || record.openmohaa_portable_v1 !== edition)
    throw new Error(
      "The OpenMoHAA recipe requires its reviewed project and matching game edition.",
    );
  const explicit = record.integration;
  if (
    !explicit ||
    Object.keys(explicit).some((field) => !explicitFields.has(field)) ||
    !isRecord(explicit.presentation) ||
    explicit.presentation.installation_method !== "portable-package" ||
    explicit.presentation.saves_and_settings !== "external-user-owned"
  )
    throw new Error("The OpenMoHAA recipe supplies the package, launcher and data layout.");

  const { support_tier, automated_tested_platforms, manually_validated_platforms, presentation } =
    explicit;
  const { openmohaa_portable_v1: _recipe, ...projected } = record;
  const launcher = `launch_openmohaa_${edition}`;
  const unixLayout = () => ({ directories: [], executables: [launcher, "openmohaa"] });
  return {
    ...projected,
    integration: {
      support_tier,
      channels: ["stable"],
      platforms: [...platforms],
      adapter: "native-portable",
      reviewed_package_layouts: {
        [linux]: unixLayout(),
        [macIntel]: unixLayout(),
        [macArm]: unixLayout(),
        [windows]: { directories: [], executables: [...windowsExecutables] },
      },
      automated_tested_platforms,
      manually_validated_platforms,
      release: {
        provider: "github",
        repository,
        asset_hints: {
          [windows]: ["openmohaa-", "-windows-x64.zip"],
          [linux]: ["openmohaa-", "-linux-amd64.zip"],
          [macIntel]: ["openmohaa-", macArchiveSuffix],
          [macArm]: ["openmohaa-", macArchiveSuffix],
        },
      },
      presentation,
      executable_hints: {
        [windows]: [`${launcher}.exe`],
        [linux]: [launcher],
        [macIntel]: [launcher],
        [macArm]: [launcher],
      },
      persistent_paths: [...editions[edition].directories],
      windows_runtime_path_policy: "printable-ascii-max-path",
      external_profile_policy: "openmohaa-unix-v1",
    },
  };
}

export function compactOpenMohaaPortable(record: AuthoredPort): AuthoredPort {
  if (record.openmohaa_portable_v1 !== undefined) return record;
  const edition = reviewedEdition(record);
  const explicit = record.integration;
  if (
    !edition ||
    !explicit ||
    !isRecord(explicit.presentation) ||
    explicit.presentation.installation_method !== "portable-package" ||
    explicit.presentation.saves_and_settings !== "external-user-owned"
  )
    return record;
  const integration = Object.fromEntries(
    Object.entries(explicit).filter(([field]) => explicitFields.has(field)),
  );
  const candidate: AuthoredPort = { ...record, openmohaa_portable_v1: edition, integration };
  return JSON.stringify(projectOpenMohaaPortable(candidate).integration) ===
    JSON.stringify(explicit)
    ? candidate
    : record;
}
