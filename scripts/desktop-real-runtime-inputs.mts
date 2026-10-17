import assert from "node:assert/strict";
import path from "node:path";
import { isRecord } from "./runtime-values.mts";

const pilotIds = ["wave-race-64-recomp", "wave-race-64-racewave46"] as const;
type PilotId = (typeof pilotIds)[number];
interface PackageInput {
  port_id: PilotId;
  directory: string;
  archive: string;
}
interface RealInput {
  format_version: 1;
  source: string;
  packages: PackageInput[];
}

export function absoluteRealRuntimeInputPath(value: unknown) {
  assert.ok(typeof value === "string" && path.isAbsolute(value), "Input paths must be absolute");
  return value;
}

export function parseRealRuntimeInput(value: unknown): RealInput {
  assert.ok(isRecord(value) && value.format_version === 1 && Array.isArray(value.packages));
  assert.deepEqual(Object.keys(value).sort(), ["format_version", "packages", "source"]);
  assert.equal(
    value.packages.length,
    pilotIds.length,
    "Qualify the two selected distinct real routes",
  );
  const packages = value.packages.map((entry: unknown) => {
    assert.ok(isRecord(entry));
    assert.deepEqual(Object.keys(entry).sort(), ["archive", "directory", "port_id"]);
    assert.ok(pilotIds.some((id) => id === entry.port_id));
    return {
      port_id: entry.port_id as PilotId,
      directory: absoluteRealRuntimeInputPath(entry.directory),
      archive: absoluteRealRuntimeInputPath(entry.archive),
    };
  });
  assert.deepEqual(packages.map((entry) => entry.port_id).sort(), [...pilotIds].sort());
  return { format_version: 1, source: absoluteRealRuntimeInputPath(value.source), packages };
}

export function runtimeMutable(relative: string, mutable: readonly string[]) {
  const name = relative.replaceAll("\\", "/").toLowerCase();
  return mutable.some((entry) => {
    const prefix = entry.replaceAll("\\", "/").toLowerCase();
    return name === prefix || name.startsWith(`${prefix}/`);
  });
}
