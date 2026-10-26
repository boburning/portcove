import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions, SpawnSyncOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./runtime-values.mts";
import { parseRustdocOutcomes, rustdocMaximumBytes } from "./rustdoc-outcomes.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
type MetadataRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => { status: number | null; stdout?: string | Buffer | null; error?: Error };
type ChildRunner = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Preserve the two independently compiled documentation scopes. */
export function qualificationRustdocRecipe(mode: string) {
  if (mode === "workspace")
    return ["test", "--locked", "--workspace", "--exclude", "portcove-desktop", "--doc"];
  if (mode === "desktop") return ["test", "--locked", "-p", "portcove-desktop", "--doc"];
  throw new Error("Expected workspace or desktop documentation scope");
}

function captureStream(
  file: string,
  descriptor: number,
  publish: (descriptor: number, chunk: Buffer) => unknown,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: string | null = null;
  writeFileSync(file, "", { flag: "wx" });
  return {
    capture(chunk: Buffer) {
      const retained = chunk.subarray(0, Math.max(0, rustdocMaximumBytes - bytes));
      bytes += chunk.length;
      if (retained.length) {
        chunks.push(retained);
        try {
          appendFileSync(file, retained);
          publish(descriptor, retained);
        } catch (error) {
          failure ??= errorMessage(error);
        }
      }
      if (bytes > rustdocMaximumBytes) failure ??= "Rustdoc stream exceeds byte limit";
    },
    fail(error: Error) {
      failure ??= errorMessage(error);
    },
    result() {
      const raw = Buffer.concat(chunks);
      if (!isUtf8(raw)) failure ??= "Rustdoc stream is not valid UTF-8";
      return {
        raw: raw.toString("utf8"),
        sha256: createHash("sha256").update(raw).digest("hex"),
        observed_bytes: bytes,
        retained_bytes: raw.length,
        failure,
      };
    },
  };
}

async function executeCargo(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  packet: string,
  start: ChildRunner,
  publish: (descriptor: number, chunk: Buffer) => unknown,
) {
  const stdout = captureStream(path.join(packet, "stdout.jsonl"), 1, publish);
  const stderr = captureStream(path.join(packet, "stderr.txt"), 2, publish);
  const started = performance.now();
  const child = start("cargo", args, {
    cwd,
    env: environment,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  });
  let processError: string | null = null;
  child.stdout?.on("data", (chunk: Buffer) => stdout.capture(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.capture(chunk));
  child.stdout?.on("error", (error) => stdout.fail(error));
  child.stderr?.on("error", (error) => stderr.fail(error));
  child.on("error", (error) => {
    processError = errorMessage(error);
  });
  const result = await new Promise<{ status: number | null; signal: string | null }>((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  return {
    ...result,
    process_error: processError,
    duration_ms: performance.now() - started,
    stdout: stdout.result(),
    stderr: stderr.result(),
    missing_stream: !child.stdout || !child.stderr,
  };
}

function documentationRequest(
  mode: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  run: MetadataRunner,
) {
  const label = (name: string) => environment[name] ?? null;
  if (environment.RUSTC_BOOTSTRAP !== undefined && environment.RUSTC_BOOTSTRAP !== "-1")
    throw new Error("Documentation reporter refuses inherited bootstrap overrides");
  if (process.versions.node !== readFileSync(path.join(cwd, ".node-version"), "utf8").trim())
    throw new Error("Documentation reporting requires the repository-pinned Node");
  const metadata = (command: string, args: string[]) => {
    const result = run(command, args, {
      cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0)
      throw new Error("Documentation metadata unavailable: " + command);
    return String(result.stdout ?? "").trim();
  };
  const checkout = metadata("git", ["rev-parse", "HEAD"]);
  const source = environment.PORTCOVE_HEAD_SHA || checkout;
  if (!/^[0-9a-f]{40}$/u.test(checkout) || !/^[0-9a-f]{40}$/u.test(source))
    throw new Error("Documentation source or checkout identity unavailable");
  const compiler = metadata("rustc", ["--version", "--verbose"]);
  const pin = /^\s*channel\s*=\s*"([^"]+)"\s*$/mu.exec(
    readFileSync(path.join(cwd, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (!pin || !compiler.split(/\r?\n/u).includes("release: " + pin))
    throw new Error("Documentation compiler differs from repository pin");
  return {
    format_version: 1,
    runner: "rustdoc-libtest",
    invocation_id: randomUUID(),
    mode,
    command: ["cargo", ...args],
    source,
    checkout,
    tracked_source_dirty: Boolean(
      metadata("git", ["status", "--porcelain", "--untracked-files=no"]),
    ),
    compiler,
    cargo: metadata("cargo", ["--version"]),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    run: label("GITHUB_RUN_ID"),
    attempt: label("GITHUB_RUN_ATTEMPT"),
    job: label("GITHUB_JOB"),
    child_environment: {
      RUSTC_BOOTSTRAP: "-1",
      RUSTFLAGS: label("RUSTFLAGS"),
      RUSTDOCFLAGS: label("RUSTDOCFLAGS"),
      CARGO_ENCODED_RUSTFLAGS: label("CARGO_ENCODED_RUSTFLAGS"),
      CARGO_ENCODED_RUSTDOCFLAGS: label("CARGO_ENCODED_RUSTDOCFLAGS"),
      RUSTC: label("RUSTC"),
      RUSTDOC: label("RUSTDOC"),
      RUSTC_WRAPPER: label("RUSTC_WRAPPER"),
      RUSTC_WORKSPACE_WRAPPER: label("RUSTC_WORKSPACE_WRAPPER"),
    },
  };
}

function invocationOutcome(
  result: Awaited<ReturnType<typeof executeCargo>>,
  observation: ReturnType<typeof parseRustdocOutcomes>,
) {
  const reportingFailure =
    result.stdout.failure ??
    result.stderr.failure ??
    (result.missing_stream ? "Documentation stream unavailable" : null);
  const contradictorySuccess = result.status === 0 && observation.failed > 0;
  const scopeComplete =
    observation.complete &&
    result.status === 0 &&
    !result.signal &&
    !reportingFailure &&
    !result.process_error &&
    !contradictorySuccess;
  const nativeStatus = result.process_error ? 1 : (result.status ?? 1);
  return { reportingFailure, contradictorySuccess, scopeComplete, nativeStatus };
}

export async function runQualificationRustdoc(
  mode: string,
  dependencies: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    spawnSync?: MetadataRunner;
    spawn?: ChildRunner;
    publishReceipt?: (file: string, text: string) => void;
    publishRaw?: (descriptor: number, chunk: Buffer) => unknown;
  } = {},
) {
  const cwd = dependencies.cwd ?? root;
  const recipe = qualificationRustdocRecipe(mode);
  const environment = { ...(dependencies.environment ?? process.env) };
  const args = [...recipe, "--", "--format=json", "-Zunstable-options", "--report-time"];
  const request = documentationRequest(
    mode,
    args,
    cwd,
    environment,
    dependencies.spawnSync ?? spawnSync,
  );
  const directory = path.join(cwd, "work", "test-results");
  mkdirSync(directory, { recursive: true });
  const packet = mkdtempSync(path.join(directory, "rustdoc-"));
  writeFileSync(path.join(packet, "request.json"), JSON.stringify(request, null, 2) + "\n", {
    flag: "wx",
  });
  // -1 keeps compilation stable; pinned libtest currently admits experimental runtime formatting.
  const result = await executeCargo(
    args,
    cwd,
    { ...environment, RUSTC_BOOTSTRAP: "-1" },
    packet,
    dependencies.spawn ?? spawn,
    dependencies.publishRaw ?? writeSync,
  );
  const observation = parseRustdocOutcomes(result.stdout.raw);
  const { reportingFailure, contradictorySuccess, scopeComplete, nativeStatus } = invocationOutcome(
    result,
    observation,
  );
  let complete = scopeComplete;
  let receiptFailure: string | null = null;
  try {
    (dependencies.publishReceipt ?? ((file, text) => writeFileSync(file, text, { flag: "wx" })))(
      path.join(packet, "receipt.json"),
      JSON.stringify(
        {
          ...request,
          ...observation,
          stream_complete: observation.complete,
          scope_complete: scopeComplete,
          observed_discovered: observation.discovered,
          observed_selected: observation.selected,
          discovered: scopeComplete ? observation.discovered : null,
          selected: scopeComplete ? observation.selected : null,
          complete,
          native_status: result.status,
          signal: result.signal,
          process_error: result.process_error,
          reporting_failure: reportingFailure,
          contradictory_success: contradictorySuccess,
          invocation_duration_ms: result.duration_ms,
          stdout_sha256: result.stdout.sha256,
          stderr_sha256: result.stderr.sha256,
          observed_stdout_bytes: result.stdout.observed_bytes,
          observed_stderr_bytes: result.stderr.observed_bytes,
          retained_stdout_bytes: result.stdout.retained_bytes,
          retained_stderr_bytes: result.stderr.retained_bytes,
          limits:
            "Doctests only. Counts/cases are observations; a nonzero, signalled or incompletely captured invocation cannot establish whole-recipe discovery/selection. Explicit zero-case native suites are zero executions. Unknown ignore reasons remain null. Native per-case time and separate rustdoc compilation/total phases have different scopes. Bootstrap -1 reaches the Cargo child, build scripts and doctest compiler; native acceptance provenance policy is unchanged. Each raw stream is capped at32MiB and over-limit reporting is incomplete.",
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    receiptFailure = errorMessage(error);
    complete = false;
  }
  try {
    writeSync(
      1,
      "Rustdoc tests: " +
        JSON.stringify({
          mode,
          source: request.source,
          checkout: request.checkout,
          complete,
          executed: observation.executed,
          skipped: observation.skipped,
          failed: observation.failed,
          native_status: result.status,
          reporting_failure: receiptFailure ?? reportingFailure,
          packet,
        }) +
        "\n",
    );
  } catch {
    complete = false;
  }
  return nativeStatus !== 0 ? nativeStatus : complete ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...extra] = process.argv.slice(2);
    if (!mode || extra.length)
      throw new Error("usage: qualification-rustdoc.mts workspace|desktop");
    process.exitCode = await runQualificationRustdoc(mode);
  } catch (error) {
    try {
      writeSync(2, errorMessage(error) + "\n");
    } finally {
      process.exitCode = 1;
    }
  }
}
