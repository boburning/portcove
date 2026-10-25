/** Fixed public bootstrap dependency. The Node wrapper/downloader is never used. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, writeFile, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseDocument } from "yaml";
import { isRecord } from "./runtime-values.mts";

export const nativePnpmVersion = "12.14.0";
export const nativePnpmArchive = Object.freeze({
  url: "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.14.0.tgz",
  integrity:
    "sha512-F6K8e/jWxiuEYJaQtRRUG9ynBSTEHa+t7Lf86MKuOO5UA7WVVMbi+oB8nY6iKW++ncWS2yG6T9faXZGxqNsfoQ==",
});
const maximum = 64 * 1024 ** 2;
const names = [
  "package/LICENSE",
  "package/pnpm",
  "package/package.json",
  "package/THIRD-PARTY-NOTICES.md",
];
export function inspectNativeDependencyWorkspace(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 65536);
  const doc = parseDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
    uniqueKeys: true,
    strict: true,
  });
  assert.ok(doc.errors.length === 0 && doc.warnings.length === 0, "native workspace YAML differs");
  const raw: unknown = doc.toJS({ maxAliasCount: 0 });
  const allowed = [
    "packages",
    "runtimeOnFail",
    "pmOnFail",
    "allowBuilds",
    "minimumReleaseAge",
    "minimumReleaseAgeStrict",
    "storeDir",
    "catalog",
    "overrides",
    "peerDependencyRules",
    "patchedDependencies",
  ];
  assert.ok(
    isRecord(raw) && Object.keys(raw).every((key) => allowed.includes(key)),
    "native workspace setting outside fixed contract",
  );
  assert.deepEqual(raw.packages, ["apps/desktop"]);
  for (const key of ["pmOnFail", "runtimeOnFail"])
    assert.ok(
      raw[key] === undefined ||
        (typeof raw[key] === "string" && ["ignore", "warn", "error"].includes(raw[key])),
      "workspace runtime download selection refused",
    );
  assert.ok(raw.storeDir === undefined || raw.storeDir === "work/pnpm-store");
  assert.ok(
    raw.minimumReleaseAge === undefined ||
      (Number.isSafeInteger(raw.minimumReleaseAge) && Number(raw.minimumReleaseAge) >= 0),
  );
  assert.ok(
    raw.minimumReleaseAgeStrict === undefined || typeof raw.minimumReleaseAgeStrict === "boolean",
  );
  for (const key of ["catalog", "overrides", "patchedDependencies", "allowBuilds"]) {
    const value = raw[key];
    assert.ok(
      value === undefined ||
        (isRecord(value) &&
          Object.entries(value).every(
            ([name, item]) =>
              name.length <= 256 &&
              (key === "allowBuilds"
                ? typeof item === "boolean"
                : typeof item === "string" && item.length <= 4096),
          )),
      "workspace package data differs",
    );
  }
  for (const key of ["catalog", "overrides"]) {
    const versions =
      raw[key] === undefined ? [] : Object.values(raw[key] as Record<string, string>);
    assert.ok(
      versions.every(
        (value) =>
          !/^(?:file:|link:|git|https?:|ssh:|\.|\/)|^[^@:]+\//u.test(value) &&
          (!value.includes(":") ||
            (/^(?:npm:|catalog:|workspace:)/u.test(value) && value.split(":").length === 2)) &&
          (!value.startsWith("workspace:") || /^workspace:[*~^0-9][0-9.*~^ -]*$/u.test(value)),
      ),
      "external workspace dependency route refused",
    );
  }
  if (raw.peerDependencyRules !== undefined) {
    assert.ok(
      isRecord(raw.peerDependencyRules) &&
        Object.keys(raw.peerDependencyRules).every((key) =>
          ["allowAny", "allowedVersions"].includes(key),
        ),
    );
    const { allowAny, allowedVersions } = raw.peerDependencyRules;
    assert.ok(
      allowAny === undefined ||
        (Array.isArray(allowAny) && allowAny.every((item) => typeof item === "string")),
    );
    assert.ok(
      allowedVersions === undefined ||
        (isRecord(allowedVersions) &&
          Object.values(allowedVersions).every((item) => typeof item === "string")),
    );
  }
  const patches =
    raw.patchedDependencies === undefined
      ? []
      : Object.values(raw.patchedDependencies as Record<string, string>);
  assert.ok(
    patches.every((name) => /^patches\/[A-Za-z0-9_@.+-]+\.patch$/u.test(name)),
    "patch path outside reviewed source",
  );
  return { sha256: createHash("sha256").update(bytes).digest("hex"), patches };
}
function octal(bytes: Buffer) {
  const text = bytes.toString("ascii").replace(/[\0 ]+$/u, "");
  assert.match(text, /^[0-7]{1,12}$/u, "unsupported pnpm TAR numeric metadata");
  return Number.parseInt(text, 8);
}

/** Raw headers are validated before reading any payload. No TAR library can
 * preprocess extension/PAX/long-name/link records before these bounds. */
export function inspectNativePnpmTar(decoded: Buffer) {
  assert.ok(decoded.length <= maximum && decoded.length >= 1536 && decoded.length % 512 === 0);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (
    offset + 512 <= decoded.length &&
    decoded.subarray(offset, offset + 512).some((b) => b !== 0)
  ) {
    assert.ok(files.size < 4, "pnpm TAR inventory exceeds bound");
    const header = decoded.subarray(offset, offset + 512);
    assert.ok(header[156] === 0 || header[156] === 0x30, "pnpm TAR extensions/links refused");
    assert.ok(
      !header.subarray(157, 257).some((b) => b !== 0) &&
        !header.subarray(345, 512).some((b) => b !== 0),
      "pnpm TAR prefix/link metadata refused",
    );
    assert.ok(
      header.subarray(257, 265).equals(Buffer.from("ustar\0" + "00")),
      "pnpm TAR format differs",
    );
    const endName = header.subarray(0, 100).indexOf(0);
    assert.ok(endName > 0 && !header.subarray(endName, 100).some((b) => b !== 0));
    const name = header.subarray(0, endName).toString("utf8");
    assert.ok(names.includes(name) && !files.has(name), "pnpm TAR path/duplicate refused");
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    assert.equal(checksum, octal(header.subarray(148, 156)), "pnpm TAR checksum differs");
    const size = octal(header.subarray(124, 136)),
      mode = octal(header.subarray(100, 108));
    assert.ok(size > 0 && size <= (name === "package/pnpm" ? maximum - 16384 : 65536));
    assert.ok(mode <= 0o777 && (name !== "package/pnpm" || (mode & 0o100) !== 0));
    const start = offset + 512,
      end = start + size,
      padded = start + Math.ceil(size / 512) * 512;
    assert.ok(
      padded <= decoded.length && !decoded.subarray(end, padded).some((b) => b !== 0),
      "pnpm TAR payload/padding differs",
    );
    files.set(name, decoded.subarray(start, end));
    offset = padded;
  }
  assert.ok(
    files.size === 4 &&
      decoded.length - offset >= 1024 &&
      decoded.length - offset <= 10240 &&
      !decoded.subarray(offset).some((b) => b !== 0),
    "pnpm TAR final inventory differs",
  );
  const metadata: unknown = JSON.parse(files.get("package/package.json")!.toString("utf8"));
  assert.ok(
    isRecord(metadata) &&
      metadata.name === "@pnpm/exe.linux-x64" &&
      metadata.version === nativePnpmVersion,
  );
  const binary = files.get("package/pnpm")!;
  assert.ok(
    binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    "pnpm ELF route differs",
  );
  return {
    binary,
    license: files.get("package/LICENSE")!,
    notices: files.get("package/THIRD-PARTY-NOTICES.md")!,
  };
}

export function inspectNativePnpmArchive(archive: Buffer) {
  assert.ok(
    archive.length > 0 && archive.length <= 32 * 1024 ** 2,
    "pnpm compressed archive exceeds bound",
  );
  assert.equal(
    `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    nativePnpmArchive.integrity,
    "pinned pnpm archive differs",
  );
  return inspectNativePnpmTar(gunzipSync(archive, { maxOutputLength: maximum }));
}

/** One fixed GET, no redirects, credentials, retry or ambient registry config. */
export async function acquireNativePnpm() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(nativePnpmArchive.url, {
      redirect: "error",
      signal: controller.signal,
      headers: { "accept-encoding": "identity" },
    });
    assert.ok(
      response.status === 200 && !response.headers.get("content-encoding") && response.body,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      const value: unknown = chunk;
      assert.ok(value instanceof Uint8Array, "pnpm response stream differs");
      size += value.byteLength;
      assert.ok(size <= 32 * 1024 ** 2, "pnpm download exceeds bound");
      chunks.push(Buffer.from(value));
    }
    return inspectNativePnpmArchive(Buffer.concat(chunks, size));
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** Actual offline runtime smoke, using inert fixture packages only. */
export async function qualifyNativePnpmRuntime(
  executable: string,
  directory: string,
  nodeDirectory: string,
) {
  await mkdir(directory, { mode: 0o700 });
  const environment = {
    HOME: directory,
    TMPDIR: directory,
    PATH: `${nodeDirectory}:/usr/bin:/bin`,
    CI: "true",
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
  };
  const version = spawnSync(executable, ["--version"], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8192,
  });
  assert.equal(version.error, undefined);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), nativePnpmVersion);
  const observations = [];
  for (const changed of [false, true]) {
    const root = path.join(directory, changed ? "changed-lock" : "matching-lock");
    await mkdir(root, { mode: 0o700 });
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", { flag: "wx" });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { postinstall: "touch lifecycle-ran" },
        ...(changed ? { dependencies: { "portcove-inert-nonexistent-dependency": "0.0.0" } } : {}),
      }),
      { flag: "wx" },
    );
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
      { flag: "wx" },
    );
    await writeFile(
      path.join(root, ".pnpmfile.cjs"),
      "require('node:fs').writeFileSync(__dirname+'/hook-ran','unexpected'); module.exports={};",
      { flag: "wx" },
    );
    const result = spawnSync(
      executable,
      [
        "--dir",
        root,
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--pm-on-fail=error",
        "--runtime-on-fail=error",
        "--store-dir",
        path.join(root, "store"),
        "--reporter=append-only",
      ],
      { cwd: directory, env: environment, encoding: "utf8", timeout: 30000, maxBuffer: 8192 },
    );
    await writeFile(
      path.join(root, "capture.json"),
      JSON.stringify({
        status: result.status,
        error: result.error?.message ?? null,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
      { flag: "wx", mode: 0o600 },
    );
    assert.equal(result.error, undefined);
    if (changed) {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /OUTDATED_LOCKFILE/u);
    } else assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of ["lifecycle-ran", "hook-ran"])
      assert.equal(
        await lstat(path.join(root, name)).catch((error: unknown) => {
          assert.ok(isRecord(error) && error.code === "ENOENT");
          return undefined;
        }),
        undefined,
        "inert package code executed",
      );
    observations.push({
      changed_lock: changed,
      status: result.status,
      lifecycle_absent: true,
      hook_absent: true,
    });
  }
  return {
    version: nativePnpmVersion,
    observations,
    scope: "offline-inert-runtime-only",
    authority: "none",
  };
}
