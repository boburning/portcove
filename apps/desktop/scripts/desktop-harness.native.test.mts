import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { observeDesktopHarnessInputs } from "../../../scripts/native-helper-dependencies.mts";
import path from "node:path";
import { runDesktopModuleFixture } from "../../../scripts/fixtures/desktop-module-fixture.mts";
import { verifyConnectedApplicationMedia } from "../../../scripts/desktop-linux-media.mts";

async function assertMediaInspectorCustody(
  verify: typeof verifyConnectedApplicationMedia,
  directory: string,
) {
  const { createHash } = await import("node:crypto");
  const inputPath = path.join(directory, "media-input.json");
  const bytes = "inert media fixture, not a native observation";
  await writeFile(inputPath, bytes);
  const input = {
    path: inputPath,
    bytes: Buffer.byteLength(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const namespaces = { user: "user:[10]", mnt: "mnt:[20]", pid: "pid:[30]" };
  const shared = {
    namespaces,
    uid_map: "1000 1000 1",
    gid_map: "1000 1000 1",
    credentials: {
      Uid: ["1000", "1000", "1000", "1000"],
      Gid: ["1000", "1000", "1000", "1000"],
      Groups: ["1000"],
    },
    device: { ino: 4, rdev: 5, uid: 1000, gid: 1000, mode: 0o20600, ctime_ms: 1000 },
    socket: { ino: 6, rdev: 0, uid: 1000, gid: 1000, mode: 0o140600, ctime_ms: 1000 },
  };
  for (const mode of [
    "ready",
    "inputs",
    "changed-file",
    "configuration",
    "source",
    "configuration-bytes",
    "missing-configuration",
    "missing-source",
    "identity",
  ] as const) {
    await writeFile(inputPath, mode === "changed-file" ? "X" + bytes.slice(1) : bytes);
    let closed = 0;
    const failure = new Error(`media-${mode}`);
    const inspector = {
      ownedProcessIdentity: {
        namespace_pid: mode === "identity" ? 4 : 3,
        start_ticks: "12345",
        namespaces,
        executable: process.execPath,
        sha256: "a".repeat(64),
      },
      quit: async () => {
        closed++;
      },
    };
    const readiness: Record<string, unknown> = {
      phase: "app-launched",
      probe: {
        outcome: "ready",
        uid: 1000,
        positive_reads: { video_buffers: 1, audio_buffers: 1 },
      },
      wrapper: shared,
      application: { ...shared, pid: 3, start_ticks: "12345" },
      executable: { path: process.execPath, sha256: "a".repeat(64) },
      configuration: mode === "configuration" ? { ...input, sha256: "b".repeat(64) } : input,
      source: mode === "source" ? { ...input, sha256: "b".repeat(64) } : input,
    };
    if (mode === "configuration-bytes")
      readiness.configuration = { ...input, bytes: input.bytes + 1 };
    if (mode === "missing-configuration") delete readiness.configuration;
    if (mode === "missing-source") delete readiness.source;
    let browser: typeof inspector | undefined;
    let observed: unknown;
    try {
      await verify({
        inspector,
        retain: (connected) => {
          browser = connected;
        },
        inputs: [input],
        admission: {
          signal: new AbortController().signal,
          assertReady: () => {
            if (mode === "inputs") throw failure;
          },
          verify: async () => {},
        },
        readiness,
      });
    } catch (error) {
      observed = error;
    } finally {
      if (browser) await browser.quit();
    }
    assert.equal(browser, inspector, "CONNECTED_INSPECTOR_CUSTODY");
    assert.equal(closed, 1, "CONNECTED_INSPECTOR_CLEANUP");
    if (mode === "ready") assert.equal(observed, undefined, "VALID_MEDIA_BINDINGS");
    else if (mode === "inputs") assert.equal(observed, failure, "MEDIA_INPUT_FAILURE_IDENTITY");
    else {
      assert.ok(observed instanceof assert.AssertionError, `MEDIA_${mode.toUpperCase()}_REFUSAL`);
      if (mode === "changed-file")
        assert.match(observed.message, /Application media input bytes changed/u);
    }
  }
}

void test("connected inspector stays owned when post-connect media verification refuses", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-media-inspector-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assertMediaInspectorCustody(verifyConnectedApplicationMedia, directory);
});

void test("whole media owner preserves custody and rejects removed public validation gates", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-media-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // This existing Desktop fixture anchors its inert IPC mock beside the native
  // helpers; the exercised owner remains the complete media module below.
  const fixtureAnchor = new URL("./desktop-owned-native-session.mts", import.meta.url);
  const media = new URL("../../../scripts/desktop-linux-media.mts", import.meta.url);
  const program = (mutation = "", aliased = false) => `
    import {writeFile} from 'node:fs/promises'; import path from 'node:path';
    const media=${JSON.stringify(media.href)},mutation=${JSON.stringify(mutation)},aliased=${JSON.stringify(aliased)};
    if(mutation||aliased) registerHooks({load(url,context,next){
      const loaded=next(url,context); if(url!==media)return loaded;
      if(aliased){
        const actual=new URL(media);actual.searchParams.set('fixture','actual');
        return {...loaded,source:'import {verifyConnectedApplicationMedia as local} from '+JSON.stringify(actual.href)+';export {local as verifyConnectedApplicationMedia};'};
      }
      const source=typeof loaded.source==='string'?loaded.source:new TextDecoder().decode(loaded.source);
      return {...loaded,source:source+String.fromCharCode(10)+mutation};
    }});
    const actual=await import(media);
    await (${assertMediaInspectorCustody.toString()})(actual.verifyConnectedApplicationMedia,${JSON.stringify(directory)});
  `;
  runDesktopModuleFixture(fixtureAnchor, program());
  runDesktopModuleFixture(fixtureAnchor, program("", true));
  for (const [mutation, marker] of [
    [
      "const original=verifyConnectedApplicationMedia; verifyConnectedApplicationMedia=(x)=>original({...x,retain:()=>{}});",
      "CONNECTED_INSPECTOR_CUSTODY",
    ],
    [
      "const original=verifyConnectedApplicationMedia; verifyConnectedApplicationMedia=async(x)=>{await original({...x,retain:()=>{}});x.retain(x.inspector);};",
      "CONNECTED_INSPECTOR_CUSTODY",
    ],
    ["verifyApplicationMediaInputs=async()=>{};", "MEDIA_INPUT_FAILURE_IDENTITY"],
    ["assertCapturedApplicationMediaBindings=()=>{};", "MEDIA_CONFIGURATION_REFUSAL"],
    ["assertApplicationMediaReadiness=()=>{};", "MEDIA_IDENTITY_REFUSAL"],
  ] as const)
    assert.throws(
      () => runDesktopModuleFixture(fixtureAnchor, program(mutation)),
      (error) => error instanceof assert.AssertionError && error.message.includes(marker),
    );
});

void test("runner phase metadata is checked at initial read before native execution", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-runner-phases-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = path.join(directory, "metadata.json");
  const custody = { inputs: [] };
  const inspect = async (phases: unknown) => {
    await writeFile(metadata, JSON.stringify({ source_state: { declared: true }, phases }));
    return observeDesktopHarnessInputs({
      custody,
      runMetadata: metadata,
      capture: {
        root: directory,
        values: { app: process.execPath },
        plan: { receiptInputs: [], selection: { selected_scenarios: [] } },
        output: directory,
        revision: "a".repeat(40),
        validate: async () => assert.fail("Existing custody must not trigger capture"),
      },
    });
  };
  for (const phases of [undefined, [], [{ phase: "build", opaque_metadata: 42 }]]) {
    const actual = await inspect(phases);
    assert.deepEqual(actual.metadataPhases, phases ?? []);
    assert.deepEqual(custody.inputs, [], "Phase observations must not enlarge custody");
    assert.equal(actual.inputs.length, 1);
    assert.equal(actual.inputs[0]?.path, metadata);
    if (Array.isArray(actual.runnerMetadata.phases)) {
      assert.notEqual(actual.metadataPhases, actual.runnerMetadata.phases);
      assert.equal(actual.metadataPhases[0], actual.runnerMetadata.phases[0]);
    }
  }
  for (const phases of [null, false, "build", {}, [null], [false], ["build"], [[]]]) {
    await assert.rejects(() => inspect(phases), { code: "ERR_ASSERTION" });
    assert.deepEqual(custody.inputs, []);
  }
});
