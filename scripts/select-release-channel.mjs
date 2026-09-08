import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

function releaseField(release, camel, snake) {
  return release[camel] ?? release[snake];
}

export function selectReleaseForChannel(releases, channel) {
  if (!["preview", "stable"].includes(channel)) throw new Error(`unknown release channel: ${channel}`);
  if (!Array.isArray(releases)) throw new Error("release response must be an array");
  const prerelease = channel === "preview";
  const candidates = releases.filter(release => {
    const draft = releaseField(release, "isDraft", "draft");
    const preview = releaseField(release, "isPrerelease", "prerelease");
    return draft === false && preview === prerelease && releaseField(release, "tagName", "tag_name");
  }).map(release => {
    const publishedAt = releaseField(release, "publishedAt", "published_at");
    const publishedTime = Date.parse(publishedAt ?? "");
    if (Number.isNaN(publishedTime)) {
      throw new Error(`published ${channel} release has an invalid published timestamp: ${publishedAt ?? "missing"}`);
    }
    return { release, publishedTime };
  });
  candidates.sort((left, right) => {
    const byTime = right.publishedTime - left.publishedTime;
    if (byTime !== 0) return byTime;
    return String(releaseField(right.release, "tagName", "tag_name"))
      .localeCompare(String(releaseField(left.release, "tagName", "tag_name")));
  });
  return candidates[0]?.release ?? null;
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== "--channel" || argv[2] !== "--input") {
    throw new Error("usage: select-release-channel.mjs --channel preview|stable --input releases.json");
  }
  return { channel: argv[1], input: path.resolve(argv[3]) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const selected = selectReleaseForChannel(JSON.parse(await readFile(options.input, "utf8")), options.channel);
  if (!selected) {
    console.error(`No published ${options.channel} release is available.`);
    process.exitCode = 4;
  } else {
    console.log(JSON.stringify(selected));
  }
}
