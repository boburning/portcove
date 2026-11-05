/** Whole production receiver/getter behavior with simulated GH transport.
 * Real bounded files live only in this child's owned temporary directory.
 * Production creates every private receipt; no private state is seeded/exported. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import * as children from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import * as contextFiles from "../release-signing-context.mts";
import * as assemblerIdentity from "../assembler-job-identity.mts";

type Subject = Pick<
  typeof import("../release-signing-context-artifact.mts"),
  | "receiveSigningContextArtifact"
  | "requireReceivedSigningContext"
  | "requireRetainedSigningContext"
>;
let clock = 1000;
Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
const forbidden = () => {
  throw new Error("Uncontrolled context provider/process work is forbidden");
};
let controlledFetch: typeof globalThis.fetch | undefined;
globalThis.fetch = (input, init) => {
  assert.ok(controlledFetch, "The inert SDK provider must be installed");
  return controlledFetch(input, init);
};
process.kill = forbidden;
let transport: ((command: unknown, args: readonly string[]) => unknown) | undefined;
const controlledSpawn = (command: unknown, args: readonly string[]) => {
  assert.ok(transport, "The inert default GH transport must be installed");
  return transport(command, args);
};
for (const [name, value] of Object.entries(childProcess))
  if (typeof value === "function") Reflect.set(childProcess, name, forbidden);
Reflect.set(childProcess, "spawnSync", controlledSpawn);
syncBuiltinESMExports();
const safeChildren = {
  ...Object.fromEntries(
    Object.entries(children)
      .filter(([name]) => name !== "default")
      .map(([name, value]) => [name, typeof value === "function" ? forbidden : value]),
  ),
  spawnSync: controlledSpawn,
};
mock.module("node:child_process", { namedExports: safeChildren, defaultExport: safeChildren });
interface ReadControl {
  deadline: number;
  expire: boolean;
  reads: number;
  files: Map<string, Buffer>;
  context: string;
}
let producer:
  | {
      receipt: object;
      fixture: ReturnType<
        typeof import("./signing-context-artifact-fixture.mts").signingContextArtifactFixture
      >;
      expiresAt: number;
    }
  | undefined;
mock.module(new URL("../assembler-job-identity.mts", import.meta.url).href, {
  namedExports: {
    ...assemblerIdentity,
    inspectAssemblerIdentityExpectation: (value: unknown) => value,
    requestAssemblerToken: async () => {
      assert.ok(producer);
      return "inert-oidc";
    },
    verifyPayloadSignerJobIdentity: async (token: unknown) => {
      assert.ok(producer);
      assert.equal(token, "inert-oidc");
      return {
        evidence_scope: "github.com",
        expires_at: new Date(producer.expiresAt).toISOString(),
        job_id: 501,
        check_run_id: "777",
      };
    },
  },
});
let armed: ReadControl | undefined;
mock.module(new URL("../release-signing-context.mts", import.meta.url).href, {
  namedExports: {
    ...contextFiles,
    requireReleaseSigningContext: async (receipt: object) => {
      assert.ok(producer);
      assert.equal(receipt, producer.receipt);
      const { manifest } = producer.fixture;
      return {
        tools: { identity: manifest.controller },
        previous_site: { pins: manifest.previous_site_pins },
        binding: manifest.binding,
        facts: manifest.facts,
        control_facts: manifest.control_facts,
      };
    },
    readReleaseSigningContextFiles: async (receipt: object) => {
      assert.ok(producer);
      assert.equal(receipt, producer.receipt);
      return producer.fixture.files;
    },
    readBoundedReleaseContextFiles: async (
      ...args: Parameters<typeof contextFiles.readBoundedReleaseContextFiles>
    ) => {
      const files = await contextFiles.readBoundedReleaseContextFiles(...args);
      if (armed) {
        assert.equal(args[0], armed.context);
        assert.deepEqual([...files.keys()].sort(), [...armed.files.keys()].sort());
        for (const [name, bytes] of files) assert.deepEqual(bytes, armed.files.get(name));
        armed.reads++;
        // Advance only after the real asynchronous complete-tree read and checks.
        if (armed.expire) clock = armed.deadline + 1;
      }
      return files;
    },
  },
});
const entry = new URL("../release-signing-context-artifact.mts", import.meta.url);
entry.searchParams.set("portcove-receiver", "actual");
const alias = new URL(entry);
alias.searchParams.set("fixture-export-alias", "true");
registerHooks({
  load(url, context, next) {
    if (url !== alias.href) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
    import {receiveSigningContextArtifact as receiver,requireReceivedSigningContext as fresh,requireRetainedSigningContext as retained} from ${JSON.stringify(entry.href)};
    export {receiver as receiveSigningContextArtifact,fresh as requireReceivedSigningContext,retained as requireRetainedSigningContext};
  `,
    };
  },
});
const {
  signingContextArtifactFixture,
  signingContextRetainedSpawn,
  signingContextProviderFetch,
  signingContextFixtureToken,
} = await import("./signing-context-artifact-fixture.mts");
function subject(value: unknown): Subject {
  assert.ok(value && typeof value === "object");
  for (const name of [
    "receiveSigningContextArtifact",
    "requireReceivedSigningContext",
    "requireRetainedSigningContext",
  ])
    assert.equal(typeof Reflect.get(value, name), "function");
  return value as Subject;
}
async function scenario(actual: Subject, provider: "fresh" | "retained") {
  armed = undefined;
  clock = 1000;
  const f = signingContextArtifactFixture();
  transport = signingContextRetainedSpawn(f);
  controlledFetch = signingContextProviderFetch(f);
  process.env.GH_TOKEN = signingContextFixtureToken;
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-context-getter-"));
  const deadline = clock + 15000;
  try {
    // No options injection: the real default receiver performs every join and
    // creates its own private receipt. Provider bytes remain simulated.
    const receipt = await actual.receiveSigningContextArtifact(root, f.expected, deadline);
    assert.equal(receipt.evidence_scope, "github.com");
    assert.equal(receipt.authority, "none");
    assert.equal(receipt.publication_admission, "not-established");
    const control: ReadControl = {
      deadline,
      expire: false,
      reads: 0,
      files: f.files,
      context: path.join(receipt.directory, "context"),
    };
    armed = control;
    const getter =
      provider === "fresh"
        ? actual.requireReceivedSigningContext
        : actual.requireRetainedSigningContext;
    const before = f.counts();
    const observed = await getter(receipt);
    assert.equal(
      control.reads,
      1,
      "CONTEXT_FULL_TREE_CALLER must consume the actual getter and complete-tree dependency",
    );
    assert.equal(observed.authority, "none");
    assert.equal(observed.publication_admission, "not-established");
    assert.equal(
      observed.provenance,
      provider === "fresh" ? "fresh-provider-readback" : "original-verified-snapshot",
    );
    assert.equal(observed.directory, receipt.directory);
    assert.equal(observed.context, path.join(control.context, "context.json"));
    assert.deepEqual(observed.manifest, f.manifest);
    assert.deepEqual(f.counts(), {
      requests: before.requests + (provider === "fresh" ? 6 : 0),
      downloads: before.downloads,
    });
    const after = f.counts();
    control.expire = true;
    await assert.rejects(
      getter(receipt),
      /signing context total phase deadline exhausted/u,
      provider === "retained"
        ? "CONTEXT_RETAINED_DEADLINE must refuse after the real full-tree read"
        : "CONTEXT_FRESH_DEADLINE must retain its original phase",
    );
    assert.equal(control.reads, 2, "The refusal must follow the complete asynchronous tree read");
    assert.equal(clock, deadline + 1);
    assert.deepEqual(
      f.counts(),
      after,
      "Expired full-tree reads cannot start another provider refresh",
    );
    return observed;
  } finally {
    armed = undefined;
    transport = undefined;
    controlledFetch = undefined;
    delete process.env.GH_TOKEN;
    await rm(root, { recursive: true, force: true });
  }
}
const actual = subject(await import(entry.href)),
  aliased = subject(await import(alias.href));
const retained = await scenario(actual, "retained");
await scenario(actual, "fresh");
await scenario(aliased, "retained");
await scenario(aliased, "fresh");
await assert.rejects(
  scenario({ ...actual, requireRetainedSigningContext: async () => retained }, "retained"),
  /CONTEXT_FULL_TREE_CALLER/u,
);
// Exercise the same producer entry and real locked SDK without granting a
// fixture a private receipt. The real preparation owns the upload receipt.
const producerEntry = (await import(
  entry.href
)) as typeof import("../release-signing-context-artifact.mts");
const producerRoot = await mkdtemp(path.join(os.tmpdir(), "portcove-context-expiry-"));
const savedWallNow = Date.now;
try {
  for (const crossesExpiry of [false, true]) {
    const f = signingContextArtifactFixture();
    const receipt = {};
    const started = savedWallNow();
    let wallNow = started;
    Date.now = () => wallNow;
    clock = 1000;
    producer = { receipt, fixture: f, expiresAt: started + 1000 };
    process.env.GH_TOKEN = signingContextFixtureToken;
    const prepared = await producerEntry.prepareSigningContextArtifact(receipt, producerRoot);
    const archive = f.archiveFor(
      await readFile(path.join(prepared.directory, "signing-context-manifest.json")),
      await readFile(path.join(prepared.directory, "signing-context-bytes.bin")),
    );
    const archiveSha = createHash("sha256").update(archive).digest("hex");
    const route = producerEntry.signingContextArtifactRoute("release-signing-context");
    const read = signingContextProviderFetch(f);
    let calls = 0;
    controlledFetch = async (input, init) => {
      const response = await read(input, init);
      if (++calls === 2 && crossesExpiry) wallNow = started + 1000;
      const data = (await response.json()) as Record<string, unknown>;
      return Response.json({
        ...data,
        size_in_bytes: archive.length,
        digest: `sha256:${archiveSha}`,
      });
    };
    transport = (command, args) => {
      assert.equal(command, "gh");
      assert.equal(args.at(-1), "repos/boburning/portcove/actions/artifacts/101/zip");
      return { status: 0, stdout: archive };
    };
    const work = producerEntry.prepareSigningContextPredicate(
      prepared,
      { artifact_id: 101, sha256: archiveSha },
      { ...f.manifest.controller, audience: route.audience },
      clock + 15000,
    );
    if (crossesExpiry) {
      await assert.rejects(work, /producer or uploaded custody changed/u);
      assert.ok(!(await readdir(prepared.directory)).includes("signing-context-predicate.json"));
      assert.ok(!(await readdir(prepared.directory)).includes("uploaded-context.zip"));
    } else {
      const result = await work;
      assert.equal(result.authority, "none");
      assert.ok((await readdir(prepared.directory)).includes("signing-context-predicate.json"));
    }
    assert.equal(calls, 2);
  }
} finally {
  Date.now = savedWallNow;
  delete process.env.GH_TOKEN;
  producer = undefined;
  controlledFetch = undefined;
  transport = undefined;
  await rm(producerRoot, { recursive: true, force: true });
}
console.log("actual receiver deadline PASS; controlled provider, no hosted authority");
