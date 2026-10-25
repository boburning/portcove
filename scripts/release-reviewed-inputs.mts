import { spawnSync } from "node:child_process";
import { open, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import {
  admitReviewedInputsController,
  admitProductionCatalogProtectionObserver,
  admitProductionProtectionObserver,
  admitProductionClassificationObserver,
  readProductionControllerWorkflowBytes,
  isSharedApplicationProtectionObserverSource,
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
  checkCoordinatorDeadline,
  withCoordinatorDeadline,
} from "./release-coordinator-deadline.mts";
import {
  currentClassificationJobDeadline,
  currentSharedProtectionJobDeadline,
} from "./release-signing-job-budget.mts";
import {
  requireProductionClassificationWriterAuthorities,
  requireProductionClassificationObserverAuthorities,
  requireSelectedProductionClassificationAuthorities,
} from "./release-authority-configuration.mts";
import { requireProtectionObserverSourceConfiguration } from "./release-authority-configuration-contract.mts";
import {
  prepareFixedClassificationProducer,
  establishFixedClassificationPrincipal,
  requireProductionFixedClassificationWriter,
  requireProductionProtectionObserver,
} from "./release-classification-principal.mts";
import { requireFixedClassificationStoragePolicy } from "./release-input-protections.mts";
import type { inspectApplicationReviewProducerConfiguration } from "./release-control-inputs.mts";

export async function retainProtectionObservationOutputs(
  output: string | undefined,
  retainedPath: string | undefined,
  result: unknown,
  operation: string,
  receipt: { writeFile: (value: string) => Promise<unknown> },
  requireFresh: () => void,
  io: Pick<typeof import("node:fs/promises"), "appendFile" | "writeFile"> = {
    appendFile,
    writeFile,
  },
) {
  const encoded = JSON.stringify(result);
  requireFresh();
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 60 * 1024 || !output)
    throw new Error("trusted observer output channel unavailable or oversized");
  await io.appendFile(output, `observation=${encoded}\n`);
  requireFresh();
  if (retainedPath) {
    await io.writeFile(retainedPath, encoded, { flag: "wx", mode: 0o600 });
    requireFresh();
  }
  await receipt.writeFile(
    JSON.stringify({
      schema_version: 1,
      operation,
      status: "succeeded",
      result,
      authority: "none",
    }) + "\n",
  );
  requireFresh();
}

async function runOperation(
  classification?: {
    namespace: string;
    producer: ReturnType<typeof inspectApplicationReviewProducerConfiguration>;
    selected?: Awaited<ReturnType<typeof requireSelectedProductionClassificationAuthorities>>;
    environment: NodeJS.ProcessEnv;
    deadline: number;
    observerSource?: ReturnType<typeof admitProductionClassificationObserver>;
  },
  sharedObserver?: {
    environment: NodeJS.ProcessEnv;
    deadline: number;
    source: ReturnType<typeof admitProductionProtectionObserver>;
  },
) {
  const environment = classification?.environment ??
    sharedObserver?.environment ?? { ...process.env };
  const originalDeadline = classification?.deadline ?? sharedObserver?.deadline;
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
          environment.PORTCOVE_CONTROLLER_ADMISSION,
          environment,
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
    inspectControllerExecutionPurpose(environment.PORTCOVE_EXECUTION_PURPOSE) ===
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
  const observerSource = productionObservation
    ? (sharedObserver?.source ??
      (catalogPurpose
        ? admitProductionCatalogProtectionObserver
        : admitProductionProtectionObserver)(
        catalogPurpose
          ? environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION
          : environment.PORTCOVE_CONTROLLER_ADMISSION,
        environment,
        await readProductionControllerWorkflowBytes(),
        phase,
      ))
    : classification?.observerSource;
  const observing = mode === "observe" || productionObservation || classificationObserver;
  const persisting =
    mode === "persist" || mode === "persist-request" || mode === "persist-production-request";
  const temp = environment.RUNNER_TEMP;
  if (!temp || !path.isAbsolute(temp))
    throw new Error("private runner temporary directory unavailable");
  // Exclusive receipt opens before any source or mutation. Never persist tokens
  // or raw exceptions/provider output. Existing receipt means no retry.
  const receipt = await open(
    path.join(temp, `release-reviewed-inputs-${mode}${roundSuffix}.jsonl`),
    "wx",
    0o600,
  );
  let requireObserver = () => {};
  try {
    await receipt.writeFile(
      JSON.stringify({ schema_version: 1, operation: mode, status: "started", authority: "none" }) +
        "\n",
    );
    const fixedObserver =
      productionObservation ||
      classificationObserver ||
      mode === "probe-production-classification-observer";
    const observerPhase =
      classificationObserver || mode === "probe-production-classification-observer"
        ? "classification"
        : phase;
    const observerPurpose = catalogPurpose ? "catalog-publication" : "application";
    const rawObserver = fixedObserver
      ? catalogPurpose
        ? environment.PORTCOVE_CATALOG_AUTHORITIES
        : environment.PORTCOVE_RELEASE_AUTHORITIES
      : undefined;
    if (fixedObserver && (!rawObserver || Buffer.byteLength(rawObserver) > 32768))
      throw new Error("complete observer source configuration unavailable");
    const observerConfiguration: unknown = rawObserver ? JSON.parse(rawObserver) : null;
    const observerRoles = fixedObserver
      ? requireProtectionObserverSourceConfiguration(
          observerConfiguration,
          observerSource,
          observerPhase,
          observerPurpose,
        )
      : null;
    if (
      observerRoles &&
      (environment.PORTCOVE_EXPECTED_PROTECTION_APP_ID !==
        String(observerRoles.protection_app_id) ||
        environment.PORTCOVE_EXPECTED_INSTALLATION_ID !==
          String(observerRoles.protection_installation_id))
    )
      throw new Error("observer mint target differs from the source-bound configuration");
    const selectedWriter = classification?.selected !== undefined && persisting;
    if (selectedWriter || observerRoles?.classification_transport === "fixed-job") {
      const { assertControllerBootstrapEnvironment } =
        await import("./release-controller-job-bootstrap.mts");
      assertControllerBootstrapEnvironment({
        ...environment,
        ...(observing ? { PORTCOVE_CONTROL_APP_TOKEN: undefined } : {}),
      });
    }
    const appToken =
      observing || (persisting && !selectedWriter)
        ? environment.PORTCOVE_CONTROL_APP_TOKEN
        : undefined;
    const jobToken = selectedWriter ? environment.GH_TOKEN : undefined;
    if (selectedWriter && (!jobToken || jobToken.length > 16384))
      throw new Error("isolated fixed classification job token unavailable");
    if ((observing || (persisting && !selectedWriter)) && (!appToken || appToken.length > 16384))
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
              ...environment,
              GH_TOKEN: appToken ?? jobToken ?? environment.GH_TOKEN,
              GITHUB_TOKEN: undefined,
              PORTCOVE_CONTROL_APP_TOKEN: undefined,
              ...(selectedWriter || observing
                ? {
                    ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
                    ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
                  }
                : {}),
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
        spawn: (command, args, options) =>
          spawnSync(command, args, {
            ...options,
            env: {
              ...environment,
              GH_TOKEN: environment.GH_TOKEN,
              GITHUB_TOKEN: undefined,
              PORTCOVE_CONTROL_APP_TOKEN: undefined,
              ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
              ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
            },
          }),
      })(args, input);
    const readApi = selectedWriter
      ? appApi
      : new GitHubApiClient((args, input) =>
          readRunner([...args, "--hostname", "github.com"], input),
        );
    const api = {
      request: (method: string, endpoint: string, body?: unknown) => {
        if (observing && method !== "GET")
          throw new Error("isolated protection observer is GET-only");
        return (
          /\/(?:check-runs|check-suites)(?:\/|\?)/u.test(endpoint) ? readApi : appApi
        ).request(method, endpoint, body);
      },
      graphql: (query: string, variables: Readonly<Record<string, unknown>>) => {
        if (observing) throw new Error("isolated protection observer cannot use GraphQL");
        return appApi.graphql(query, variables);
      },
    };
    let observerIdentity: unknown = null;
    let writerPrincipal: ReturnType<typeof establishFixedClassificationPrincipal> | null = null;
    if (observing || persisting) {
      // Config is separately ratified environment data, never an input file or
      // dispatch-provided expected identity. No self-expectation from JWT claims.
      if (environment.GITHUB_RUN_ATTEMPT !== "1")
        throw new Error("review input reruns are not admitted");
      const policy: unknown = JSON.parse(
        (catalogPurpose
          ? environment.PORTCOVE_CATALOG_CONTROLLER_ADMISSION
          : environment.PORTCOVE_CONTROLLER_ADMISSION) ?? "null",
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
        run_id: environment.GITHUB_RUN_ID,
        run_attempt: 1,
      });
      const token = await requestAssemblerToken(
        expected.audience,
        environment,
        fetch,
        originalDeadline,
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
            ...(originalDeadline === undefined ? {} : { deadline: originalDeadline }),
          },
        },
        phase,
        productionObservation ? observerSource : undefined,
      );
      if (observing) {
        observerIdentity = identity;
        if (fixedObserver) {
          requireObserver = () => {
            requireProductionProtectionObserver(
              observerConfiguration,
              observerSource,
              identity,
              observerPhase,
              observerPurpose,
              environment.PORTCOVE_EXPECTED_PROTECTION_APP_ID,
              environment.PORTCOVE_OBSERVED_INSTALLATION_ID,
            );
            checkCoordinatorDeadline();
          };
          requireObserver();
        }
      }
      if (classification?.selected && persisting) {
        writerPrincipal = establishFixedClassificationPrincipal(
          classification.selected.configuration,
          classification.selected.source,
          identity,
          "classification-writer",
        );
        requireProductionFixedClassificationWriter(writerPrincipal);
      }
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
      const recovered = await recoverRemoteCoordinator(
        temp,
        { schema_version: 1, namespace: classification.namespace },
        { transport: { cwd: process.cwd() } },
      );
      result = inspectClassificationRequestReadiness(
        api,
        classification.producer,
        recovered.input.review_request,
      );
      if (!environment.GITHUB_OUTPUT || !isRecord(result))
        throw new Error("fixed classification routing channel unavailable");
      await appendFile(
        environment.GITHUB_OUTPUT,
        `eligible=${result.eligible === true ? "true" : "false"}\n`,
      );
    } else if (observing) {
      requireObserver();
      result = catalogPurpose
        ? observeCatalogMaintenanceProtections(api)
        : observeReleaseInputProtections(api, {
            releasePublication: phase === "release-publication",
          });
      requireObserver();
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
      await retainProtectionObservationOutputs(
        environment.GITHUB_OUTPUT,
        productionObservation
          ? roundIndex === undefined
            ? path.join(temp, `observation-${phase}.json`)
            : path.join(
                temp,
                `release-control-ready-${phase}${roundSuffix}`,
                `observation-${phase}.json`,
              )
          : undefined,
        result,
        mode,
        receipt,
        requireObserver,
      );
    } else {
      const { persistReviewedClassification, readPublicationPause, readReviewedClassification } =
        await import("./release-control-inputs.mts");
      const config: unknown = JSON.parse(environment.PORTCOVE_REVIEW_PRODUCER ?? "null");
      if (mode === "persist-request" || mode === "persist-production-request") {
        const { requireReviewedInputsReleaseAuthorities } =
          await import("./release-authority-configuration.mts");
        const { recoverRemoteCoordinator } = await import("./release-coordinator-recovery.mts");
        const { inspectReleaseReviewRequest } = await import("./release-review-request.mts");
        const { semanticReviewCheckName } = await import("./release-semantic-review.mts");
        const { persistReviewedClassificationForRequest, requireCurrentClassificationRequest } =
          await import("./release-classification-request.mts");
        const authorities = classification ? null : await requireReviewedInputsReleaseAuthorities();
        const producer =
          classification?.producer ??
          (authorities
            ? {
                schema_version: 1,
                review_app_id: authorities.apps.semantic.app_id,
                writer_app_id: authorities.apps.classification.app_id,
                review_check_name: semanticReviewCheckName,
              }
            : null);
        if (producer === null) throw new Error("classification producer unavailable");
        const namespace = classification?.namespace ?? authorities?.namespace;
        if (!namespace) throw new Error("classification journal namespace unavailable");
        const { inspectReviewProducerConfiguration } = await import("./release-control-inputs.mts");
        const parsed = classification ? producer : inspectReviewProducerConfiguration(config);
        if (
          parsed.review_app_id !== producer.review_app_id ||
          ("writer_app_id" in producer &&
            (!("writer_app_id" in parsed) || parsed.writer_app_id !== producer.writer_app_id)) ||
          parsed.review_check_name !== producer.review_check_name
        )
          throw new Error("writer producer roles differ from ratified release authority");
        const recovered = await recoverRemoteCoordinator(
          temp,
          { schema_version: 1, namespace },
          { transport: { cwd: process.cwd() } },
        );
        const request = inspectReleaseReviewRequest(recovered.input.review_request);
        if (!request) throw new Error("no outstanding exact journal request for automatic writer");
        const requireFreshWriter = () => {
          const protection: unknown = JSON.parse(
            environment.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION ?? "null",
          );
          if (classification?.selected) {
            requireProductionFixedClassificationWriter(writerPrincipal);
            requireFixedClassificationStoragePolicy(protection, writerPrincipal);
          } else {
            if (!("writer_app_id" in producer))
              throw new Error("legacy writer identity unavailable");
            requireReleaseInputWriterPolicy(protection, producer.writer_app_id);
          }
        };
        const beforeMutation = () =>
          requireCurrentClassificationRequest(
            readApi,
            namespace,
            recovered.checkpoint,
            requireFreshWriter,
          );
        beforeMutation();
        result = persistReviewedClassificationForRequest(api, producer, request, beforeMutation);
        beforeMutation();
      } else if (mode === "persist") {
        const opportunity: unknown = JSON.parse(
          environment.PORTCOVE_REVIEWED_OPPORTUNITY ?? "null",
        );
        // Only the fixed held workflow maps this from needs.protection_observation.
        // No workflow_dispatch inputs are declared. A cross-workflow receipt is
        // not accepted, and aggregate admission remains independently held.
        if (!isRecord(config) || typeof config.writer_app_id !== "number")
          throw new Error("writer identity unconfigured");
        requireReleaseInputWriterPolicy(
          JSON.parse(environment.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION ?? "null"),
          config.writer_app_id,
        );
        const check = environment.PORTCOVE_REVIEW_CHECK_ID;
        if (!check || !/^[1-9][0-9]{0,15}$/u.test(check))
          throw new Error("exact independent check identity unavailable");
        result = persistReviewedClassification(api, config, opportunity, Number(check), () => {
          requireReleaseInputWriterPolicy(
            JSON.parse(environment.PORTCOVE_TRUSTED_PROTECTION_OBSERVATION ?? "null"),
            config.writer_app_id as number,
          );
        });
      } else {
        const opportunity: unknown = JSON.parse(
          environment.PORTCOVE_REVIEWED_OPPORTUNITY ?? "null",
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
    if (!observing)
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
  requireObserver();
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
  if (!role) {
    const environment = { ...process.env };
    if (
      environment.GITHUB_JOB === "protection_observation" &&
      mode?.startsWith("observe-production")
    ) {
      const phase = inspectReleaseControlPhase(
        mode === "observe-production" ? "admission" : mode.slice("observe-production-".length),
      );
      const source = admitProductionProtectionObserver(
        environment.PORTCOVE_CONTROLLER_ADMISSION,
        environment,
        await readProductionControllerWorkflowBytes(),
        phase,
      );
      if (isSharedApplicationProtectionObserverSource(source)) {
        const deadline = currentSharedProtectionJobDeadline(
          {
            run_id: source.run_id,
            run_attempt: 1,
            controller_revision: source.revision,
            controller_ref: source.execution_ref,
          },
          process.cwd(),
          performance.now() + 570000,
        );
        return withCoordinatorDeadline(deadline, () =>
          runOperation(undefined, { environment, deadline, source }),
        );
      }
    }
    return runOperation();
  }
  if (process.argv.length !== 3) throw new Error("fixed classification operation required");
  const { inspectApplicationReviewProducerConfiguration } =
    await import("./release-control-inputs.mts");
  const environment = { ...process.env };
  const raw: unknown = JSON.parse(environment.PORTCOVE_RELEASE_AUTHORITIES ?? "null");
  const selected =
    isRecord(raw) && (raw.schema_version === 4 || raw.kind === "two-app-fixed-jobs-v1")
      ? await requireSelectedProductionClassificationAuthorities(role)
      : undefined;
  const authorities = selected
    ? null
    : await (role === "writer"
        ? requireProductionClassificationWriterAuthorities()
        : requireProductionClassificationObserverAuthorities());
  const producer = selected
    ? prepareFixedClassificationProducer(selected.configuration, selected.source)
    : authorities
      ? inspectApplicationReviewProducerConfiguration({
          schema_version: 1,
          review_app_id: authorities.apps.semantic.app_id,
          writer_app_id: authorities.apps.classification.app_id,
          review_check_name: "Portcove independent release semantic review",
        })
      : null;
  if (!producer) throw new Error("classification producer unavailable");
  const namespace = selected?.configuration.journal.namespace ?? authorities?.namespace;
  if (!namespace) throw new Error("classification namespace unavailable");
  const policy: unknown = JSON.parse(environment.PORTCOVE_CONTROLLER_ADMISSION ?? "null");
  if (!isRecord(policy)) throw new Error("ratified classification source unavailable");
  const deadline = currentClassificationJobDeadline(
    role,
    {
      run_id: environment.GITHUB_RUN_ID ?? "",
      run_attempt: 1,
      controller_revision: String(policy.revision),
      controller_ref: String(policy.execution_ref),
    },
    process.cwd(),
    performance.now() + 115000,
  );
  const observerSource =
    role === "observer"
      ? (selected?.source ??
        admitProductionClassificationObserver(
          environment.PORTCOVE_CONTROLLER_ADMISSION,
          environment,
          await readProductionControllerWorkflowBytes(),
        ))
      : undefined;
  return withCoordinatorDeadline(deadline, () =>
    runOperation({
      namespace,
      producer,
      ...(selected ? { selected } : {}),
      environment,
      deadline,
      ...(observerSource ? { observerSource } : {}),
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("reviewed input operation refused");
    process.exitCode = 1;
  });
}
