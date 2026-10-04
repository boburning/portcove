// Capture core-owned evidence and prepare an explicitly unassessed checklist.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify, parseArgs } from "node:util";

function requiredIdentity(value, label) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing ${label} in core report`);
  return value;
}

function availableText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function reportRecords(statuses) {
  const ports = new Set();
  const identities = new Set();
  const records = [];
  for (const status of statuses) {
    const portId = requiredIdentity(status?.port_id, "port identity");
    if (ports.has(portId)) throw new Error(`Duplicate port identity in core report: ${portId}`);
    ports.add(portId);
    if (status.active != null && status.external_runtime != null)
      throw new Error(`Ambiguous managed and external runtime for ${portId}`);
    const record = status.active ?? status.external_runtime;
    if (record == null) continue;
    const kind = status.active != null ? "managed" : "external";
    const id = requiredIdentity(record.id, `${kind} record identity for ${portId}`);
    if (record.port_id != null && record.port_id !== portId)
      throw new Error(`Runtime record owner differs from status owner for ${portId}`);
    const identity = `${kind}:${id}`;
    if (identities.has(identity)) throw new Error(`Duplicate ${kind} record identity: ${id}`);
    identities.add(identity);
    records.push({ status, record, kind });
  }
  return records;
}

function observation({ status, record, kind }, port) {
  const managed = kind === "managed";
  return {
    port_id: status.port_id,
    name: port?.name ?? status.port_id,
    runtime_kind: kind,
    install_id: managed ? record.id : null,
    registration_id: managed ? null : record.id,
    artifact_sha256: availableText(managed ? record.artifact?.sha256 : record.archive_sha256),
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

function readinessLabel(readiness) {
  if (readiness?.launchable === true) return "Ready";
  if (readiness?.launchable === false) return "Needs setup";
  return "Unknown";
}

async function cliDigest(cli) {
  if (!(await lstat(cli)).isFile()) throw new Error(`Selected CLI is not a regular file: ${cli}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(cli)) hash.update(chunk);
  return hash.digest("hex");
}

export async function captureQualificationReport(options, execute = promisify(execFile)) {
  const cli = resolve(options.cli);
  const library = resolve(options.library);
  const output = resolve(options.output);
  if (
    !(await lstat(cli)).isFile() ||
    !(await lstat(library)).isDirectory() ||
    !(await lstat(join(library, "portcove.sqlite3"))).isFile()
  ) {
    throw new Error("Use an existing CLI executable and initialized qualification library");
  }
  const cliSha256 = await cliDigest(cli);
  async function requireCliIdentity() {
    try {
      if ((await cliDigest(cli)) !== cliSha256) throw new Error("Selected CLI SHA-256 differs");
    } catch (cause) {
      throw new Error(`Selected CLI identity changed: ${cli}`, { cause });
    }
  }
  async function capture(...args) {
    await requireCliIdentity();
    let envelope;
    let commandFailed = false;
    let commandError;
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
      envelope = JSON.parse(stdout);
      if (!envelope.ok) throw new Error(`${args.join(" ")}: ${envelope.error?.message}`);
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
  const evidence = {};
  // Sequential commands avoid taking a burst of library connections on slower hosts.
  for (const [label, args] of Object.entries(commands)) evidence[label] = await capture(...args);
  const catalog = evidence.catalog.data;
  const statuses = evidence.status.data;
  if (!Array.isArray(statuses) || !Array.isArray(catalog?.ports))
    throw new Error("Unsupported core report shape");
  const records = reportRecords(statuses);
  const observations = [];
  for (const item of records) {
    const port = catalog.ports.find((port) => port.id === item.status.port_id);
    if (item.kind === "managed")
      evidence[`backups:${item.status.port_id}`] = await capture(
        "backup",
        "list",
        item.status.port_id,
      );
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
  const clean = (value) => String(value).replace(/[\r\n|]/g, " ");
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
    options: { cli: { type: "string" }, library: { type: "string" }, output: { type: "string" } },
  });
  for (const name of ["cli", "library", "output"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  const result = await captureQualificationReport(values);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
