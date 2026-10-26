import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./runtime-values.mts";
import { fileIdentity } from "./development-evidence.mts";
import { executeLibtestProcess } from "./qualification-rustdoc.mts";
import { parseStandaloneLibtestOutcomes } from "./rustdoc-outcomes.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
const binaryIdentity = (file: string) => fileIdentity(file, { maxBytes: 128 * 1024 * 1024 });

export async function runStandaloneRustTests(
  binary: string,
  options: {
    cwd?: string;
    spawn?: Parameters<typeof executeLibtestProcess>[5];
    environment?: NodeJS.ProcessEnv;
    publishReceipt?: (file: string, bytes: string) => void;
    publishRaw?: (descriptor: number, bytes: Buffer) => unknown;
  } = {},
) {
  const cwd = options.cwd ?? root;
  const environment = { ...(options.environment ?? process.env) };
  if (environment.RUSTC_BOOTSTRAP !== undefined && environment.RUSTC_BOOTSTRAP !== "-1")
    throw new Error("Standalone reporting refuses inherited bootstrap overrides");
  const executable = path.resolve(cwd, binary);
  const identity = await binaryIdentity(executable);
  const parent = path.join(cwd, "work", "standalone-rust-tests");
  mkdirSync(parent, { recursive: true });
  const packet = mkdtempSync(path.join(parent, "invocation-"));
  const args = ["--format=json", "-Zunstable-options", "--report-time"];
  const request = {
    format_version: 1,
    runner: "standalone-libtest",
    invocation_id: randomUUID(),
    source: { kind: "compiled-test-binary", ...identity },
    executable,
    command: [executable, ...args],
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    run: environment.GITHUB_RUN_ID ?? null,
    attempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    job: environment.GITHUB_JOB ?? null,
    child_environment: { RUSTC_BOOTSTRAP: "-1" },
    packet,
  };
  writeFileSync(path.join(packet, "request.json"), JSON.stringify(request, null, 2) + "\n", {
    flag: "wx",
  });
  const result = await executeLibtestProcess(
    executable,
    args,
    cwd,
    { ...environment, RUSTC_BOOTSTRAP: "-1" },
    packet,
    options.spawn ?? spawn,
    options.publishRaw ?? writeSync,
  );
  const observation = parseStandaloneLibtestOutcomes(result.stdout.raw);
  let failure =
    result.stdout.failure ??
    result.stderr.failure ??
    result.process_error ??
    (result.missing_stream ? "Standalone stream unavailable" : null);
  try {
    if (JSON.stringify(await binaryIdentity(executable)) !== JSON.stringify(identity))
      failure ??= "Standalone test binary changed during execution";
  } catch (error) {
    failure ??= errorMessage(error);
  }
  let complete =
    observation.complete &&
    !failure &&
    !result.signal &&
    result.status === 0 &&
    observation.failed === 0;
  try {
    (options.publishReceipt ?? ((file, bytes) => writeFileSync(file, bytes, { flag: "wx" })))(
      path.join(packet, "receipt.json"),
      JSON.stringify(
        {
          ...request,
          native_status: result.status,
          signal: result.signal,
          complete,
          reporting_failure: failure,
          observation,
          duration_ms: result.duration_ms,
          interpretation:
            "Unfiltered compiled binary outcomes. Host platform is observed; build-source/target provenance is not inferred. Static source attributes are not execution counts. Raw streams are bounded independently.",
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    complete = false;
    failure ??= errorMessage(error);
  }
  try {
    writeSync(
      1,
      "Standalone Rust tests: " +
        JSON.stringify({
          ...request,
          complete,
          discovered: observation.discovered,
          selected: observation.selected,
          executed: observation.executed,
          skipped: observation.skipped,
          failed: observation.failed,
          native_status: result.status,
          reporting_failure: failure,
        }) +
        "\n",
    );
  } catch {
    complete = false;
  }
  return result.status !== null && result.status > 0 ? result.status : complete ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [binary, ...extra] = process.argv.slice(2);
    if (!binary || extra.length) throw new Error("usage: standalone-rust-tests.mts BINARY");
    process.exitCode = await runStandaloneRustTests(binary);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
