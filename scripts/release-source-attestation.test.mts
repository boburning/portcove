import assert from "node:assert/strict";
import test, { mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectReleaseSourceAttestation,
  verifyReleaseSourceAttestation,
  releaseProcessPredicate,
  upstreamRehearsalExecutionRef,
} from "./release-source-attestation.mts";

const expected = {
  source_commit: "a".repeat(40),
  ref: "refs/tags/portcove-beta-prepared/v0.9.1",
  run_id: "12345",
  run_attempt: 2,
  subjects: [{ filename: "compiler-result-cli-linux-x86_64.json", sha256: "b".repeat(64) }],
};

void test("default verifier process honors the private reader environment and excludes operational signing keys", async () => {
  assert.ok(
    !Object.hasOwn(process.env, "PORTCOVE_SIGNING_KEY"),
    "test requires a credential-free parent",
  );
  const token = process.env.GH_TOKEN;
  const directory = await mkdtemp(path.join(tmpdir(), "attestation-reader-environment-"));
  process.env.GH_TOKEN = "inert-reader-token";
  process.env.PORTCOVE_SIGNING_KEY = "inert-signing-sentinel";
  let calls = 0;
  const subprocess = mock.method(childProcess, "spawnSync", (...parameters: unknown[]) => {
    calls++;
    assert.equal(parameters[0], "gh");
    const settings = parameters[2];
    assert.ok(isRecord(settings) && isRecord(settings.env));
    assert.equal(settings.env.GH_TOKEN, "inert-reader-token");
    assert.equal(settings.env.GH_HOST, "github.com");
    assert.equal(Object.hasOwn(settings.env, "PORTCOVE_SIGNING_KEY"), false);
    assert.equal(Object.hasOwn(settings.env, "NODE_OPTIONS"), false);
    const stdout = JSON.stringify(fixture());
    return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
  });
  syncBuiltinESMExports();
  try {
    await withReadOnlyReleaseChildren(directory, () =>
      verifyReleaseSourceAttestation(directory, expected.subjects[0]!.filename, expected),
    );
    assert.equal(calls, 1);
  } finally {
    subprocess.mock.restore();
    syncBuiltinESMExports();
    delete process.env.PORTCOVE_SIGNING_KEY;
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
    await rm(directory, { recursive: true, force: true });
  }
});
function fixture() {
  return [
    {
      verificationResult: {
        verifiedTimestamps: [{ type: "inert fixture; parser only" }],
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryIdentifier: "1354613114",
            sourceRepositoryURI: "https://github.com/boburning/portcove",
            buildSignerURI: `https://github.com/boburning/portcove/.github/workflows/release.yml@${expected.ref}`,
            buildSignerDigest: expected.source_commit,
            sourceRepositoryDigest: expected.source_commit,
            sourceRepositoryRef: expected.ref,
            runnerEnvironment: "github-hosted",
            runInvocationURI: `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/${expected.run_attempt}`,
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: releaseProcessPredicate,
          subject: expected.subjects.map((entry) => ({
            name: entry.filename,
            digest: { sha256: entry.sha256 },
          })),
          predicate: { inert: true },
        },
      },
    },
  ];
}
void test("bootstrap assembly attestation binds both fixed subjects and selects only the appointed producer attempt", () => {
  const input = {
    ...expected,
    subjects: [
      { filename: "application-site.zip", sha256: "c".repeat(64) },
      { filename: "application-metadata.json", sha256: "d".repeat(64) },
    ],
  };
  const wanted = fixture();
  wanted[0]!.verificationResult.signature.certificate.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/application-release-assembly.yml@${expected.ref}`;
  wanted[0]!.verificationResult.statement.subject = input.subjects.map((entry) => ({
    name: entry.filename,
    digest: { sha256: entry.sha256 },
  }));
  const prior = structuredClone(wanted);
  prior[0]!.verificationResult.signature.certificate.runInvocationURI = `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/1`;
  assert.equal(
    inspectReleaseSourceAttestation([prior[0], wanted[0]], input, "application-assembly").authority,
    "none",
  );
  assert.throws(() => inspectReleaseSourceAttestation(wanted, input, "application-package"));
  assert.throws(() =>
    inspectReleaseSourceAttestation([wanted[0], wanted[0]], input, "application-assembly"),
  );
  assert.throws(() =>
    inspectReleaseSourceAttestation(
      wanted,
      { ...input, subjects: [input.subjects[0]!] },
      "application-assembly",
    ),
  );
});
void test("application package provenance requires the reusable attester identity", () => {
  const raw = fixture();
  raw[0]!.verificationResult.signature.certificate.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/application-release-package.yml@${expected.ref}`;
  assert.equal(
    inspectReleaseSourceAttestation(raw, expected, "application-package").authority,
    "none",
  );
  assert.throws(() => inspectReleaseSourceAttestation(raw, expected));
  assert.throws(() => inspectReleaseSourceAttestation(fixture(), expected, "application-package"));
});

void test("native evidence requires its fixed reusable attester and complete three-subject matrix", () => {
  const input = {
    ...expected,
    subjects: [
      { filename: "native-qualification.json", sha256: "c".repeat(64) },
      { filename: "native-capture.json", sha256: "d".repeat(64) },
      { filename: "native-evidence.json", sha256: "e".repeat(64) },
    ],
  };
  const raw = fixture();
  raw[0]!.verificationResult.signature.certificate.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/application-release-native.yml@${expected.ref}`;
  raw[0]!.verificationResult.statement.subject = input.subjects.map((subject) => ({
    name: subject.filename,
    digest: { sha256: subject.sha256 },
  }));
  assert.equal(inspectReleaseSourceAttestation(raw, input, "application-native").authority, "none");
  assert.throws(() => inspectReleaseSourceAttestation(raw, input, "application-package"));
  assert.throws(() =>
    inspectReleaseSourceAttestation(
      raw,
      { ...input, subjects: input.subjects.slice(0, 1) },
      "application-native",
    ),
  );
  const prior = structuredClone(raw);
  prior[0]!.verificationResult.signature.certificate.runInvocationURI = `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/1`;
  assert.equal(
    inspectReleaseSourceAttestation([prior[0], raw[0]], input, "application-native").authority,
    "none",
  );
  assert.throws(() =>
    inspectReleaseSourceAttestation([raw[0], raw[0]], input, "application-native"),
  );
});

void test("package re-attestation after failed artifact upload selects the expected original attempt", () => {
  const wanted = fixture();
  wanted[0]!.verificationResult.signature.certificate.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/application-release-package.yml@${expected.ref}`;
  const earlier = structuredClone(wanted);
  earlier[0]!.verificationResult.signature.certificate.runInvocationURI = `https://github.com/boburning/portcove/actions/runs/${expected.run_id}/attempts/1`;
  const result = inspectReleaseSourceAttestation(
    [earlier[0], wanted[0]],
    expected,
    "application-package",
  );
  assert.equal(result.authority, "none");
  assert.equal(
    result.certificate.runInvocationURI,
    wanted[0]!.verificationResult.signature.certificate.runInvocationURI,
  );
  assert.throws(
    () => inspectReleaseSourceAttestation([wanted[0], wanted[0]], expected, "application-package"),
    /ambiguous/u,
  );
  assert.throws(
    () =>
      inspectReleaseSourceAttestation([earlier[0], earlier[0]], expected, "application-package"),
    /ambiguous/u,
  );
});
void test("source report parser binds complete exact subjects and workflow/source/run/attempt without minting authority", () => {
  const result = inspectReleaseSourceAttestation(fixture(), expected);
  assert.equal(result.authority, "none");
  assert.equal(result.statement.predicateType, releaseProcessPredicate);
  assert.throws(
    () => inspectReleaseSourceAttestation([...fixture(), ...fixture()], expected),
    /ambiguous/,
  );
});

void test("rehearsal retries select one explicitly expected authenticated attempt without accepting duplicate identity", () => {
  const identity = { ...expected, ref: upstreamRehearsalExecutionRef };
  const wanted = fixture();
  const cert = wanted[0]!.verificationResult.signature.certificate;
  cert.sourceRepositoryRef = identity.ref;
  cert.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/upstream-release-rehearsal.yml@${identity.ref}`;
  const previous = structuredClone(wanted);
  previous[0]!.verificationResult.signature.certificate.runInvocationURI =
    "https://github.com/boburning/portcove/actions/runs/12345/attempts/1";
  const selected = inspectReleaseSourceAttestation(
    [...previous, ...wanted],
    identity,
    "upstream-rehearsal",
  );
  assert.equal(selected.certificate.runInvocationURI, cert.runInvocationURI);
  assert.equal(selected.authority, "none");
  assert.throws(
    () => inspectReleaseSourceAttestation([...wanted, ...wanted], identity, "upstream-rehearsal"),
    /ambiguous/u,
  );
  assert.throws(
    () => inspectReleaseSourceAttestation([...previous, ...wanted], identity),
    /ambiguous/u,
  );
});
void test("wrong issuer/ref/workflow/source/attempt, missing timestamps and changed/extra/omitted subject refuse", () => {
  for (const [key, value] of [
    ["issuer", "https://wrong.invalid"],
    [
      "buildSignerURI",
      "https://github.com/boburning/portcove/.github/workflows/ci.yml@refs/heads/main",
    ],
    ["buildSignerDigest", "c".repeat(40)],
    ["sourceRepositoryRef", "refs/heads/main"],
    ["runInvocationURI", "https://github.com/boburning/portcove/actions/runs/12345/attempts/1"],
    ["runnerEnvironment", "self-hosted"],
  ]) {
    const raw = fixture();
    Object.assign(raw[0]!.verificationResult.signature.certificate, { [key!]: value });
    assert.throws(() => inspectReleaseSourceAttestation(raw, expected), /differs/);
  }
  for (const change of [
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.verifiedTimestamps = [];
    },
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.statement.subject = [];
    },
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.statement.subject.push({
        name: "extra.json",
        digest: { sha256: "c".repeat(64) },
      });
    },
    (raw: ReturnType<typeof fixture>) => {
      raw[0]!.verificationResult.statement.subject[0]!.digest.sha256 = "c".repeat(64);
    },
  ]) {
    const raw = fixture();
    change(raw);
    assert.throws(() => inspectReleaseSourceAttestation(raw, expected));
  }
});
void test("rehearsal scope authenticates only its fixed workflow and does not broaden release identity", () => {
  const raw = fixture();
  const rehearsal = { ...expected, ref: "refs/heads/main" };
  const cert = raw[0]!.verificationResult.signature.certificate;
  cert.sourceRepositoryRef = rehearsal.ref;
  cert.buildSignerURI =
    "https://github.com/boburning/portcove/.github/workflows/upstream-release-rehearsal.yml@refs/heads/main";
  assert.equal(
    inspectReleaseSourceAttestation(raw, rehearsal, "upstream-rehearsal").authority,
    "none",
  );
  assert.throws(() => inspectReleaseSourceAttestation(raw, rehearsal), /differs/);
  assert.throws(
    () => inspectReleaseSourceAttestation(fixture(), expected, "upstream-rehearsal"),
    /differs/,
  );
  cert.runInvocationURI = "https://github.com/boburning/portcove/actions/runs/12345/attempts/1";
  assert.throws(
    () => inspectReleaseSourceAttestation(raw, rehearsal, "upstream-rehearsal"),
    /differs/,
  );
});

void test("historical rehearsal attestations remain readable without allowing an arbitrary ref", async () => {
  for (const ref of [
    "refs/heads/main",
    "refs/tags/portcove-upstream-rehearsal-20261104r1",
    "refs/tags/portcove-upstream-rehearsal-20261104r2",
    upstreamRehearsalExecutionRef,
  ]) {
    const directory = await mkdtemp(path.join(tmpdir(), "portcove-rehearsal-history-"));
    try {
      const identity = { ...expected, ref };
      const raw = fixture();
      raw[0]!.verificationResult.signature.certificate.sourceRepositoryRef = ref;
      raw[0]!.verificationResult.signature.certificate.buildSignerURI = `https://github.com/boburning/portcove/.github/workflows/upstream-release-rehearsal.yml@${ref}`;
      const result = await verifyReleaseSourceAttestation(
        directory,
        identity.subjects[0]!.filename,
        identity,
        {
          scope: "upstream-rehearsal",
          spawn: (command, args) => {
            assert.equal(command, "gh");
            assert.equal(args[args.indexOf("--source-ref") + 1], ref);
            const stdout = JSON.stringify(raw);
            return {
              pid: 1,
              output: [null, stdout, ""],
              stdout,
              stderr: "",
              status: 0,
              signal: null,
            };
          },
        },
      );
      assert.equal(result.evidence_scope, "injected-provider");
      assert.equal(result.authority, "none");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  let called = false;
  await assert.rejects(
    () =>
      verifyReleaseSourceAttestation(
        ".",
        "fixture.json",
        { ...expected, ref: "refs/tags/portcove-upstream-rehearsal-20261104r999" },
        {
          scope: "upstream-rehearsal",
          spawn: () => {
            called = true;
            throw new Error("unexpected provider invocation");
          },
        },
      ),
    /identities unavailable/u,
  );
  assert.equal(called, false);
});

void test("source attestation retains reader scope, original deadline and subprocess bounds", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-attestation-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prior = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "ghs_SYNTHETIC_READER_ONLY";
    await withReadOnlyReleaseChildren(directory, async () => {
      process.env.GH_TOKEN = "ghs_SYNTHETIC_OTHER_ROLE";
      const result = await withCoordinatorDeadline(performance.now() + 5000, () =>
        verifyReleaseSourceAttestation(directory, expected.subjects[0]!.filename, expected, {
          spawn: (command, args, settings) => {
            assert.equal(command, "gh");
            assert.deepEqual(args.slice(0, 2), ["attestation", "verify"]);
            assert.equal(settings.env?.GH_TOKEN, "ghs_SYNTHETIC_READER_ONLY");
            assert.equal(settings.env?.GH_HOST, "github.com");
            assert.equal(settings.maxBuffer, 4 * 1024 * 1024);
            assert.ok(
              typeof settings.timeout === "number" &&
                settings.timeout > 0 &&
                settings.timeout <= 5000,
            );
            assert.equal(settings.killSignal, "SIGKILL");
            return { status: 0, stdout: JSON.stringify(fixture()), stderr: "" };
          },
        }),
      );
      assert.equal(result.authority, "none");
      assert.equal(result.evidence_scope, "injected-provider");
    });
  } finally {
    if (prior === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prior;
  }
});

void test("timed-out attestation cannot publish complete-looking partial proof", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-attestation-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    verifyReleaseSourceAttestation(directory, expected.subjects[0]!.filename, expected, {
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify(fixture()),
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      }),
    }),
    /ETIMEDOUT/u,
  );
  await assert.rejects(access(path.join(directory, "source-attestation-verification.json")), {
    code: "ENOENT",
  });
});
