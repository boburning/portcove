/** Original hosted Linux capture -> bounded keyless proof. No CLI, imported
 * report, new issuer, upload, native acceptance or production activation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DSSEBundleBuilder } from "@sigstore/sign/dist/bundler/dsse.js";
import { FulcioSigner } from "@sigstore/sign/dist/signer/fulcio/index.js";
import { RekorWitness } from "@sigstore/sign/dist/witness/tlog/index.js";
import { bundleToJSON } from "@sigstore/bundle";
import { withPortcoveSigningTransport } from "@sigstore/sign/dist/external/fetch.js";
import {
  hostedNativeJobProfile,
  controllerOidcSubject,
  requestAssemblerToken,
  verifyHostedNativeAttestationIdentity,
} from "./assembler-job-identity.mts";
import { requireActualHostedLinuxNativeStageReport } from "./release-native-linux-report.mts";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import {
  prepareHostedNativeProofSubject,
  inspectHostedNativeProofFiles,
  hostedNativeProofLimits,
} from "./release-hosted-native-proof-contract.mts";
import type { HostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import { inspectHostedNativeLinuxHost } from "./release-native-wsl-host.mts";
import { hostedNativeArtifactName } from "./release-hosted-native-artifact.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { createHostedNativeProofStore } from "./release-owned-capture-store.mts";
import { createCheckpointSigningTransport } from "./release-checkpoint-signing-transport.mts";
import { withReadOnlyReleaseChildren } from "./release-readonly-child-environment.mts";
import { isRecord } from "./runtime-values.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const attempted = new WeakSet<object>();
type Prepared = ReturnType<typeof prepareHostedNativeProofSubject>;
type Retained = {
  report: object;
  parent: object;
  directory: string;
  prepared: Prepared;
  files: HostedNativeProofFiles;
  deadline: number;
  stopped: boolean;
};
const proofs = new WeakMap<object, Retained>();

async function original(reportReceipt: object) {
  const actual = await requireActualHostedLinuxNativeStageReport(reportReceipt);
  const parentReceipt = actual.actual.parent_source;
  const parent = await requireActualHostedNativeParentSource(parentReceipt);
  assert.equal(parent.platform_label, "linux-x86_64");
  assert.ok(parent.stage === "payload-signing" || parent.stage === "release-publication");
  assert.equal(actual.report.stage, parent.stage);
  assert.equal(actual.report.platform_label, parent.platform_label);
  return { actual, parent, parentReceipt };
}

async function readInput(reportReceipt: object) {
  const { actual, parent, parentReceipt } = await original(reportReceipt);
  const report = await readBoundedPublicBuildInputFile(
    actual.directory,
    "native-report.json",
    hostedNativeProofLimits.report,
  );
  const capture = await readBoundedPublicBuildInputFile(
    actual.directory,
    "capture.json",
    hostedNativeProofLimits.capture,
  );
  for (const [name, bytes] of [
    ["native-report.json", report],
    ["capture.json", capture],
  ] as const) {
    const identity = actual.original_file_identities.find((file) => file.name === name);
    assert.ok(identity, "original hosted report file identity required");
    assert.equal(bytes.length, identity.bytes);
    assert.equal(
      hash(bytes),
      identity.sha256,
      "consumed hosted proof input differs from original receipt",
    );
  }
  const observed: unknown = JSON.parse(
    (
      await readBoundedPublicBuildInputFile(actual.directory, "host-before.stdout.bin", 65536)
    ).toString("utf8"),
  );
  assert.ok(isRecord(observed));
  inspectHostedNativeLinuxHost(
    observed,
    {
      account: actual.actual.host.projection.account,
      qualification_gid: String(actual.actual.host.observed.qualification_gid),
    },
    actual.prepared.request.invocation_id,
    {
      machine_id_sha256: actual.report.host.machine_id_sha256,
      minimum_os_version: actual.report.compatibility.minimum_os_version,
    },
  );
  // The existing host inspector proves these exact distribution values from
  // retained os-release bytes, including duplicate-field refusal.
  const prepared = prepareHostedNativeProofSubject(
    parent.configuration,
    parent.producer,
    report,
    capture,
    {
      architecture: observed.architecture,
      platform_label: "linux-x86_64",
      machine_id_sha256: observed.machine_id_sha256,
      os: { id: "ubuntu", version_id: "24.04", kernel_release: observed.kernel_release },
    },
  );
  const final = await original(reportReceipt);
  assert.equal(final.actual.directory, actual.directory);
  assert.equal(final.parentReceipt, parentReceipt);
  return { prepared, report, capture, parent, parentReceipt, directory: actual.directory };
}

/** One irreversible attempt per original report. Durable exclusive intent and
 * the original remote reservation are checked before each provider POST. A
 * refused/ambiguous response retains partial effects and never remints. */
export async function signActualHostedLinuxNativeProof(reportReceipt: object) {
  const phaseDeadline = performance.now() + 120000;
  if (attempted.has(reportReceipt))
    throw new Error("hosted native proof requires original attempt recovery");
  attempted.add(reportReceipt);
  const input = await readInput(reportReceipt);
  const deadline = Math.min(input.parent.deadline, phaseDeadline);
  assert.ok(
    performance.now() < deadline,
    "hosted native preparation exceeded original phase deadline",
  );
  // Ordinary retained bytes reserve both maximum provider responses, the
  // maximum public Rekor request, the bundle and24KiB of fixed metadata/failure
  // receipts before any irreversible exchange. Capture has its fixed allowance.
  assert.ok(
    input.report.length + input.prepared.subject.length + 4 * 65536 + 24576 <= 384 * 1024,
    "hosted native proof retention cannot fit the fixed store",
  );
  const directory = path.join(input.directory, "hosted-proof");
  const store = await createHostedNativeProofStore(directory);
  let stage = "intent";
  try {
    await store.write(
      "signing-intent.json",
      Buffer.from(
        JSON.stringify({
          schema_version: 1,
          producer: input.prepared.producer,
          subject_sha256: hash(input.prepared.subject),
          report_sha256: hash(input.report),
          capture_sha256: hash(input.capture),
          automatic_retry: false,
          authority: "none",
        }),
      ),
    );
    await store.write("subject.json", input.prepared.subject);
    await store.write("report.json", input.report);
    await store.write("capture.json", input.capture);
    return await withReadOnlyReleaseChildren(directory, async () => {
      const profile = hostedNativeJobProfile("linux-x86_64");
      const producer = input.prepared.producer;
      const environment = {
        ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      };
      const recheck = async () => {
        assert.ok(performance.now() < deadline, "hosted native proof deadline exhausted");
        const current = await readInput(reportReceipt);
        assert.equal(current.parentReceipt, input.parentReceipt);
        assert.ok(current.prepared.subject.equals(input.prepared.subject));
        assert.ok(current.report.equals(input.report) && current.capture.equals(input.capture));
        assert.ok(performance.now() < deadline, "hosted native proof deadline exhausted");
      };
      await recheck();
      stage = "identity";
      const token = await requestAssemblerToken("sigstore", environment, fetch, deadline);
      const identity = await verifyHostedNativeAttestationIdentity(
        "linux-x86_64",
        token,
        {
          audience: "sigstore",
          subject: controllerOidcSubject(producer.controller_ref, profile.environment),
          controller_revision: producer.controller_revision,
          controller_ref: producer.controller_ref,
          actor_id: producer.actor_id,
          run_id: producer.run_id,
          run_attempt: producer.run_attempt,
        },
        { transport: { cwd: directory, deadline } },
      );
      assert.equal(identity.evidence_scope, "github.com");
      assert.equal(identity.job_id, producer.job_id);
      assert.equal(identity.check_run_id, producer.check_run_id);
      const signingDeadline = Math.min(
        deadline,
        performance.now() + Date.parse(identity.expires_at) - Date.now(),
      );
      const identityBytes = Buffer.from(JSON.stringify(identity));
      assert.ok(
        identityBytes.length <= 8192,
        "hosted native identity receipt exceeds retained budget",
      );
      await store.write("identity.json", identityBytes);
      const active = async () => {
        await recheck();
        assert.ok(
          performance.now() < signingDeadline,
          "hosted native signing identity expired monotonically",
        );
        assert.ok(
          Date.now() < Date.parse(identity.expires_at),
          "hosted native signing identity expired",
        );
      };
      const network = createCheckpointSigningTransport(
        store,
        deadline,
        fetch,
        [token, environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ""].filter(Boolean),
        active,
      );
      stage = "signing";
      const signed = await withPortcoveSigningTransport(
        (url, settings) => network.request(url, settings),
        async () =>
          new DSSEBundleBuilder({
            signer: new FulcioSigner({
              identityProvider: {
                async getToken() {
                  return token;
                },
              },
              retry: 0,
              timeout: 15000,
            }),
            witnesses: [
              new RekorWitness({
                retry: 0,
                timeout: 15000,
                fetchOnConflict: false,
                entryType: "dsse",
                majorApiVersion: 1,
              }),
            ],
            certificateChain: true,
          }).create({
            type: "application/vnd.in-toto+json",
            data: Buffer.from(JSON.stringify(input.prepared.statement)),
          }),
      );
      assert.equal(network.completedRequests, 2);
      const files = {
        subject: input.prepared.subject,
        report: input.report,
        capture: input.capture,
        bundle: Buffer.from(JSON.stringify(bundleToJSON(signed))),
      };
      inspectHostedNativeProofFiles(files, input.parent.configuration, producer);
      await store.write("bundle.json", files.bundle);
      await active();
      await store.write(
        "signing-result.json",
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            bundle_retained: true,
            bundle_sha256: hash(files.bundle),
            automatic_retry: false,
            signature_verification: "not-performed",
            authority: "none",
          }),
        ),
      );
      await active();
      const receipt = Object.freeze({
        kind: "original-hosted-linux-native-proof",
        authority: "none",
      });
      proofs.set(receipt, {
        report: reportReceipt,
        parent: input.parentReceipt,
        directory,
        prepared: input.prepared,
        files,
        deadline,
        stopped: false,
      });
      return receipt;
    });
  } catch {
    try {
      await store.write(
        "signing-failure.json",
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            phase: stage,
            completed: false,
            remote_effect: stage === "signing" ? "unknown" : "not-attempted",
            automatic_retry: false,
            recovery_required: true,
            authority: "none",
          }),
        ),
      );
    } catch {
      /* Keep original intent and every partial effect. */
    }
    throw new Error(`hosted native proof refused at ${stage}; retain ${directory} and reconcile`);
  }
}

/** Original proof custody only. The existing receiver still independently
 * verifies signature, historical job, configuration and admission. */
export async function requireActualHostedLinuxNativeProof(receipt: object) {
  const retained = proofs.get(receipt);
  if (!retained || retained.stopped)
    throw new Error("original active hosted native proof required");
  try {
    assert.ok(performance.now() < retained.deadline);
    const input = await readInput(retained.report);
    assert.equal(input.parentReceipt, retained.parent);
    assert.ok(input.prepared.subject.equals(retained.prepared.subject));
    for (const key of ["subject", "report", "capture", "bundle"] as const) {
      const bytes = await readBoundedPublicBuildInputFile(
        retained.directory,
        `${key}.json`,
        hostedNativeProofLimits[key],
      );
      assert.ok(bytes.equals(retained.files[key]), "original hosted native proof bytes changed");
    }
    await original(retained.report);
    assert.ok(performance.now() < retained.deadline);
    const producer = retained.prepared.producer;
    return {
      deadline: retained.deadline,
      stage: input.parent.stage,
      producer: Object.freeze({ ...producer }),
      directory: retained.directory,
      artifact_name: hostedNativeArtifactName({
        controller_revision: producer.controller_revision,
        run_id: producer.run_id,
        run_attempt: producer.run_attempt,
        platform_label: "linux-x86_64",
        stage: input.parent.stage,
      }),
      files: Object.fromEntries(
        Object.entries(retained.files).map(([key, bytes]) => [key, Buffer.from(bytes)]),
      ) as HostedNativeProofFiles,
      signature_verification: "not-performed" as const,
      authority: "none" as const,
    };
  } catch (error) {
    retained.stopped = true;
    throw error;
  }
}
