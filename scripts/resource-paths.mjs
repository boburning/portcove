import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Same-user identity is independent of checkout, pins and writable cache settings.
export function resourceDomainRoot() {
  return path.join(homedir(), ".portcove", "resources");
}

export async function resourceConfiguration(root = resourceDomainRoot()) {
  let supplied = {};
  try {
    supplied = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const config = {
    slots: 2,
    waitMs: 900_000,
    legacyRoots: [],
    legacyMode: "pending",
    ...supplied,
  };
  if (
    Object.keys(config).some(
      (key) => !["slots", "waitMs", "legacyRoots", "legacyMode"].includes(key),
    ) ||
    !["pending", "coordinated"].includes(config.legacyMode) ||
    !Number.isInteger(config.slots) ||
    config.slots < 1 ||
    config.slots > 8 ||
    !Number.isInteger(config.waitMs) ||
    config.waitMs < 0 ||
    config.waitMs > 3_600_000 ||
    !Array.isArray(config.legacyRoots) ||
    config.legacyRoots.some((value) => typeof value !== "string" || !path.isAbsolute(value))
  )
    throw new Error(
      "Resource config requires slots 1..8, waitMs 0..3600000 and absolute legacyRoots",
    );
  return config;
}
