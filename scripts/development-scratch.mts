import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, statfsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorCode, isRecord } from "./runtime-values.mts";

export interface ScratchProfile {
  format: 1;
  root: string;
  identity: string;
  backingDirectory?: string;
  distribution?: string;
  filesystemUuid?: string;
  backingVhd?: string;
  windowsNode?: string;
  workspaces?: string[];
}

export function readScratchProfile(
  file = path.join(os.homedir(), ".config/portcove/development-scratch.json"),
): ScratchProfile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    Object.keys(value).some(
      (key) =>
        ![
          "format",
          "root",
          "identity",
          "backingDirectory",
          "distribution",
          "filesystemUuid",
          "backingVhd",
          "windowsNode",
          "workspaces",
        ].includes(key),
    ) ||
    typeof value.root !== "string" ||
    !path.isAbsolute(value.root) ||
    typeof value.identity !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.identity) ||
    (value.backingDirectory !== undefined &&
      (typeof value.backingDirectory !== "string" || !path.isAbsolute(value.backingDirectory))) ||
    (value.distribution !== undefined &&
      (typeof value.distribution !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.distribution))) ||
    (value.filesystemUuid !== undefined &&
      (typeof value.filesystemUuid !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(value.filesystemUuid))) ||
    (value.backingVhd !== undefined &&
      (typeof value.backingVhd !== "string" || !path.win32.isAbsolute(value.backingVhd))) ||
    (value.windowsNode !== undefined &&
      (typeof value.windowsNode !== "string" ||
        !path.posix.isAbsolute(value.windowsNode) ||
        !value.windowsNode.endsWith(".exe"))) ||
    (value.workspaces !== undefined &&
      (!Array.isArray(value.workspaces) ||
        !value.workspaces.length ||
        !value.workspaces.every(
          (entry: unknown) => typeof entry === "string" && path.isAbsolute(entry),
        ))) ||
    (process.platform === "linux" &&
      (!value.filesystemUuid ||
        !value.backingDirectory ||
        !value.distribution ||
        !value.backingVhd ||
        !value.windowsNode))
  )
    throw new Error("Invalid machine scratch profile: " + file);
  return value as unknown as ScratchProfile;
}

export function scratchAllocation(
  profile: ScratchProfile,
  workspace: string,
  platform = process.platform,
) {
  const physical = realpathSync.native(workspace);
  const key = createHash("sha256")
    .update(platform)
    .update("\0")
    .update(platform === "win32" ? physical.toLowerCase() : physical)
    .digest("hex")
    .slice(0, 20);
  const root = path.join(profile.root, platform, key);
  return { temporary: path.join(root, "temp"), target: path.join(root, "target") };
}

export function scratchCargoTarget(
  effective: string,
  workspace: string,
  target: string,
  environment: NodeJS.ProcessEnv,
) {
  const normalize = (file: string) =>
    process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  return !environment.CARGO_TARGET_DIR &&
    normalize(effective) === normalize(path.join(workspace, "target"))
    ? target
    : effective;
}

export function validateScratchBacking(
  expectedDirectory: string,
  expectedVhd: string,
  observed: unknown,
) {
  const canonical = (value: string) =>
    path.win32
      .normalize(value)
      .replace(/^\\\\\?\\/u, "")
      .toLowerCase();
  if (
    !isRecord(observed) ||
    typeof observed.basePath !== "string" ||
    typeof observed.vhdPath !== "string" ||
    canonical(observed.basePath) !== canonical(expectedDirectory) ||
    canonical(observed.vhdPath) !== canonical(expectedVhd) ||
    canonical(path.win32.dirname(observed.vhdPath)) !== canonical(observed.basePath)
  )
    throw new Error(
      "Scratch distribution backing VHD differs; refusing the wrong volume capacity check",
    );
  return observed;
}

function verifyRegisteredBacking(profile: ScratchProfile) {
  const directory = execFileSync(
    "wslpath",
    ["-w", realpathSync.native(profile.backingDirectory!)],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
    },
  ).trim();
  const request = Buffer.from(JSON.stringify({ distribution: profile.distribution })).toString(
    "base64",
  );
  const query =
    "$q=ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
    request +
    "'))); $r=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DistributionName -CEQ $q.distribution); if($r.Count -ne 1){throw 'Scratch registration missing or ambiguous'}; [ordered]@{basePath=$r[0].BasePath; vhdFile=($r[0].VhdFileName ?? 'ext4.vhdx')} | ConvertTo-Json -Compress";
  const code = [
    'const fs=await import("node:fs"),p=await import("node:path"),cp=await import("node:child_process");',
    'const r=JSON.parse(cp.execFileSync("pwsh.exe",["-NoProfile","-NonInteractive","-Command",process.argv[1]],{encoding:"utf8",timeout:5000,maxBuffer:8192,windowsHide:true}));',
    "console.log(JSON.stringify({basePath:fs.realpathSync.native(r.basePath),vhdPath:fs.realpathSync.native(p.join(r.basePath,r.vhdFile))}));",
  ].join("\n");
  const observed: unknown = JSON.parse(
    execFileSync(profile.windowsNode!, ["--input-type=module", "-e", code, query], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8192,
      windowsHide: true,
    }),
  );
  return validateScratchBacking(directory, profile.backingVhd!, observed);
}

export function verifyScratchProfile(profile: ScratchProfile) {
  const directory = lstatSync(profile.root);
  const markerPath = path.join(profile.root, ".portcove-scratch.json");
  const markerStat = lstatSync(markerPath);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !markerStat.isFile() ||
    markerStat.size > 4096
  )
    throw new Error("Scratch root or ownership marker is not an ordinary owned path");
  const marker: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
  if (!isRecord(marker) || marker.format !== 1 || marker.identity !== profile.identity)
    throw new Error("Scratch ownership marker differs; refusing adoption");
  if (process.platform === "linux") {
    if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
      throw new Error("Linux scratch ownership/permissions differ");
    const raw: unknown = JSON.parse(
      execFileSync(
        "findmnt",
        ["--json", "--target", profile.root, "--output", "TARGET,FSTYPE,UUID"],
        { encoding: "utf8", timeout: 5000, maxBuffer: 8192 },
      ),
    );
    const mounts = isRecord(raw) && Array.isArray(raw.filesystems) ? raw.filesystems : [];
    const mount: unknown = mounts[0];
    if (
      !isRecord(mount) ||
      mount.target !== profile.root ||
      mount.fstype !== "ext4" ||
      mount.uuid !== profile.filesystemUuid ||
      marker.filesystemUuid !== profile.filesystemUuid ||
      Number(statfsSync(profile.root).type) !== 0xef53
    )
      throw new Error(
        "SSD ext4 scratch mount identity differs; no fallback directory is permitted",
      );
    verifyRegisteredBacking(profile);
  }
  return profile;
}

/** Only run/prepare mutates mount state; preflight/getPaths remain observational. */
export function prepareScratchProfile(profile = readScratchProfile()) {
  if (!profile) return;
  if (process.platform === "linux") {
    execFileSync(
      "wsl.exe",
      [
        "--distribution",
        profile.distribution!,
        "--cd",
        "/",
        "--user",
        "root",
        "--exec",
        "/usr/local/sbin/portcove-scratch-mount",
        profile.filesystemUuid!,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 8192, windowsHide: true },
    );
  }
  verifyScratchProfile(profile);
}
