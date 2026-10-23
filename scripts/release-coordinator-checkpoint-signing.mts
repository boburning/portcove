/** Producer preparation inside the existing trusted controller. The owning
 * driver must establish its ratified history/current controls and durable remote
 * pending intent before invoking this adapter. There is no CLI or activation. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { DSSEBundleBuilder, FulcioSigner, RekorWitness } from "@sigstore/sign";
import { bundleToJSON } from "@sigstore/bundle";
import { withPortcoveSigningTransport } from "@sigstore/sign/dist/external/fetch.js";
import {
  capacityExecutorJobProfile,
  controllerOidcSubject,
  requestAssemblerToken,
  verifyCapacityExecutorJobIdentity,
} from "./assembler-job-identity.mts";
import type { CapacityExecutorRole } from "./assembler-job-identity.mts";
import {
  inspectCoordinatorCheckpointEvidence,
  prepareCoordinatorCheckpointSigningInput,
} from "./release-coordinator-checkpoint-evidence.mts";
import type { exportCoordinatorCheckpoint } from "./release-coordinator-state.mts";
import type { CheckpointProducerExpectation } from "./release-coordinator-checkpoint-authentication.mts";
import { createAppRegistrationStore } from "./release-app-registration-capture.mts";
import type { AppRegistrationStore } from "./release-app-registration-capture.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import { createCheckpointSigningTransport } from "./release-checkpoint-signing-transport.mts";

type Checkpoint = Awaited<ReturnType<typeof exportCoordinatorCheckpoint>>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function signCoordinatorCheckpointEvidence(
  directory: string,
  rawCheckpoint: Checkpoint,
  rawConfiguration: unknown,
  rawExpected: { role: CapacityExecutorRole; producer: CheckpointProducerExpectation },
  deadline: number,
  options: {
    environment?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
    identity?: NonNullable<Parameters<typeof verifyCapacityExecutorJobIdentity>[3]>;
    createStore?: (directory: string) => Promise<AppRegistrationStore>;
  } = {},
) {
  // Everything the caller can retain is selected before the first await.
  const checkpoint = structuredClone(rawCheckpoint),
    configuration: unknown = structuredClone(rawConfiguration),
    expected = structuredClone(rawExpected),
    selected = {
      ...options,
      identity: options.identity
        ? {
            ...options.identity,
            transport: options.identity.transport ? { ...options.identity.transport } : undefined,
          }
        : undefined,
    };
  const input = prepareCoordinatorCheckpointSigningInput(
    checkpoint,
    configuration,
    expected.producer,
  );
  if (
    input.subject.length > 16384 ||
    !path.isAbsolute(directory) ||
    !Number.isFinite(deadline) ||
    deadline - performance.now() < 1 ||
    deadline - performance.now() > 120000
  )
    throw new Error("bounded checkpoint signing input and original deadline required");
  if (!readOnlyReleaseChildEnvironment())
    throw new Error("isolated read-only identity transport required");
  const profile = capacityExecutorJobProfile(expected.role);
  const environment = {
    ACTIONS_ID_TOKEN_REQUEST_URL: (selected.environment ?? process.env)
      .ACTIONS_ID_TOKEN_REQUEST_URL,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: (selected.environment ?? process.env)
      .ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  };
  const injected = Boolean(
    selected.environment || selected.fetcher || selected.identity || selected.createStore,
  );
  if (
    injected &&
    (!selected.fetcher ||
      !selected.environment ||
      !selected.createStore ||
      !selected.identity?.readKeys ||
      !selected.identity.transport?.spawn)
  )
    throw new Error("complete injected signing transport, identity and custody required");
  const capture = path.join(directory, `checkpoint-signing-${checkpoint.checkpoint}`);
  // Existing owner-only, exclusive, fsynced native Linux capture machinery.
  // A retained path is refused rather than reset, overwritten or reminted.
  const store = await (selected.createStore ?? createAppRegistrationStore)(capture);
  let stage = "identity";
  try {
    await store.write(
      "signing-intent.json",
      Buffer.from(
        JSON.stringify({
          schema_version: 1,
          checkpoint: checkpoint.checkpoint,
          subject_sha256: hash(input.subject),
          producer: expected.producer,
          sdk: "@sigstore/sign@5.0.0",
          automatic_retry: false,
          signature_verification: "not-performed",
          authority: "none",
        }),
      ),
    );
    await store.write("transition.json", input.subject);
    const token = await requestAssemblerToken(
      "sigstore",
      environment,
      selected.fetcher ?? fetch,
      deadline,
    );
    const identity = await verifyCapacityExecutorJobIdentity(
      expected.role,
      token,
      {
        audience: "sigstore",
        subject: controllerOidcSubject(expected.producer.controller_ref, profile.environment),
        controller_revision: expected.producer.controller_revision,
        controller_ref: expected.producer.controller_ref,
        actor_id: expected.producer.actor_id,
        run_id: expected.producer.run_id,
        run_attempt: expected.producer.run_attempt,
      },
      {
        ...selected.identity,
        transport: { ...selected.identity?.transport, cwd: directory, deadline },
      },
    );
    if (
      String(identity.job_id) !== expected.producer.job_id ||
      identity.check_run_id !== expected.producer.check_run_id
    )
      throw new Error("checkpoint producer differs from the actual live job");
    await store.write("identity.json", Buffer.from(JSON.stringify(identity)));
    const signingDeadline = Math.min(
      deadline,
      performance.now() + Date.parse(identity.expires_at) - Date.now(),
    );
    const requireCurrent = () => {
      if (performance.now() >= signingDeadline || Date.now() >= Date.parse(identity.expires_at))
        throw new Error("checkpoint signing identity or original deadline exhausted");
    };
    const network = createCheckpointSigningTransport(
      store,
      signingDeadline,
      selected.fetcher ?? fetch,
      [token, environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? ""].filter(Boolean),
    );
    stage = "signing";
    const signed = await withPortcoveSigningTransport(
      (url, settings) => {
        requireCurrent();
        return network.request(url, settings);
      },
      async () => {
        const signer = new FulcioSigner({
          identityProvider: {
            async getToken() {
              return token;
            },
          },
          retry: 0,
          timeout: 15000,
        });
        const witness = new RekorWitness({
          retry: 0,
          timeout: 15000,
          fetchOnConflict: false,
          entryType: "dsse",
          majorApiVersion: 1,
        });
        return new DSSEBundleBuilder({
          signer,
          witnesses: [witness],
          certificateChain: true,
        }).create({
          type: "application/vnd.in-toto+json",
          data: Buffer.from(JSON.stringify(input.statement)),
        });
      },
    );
    requireCurrent();
    if (network.completedRequests !== 2)
      throw new Error("checkpoint signing exchange incomplete or expired");
    const evidence = {
      subject: input.subject,
      bundle: Buffer.from(JSON.stringify(bundleToJSON(signed))),
    };
    inspectCoordinatorCheckpointEvidence(checkpoint, configuration, evidence);
    await store.write("bundle.json", evidence.bundle);
    requireCurrent();
    await store.write(
      "signing-result.json",
      Buffer.from(
        JSON.stringify({
          schema_version: 1,
          bundle_retained: true,
          caller_acceptance: "subject-to-final-deadline-check",
          bundle_sha256: hash(evidence.bundle),
          automatic_retry: false,
          evidence_scope:
            injected || identity.evidence_scope !== "github.com"
              ? "injected-provider"
              : "github.com",
          signature_verification: "not-performed",
          authority: "none",
        }),
      ),
    );
    requireCurrent();
    return {
      evidence,
      capture_directory: capture,
      evidence_scope:
        injected || identity.evidence_scope !== "github.com"
          ? ("injected-provider" as const)
          : ("github.com" as const),
      authority: "none" as const,
    };
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
            provider_error_text_retained: false,
          }),
        ),
      );
    } catch {
      /* Original marker and partial effects remain retained. */
    }
    throw new Error(
      `checkpoint signing ${stage} refused; retained capture ${capture}; explicit recovery required`,
    );
  }
}
