import { spawnSync } from "node:child_process";
import { open, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import { admitReviewedInputsController } from "./production-controller-admission.mts";
import {
  requestAssemblerToken,
  inspectAssemblerIdentityExpectation,
  verifyClassificationWriterJobIdentity,
  verifyProtectionObserverJobIdentity,
  verifyProductionProtectionObserverJobIdentity,
} from "./assembler-job-identity.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";
import { appendFile } from "node:fs/promises";
import {
  observeReleaseInputProtections,
  requireReleaseInputWriterPolicy,
  prepareProductionProtectionHandoff,
} from "./release-input-protections.mts";

async function main() {
  const mode = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !["admission", "observe", "observe-production", "persist", "read"].includes(mode ?? "")
  )
    throw new Error("fixed reviewed-input operation required");
  if (mode === "admission") {
    const handle = await open(
      new URL("../.github/workflows/release-reviewed-inputs.yml", import.meta.url),
      "r",
    );
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("review workflow is not a regular file");
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    const bytes = buffer.subarray(0, length);
    console.log(
      JSON.stringify(
        admitReviewedInputsController(
          process.env.PORTCOVE_CONTROLLER_ADMISSION,
          process.env,
          bytes,
        ),
      ),
    );
    return;
  }
  const observing = mode === "observe" || mode === "observe-production";
  const temp = process.env.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp))
    throw new Error("private runner temporary directory unavailable");
  // Exclusive receipt opens before any source or mutation. Never persist tokens
  // or raw exceptions/provider output. Existing receipt means no retry.
  const receipt = await open(path.join(temp, `release-reviewed-inputs-${mode}.jsonl`), "wx", 0o600);
  try {
    await receipt.writeFile(
      JSON.stringify({ schema_version: 1, operation: mode, status: "started", authority: "none" }) +
        "\n",
    );
    const appToken =
      observing || mode === "persist" ? process.env.PORTCOVE_CONTROL_APP_TOKEN : undefined;
    if ((observing || mode === "persist") && (!appToken || appToken.length > 16384))
      throw new Error("isolated App installation token unavailable");
    const runner = createGitHubRunner({
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
      timeoutMs: 15000,
      spawn: (command, args, options) =>
        spawnSync(command, args, {
          ...options,
          env: {
            ...process.env,
            GH_TOKEN: appToken ?? process.env.GH_TOKEN,
            GITHUB_TOKEN: undefined,
            PORTCOVE_CONTROL_APP_TOKEN: undefined,
          },
        }),
    });
    const appApi = new GitHubApiClient((args, input) =>
      runner([...args, "--hostname", "github.com"], input),
    );
    const readRunner = createGitHubRunner({
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
      timeoutMs: 15000,
    });
    const readApi = new GitHubApiClient((args, input) =>
      readRunner([...args, "--hostname", "github.com"], input),
    );
    const api = {
      request: (method: string, endpoint: string, body?: unknown) =>
        (endpoint.includes("/check-runs/") ? readApi : appApi).request(method, endpoint, body),
      graphql: (query: string, variables: Readonly<Record<string, unknown>>) =>
        appApi.graphql(query, variables),
    };
    let observerIdentity: unknown = null;
    if (observing || mode === "persist") {
      // Config is separately ratified environment data, never an input file or
      // dispatch-provided expected identity. No self-expectation from JWT claims.
      if (process.env.GITHUB_RUN_ATTEMPT !== "1")
        throw new Error("review input reruns are not admitted");
      const policy: unknown = JSON.parse(process.env.PORTCOVE_CONTROLLER_ADMISSION ?? "null");
      if (!isRecord(policy)) throw new Error("ratified controller policy unavailable");
      const expected = inspectAssemblerIdentityExpectation({
        audience: observing
          ? "portcove-release-protection-v1"
          : "portcove-release-classification-v1",
        subject: `repo:boburning/portcove:environment:${observing ? "production-release-protection-observer" : "production-release-classification"}`,
        controller_revision: policy.revision,
        controller_ref: policy.execution_ref,
        actor_id: policy.actor_id,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: 1,
      });
      const token = await requestAssemblerToken(expected.audience);
      const verify =
        mode === "observe-production"
          ? verifyProductionProtectionObserverJobIdentity
          : mode === "observe"
            ? verifyProtectionObserverJobIdentity
            : verifyClassificationWriterJobIdentity;
      const identity = await verify(token, expected, { transport: { cwd: process.cwd() } });
      if (observing) observerIdentity = identity;
      await receipt.writeFile(
        JSON.stringify({
          schema_version: 1,
          operation: mode,
          status: "identity-verified",
          identity,
        }) + "\n",
      );
    }
    let result: unknown;
    if (observing) {
      result = observeReleaseInputProtections(api);
      if (mode === "observe-production")
        result = prepareProductionProtectionHandoff(observerIdentity, result);
      const encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded) > 60 * 1024 || !process.env.GITHUB_OUTPUT)
        throw new Error("trusted observer output channel unavailable or oversized");
      await appendFile(process.env.GITHUB_OUTPUT, `observation=${encoded}\n`);
      if (mode === "observe-production") {
        // The fixed source waits for readiness before releasing the App token.
        // Preserve its exact artifact association beside the actual report.
        const ready = JSON.parse(
          await readFile(
            path.join(temp, "release-control-ready", "control-ready-readback.json"),
            "utf8",
          ),
        ) as unknown;
        if (
          !isRecord(ready) ||
          ready.role !== "ready" ||
          !isRecord(ready.body) ||
          !isRecord(ready.body.producer) ||
          !isRecord(result) ||
          !isRecord(result.producer) ||
          ready.body.producer.run_id !== result.producer.run_id ||
          ready.body.producer.run_attempt !== result.producer.run_attempt ||
          ready.body.producer.controller_revision !== result.producer.controller_revision
        )
          throw new Error("matching fixed reader readiness unavailable");
        await writeFile(path.join(temp, "observation.json"), encoded, { flag: "wx", mode: 0o600 });
      }
    } else {
      const { persistReviewedClassification, readPublicationPause, readReviewedClassification } =
        await import("./release-control-inputs.mts");
      const config: unknown = JSON.parse(process.env.PORTCOVE_REVIEW_PRODUCER ?? "null");
      const opportunity: unknown = JSON.parse(process.env.PORTCOVE_REVIEWED_OPPORTUNITY ?? "null");
      if (mode === "persist") {
        // Only the fixed held workflow maps this from needs.protection_observation.
        // No workflow_dispatch inputs are declared. A cross-workflow receipt is
        // not accepted, and aggregate admission remains independently held.
        if (!isRecord(config) || typeof config.writer_app_id !== "number")
          throw new Error("writer identity unconfigured");
        requireReleaseInputWriterPolicy(
          JSON.parse(process.env.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION ?? "null"),
          config.writer_app_id,
        );
        const check = process.env.PORTCOVE_REVIEW_CHECK_ID;
        if (!check || !/^[1-9][0-9]{0,15}$/u.test(check))
          throw new Error("exact independent check identity unavailable");
        result = persistReviewedClassification(api, config, opportunity, Number(check), () => {
          requireReleaseInputWriterPolicy(
            JSON.parse(process.env.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION ?? "null"),
            config.writer_app_id as number,
          );
        });
      } else
        result = {
          classification: readReviewedClassification(api, config, opportunity),
          pause: readPublicationPause(api),
          admission: "hold",
          capacity: "unconfigured",
          protection_handoff: "unconfigured",
        };
    }
    await receipt.writeFile(
      JSON.stringify({
        schema_version: 1,
        operation: mode,
        status: "succeeded",
        result,
        authority: "none",
      }) + "\n",
    );
  } catch (error) {
    if (error instanceof CoordinatorRemoteError)
      await receipt.writeFile(
        JSON.stringify({
          schema_version: 1,
          status: "mutation-outcome",
          evidence: error.evidence,
        }) + "\n",
      );
    await receipt.writeFile(
      JSON.stringify({ schema_version: 1, operation: mode, status: "refused", authority: "none" }) +
        "\n",
    );
    throw new Error("reviewed input operation refused; retain receipt without automatic retry");
  } finally {
    await receipt.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("reviewed input operation refused");
    process.exitCode = 1;
  });
}
