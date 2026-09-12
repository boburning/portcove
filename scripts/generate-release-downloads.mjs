import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const startMarker = "<!-- portcove-downloads:start -->";
const endMarker = "<!-- portcove-downloads:end -->";

function validateInventory(inventory) {
  if (
    inventory?.schema_version !== 1 ||
    !inventory?.repository ||
    !inventory?.tag ||
    !inventory?.version
  ) {
    throw new Error("release inventory identity is incomplete");
  }
  if (inventory.tag !== `v${inventory.version}`)
    throw new Error("release inventory tag and version disagree");
  if (!Array.isArray(inventory.packages) || inventory.packages.length === 0)
    throw new Error("release inventory has no packages");
  if (
    inventory.sbom?.format !== "SPDX-2.3 JSON" ||
    !inventory.sbom.filename ||
    !inventory.sbom.download_url ||
    !/^[a-f0-9]{64}$/u.test(inventory.sbom.sha256 ?? "")
  ) {
    throw new Error("release inventory has no finalized SPDX SBOM");
  }
  const names = new Set();
  for (const entry of inventory.packages) {
    if (
      !entry.id ||
      !entry.interface ||
      !entry.display_label ||
      !entry.format_label ||
      !entry.download_url
    ) {
      throw new Error("release inventory package metadata is incomplete");
    }
    const name = entry.filename?.toLowerCase();
    if (!name || names.has(name))
      throw new Error(
        `release inventory has a missing or duplicate filename: ${entry.filename ?? "missing"}`,
      );
    names.add(name);
  }
}

function groupedDownloadLines(packages) {
  const groups = [];
  for (const entry of packages) {
    let group = groups.find((item) => item.display_label === entry.display_label);
    if (!group) {
      group = {
        display_label: entry.display_label,
        experimental: entry.experimental,
        entries: [],
      };
      groups.push(group);
    }
    if (group.experimental !== entry.experimental)
      throw new Error(`inconsistent experimental label for ${entry.display_label}`);
    group.entries.push(entry);
  }
  return groups
    .map((group) => {
      const qualification = group.experimental ? " (experimental)" : "";
      const links = group.entries
        .map((entry) => `[${entry.format_label}](${entry.download_url})`)
        .join(", ");
      return `- **${group.display_label}${qualification}:** ${links}`;
    })
    .join("\n");
}

function powershellExample(asset, manifest) {
  return `\`\`\`powershell
$asset = '${asset}'
$lines = @(Get-Content -LiteralPath '${manifest}' | Where-Object {
  $parts = $_ -split '  ', 2
  $parts.Count -eq 2 -and $parts[1] -ceq $asset
})
if ($lines.Count -ne 1) { throw "Expected exactly one checksum for $asset" }
$expected = ($lines[0] -split '  ', 2)[0]
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset).Hash.ToLowerInvariant()
if ($actual -cne $expected) { throw "SHA-256 mismatch for $asset" }
"Verified $asset"
\`\`\``;
}

function unixExample(asset, manifest, command) {
  return `\`\`\`bash
asset='${asset}'
line="$(awk -v name="$asset" '$2 == name { print }' '${manifest}')"
test "$(printf '%s\\n' "$line" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 1
printf '%s\\n' "$line" | ${command}
\`\`\``;
}

export function renderDownloadSection(inventory) {
  validateInventory(inventory);
  const desktop = inventory.packages.filter((entry) => entry.interface === "desktop");
  const cli = inventory.packages.filter((entry) => entry.interface === "cli");
  const windows = desktop.find((entry) => entry.os === "windows");
  const linux = desktop.find((entry) => entry.os === "linux" && entry.format === "appimage");
  const mac = desktop.find((entry) => entry.os === "macos" && entry.architecture === "aarch64");
  if (!windows || !linux || !mac) throw new Error("release inventory lacks verification examples");
  const preview = inventory.version.includes("-")
    ? "> [!WARNING]\n> **Technical preview.** Use a disposable or fully backed-up Portcove library. A matching checksum is not publisher identity or a malware assessment; keep operating-system protections enabled and review the signing, qualification, and upgrade limitations below."
    : "> [!NOTE]\n> Review the known limitations and upgrade guidance for this release before replacing an existing installation.";

  return `${startMarker}
${preview}

## Download the desktop app

${groupedDownloadLines(desktop)}

The desktop app is complete on its own; it does not require the separate CLI download. An AppImage is one experimental Linux option, not a universal Linux or Steam Deck compatibility claim.

## Command-line tools

${groupedDownloadLines(cli)}

These are standalone CLI archives for integrators and automation. They contain \`portcove\` (\`portcove.exe\` on Windows), not a portable graphical app. See the [CLI contract](https://github.com/${inventory.repository}/blob/${inventory.tag}/docs/CLI.md) and [integration guide](https://github.com/${inventory.repository}/blob/${inventory.tag}/docs/INTEGRATIONS.md). The desktop app does not shell out to this separate executable.

GitHub's automatically generated **Source code** archives are not application downloads; they require the development toolchain and a source build.

## Verify your download

Download [${inventory.checksum_manifest}](${inventory.checksum_url}) and only the package you selected. The manifest has exactly one SHA-256 entry for every application download.

PowerShell (Windows):

${powershellExample(windows.filename, inventory.checksum_manifest)}

Linux:

${unixExample(linux.filename, inventory.checksum_manifest, "sha256sum --check --strict -")}

macOS:

${unixExample(mac.filename, inventory.checksum_manifest, "shasum -a 256 --check -")}

The [SPDX 2.3 SBOM](${inventory.sbom.download_url}) inventories the release build context and is itself covered by \`${inventory.checksum_manifest}\`. GitHub build-provenance and SBOM attestations bind the final release payloads to this repository and workflow. Verify a downloaded package with \`gh attestation verify <FILE> --repo ${inventory.repository}\` in addition to checking its SHA-256.

A checksum proves that your bytes agree with the bytes listed in this release. An attestation binds those bytes to a workflow identity; neither is a malware assessment, operating-system signature, updater authorization, gameplay result, or platform-compatibility claim.
${endMarker}`;
}

export function mergeDownloadSection(reviewedBody, inventory) {
  const startCount = reviewedBody.split(startMarker).length - 1;
  const endCount = reviewedBody.split(endMarker).length - 1;
  if (startCount !== endCount || startCount > 1) {
    throw new Error("release body has incomplete or duplicate generated-download markers");
  }
  const withoutGenerated = (
    startCount === 1
      ? reviewedBody.replace(new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\s*`), "")
      : reviewedBody
  ).trim();
  const section = renderDownloadSection(inventory);
  const title = withoutGenerated.match(/^(# [^\r\n]+)(?:\r?\n+)([\s\S]*)$/);
  if (title) return `${title[1]}\n\n${section}\n\n${title[2].trim()}\n`;
  return `${section}${withoutGenerated ? `\n\n${withoutGenerated}` : ""}\n`;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--inventory", "--body", "--output"].includes(name) || !value) {
      throw new Error(
        "usage: generate-release-downloads.mjs --inventory PATH --body PATH --output PATH",
      );
    }
    options[name.slice(2)] = path.resolve(value);
  }
  if (!options.inventory || !options.body || !options.output)
    throw new Error("--inventory, --body, and --output are required");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const options = parseArguments(process.argv.slice(2));
  const inventory = JSON.parse(await readFile(options.inventory, "utf8"));
  const body = await readFile(options.body, "utf8");
  const merged = mergeDownloadSection(body, inventory);
  await writeFile(options.output, merged, "utf8");
  console.log(
    `Generated desktop-first downloads for ${inventory.tag} without replacing reviewed release prose.`,
  );
}
