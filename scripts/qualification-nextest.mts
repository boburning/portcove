import type { SpawnSyncOptions } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, isRecord } from "./runtime-values.mts";
import {
  nextestOutcomeSelection,
  runnableNextestTests,
  runNextestWithOutcomes,
} from "./nextest-outcomes.mts";

const root = fileURLToPath(new URL("../", import.meta.url));
function diagnosticMessage(
  text: string,
  write: (value: string) => unknown = (value) => process.stderr.write(value),
) {
  try {
    write(text);
  } catch {
    /* An unavailable diagnostic sink cannot replace an original native failure. */
  }
}
type Runner = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => {
  status: number | null;
  error?: Error;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

/** The three existing qualification commands, without arbitrary selector overrides. */
export function qualificationNextestRecipe(
  mode: string,
  partition: string | undefined,
  cwd: string,
) {
  if (mode === "workspace-other" && partition === undefined) {
    const scope = ["--locked", "--workspace", "--exclude", "portcove-core"];
    return { scope, selected: [...scope] };
  }
  if (mode === "native" && partition === "hash:1/1") {
    const scope = ["--locked", "--workspace"];
    return { scope, selected: [...scope, "--partition", partition] };
  }
  if (
    mode === "intel" &&
    typeof partition === "string" &&
    ["hash:1/2", "hash:2/2"].includes(partition)
  ) {
    const scope = [
      "--archive-file",
      "work/intel-tests/intel-tests.tar.zst",
      "--workspace-remap",
      cwd,
    ];
    return { scope, selected: [...scope, "--partition", partition] };
  }
  throw new Error("Expected workspace-other, native hash:1/1, or intel hash:1/2|hash:2/2");
}

export function qualificationNextestSelection(complete: unknown, selected: unknown) {
  const all = runnableNextestTests(complete);
  if (!all.size) throw new Error("Qualification complete runnable inventory is empty");
  // This also validates complete binary names/kinds and ignored declarations.
  const compiled = nextestOutcomeSelection(complete, all);
  const chosen = runnableNextestTests(selected, { allowSkipped: true, allowDefaultSkipped: true });
  if (!chosen.size) throw new Error("Qualification selected runnable inventory is empty");
  if ([...chosen].some((identity) => !all.has(identity)))
    throw new Error("Qualification selection escaped complete discovery");
  const outcomes = nextestOutcomeSelection(selected, chosen);
  for (const [key, binary] of outcomes.binaries) {
    const original = compiled.binaries.get(key);
    if (
      !original ||
      [...binary.cases].some(
        ([name, entry]) => original.cases.get(name)?.identity !== entry.identity,
      )
    )
      throw new Error("Qualification selected binary metadata differs from complete discovery");
  }
  return { all, outcomes, compiledCount: compiled.discovered };
}

export function runQualificationNextest(
  mode: string,
  partition?: string,
  dependencies: {
    spawnSync?: Runner;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    report?: (text: string) => void;
    diagnostic?: (text: string) => void;
    publishReceipt?: (file: string, text: string) => void;
  } = {},
) {
  const cwd = dependencies.cwd ?? root;
  const recipe = qualificationNextestRecipe(mode, partition, cwd);
  const run = dependencies.spawnSync ?? spawnSync;
  const report = dependencies.report ?? ((text: string) => process.stdout.write(text + "\n"));
  const diagnostic = (text: string) => diagnosticMessage(text, dependencies.diagnostic);
  const publishReceipt =
    dependencies.publishReceipt ??
    ((file: string, text: string) => writeFileSync(file, text, { flag: "wx" }));
  const environment = { ...(dependencies.environment ?? process.env) };
  const directory = path.join(cwd, "work", "test-results");
  mkdirSync(directory, { recursive: true });
  const packet = mkdtempSync(path.join(directory, "qualification-"));
  const stages: {
    name: string;
    duration_ms: number;
    status: number | null;
    error: string | null;
  }[] = [];
  let nativeStatus: number | null = null;
  let status = 1;
  let failure: string | null = null;
  const execute = (name: string, command: string, args: string[]) => {
    const started = performance.now();
    const result = run(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: environment,
    });
    nativeStatus = result.status;
    stages.push({
      name,
      duration_ms: performance.now() - started,
      status: result.status,
      error: result.error ? errorMessage(result.error) : null,
    });
    writeFileSync(path.join(packet, name + ".stdout"), result.stdout ?? "", { flag: "wx" });
    writeFileSync(path.join(packet, name + ".stderr"), result.stderr ?? "", { flag: "wx" });
    if (result.stderr) diagnostic(String(result.stderr));
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${name} failed with original status ${result.status}`);
    return String(result.stdout ?? "");
  };
  try {
    const pin = readFileSync(path.join(cwd, ".node-version"), "utf8").trim();
    if (process.versions.node !== pin)
      throw new Error("Qualification reporting requires the repository-pinned Node");
    const checkout = execute("checkout", "git", ["rev-parse", "HEAD"]).trim();
    if (!/^[0-9a-f]{40}$/u.test(checkout))
      throw new Error("Qualification checkout identity is unavailable");
    if (environment.PORTCOVE_HEAD_SHA === undefined || environment.PORTCOVE_HEAD_SHA === "")
      environment.PORTCOVE_HEAD_SHA = checkout;
    if (!/^[0-9a-f]{40}$/u.test(environment.PORTCOVE_HEAD_SHA))
      throw new Error("Qualification source identity is unavailable");
    environment.PORTCOVE_CHECKOUT_SHA = checkout;
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(cwd, ".github", "quality-tools.json"), "utf8"),
    );
    if (!isRecord(manifest) || !Array.isArray(manifest.tools))
      throw new Error("Missing pinned nextest manifest");
    const tool: unknown = manifest.tools.find(
      (item: unknown) => isRecord(item) && item.id === "cargo-nextest",
    );
    if (!isRecord(tool) || typeof tool.version !== "string")
      throw new Error("Missing pinned nextest version");
    const version = execute("runner", "cargo-nextest", ["--version"]).trim();
    if (!version.startsWith(`cargo-nextest ${tool.version} `))
      throw new Error("Qualification nextest version differs from its pin");
    const request = {
      format_version: 1,
      invocation_id: randomUUID(),
      mode,
      partition: partition ?? null,
      recipe,
      profile: environment.NEXTEST_PROFILE ?? "default",
      node: process.version,
      runner: version,
      source: environment.PORTCOVE_HEAD_SHA,
      checkout,
      platform: process.platform,
      arch: process.arch,
      run: environment.GITHUB_RUN_ID ?? null,
      attempt: environment.GITHUB_RUN_ATTEMPT ?? null,
      job: environment.GITHUB_JOB ?? null,
    };
    writeFileSync(path.join(packet, "request.json"), JSON.stringify(request, null, 2) + "\n", {
      flag: "wx",
    });
    const complete: unknown = JSON.parse(
      execute("build-and-complete-inventory", "cargo-nextest", [
        "nextest",
        "list",
        ...recipe.scope,
        "-E",
        "all()",
        "--message-format",
        "json",
      ]),
    );
    const selected: unknown = JSON.parse(
      execute("selected-inventory", "cargo-nextest", [
        "nextest",
        "list",
        ...recipe.selected,
        "--message-format",
        "json",
      ]),
    );
    const selection = qualificationNextestSelection(complete, selected);
    report(
      `Rust qualification selection observation: ${JSON.stringify({ ...request, compiled_cases: selection.compiledCount, complete_runnable: [...selection.all].sort(), selected: [...selection.outcomes.selected].sort(), dispositions: "Original inventory stdout retains ignored/filter-match records and skipped binary status; absent platform declarations are unknown", complete: true })}`,
    );
    const started = performance.now();
    status = runNextestWithOutcomes(recipe.selected, selection.outcomes, {
      cwd,
      environment,
      spawnSync: (command, args, options) => {
        const result = run(command, args, options);
        nativeStatus = result.status;
        return result;
      },
      report: (text) => {
        appendFileSync(path.join(packet, "outcomes.log"), text + "\n");
        report(text);
      },
    });
    stages.push({
      name: "test-execution-and-reporting",
      duration_ms: performance.now() - started,
      status: nativeStatus,
      error: null,
    });
    if (status !== 0)
      failure = "Native failure or incomplete nextest outcomes; retain original streams";
  } catch (error) {
    status = nativeStatus !== null && nativeStatus !== 0 ? nativeStatus : 1;
    failure = errorMessage(error);
  }
  try {
    const files = [
      "build-and-complete-inventory.stdout",
      "selected-inventory.stdout",
      "outcomes.log",
    ];
    const hashes = files.flatMap((name) => {
      try {
        return [
          {
            name,
            sha256: createHash("sha256")
              .update(readFileSync(path.join(packet, name)))
              .digest("hex"),
          },
        ];
      } catch (error) {
        if (status === 0) {
          status = 1;
          failure = `Qualification artifact unavailable: ${name}: ${errorMessage(error)}`;
        }
        return [];
      }
    });
    publishReceipt(
      path.join(packet, "receipt.json"),
      JSON.stringify(
        {
          format_version: 1,
          mode,
          partition: partition ?? null,
          status,
          native_status: nativeStatus,
          failure,
          stages,
          hashes,
          complete: status === 0,
          limits:
            "Compiled current-platform package scope only; raw ignored/filter dispositions are not executions. Original stderr for test execution remains in CI/terminal output. Stage durations include compilation/setup and do not establish a speedup.",
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    if (status === 0) status = 1;
    diagnostic(`Qualification receipt incomplete: ${errorMessage(error)}\n`);
  }
  if (failure) diagnostic(failure + "\n");
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, partition, ...extra] = process.argv.slice(2);
    if (!mode || extra.length)
      throw new Error("usage: qualification-nextest.mts workspace-other|native|intel [partition]");
    process.exitCode = runQualificationNextest(mode, partition);
  } catch (error) {
    diagnosticMessage(errorMessage(error) + "\n");
    process.exitCode = 1;
  }
}
