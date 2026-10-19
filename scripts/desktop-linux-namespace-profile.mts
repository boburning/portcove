// Ubuntu's documented per-executable userns grant, only on a disposable hosted VM.
// https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

assert.equal(process.platform, "linux");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.ok(process.getuid && process.getuid() > 0);
assert.match(readFileSync("/etc/os-release", "utf8"), /^VERSION_ID="24\.04"$/mu);
const run = process.env.GITHUB_RUN_ID,
  attempt = process.env.GITHUB_RUN_ATTEMPT;
assert.match(run ?? "", /^[1-9][0-9]*$/u);
assert.match(attempt ?? "", /^[1-9][0-9]*$/u);
const name = `portcove-qualification-${run}-${attempt}`;
const directory = `/opt/${name}`;
const binary = `${directory}/node`;
const policy = `/etc/apparmor.d/${name}`;
const output = path.resolve("work/linux-namespace-profile");
const receipt = path.join(output, "profile.json");
const text = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ${name} ${binary} flags=(unconfined) {\n  userns,\n}\n`;
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sudo = (...args: string[]) =>
  execFileSync("sudo", ["-n", ...args], { encoding: "utf8", timeout: 15_000 });
const restriction = () =>
  readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8");
assert.equal(restriction().trim(), "1", "Global userns restriction must remain enabled");
if (process.argv[2] === "--prepare") {
  mkdirSync(output, { recursive: true });
  const candidate = path.join(output, "profile.txt");
  writeFileSync(candidate, text, { flag: "wx" });
  // Refuse foreign/existing paths; all privileged mutations have fixed destinations.
  sudo("test", "!", "-e", directory);
  sudo("test", "!", "-e", policy);
  sudo("install", "-d", "-o", "root", "-g", "root", "-m", "0755", directory);
  sudo("install", "-o", "root", "-g", "root", "-m", "0755", process.execPath, binary);
  sudo("install", "-o", "root", "-g", "root", "-m", "0644", candidate, policy);
  const nodeSha = digest(readFileSync(process.execPath));
  assert.equal(digest(readFileSync(binary)), nodeSha);
  assert.equal(readFileSync(policy, "utf8"), text);
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        name,
        directory,
        binary,
        policy,
        original_node: process.execPath,
        node_sha256: nodeSha,
        policy_sha256: digest(text),
        restriction: restriction(),
        phase: "installed",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  sudo("apparmor_parser", "--add", policy);
  const observed = execFileSync(
    binary,
    ["-e", "process.stdout.write(require('fs').readFileSync('/proc/self/attr/current','utf8'))"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.ok(observed.startsWith(`${name} (`), observed);
  writeFileSync(
    path.join(output, "activation.json"),
    JSON.stringify({ observed, restriction: restriction() }) + "\n",
    { flag: "wx" },
  );
  assert.ok(process.env.GITHUB_PATH && process.env.GITHUB_ENV);
  appendFileSync(process.env.GITHUB_PATH, directory + "\n");
  appendFileSync(process.env.GITHUB_ENV, `PORTCOVE_NAMESPACE_ORIGINAL_NODE=${process.execPath}\n`);
} else {
  assert.equal(process.argv[2], "--cleanup");
  const prior: unknown = JSON.parse(readFileSync(receipt, "utf8"));
  assert.ok(prior && typeof prior === "object" && "name" in prior && prior.name === name);
  assert.ok("node_sha256" in prior && digest(readFileSync(binary)) === prior.node_sha256);
  assert.equal(readFileSync(policy, "utf8"), text);
  // Cleanup is invoked with the original interpreter, after supervised joins.
  // Include privileged provisioning descendants. Any opaque userspace process
  // refuses withdrawal; kernel threads cannot execute this interpreter.
  assert.ok(!readFileSync("/proc/self/attr/current", "utf8").startsWith(name));
  const scan = sudo(
    "/usr/bin/python3",
    "-c",
    `
import errno,json,pathlib,re,sys
name=sys.argv[1]
pids=[p for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()]
assert len(pids)<=8192, 'Process inventory exceeds bound'
matches=[]; unknown=[]; kernel_threads=0
for p in pids:
    try:
        status=(p/'status').read_text()
        if re.search(r'^Kthread:\\s+1$',status,re.M):
            kernel_threads+=1
            continue
        label=(p/'attr/current').read_text()
        if label.startswith(name): matches.append({'pid':p.name,'label':label})
    except OSError as error:
        if error.errno not in (errno.ENOENT,errno.ESRCH): unknown.append({'pid':p.name,'error':str(error)})
print(json.dumps({'matches':matches,'unknown':unknown,'observed':len(pids),'kernel_threads':kernel_threads}))
sys.exit(1 if matches or unknown else 0)
`,
    name,
  );
  writeFileSync(path.join(output, "quiescence.json"), scan, { flag: "wx" });
  sudo("apparmor_parser", "--remove", policy);
  sudo("rm", "--", policy, binary);
  sudo("rmdir", "--", directory);
  writeFileSync(
    path.join(output, "cleanup.json"),
    JSON.stringify({ profile_removed: true, restriction: restriction() }) + "\n",
    { flag: "wx" },
  );
}
assert.equal(restriction().trim(), "1");
