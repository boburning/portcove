import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

void test(
  "component noexec probe never runs an inert surrogate on an exec mount",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    const prefix = path.join("/dev/shm", `portcove-noexec-component-${randomUUID()}`);
    const image = `${prefix}.image`,
      output = `${prefix}.json`,
      marker = `${prefix}.executed`;
    try {
      await writeFile(
        image,
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected execution');\n`,
        { flag: "wx", mode: 0o755 },
      );
      const binary = await fileIdentity(image);
      const entry = fileURLToPath(new URL("./desktop-appimage-noexec-probe.mts", import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          entry,
          "--root",
          "/dev/shm",
          "--image",
          image,
          "--sha256",
          binary.sha256,
          "--output",
          output,
        ],
        { encoding: "utf8", timeout: 30000, maxBuffer: 262144 },
      );
      assert.equal(result.error, undefined);
      const report: unknown = JSON.parse(await readFile(output, "utf8"));
      assert.ok(isRecord(report) && isRecord(report.mount_query));
      const query: unknown = JSON.parse(String(report.mount_query.stdout));
      assert.ok(
        isRecord(query) && Array.isArray(query.filesystems) && query.filesystems.length === 1,
      );
      const mounted: unknown = query.filesystems[0];
      assert.ok(isRecord(mounted) && typeof mounted.options === "string");
      if (mounted.options.split(",").includes("noexec")) {
        assert.equal(result.status, 0);
        assert.equal(report.phase, "noexec-refused");
        assert.ok(isRecord(report.execution));
        assert.equal(report.execution.error_code, "EACCES");
      } else {
        assert.equal(result.status, 1);
        assert.equal(report.phase, "failed");
        assert.equal(report.execution, undefined, "An exec mount must be refused before launching");
      }
      await assert.rejects(lstat(marker), { code: "ENOENT" });
    } finally {
      await Promise.all([image, output, marker].map((file) => rm(file, { force: true })));
    }
  },
);

for (const missing of ["hash", "real-data"] as const) {
  void test(
    `ordinary driver refuses busy helper without ${missing} before creating output or launching`,
    {
      skip: !["linux", "win32"].includes(process.platform),
    },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "portcove-busy-admission-"));
      const output = path.join(root, "never-created");
      try {
        const absolute = (name: string) => path.join(root, name);
        const common = [
          "--app",
          absolute("missing-app"),
          "--output",
          output,
          "--staging",
          absolute("staging"),
          "--stage-marker",
          absolute("stage.json"),
          "--helper-process-marker",
          absolute("helper.json"),
          "--relaunch-process-marker",
          absolute("relaunch.json"),
          "--candidate-version",
          "0.3.0",
          "--library-busy-helper",
          absolute("missing-busy-helper"),
        ];
        if (missing === "real-data")
          common.push(
            "--library-busy-sha",
            "a".repeat(64),
            "--library-busy-source",
            "b".repeat(40),
          );
        const windows = process.platform === "win32";
        const entry = fileURLToPath(
          new URL(
            windows ? "./desktop-windows-update-test.mts" : "./desktop-appimage-update-test.mts",
            import.meta.url,
          ),
        );
        const platform = windows
          ? [
              "--candidate-installer-sha",
              "a".repeat(64),
              "--candidate-executable-sha",
              "c".repeat(64),
              "--transport",
              "embedded",
            ]
          : [
              "--candidate-sha",
              "a".repeat(64),
              "--driver",
              absolute("missing-driver"),
              "--native-driver",
              absolute("missing-native-driver"),
            ];
        // Exercise the actual CLI preflight without frontend dependencies. Any
        // attempted UI use still fails; this hook grants no native execution.
        const probe = path.join(root, "preflight.mjs");
        await writeFile(
          probe,
          `import {registerHooks} from 'node:module';
const forbidden = 'export const By=new Proxy({},{get(){throw Error("UI use forbidden before preflight")}});export const until=By';
registerHooks({resolve(name,context,next){
 if(name==='selenium-webdriver')return {url:'data:text/javascript,'+encodeURIComponent(forbidden),shortCircuit:true};
 return next(name,context);
}});
process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify([...common, ...platform])}];
await import(${JSON.stringify(pathToFileURL(entry).href)});
`,
          { flag: "wx" },
        );
        const result = spawnSync(process.execPath, [probe], {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 262_144,
          windowsHide: true,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          missing === "hash"
            ? /library-busy-sha.*required/u
            : windows
              ? /game-data-configuration.*required/u
              : /requires the real installed game fixture/u,
        );
        await assert.rejects(lstat(output), { code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true });
      }
    },
  );
}

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
