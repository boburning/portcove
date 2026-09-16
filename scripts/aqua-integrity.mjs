import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const releasePrefix = "github_release/github.com/";

function actionlintAssets(version) {
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

function shellcheckAssets(version) {
  return [
    `shellcheck-${version}.darwin.aarch64.tar.xz`,
    `shellcheck-${version}.darwin.x86_64.tar.xz`,
    `shellcheck-${version}.linux.aarch64.tar.xz`,
    `shellcheck-${version}.linux.x86_64.tar.xz`,
    `shellcheck-${version}.zip`,
  ];
}

const assetInventories = {
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
};

function exactUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

export function parseAquaConfig(contents) {
  const normalized = contents.replaceAll("\r\n", "\n");
  const structure =
    /^# yaml-language-server: \$schema=https:\/\/raw\.githubusercontent\.com\/aquaproj\/aqua\/main\/json-schema\/aqua-yaml\.json\nregistries:\n  - type: standard\n    ref: (\S+)\n\nchecksum:\n  enabled: true\n  require_checksum: true\n\npackages:\n((?:  - name: [^@\s]+@\S+\n?)+)$/u.exec(
      normalized,
    );
  if (!structure)
    throw new Error(
      "aqua.yaml must use the maintained standard registry, required checksums, and default package authority only",
    );
  const packages = [...structure[2].matchAll(/^ {2}- name: ([^@\s]+)@(\S+)$/gmu)].map(
    ([, name, version]) => ({ name, version }),
  );
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
  return { registryRef: structure[1], packages };
}

export function parseReleaseChecksumId(id) {
  if (!id.startsWith(releasePrefix)) return null;
  const match = /^github_release\/github\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/u.exec(id);
  if (!match) throw new Error(`invalid GitHub release checksum identity: ${id}`);
  return { name: `${match[1]}/${match[2]}`, version: match[3], asset: match[4] };
}

function expectedReleaseIdentities(config) {
  return config.packages.flatMap(({ name, version }) =>
    assetInventories[name](version).map((asset) => `${releasePrefix}${name}/${version}/${asset}`),
  );
}

function expectedRegistryIdentity(config) {
  return `registries/github_content/github.com/aquaproj/aqua-registry/${config.registryRef}/registry.yaml`;
}

export function validateAquaChecksumLedger(config, ledger) {
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

export function validateAquaChecksumEntries(ledger) {
  if (!ledger || Object.keys(ledger).length !== 1 || !Array.isArray(ledger.checksums))
    throw new Error("aqua-checksums.json must contain only a checksums array");
  const ids = ledger.checksums.map(({ id }) => id);
  exactUnique(ids, "Aqua checksum identities");
  for (const entry of ledger.checksums) {
    if (entry.algorithm !== "sha256" || !/^[A-F0-9]{64}$/u.test(entry.checksum))
      throw new Error(`invalid SHA-256 checksum entry: ${entry.id}`);
  }
}

export function verifyPublisherDigests(entries, releases) {
  for (const entry of entries) {
    const identity = parseReleaseChecksumId(entry.id);
    const release = releases[`${identity.name}@${identity.version}`];
    if (!release || release.tag_name !== identity.version || !Array.isArray(release.assets))
      throw new Error(
        `publisher release metadata is missing for ${identity.name}@${identity.version}`,
      );
    const matches = release.assets.filter(({ name }) => name === identity.asset);
    if (matches.length !== 1)
      throw new Error(
        `publisher asset is missing or ambiguous: ${identity.name}/${identity.asset}`,
      );
    const digest = matches[0].digest;
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error(`publisher SHA-256 digest is missing for ${identity.name}/${identity.asset}`);
    if (digest.slice("sha256:".length).toUpperCase() !== entry.checksum)
      throw new Error(`publisher SHA-256 digest differs for ${identity.name}/${identity.asset}`);
  }
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${arguments_.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  return result.stdout.trim();
}

function assertPinnedAquaVersion(expected) {
  const output = run("aqua", ["-v"]);
  const actual = /^aqua version (\S+)$/mu.exec(output)?.[1];
  if (`v${actual}` !== expected)
    throw new Error(
      `aqua ${expected} is required; installed command reported ${actual ?? "unknown"}`,
    );
}

function releaseMetadata(config) {
  return Object.fromEntries(
    config.packages.map(({ name, version }) => {
      const output = run("gh", [
        "api",
        "--method",
        "GET",
        `repos/${name}/releases/tags/${encodeURIComponent(version)}`,
      ]);
      return [`${name}@${version}`, JSON.parse(output)];
    }),
  );
}

function stableNonReleaseEntries(ledger) {
  return ledger.checksums
    .filter(({ id }) => !id.startsWith(releasePrefix))
    .map(({ id, checksum, algorithm }) => ({ id, checksum, algorithm }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function requireStableNonReleaseEntries(previous, generated) {
  if (
    JSON.stringify(stableNonReleaseEntries(previous)) !==
    JSON.stringify(stableNonReleaseEntries(generated))
  )
    throw new Error("non-release Aqua checksum authority changed; review it separately");
}

export function requireUnchangedInputs(expected, observed) {
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
  const ledger = JSON.parse(ledgerText);
  validateAquaChecksumEntries(ledger);
  const releaseEntries = validateInventory ? validateAquaChecksumLedger(config, ledger) : [];
  return { configText, ledgerText, config, ledger, releaseEntries };
}

async function update() {
  const current = await loadCurrent(false);
  const aquaVersion = (await readFile(path.join(projectRoot, ".aqua-version"), "utf8")).trim();
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
    run("aqua", ["--config", stagedConfig, "update-checksum", "--prune"], {
      cwd: temporary,
      env: {
        ...process.env,
        AQUA_ROOT_DIR: path.join(temporary, "aqua-root"),
        AQUA_ENFORCE_CHECKSUM: "true",
        AQUA_ENFORCE_REQUIRE_CHECKSUM: "true",
      },
    });
    const generatedText = await readFile(stagedLedger, "utf8");
    const generated = JSON.parse(generatedText);
    const releaseEntries = validateAquaChecksumLedger(current.config, generated);
    requireStableNonReleaseEntries(current.ledger, generated);
    verifyPublisherDigests(releaseEntries, releaseMetadata(current.config));

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

async function main(argv) {
  if (argv.length !== 1 || !["--check", "--update"].includes(argv[0]))
    throw new Error("usage: aqua-integrity.mjs --check|--update");
  if (argv[0] === "--check") {
    const current = await loadCurrent();
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
