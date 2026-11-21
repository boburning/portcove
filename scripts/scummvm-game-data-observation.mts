import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { scummvmGameKey } from "./catalog-scummvm-game-setup.mts";
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
const suffix =
  ". Check the page for current downloads and notes. The setup example applies to its named archive.";

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
  for (const row of rows) {
    if (!isRecord(row) || !["addons", "games"].includes(String(row.category)))
      throw new Error("ScummVM game data has an unsupported category");
    if (row.category === "addons") continue;
    const { game_id: game, name, url } = row;
    if (
      typeof game !== "string" ||
      !/^[a-z0-9]+:[a-z0-9][a-z0-9_-]*$/u.test(game) ||
      typeof name !== "string" ||
      typeof url !== "string"
    )
      throw new Error("ScummVM game data row lacks its exact identity, label or path");
    // The games category also carries add-ons and installers. Neither supplies
    // a game data edition for this projection. External links never enter it.
    if (
      !url.toLowerCase().endsWith(".zip") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(url) ||
      /\badd-?on\b/iu.test(name)
    )
      continue;
    const parts = url.split("/");
    const filename = parts.at(-1);
    if (
      !filename ||
      !archiveName.test(filename) ||
      parts.some((part) => !part || part === "." || part === ".." || /[?#\\\p{Cc}]/u.test(part)) ||
      !editionLabel.test(name) ||
      /https?:|[<>{}]/iu.test(name)
    )
      throw new Error("ScummVM game data contains ambiguous edition text or archive paths");
    const editions = byGame.get(game) ?? new Set<string>();
    editions.add(`${name} (${filename})`);
    if (editions.size > 12) throw new Error("ScummVM game data exceeds the per-game edition bound");
    byGame.set(game, editions);
  }
  if (!byGame.size) throw new Error("ScummVM game data has no observed game archives");
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
  const observation = readScummvmGameData(bytes, revision);
  if (bytes.length !== data.size || observation.blob !== data.sha)
    throw new Error("ScummVM game data blob does not match its source identity");
  if ((await currentRevision()) !== revision)
    throw new Error("ScummVM game data changed during observation");
  await checkRepository();
  return observation;
}

/** Upstream text can only supply a bounded reference on an existing checked guide. */
export function withoutScummvmGameData(listing: Record<string, unknown>) {
  const setup = listing.manual_setup;
  if (
    !scummvmGameKey(listing) ||
    !isRecord(setup) ||
    setup.help_url !== listing.setup_url ||
    !Array.isArray(setup.references)
  )
    return listing;
  const references = setup.references.filter(
    (reference) => !isRecord(reference) || reference.title !== sourceTitle,
  );
  if (references.length === setup.references.length) return listing;
  return { ...listing, manual_setup: { ...setup, references } };
}

export function projectScummvmGameData(
  listing: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  observation: ScummvmGameDataObservation | undefined,
) {
  const key = scummvmGameKey(listing);
  const setup = listing.manual_setup;
  if (
    !key ||
    !isRecord(setup) ||
    setup.help_url !== listing.setup_url ||
    !Array.isArray(setup.references) ||
    setup.references.length !== 3 ||
    !Array.isArray(setup.steps) ||
    setup.steps.length !== 3 ||
    !isRecord(setup.references[0]) ||
    setup.references[0].title !== "Find your launch target"
  )
    return;
  let reference: unknown;
  if (observation) {
    const editions = observation.editions.get(key);
    if (!editions?.length) return;
    reference = { title: sourceTitle, instruction: prefix + editions.join(", ") + suffix };
  } else if (previous) {
    const old = previous.manual_setup;
    const base = withoutScummvmGameData(previous).manual_setup;
    if (
      isRecord(old) &&
      Array.isArray(old.references) &&
      old.references.length === 4 &&
      observationHash(base ?? null) === observationHash(setup)
    ) {
      const retained: unknown = old.references.at(-1);
      if (
        isRecord(retained) &&
        retained.title === sourceTitle &&
        typeof retained.instruction === "string" &&
        retained.instruction.startsWith(prefix) &&
        retained.instruction.endsWith(suffix)
      )
        reference = retained;
    }
  }
  if (reference)
    listing.manual_setup = {
      ...setup,
      references: [...(setup.references as unknown[]), reference],
    };
}
