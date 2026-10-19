import { reenterResourceCommand } from "./resource-command.mts";
import { inspectSemanticFixtureEvents } from "./release-semantic-runtime.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, link } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const mode = process.argv[2] ?? "normal";
if (mode === "reader-preflight-series") {
  if (process.platform !== "win32") throw new Error("native Windows boundary required");
  if (process.argv.length !== 3) throw new Error("fixed preflight series takes no other inputs");
  await reenterResourceCommand("analysis", import.meta.url);
  for (const fixture of ["storage-readonly", "reader-fixture", "codex-fixture"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), fixture], {
      stdio: "inherit",
      windowsHide: true,
      timeout: 180000,
    });
    if (child.error || child.status !== 0) {
      console.error(`preflight stopped at ${fixture}; preserve its actual refusal`);
      process.exit(child.status ?? 1);
    }
  }
  process.exit(0);
}
const bounded = process.argv[3] === "--bounded-storage";
if (
  process.argv.length > (bounded ? 4 : 3) ||
  (bounded && !["reader-fixture", "codex-fixture", "storage-readonly"].includes(mode))
)
  throw new Error("fixed inert bounded-storage selection required");
if (
  ![
    "normal",
    "hardlink",
    "flood",
    "descendant",
    "readonly",
    "storage-readonly",
    "reader-fixture",
    "codex-fixture",
  ].includes(mode)
)
  throw new Error(
    "usage: qualify-semantic-isolation.mts normal|hardlink|flood|descendant|readonly|storage-readonly|reader-fixture|codex-fixture [--bounded-storage]",
  );
if (process.platform !== "win32") throw new Error("native Windows boundary required");
await reenterResourceCommand("analysis", import.meta.url);
await mkdir(path.resolve("work/slice4"), { recursive: true });
const root = await mkdtemp(path.resolve("work/slice4/semantic-isolation-"));
for (const dir of ["runtime", "inputs", "capture", "work", "sensitive"])
  await mkdir(path.join(root, dir));
await writeFile(path.join(root, ".portcove-semantic-review-owned"), "inert qualification only\n");
await copyFile(process.execPath, path.join(root, "runtime/node.exe"));
await writeFile(path.join(root, "inputs/instructions.txt"), "inert probe\n");
await writeFile(path.join(root, "inputs/frozen.txt"), "frozen inputs\n");
await writeFile(path.join(root, "sensitive/issuer.inert"), "NOT-A-CREDENTIAL\n");
await writeFile(
  path.join(root, "inputs/probe.mts"),
  `
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const root=process.argv[2];
function refused(f){try{f();return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}}
const facts={read_input:readFileSync(path.join(root,'inputs/frozen.txt'),'utf8')==='frozen inputs\\n',
issuer_read_denied:refused(()=>readFileSync(path.join(root,'sensitive/issuer.inert'))),
input_write_denied:refused(()=>writeFileSync(path.join(root,'inputs/frozen.txt'),'changed')),
capture_write_denied:refused(()=>writeFileSync(path.join(root,'capture/forged.json'),'forged')),
inherited_issuer_environment_absent:!Object.keys(process.env).some(k=>/TOKEN|GH_|GITHUB|SECRET|KEY/.test(k))};
writeFileSync(path.join(root,'work/result.json'),JSON.stringify(facts));console.log(JSON.stringify(facts));
if(!Object.values(facts).every(Boolean))process.exitCode=1;
`,
);
if (mode === "flood")
  await writeFile(
    path.join(root, "inputs/probe.mts"),
    `const bytes=Buffer.alloc(65536,120);for(;;)process.stdout.write(bytes);`,
  );
if (mode === "descendant")
  await writeFile(
    path.join(root, "inputs/probe.mts"),
    `import {spawn} from 'node:child_process';const p=spawn(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});p.unref();console.log(p.pid);`,
  );
if (mode === "hardlink") {
  const canary = path.join(path.dirname(root), "hardlink-canary-" + path.basename(root));
  await writeFile(canary, "external task-owned canary");
  const observation = spawnSync("icacls.exe", [canary], { encoding: "utf8", windowsHide: true });
  if (observation.error || observation.status !== 0)
    throw new Error("canary ACL preimage unavailable");
  const acl = observation.stdout;
  await link(canary, path.join(root, "inputs/hardlink.data"));
  await writeFile(path.join(root, "capture/canary-preimage.txt"), acl);
}
if (mode === "readonly")
  await writeFile(
    path.join(root, "inputs/probe.mts"),
    `
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
const root=process.argv[2];
function denied(f){try{f();return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}}
const facts={read_input:readFileSync(path.join(root,'inputs/frozen.txt'),'utf8')==='frozen inputs\\n',
work_write_denied:denied(()=>writeFileSync(path.join(root,'work/new.data'),'x')),
temp_write_denied:denied(()=>writeFileSync(path.join(process.env.TEMP,'temp.data'),'x')),
real_profile_write_denied:denied(()=>writeFileSync(path.join(process.env.PORTCOVE_REVIEW_PROFILE,'profile.data'),'x')),
input_attribute_write_denied:denied(()=>chmodSync(path.join(root,'inputs/frozen.txt'),0o777)),
issuer_read_denied:denied(()=>readFileSync(path.join(root,'sensitive/issuer.inert'))),
capture_write_denied:denied(()=>writeFileSync(path.join(root,'capture/forged'),'x'))};
console.log(JSON.stringify(facts));if(!Object.values(facts).every(Boolean))process.exitCode=1;
`,
  );
console.log("owned root", root);
if (mode === "storage-readonly") {
  await writeFile(path.join(root, "inputs/frozen.txt"), "frozen inputs" + String.fromCharCode(10));
  await writeFile(path.join(root, "inputs/allapps-only.txt"), "inert capability canary");
  const compile = spawnSync(
    "C:/Users/bobur/.local/share/retcomm/toolchains/cmake-clang-v1/1.0.14/bin/clang++.exe",
    [
      "-O2",
      "-static",
      "-municode",
      "scripts/fixtures/semantic-storage-probe.cpp",
      "-o",
      path.join(root, "runtime/storage-probe.exe"),
      "-luserenv",
      "-ladvapi32",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  await writeFile(path.join(root, "capture/compiler.stdout"), compile.stdout ?? "");
  await writeFile(path.join(root, "capture/compiler.stderr"), compile.stderr ?? "");
  if (compile.error || compile.status !== 0)
    throw new Error(`storage probe compilation failed; retain ${root}`);
}
if (mode === "reader-fixture" || mode === "codex-fixture") {
  const data = Buffer.from("inert fixture" + String.fromCharCode(10));
  const oid = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  const entry = { path: "fixture.txt", oid, mode: "100644" };
  const payload = Buffer.from(
    JSON.stringify({
      bundle_sha256: "0".repeat(64),
      manifest: {
        qualification: "inert reader protocol fixture; no release opportunity or acceptance",
        snapshots: { source: [entry], baseline: [entry] },
      },
      files: [
        {
          name: `objects/${oid}.data`,
          sha256: createHash("sha256").update(data).digest("hex"),
          data: data.toString("base64"),
        },
      ],
    }),
  );
  await writeFile(path.join(root, "inputs/reader-index.json"), payload);
  await writeFile(
    path.join(root, "inputs/reader-launch.json"),
    JSON.stringify({
      schema_version: 1,
      index_sha256: createHash("sha256").update(payload).digest("hex"),
    }),
  );
  for (const name of [
    "release-semantic-reader-core.mts",
    "release-semantic-reader-server.mts",
    "runtime-values.mts",
  ])
    await copyFile(new URL(name, import.meta.url), path.join(root, "runtime", name));
  const requests =
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "read",
          arguments: { snapshot: "source", path: "fixture.txt", offset: 0, length: 1024 },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "search", arguments: { snapshot: "source", literal: "fixture" } },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  if (mode === "reader-fixture")
    await writeFile(path.join(root, "inputs/instructions.txt"), requests);
}
if (mode === "codex-fixture") {
  const executable = "C:/Users/bobur/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe";
  const bytes = await readFile(executable);
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    "dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f"
  )
    throw new Error("installed fixture runtime changed; refresh and review exact identity");
  await copyFile(executable, path.join(root, "runtime/codex.exe"));
  await writeFile(
    path.join(root, "inputs/instructions.txt"),
    'Inert runtime qualification only. Use only portcove_frozen_bundle read(source,fixture.txt,0,1024) and verify its inert bytes, then return {"fixture":"inert"}. No other tools, credentials or release review.\n',
  );
  await writeFile(
    path.join(root, "inputs/result-schema.json"),
    JSON.stringify({
      type: "object",
      properties: { fixture: { type: "string", const: "inert" } },
      required: ["fixture"],
      additionalProperties: false,
    }),
  );
}
const result = spawnSync(
  "pwsh.exe",
  [
    "-NoProfile",
    "-File",
    "scripts/semantic-review-sandbox.ps1",
    "-RunRoot",
    root,
    "-Mode",
    mode === "codex-fixture" ? "fixture" : mode === "reader-fixture" ? "reader-fixture" : "probe",
    ...(["readonly", "storage-readonly", "reader-fixture", "codex-fixture"].includes(mode)
      ? ["-ReadOnlyStorage"]
      : []),
    ...(mode === "storage-readonly" ? ["-StorageProbe"] : []),
    ...(bounded
      ? [
          "-BoundedStorageConfiguration",
          fileURLToPath(
            new URL(
              "../docs/qualification/slice4-semantic-local-storage.proposed.json",
              import.meta.url,
            ),
          ),
        ]
      : []),
  ],
  { encoding: "utf8", windowsHide: true, timeout: bounded ? 180000 : 120000 },
);
await writeFile(path.join(root, "capture/launcher.stdout"), result.stdout ?? "");
await writeFile(path.join(root, "capture/launcher.stderr"), result.stderr ?? "");
console.log("launcher", result.status, result.error?.message);
console.log((result.stderr ?? "").slice(-3000));
if (mode === "hardlink") {
  const canary = path.join(path.dirname(root), "hardlink-canary-" + path.basename(root));
  const observation = spawnSync("icacls.exe", [canary], { encoding: "utf8", windowsHide: true });
  if (observation.error || observation.status !== 0)
    throw new Error("canary ACL readback unavailable");
  const acl = observation.stdout;
  const before = await readFile(path.join(root, "capture/canary-preimage.txt"), "utf8");
  console.log("external-canary-acl-unchanged", acl === before);
  if (
    result.error ||
    result.status !== 1 ||
    acl !== before ||
    !result.stderr.includes('Exception calling "LockBoundary"') ||
    !result.stderr.includes('"reparse/hard-linked boundary refused"')
  )
    throw new Error("expected pre-ACL hardlink refusal was not observed");
}
try {
  console.log(await readFile(path.join(root, "capture/isolation.json"), "utf8"));
  if (mode !== "flood")
    console.log(await readFile(path.join(root, "capture/stdout.jsonl"), "utf8"));
  console.log(await readFile(path.join(root, "capture/stderr.txt"), "utf8"));
} catch (e) {
  console.log(errorMessage(e));
}
if (mode === "flood" || mode === "descendant") {
  const record: unknown = JSON.parse(
    await readFile(path.join(root, "capture/isolation.json"), "utf8"),
  );
  if (
    !isRecord(record) ||
    !isRecord(record.process) ||
    typeof record.process.StdoutBytes !== "number" ||
    result.error ||
    result.status !== 1 ||
    record.mode !== "probe" ||
    record.profile_deleted !== true ||
    typeof record.expected_sid !== "string" ||
    record.process.ObservedSid !== record.expected_sid ||
    record.process.IsAppContainer !== true ||
    record.process.TreeEmpty !== true ||
    record.process.ForcedTermination !== true ||
    (mode === "flood" &&
      (record.process.StdoutBytes !== 16 * 1024 * 1024 ||
        record.process.CaptureComplete !== false)) ||
    (mode === "descendant" && record.process.CaptureComplete !== true)
  )
    throw new Error("negative containment did not refuse safely");
  if (mode === "descendant") {
    const child = (await readFile(path.join(root, "capture/stdout.jsonl"), "utf8")).trim();
    if (
      !/^[1-9]\d*$/u.test(child) ||
      Number(child) === record.process.Pid ||
      record.process.ExitCode !== 0 ||
      typeof record.process.ActiveBeforeTermination !== "number" ||
      record.process.ActiveBeforeTermination < 1
    )
      throw new Error("persistent descendant was not actually established before teardown");
  }
}
if (["readonly", "storage-readonly", "reader-fixture", "codex-fixture"].includes(mode)) {
  const record: unknown = JSON.parse(
    await readFile(path.join(root, "capture/isolation.json"), "utf8"),
  );
  if (
    !isRecord(record) ||
    !isRecord(record.process) ||
    record.read_only_storage !== true ||
    !Array.isArray(record.cleanup_errors) ||
    record.cleanup_errors.length !== 0 ||
    record.profile_deleted !== true ||
    typeof record.expected_sid !== "string" ||
    record.process.ObservedSid !== record.expected_sid ||
    record.process.IsAppContainer !== true ||
    record.process.ExitCode !== 0 ||
    record.process.RegistryReadOnly !== true ||
    record.process.RegistryCanariesIntact !== true ||
    record.process.AllApplicationPackagesGrantRefused !== true ||
    record.process?.TreeEmpty !== true ||
    record.process?.ForcedTermination !== false ||
    record.process?.CaptureComplete !== true
  )
    throw new Error("read-only storage qualification incomplete; retain native failure");
}
if (mode === "codex-fixture" && result.status === 0) {
  const fixture = inspectSemanticFixtureEvents(
    await readFile(path.join(root, "capture/stdout.jsonl")),
  );
  await writeFile(path.join(root, "capture/inert-fixture-result.json"), JSON.stringify(fixture));
}
if (mode === "reader-fixture" && result.status === 0) {
  const rows: unknown[] = (await readFile(path.join(root, "capture/stdout.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  const read = rows.find((row) => isRecord(row) && row.id === 3);
  if (
    rows.length !== 4 ||
    !isRecord(read) ||
    !isRecord(read.result) ||
    !Array.isArray(read.result.content) ||
    !isRecord(read.result.content[0]) ||
    typeof read.result.content[0].text !== "string"
  )
    throw new Error("native reader response incomplete");
  const value: unknown = JSON.parse(read.result.content[0].text);
  if (!isRecord(value) || value.data !== Buffer.from("inert fixture\n").toString("base64"))
    throw new Error("native reader returned different frozen bytes");
}
process.exitCode = [
  "normal",
  "readonly",
  "storage-readonly",
  "reader-fixture",
  "codex-fixture",
].includes(mode)
  ? (result.status ?? 1)
  : 0;
