import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectLinuxSupervisor } from "./run-rust-tests.mjs";
import { readProcessIdentity } from "./heavy-rust-test-lock.mjs";
import { prepareRustSupportArtifact, rustSupportCompilerIdentity } from "./rust-support-cache.mjs";

async function waitUntil(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before its deadline");
}

test(
  "non-Linux Unix supervisor gates launch and kills a surviving grandchild after wrapper loss",
  { skip: process.platform === "win32" || process.platform === "linux", timeout: 15_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-unix-supervisor-"));
    const gatePath = path.join(root, "registered.gate");
    const statusPath = path.join(root, "status.json");
    const cleanupReceiptPath = path.join(root, "cleanup.json");
    const startedPath = path.join(root, "started.txt");
    const descendantPath = path.join(root, "descendant.txt");
    const rootScript = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      `writeFileSync(${JSON.stringify(startedPath)}, "started")`,
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid))`,
      "child.unref()",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const supervisor = spawn(
      process.execPath,
      [
        path.resolve("scripts/rust-test-tree-supervisor.mjs"),
        gatePath,
        statusPath,
        cleanupReceiptPath,
        process.execPath,
        "-e",
        rootScript,
      ],
      { detached: true, stdio: "ignore" },
    );
    const exited = new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", (code, signal) => resolve({ code, signal }));
    });
    let descendantPid;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(existsSync(startedPath), false, "managed command started before registration");
      await writeFile(gatePath, "registered\n");
      await waitUntil(() => existsSync(descendantPath), 5_000);
      assert.equal(existsSync(statusPath), false, "managed root exited before supervisor loss");
      descendantPid = Number(await readFile(descendantPath, "utf8"));
      assert.equal(supervisor.kill("SIGKILL"), true);
      const outcome = await exited;
      assert.notEqual(outcome.code, 0, JSON.stringify(outcome));
      await waitUntil(() => existsSync(cleanupReceiptPath), 5_000);
      assert.deepEqual(JSON.parse(await readFile(cleanupReceiptPath, "utf8")), {
        outcome: "quiescent",
      });
      await waitUntil(() => {
        try {
          process.kill(descendantPid, 0);
          return false;
        } catch (error) {
          if (error.code === "ESRCH") return true;
          throw error;
        }
      }, 5_000);
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        try {
          process.kill(-supervisor.pid, "SIGKILL");
        } catch {}
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Every adversarial inner job runs under a first-party adopting envelope. This
// keeps deliberate old-topology/reaper-loss fixtures from orphaning test children
// to the host's PID1. The envelope's real receipt and every captured disappearance
// are checked after the scenario exits; neither is inferred from an exit status.
async function linuxInnerCase({ mode, directory, reaper, supervisor }) {
  const assert = (await import("node:assert/strict")).default;
  const { spawn } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const path = (await import("node:path")).default;
  const identity = (pid) => {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value
      .slice(value.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return {
      pid,
      state: fields[0],
      parent: Number(fields[1]),
      group: Number(fields[2]),
      start: fields[19],
      identity: `linux:${boot}:${pid}:${fields[19]}`,
    };
  };
  const wait = async (predicate, milliseconds = 5_000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Linux ${mode} fixture did not reach its bounded condition`);
  };
  const gate = path.join(directory, "inner.gate");
  const status = path.join(directory, "inner.status");
  const receipt = path.join(directory, "inner.receipt");
  const registration = path.join(directory, "inner.registration");
  const started = path.join(directory, "inner.started");
  const descendant = path.join(directory, "inner.descendant");
  const helperPid = path.join(directory, "inner.helper");
  const finish = path.join(directory, "inner.finish");
  const payload = [
    'const {spawn}=require("node:child_process")',
    'const {writeFileSync,existsSync}=require("node:fs")',
    `writeFileSync(${JSON.stringify(started)},"started")`,
    `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:${mode === "escaped-refusal"},stdio:"ignore"})`,
    `writeFileSync(${JSON.stringify(descendant)},String(child.pid))`,
    "child.unref()",
    ...(mode === "natural" || mode === "receipt-refusal"
      ? [`setInterval(()=>{if(existsSync(${JSON.stringify(finish)}))process.exit(0)},10)`]
      : ["setInterval(()=>{},1000)"]),
  ].join(";");
  const args = [
    gate,
    status,
    receipt,
    registration,
    process.execPath,
    supervisor,
    process.execPath,
    "-e",
    payload,
  ];
  const captured = [];
  const capture = (pid) => {
    const value = identity(pid);
    captured.push(value);
    return value;
  };
  const closed = (child) =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  let managed;
  let wrapper;
  let helper;
  let completion;
  if (mode === "legacy-sibling-red") {
    managed = spawn(
      process.execPath,
      [supervisor, gate, status, receipt, process.execPath, "-e", payload],
      {
        detached: true,
        stdio: "inherit",
      },
    );
    completion = closed(managed);
    helper = managed.pid;
    if (mode !== "init-refusal") capture(helper);
  } else if (mode === "wrapper-loss") {
    const wrapperScript = [
      'const {spawn}=require("node:child_process")',
      'const {writeFileSync}=require("node:fs")',
      `const child=spawn(${JSON.stringify(reaper)},${JSON.stringify(args)},{stdio:["pipe","inherit","inherit"]})`,
      `writeFileSync(${JSON.stringify(helperPid)},String(child.pid))`,
      "setInterval(()=>{},1000)",
    ].join(";");
    wrapper = spawn(process.execPath, ["-e", wrapperScript], { stdio: "inherit" });
    completion = closed(wrapper);
    capture(wrapper.pid);
    await wait(() => existsSync(helperPid));
    helper = Number(readFileSync(helperPid, "utf8"));
    capture(helper);
  } else {
    managed = spawn(reaper, args, {
      stdio: mode === "init-refusal" ? "ignore" : ["pipe", "inherit", "inherit"],
    });
    completion = closed(managed);
    helper = managed.pid;
    capture(helper);
  }
  if (mode === "init-refusal") {
    assert.equal((await completion).code, 1);
    assert.equal(JSON.parse(readFileSync(receipt, "utf8")).outcome, "failed:linux-reaper");
    assert.equal(existsSync(registration), false);
    assert.equal(existsSync(started), false);
  } else {
    let node;
    if (mode === "legacy-sibling-red") node = captured[0];
    else {
      await wait(() => existsSync(registration));
      node = capture(JSON.parse(readFileSync(registration, "utf8")).pid);
      assert.equal(node.parent, helper);
      assert.equal(node.group, node.pid);
      assert.notEqual(identity(helper).group, node.group, "adopter shared the killed group");
    }
    assert.equal(existsSync(started), false, "payload ran before the registration gate");
    assert.equal(existsSync(receipt), false, "cleanup succeeded before group absence");
    if (mode === "gate-refusal") managed.stdin.end();
    else {
      if (mode === "receipt-refusal")
        writeFileSync(receipt, '{"outcome":"failed:original"}\n', { flag: "wx" });
      writeFileSync(gate, "registered\n", { flag: "wx" });
      await wait(() => existsSync(descendant));
      const child = capture(Number(readFileSync(descendant, "utf8")));
      if (mode === "natural" || mode === "receipt-refusal") writeFileSync(finish, "finish\n");
      if (mode === "cancel-pipe") managed.stdin.end();
      if (mode === "supervisor-loss" || mode === "legacy-sibling-red") {
        assert.equal(identity(node.pid).start, node.start);
        assert.equal(identity(node.pid).group, node.pid);
        process.kill(-node.pid, "SIGKILL");
      }
      if (mode === "wrapper-loss") wrapper.kill("SIGKILL");
      if (mode === "reaper-loss") managed.kill("SIGKILL");
      if (mode === "pipe-refusal") managed.stdin.write("unexpected control input");
      if (mode === "escaped-refusal") managed.stdin.end();
      if (mode === "reaper-loss") {
        await completion;
        await wait(() => identity(node.pid).state === "Z" && identity(child.pid).state === "Z");
        assert.equal(existsSync(receipt), false, "lost reaper manufactured a receipt");
      }
    }
    if (mode !== "reaper-loss") {
      // The old sibling cleaner and escaped-child refusal keep the existing 5s
      // cleanup deadline; the enclosing Node test retains its unchanged 30s guard.
      await wait(
        () => existsSync(receipt),
        mode === "legacy-sibling-red" || mode === "escaped-refusal" ? 6_000 : 5_000,
      );
      const outcome = JSON.parse(readFileSync(receipt, "utf8")).outcome;
      if (mode === "legacy-sibling-red") {
        assert.equal(
          outcome,
          "failed:timeout",
          "old sibling topology did not reproduce its orphan defect",
        );
        assert.equal(identity(Number(readFileSync(descendant, "utf8"))).state, "Z");
        await completion;
      } else if (mode === "receipt-refusal") {
        assert.equal((await completion).code, 1);
        assert.equal(readFileSync(receipt, "utf8"), '{"outcome":"failed:original"}\n');
      } else if (mode === "pipe-refusal") {
        assert.equal(outcome, "failed:linux-reaper");
        assert.equal((await completion).code, 1);
      } else if (mode === "escaped-refusal") {
        assert.equal(outcome, "failed:linux-reaper");
        assert.equal((await completion).code, 1);
        const child = captured.at(-1);
        assert.equal(identity(child.pid).start, child.start);
        const outerNode = identity(process.ppid);
        assert.equal(
          identity(child.pid).parent,
          outerNode.parent,
          "escaped fixture is not adopted by the test envelope",
        );
        process.kill(child.pid, "SIGKILL"); // Exactly identified inert fixture; never another owner.
      } else {
        assert.equal(outcome, "quiescent");
        if (mode === "wrapper-loss") await completion;
        else assert.equal((await completion).code, 0);
        assert.equal(existsSync(`/proc/${node.pid}`), false, "Node group was not actually reaped");
        if (mode === "gate-refusal") assert.equal(existsSync(started), false);
        else
          assert.equal(
            existsSync(`/proc/${captured.at(-1).pid}`),
            false,
            "descendant was not actually reaped",
          );
      }
    }
  }
  writeFileSync(path.join(directory, "captured.json"), JSON.stringify(captured));
}

let linuxEvidenceHeld = false;
for (const mode of [
  "legacy-sibling-red",
  "natural",
  "gate-refusal",
  "cancel-pipe",
  "supervisor-loss",
  "wrapper-loss",
  "reaper-loss",
  "escaped-refusal",
  "init-refusal",
  "pipe-refusal",
  "receipt-refusal",
]) {
  test(
    `Linux adopting containment proves ${mode}`,
    { skip: process.platform !== "linux", timeout: 30_000 },
    async () => {
      assert.equal(
        linuxEvidenceHeld,
        false,
        "previous owned fixture lacks containment closure; no new process fixture admitted",
      );
      const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-linux-reaper-proof-"));
      const root = path.resolve(".");
      const reaper = path.join(directory, "reaper");
      const compiler = rustSupportCompilerIdentity({
        runSync: spawnSync,
        environment: process.env,
      });
      const prepared = prepareRustSupportArtifact({
        root,
        output: reaper,
        compiler,
        runSync: spawnSync,
        environment: process.env,
        platform: "linux",
        architecture: process.arch,
        product: "linux-process-tree-reaper",
        source: "scripts/fixtures/linux-process-tree-reaper.rs.txt",
        rustcArgs: ["--edition=2024", "--crate-name", "portcove_linux_process_tree_reaper"],
      });
      assert.equal(prepared.output.sha256.length, 64);
      const supervisor = path.resolve("scripts/rust-test-tree-supervisor.mjs");
      const gate = path.join(directory, "outer.gate");
      const status = path.join(directory, "outer.status");
      const receipt = path.join(directory, "outer.receipt");
      const registration = path.join(directory, "outer.registration");
      const scenario = `(${linuxInnerCase.toString()})(${JSON.stringify({ mode, directory, reaper, supervisor })}).catch(error=>{console.error(error);process.exitCode=1})`;
      const outer = spawn(
        reaper,
        [
          gate,
          status,
          receipt,
          registration,
          process.execPath,
          supervisor,
          process.execPath,
          "--input-type=module",
          "-e",
          scenario,
        ],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      linuxEvidenceHeld = true;
      const exited = new Promise((resolve, reject) => {
        outer.once("error", reject);
        outer.once("close", (code) => resolve(code));
      });
      let completed = false;
      try {
        await waitUntil(() => existsSync(registration), 5_000);
        inspectLinuxSupervisor(JSON.parse(readFileSync(registration, "utf8")), outer.pid);
        await writeFile(gate, "registered\n", { flag: "wx" });
        const exitCode = await exited;
        assert.equal(exitCode, 0);
        assert.equal(JSON.parse(await readFile(receipt, "utf8")).outcome, "quiescent");
        linuxEvidenceHeld = false;
        assert.equal(JSON.parse(await readFile(status, "utf8")).exit_code, 0);
        const captured = JSON.parse(await readFile(path.join(directory, "captured.json"), "utf8"));
        for (const process of captured)
          assert.notEqual(
            readProcessIdentity(process.pid),
            process.identity,
            `fixture identity ${process.identity} was not reaped`,
          );
        completed = true;
      } finally {
        outer.stdin.end(); // Request only the owned envelope's ordinary bounded closure.
        if (completed) await rm(directory, { recursive: true, force: true });
        else console.error(`Retained failed Linux containment evidence: ${directory}`);
      }
    },
  );
}
