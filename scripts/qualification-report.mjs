// Capture core-owned evidence and prepare an explicitly unassessed hands-on checklist.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify, parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  cli: { type: "string" }, library: { type: "string" }, output: { type: "string" },
} });
for (const name of ["cli", "library", "output"]) {
  if (!values[name]) throw new Error(`--${name} is required`);
}
const cli = resolve(values.cli);
const library = resolve(values.library);
const output = resolve(values.output);
if (!(await lstat(cli)).isFile() || !(await lstat(library)).isDirectory()
    || !(await lstat(join(library, "portcove.sqlite3"))).isFile()) {
  throw new Error("Use an existing CLI executable and initialized qualification library");
}
const hash = createHash("sha256");
for await (const chunk of createReadStream(cli)) hash.update(chunk);
const execute = promisify(execFile);
async function capture(...args) {
  const { stdout } = await execute(cli, ["--library", library, "--json", "--non-interactive", ...args], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
  });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(`${args.join(" ")}: ${envelope.error?.message}`);
  return envelope;
}
const commands = {
  doctor: ["doctor"], catalog: ["catalog", "export"], status: ["status"],
  sources: ["source", "list"], activity: ["activity", "--limit", "50"], storage: ["storage"],
};
const evidence = {};
// Sequential commands avoid taking a burst of library connections on slower hosts.
for (const [label, args] of Object.entries(commands)) evidence[label] = await capture(...args);
const catalog = evidence.catalog.data;
const statuses = evidence.status.data;
if (!Array.isArray(statuses) || !Array.isArray(catalog.ports)) throw new Error("Unsupported core report shape");
const installed = statuses.filter(status => status.active);
const observations = [];
for (const status of installed) {
  const port = catalog.ports.find(port => port.id === status.port_id);
  evidence[`backups:${status.port_id}`] = await capture("backup", "list", status.port_id);
  observations.push({ port_id: status.port_id, name: port?.name ?? status.port_id,
    install_id: status.active.id, artifact_sha256: status.active.artifact.sha256,
    version: status.active.version, source_profile: port?.source_profile ?? null,
    user_data_root: status.user_data_root, readiness: status.readiness,
    manual_observations: { gameplay: null, audio: null, controller: null, save_load: null }, notes: "",
  });
}
const report = {
  report_format: 1, captured_at: new Date().toISOString(), cli, cli_sha256: hash.digest("hex"), library,
  interpretation: "Core snapshots only. Null observations are unassessed. A report never grants qualification or edits the catalog.",
  observations, evidence,
};
await mkdir(output); // A new directory preserves every earlier evidence capture.
await writeFile(join(output, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
const clean = value => String(value).replace(/[\r\n|]/g, " ");
const rows = observations.map(item => `| ${clean(item.name)} | ${clean(item.version)} | ${item.readiness.launchable ? "Ready" : "Needs setup"} | Unassessed |`);
const checklist = `# Portcove qualification session

Captured ${report.captured_at}. CLI SHA-256: \`${report.cli_sha256}\`.
Library: \`${library}\`. Full versioned core responses are in evidence.json.

| Installed port | Version | Core readiness | Hands-on result |
| --- | --- | --- | --- |
${rows.join("\n")}

Use the isolated library above. Record the exact install ID, platform, date, and observed result in evidence.json or a separate session note. Null means unassessed.

- [ ] In each chosen game, observe gameplay, audio, Xbox/controller input, and a real save/load cycle.
- [ ] In Settings, cancel one GitHub device login, retry, and check readable recovery. Signing in grants account access and requires the account owner's action.
- [ ] With the controller, open Advanced controls → Update policy. A opens the choices; B closes one level at a time and returns visible focus. Repeat at the minimum window size.
- [ ] In Updates and Settings, compare activity order, failure/recovery copy, update badges after restart, source readiness, and native pickers with the captured core records.
- [ ] Create a backup of a disposable real save, advance it, restore through CLI and GUI, and confirm the game loads the restored state. Confirm the automatic safety backup recovers the newer state.

See docs/CATALOG.md for platform qualification rules and the live Portcove Roadmap for current game-specific source or upstream blockers. Automated evidence and hands-on observations remain separate.
`;
await writeFile(join(output, "checklist.md"), checklist, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ output, installed_ports: observations.length, cli_sha256: report.cli_sha256 })}\n`);
