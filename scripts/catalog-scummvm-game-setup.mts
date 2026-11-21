import { isRecord } from "./runtime-values.mts";

const player = "https://github.com/scummvm/scummvm";
const games = "https://www.scummvm.org/games/#games-";
const gameKey = /^[a-z0-9]+:[a-z0-9][a-z0-9_-]*$/u;

export function scummvmGameKey(listing: Record<string, unknown>) {
  if (
    listing.project_url !== player ||
    typeof listing.setup_url !== "string" ||
    !listing.setup_url.startsWith(games)
  )
    return undefined;
  const key = listing.setup_url.slice(games.length);
  return gameKey.test(key) ? key : undefined;
}

type GuideStep = { title: string; instruction: string };

export const scummvmGameDataStepTitle = "Extract and add the game files";
export const scummvmGameDataInstruction =
  "On the ScummVM games page, choose the game data edition you want. Extract the archive, then use Add Game in ScummVM and select the folder containing the game data.";
export const scummvmEditionPrompt =
  " Choose the edition or language you want when ScummVM offers a choice.";

export function scummvmSetupGuide(record: Record<string, unknown>) {
  const facts = record.scummvm_game_setup_v1;
  if (facts === undefined) return undefined;
  const listing = record.listing;
  const lineage = record.upstream_lineage;
  if (
    !isRecord(listing) ||
    !isRecord(lineage) ||
    !isRecord(lineage.origin) ||
    !isRecord(lineage.origin.repository) ||
    lineage.origin.repository.host !== "github.com" ||
    lineage.origin.repository.id !== "1358940" ||
    lineage.origin.project_url !== player ||
    !Array.isArray(lineage.decisions) ||
    lineage.decisions.length !== 0 ||
    listing.manual_setup !== undefined ||
    record.integration !== undefined ||
    typeof listing.original_game_title !== "string"
  )
    throw new Error("ScummVM setup requires a listing-only guide bound to the official player");
  const key = scummvmGameKey(listing);
  if (
    !key ||
    !isRecord(facts) ||
    Object.keys(facts).some(
      (name) => !["archive", "folder", "choose_edition", "warnings"].includes(name),
    ) ||
    typeof facts.archive !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.zip$/iu.test(facts.archive) ||
    (facts.folder !== undefined &&
      (typeof facts.folder !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._ -]*(?:\/[A-Za-z0-9][A-Za-z0-9._ -]*)*$/u.test(facts.folder) ||
        facts.folder.length > 120)) ||
    (facts.choose_edition !== undefined && facts.choose_edition !== true) ||
    (facts.warnings !== undefined &&
      (!Array.isArray(facts.warnings) ||
        facts.warnings.some((warning) => typeof warning !== "string")))
  )
    throw new Error("Invalid reviewed ScummVM setup facts");
  const { archive, folder, choose_edition: chooseEdition, warnings } = facts;
  const step = (title: string, instruction: string): GuideStep => ({ title, instruction });
  return {
    steps: [
      step(
        "Get ScummVM for your system",
        "On ScummVM’s downloads page, choose the Windows 64-bit ZIP, your Linux distribution’s package, or the universal macOS disk image for Intel and Apple Silicon. Keep the package’s support files with the player.",
      ),
      step(
        scummvmGameDataStepTitle,
        scummvmGameDataInstruction +
          (chooseEdition ? scummvmEditionPrompt : "") +
          ` If the page lists ${archive} and you choose it, select ${folder ? `the ${folder} folder from the ZIP` : "the folder you extracted the ZIP into"}.`,
      ),
      step(
        "Play again from the saved target",
        "Select your saved entry in ScummVM and press Start. The entry remembers the game folder. To launch directly from a frontend, run ScummVM with the saved target ID. Use Game Options in ScummVM to change the entry later.",
      ),
    ],
    warnings: warnings ?? [],
    help_url: listing.setup_url,
    references: [
      step(
        "Find your launch target",
        `ScummVM detects these files as ${key}. Run scummvm --list-targets to see the ID of the saved entry. Use that saved ID as the positional argument so ScummVM reuses its settings and data folder.`,
      ),
      step(
        "Update your player",
        "For the Windows ZIP, you replace the runtime. A Linux distribution package updates through your package manager. The official universal macOS disk image uses ScummVM’s updater. Portcove leaves this installation and its files with you.",
      ),
      step(
        "Keep your saves and settings",
        "In Game Options, open Paths and check Save Path. If it shows Default, check Global Options. For a Default global path, use ScummVM’s documented location for your system or choose a save folder explicitly. Global Options also shows the configuration file path. Back up both before updating.",
      ),
    ],
  };
}
