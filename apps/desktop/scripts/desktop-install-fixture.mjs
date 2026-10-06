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

function platformContract() {
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

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`Tar field exceeds ${length} bytes: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, "0");
  if (octal.length >= length) throw new Error(`Tar number exceeds ${length} bytes: ${value}`);
  writeString(buffer, offset, length, `${octal}\0`);
}

function tarEntry(name, contents, mode) {
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

function createInstallArtifact(seed) {
  const { executable } = platformContract();
  const payload = deterministicPayload(3 * 1024 * 1024, seed);
  const tar = Buffer.concat([tarEntry(executable, payload, 0o755), Buffer.alloc(1024)]);
  return gzipSync(tar, { level: 0 });
}

async function createCompletionArtifact(tool) {
  if (!tool || !path.isAbsolute(tool) || !(await stat(tool)).isFile())
    throw new Error("Selected setup completion requires an absolute owned preparation tool file");
  const executable = await readFile(tool);
  if (executable.length === 0) throw new Error("Owned preparation tool must not be empty");
  return gzipSync(
    Buffer.concat([
      tarEntry(platformContract().executable, executable, 0o755),
      // Keep the first download genuinely interruptible even for a small probe.
      tarEntry("owned-download-padding.bin", deterministicPayload(), 0o644),
      Buffer.alloc(1024),
    ]),
    { level: 0 },
  );
}

function fixturePort({ id, name, summary, platform, executable, url, artifact, adapter }) {
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  return server.address().port;
}

async function addSelectedSetupSources({
  baseCatalog,
  portDefinitions,
  portDefinition,
  refreshPortDefinition,
  output,
  revision,
  completionJourney = false,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? ""))
    throw new Error("Selected setup requires the actual frozen source revision");
  const directory = path.join(output, "selected-setup-inputs");
  await mkdir(directory);
  const syntheticN64 = (variant) => {
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
  const gamePath = path.join(directory, `game.${gameExtension}`);
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
  const immutableUrl = `https://github.com/boburning/portcove/blob/${revision}/apps/desktop/scripts/desktop-install-fixture.mjs`;
  const profiles = [
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
  for (const profile of profiles) {
    baseCatalog.source_catalog.identities.push({
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
    });
  }
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
    });
  }
  refreshPortDefinition.adapter = "psx-recomp-managed";
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
      });
    }
  }
  return {
    directory,
    gamePath,
    biosPath,
    gameBefore,
    gameReplacement,
    biosBefore,
    game,
    replacement,
    bios,
    profiles: profiles.map(({ id }) => id),
  };
}

export async function createInstallFixture({
  root,
  output,
  holdFirstDownload = false,
  sourceJourney = false,
  completionJourney = false,
  preparationTool,
  revision,
}) {
  if (sourceJourney && completionJourney)
    throw new Error("Discovery and completion fixtures require separate isolated selections");
  let artifact = completionJourney
    ? await createCompletionArtifact(preparationTool)
    : createInstallArtifact();
  const artifacts = new Map([[`/${artifactName}`, artifact]]);
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const servedArtifact = request.method === "GET" ? artifacts.get(request.url) : null;
    if (!servedArtifact) {
      response.writeHead(404).end();
      return;
    }
    const observation = {
      index: requests.length + 1,
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
    let timer;
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
    if (observation.index === 1) {
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
  const port = await listen(server);
  let url;
  let portDefinition;
  let refreshPortDefinition;
  let artifactPath;
  let catalogPath;
  try {
    url = `http://127.0.0.1:${port}/${artifactName}`;
    const contract = platformContract();
    portDefinition = fixturePort({
      id: INSTALL_FIXTURE_PORT_ID,
      name: INSTALL_FIXTURE_NAME,
      summary: "Isolated checksum-pinned native install and cancellation fixture.",
      ...contract,
      url,
      artifact,
      adapter: "n64-recomp-portable",
    });
    refreshPortDefinition = fixturePort({
      id: INSTALL_REFRESH_FIXTURE_PORT_ID,
      name: INSTALL_REFRESH_FIXTURE_NAME,
      summary: "Isolated committed install and workspace refresh recovery fixture.",
      ...contract,
      url,
      artifact,
      adapter: "libultraship-portable",
    });
    const portDefinitions = [portDefinition, refreshPortDefinition];
    const baseCatalog = JSON.parse(
      await readFile(path.join(root, "crates", "portcove-core", "catalog", "catalog.json"), "utf8"),
    );
    for (const definition of portDefinitions) {
      if (baseCatalog.ports.some((item) => item.id === definition.id))
        throw new Error(`${definition.id} unexpectedly exists in the maintained catalog`);
    }
    if (sourceJourney || completionJourney)
      sourceJourney = await addSelectedSetupSources({
        baseCatalog,
        portDefinitions,
        portDefinition,
        refreshPortDefinition,
        output,
        revision,
        completionJourney,
      });
    baseCatalog.ports.push(...portDefinitions);
    artifactPath = path.join(output, artifactName);
    catalogPath = path.join(output, "qualification-catalog.json");
    await Promise.all([
      writeFile(artifactPath, artifact, { flag: "wx" }),
      writeFile(catalogPath, `${JSON.stringify(baseCatalog, null, 2)}\n`, { flag: "wx" }),
    ]);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
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
    sourceJourney: sourceJourney || null,
    completionJourney,
    url,
    async publishRelease(portId, { version, publishedAt, seed }) {
      if (completionJourney)
        throw new Error("Completion probe fixture cannot publish inert upgrades");
      if (![INSTALL_FIXTURE_PORT_ID, INSTALL_REFRESH_FIXTURE_PORT_ID].includes(portId))
        throw new Error(`Cannot publish an upgrade for unknown fixture port ${portId}`);
      if (!version || !publishedAt || !Number.isInteger(seed) || seed === 0)
        throw new Error(
          "Fixture upgrades require a version, publication time, and nonzero integer seed",
        );
      const nextArtifact = createInstallArtifact(seed);
      const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
      const definition = catalog.ports.find((value) => value.id === portId);
      if (!definition) throw new Error(`Fixture catalog no longer contains ${portId}`);
      const releases = Object.values(definition.release.direct);
      if (releases.length !== 1) throw new Error("Fixture port must expose one platform release");
      const sha256 = createHash("sha256").update(nextArtifact).digest("hex");
      const publishedUrl = new URL(`/${portId}-${sha256.slice(0, 16)}-${artifactName}`, url).href;
      Object.assign(releases[0], {
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
        writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`),
      ]);
      return { version, url: publishedUrl, size: nextArtifact.length, sha256 };
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
