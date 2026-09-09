import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectApplicationRelease } from "../apps/desktop/scripts/release-version-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);

export function selectReleaseForChannel(releases, channel, options = {}) {
  return selectApplicationRelease(releases, channel, options);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    if (!["channel", "input", "eligibility", "current-version", "target"].includes(key)
        || options[key] !== undefined || !argv[index + 1]) throw new Error("invalid or duplicate release selection argument");
    options[key] = argv[index + 1];
  }
  if (!options.channel || !options.input) throw new Error("usage: select-release-channel.mjs --channel preview|stable --input releases.json [--eligibility evidence.json] [--current-version VERSION] [--target TARGET]");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const selected = selectReleaseForChannel(JSON.parse(await readFile(options.input, "utf8")), options.channel, {
    eligibility: options.eligibility ? JSON.parse(await readFile(options.eligibility, "utf8")) : undefined,
    currentVersion: options["current-version"], target: options.target,
  });
  if (!selected) {
    console.error(`No published ${options.channel} release is available.`);
    process.exitCode = 4;
  } else {
    console.log(JSON.stringify(selected));
  }
}
