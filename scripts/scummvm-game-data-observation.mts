import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  scummvmEditionPrompt,
  scummvmGameDataInstruction,
  scummvmGameDataStepTitle,
  scummvmGameKey,
} from "./catalog-scummvm-game-setup.mts";
import { createGitHubClient } from "./github-client.mts";
import { isRecord } from "./runtime-values.mts";
import { observationHash } from "./upstream-observer.mts";

const repository = "/repos/scummvm/scummvm-web";
const file = "data/en/game_downloads.yaml";
const commits = repository + "/commits";
const content = repository + "/contents/" + file;
const branch = "master";
const sourceId = 5929844;
const maxSourceBytes = 64 * 1024;
const sha1 = /^[a-f0-9]{40}$/u;
const archiveName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.zip$/iu;
const editionLabel = /^[\p{L}\p{N}][\p{L}\p{N}\p{P} ]{0,119}$/u;
const sourceTitle = "Game data editions listed by ScummVM";
const prefix = "On the ScummVM games page, the source lists ";
const suffix = ". Check the page for current downloads and notes.";

export interface ScummvmGameDataObservation {
  revision: string;
  blob: string;
  sha256: string;
  editions: ReadonlyMap<string, readonly string[]>;
}

export function readScummvmGameData(
  bytes: Uint8Array,
  revision: string,
): ScummvmGameDataObservation {
  if (bytes.length < 1 || bytes.length > maxSourceBytes || !sha1.test(revision))
    throw new Error("Unsupported ScummVM game data revision or document size");
  const document = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
    uniqueKeys: true,
    schema: "failsafe",
  });
  if (document.errors.length || document.warnings.length)
    throw new Error("ScummVM game data YAML is invalid");
  const rows: unknown = document.toJS({ maxAliasCount: 0 });
  if (!Array.isArray(rows) || !rows.length || rows.length > 512)
    throw new Error("ScummVM game data requires a complete bounded row array");
  const byGame = new Map<string, Set<string>>();
  let gameRows = 0;
  for (const row of rows) {
    if (!isRecord(row) || !["addons", "games"].includes(String(row.category)))
      throw new Error("ScummVM game data has an unsupported category");
    const { game_id: game, name, url } = row;
    if (
      typeof game !== "string" ||
      !/^[a-z0-9]+:[a-z0-9][a-z0-9_-]*$/u.test(game) ||
      typeof name !== "string" ||
      typeof url !== "string"
    )
      throw new Error("ScummVM game data row lacks its exact identity, label or path");
    const external = /^[a-z][a-z0-9+.-]*:/iu.test(url);
    const parsed = external && URL.canParse(url) ? new URL(url) : null;
    const parts = url.split("/");
    const filename = parts.at(-1);
    if (
      !editionLabel.test(name) ||
      /https?:|[<>{}]/iu.test(name) ||
      url.length > 512 ||
      url !== url.trim() ||
      (external
        ? !parsed ||
          parsed.protocol !== "https:" ||
          !!parsed.username ||
          !!parsed.password ||
          /[\\\p{Cc}]/u.test(url)
        : parts.some(
            (part) => !part || part === "." || part === ".." || /[?#\\\p{Cc}]/u.test(part),
          ))
    )
      throw new Error("ScummVM game data contains ambiguous edition text or archive paths");
    // Add-ons never demonstrate a complete game data table. A validated table
    // of other game packages can authoritatively withdraw every prior ZIP.
    if (row.category === "addons" || /\badd-?on\b/iu.test(name)) continue;
    gameRows += 1;
    if (external || !url.toLowerCase().endsWith(".zip")) continue;
    if (!filename || !archiveName.test(filename))
      throw new Error("ScummVM game data contains ambiguous edition text or archive paths");
    const editions = byGame.get(game) ?? new Set<string>();
    editions.add(`${name} (${filename})`);
    if (editions.size > 12) throw new Error("ScummVM game data exceeds the per-game edition bound");
    byGame.set(game, editions);
  }
  if (!gameRows) throw new Error("ScummVM game data has no complete game rows");
  return {
    revision,
    blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    editions: new Map([...byGame].map(([key, values]) => [key, [...values].sort()])),
  };
}

export async function observeScummvmGameData(
  token = process.env.GH_TOKEN,
  fetchImplementation?: typeof fetch,
) {
  const sdk = await createGitHubClient({
    credential: token ? { kind: "explicit", token } : { kind: "anonymous" },
    deadline: performance.now() + 15000,
    requestTimeoutMs: 5000,
    maxBytes: 96 * 1024,
    allowRequest: (method, url) =>
      method === "GET" && [repository, commits, content].includes(url.pathname),
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  });
  const checkRepository = async () => {
    const data: unknown = (await sdk.request("GET " + repository)).data;
    if (
      !isRecord(data) ||
      data.id !== sourceId ||
      data.full_name !== "scummvm/scummvm-web" ||
      data.default_branch !== branch ||
      data.archived !== false
    )
      throw new Error("ScummVM website repository authority changed");
  };
  const currentRevision = async () => {
    const data: unknown = (
      await sdk.request("GET " + commits, {
        path: file,
        sha: branch,
        per_page: 1,
      })
    ).data;
    if (
      !Array.isArray(data) ||
      data.length !== 1 ||
      !isRecord(data[0]) ||
      typeof data[0].sha !== "string" ||
      !sha1.test(data[0].sha)
    )
      throw new Error("ScummVM game data revision is unavailable");
    return data[0].sha;
  };
  await checkRepository();
  const revision = await currentRevision();
  const data: unknown = (await sdk.request("GET " + content, { ref: revision })).data;
  if (
    !isRecord(data) ||
    data.path !== file ||
    data.type !== "file" ||
    data.encoding !== "base64" ||
    typeof data.content !== "string" ||
    !Number.isSafeInteger(data.size) ||
    Number(data.size) > maxSourceBytes
  )
    throw new Error("ScummVM game data content is unavailable");
  const bytes = Buffer.from(data.content, "base64");
  if (bytes.length !== data.size)
    throw new Error("ScummVM game data blob does not match its source identity");
  const observation = readScummvmGameData(bytes, revision);
  if (observation.blob !== data.sha)
    throw new Error("ScummVM game data blob does not match its source identity");
  if ((await currentRevision()) !== revision)
    throw new Error("ScummVM game data changed during observation");
  await checkRepository();
  return observation;
}

function guide(listing: Record<string, unknown>) {
  const key = scummvmGameKey(listing);
  const setup = listing.manual_setup;
  if (
    !key ||
    !isRecord(setup) ||
    setup.help_url !== listing.setup_url ||
    !Array.isArray(setup.steps) ||
    setup.steps.length !== 3 ||
    !Array.isArray(setup.references) ||
    !isRecord(setup.steps[1]) ||
    setup.steps[1].title !== scummvmGameDataStepTitle ||
    typeof setup.steps[1].instruction !== "string" ||
    !isRecord(setup.references[0]) ||
    setup.references[0].title !== "Find your launch target"
  )
    return;
  const steps: unknown[] = setup.steps;
  const references: unknown[] = setup.references;
  const instruction = setup.steps[1].instruction;
  const generic =
    scummvmGameDataInstruction +
    (instruction.startsWith(scummvmGameDataInstruction + scummvmEditionPrompt)
      ? scummvmEditionPrompt
      : "");
  if (instruction !== generic && !instruction.startsWith(generic + " If the page lists ")) return;
  const archive = /^ If the page lists ([A-Za-z0-9._-]+\.zip) and you choose it, select /u.exec(
    instruction.slice(generic.length),
  )?.[1];
  const withoutExample = {
    ...setup,
    steps: [steps[0], { title: scummvmGameDataStepTitle, instruction: generic }, steps[2]],
  };
  return { key, setup, references, instruction, archive, withoutExample };
}

function retainedGuide(listing: Record<string, unknown>, previous: Record<string, unknown>) {
  const authored = guide(listing);
  const old = guide(previous);
  if (!authored || !old || old.key !== authored.key || authored.references.length !== 3) return;
  const reference = old.references.at(-1);
  const observed =
    old.references.length === 4 &&
    isRecord(reference) &&
    reference.title === sourceTitle &&
    typeof reference.instruction === "string" &&
    reference.instruction.startsWith(prefix) &&
    reference.instruction.endsWith(suffix)
      ? reference
      : undefined;
  const refs = observed ? old.references.slice(0, -1) : old.references;
  const actual = { ...old.setup, references: refs };
  if (
    observationHash(actual) === observationHash(authored.setup) ||
    observationHash(actual) === observationHash(authored.withoutExample)
  )
    return { setup: actual, observed };
}

/** Match retained release observations against their original listing declarations. */
export function withoutScummvmGameData(
  listing: Record<string, unknown>,
  canonical: Record<string, unknown>,
) {
  return retainedGuide(canonical, listing)
    ? { ...listing, manual_setup: canonical.manual_setup }
    : listing;
}

/** Remove a withdrawn example before fitting any optional source text. */
export function projectScummvmPreparation(
  listing: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  observation: ScummvmGameDataObservation | undefined,
) {
  const current = guide(listing);
  if (!current?.archive) return;
  if (observation) {
    const editions = observation.editions.get(current.key) ?? [];
    if (!editions.some((edition) => edition.endsWith(` (${current.archive})`)))
      listing.manual_setup = current.withoutExample;
  } else if (previous) {
    const retained = retainedGuide(listing, previous);
    if (retained) listing.manual_setup = retained.setup;
  }
}

/** Attach source text to an admitted and already safe guide when space remains. */
export function projectScummvmGameData(
  listing: Record<string, unknown>,
  canonical: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  observation: ScummvmGameDataObservation | undefined,
) {
  const current = guide(listing);
  if (!current || current.references.length !== 3) return;
  let reference: unknown;
  if (observation) {
    const editions = observation.editions.get(current.key);
    if (editions?.length)
      reference = { title: sourceTitle, instruction: prefix + editions.join(", ") + suffix };
  } else if (previous) {
    reference = retainedGuide(canonical, previous)?.observed;
  }
  if (reference)
    listing.manual_setup = { ...current.setup, references: [...current.references, reference] };
}
