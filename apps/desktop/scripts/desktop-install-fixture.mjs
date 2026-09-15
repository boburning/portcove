import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

function deterministicPayload(size = 3 * 1024 * 1024) {
  const payload = Buffer.allocUnsafe(size);
  let state = 0x6d2b79f5;
  for (let index = 0; index < payload.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[index] = state & 0xff;
  }
  return payload;
}

function createInstallArtifact() {
  const { executable } = platformContract();
  const payload = deterministicPayload();
  const tar = Buffer.concat([tarEntry(executable, payload, 0o755), Buffer.alloc(1024)]);
  return gzipSync(tar, { level: 0 });
}

function fixturePort({ id, name, summary, platform, executable, url, artifact }) {
  return {
    id,
    name,
    summary,
    project_url: `https://example.invalid/${id}`,
    support_tier: "beta",
    channels: ["stable"],
    platforms: [platform],
    adapter: "n64-recomp-portable",
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

export async function createInstallFixture({ root, output }) {
  const artifact = createInstallArtifact();
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== `/${artifactName}`) {
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
      "Content-Length": artifact.length,
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
      const end = Math.min(offset + 64 * 1024, artifact.length);
      if (end > offset) {
        response.write(artifact.subarray(offset, end));
        observation.bytes_sent = end;
        offset = end;
      }
      if (offset === artifact.length) finish();
    };
    response.on("close", () => {
      if (timer) clearInterval(timer);
      observation.connection_closed = true;
      observation.closed_at = new Date().toISOString();
    });
    if (observation.index === 1) {
      writeChunk();
      timer = setInterval(writeChunk, 75);
    } else {
      response.write(artifact);
      observation.bytes_sent = artifact.length;
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
    });
    refreshPortDefinition = fixturePort({
      id: INSTALL_REFRESH_FIXTURE_PORT_ID,
      name: INSTALL_REFRESH_FIXTURE_NAME,
      summary: "Isolated committed install and workspace refresh recovery fixture.",
      ...contract,
      url,
      artifact,
    });
    const portDefinitions = [portDefinition, refreshPortDefinition];
    const baseCatalog = JSON.parse(
      await readFile(path.join(root, "crates", "portcove-core", "catalog", "catalog.json"), "utf8"),
    );
    for (const definition of portDefinitions) {
      if (baseCatalog.ports.some((item) => item.id === definition.id))
        throw new Error(`${definition.id} unexpectedly exists in the maintained catalog`);
    }
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
    artifact,
    artifactPath,
    catalogPath,
    port: portDefinition,
    refreshPort: refreshPortDefinition,
    requests,
    url,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
