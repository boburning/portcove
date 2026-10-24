import { createHash } from "node:crypto";
import { copyFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord, errorCode } from "./runtime-values.mts";

export interface ProposalReceipt extends Record<string, unknown> {
  format_version: 1;
  input_sha256: string;
  input_bytes: number;
  ports: unknown[];
  validator_artifact_sha256: string;
}
export interface ListingReceipt extends Record<string, unknown> {
  format_version: 1 | 2;
  input_sha256: string;
  input_bytes: number;
  listings: unknown[];
  validator_artifact_sha256: string;
}

export function coreProposalInspector(cli: string, root: string) {
  const artifact = join(root, process.platform === "win32" ? "validator.exe" : "validator");
  copyFileSync(resolve(cli), artifact);
  chmodSync(artifact, 0o500);
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PORTCOVE_LIBRARY"),
  );
  const invoke = (
    name: string,
    bytes: Buffer,
    operation: "inspect-proposal" | "inspect-listings",
  ) => {
    const file = join(root, `${name}.json`);
    writeFileSync(file, bytes, { flag: "wx" });
    const processStarted = process.hrtime.bigint();
    const child = spawnSync(
      artifact,
      [
        "--library",
        join(root, "unused-library"),
        "--json",
        "--non-interactive",
        "catalog",
        operation,
        ...(operation === "inspect-listings" ? ["--path", file] : [file]),
      ],
      {
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: (operation === "inspect-listings" ? 10 : 1) * 1024 * 1024,
        windowsHide: true,
      },
    );
    const processElapsedMs = Number(process.hrtime.bigint() - processStarted) / 1e6;
    writeFileSync(
      join(root, `${name}-process.json`),
      JSON.stringify(
        {
          validator_artifact_sha256: artifactSha256,
          operation,
          status: child.status,
          signal: child.signal,
          error_code: errorCode(child.error) ?? null,
          elapsed_ms: processElapsedMs,
          elapsed_boundary: "monotonic wall elapsed around validator spawnSync, including waiting",
          stdout_tail: child.stdout?.slice(-16384) ?? "",
          stderr_tail: child.stderr?.slice(-16384) ?? "",
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    if (child.error || child.status !== 0)
      throw new Error(
        `Core refused ${name} catalog declarations; retained process receipt has the reason.`,
      );
    const envelope: unknown = JSON.parse(child.stdout);
    const report = isRecord(envelope) ? envelope.data : undefined;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { report, sha256 };
  };
  const inspect = (name: string, bytes: Buffer): ProposalReceipt => {
    const { report, sha256 } = invoke(name, bytes, "inspect-proposal");
    if (
      !isRecord(report) ||
      report.format_version !== 1 ||
      report.input_sha256 !== sha256 ||
      report.input_bytes !== bytes.length ||
      !Array.isArray(report.ports)
    )
      throw new Error("Core proposal receipt does not identify the checked input.");
    return {
      ...report,
      format_version: 1,
      input_sha256: sha256,
      input_bytes: bytes.length,
      ports: report.ports,
      validator_artifact_sha256: artifactSha256,
    };
  };
  const inspectListings = (name: string, bytes: Buffer): ListingReceipt => {
    const { report, sha256 } = invoke(name, bytes, "inspect-listings");
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(report) ||
      (report.format_version !== 1 && report.format_version !== 2) ||
      !Array.isArray(report.listings) ||
      !isDeepStrictEqual(report, input)
    )
      throw new Error("Core listing response differs from the exact generated input.");
    return {
      format_version: report.format_version,
      input_sha256: sha256,
      input_bytes: bytes.length,
      listings: report.listings,
      validator_artifact_sha256: artifactSha256,
    };
  };
  return { artifact, inspect, inspectListings };
}
