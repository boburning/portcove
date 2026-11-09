import { parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createGitHubClient } from "./github-client.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAqua } from "./tool-cache.mts";

export interface AquaChecksumEntry {
  id: string;
  checksum: string;
  algorithm: "sha256";
}
export interface AquaChecksumLedger {
  checksums: AquaChecksumEntry[];
}
type AquaConfig = ReturnType<typeof parseAquaConfig>;
interface AquaInputText {
  configText: string;
  ledgerText: string;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const releasePrefix = "github_release/github.com/";

function actionlintAssets(version: string) {
  const number = version.replace(/^v/u, "");
  return [
    `actionlint_${number}_darwin_amd64.tar.gz`,
    `actionlint_${number}_darwin_arm64.tar.gz`,
    `actionlint_${number}_linux_amd64.tar.gz`,
    `actionlint_${number}_linux_arm64.tar.gz`,
    `actionlint_${number}_windows_amd64.zip`,
    `actionlint_${number}_windows_arm64.zip`,
  ];
}

function shellcheckAssets(version: string) {
  return [
    `shellcheck-${version}.darwin.aarch64.tar.xz`,
    `shellcheck-${version}.darwin.x86_64.tar.xz`,
    `shellcheck-${version}.linux.aarch64.tar.xz`,
    `shellcheck-${version}.linux.x86_64.tar.xz`,
    `shellcheck-${version}.zip`,
  ];
}

const assetInventories: Readonly<Record<string, (version: string) => string[]>> = {
  "astral-sh/ruff": () => [
    "ruff-aarch64-apple-darwin.tar.gz",
    "ruff-aarch64-pc-windows-msvc.zip",
    "ruff-aarch64-unknown-linux-musl.tar.gz",
    "ruff-x86_64-apple-darwin.tar.gz",
    "ruff-x86_64-pc-windows-msvc.zip",
    "ruff-x86_64-unknown-linux-musl.tar.gz",
  ],
  "rhysd/actionlint": actionlintAssets,
  "koalaman/shellcheck": shellcheckAssets,
  // Recovery-only configuration. Ordinary aqua.yaml does not appoint these tools.
  "FiloSottile/age": (version) => [
    `age-${version}-linux-amd64.tar.gz`,
    `age-${version}-windows-amd64.zip`,
  ],
  "cli/cli": (version) => [
    `gh_${version.replace(/^v/u, "")}_linux_amd64.tar.gz`,
    `gh_${version.replace(/^v/u, "")}_windows_amd64.zip`,
  ],
};

function exactUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

export function parseAquaConfig(contents: string) {
  if (Buffer.byteLength(contents, "utf8") > 64 * 1024)
    throw new Error("aqua.yaml exceeds the 64 KiB configuration limit");
  const document = parseDocument(contents, { uniqueKeys: true, version: "1.2" });
  if (
    document.errors.length ||
    document.warnings.length ||
    document.directives?.yaml.version !== "1.2"
  )
    throw new Error("Invalid or unsupported Aqua YAML", {
      cause: document.errors[0] ?? document.warnings[0],
    });
  const config: unknown = document.toJS({ maxAliasCount: 0 });
  const policyError = () =>
    new Error(
      "aqua.yaml must use the maintained standard registry, required checksums, and default package authority only",
    );
  const hasKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  if (
    !hasKeys(config, ["registries", "checksum", "packages"]) ||
    !Array.isArray(config.registries) ||
    config.registries.length !== 1 ||
    !hasKeys(config.registries[0], ["type", "ref"]) ||
    config.registries[0].type !== "standard" ||
    typeof config.registries[0].ref !== "string" ||
    !/^\S+$/u.test(config.registries[0].ref) ||
    !hasKeys(config.checksum, ["enabled", "require_checksum"]) ||
    config.checksum.enabled !== true ||
    config.checksum.require_checksum !== true ||
    !Array.isArray(config.packages)
  )
    throw policyError();
  const registryRef = config.registries[0].ref;
  const packages = config.packages.map((entry: unknown) => {
    if (!hasKeys(entry, ["name"]) || typeof entry.name !== "string") throw policyError();
    const match = /^([^@\s]+)@(\S+)$/u.exec(entry.name);
    if (!match) throw policyError();
    return { name: match[1]!, version: match[2]! };
  });
  if (!packages.length) throw new Error("aqua.yaml must define at least one package");
  exactUnique(
    packages.map(({ name }) => name),
    "aqua package inventory",
  );
  for (const { name, version } of packages) {
    if (!/^[^/]+\/[^/]+$/u.test(name))
      throw new Error(`unsupported Aqua package identity: ${name}`);
    if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version))
      throw new Error(`${name} must use an exact version`);
    if (!assetInventories[name]) throw new Error(`no maintained platform inventory for ${name}`);
  }
  return { registryRef, packages };
}

export function parseReleaseChecksumId(id: string) {
  if (!id.startsWith(releasePrefix)) return null;
  const match = /^github_release\/github\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/u.exec(id);
  if (!match) throw new Error(`invalid GitHub release checksum identity: ${id}`);
  return { name: `${match[1]}/${match[2]}`, version: match[3] ?? "", asset: match[4] ?? "" };
}

function expectedReleaseIdentities(config: AquaConfig) {
  return config.packages.flatMap(({ name, version }) =>
    (
      assetInventories[name] ??
      (() => {
        throw new Error(`no maintained platform inventory for ${name}`);
      })
    )(version).map((asset) => `${releasePrefix}${name}/${version}/${asset}`),
  );
}

function expectedRegistryIdentity(config: AquaConfig) {
  return `registries/github_content/github.com/aquaproj/aqua-registry/${config.registryRef}/registry.yaml`;
}

export function validateAquaChecksumLedger(
  config: AquaConfig,
  ledger: unknown,
): AquaChecksumEntry[] {
  validateAquaChecksumEntries(ledger);
  const ids = ledger.checksums.map(({ id }) => id);

  const expected = [...expectedReleaseIdentities(config), expectedRegistryIdentity(config)].sort();
  const actual = [...ids].sort();
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Aqua checksum inventory drifted` +
        `${missing.length ? `; missing: ${missing.join(", ")}` : ""}` +
        `${unexpected.length ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
    );
  }
  return ledger.checksums.filter(({ id }) => id.startsWith(releasePrefix));
}

export function validateAquaChecksumEntries(ledger: unknown): asserts ledger is AquaChecksumLedger {
  if (!isRecord(ledger) || Object.keys(ledger).length !== 1 || !Array.isArray(ledger.checksums))
    throw new Error("aqua-checksums.json must contain only a checksums array");
  const entries: unknown[] = ledger.checksums;
  const ids = entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id)
      throw new Error("invalid Aqua checksum identity");
    return entry.id;
  });
  exactUnique(ids, "Aqua checksum identities");
  for (const entry of entries) {
    if (!isRecord(entry)) throw new Error("invalid Aqua checksum entry");
    if (
      entry.algorithm !== "sha256" ||
      typeof entry.checksum !== "string" ||
      !/^[A-F0-9]{64}$/u.test(entry.checksum)
    )
      throw new Error(`invalid SHA-256 checksum entry: ${String(entry.id)}`);
  }
}

export function verifyPublisherDigests(entries: readonly AquaChecksumEntry[], releases: unknown) {
  for (const entry of entries) {
    const identity = parseReleaseChecksumId(entry.id);
    if (!identity) throw new Error("publisher comparison requires a release checksum identity");
    const release = isRecord(releases)
      ? releases[`${identity.name}@${identity.version}`]
      : undefined;
    if (
      !isRecord(release) ||
      release.tag_name !== identity.version ||
      !Array.isArray(release.assets)
    )
      throw new Error(
        `publisher release metadata is missing for ${identity.name}@${identity.version}`,
      );
    const assets: unknown[] = release.assets;
    const matches = assets
      .map((asset) => {
        if (!isRecord(asset)) throw new Error("publisher release asset metadata is invalid");
        return asset;
      })
      .filter((asset) => asset.name === identity.asset);
    if (matches.length !== 1)
      throw new Error(
        `publisher asset is missing or ambiguous: ${identity.name}/${identity.asset}`,
      );
    const digest = matches[0]?.digest;
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error(`publisher SHA-256 digest is missing for ${identity.name}/${identity.asset}`);
    if (digest.slice("sha256:".length).toUpperCase() !== entry.checksum)
      throw new Error(`publisher SHA-256 digest differs for ${identity.name}/${identity.asset}`);
  }
}

function run(
  arguments_: string[],
  options: Pick<SpawnSyncOptionsWithStringEncoding, "cwd" | "env"> = {},
) {
  const settings: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    windowsHide: true,
  };
  const result = runAqua(arguments_, settings);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `aqua ${arguments_.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result.stdout.trim();
}

function assertPinnedAquaVersion(expected: string) {
  const output = run(["-v"]);
  const actual = /^aqua version (\S+)$/mu.exec(output)?.[1];
  if (`v${actual}` !== expected)
    throw new Error(
      `aqua ${expected} is required; installed command reported ${actual ?? "unknown"}`,
    );
}

async function releaseMetadata(config: AquaConfig) {
  const deadline = performance.now() + 120_000;
  const client = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    allowRequest: (method, url) =>
      method === "GET" &&
      config.packages.some(
        ({ name, version }) =>
          url.pathname === `/repos/${name}/releases/tags/${encodeURIComponent(version)}`,
      ),
  });
  const entries: [string, unknown][] = [];
  for (const { name, version } of config.packages) {
    const response = await client.request("GET /repos/{owner}/{repo}/releases/tags/{tag}", {
      owner: name.split("/")[0]!,
      repo: name.split("/")[1]!,
      tag: version,
      request: { portcove: { replay: "safe-read", attempts: 0 } },
    });
    entries.push([`${name}@${version}`, response.data]);
  }
  return Object.fromEntries(entries);
}

/**
 * Derive the pinned Aqua executable identity from its publisher release. Only
 * fields already recorded for a platform are refreshed, so the bootstrap shape
 * stays reviewed while version, asset id, size and digest follow `.aqua-version`.
 */
export function deriveAquaBootstrap(bootstrap: unknown, version: string, release: unknown) {
  if (
    !isRecord(bootstrap) ||
    !isRecord(bootstrap.aqua) ||
    !isRecord(bootstrap.aqua.artifacts) ||
    !/^v\d+\.\d+\.\d+$/u.test(version)
  )
    throw new Error("tool bootstrap must record an Aqua version and artifacts");
  if (!isRecord(release) || release.tag_name !== version || !Array.isArray(release.assets))
    throw new Error(`publisher release metadata is missing for aquaproj/aqua@${version}`);
  const assets: unknown[] = release.assets;
  const artifacts: Record<string, unknown> = {};
  for (const [platform, recorded] of Object.entries(bootstrap.aqua.artifacts)) {
    if (!isRecord(recorded) || typeof recorded.archive !== "string")
      throw new Error(`tool bootstrap Aqua artifact is invalid: ${platform}`);
    const matches = assets.filter((asset) => isRecord(asset) && asset.name === recorded.archive);
    const asset = matches[0];
    if (matches.length !== 1 || !isRecord(asset))
      throw new Error(`publisher asset is missing or ambiguous: aquaproj/aqua/${recorded.archive}`);
    const digest = asset.digest;
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error(`publisher SHA-256 digest is missing for aquaproj/aqua/${recorded.archive}`);
    const refreshed: Record<string, unknown> = { ...recorded };
    if ("asset_id" in recorded) {
      if (!Number.isSafeInteger(asset.id) || Number(asset.id) <= 0)
        throw new Error(`publisher asset id is invalid for aquaproj/aqua/${recorded.archive}`);
      refreshed.asset_id = asset.id;
    }
    if ("bytes" in recorded) {
      if (!Number.isSafeInteger(asset.size) || Number(asset.size) <= 0)
        throw new Error(`publisher asset size is invalid for aquaproj/aqua/${recorded.archive}`);
      refreshed.bytes = asset.size;
    }
    refreshed.sha256 = digest.slice("sha256:".length).toUpperCase();
    artifacts[platform] = refreshed;
  }
  return { ...bootstrap, aqua: { ...bootstrap.aqua, artifacts, version } };
}

async function aquaReleaseMetadata(version: string) {
  const deadline = performance.now() + 120_000;
  const client = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    allowRequest: (method, url) =>
      method === "GET" &&
      url.pathname === `/repos/aquaproj/aqua/releases/tags/${encodeURIComponent(version)}`,
  });
  const response = await client.request("GET /repos/{owner}/{repo}/releases/tags/{tag}", {
    owner: "aquaproj",
    repo: "aqua",
    tag: version,
    request: { portcove: { replay: "safe-read", attempts: 0 } },
  });
  return response.data;
}

async function updateBootstrap(version: string) {
  const file = path.join(projectRoot, ".config", "tool-bootstrap.json");
  const text = await readFile(file, "utf8");
  const derived = deriveAquaBootstrap(
    JSON.parse(text),
    version,
    await aquaReleaseMetadata(version),
  );
  const next = `${JSON.stringify(derived, null, 2)}\n`;
  if (next === text) return false;
  const promotion = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(promotion, next, "utf8");
    if ((await readFile(file, "utf8")) !== text)
      throw new Error(
        ".config/tool-bootstrap.json changed while Aqua identity repair was running; retry",
      );
    await rename(promotion, file);
  } finally {
    await rm(promotion, { force: true });
  }
  return true;
}

function stableNonReleaseEntries(ledger: AquaChecksumLedger) {
  return ledger.checksums
    .filter(({ id }) => !id.startsWith(releasePrefix))
    .map(({ id, checksum, algorithm }) => ({ id, checksum, algorithm }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function requireStableNonReleaseEntries(previous: unknown, generated: unknown) {
  validateAquaChecksumEntries(previous);
  validateAquaChecksumEntries(generated);
  if (
    JSON.stringify(stableNonReleaseEntries(previous)) !==
    JSON.stringify(stableNonReleaseEntries(generated))
  )
    throw new Error("non-release Aqua checksum authority changed; review it separately");
}

export function requireUnchangedInputs(expected: AquaInputText, observed: AquaInputText) {
  if (observed.configText !== expected.configText)
    throw new Error(
      "aqua.yaml changed while checksum repair was running; retry from current files",
    );
  if (observed.ledgerText !== expected.ledgerText)
    throw new Error(
      "aqua-checksums.json changed while checksum repair was running; retry from current files",
    );
}

async function loadCurrent(validateInventory = true) {
  const configText = await readFile(path.join(projectRoot, "aqua.yaml"), "utf8");
  const ledgerText = await readFile(path.join(projectRoot, "aqua-checksums.json"), "utf8");
  const config = parseAquaConfig(configText);
  const ledger: unknown = JSON.parse(ledgerText);
  validateAquaChecksumEntries(ledger);
  const releaseEntries = validateInventory ? validateAquaChecksumLedger(config, ledger) : [];
  return { configText, ledgerText, config, ledger, releaseEntries };
}

async function update() {
  const current = await loadCurrent(false);
  const aquaVersion = (await readFile(path.join(projectRoot, ".aqua-version"), "utf8")).trim();
  // The executable identity needs no installed Aqua, so a Renovate `.aqua-version`
  // bump is repaired before the pinned executable is required below.
  if (await updateBootstrap(aquaVersion))
    console.log(`Updated .config/tool-bootstrap.json to Aqua ${aquaVersion} publisher identity.`);
  assertPinnedAquaVersion(aquaVersion);

  const workRoot = path.join(projectRoot, "work");
  await mkdir(workRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(workRoot, "aqua-integrity-"));
  const stagedConfig = path.join(temporary, "aqua.yaml");
  const stagedLedger = path.join(temporary, "aqua-checksums.json");
  const promotion = path.join(projectRoot, `aqua-checksums.json.${process.pid}.tmp`);
  try {
    await copyFile(path.join(projectRoot, "aqua.yaml"), stagedConfig);
    await copyFile(path.join(projectRoot, "aqua-checksums.json"), stagedLedger);
    run(["--config", stagedConfig, "update-checksum", "--prune"], {
      cwd: temporary,
      env: {
        ...process.env,
        AQUA_ROOT_DIR: path.join(temporary, "aqua-root"),
        AQUA_ENFORCE_CHECKSUM: "true",
        AQUA_ENFORCE_REQUIRE_CHECKSUM: "true",
      },
    });
    const generatedText = await readFile(stagedLedger, "utf8");
    const generated: unknown = JSON.parse(generatedText);
    const releaseEntries = validateAquaChecksumLedger(current.config, generated);
    requireStableNonReleaseEntries(current.ledger, generated);
    verifyPublisherDigests(releaseEntries, await releaseMetadata(current.config));

    await copyFile(stagedLedger, promotion);
    requireUnchangedInputs(current, {
      configText: await readFile(path.join(projectRoot, "aqua.yaml"), "utf8"),
      ledgerText: await readFile(path.join(projectRoot, "aqua-checksums.json"), "utf8"),
    });
    await rename(promotion, path.join(projectRoot, "aqua-checksums.json"));
    console.log(
      `Updated ${releaseEntries.length} Aqua package checksums after publisher-digest verification.`,
    );
  } finally {
    await rm(promotion, { force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(argv: string[]) {
  if (argv.length !== 1 || !["--check", "--update"].includes(argv[0] ?? ""))
    throw new Error("usage: aqua-integrity.mts --check|--update");
  if (argv[0] === "--check") {
    const current = await loadCurrent();
    const aquaVersion = (await readFile(path.join(projectRoot, ".aqua-version"), "utf8")).trim();
    const bootstrap: unknown = JSON.parse(
      await readFile(path.join(projectRoot, ".config", "tool-bootstrap.json"), "utf8"),
    );
    if (!isRecord(bootstrap) || !isRecord(bootstrap.aqua) || bootstrap.aqua.version !== aquaVersion)
      throw new Error(
        `.config/tool-bootstrap.json does not record Aqua ${aquaVersion}; run just aqua-integrity-update`,
      );
    console.log(
      `Aqua package versions and ${current.releaseEntries.length} required platform checksums are synchronized.`,
    );
    return;
  }
  await update();
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main(process.argv.slice(2));
}
