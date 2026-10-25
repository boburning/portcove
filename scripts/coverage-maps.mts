import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord, errorCode } from "./runtime-values.mts";
import {
  assertCoverageCustody,
  boundedCoverageRead,
  type CoveragePacket,
} from "./test-coverage-config.mts";
import type { Vitest } from "vite-plus/test/node";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const key = (file: string) =>
  process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

export function retainCoverageMap(
  packet: CoveragePacket,
  file: string,
  code: string,
  mapping: unknown,
  scope: string,
) {
  assertCoverageCustody(packet);
  const selected = packet.request.modules.find(
    (module) => key(path.join(packet.root, module)) === key(file),
  );
  if (!selected) return;
  if (Buffer.byteLength(code) > 1024 * 1024)
    throw new Error("Coverage transform exceeds byte limit");
  const map = JSON.stringify(mapping, null, 2) + "\n";
  if (Buffer.byteLength(map) > 2 * 1024 * 1024)
    throw new Error("Coverage source map exceeds byte limit");
  const original = boundedCoverageRead(path.join(packet.root, selected), 1024 * 1024);
  if (
    scope.startsWith("vitest-v8-remapper:") &&
    (!isRecord(mapping) ||
      mapping.version !== 3 ||
      !Array.isArray(mapping.sourcesContent) ||
      !mapping.sourcesContent.includes(original.toString("utf8")))
  )
    throw new Error("Frontend source map does not bind the selected original source");
  // Exclusive slots bound all workers together: 64 observations / 192 MiB of code+maps.
  let directory: string | undefined;
  for (let index = 0; index < 64; index++) {
    const candidate = path.join(packet.directory, "maps", String(index).padStart(2, "0"));
    try {
      mkdirSync(candidate);
      directory = candidate;
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  if (!directory) throw new Error("Coverage mapping observation limit exceeded");
  writeFileSync(path.join(directory, "generated.js"), code, { flag: "wx" });
  writeFileSync(path.join(directory, "source-map.json"), map, { flag: "wx" });
  writeFileSync(
    path.join(directory, "identity.json"),
    JSON.stringify(
      {
        file: selected,
        scope,
        original_sha256: hash(original),
        generated_sha256: hash(code),
        map_sha256: hash(map),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}

export function readCoverageMaps(packet: CoveragePacket) {
  assertCoverageCustody(packet);
  const maps = path.join(packet.directory, "maps");
  if (readdirSync(packet.directory).some((file) => /^mapping-failure-\d+\.json$/u.test(file)))
    throw new Error("Coverage mapping observation failed; retained mapping-failure evidence");
  const entries = readdirSync(maps);
  if (entries.length > 64) throw new Error("Coverage mapping observation limit exceeded");
  const observations = entries.map((id) => {
    if (!/^(?:[0-5]\d|6[0-3])$/u.test(id)) throw new Error("Invalid coverage map observation");
    const directory = path.join(maps, id);
    const identity: unknown = JSON.parse(
      boundedCoverageRead(path.join(directory, "identity.json"), 64 * 1024).toString("utf8"),
    );
    const generated = boundedCoverageRead(path.join(directory, "generated.js"), 1024 * 1024);
    const mapping = boundedCoverageRead(path.join(directory, "source-map.json"), 2 * 1024 * 1024);
    if (
      !isRecord(identity) ||
      typeof identity.file !== "string" ||
      !packet.request.modules.includes(identity.file) ||
      identity.original_sha256 !==
        hash(boundedCoverageRead(path.join(packet.root, identity.file), 1024 * 1024)) ||
      identity.generated_sha256 !== hash(generated) ||
      identity.map_sha256 !== hash(mapping)
    )
      throw new Error("Coverage source map identity mismatch");
    return { directory, ...identity, file: identity.file };
  });
  for (const file of packet.request.modules)
    if (!observations.some((observation) => observation.file === file))
      throw new Error(`Missing source mapping: ${file}`);
  return observations;
}

/** Retain the exact transform/map returned to the maintained V8 remapper. */
export async function retainFrontendCoverageMaps(packet: CoveragePacket, runner: Vitest) {
  const { BaseCoverageProvider } = await import("vite-plus/test/node");
  const provider: unknown = Reflect.get(runner, "coverageProvider");
  if (!(provider instanceof BaseCoverageProvider))
    throw new Error("Coverage provider has no supported transform mapping boundary");
  const transform = provider.transformFile.bind(provider);
  provider.transformFile = async (...args: Parameters<typeof transform>) => {
    const result = await transform(...args);
    if (result && result.map)
      retainCoverageMap(packet, args[0], result.code, result.map, `vitest-v8-remapper:${args[2]}`);
    return result;
  };
}
