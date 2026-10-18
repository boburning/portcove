import { reenterResourceCommand } from "./resource-command.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, link } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
const mode = process.argv[2] ?? "normal";
if (!["normal", "hardlink", "flood", "descendant"].includes(mode))
  throw new Error("usage: qualify-semantic-isolation.mts normal|hardlink|flood|descendant");
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
console.log("owned root", root);
const result = spawnSync(
  "pwsh.exe",
  [
    "-NoProfile",
    "-File",
    "scripts/semantic-review-sandbox.ps1",
    "-RunRoot",
    root,
    "-Mode",
    "probe",
  ],
  { encoding: "utf8", windowsHide: true, timeout: 120000 },
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
}
process.exitCode = mode === "normal" ? (result.status ?? 1) : 0;
