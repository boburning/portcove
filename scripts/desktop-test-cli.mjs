import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readToolPins } from "./tool-cache.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "usage: just desktop-test --app ABSOLUTE --output ABSOLUTE [--driver ABSOLUTE] [--native-driver ABSOLUTE] [options]",
  );
  console.log("Cached drivers are used when --driver and --native-driver are omitted.");
  console.log("Select with --profile PROFILE or repeat --scenario ID for an exact series.");
  console.log(
    "Legacy focused modes remain: --accessibility-only, --artwork-only, --adoption-only.",
  );
} else {
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    createRequire(path.join(root, "apps", "desktop", "package.json")).resolve("selenium-webdriver");
  } catch {
    throw new Error(
      `selenium-webdriver is unavailable; run node scripts/dev-storage.mjs run -- corepack ${readToolPins().packageManager} --dir apps/desktop install --frozen-lockfile`,
    );
  }
  await import("../apps/desktop/scripts/desktop-test.mjs");
}
