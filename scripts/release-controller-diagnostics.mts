/** Public routing evidence only; never logs, keys, package data or acceptance. */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectReleaseControlPhase } from "./release-control-phases.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { errorCode } from "./runtime-values.mts";

export async function retainControllerDiagnostics(root: string, rawPhase: unknown) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (!path.isAbsolute(root)) throw new Error("owned diagnostics root required");
  const directory = path.join(root, `controller-public-evidence-${phase}`);
  await mkdir(directory, { mode: 0o700 }); // Preserve earlier attempt; no overwrite.
  const names = [
    `controller-${phase === "admission" ? "building" : phase}-source.json`,
    `controller-worker-${phase}-started.json`,
    `controller-job-settlement-${phase}.json`,
    `release-control-${phase}-process-ended.json`,
    ...[
      "clock",
      "aggregate-ack",
      "signature-ack",
      "context-ack",
      "result-ack",
      "site-ack",
      "attest-ack",
      "attestation-uploaded",
    ].map((suffix) => `controller-transport-${phase}-${suffix}.json`),
    ...Array.from(
      { length: 40 },
      (_, slot) => `controller-transport-${phase}-slot-${slot + 1}.json`,
    ),
    ...Array.from({ length: 15 }, (_, round) => `control-step-ready-${phase}-r${round}.json`),
  ];
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const unavailable: { path: string; reason: string }[] = [];
  for (const name of names) {
    try {
      const bytes = await readControllerToolFile(path.join(root, name), 65536);
      JSON.parse(bytes.toString("utf8"));
      await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      files.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      unavailable.push({
        path: name,
        reason: errorCode(error) === "ENOENT" ? "absent" : "unreadable-or-invalid",
      });
    }
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      phase,
      files,
      unavailable,
      authority: "none",
      scope: "public-routing-diagnostics-only",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return directory;
}

/** Fixed public lifecycle rows only. Missing/partial rows stay unavailable;
 * collecting them neither retries nor settles the original native worker. */
export async function retainHostedNativeDiagnostics(
  temporary: string,
  home: string,
  run: string,
  revision: string,
) {
  if (
    !path.isAbsolute(temporary) ||
    !path.isAbsolute(home) ||
    !/^[1-9][0-9]{0,15}$/u.test(run) ||
    !/^[a-f0-9]{40}$/u.test(revision)
  )
    throw new Error("fixed native diagnostics binding required");
  const source = path.join(home, `.portcove-native-${run}-1-${revision}`);
  const directory = path.join(temporary, "native-public-evidence-linux");
  await mkdir(directory, { mode: 0o700 });
  const names = [
    "native-supervision-started.json",
    "native-supervision-settlement.json",
    "native-supervision-refusal.json",
    "portcove-native-job-clock.json",
    "native-post-start.json",
    ...["pre-sign", "post-sign"].flatMap((stage) => [
      `${stage}-supervision-settlement.json`,
      `${stage}-supervision-refusal.json`,
      `${stage}-tree-cleanup.json`,
      ...["started", "refusal", "settlement", "upload-request", "upload-ack"].map(
        (suffix) => `portcove-native-linux-${stage}/native-job-${suffix}.json`,
      ),
    ]),
  ];
  const files: { path: string; source: string; bytes: number; sha256: string }[] = [];
  const unavailable: { path: string; reason: string }[] = [];
  for (const [index, name] of names.entries()) {
    try {
      const bytes = await readControllerToolFile(path.join(source, name), 65536);
      JSON.parse(bytes.toString("utf8"));
      const output = `record-${index}.json`;
      await writeFile(path.join(directory, output), bytes, { flag: "wx", mode: 0o600 });
      files.push({
        path: output,
        source: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      unavailable.push({
        path: name,
        reason: errorCode(error) === "ENOENT" ? "absent" : "unreadable-or-invalid",
      });
    }
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      run_id: run,
      run_attempt: 1,
      controller_revision: revision,
      files,
      unavailable,
      scope: "public-native-routing-diagnostics-only",
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  if (process.argv[2] === "native-linux" && process.argv.length === 3)
    await retainHostedNativeDiagnostics(
      process.env.RUNNER_TEMP ?? "",
      process.env.HOME ?? "",
      process.env.GITHUB_RUN_ID ?? "",
      process.env.GITHUB_SHA ?? "",
    );
  else await retainControllerDiagnostics(process.env.RUNNER_TEMP ?? "", process.argv[2]);
