/** Source-only Microsoft driver preparation. No shared cache, role or native authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { windowsSourceSystemExecutables } from "./release-native-runtime-custody.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sourceScope =
  "source-builder broker registry/signature/version observation; actual candidate runtime not observed";
const members: Readonly<Record<string, string>> = Object.freeze({
  "msedgedriver.exe": "bin/msedgedriver.exe",
  "Driver_Notes/LICENSE": "webview-driver-license.txt",
  "Driver_Notes/EULA": "webview-driver-eula.txt",
  "Driver_Notes/credits.html": "webview-driver-notices.html",
});

/** Data integrity only. An imported JSON record cannot authenticate a tool. */
export function inspectWindowsWebviewDriverProof(raw: unknown, binary: Buffer, policy: Buffer) {
  assert.ok(
    isRecord(raw) &&
      Object.keys(raw).sort().join(",") ===
        "architecture,archive,authority,empty_directories,executable,policy_sha256,schema_version,scope,signature,signature_status,url,version",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.architecture, "x64");
  assert.equal(raw.authority, "none");
  assert.equal(raw.scope, sourceScope);
  assert.equal(raw.signature_status, "Valid");
  assert.ok(
    typeof raw.version === "string" && /^[0-9]{1,10}(?:\.[0-9]{1,10}){3}$/u.test(raw.version),
  );
  assert.equal(raw.url, `https://msedgedriver.microsoft.com/${raw.version}/edgedriver_win64.zip`);
  assert.ok(
    isRecord(raw.archive) &&
      Object.keys(raw.archive).sort().join(",") === "bytes,sha256" &&
      Number.isSafeInteger(raw.archive.bytes) &&
      Number(raw.archive.bytes) >= 22 &&
      Number(raw.archive.bytes) <= 32 * 1024 ** 2 &&
      typeof raw.archive.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(raw.archive.sha256),
  );
  assert.ok(
    Buffer.isBuffer(binary) &&
      binary.length > 0 &&
      binary.length <= 64 * 1024 ** 2 &&
      Buffer.isBuffer(policy) &&
      policy.length > 0 &&
      policy.length <= 16384,
  );
  assert.deepEqual(raw.executable, { bytes: binary.length, sha256: hash(binary) });
  assert.equal(raw.policy_sha256, hash(policy));
  assert.ok(
    Array.isArray(raw.empty_directories) &&
      raw.empty_directories.length <= 1 &&
      raw.empty_directories.every((name: unknown) => name === "Driver_Notes/"),
  );
  assert.ok(
    isRecord(raw.signature) &&
      Object.keys(raw.signature).sort().join(",") === "subject,thumbprint,version" &&
      raw.signature.version === raw.version &&
      typeof raw.signature.subject === "string" &&
      raw.signature.subject.length <= 4096 &&
      raw.signature.subject.includes("Microsoft Corporation") &&
      typeof raw.signature.thumbprint === "string" &&
      /^[A-F0-9]{40}$/u.test(raw.signature.thumbprint),
  );
  return {
    version: raw.version,
    executable: { bytes: binary.length, sha256: hash(binary) },
    authority: "none" as const,
  };
}

export function inspectWindowsWebviewDriverArchive(raw: Buffer) {
  const deadline = performance.now() + 10000;
  const { archive, entries, directories } = inspectBoundedZip(
    raw,
    {
      compressedBytes: 32 * 1024 ** 2,
      expandedBytes: 96 * 1024 ** 2,
      files: 5,
      nameBytes: 64,
      allowedPaths: new Set(Object.keys(members)),
      allowedEmptyDirectories: new Set(["Driver_Notes/"]),
    },
    { clock: performance.now.bind(performance), deadline },
  );
  assert.equal(entries.length, 4, "complete Microsoft driver/license inventory required");
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    assert.ok(performance.now() < deadline);
    const limit = entry.name === "msedgedriver.exe" ? 64 * 1024 ** 2 : 16 * 1024 ** 2;
    assert.ok(entry.bytes > 0 && entry.bytes <= limit, "Microsoft driver member exceeds bound");
    const compressed = archive.subarray(entry.data, entry.dataEnd),
      bytes =
        entry.method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, { maxOutputLength: entry.bytes });
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crc32(bytes), entry.crc, "Microsoft driver CRC differs");
    const name = members[entry.name];
    assert.ok(name);
    files.set(name, bytes);
  }
  assert.ok(performance.now() < deadline);
  return {
    files,
    archive_sha256: hash(archive),
    archive_bytes: archive.length,
    empty_directories: directories.map((entry) => entry.name),
    authority: "none" as const,
  };
}

const policyPrelude = String.raw`
$ErrorActionPreference='Stop'
$module=New-Module -ScriptBlock ([scriptblock]::Create([IO.File]::ReadAllText($env:PORTCOVE_EDGE_POLICY)))
Import-Module $module
`;
function observe(script: string, environment: NodeJS.ProcessEnv) {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  let bytes: string;
  try {
    bytes = execFileSync(
      windowsSourceSystemExecutables.powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(policyPrelude + script, "utf16le").toString("base64"),
      ],
      {
        env: environment,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16384,
        windowsHide: true,
        stdio: "pipe",
      },
    );
  } catch (error) {
    const value = isRecord(error) ? error : {};
    throw Object.assign(new Error("Windows WebView observer refused; retain bounded diagnostics"), {
      diagnostic: {
        status: Number.isSafeInteger(value.status) ? value.status : null,
        code: typeof value.code === "string" ? value.code.slice(0, 64) : null,
        stdout_prefix: typeof value.stdout === "string" ? value.stdout.slice(0, 4096) : "",
        stderr_prefix: typeof value.stderr === "string" ? value.stderr.slice(0, 4096) : "",
        authority: "none",
      },
    });
  }
  return JSON.parse(bytes.replace(/^\uFEFF/u, "")) as unknown;
}

/** Shared bounded public Microsoft archive acquisition; not executable trust. */
export async function downloadWindowsWebviewDriverArchive(
  version: string,
  architecture: "x64" | "arm64",
) {
  assert.match(version, /^[0-9]{1,10}(?:\.[0-9]{1,10}){3}$/u);
  assert.ok(architecture === "x64" || architecture === "arm64");
  const archive = architecture === "x64" ? "edgedriver_win64.zip" : "edgedriver_arm64.zip";
  const url = `https://msedgedriver.microsoft.com/${version}/${archive}`;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  let raw: Buffer;
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "accept-encoding": "identity" },
    });
    assert.ok(
      response.status === 200 && !response.headers.get("content-encoding") && response.body,
      "fixed official Microsoft driver response required",
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      assert.ok(chunk instanceof Uint8Array);
      size += chunk.byteLength;
      assert.ok(size <= 32 * 1024 ** 2, "Microsoft driver download exceeds bound");
      chunks.push(Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks, size);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
  return { url, raw };
}

/** Ordinary bootstrap output only. Signature/version policy remains its caller's. */
export async function prepareBootstrapWindowsWebviewDriver(
  version: string,
  architecture: "x64" | "arm64",
  destination: string,
) {
  assert.ok(
    path.isAbsolute(destination) &&
      destination === path.resolve(destination) &&
      destination.length <= 4096 &&
      path.basename(destination) === "extract",
  );
  const parent = path.dirname(destination);
  const before = await lstat(parent);
  assert.ok(before.isDirectory() && !before.isSymbolicLink());
  const resolvedParent = await realpath(parent);
  assert.equal(resolvedParent, parent);
  // Only an absent fresh output root is permitted; no retained partial reuse.
  await lstat(destination).then(
    () => assert.fail("Bootstrap driver output already exists"),
    (error) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "ENOENT");
    },
  );
  const { url, raw } = await downloadWindowsWebviewDriverArchive(version, architecture);
  const prepared = inspectWindowsWebviewDriverArchive(raw);
  const after = await lstat(parent);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(await realpath(parent), resolvedParent);
  await mkdir(destination, { mode: 0o700 });
  await mkdir(path.join(destination, "bin"), { mode: 0o700 });
  for (const [name, bytes] of prepared.files) {
    await writeFile(path.join(destination, name), bytes, { flag: "wx", mode: 0o600 });
    assert.ok(
      (await readControllerToolFile(path.join(destination, name), 64 * 1024 ** 2)).equals(bytes),
    );
  }
  const result = {
    schema_version: 1,
    architecture,
    version,
    url,
    archive_bytes: prepared.archive_bytes,
    archive_sha256: prepared.archive_sha256,
    files: [...prepared.files].map(([name, bytes]) => ({
      path: name,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
    authority: "none",
  };
  await writeFile(
    path.join(destination, "bootstrap-driver-acquisition.json"),
    JSON.stringify(result),
    { flag: "wx", mode: 0o600 },
  );
  return result;
}

/** Fresh source-builder outputs only. The maintained signature policy runs
 * before any version probe. Admission and actual runtime matching are separate. */
export async function acquireWindowsWebviewDriver(
  sourceRoot: string,
  toolsRoot: string,
  environment: NodeJS.ProcessEnv,
) {
  assert.ok(process.platform === "win32" && process.arch === "x64");
  const policy = path.join(sourceRoot, "scripts/windows-webview-driver-policy.psm1"),
    policyBytes = await readControllerToolFile(policy, 16384),
    env = { ...environment, PATHEXT: ".EXE", PORTCOVE_EDGE_POLICY: policy };
  const observed = observe("@{version=(Get-WebViewRuntimeVersion)}|ConvertTo-Json -Compress", env);
  assert.ok(
    isRecord(observed) &&
      Object.keys(observed).join(",") === "version" &&
      typeof observed.version === "string" &&
      /^[0-9]{1,10}(?:\.[0-9]{1,10}){3}$/u.test(observed.version),
  );
  const version = observed.version;
  const { url, raw } = await downloadWindowsWebviewDriverArchive(version, "x64");
  const archiveRecord = {
    schema_version: 1,
    version,
    url,
    bytes: raw.length,
    sha256: hash(raw),
    authority: "none",
  };
  await writeFile(
    path.join(path.dirname(toolsRoot), "webview-driver-download.json"),
    JSON.stringify(archiveRecord),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(path.join(path.dirname(toolsRoot), "webview-driver-download.zip"), raw, {
    flag: "wx",
    mode: 0o600,
  });
  const prepared = inspectWindowsWebviewDriverArchive(raw);
  await mkdir(path.join(toolsRoot, "bin"), { recursive: true });
  for (const [name, bytes] of prepared.files)
    await writeFile(path.join(toolsRoot, name), bytes, { flag: "wx", mode: 0o600 });
  const executable = path.join(toolsRoot, "bin/msedgedriver.exe"),
    binary = prepared.files.get("bin/msedgedriver.exe")!;
  const verified = observe(
    String.raw`
if(-not (Test-VerifiedEdgeDriver $env:PORTCOVE_EDGE_EXECUTABLE $env:PORTCOVE_EDGE_VERSION)){throw 'Microsoft driver version/signature refused'}
$signature=Get-AuthenticodeSignature -LiteralPath $env:PORTCOVE_EDGE_EXECUTABLE
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'Microsoft driver signature changed'}
$version=([Diagnostics.FileVersionInfo]::GetVersionInfo($env:PORTCOVE_EDGE_EXECUTABLE).FileVersion -split ' ')[0]
if($version -cne $env:PORTCOVE_EDGE_VERSION -or (Get-WebViewRuntimeVersion) -cne $env:PORTCOVE_EDGE_VERSION){throw 'Microsoft driver file/runtime version changed'}
@{version=$version;subject=$signature.SignerCertificate.Subject;thumbprint=$signature.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress
`,
    { ...env, PORTCOVE_EDGE_EXECUTABLE: executable, PORTCOVE_EDGE_VERSION: version },
  );
  assert.ok(
    isRecord(verified) &&
      Object.keys(verified).sort().join(",") === "subject,thumbprint,version" &&
      verified.version === version &&
      typeof verified.subject === "string" &&
      verified.subject.length <= 4096 &&
      typeof verified.thumbprint === "string" &&
      /^[A-F0-9]{40}$/u.test(verified.thumbprint),
  );
  assert.ok(
    (await readControllerToolFile(executable, 64 * 1024 ** 2)).equals(binary),
    "verified Microsoft driver changed",
  );
  assert.ok(
    (await readControllerToolFile(policy, 16384)).equals(policyBytes),
    "shared driver policy changed",
  );
  const proof = {
    schema_version: 1,
    version,
    architecture: "x64",
    url,
    archive: { bytes: prepared.archive_bytes, sha256: prepared.archive_sha256 },
    executable: { bytes: binary.length, sha256: hash(binary) },
    signature_status: "Valid",
    signature: verified,
    empty_directories: prepared.empty_directories,
    policy_sha256: hash(policyBytes),
    scope: sourceScope,
    authority: "none",
  };
  await writeFile(path.join(toolsRoot, "webview-driver.json"), JSON.stringify(proof), {
    flag: "wx",
    mode: 0o600,
  });
  return proof;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 6);
  assert.equal(process.argv[2], "--prepare-bootstrap");
  assert.ok(process.argv[4] === "x64" || process.argv[4] === "arm64");
  console.log(
    JSON.stringify(
      await prepareBootstrapWindowsWebviewDriver(
        process.argv[3]!,
        process.argv[4],
        process.argv[5]!,
      ),
    ),
  );
}
