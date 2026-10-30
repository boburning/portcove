import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function prerequisiteEnvironment() {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMP",
    "TEMP",
  ])
    if (process.env[key] !== undefined) result[key] = process.env[key];
  return result;
}
// Define refusals before source evaluation, including the outer timeout/env
// owners, so an accidental import-time install cannot start privileged APT.
export const prerequisiteImportGuards = [
  "dpkg-query",
  "dpkg",
  "sudo",
  "apt-get",
  "sed",
  "timeout",
  "env",
]
  .map((name) => `${name}() { printf '%s\\n' 'forbidden-import:${name}' >&2; return 99; }`)
  .join("\n");
let selectedBash: string | undefined;
export function prerequisiteBash() {
  if (selectedBash) return selectedBash;
  const git = spawnSync("git", ["--exec-path"], {
    env: prerequisiteEnvironment(),
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.ifError(git.error);
  assert.equal(git.status, 0, git.stderr);
  selectedBash =
    process.platform === "win32"
      ? path.resolve(git.stdout.trim(), "../../../bin/bash.exe")
      : "bash";
  if (process.platform === "win32") assert.ok(existsSync(selectedBash));
  return selectedBash;
}
export function prerequisiteOperations(
  program: string,
  args: readonly string[] = [],
  sourcePath = fileURLToPath(new URL("../install-linux-desktop-prerequisites.sh", import.meta.url)),
) {
  const module = sourcePath.replaceAll("\\", "/");
  const result = spawnSync(
    prerequisiteBash(),
    [
      "--noprofile",
      "--norc",
      "-c",
      `set -euo pipefail\nsource_options=$-\n${prerequisiteImportGuards}\n. "$1"\n[[ $- == "$source_options" ]]\nshift\n${program}`,
      "prerequisite-fixture",
      module,
      ...args,
    ],
    {
      env: prerequisiteEnvironment(),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  assert.ifError(result.error);
  return result;
}
/** Exercise literal workflow invocations against an inert program in owned scratch.
 * The accepted surface is one fixed script plus literal flags, never general shell. */
export function prerequisiteInvocation(run: string) {
  const command = run.replace(/\\\r?\n[\t ]*/gu, " ").trim();
  assert.ok(
    !/[\r\n;$`|&<>(){}[\]*?!\\]/u.test(command),
    "Prerequisite workflow command must remain one literal invocation",
  );
  assert.match(
    command,
    /^(?:bash\s+)?(?:"\.\/scripts\/install-linux-desktop-prerequisites\.sh"|'\.\/scripts\/install-linux-desktop-prerequisites\.sh'|\.\/scripts\/install-linux-desktop-prerequisites\.sh)(?:\s|$)/u,
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "portcove-prerequisite-invocation-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(
      path.join(root, "scripts/install-linux-desktop-prerequisites.sh"),
      "#!/usr/bin/env bash\nif (( $# )); then printf '%s\\0' \"$@\"; fi\n",
      { mode: 0o755 },
    );
    const result = spawnSync(
      prerequisiteBash(),
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
      {
        cwd: root,
        env: prerequisiteEnvironment(),
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    if (result.stdout === "") return [];
    assert.ok(result.stdout.endsWith("\0"));
    return result.stdout.slice(0, -1).split("\0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
