// Capture core-owned evidence and prepare an explicitly unassessed checklist.
// This file is copied alone into hash-bound qualification sessions and must
// remain executable before repository dependencies or adjacent helpers exist.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failureMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "Unknown failure";
  } catch {
    return "Failure with unserializable details";
  }
}
import type { ExecFileOptions } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify, parseArgs, isDeepStrictEqual } from "node:util";

const HELP = `Capture core diagnostics with an existing verified Portcove CLI and prepare an unassessed test checklist.

Usage: node scripts/qualification-report.mts --cli FILE --library DIRECTORY --output DIRECTORY
       node scripts/qualification-report.mts --help

Required arguments:
  --cli FILE           Existing regular CLI executable verified for this session.
  --library DIRECTORY Initialized test library containing portcove.sqlite3.
  --output DIRECTORY  New report directory; existing output is never replaced.

Options:
  --preparation-case FILE  Run the reviewed preparation/verification sequence instead
                           of read-only capture. See docs/CATALOG.md.
  --help               Show this help without executing the CLI or writing a report.

The report retains the selected CLI SHA-256 and core evidence. Gameplay, audio,
controllers or hardware controls, and save/load observations remain unassessed.
This tool does not change catalog qualification flags. Keep reports private:
they include local paths. Use the same reviewed source for the CLI and this tool.

Example:
  node scripts/qualification-report.mts --cli ./portcove.exe --library ./test-library --output ./report
`;

function unsupportedReport(detail: string) {
  return new Error(
    `The CLI returned a report format this tool does not support (${detail}). Use the CLI and qualification-report.mts from the same reviewed source.`,
  );
}

export interface QualificationReportOptions {
  cli: string;
  library: string;
  output: string;
}

// One repeated sequence, not an interpreter: only Core's reviewed preparation
// and immutable verification. The caller supplies an exact Core plan, not commands.
export async function qualifyPreparation(
  options: QualificationReportOptions & { caseFile: string },
  execute: QualificationTransport = promisify(execFile),
) {
  const cli = resolve(options.cli);
  const library = resolve(options.library);
  const output = resolve(options.output);
  const casePath = resolve(options.caseFile);
  const caseStat = await lstat(casePath);
  if (!caseStat.isFile() || caseStat.size > 8 * 1024 * 1024)
    throw new Error("Preparation case must be a bounded regular file");
  if (
    !(await lstat(library)).isDirectory() ||
    !(await lstat(join(library, "portcove.sqlite3"))).isFile()
  )
    throw new Error("Preparation qualification requires an initialized selected library");
  const caseBytes = await readFile(casePath);
  const value: unknown = JSON.parse(caseBytes.toString("utf8"));
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    !["synthetic", "actual"].includes(String(value.evidence_kind)) ||
    !isRecord(value.plan) ||
    !isRecord(value.environment) ||
    value.environment.platform !== process.platform ||
    value.environment.arch !== process.arch ||
    value.environment.node !== process.version
  )
    throw new Error("Unknown preparation case or mismatched execution environment");
  const cliSha256 = await cliDigest(cli);
  if (value.cli_sha256 !== cliSha256) throw new Error("Preparation case CLI identity differs");
  const expected = value.plan;
  const portId = requiredIdentity(expected.port_id, "case port");
  const fingerprint = requiredIdentity(expected.plan_sha256, "reviewed preparation plan");
  if (
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    !isRecord(expected.inputs) ||
    !isRecord(expected.inputs.install) ||
    !isRecord(expected.inputs.source) ||
    !isRecord(expected.inputs.options) ||
    !preparationFormatMatches(expected) ||
    !isRecord(expected.copy)
  )
    throw new Error("Preparation case has incomplete operation inputs");
  const inputs = expected.inputs;
  const install = inputs.install;
  if (!isRecord(install)) throw new Error("Preparation case has no managed installation");
  requiredIdentity(install.id, "managed installation ID");
  if (
    install.port_id !== portId ||
    !isRecord(install.artifact) ||
    typeof inputs.definition_sha256 !== "string" ||
    !isRecord(inputs.source_inspection)
  )
    throw new Error("Preparation case has mismatched retained scope");
  // Preserve the operation's entire retained inputs and inventories. In particular,
  // a declaration or the capture host never fills absent historical source facts.
  const environment = { platform: process.platform, arch: process.arch, node: process.version };
  const steps: Array<{ phase: string; elapsed_ms: number; response?: unknown; error?: string }> =
    [];
  let apiVersion: number | undefined;
  const started = performance.now();
  await mkdir(output); // Never replace a prior successful or failed attempt.
  await writeFile(join(output, "preparation-case.json"), caseBytes, { flag: "wx" });
  let failure: unknown;
  let failed = false;
  const capture = async (phase: string, args: string[], jsonl = false) => {
    const began = performance.now();
    let response: unknown;
    let error: unknown;
    try {
      if ((await cliDigest(cli)) !== cliSha256) throw new Error("Selected CLI identity changed");
      const result = await execute(
        cli,
        ["--library", library, jsonl ? "--jsonl" : "--json", "--non-interactive", ...args],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 600_000 },
      );
      response = jsonl
        ? result.stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => JSON.parse(line) as unknown)
        : (JSON.parse(result.stdout) as unknown);
      const envelope: unknown = Array.isArray(response) ? response.at(-1) : response;
      if (
        !isRecord(envelope) ||
        typeof envelope.schema_version !== "number" ||
        envelope.command !== args.slice(0, args[0] === "preparation" ? 2 : 1).join(".")
      )
        throw unsupportedReport(`${phase}: command or schema identity differs`);
      if (apiVersion !== undefined && envelope.schema_version !== apiVersion)
        throw new Error("CLI check version changed during qualification");
      apiVersion = envelope.schema_version;
      if (envelope.ok !== true) throw new Error(`${phase}: Core operation did not succeed`);
      if ((await cliDigest(cli)) !== cliSha256) throw new Error("Selected CLI identity changed");
      return envelope.data;
    } catch (cause) {
      error = cause;
      // Failed subprocesses may still supply the authoritative terminal failure.
      if (response === undefined && isRecord(cause) && typeof cause.stdout === "string")
        response = { stdout: cause.stdout };
      throw cause;
    } finally {
      const step = {
        phase,
        elapsed_ms: Math.round(performance.now() - began),
        response,
        ...(error === undefined ? {} : { error: failureMessage(error) }),
      };
      steps.push(step);
      await writeFile(join(output, `${phase}.json`), JSON.stringify(step, null, 2) + "\n", {
        flag: "wx",
      });
    }
  };
  try {
    const plan = await capture("plan-before", ["preparation", "plan", portId]);
    if (!isDeepStrictEqual(plan, expected))
      throw new Error("Reviewed preparation inputs changed; capture and review a new case");
    const before = await capture("verify-before", ["verify", portId]);
    if (!isRecord(before) || before.install_id !== install.id || before.valid !== true)
      throw new Error("Pre-preparation verification belongs to another or invalid installation");
    const prepared = await capture(
      "preparation-run",
      ["preparation", "run", portId, "--expected-plan", fingerprint, "--yes"],
      true,
    );
    if (
      !isRecord(prepared) ||
      prepared.port_id !== portId ||
      !isDeepStrictEqual(prepared.artifact, install.artifact) ||
      !isDeepStrictEqual(prepared.runtime, install.runtime)
    )
      throw new Error("Preparation result changed artifact or runtime scope");
    requiredIdentity(prepared.id, "prepared installation ID");
    const after = await capture("verify-after", ["verify", portId]);
    if (!isRecord(after) || after.install_id !== prepared.id || after.valid !== true)
      throw new Error("Post-preparation verification belongs to another or invalid installation");
    const current = await capture("plan-after", ["preparation", "plan", portId]);
    if (
      !isRecord(current) ||
      !isRecord(current.inputs) ||
      !isRecord(current.inputs.install) ||
      !preparationFormatMatches(current) ||
      current.format_version !== expected.format_version ||
      current.inputs.install.id !== prepared.id ||
      !isRecord(current.copy)
    )
      throw new Error("Post-preparation inventory does not describe the prepared installation");
    for (const key of ["definition_sha256", "source", "source_inspection", "host", "options"])
      if (!isDeepStrictEqual(inputs[key], current.inputs[key]))
        throw new Error(`Post-preparation ${key} scope changed`);
    for (const key of ["setup_tool", "conversion_tool"]) {
      const original = inputs[key];
      const next = current.inputs[key];
      if (original == null && next == null) continue;
      if (
        !isRecord(original) ||
        !isRecord(next) ||
        original.sha256 !== next.sha256 ||
        original.size !== next.size
      )
        throw new Error(`Post-preparation ${key} identity changed`);
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  const report = {
    report_format: 1,
    sequence: "reviewed-preparation-and-immutable-verification",
    result: failed ? "failed" : "passed",
    evidence_kind: value.evidence_kind,
    cli,
    cli_sha256: cliSha256,
    api_schema_version: apiVersion ?? null,
    library,
    environment,
    case_sha256: createHash("sha256").update(caseBytes).digest("hex"),
    operation_inputs: inputs,
    steps,
    elapsed_ms: Math.round(performance.now() - started),
    source_validation:
      "Retained Core source inspection is separate from upstream setup acceptance.",
    manual_observations: {
      launch: null,
      gameplay: null,
      audio: null,
      controller: null,
      save_load: null,
    },
    reuse: {
      production_operations: ["preparation.plan", "verify", "preparation.run"],
      per_title_commands: false,
      engineering_effort: null,
      comparative_baseline: null,
    },
    limitations:
      "Preparation and immutable verification only; inventories come from Core plans. No gameplay, managed update, rollback, backup, deletion or external-file ownership is established.",
    ...(failed ? { error: failureMessage(failure) } : {}),
  };
  await writeFile(join(output, "sequence.json"), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  if (failed) throw failure;
  return { output, result: "passed", cli_sha256: cliSha256 };
}
export type QualificationTransport = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string }>;
interface CapturedEnvelope {
  ok: true;
  data?: unknown;
  [key: string]: unknown;
}
// Retain complete raw snapshots; only identities are admitted here. Optional core
// facts stay unknown until their display projection, without claiming schema validation.
interface RuntimeSnapshot {
  status: Record<string, unknown>;
  record: Record<string, unknown>;
  portId: string;
  id: string;
  kind: "managed" | "external";
}

function requiredIdentity(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${label} in core report`);
  return value;
}

function availableText(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function reportRecords(statuses: unknown[]): RuntimeSnapshot[] {
  const ports = new Set();
  const identities = new Set();
  const records: RuntimeSnapshot[] = [];
  for (const status of statuses) {
    if (!isRecord(status)) throw unsupportedReport("status is not an object");
    const portId = requiredIdentity(status.port_id, "port identity");
    if (ports.has(portId)) throw new Error(`Duplicate port identity in core report: ${portId}`);
    ports.add(portId);
    if (status.active != null && status.external_runtime != null)
      throw new Error(`Ambiguous managed and external runtime for ${portId}`);
    const record = status.active ?? status.external_runtime;
    if (record == null) continue;
    const kind = status.active != null ? "managed" : "external";
    if (!isRecord(record)) throw unsupportedReport("runtime record is not an object");
    const id = requiredIdentity(record.id, `${kind} record identity for ${portId}`);
    if (record.port_id != null && record.port_id !== portId)
      throw new Error(`Runtime record owner differs from status owner for ${portId}`);
    const identity = `${kind}:${id}`;
    if (identities.has(identity)) throw new Error(`Duplicate ${kind} record identity: ${id}`);
    identities.add(identity);
    records.push({ status, record, kind, portId, id });
  }
  return records;
}

function observation(
  { status, record, kind, portId, id }: RuntimeSnapshot,
  port: Record<string, unknown> | undefined,
) {
  const managed = kind === "managed";
  return {
    port_id: portId,
    name: port?.name ?? portId,
    runtime_kind: kind,
    install_id: managed ? id : null,
    registration_id: managed ? null : id,
    artifact_sha256: availableText(
      managed
        ? isRecord(record.artifact)
          ? record.artifact.sha256
          : undefined
        : record.archive_sha256,
    ),
    immutable_tree_sha256: managed ? null : availableText(record.immutable_tree_sha256),
    version: availableText(record.version),
    // InstallRecord has no artifact-platform field; the capture host is not that identity.
    platform: managed ? null : availableText(record.platform),
    runtime_path: availableText(record.path),
    executable: availableText(managed ? record.selected_executable : record.executable),
    // Neither runtime record binds an installed source profile. A current
    // catalog declaration and the source inventory are separate snapshots.
    source_profile: null,
    catalog_source_profile: availableText(port?.source_profile),
    user_data_root: managed ? (status.user_data_root ?? null) : null,
    readiness: status.readiness ?? null,
    manual_observations: { gameplay: null, audio: null, controller: null, save_load: null },
    notes: "",
  };
}

function readinessLabel(readiness: unknown) {
  if ((isRecord(readiness) ? readiness.launchable : undefined) === true) return "Ready";
  if ((isRecord(readiness) ? readiness.launchable : undefined) === false) return "Needs setup";
  return "Unknown";
}

async function cliDigest(cli: string) {
  if (!(await lstat(cli)).isFile()) throw new Error(`Selected CLI is not a regular file: ${cli}`);
  const hash = createHash("sha256");
  for await (const rawChunk of createReadStream(cli)) {
    const chunk: unknown = rawChunk;
    if (!(chunk instanceof Uint8Array)) throw new Error("CLI stream yielded non-byte data");
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function captureQualificationReport(
  options: QualificationReportOptions,
  execute: QualificationTransport = promisify(execFile),
) {
  const cli = resolve(options.cli);
  const library = resolve(options.library);
  const output = resolve(options.output);
  try {
    if (
      !(await lstat(cli)).isFile() ||
      !(await lstat(library)).isDirectory() ||
      !(await lstat(join(library, "portcove.sqlite3"))).isFile()
    ) {
      throw new Error(
        "The CLI and library database must be regular files, and the library must be a directory.",
      );
    }
  } catch (cause) {
    throw new Error(
      `Provide an existing Portcove CLI executable verified for this session and an initialized test library containing portcove.sqlite3. Received --cli ${JSON.stringify(cli)} and --library ${JSON.stringify(library)}.`,
      { cause },
    );
  }
  const cliSha256 = await cliDigest(cli);
  async function requireCliIdentity() {
    try {
      if ((await cliDigest(cli)) !== cliSha256) throw new Error("Selected CLI SHA-256 differs");
    } catch (cause) {
      throw new Error(`Selected CLI identity changed: ${cli}`, { cause });
    }
  }
  async function capture(...args: string[]): Promise<CapturedEnvelope> {
    await requireCliIdentity();
    let envelope: CapturedEnvelope | undefined;
    let commandFailed = false;
    let commandError: unknown;
    try {
      const { stdout } = await execute(
        cli,
        ["--library", library, "--json", "--non-interactive", ...args],
        {
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          timeout: 120_000,
        },
      );
      let value: unknown;
      try {
        value = JSON.parse(stdout);
      } catch (cause) {
        throw new SyntaxError(unsupportedReport(`${args.join(" ")}: invalid JSON`).message, {
          cause,
        });
      }
      if (!isRecord(value))
        throw unsupportedReport(`${args.join(" ")}: response envelope is not an object`);
      if (value.ok !== true) {
        if (value.ok === false && isRecord(value.error) && typeof value.error.message === "string")
          throw new Error(`${args.join(" ")}: ${value.error.message}`);
        throw unsupportedReport(`${args.join(" ")}: expected a success or failure envelope`);
      }
      envelope = { ...value, ok: true };
    } catch (error) {
      commandFailed = true;
      commandError = error;
    }
    try {
      await requireCliIdentity();
    } catch (identityError) {
      if (commandFailed)
        throw new AggregateError(
          [commandError, identityError],
          "CLI capture failed and selected CLI identity changed",
          { cause: commandError },
        );
      throw identityError;
    }
    if (commandFailed) throw commandError;
    if (!envelope) throw new Error("Core capture did not return a response");
    return envelope;
  }
  const commands = {
    doctor: ["doctor"],
    catalog: ["catalog", "export"],
    status: ["status"],
    sources: ["source", "list"],
    activity: ["activity", "--limit", "50"],
    storage: ["storage"],
  };
  const evidence: Record<string, CapturedEnvelope> = {};
  // Sequential commands avoid taking a burst of library connections on slower hosts.
  for (const [label, args] of Object.entries(commands)) evidence[label] = await capture(...args);
  const catalog = evidence.catalog?.data;
  const statuses = evidence.status?.data;
  if (!Array.isArray(statuses) || !isRecord(catalog) || !Array.isArray(catalog.ports))
    throw unsupportedReport("expected a status array and a catalog with a ports array");
  const rawStatuses: unknown[] = statuses;
  const ports: unknown[] = catalog.ports;
  const records = reportRecords(rawStatuses);
  const observations = [];
  for (const item of records) {
    const port = ports.find(
      (port): port is Record<string, unknown> => isRecord(port) && port.id === item.portId,
    );
    if (item.kind === "managed")
      evidence[`backups:${item.portId}`] = await capture("backup", "list", item.portId);
    observations.push(observation(item, port));
  }
  const report = {
    report_format: 1,
    captured_at: new Date().toISOString(),
    cli,
    cli_sha256: cliSha256,
    library,
    interpretation:
      "Core snapshots only. Null observations are unassessed; null identity facts are unknown. Managed installs and non-owning external registrations remain distinct. A report never grants qualification or edits the catalog.",
    observations,
    evidence,
  };
  await mkdir(output); // A new directory preserves every earlier evidence capture.
  await writeFile(join(output, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  const clean = (value: unknown) => String(value).replace(/[\r\n|]/g, " ");
  const rows = observations.map(
    (item) =>
      `| ${clean(item.name)} | ${item.runtime_kind === "managed" ? "Managed install" : "External registration"} | ${clean(item.version ?? "Unknown")} | ${readinessLabel(item.readiness)} | Unassessed |`,
  );
  const managedTasks = observations.some((item) => item.runtime_kind === "managed")
    ? "\n- [ ] Managed installs only: create a backup of a disposable real save, advance it, restore through CLI and GUI, and confirm the game loads the restored state. Confirm the automatic safety backup recovers the newer state.\n"
    : "";
  const checklist = `# Portcove qualification session

Captured ${report.captured_at}. CLI SHA-256: \`${report.cli_sha256}\`.
Library: \`${library}\`. Full versioned core responses are in evidence.json.

| Port | Runtime route | Version | Core readiness | Direct observation |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

Record the exact install or registration ID, platform, artifact/tree identity, operation, method, date and observed result in evidence.json or a separate session note. Null observations are unassessed; null identity facts are unknown. Core readiness is not an observed gameplay result.

External registrations refer to player-owned runtimes and saves. This report does not establish their save locations or authorize Portcove backup, restore, replacement or deletion. A game's own reviewed writes remain separate from Portcove management.

- [ ] In each chosen game, observe gameplay, audio, the applicable controller/input path, and a real save/load cycle; record only the behavior and environment actually observed.
- [ ] In Settings, cancel one GitHub device login, retry, and check readable recovery. Signing in grants account access and requires the account owner's action.
- [ ] With the controller, open Advanced controls → Update policy. A opens the choices; B closes one level at a time and returns visible focus. Repeat at the minimum window size.
- [ ] In Updates and Settings, compare activity order, failure/recovery copy, update badges after restart, source readiness, and native pickers with the captured core records.
${managedTasks}

See docs/CATALOG.md for platform qualification rules and the live Portcove Roadmap for current game-specific source or upstream blockers. Automated evidence and direct observations remain separate.
`;
  await writeFile(join(output, "checklist.md"), checklist, { flag: "wx" });
  const installedPorts = records.filter((item) => item.kind === "managed").length;
  return {
    output,
    installed_ports: installedPorts,
    registered_ports: records.length - installedPorts,
    reported_ports: records.length,
    cli_sha256: report.cli_sha256,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      cli: { type: "string" },
      library: { type: "string" },
      output: { type: "string" },
      "preparation-case": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  for (const name of ["cli", "library", "output"] as const) {
    if (!values[name])
      throw new Error(
        `--${name} is required. Use --help for the verified CLI, initialized test library, and new report directory requirements.`,
      );
  }
  if (!values.cli || !values.library || !values.output) throw new Error("Missing report paths");
  const options = {
    cli: values.cli,
    library: values.library,
    output: values.output,
  };
  const result = values["preparation-case"]
    ? await qualifyPreparation({ ...options, caseFile: values["preparation-case"] })
    : await captureQualificationReport(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function preparationFormatMatches(plan: Record<string, unknown>) {
  if (!isRecord(plan.inputs) || !isRecord(plan.inputs.options)) return false;
  const { inputs } = plan;
  const mode = plan.inputs.options.mode;
  if (plan.format_version === 3 && mode === "source_only")
    return !Object.hasOwn(inputs, "setup_tool");
  return (
    ((plan.format_version === 1 && mode === "default") ||
      (plan.format_version === 2 && mode === "ghostship200_legacy")) &&
    isRecord(inputs.setup_tool)
  );
}
