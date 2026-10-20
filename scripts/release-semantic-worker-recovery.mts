import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { capacityDigest } from "./release-capacity.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { isRecord } from "./runtime-values.mts";

/** Technical duplicate/resource control, never semantic acceptance or journal
 * mutation authority. Retained POST locators permanently select readback. */
export function inspectSemanticTechnicalRecovery(raw: unknown, unit: unknown) {
  if (
    !isRecord(raw) ||
    raw.schema_version !== 1 ||
    raw.mode !== "codex" ||
    raw.scope !== "held-linux-semantic-runtime-preparation" ||
    raw.authority !== "none" ||
    typeof raw.unit !== "string" ||
    !/^portcove-semantic-[a-f0-9]{32}\.service$/u.test(raw.unit) ||
    raw.cgroup_empty !== true ||
    raw.unit_settled !== true ||
    raw.network_settled !== true ||
    !Array.isArray(raw.cleanup_errors) ||
    raw.cleanup_errors.length !== 0 ||
    !isRecord(unit) ||
    unit.MainPID !== "0" ||
    unit.ControlGroup !== "" ||
    !(unit.LoadState === "not-found" || ["inactive", "failed"].includes(String(unit.ActiveState)))
  )
    throw new Error("prior semantic boundary has not positively settled for technical recovery");
  // Exit/auth/report success are deliberately absent: this authorizes no report.
  return { unit: raw.unit, authority: "none", scope: "technical recovery only" };
}

async function absent(filename: string) {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return true;
    throw error;
  }
}
async function json(root: string, name: string) {
  return JSON.parse(
    (await readBoundedPublicBuildInputFile(root, name, 128 * 1024)).toString("utf8"),
  ) as unknown;
}

/** Fixed GET-only OS readback. It never starts, stops, kills or resets a unit. */
async function settleRetainedInvocation(root: string, expected: string, systemctlSha256: string) {
  if (!(await absent(path.join(root, "capture/check-attempt.jsonl"))))
    throw new Error("retained broker attempt requires GET-only reconciliation");
  const invocation = await json(root, "capture/invocation.json");
  if (
    !isRecord(invocation) ||
    capacityDigest(invocation) !== expected ||
    (await readBoundedPublicBuildInputFile(root, ".portcove-semantic-review-owned", 128)).toString(
      "utf8",
    ) !== invocation.id
  )
    throw new Error("original semantic invocation identity changed");
  const request = await json(root, "capture/linux-request.json");
  const isolation = await json(root, "capture/isolation.json");
  const intent = await json(root, "capture/linux-intent.json");
  if (
    !isRecord(request) ||
    request.run_root !== root ||
    !isRecord(isolation) ||
    typeof isolation.unit !== "string" ||
    !/^portcove-semantic-[a-f0-9]{32}\.service$/u.test(isolation.unit)
  )
    throw new Error("retained semantic request or exact unit unavailable");
  if (
    !isRecord(intent) ||
    Object.keys(intent).sort().join(",") !== "mode,schema_version,supervisor_sha256,unit" ||
    intent.schema_version !== 1 ||
    intent.mode !== "codex" ||
    intent.unit !== isolation.unit ||
    intent.supervisor_sha256 !== invocation.supervisor_sha256
  )
    throw new Error("original semantic unit/supervisor intent differs from capture");
  if (
    createHash("sha256")
      .update(await readFile("/usr/bin/systemctl"))
      .digest("hex") !== systemctlSha256
  )
    throw new Error("qualified systemctl identity changed");
  const output = execFileSync(
    "/usr/bin/systemctl",
    ["--user", "show", isolation.unit, "--property=LoadState,ActiveState,ControlGroup,MainPID"],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8192,
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: process.env.HOME,
        XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}`,
      },
    },
  );
  const properties: Record<string, string> = {};
  for (const line of output.trim().split("\n")) {
    const match = /^(LoadState|ActiveState|ControlGroup|MainPID)=(.*)$/u.exec(line);
    if (!match || Object.hasOwn(properties, match[1]!))
      throw new Error("ambiguous exact unit readback");
    properties[match[1]!] = match[2]!;
  }
  return inspectSemanticTechnicalRecovery(isolation, properties);
}

/** The sole installed worker retains initial+two technical invocations. State
 * loss, incomplete evidence and possible POST effects refuse automatic replay. */
export async function claimSemanticTechnicalAttempt(
  requestDirectory: string,
  systemctlSha256: string,
) {
  const entries = await readdir(requestDirectory);
  const runs = entries.filter((name) => /^technical-[0-2]$/u.test(name)).sort();
  const anchor = path.join(
    path.dirname(requestDirectory),
    `${path.basename(requestDirectory)}.attempts.jsonl`,
  );
  let anchored: string[] = [];
  if (!(await absent(anchor))) {
    anchored = (
      await readBoundedPublicBuildInputFile(path.dirname(anchor), path.basename(anchor), 4096)
    )
      .toString("utf8")
      .trim()
      .split("\n");
  }
  if (JSON.stringify(anchored) !== JSON.stringify(runs))
    throw new Error("semantic attempt custody missing or contradictory; no counter reset");
  if (runs.length >= 3) throw new Error("semantic technical retry budget exhausted");
  if (runs.some((name, index) => name !== `technical-${index}`))
    throw new Error("semantic technical attempt custody has a gap");
  for (const name of runs) {
    const root = path.join(requestDirectory, name);
    if (!(await absent(path.join(root, "expected-check.json"))))
      throw new Error("retained original Check request requires GET-only reconciliation");
    const stopped = await json(root, "technical-stop.json");
    if (
      !isRecord(stopped) ||
      stopped.outcome !== "technical-failure" ||
      !Array.isArray(stopped.invocations) ||
      stopped.invocations.length > 2
    )
      throw new Error("previous technical attempt is live, incomplete or ambiguous");
    for (const invocation of stopped.invocations) {
      if (
        !isRecord(invocation) ||
        typeof invocation.root !== "string" ||
        path.dirname(invocation.root) !== root ||
        !/^r-[A-Za-z0-9_-]+$/u.test(path.basename(invocation.root)) ||
        typeof invocation.invocation_sha256 !== "string"
      )
        throw new Error("retained technical invocation locator differs");
      await settleRetainedInvocation(
        invocation.root,
        invocation.invocation_sha256,
        systemctlSha256,
      );
    }
  }
  const root = path.join(requestDirectory, `technical-${runs.length}`);
  // Persist the claim outside the disposable execution directory first. A lost
  // directory or interrupted creation remains contradictory, never attempt zero.
  const custody = await open(anchor, "a", 0o600);
  try {
    await custody.writeFile(`technical-${runs.length}\n`);
    await custody.sync();
  } finally {
    await custody.close();
  }
  await mkdir(root, { mode: 0o700 }); // atomic exclusion; no recursive/reuse
  const handle = await open(path.join(root, "technical-start.json"), "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({ schema_version: 1, attempt: runs.length, authority: "none" }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return root;
}
