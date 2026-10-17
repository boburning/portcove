import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errorCode, isRecord } from "./runtime-values.mts";

export interface ResourceConfiguration {
  slots: number;
  waitMs: number;
  legacyRoots: string[];
  legacyMode: "pending" | "coordinated";
}

// Same-user identity is independent of checkout, pins and writable cache settings.
export function resourceDomainRoot() {
  return path.join(homedir(), ".portcove", "resources");
}

export async function resourceConfiguration(root = resourceDomainRoot()) {
  let supplied: unknown = {};
  try {
    supplied = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (!isRecord(supplied)) throw new Error("Resource config must be an object");
  const config: unknown = {
    slots: 2,
    waitMs: 900_000,
    legacyRoots: [],
    legacyMode: "pending",
    ...supplied,
  };
  function assertConfiguration(config: unknown): asserts config is ResourceConfiguration {
    if (
      !isRecord(config) ||
      Object.keys(config).some(
        (key) => !["slots", "waitMs", "legacyRoots", "legacyMode"].includes(key),
      ) ||
      (config.legacyMode !== "pending" && config.legacyMode !== "coordinated") ||
      typeof config.slots !== "number" ||
      !Number.isInteger(config.slots) ||
      config.slots < 1 ||
      config.slots > 8 ||
      typeof config.waitMs !== "number" ||
      !Number.isInteger(config.waitMs) ||
      config.waitMs < 0 ||
      config.waitMs > 3_600_000 ||
      !Array.isArray(config.legacyRoots) ||
      config.legacyRoots.some(
        (value: unknown) => typeof value !== "string" || !path.isAbsolute(value),
      )
    )
      throw new Error(
        "Resource config requires slots 1..8, waitMs 0..3600000 and absolute legacyRoots",
      );
  }
  assertConfiguration(config);
  return config;
}
