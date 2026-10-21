import { spawnSync } from "node:child_process";
import { open, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import {
  admitReviewedInputsController,
  admitProductionCatalogProtectionObserver,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import {
  requestAssemblerToken,
  controllerOidcSubject,
  inspectAssemblerIdentityExpectation,
  verifyClassificationWriterJobIdentity,
  verifyProtectionObserverJobIdentity,
  verifyProductionProtectionObserverJobIdentity,
  verifyProductionClassificationWriterJobIdentity,
  verifyProductionClassificationObserverJobIdentity,
} from "./assembler-job-identity.mts";
import { CoordinatorRemoteError } from "./release-coordinator-errors.mts";
import { isRecord } from "./runtime-values.mts";
import { appendFile } from "node:fs/promises";
import {
  inspectControllerExecutionPurpose,
  inspectReleaseControlPhase,
  releaseControlPhaseProfile,
} from "./release-control-phases.mts";
import {
  observeReleaseInputProtections,
  observeCatalogMaintenanceProtections,
  requireReleaseInputWriterPolicy,
  prepareProductionProtectionHandoff,
} from "./release-input-protections.mts";

import {
  coordinatorCommandTimeout,
  withCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import { currentClassificationJobDeadline } from "./release-signing-job-budget.mts";
import {
  requireProductionClassificationWriterAuthorities,
  requireProductionClassificationObserverAuthorities,
} from "./release-authority-configuration.mts";

type ClassificationAuthorities = Awaited<
  ReturnType<typeof requireProductionClassificationWriterAuthorities>
>;
async function runOperation(classification?: {
  authorities: ClassificationAuthorities;
  deadline: number;
}) {
  const mode = process.argv[2];
  if (
    (process.argv.length !== 3 &&
      !(process.argv.length === 4 && mode?.startsWith("observe-production"))) ||
    (![
      "admission",
      "observe",
      "observe-production",
      "observe-production-payload",
      "observe-production-site-publication",
      "observe-production-release-publication",
      "persist",
      "persist-request",
      "probe-production-request",
      "probe-production-classification-observer",
      "persist-production-request",
      "observe-production-classification",
      "read",
    ].includes(mode ?? "") &&
      !mode?.startsWith("observe-production-"))
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
  const inspectControlRound =
    process.argv[3] === undefined
      ? undefined
      : (await import("./release-control-handshake.mts")).inspectControlRound;
  const classificationObserver = mode === "observe-production-classification";
  const classificationProbe =
    mode === "probe-production-request" || mode === "probe-production-classification-observer";
  const catalogPurpose =
    inspectControllerExecutionPurpose(process.env.PORTCOVE_EXECUTION_PURPOSE) ===
    "catalog-publication";
  if (catalogPurpose && !mode?.startsWith("observe-production-"))
    throw new Error("catalog input command may only observe maintenance");
  const productionObservation =
    !classificationObserver && mode?.startsWith("observe-production") === true;
  const roundIndex =
    process.argv[3] === undefined
      ? undefined
      : inspectControlRound!({ index: Number(process.argv[3]) }, false).index;
  const roundSuffix = roundIndex === undefined ? "" : `-r${roundIndex}`;
  const phase = inspectReleaseControlPhase(
    productionObservation && mode !== "observe-production"
      ? mode.slice("observe-production-".length)
      : "admission",
  );
  const phaseProfile = releaseControlPhaseProfile(phase);
  if (catalogPurpose)
    admitProductionCatalogProtectionObserver(
      process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION,
      process.env,
      await readProductionControllerWorkflowBytes(),
      phase,
    );
  const observing = mode === "observe" || productionObservation || classificationObserver;
  const persisting =
    mode === "persist" || mode === "persist-request" || mode === "persist-production-request";
  const temp = process.env.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp))
    throw new Error("private runner temporary directory unavailable");
  // Exclusive receipt opens before any source or mutation. Never persist tokens
  // or raw exceptions/provider output. Existing receipt means no retry.
  const receipt = await open(
    path.join(temp, `release-reviewed-inputs-${mode}${roundSuffix}.jsonl`),
    "wx",
    0o600,
  );
  try {
    await receipt.writeFile(
      JSON.stringify({ schema_version: 1, operation: mode, status: "started", authority: "none" }) +
        "\n",
    );
    const appToken = observing || persisting ? process.env.PORTCOVE_CONTROL_APP_TOKEN : undefined;
    if ((observing || persisting) && (!appToken || appToken.length > 16384))
      throw new Error("isolated App installation token unavailable");
    const runner = (args: readonly string[], input?: string) =>
      createGitHubRunner({
        cwd: process.cwd(),
        maxBuffer: 2 * 1024 * 1024,
        timeoutMs: coordinatorCommandTimeout(15000),
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
      })(args, input);
    const appApi = new GitHubApiClient((args, input) =>
      runner([...args, "--hostname", "github.com"], input),
    );
    const readRunner = (args: readonly string[], input?: string) =>
      createGitHubRunner({
        cwd: process.cwd(),
        maxBuffer: 2 * 1024 * 1024,
        timeoutMs: coordinatorCommandTimeout(15000),
      })(args, input);
    const readApi = new GitHubApiClient((args, input) =>
      readRunner([...args, "--hostname", "github.com"], input),
    );
    const api = {
      request: (method: string, endpoint: string, body?: unknown) =>
        (/\/(?:check-runs|check-suites)(?:\/|\?)/u.test(endpoint) ? readApi : appApi).request(
          method,
          endpoint,
          body,
        ),
      graphql: (query: string, variables: Readonly<Record<string, unknown>>) =>
        appApi.graphql(query, variables),
    };
    let observerIdentity: unknown = null;
    if (observing || persisting) {
      // Config is separately ratified environment data, never an input file or
      // dispatch-provided expected identity. No self-expectation from JWT claims.
      if (process.env.GITHUB_RUN_ATTEMPT !== "1")
        throw new Error("review input reruns are not admitted");
      const policy: unknown = JSON.parse(
        (catalogPurpose
          ? process.env.PORTCOVE_CATALOG_CONTROLLER_ADMISSION
          : process.env.PORTCOVE_CONTROLLER_ADMISSION) ?? "null",
      );
      if (!isRecord(policy)) throw new Error("ratified controller policy unavailable");
      const expected = inspectAssemblerIdentityExpectation({
        audience: classificationObserver
          ? "portcove-release-classification-protection-v1"
          : observing
            ? phaseProfile.observer_audience
            : "portcove-release-classification-v1",
        subject: controllerOidcSubject(
          String(policy.execution_ref),
          observing
            ? "production-release-protection-observer"
            : "production-release-classification",
        ),
        controller_revision: policy.revision,
        controller_ref: policy.execution_ref,
        actor_id: policy.actor_id,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: 1,
      });
      const token = await requestAssemblerToken(
        expected.audience,
        process.env,
        fetch,
        classification?.deadline,
      );
      const verify = classificationObserver
        ? verifyProductionClassificationObserverJobIdentity
        : mode === "persist-production-request"
          ? verifyProductionClassificationWriterJobIdentity
          : productionObservation
            ? verifyProductionProtectionObserverJobIdentity
            : mode === "observe"
              ? verifyProtectionObserverJobIdentity
              : verifyClassificationWriterJobIdentity;
      const identity = await verify(
        token,
        expected,
        {
          transport: {
            cwd: process.cwd(),
            ...(classification ? { deadline: classification.deadline } : {}),
          },
        },
        phase,
      );
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
    if (classificationProbe) {
      if (!classification)
        throw new Error("fixed classification source and original job budget unavailable");
      const { recoverRemoteCoordinator } = await import("./release-coordinator-recovery.mts");
      const { inspectClassificationRequestReadiness } =
        await import("./release-classification-request.mts");
      const { semanticReviewCheckName } = await import("./release-semantic-review.mts");
      const recovered = await recoverRemoteCoordinator(
        temp,
        { schema_version: 1, namespace: classification.authorities.namespace },
        { transport: { cwd: process.cwd() } },
      );
      result = inspectClassificationRequestReadiness(
        api,
        {
          schema_version: 1,
          review_app_id: classification.authorities.apps.semantic.app_id,
          writer_app_id: classification.authorities.apps.classification.app_id,
          review_check_name: semanticReviewCheckName,
        },
        recovered.input.review_request,
      );
      if (!process.env.GITHUB_OUTPUT || !isRecord(result))
        throw new Error("fixed classification routing channel unavailable");
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `eligible=${result.eligible === true ? "true" : "false"}\n`,
      );
    } else if (observing) {
      result = catalogPurpose
        ? observeCatalogMaintenanceProtections(api)
        : observeReleaseInputProtections(api, {
            releasePublication: phase === "release-publication",
          });
      if (productionObservation)
        result = prepareProductionProtectionHandoff(observerIdentity, result, phase);
      if (productionObservation) {
        // The fixed source waits for readiness before releasing the App token.
        // Preserve its exact artifact association beside the actual report.
        const ready = JSON.parse(
          await readFile(
            path.join(
              temp,
              `release-control-ready-${phase}${roundSuffix}`,
              "control-ready-readback.json",
            ),
            "utf8",
          ),
        ) as unknown;
        if (
          !isRecord(ready) ||
          ready.role !== "ready" ||
          ready.phase !== phase ||
          !isRecord(ready.body) ||
          !isRecord(ready.body.producer) ||
          ready.body.phase !== phase ||
          !isRecord(result) ||
          !isRecord(result.producer) ||
          ready.body.producer.run_id !== result.producer.run_id ||
          ready.body.producer.run_attempt !== result.producer.run_attempt ||
          ready.body.producer.controller_revision !== result.producer.controller_revision
        )
          throw new Error("matching fixed reader readiness unavailable");
        if (roundIndex !== undefined) {
          const round = inspectControlRound!(ready.body.round);
          if (round.index !== roundIndex) throw new Error("observer ready round differs");
          result = { ...result, round };
        } else if (Object.hasOwn(ready.body, "round"))
          throw new Error("unexpected round on legacy observer");
      }
      const encoded = JSON.stringify(result);
      if (Buffer.byteLength(encoded) > 60 * 1024 || !process.env.GITHUB_OUTPUT)
        throw new Error("trusted observer output channel unavailable or oversized");
      await appendFile(process.env.GITHUB_OUTPUT, `observation=${encoded}\n`);
      if (productionObservation) {
        await writeFile(
          roundIndex === undefined
            ? path.join(temp, `observation-${phase}.json`)
            : path.join(
                temp,
                `release-control-ready-${phase}${roundSuffix}`,
                `observation-${phase}.json`,
              ),
          encoded,
          {
            flag: "wx",
            mode: 0o600,
          },
        );
      }
    } else {
      const { persistReviewedClassification, readPublicationPause, readReviewedClassification } =
        await import("./release-control-inputs.mts");
      const config: unknown = JSON.parse(process.env.PORTCOVE_REVIEW_PRODUCER ?? "null");
      if (mode === "persist-request" || mode === "persist-production-request") {
        const { requireReviewedInputsReleaseAuthorities } =
          await import("./release-authority-configuration.mts");
        const { recoverRemoteCoordinator } = await import("./release-coordinator-recovery.mts");
        const { inspectReleaseReviewRequest } = await import("./release-review-request.mts");
        const { semanticReviewCheckName } = await import("./release-semantic-review.mts");
        const { persistReviewedClassificationForRequest } =
          await import("./release-classification-request.mts");
        const authorities =
          classification?.authorities ?? (await requireReviewedInputsReleaseAuthorities());
        const producer = {
          schema_version: 1,
          review_app_id: authorities.apps.semantic.app_id,
          writer_app_id: authorities.apps.classification.app_id,
          review_check_name: semanticReviewCheckName,
        };
        const { inspectReviewProducerConfiguration } = await import("./release-control-inputs.mts");
        const parsed = classification ? producer : inspectReviewProducerConfiguration(config);
        if (
          parsed.review_app_id !== producer.review_app_id ||
          parsed.writer_app_id !== producer.writer_app_id ||
          parsed.review_check_name !== producer.review_check_name
        )
          throw new Error("writer producer roles differ from ratified release authority");
        const recovered = await recoverRemoteCoordinator(
          temp,
          { schema_version: 1, namespace: authorities.namespace },
          { transport: { cwd: process.cwd() } },
        );
        const request = inspectReleaseReviewRequest(recovered.input.review_request);
        if (!request) throw new Error("no outstanding exact journal request for automatic writer");
        const beforeMutation = () => {
          requireReleaseInputWriterPolicy(
            JSON.parse(process.env.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION ?? "null"),
            producer.writer_app_id,
          );
          const response = readApi.request(
            "GET",
            `repos/boburning/portcove/git/ref/heads/${authorities.namespace}-coordinator-state`,
          );
          if (
            response.status !== 200 ||
            !isRecord(response.body) ||
            response.body.ref !== `refs/heads/${authorities.namespace}-coordinator-state` ||
            !isRecord(response.body.object) ||
            response.body.object.type !== "commit" ||
            response.body.object.sha !== recovered.checkpoint
          )
            throw new Error("automatic writer outstanding journal request changed");
        };
        beforeMutation();
        result = persistReviewedClassificationForRequest(api, producer, request, beforeMutation);
        beforeMutation();
      } else if (mode === "persist") {
        const opportunity: unknown = JSON.parse(
          process.env.PORTCOVE_REVIEWED_OPPORTUNITY ?? "null",
        );
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
      } else {
        const opportunity: unknown = JSON.parse(
          process.env.PORTCOVE_REVIEWED_OPPORTUNITY ?? "null",
        );
        result = {
          classification: readReviewedClassification(api, config, opportunity),
          pause: readPublicationPause(api),
          admission: "hold",
          capacity: "unconfigured",
          protection_handoff: "unconfigured",
        };
      }
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
async function main() {
  const mode = process.argv[2];
  const role =
    mode === "probe-production-request" || mode === "persist-production-request"
      ? "writer"
      : mode === "probe-production-classification-observer" ||
          mode === "observe-production-classification"
        ? "observer"
        : null;
  if (!role) return runOperation();
  if (process.argv.length !== 3) throw new Error("fixed classification operation required");
  const authorities = await (role === "writer"
    ? requireProductionClassificationWriterAuthorities()
    : requireProductionClassificationObserverAuthorities());
  const policy: unknown = JSON.parse(process.env.PORTCOVE_CONTROLLER_ADMISSION ?? "null");
  if (!isRecord(policy)) throw new Error("ratified classification source unavailable");
  const deadline = currentClassificationJobDeadline(
    role,
    {
      run_id: process.env.GITHUB_RUN_ID ?? "",
      run_attempt: 1,
      controller_revision: String(policy.revision),
      controller_ref: String(policy.execution_ref),
    },
    process.cwd(),
    performance.now() + 115000,
  );
  return withCoordinatorDeadline(deadline, () => runOperation({ authorities, deadline }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("reviewed input operation refused");
    process.exitCode = 1;
  });
}
