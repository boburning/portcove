import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectApplicationRelease } from "../apps/desktop/scripts/release-version-policy.mts";

const scriptPath = fileURLToPath(import.meta.url);

export function selectReleaseForChannel<Release>(
  releases: readonly Release[],
  channel: unknown,
  options?: unknown,
): Release | null;
export function selectReleaseForChannel(
  releases: unknown,
  channel: unknown,
  options?: unknown,
): unknown;
export function selectReleaseForChannel(
  releases: unknown,
  channel: unknown,
  options: unknown = {},
) {
  return selectApplicationRelease(releases, channel, options);
}

const flags = ["channel", "input", "eligibility", "current-version", "target"] as const;
function parseArguments(argv: readonly string[]) {
  const options: Partial<Record<(typeof flags)[number], string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const rawKey = argv[index]?.replace(/^--/, "");
    const key = flags.find((flag) => flag === rawKey);
    const value = argv[index + 1];
    if (key === undefined || options[key] !== undefined || !value)
      throw new Error("invalid or duplicate release selection argument");
    options[key] = value;
  }
  if (!options.channel || !options.input)
    throw new Error(
      "usage: select-release-channel.mts --channel preview|stable --input releases.json [--eligibility evidence.json] [--current-version VERSION] [--target TARGET]",
    );
  return { ...options, channel: options.channel, input: options.input };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const releases: unknown = JSON.parse(await readFile(options.input, "utf8"));
  const eligibility: unknown = options.eligibility
    ? JSON.parse(await readFile(options.eligibility, "utf8"))
    : undefined;
  const selected = selectReleaseForChannel(releases, options.channel, {
    eligibility,
    currentVersion: options["current-version"],
    target: options.target,
  });
  if (!selected) {
    console.error(`No published ${options.channel} release is available.`);
    process.exitCode = 4;
  } else {
    console.log(JSON.stringify(selected));
  }
}
