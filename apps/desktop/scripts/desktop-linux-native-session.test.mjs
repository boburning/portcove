import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { launchLinuxNativeSession } from "./desktop-linux-native-session.mjs";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function counter(file) {
  try {
    return Number(await readFile(file, "utf8"));
  } catch {
    return 0;
  }
}
async function waitCounter(file) {
  const until = Date.now() + 5000;
  while (!(await counter(file))) {
    assert.ok(Date.now() < until);
    await pause(20);
  }
}

test(
  "Linux native launches positively join detached descendants before independent restart",
  { skip: process.platform !== "linux", timeout: 30_000 },
  async () => {
    const owned = await mkdtemp(path.join(os.tmpdir(), "portcove-native-namespace-control-"));
    const writer = path.join(owned, "writer.mjs");
    await writeFile(
      writer,
      `import {writeFileSync} from 'node:fs';let n=0;setInterval(()=>writeFileSync(process.argv[2],String(++n)),20);`,
    );
    const sentinelFile = path.join(owned, "foreign-sentinel");
    const sentinel = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import{writeFileSync}from'node:fs';let n=0;setInterval(()=>writeFileSync(process.argv[1],String(++n)),20);process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
        sentinelFile,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    const sentinelClosed = new Promise((resolve) =>
      sentinel.once("close", (code, signal) => resolve({ code, signal })),
    );
    try {
      await waitCounter(sentinelFile);
      const receipts = [];
      for (const doubleFork of [false, true]) {
        const marker = path.join(owned, `writer-${doubleFork}`);
        const direct = `import{spawn}from'node:child_process';spawn(process.execPath,[${JSON.stringify(writer)},${JSON.stringify(marker)}],{detached:true,stdio:'ignore'}).unref();`;
        const program = doubleFork
          ? `import{spawn}from'node:child_process';spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(direct)}],{detached:true,stdio:'ignore'}).unref();`
          : direct;
        const launch = await launchLinuxNativeSession(
          process.execPath,
          ["--input-type=module", "-e", program],
          process.env,
        );
        launch.child.stdout.resume();
        launch.child.stderr.resume();
        await launch.ready();
        await waitCounter(marker);
        const sentinelBefore = await counter(sentinelFile);
        const closed = await launch.stop();
        assert.equal(closed.quiesced, true);
        const final = await counter(marker);
        await pause(200);
        assert.equal(await counter(marker), final);
        assert.ok((await counter(sentinelFile)) > sentinelBefore);
        receipts.push(closed);
      }
      assert.notEqual(receipts[0].nonce, receipts[1].nonce);
      await writeFile(
        path.join(owned, "positive-join-receipts.json"),
        JSON.stringify(receipts, null, 2),
      );
      console.log(`Retained real namespace control receipts: ${owned}`);
    } finally {
      sentinel.stdin.end();
      assert.deepEqual(await sentinelClosed, { code: 0, signal: null });
    }
  },
);

test(
  "Linux native startup refusal cannot establish successful session closure",
  { skip: process.platform !== "linux", timeout: 20_000 },
  async () => {
    const launch = await launchLinuxNativeSession(
      "/portcove-owned-missing-native-driver",
      [],
      process.env,
    );
    launch.child.stdout.resume();
    launch.child.stderr.resume();
    await assert.rejects(launch.ready(), /ENOENT/u);
    await assert.rejects(launch.stop(), /normal successful init join/u);
    assert.equal(launch.receipt.ready.pid, 1);
    assert.equal(launch.receipt.exit.code, 126);
    assert.equal(launch.receipt.quiesced, undefined);
    const custody = await launch.custody();
    assert.equal(custody.quiesced, true);
    assert.equal(
      custody.exit.code,
      126,
      "Failed execution can join without becoming accepted qualification",
    );
  },
);

test(
  "Malformed private transport after readiness remains a failed qualification after real join",
  { skip: process.platform !== "linux", timeout: 20_000 },
  async () => {
    const launch = await launchLinuxNativeSession(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      process.env,
    );
    launch.child.stdout.resume();
    launch.child.stderr.resume();
    await launch.ready();
    // Deliberately corrupted parent transport; the decoder cannot inherit fd3.
    launch.child.stdio[3].emit(
      "data",
      Buffer.from('{"nonce":"wrong-nonce","kind":"driver-started","pid":99}\n'),
    );
    await assert.rejects(launch.stop(), /wrong-nonce/u);
    const custody = await launch.custody();
    assert.equal(custody.quiesced, true);
    assert.match(custody.protocol_error, /wrong-nonce/u);
  },
);
