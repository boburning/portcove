import type {
  Platform,
  AdapterKind,
  PortDefinition,
  PortPresentation,
  DirectReleaseSpec,
  PortSourceContract,
  SourceIdentityProfile,
  SourceVariant,
  SourceRepresentation,
  DigestIdentity,
} from "../src/transport-types.generated.d.ts";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { isRecord } from "../../../scripts/runtime-values.mts";
// Authoring projections intentionally omit Core-defaulted fields; Core remains the catalog validator.
type FixturePort = Pick<
  PortDefinition,
  | "id"
  | "name"
  | "summary"
  | "adapter"
  | "channels"
  | "platforms"
  | "executable_hints"
  | "persistent_paths"
> & {
  project_url: string;
  support_tier: "beta";
  release: { provider: "direct-manifest"; direct: Partial<Record<Platform, DirectReleaseSpec>> };
  presentation: Pick<
    PortPresentation,
    "installation_method" | "source_requirements" | "saves_and_settings"
  >;
  source_profile?: string | null;
  bios_source_profile?: string | null;
  launch_arguments?: string[];
};
interface NamedRecord extends Record<string, unknown> {
  id: string;
}
type CatalogContract = Pick<PortSourceContract, "id" | "port_id" | "role"> &
  Record<string, unknown>;
type SourceAuthoringContract = Pick<
  PortSourceContract,
  | "id"
  | "port_id"
  | "role"
  | "profile_id"
  | "admission_mode"
  | "supported_variant_ids"
  | "validator_contract_id"
  | "evidence_ids"
  | "authority_ref"
  | "reviewed_at"
  | "immutable_review_url"
  | "live_review_url"
  | "evidence_gap"
>;
type RawRepresentation = Pick<SourceRepresentation, "id" | "extensions"> & {
  kind: "raw-file";
  identities: DigestIdentity[];
};
type IdentityAuthoring = Pick<SourceIdentityProfile, "id" | "label" | "kind" | "evidence_gap"> & {
  variants: (Pick<SourceVariant, "id" | "title" | "region" | "revision"> & {
    representations: RawRepresentation[];
  })[];
};
type PreliminaryPort = Pick<
  FixturePort,
  "id" | "name" | "summary" | "release" | "platforms" | "executable_hints"
> &
  Record<string, unknown>;
interface FixtureCatalog {
  ports: NamedRecord[];
  source_catalog: { identities: NamedRecord[]; contracts: CatalogContract[] };
}
interface SourceProfile {
  id: string;
  label: string;
  extension: string;
  payloads: Buffer[];
}
interface RequestObservation {
  index: number;
  request_path: string;
  started_at: string;
  bytes_sent: number;
  completed: boolean;
  connection_closed: boolean;
  finished_at?: string;
  closed_at?: string;
}
interface FixtureOptions {
  root: string;
  output: string;
  holdFirstDownload?: boolean;
  sourceJourney?: boolean;
  preliminaryJourney?: boolean;
  preliminarySetupJourney?: boolean;
  hashResumeJourney?: boolean;
  completionJourney?: boolean;
  acquisitionJourney?: boolean;
  updateReviewJourney?: boolean;
  preparationTool?: string;
  revision?: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Fixture catalog record must be an object");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Fixture catalog collection must be an array");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Fixture catalog identity must be a string");
  return value;
}
function named(value: unknown): NamedRecord {
  const raw = object(value);
  return { ...raw, id: text(raw.id) };
}
function catalog(value: unknown): FixtureCatalog {
  const raw = object(value),
    source = object(raw.source_catalog);
  const contracts = array(source.contracts).map((value): CatalogContract => {
    const record = named(value);
    const role = record.role;
    if (role !== "game" && role !== "bios") throw new Error("Fixture source role is invalid");
    return { ...record, port_id: text(record.port_id), role };
  });
  return {
    ...raw,
    ports: array(raw.ports).map(named),
    source_catalog: { ...source, identities: array(source.identities).map(named), contracts },
  };
}
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";

export const INSTALL_FIXTURE_PORT_ID = "portcove-install-fixture";
export const INSTALL_REFRESH_FIXTURE_PORT_ID = "portcove-install-refresh-fixture";
const INSTALL_FIXTURE_NAME = "Portcove Install Fixture";
const INSTALL_REFRESH_FIXTURE_NAME = "Portcove Install Refresh Fixture";
const artifactName = "portcove-install-fixture.tar.gz";
export const UPDATE_REVIEW_PORT_ID = "opengoal-jak1";
export const UPDATE_REVIEW_VERSION = "0.4.0-update-review-fixture";

function platformContract(): { platform: Platform; executable: string } {
  if (process.platform === "win32")
    return { platform: "windows-x86-64", executable: "portcove-install-fixture.exe" };
  if (process.platform === "linux")
    return { platform: "linux-x86-64", executable: "portcove-install-fixture" };
  if (process.platform === "darwin")
    return {
      platform: process.arch === "arm64" ? "macos-aarch64" : "macos-x86-64",
      executable: "portcove-install-fixture",
    };
  throw new Error(`Install fixture does not support ${process.platform}/${process.arch}`);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`Tar field exceeds ${length} bytes: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number) {
  const octal = value.toString(8).padStart(length - 1, "0");
  if (octal.length >= length) throw new Error(`Tar number exceeds ${length} bytes: ${value}`);
  writeString(buffer, offset, length, `${octal}\0`);
}

function tarEntry(name: string, contents: Buffer, mode: number) {
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function deterministicPayload(size = 3 * 1024 * 1024, seed = 0x6d2b79f5) {
  const payload = Buffer.allocUnsafe(size);
  let state = seed;
  for (let index = 0; index < payload.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[index] = state & 0xff;
  }
  return payload;
}

function createInstallArtifact(seed?: number) {
  const { executable } = platformContract();
  const payload = deterministicPayload(3 * 1024 * 1024, seed);
  const tar = Buffer.concat([tarEntry(executable, payload, 0o755), Buffer.alloc(1024)]);
  return gzipSync(tar, { level: 0 });
}

async function createCompletionArtifact(tool: string | undefined, seed?: number) {
  if (!tool || !path.isAbsolute(tool) || !(await stat(tool)).isFile())
    throw new Error("Selected setup completion requires an absolute owned preparation tool file");
  const executable = await readFile(tool);
  if (executable.length === 0) throw new Error("Owned preparation tool must not be empty");
  return gzipSync(
    Buffer.concat([
      tarEntry(platformContract().executable, executable, 0o755),
      // Keep the first download genuinely interruptible even for a small probe.
      tarEntry("owned-download-padding.bin", deterministicPayload(3 * 1024 * 1024, seed), 0o644),
      Buffer.alloc(1024),
    ]),
    { level: 0 },
  );
}

function fixturePort({
  id,
  name,
  summary,
  platform,
  executable,
  url,
  artifact,
  adapter,
}: {
  id: string;
  name: string;
  summary: string;
  platform: Platform;
  executable: string;
  url: string;
  artifact: Buffer;
  adapter: AdapterKind;
}): FixturePort {
  return {
    id,
    name,
    summary,
    project_url: `https://example.invalid/${id}`,
    support_tier: "beta",
    channels: ["stable"],
    platforms: [platform],
    adapter,
    release: {
      provider: "direct-manifest",
      direct: {
        [platform]: {
          version: "1.0.0-fixture",
          url,
          size: artifact.length,
          sha256: createHash("sha256").update(artifact).digest("hex"),
          published_at: "2026-09-15T00:00:00Z",
        },
      },
    },
    executable_hints: { [platform]: [executable] },
    persistent_paths: [],
    presentation: {
      installation_method: "portable-package",
      source_requirements: [],
      saves_and_settings: "portcove-managed",
    },
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address");
  return address.port;
}

function addSourceIdentityProfiles(
  baseCatalog: FixtureCatalog,
  profiles: SourceProfile[],
  evidenceGap: string,
) {
  for (const profile of profiles) {
    const identity: IdentityAuthoring = {
      id: profile.id,
      label: profile.label,
      kind: "file",
      evidence_gap: evidenceGap,
      variants: profile.payloads.map((payload, index) => ({
        id: `inert-${index}`,
        title: `Owned inert variant ${index}`,
        region: null,
        revision: null,
        representations: [
          {
            id: "original",
            extensions: [profile.extension],
            kind: "raw-file",
            identities: [
              {
                scope: "original-file",
                sha1: null,
                sha256: createHash("sha256").update(payload).digest("hex"),
                crc32: null,
              },
            ],
          },
        ],
      })),
    };
    baseCatalog.source_catalog.identities.push(identity);
  }
}

function addSourceContracts({
  baseCatalog,
  portDefinitions,
  refreshPortDefinition,
  profiles,
  revision,
  immutableUrl,
  evidenceGap,
}: {
  baseCatalog: FixtureCatalog;
  portDefinitions: FixturePort[];
  refreshPortDefinition: FixturePort;
  profiles: [SourceProfile, SourceProfile];
  revision: string;
  immutableUrl: string;
  evidenceGap: string;
}) {
  for (const definition of portDefinitions) {
    definition.source_profile = profiles[0].id;
    if (definition === refreshPortDefinition) definition.bios_source_profile = profiles[1].id;
    definition.presentation.source_requirements = profiles
      .filter((profile, index) => index === 0 || definition === refreshPortDefinition)
      .map((profile, index) => ({
        role: index === 0 ? "game" : "bios",
        profile_id: profile.id,
        label: profile.label,
        verification: "catalog-identity",
      }));
    for (const requirement of definition.presentation.source_requirements) {
      const profile = profiles.find((item) => item.id === requirement.profile_id);
      if (!profile) throw new Error("Fixture source contract has no profile");
      baseCatalog.source_catalog.contracts.push({
        id: `${definition.id}-${requirement.role}`,
        port_id: definition.id,
        role: requirement.role,
        profile_id: profile.id,
        admission_mode: "enforced",
        supported_variant_ids: profile.payloads.map((_, index) => `inert-${index}`),
        validator_contract_id: null,
        evidence_ids: [],
        authority_ref: revision,
        reviewed_at: "2026-10-06",
        immutable_review_url: immutableUrl,
        live_review_url: null,
        evidence_gap: evidenceGap,
      } satisfies SourceAuthoringContract);
    }
  }
}

async function addSelectedSetupSources({
  baseCatalog,
  portDefinitions,
  portDefinition,
  refreshPortDefinition,
  output,
  revision,
  completionJourney = false,
}: {
  baseCatalog: FixtureCatalog;
  portDefinitions: FixturePort[];
  portDefinition: FixturePort;
  refreshPortDefinition: FixturePort;
  output: string;
  revision: string | undefined;
  completionJourney?: boolean;
  acquisitionJourney?: boolean;
}) {
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Selected setup requires the actual frozen source revision");
  const directory = path.join(output, "selected-setup-inputs");
  await mkdir(directory);
  const syntheticN64 = (variant: string) => {
    const bytes = Buffer.alloc(64);
    Buffer.from([0x80, 0x37, 0x12, 0x40]).copy(bytes);
    bytes.write(`Portcove synthetic selected game ${variant}`, 4);
    return bytes;
  };
  const game = completionJourney
    ? syntheticN64("A")
    : Buffer.from("Portcove inert selected game variant A\n");
  const replacement = completionJourney
    ? syntheticN64("B")
    : Buffer.from("Portcove inert selected game variant B\n");
  const bios = Buffer.from("Portcove inert selected BIOS fixture\n");
  const gameExtension = completionJourney ? "z64" : "pcgame";
  // The root's BIOS and child directory consume one real two-entry batch before
  // traversal reaches the game. No substituted scan response supplies the result.
  const gameDirectory = completionJourney ? path.join(directory, "next-batch") : directory;
  if (completionJourney) await mkdir(gameDirectory);
  const gamePath = path.join(gameDirectory, `game.${gameExtension}`);
  const biosPath = path.join(directory, "bios.pcbios");
  const gameBefore = path.join(output, "selected-game-before.pcgame");
  const gameReplacement = path.join(output, "selected-game-replacement.pcgame");
  const biosBefore = path.join(output, "selected-bios-before.pcbios");
  await Promise.all([
    writeFile(gamePath, game, { flag: "wx" }),
    writeFile(biosPath, bios, { flag: "wx" }),
    writeFile(gameBefore, game, { flag: "wx" }),
    writeFile(gameReplacement, replacement, { flag: "wx" }),
    writeFile(biosBefore, bios, { flag: "wx" }),
  ]);
  const evidenceGap = completionJourney
    ? "Owned synthetic valid-header N64 bytes and first-party preparation probe only; no upstream game identity, rights, gameplay or real-game qualification."
    : "Owned inert qualification bytes only; no upstream identity, rights, preparation or runtime qualification.";
  const immutableUrl = `https://github.com/boburning/portcove/blob/${revision}/apps/desktop/scripts/desktop-install-fixture.mts`;
  const profiles: [SourceProfile, SourceProfile] = [
    {
      id: "selected-setup-game",
      label: "Selected setup inert game",
      extension: gameExtension,
      payloads: [game, replacement],
    },
    {
      id: "selected-setup-bios",
      label: "Selected setup inert BIOS",
      extension: "pcbios",
      payloads: [bios],
    },
  ];
  addSourceIdentityProfiles(baseCatalog, profiles, evidenceGap);
  // Outside the scanned root: these inspect-only selections must not alter the
  // existing saved-folder discovery denominator or become an admitted variant.
  const ambiguous = Buffer.from("Portcove inert ambiguous representation fixture\n");
  const ambiguousPath = path.join(output, `selected-ambiguous.${gameExtension}`);
  const unsupportedPath = path.join(output, "selected-unsupported.txt");
  await writeFile(ambiguousPath, ambiguous, { flag: "wx" });
  await writeFile(unsupportedPath, "Portcove inert unsupported source\n", { flag: "wx" });
  const gameIdentity = baseCatalog.source_catalog.identities.find(
    (item) => item.id === profiles[0].id,
  );
  if (!gameIdentity || !Array.isArray(gameIdentity.variants))
    throw new Error("Owned game identity missing");
  gameIdentity.variants.push({
    id: "ambiguous-inspection-only",
    title: "Owned ambiguous representations",
    region: null,
    revision: null,
    representations: ["sha1", "sha256"].map((algorithm) => ({
      id: `ambiguous-${algorithm}`,
      extensions: [gameExtension],
      kind: "raw-file",
      identities: [
        {
          scope: "original-file",
          [algorithm]: createHash(algorithm).update(ambiguous).digest("hex"),
        },
      ],
    })),
  });

  portDefinition.adapter = "libultraship-portable";
  if (completionJourney) {
    const { platform, executable } = platformContract();
    Object.assign(portDefinition, {
      runtime_source_filename: "source.z64",
      runtime_source_materialization: "n64-big-endian",
      setup_executable_hints: { [platform]: [executable] },
      setup_arguments: ["--owned-preparation", "--owned-fixture-mode", "success"],
      setup_output_paths: ["data/out", "data/log"],
      setup_marker: "data/out/jak1/iso/0COMMON.TXT",
    } satisfies Pick<
      PortDefinition,
      | "runtime_source_filename"
      | "runtime_source_materialization"
      | "setup_executable_hints"
      | "setup_arguments"
      | "setup_output_paths"
      | "setup_marker"
    >);
  }
  refreshPortDefinition.adapter = "psx-recomp-managed";
  addSourceContracts({
    baseCatalog,
    portDefinitions,
    refreshPortDefinition,
    profiles,
    revision,
    immutableUrl,
    evidenceGap,
  });
  return {
    directory,
    gamePath,
    biosPath,
    gameBefore,
    gameReplacement,
    biosBefore,
    ambiguousPath,
    unsupportedPath,
    game,
    replacement,
    bios,
    profiles: [profiles[0].id, profiles[1].id] as const,
  };
}

interface ArtifactGate {
  released: boolean;
  expired: boolean;
  release(): void;
}

function createArtifactServer({
  artifacts,
  requests,
  sockets,
  holdFirstDownload,
  gates,
}: {
  artifacts: Map<string, Buffer>;
  requests: RequestObservation[];
  sockets: Set<Socket>;
  holdFirstDownload: boolean;
  gates: Map<string, ArtifactGate>;
}) {
  const server = createServer((request, response) => {
    const servedArtifact = request.method === "GET" ? artifacts.get(request.url ?? "") : null;
    if (!servedArtifact) {
      response.writeHead(404).end();
      return;
    }
    const observation: RequestObservation = {
      index: requests.length + 1,
      request_path: request.url ?? "",
      started_at: new Date().toISOString(),
      bytes_sent: 0,
      completed: false,
      connection_closed: false,
    };
    requests.push(observation);
    response.writeHead(200, {
      "Content-Length": servedArtifact.length,
      "Content-Type": "application/gzip",
    });
    let offset = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (timer) clearInterval(timer);
      if (observation.completed || response.destroyed) return;
      observation.completed = true;
      observation.finished_at = new Date().toISOString();
      response.end();
    };
    const writeChunk = () => {
      if (response.destroyed) {
        if (timer) clearInterval(timer);
        return;
      }
      const chunkSize = holdFirstDownload && observation.index === 1 ? 1024 * 1024 : 64 * 1024;
      const end = Math.min(offset + chunkSize, servedArtifact.length);
      if (end > offset) {
        response.write(servedArtifact.subarray(offset, end));
        observation.bytes_sent = end;
        offset = end;
      }
      if (offset === servedArtifact.length) finish();
    };
    response.on("close", () => {
      if (timer) clearInterval(timer);
      observation.connection_closed = true;
      observation.closed_at = new Date().toISOString();
    });
    const gate = gates.get(observation.request_path);
    if (gate) {
      writeChunk();
      timer = setInterval(() => {
        if (gate.released) writeChunk();
      }, 75);
    } else if (observation.index === 1) {
      writeChunk();
      // A held first request exposes real download progress but cannot pass
      // publication while the consumer establishes conflict and cancellation.
      // Abort/fixture close releases the socket; retries remain complete.
      if (!holdFirstDownload) timer = setInterval(writeChunk, 75);
    } else {
      response.write(servedArtifact);
      observation.bytes_sent = servedArtifact.length;
      finish();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return server;
}

async function writeFixtureCatalog({
  root,
  output,
  port,
  artifact,
  sourceJourney,
  preliminarySetupJourney,
  completionJourney,
  acquisitionWaitPath,
  updateReviewJourney,
  revision,
}: {
  root: string;
  output: string;
  port: number;
  artifact: Buffer;
  updateReviewJourney: boolean;
  sourceJourney: boolean;
  preliminarySetupJourney: boolean;
  completionJourney: boolean;
  acquisitionWaitPath: string | undefined;
  revision: string | undefined;
}) {
  let url: string,
    portDefinition: FixturePort | PreliminaryPort,
    refreshPortDefinition: FixturePort,
    artifactPath: string,
    catalogPath: string;
  url = `http://127.0.0.1:${port}/${artifactName}`;
  const contract = platformContract();
  const ownedPortDefinition = fixturePort({
    id: INSTALL_FIXTURE_PORT_ID,
    name: INSTALL_FIXTURE_NAME,
    summary: "Isolated checksum-pinned native install and cancellation fixture.",
    ...contract,
    url,
    artifact,
    adapter: "n64-recomp-portable",
  });
  portDefinition = ownedPortDefinition;
  refreshPortDefinition = fixturePort({
    id: INSTALL_REFRESH_FIXTURE_PORT_ID,
    name: INSTALL_REFRESH_FIXTURE_NAME,
    summary: "Isolated committed install and workspace refresh recovery fixture.",
    ...contract,
    url,
    artifact,
    adapter: "libultraship-portable",
  });
  if (acquisitionWaitPath) {
    refreshPortDefinition.launch_arguments = [
      "--game",
      "--owned-wait",
      acquisitionWaitPath,
      "--owned-wait-seconds",
      "180",
    ];
  }
  const portDefinitions: (FixturePort | PreliminaryPort)[] = [
    portDefinition,
    refreshPortDefinition,
  ];
  const baseCatalog = catalog(
    JSON.parse(
      await readFile(path.join(root, "crates", "portcove-core", "catalog", "catalog.json"), "utf8"),
    ),
  );
  for (const definition of portDefinitions) {
    if (baseCatalog.ports.some((item) => item.id === definition.id))
      throw new Error(`${definition.id} unexpectedly exists in the maintained catalog`);
  }
  let selectedSources:
    | (Awaited<ReturnType<typeof addSelectedSetupSources>> & {
        reviewPort?: { id: string; name: string };
      })
    | null = null;
  if (sourceJourney || completionJourney)
    selectedSources = await addSelectedSetupSources({
      baseCatalog,
      portDefinitions: [ownedPortDefinition, refreshPortDefinition],
      portDefinition: ownedPortDefinition,
      refreshPortDefinition,
      output,
      revision,
      completionJourney,
    });
  if (completionJourney) {
    const alternative = structuredClone(portDefinition);
    alternative.id = "desktop-selected-review-alternative";
    alternative.name = "Selected setup review alternative";
    if (baseCatalog.ports.some((item) => item.id === alternative.id))
      throw new Error("Selected-review alternative collides with catalog identity");
    for (const contract of baseCatalog.source_catalog.contracts.filter(
      (item) => item.port_id === portDefinition.id,
    ))
      baseCatalog.source_catalog.contracts.push({
        ...structuredClone(contract),
        id: `${alternative.id}-${contract.role}`,
        port_id: alternative.id,
      });
    portDefinitions.push(alternative);
    if (!selectedSources) throw new Error("Completion source fixture is missing");
    selectedSources.reviewPort = { id: alternative.id, name: alternative.name };
  }
  if (preliminarySetupJourney) {
    const original = baseCatalog.ports.find((item) => item.id === "opengoal-jak1");
    const originalContract = baseCatalog.source_catalog.contracts.find(
      (item) => item.port_id === original?.id && item.role === "game",
    );
    if (!original || !originalContract)
      throw new Error("Preliminary setup requires the maintained pinned-validator contract");
    const owned = portDefinition;
    portDefinition = {
      ...structuredClone(original),
      id: owned.id,
      name: owned.name,
      summary:
        "Inert preliminary-selection review fixture; no validation or preparation execution.",
      release: owned.release,
      platforms: owned.platforms,
      automated_platforms: owned.platforms,
      manually_verified_platforms: [],
      executable_hints: owned.executable_hints,
    };
    portDefinitions[0] = portDefinition;
    baseCatalog.source_catalog.contracts = baseCatalog.source_catalog.contracts.filter(
      (item) => item.port_id !== owned.id,
    );
    baseCatalog.source_catalog.contracts.push({
      ...structuredClone(originalContract),
      id: `${owned.id}-game`,
      port_id: owned.id,
      evidence_ids: [],
      authority_ref: revision,
      reviewed_at: "2026-10-13",
      immutable_review_url: `https://github.com/boburning/portcove/blob/${revision}/apps/desktop/scripts/desktop-install-fixture.mts`,
      evidence_gap: "Owned inert selection; no upstream validation or preparation proof.",
    });
  }
  if (updateReviewJourney) {
    // The game update review needs an offered release without live GitHub: its
    // check and plan read this owned direct manifest instead of the anonymous
    // provider API, whose shared-runner rate limit is outside Portcove (#4879).
    // Only the app and the preparation seed read this catalog. Other owned helpers
    // in a combined local session keep the maintained definition; hosted runs
    // isolate the review in its own group, so they never mix the two.
    const reviewed = baseCatalog.ports.find((item) => item.id === UPDATE_REVIEW_PORT_ID);
    const platforms = reviewed?.platforms;
    if (
      !reviewed ||
      !Array.isArray(platforms) ||
      !platforms.every((item) => typeof item === "string")
    )
      throw new Error("Update review requires the maintained opengoal-jak1 definition");
    // Core admits a direct manifest only on the stable channel.
    if (JSON.stringify(reviewed.channels) !== JSON.stringify(["stable"]))
      throw new Error("Update review's direct manifest requires a stable-only definition");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    reviewed.release = {
      provider: "direct-manifest",
      direct: Object.fromEntries(
        platforms.map((platform) => [
          platform,
          {
            version: UPDATE_REVIEW_VERSION,
            url,
            size: artifact.length,
            sha256,
            published_at: "2026-11-01T00:00:00Z",
          },
        ]),
      ),
    };
  }
  baseCatalog.ports.push(...portDefinitions);
  artifactPath = path.join(output, artifactName);
  catalogPath = path.join(output, "qualification-catalog.json");
  await Promise.all([
    writeFile(artifactPath, artifact, { flag: "wx" }),
    writeFile(catalogPath, `${JSON.stringify(baseCatalog, null, 2)}\n`, { flag: "wx" }),
  ]);
  return {
    url,
    portDefinition,
    refreshPortDefinition,
    artifactPath,
    catalogPath,
    sourceJourney: selectedSources,
  };
}

export async function createInstallFixture({
  root,
  output,
  holdFirstDownload = false,
  sourceJourney = false,
  preliminaryJourney = false,
  preliminarySetupJourney = false,
  hashResumeJourney = false,
  completionJourney = false,
  acquisitionJourney = false,
  updateReviewJourney = false,
  preparationTool,
  revision,
}: FixtureOptions) {
  if (
    acquisitionJourney &&
    (sourceJourney || completionJourney || preliminaryJourney || hashResumeJourney)
  )
    throw new Error("Acquisition requires its own executable-upgrade fixture selection");
  const acquisitionWaitPath = acquisitionJourney
    ? path.join(output, "acquisition-game-release.signal")
    : undefined;
  if (sourceJourney && completionJourney)
    throw new Error("Discovery and completion fixtures require separate isolated selections");
  if (preliminaryJourney && (!sourceJourney || completionJourney))
    throw new Error("Preliminary review requires its standalone source fixture");
  if (preliminarySetupJourney && (!preliminaryJourney || hashResumeJourney))
    throw new Error("Preliminary setup review requires its standalone preliminary fixture");
  if (hashResumeJourney && (!sourceJourney || preliminaryJourney || completionJourney))
    throw new Error("Hash continuation requires its standalone source fixture");
  let artifact =
    completionJourney || acquisitionJourney
      ? await createCompletionArtifact(preparationTool)
      : createInstallArtifact();
  const artifacts = new Map([[`/${artifactName}`, artifact]]);
  const requests: RequestObservation[] = [];
  const sockets = new Set<Socket>();
  const gates = new Map<string, ArtifactGate>();
  const server = createArtifactServer({ artifacts, requests, sockets, holdFirstDownload, gates });
  const port = await listen(server);
  let url;
  let portDefinition;
  let refreshPortDefinition;
  let artifactPath;
  let catalogPath;
  let selectedSources: Awaited<ReturnType<typeof writeFixtureCatalog>>["sourceJourney"];
  let preliminarySelection: { path: string; before: string; profile: string } | null = null;
  try {
    ({
      url,
      portDefinition,
      refreshPortDefinition,
      artifactPath,
      catalogPath,
      sourceJourney: selectedSources,
    } = await writeFixtureCatalog({
      root,
      output,
      port,
      artifact,
      sourceJourney,
      preliminarySetupJourney,
      completionJourney,
      acquisitionWaitPath,
      updateReviewJourney,
      revision,
    }));
    if (preliminaryJourney) {
      const bytes = Buffer.from("Portcove inert preliminary disc selection; no retail identity\n");
      const selectedPath = path.join(requiredSources(selectedSources).directory, "preliminary.iso");
      const before = path.join(output, "preliminary-before.iso");
      await writeFile(selectedPath, bytes, { flag: "wx" });
      await writeFile(before, bytes, { flag: "wx" });
      preliminarySelection = { path: selectedPath, before, profile: "opengoal-jak1-disc" };
    }
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    get artifact() {
      return artifact;
    },
    artifactPath,
    catalogPath,
    port: portDefinition,
    refreshPort: refreshPortDefinition,
    requests,
    sourceJourney: selectedSources,
    preliminaryJourney: preliminarySelection,
    ...(preliminarySetupJourney ? { preliminarySetupJourney: true } : {}),
    ...(hashResumeJourney ? { hashResumeJourney: true } : {}),
    completionJourney,
    acquisitionWaitPath,
    url,
    holdArtifact(artifactUrl: string) {
      const candidate = new URL(artifactUrl);
      if (
        !acquisitionJourney ||
        candidate.origin !== new URL(url).origin ||
        !artifacts.has(candidate.pathname)
      )
        throw new Error("Only an owned acquisition artifact may be held");
      if (gates.has(candidate.pathname)) throw new Error("Artifact already has a transfer gate");
      const gate: ArtifactGate = {
        released: false,
        expired: false,
        release() {
          clearTimeout(deadline);
          gate.released = true;
        },
      };
      const deadline = setTimeout(() => {
        gate.expired = true;
        gate.release();
      }, 180_000);
      gates.set(candidate.pathname, gate);
      return gate;
    },
    async publishRelease(
      portId: string,
      { version, publishedAt, seed }: { version: string; publishedAt: string; seed: number },
    ) {
      if (completionJourney)
        throw new Error("Completion probe fixture cannot publish inert upgrades");
      if (![INSTALL_FIXTURE_PORT_ID, INSTALL_REFRESH_FIXTURE_PORT_ID].includes(portId))
        throw new Error(`Cannot publish an upgrade for unknown fixture port ${portId}`);
      if (!version || !publishedAt || !Number.isInteger(seed) || seed === 0)
        throw new Error(
          "Fixture upgrades require a version, publication time, and nonzero integer seed",
        );
      const nextArtifact = acquisitionJourney
        ? await createCompletionArtifact(preparationTool, seed)
        : createInstallArtifact(seed);
      const raw: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
      const current = catalog(raw);
      const definition = current.ports.find((value) => value.id === portId);
      if (!definition) throw new Error(`Fixture catalog no longer contains ${portId}`);
      const releases = Object.values(object(object(definition.release).direct)).map(object);
      if (releases.length !== 1) throw new Error("Fixture port must expose one platform release");
      const sha256 = createHash("sha256").update(nextArtifact).digest("hex");
      const publishedUrl = new URL(`/${portId}-${sha256.slice(0, 16)}-${artifactName}`, url).href;
      const release = releases[0];
      if (!release) throw new Error("Fixture port has no platform release");
      Object.assign(release, {
        version,
        url: publishedUrl,
        size: nextArtifact.length,
        sha256,
        published_at: publishedAt,
      });
      artifact = nextArtifact;
      artifacts.set(new URL(publishedUrl).pathname, nextArtifact);
      await Promise.all([
        writeFile(artifactPath, nextArtifact),
        writeFile(catalogPath, `${JSON.stringify(current, null, 2)}\n`),
      ]);
      return { version, url: publishedUrl, size: nextArtifact.length, sha256 };
    },
    async close() {
      for (const gate of gates.values()) gate.release();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Prelaunch-only expansion for the finite native retained-page review case.
 * Distinct bytes identify 21 games; only the last game has two implementations.
 * Twenty-five copies per game exceed the 512-match Core preview before UI paging. */
export async function prepareLargeSetupReviewFixture(
  fixture: Awaited<ReturnType<typeof createInstallFixture>>,
  revision: string,
) {
  if (!/^[a-f0-9]{40}$/.test(revision) || fixture.requests.length !== 0)
    throw new Error("Large review requires frozen source and unstarted fixture acquisition");
  const owned = requiredSources(fixture.sourceJourney);
  const current = catalog(JSON.parse(await readFile(fixture.catalogPath, "utf8")));
  const template = current.ports.find((item) => item.id === fixture.port.id);
  const contract = current.source_catalog.contracts.find(
    (item) => item.port_id === fixture.port.id && item.role === "game",
  );
  if (!template || !contract) throw new Error("Large review requires the selected-source fixture");
  const previousPorts = new Set([fixture.port.id, fixture.refreshPort.id]);
  current.ports = current.ports.filter((item) => !previousPorts.has(item.id));
  current.source_catalog.contracts = current.source_catalog.contracts.filter(
    (item) => !previousPorts.has(item.port_id),
  );
  current.source_catalog.identities = current.source_catalog.identities.filter(
    (item) => !owned.profiles.includes(item.id),
  );
  const eligiblePorts: string[] = [],
    choicePorts: string[] = [];
  const originals: { profile: string; path: string; copies: string[]; sha256: string }[] = [];
  const gap =
    "Owned unique inert game bytes for native large review only; no retail, preparation or gameplay qualification.";
  for (let index = 0; index < 21; index++) {
    const ordinal = String(index).padStart(2, "0");
    const profile = `desktop-large-review-original-${ordinal}`;
    if (current.source_catalog.identities.some((item) => item.id === profile))
      throw new Error("Large-review source identity collision");
    const bytes = Buffer.from(`Portcove inert large-review game ${ordinal}\n`);
    addSourceIdentityProfiles(
      current,
      [
        {
          id: profile,
          label: `Owned large review game ${ordinal}`,
          extension: "pcgame",
          payloads: [bytes],
        },
      ],
      gap,
    );
    const copies: string[] = [];
    for (let copy = 0; copy < 25; copy++) {
      const file = path.join(owned.directory, `large-${ordinal}-copy-${copy}.pcgame`);
      await writeFile(file, bytes, { flag: "wx" });
      copies.push(file);
    }
    originals.push({
      profile,
      path: text(copies[0]),
      copies,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (const version of index === 20 ? ["a", "b"] : ["only"]) {
      const id = `desktop-large-review-${ordinal}-${version}`;
      if (current.ports.some((item) => item.id === id))
        throw new Error("Large-review port identity collision");
      const definition = structuredClone(template);
      definition.id = id;
      definition.name = `Large review game ${ordinal} ${version}`;
      definition.source_profile = profile;
      delete definition.bios_source_profile;
      const presentation = object(definition.presentation);
      presentation.original_game_title = `Large review game ${ordinal}`;
      presentation.variant_label = index === 20 ? version : null;
      presentation.source_requirements = [
        {
          role: "game",
          profile_id: profile,
          label: `Owned large review game ${ordinal}`,
          verification: "catalog-identity",
        },
      ];
      current.ports.push(definition);
      current.source_catalog.contracts.push({
        ...structuredClone(contract),
        id: `${id}-game`,
        port_id: id,
        profile_id: profile,
        supported_variant_ids: ["inert-0"],
        authority_ref: revision,
        immutable_review_url: `https://github.com/boburning/portcove/blob/${revision}/apps/desktop/scripts/desktop-install-fixture.mts`,
        evidence_gap: gap,
      });
      (index === 20 ? choicePorts : eligiblePorts).push(id);
    }
  }
  await writeFile(fixture.catalogPath, `${JSON.stringify(current, null, 2)}\n`);
  return {
    eligiblePorts,
    choicePorts,
    originals,
    exactMatches: originals.reduce((total, original) => total + original.copies.length, 0),
  };
}

function requiredSources<T>(value: T | null): T {
  if (!value) throw new Error("Selected fixture source is required");
  return value;
}

/** Two independently installed portable integrations; the PS1 selection fixture stays separate. */
export async function prepareReviewedSetupBatchFixture(
  fixture: Awaited<ReturnType<typeof createInstallFixture>>,
) {
  const sources = requiredSources(fixture.sourceJourney);
  if (
    fixture.completionJourney ||
    fixture.preliminaryJourney ||
    fixture.requests.length !== 0 ||
    fixture.port.id !== INSTALL_FIXTURE_PORT_ID ||
    fixture.port.adapter !== "libultraship-portable" ||
    fixture.refreshPort.id !== INSTALL_REFRESH_FIXTURE_PORT_ID ||
    fixture.refreshPort.adapter !== "psx-recomp-managed"
  )
    throw new Error("Reviewed batch requires an unused standalone source-selection fixture");
  const current = catalog(JSON.parse(await readFile(fixture.catalogPath, "utf8")));
  const primary = current.ports.find((port) => port.id === fixture.port.id);
  const peerIndex = current.ports.findIndex((port) => port.id === fixture.refreshPort.id);
  const gameContracts = current.source_catalog.contracts.filter(
    (contract) => contract.port_id === fixture.port.id,
  );
  const game = gameContracts[0];
  if (
    !primary ||
    primary.adapter !== "libultraship-portable" ||
    primary.source_profile !== sources.profiles[0] ||
    peerIndex < 0 ||
    gameContracts.length !== 1 ||
    !game ||
    game.role !== "game" ||
    game.profile_id !== sources.profiles[0]
  )
    throw new Error("Reviewed batch requires the original portable game contract");
  const peer = {
    ...structuredClone(fixture.port),
    id: fixture.refreshPort.id,
    name: fixture.refreshPort.name,
    summary: "Second isolated portable integration sharing the registered original.",
  };
  current.ports[peerIndex] = peer;
  current.source_catalog.contracts = current.source_catalog.contracts.filter(
    (contract) => contract.port_id !== peer.id,
  );
  current.source_catalog.contracts.push({
    ...structuredClone(game),
    id: `${peer.id}-game`,
    port_id: peer.id,
  });
  await writeFile(fixture.catalogPath, `${JSON.stringify(current, null, 2)}\n`);
  Object.assign(fixture.refreshPort, peer);
  delete fixture.refreshPort.bios_source_profile;
}
