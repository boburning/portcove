import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileIdentity } from "../../../scripts/development-evidence.mts";
import { isRecord } from "../../../scripts/runtime-values.mts";
import { startInstalledLibraryBusy } from "./desktop-installed-library-busy.mts";

// These are real child/pipe/exit protocol controls with a fake producer. They
// establish no Core activity, installed application, Windows or release proof.
async function fixture(mode: "normal" | "bad-ready" | "early-exit" | "bad-final") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "portcove-busy-protocol-")));
  const library = path.join(root, "library");
  const output = path.join(root, "observation");
  const helper = path.join(root, "helper");
  await mkdir(library);
  await writeFile(
    helper,
    `#!${process.execPath}
const mode=${JSON.stringify(mode)};
const [command,library,port,installation,nonce,schema]=process.argv.slice(2);
if(command!=='hold-library-update')process.exit(85);
if(mode==='early-exit')process.exit(87);
const activity='component-only-activity';
console.log(JSON.stringify({schema_version:1,phase:'ready',process_id:process.pid,library,port_id:port,installation_id:installation,activity_id:activity,activity_liveness:'active',nonce:mode==='bad-ready'?'wrong':nonce,writer_schema:Number(schema),lock_protocol:'library-lock-v1'}));
let input='',released=false;
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
 input+=chunk;
 if(!input.endsWith('\\n'))return;
 const release=JSON.parse(input);
 if(release.schema_version!==1||release.action!=='cancel-and-release'||release.activity_id!==activity||release.nonce!==nonce)process.exit(86);
 released=true;
 console.log(JSON.stringify({schema_version:1,phase:'cancelled',process_id:process.pid,activity:{id:mode==='bad-final'?'foreign':activity,status:'cancelled',target_id:port,finished_at:1},finished_event:{operation_id:activity,type:'finished',result:'cancelled'},cancellation_acknowledged:{requested:true,phase:'preparing'},provider_polls:0,library_idle:true}));
});
process.stdin.on('end',()=>{process.exitCode=released?0:86;});
process.stdin.resume();
`,
    { mode: 0o755 },
  );
  await chmod(helper, 0o755);
  const binary = await fileIdentity(helper);
  const options = {
    fixtureRoot: root,
    library,
    output,
    helperRoot: root,
    helper: { ...binary, source_commit: "a".repeat(40) },
    portId: "component-fixture",
    installationId: "component-installation",
    writerSchema: 43,
    lockProtocol: "library-lock-v1",
  };
  const evidence = async () => {
    const value: unknown = JSON.parse(
      await readFile(path.join(output, "activity-holder.json"), "utf8"),
    );
    assert.ok(isRecord(value) && isRecord(value.os_exit));
    return {
      phase: value.phase,
      startup_failure: value.startup_failure,
      release_failure: value.release_failure,
      os_exit: value.os_exit,
      result: value.result,
    };
  };
  return { root, options, evidence };
}

async function discardSettled(f: Awaited<ReturnType<typeof fixture>>) {
  const evidence = await f.evidence();
  assert.ok(
    Number.isInteger(evidence.os_exit?.code) || typeof evidence.os_exit?.signal === "string",
    `Retain ${f.root}: actual child settlement is unknown`,
  );
  await rm(f.root, { recursive: true });
}

void test(
  "component fake producer: explicit release retains actual child close exit 0",
  { skip: process.platform !== "linux" },
  async () => {
    const f = await fixture("normal");
    let holder: Awaited<ReturnType<typeof startInstalledLibraryBusy>> | undefined;
    try {
      holder = await startInstalledLibraryBusy(f.options);
      await holder.assertActive();
      await holder.release();
      const evidence = await f.evidence();
      assert.equal(evidence.phase, "cancelled-and-exit-observed");
      assert.deepEqual(evidence.os_exit, { code: 0, signal: null });
      assert.ok(isRecord(evidence.result) && isRecord(evidence.result.activity));
      assert.equal(evidence.result.activity.id, holder.ready.activity_id);
    } finally {
      await holder?.settleOwned();
      await discardSettled(f);
    }
  },
);

for (const [mode, exit] of [
  ["bad-ready", 86],
  ["early-exit", 87],
] as const) {
  void test(
    `component fake producer: ${mode} fails and preserves actual owned EOF/exit outcome`,
    { skip: process.platform !== "linux" },
    async () => {
      const f = await fixture(mode);
      try {
        await assert.rejects(startInstalledLibraryBusy(f.options));
        const evidence = await f.evidence();
        assert.equal(evidence.phase, "failed");
        assert.ok(evidence.startup_failure);
        assert.equal(evidence.os_exit.code, exit);
        assert.equal(evidence.result, undefined);
      } finally {
        await discardSettled(f);
      }
    },
  );
}

void test(
  "component fake producer: OS exit 0 cannot accept a foreign terminal activity",
  { skip: process.platform !== "linux" },
  async () => {
    const f = await fixture("bad-final");
    const holder = await startInstalledLibraryBusy(f.options);
    try {
      await assert.rejects(holder.release());
      const evidence = await f.evidence();
      assert.equal(evidence.phase, "failed");
      assert.equal(evidence.os_exit.code, 0);
      assert.ok(evidence.release_failure);
      assert.equal(evidence.result, undefined);
    } finally {
      await assert.rejects(holder.settleOwned());
      await discardSettled(f);
    }
  },
);
