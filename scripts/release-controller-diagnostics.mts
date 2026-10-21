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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await retainControllerDiagnostics(process.env.RUNNER_TEMP ?? "", process.argv[2]);
