import { readSetManyInput } from "./roadmap-batch-progress.mts";
import { RoadmapClient, roadmapLockPath, validateConfig } from "./roadmap.mts";
import { acquireOwnedProcessLock } from "./process-lock.mts";
import {
  continueRoadmapCapacity,
  roadmapQuotaDeferred,
  retainRoadmapQuotaDeferral,
} from "./roadmap-capacity-continuation.mts";
import { runScopedDoctor } from "./roadmap-scoped.mts";
import { captureCheckoutContext, checkContextualDoctor } from "./checkout-context.mts";
import type { GitHubRateLimit } from "./github-api.mts";
import { RoadmapBodyJournal, bodyOperationHash } from "./roadmap-body-progress.mts";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeGitHubBody, validateGitHubBody } from "./github-body.mts";
import type { BodyApi, BodyWriteOptions } from "./github-body.mts";
import { GitHubApiClient, sanitizeOperationError } from "./github-api.mts";
import { isRoadmapSpecification, validateLiveRoadmapReplacement } from "./roadmap-authoring.mts";
import { isRecord } from "./runtime-values.mts";
import config from "../.github/roadmap.json" with { type: "json" };

class BodyAlreadyDesired extends Error {}

/** A complete preflight precedes writes; every actual mutation still rechecks its exact live preimage. */
export async function editRoadmapBatch(
  edits: readonly BodyWriteOptions[],
  api: BodyApi,
  finish: (issues: readonly number[], mode: "issues" | "global") => Promise<unknown>,
  options: {
    progress?: RoadmapBodyJournal;
    admit?: (phase: string, index: number) => void | Promise<void>;
    identity?: () => string;
  } = {},
) {
  if (!edits.length) throw new Error("Batch requires positive distinct issue edits");
  const numbers = new Set<number>();
  const input = edits.map((candidate) => {
    const edit = { ...candidate };
    const number = Number(edit.target);
    if (
      edit.operation !== "issue-edit" ||
      !/^[1-9]\d*$/u.test(String(edit.target)) ||
      !Number.isSafeInteger(number) ||
      numbers.has(number)
    )
      throw new Error("Batch needs distinct positive issue identities");
    numbers.add(number);
    validateGitHubBody(edit.body);
    if (typeof edit.previousBody !== "string" || typeof edit.body !== "string")
      throw new Error("Batch edits require body and exact preimage");
    return {
      number,
      body_sha256: bodyOperationHash(edit.body),
      previous_sha256: bodyOperationHash(edit.previousBody),
    };
  });
  const identity = bodyOperationHash({ contract: 1, config, input });
  const progress = options.progress ?? new RoadmapBodyJournal(null, identity, edits.length);
  if (progress.identity !== identity)
    throw new Error("Body operation specification changed; preserve prior journal");
  const state = progress.state;
  const editAt = (index: number) => {
    const edit = { ...edits[index]! };
    if (
      bodyOperationHash(edit.body) !== input[index]!.body_sha256 ||
      bodyOperationHash(edit.previousBody) !== input[index]!.previous_sha256
    )
      throw new Error("Body source content changed; no further mutation");
    return edit;
  };
  const sourceIdentity = options.identity?.();
  const admit = async (phase: string, index: number) => {
    if (options.identity && options.identity() !== sourceIdentity)
      throw new Error("Body source files or configuration changed; no further operation");
    await options.admit?.(phase, index);
  };
  const read = (index: number) => {
    const number = input[index]!.number;
    const observed = api.request("GET", `repos/${config.repository}/issues/${number}`).body;
    if (
      !isRecord(observed) ||
      observed.number !== number ||
      !Number.isSafeInteger(observed.id) ||
      Number(observed.id) < 1 ||
      typeof observed.body !== "string" ||
      !isRoadmapSpecification(observed)
    )
      throw new Error(`Issue #${number} identity or durable specification is invalid`);
    if (state.identities[index] !== undefined && state.identities[index] !== observed.id)
      throw new Error(`Issue #${number} identity changed; preserve evidence`);
    return observed;
  };
  for (let i = state.identities.length; i < edits.length; i++) {
    await admit("body-preflight", i);
    const edit = editAt(i),
      before = read(i);
    if (before.body !== edit.previousBody && before.body !== edit.body)
      throw new Error(`Issue #${input[i]!.number} preimage changed before batch publication`);
    (api.validateRoadmapReplacement ?? validateLiveRoadmapReplacement)(
      input[i]!.number,
      String(before.body),
      String(edit.body),
    );
    state.identities.push(Number(before.id));
    if (before.body === edit.body) state.verified.push(i);
    progress.save();
  }
  if (state.phase === "completed") {
    state.checked = [];
    state.doctors = [];
    state.phase = "verify";
    progress.save();
  }
  if (state.phase === "preflight") {
    state.phase = "mutate";
    progress.save();
  }
  if (state.verified.length < edits.length && state.verified.length) {
    const binding = bodyOperationHash(state.verified);
    if (state.resumption?.binding !== binding) {
      state.resumption = { binding, checked: [] };
      progress.save();
    }
    for (const index of state.verified) {
      if (state.resumption.checked.includes(index)) continue;
      await admit("body-resumption-read", index);
      if (read(index).body !== editAt(index).body)
        throw new Error(
          `Issue #${input[index]!.number} previously verified body changed; no further writes`,
        );
      state.resumption.checked.push(index);
      progress.save();
    }
  }
  for (let i = 0; i < edits.length; i++) {
    if (state.verified.includes(i)) continue;
    await admit("body-mutation", i);
    const edit = editAt(i);
    if (state.uncertain.includes(i)) {
      const observed = read(i);
      if (observed.body !== edit.body)
        throw new Error(
          `Issue #${input[i]!.number} has an ambiguous prior write; do not resend automatically`,
        );
      state.uncertain = state.uncertain.filter((value) => value !== i);
      state.verified.push(i);
      progress.save();
      continue;
    }
    const guarded: BodyApi = {
      ...api,
      ...(api.graphql ? { graphql: (query, variables) => api.graphql!(query, variables) } : {}),
      ...(api.validateRoadmapReplacement
        ? {
            validateRoadmapReplacement: (number, previous, body) =>
              api.validateRoadmapReplacement!(number, previous, body),
          }
        : {}),
      request: (method, endpoint, payload) => {
        if (method === "PATCH") {
          state.uncertain.push(i);
          progress.save();
        }
        const result = api.request(method, endpoint, payload);
        if (method === "GET" && (!isRecord(result.body) || result.body.id !== state.identities[i]))
          throw new Error("Body mutation target identity changed; preserve prior operation");
        if (
          method === "GET" &&
          !state.uncertain.includes(i) &&
          isRecord(result.body) &&
          result.body.body === edit.body
        ) {
          edit.observe?.({ phase: "readback", result: result.body });
          throw new BodyAlreadyDesired("Exact desired body observed before any mutation");
        }
        return result;
      },
    };
    try {
      writeGitHubBody(edit, guarded);
    } catch (error) {
      if (!(error instanceof BodyAlreadyDesired)) throw error;
    }
    state.uncertain = state.uncertain.filter((value) => value !== i);
    state.verified.push(i);
    progress.save();
  }
  state.phase = "verify";
  progress.save();
  for (let i = 0; i < edits.length; i++) {
    if (state.checked.includes(i)) continue;
    await admit("body-final-read", i);
    if (read(i).body !== editAt(i).body)
      throw new Error(`Issue #${input[i]!.number} changed after its verified write; no overwrite`);
    state.checked.push(i);
    progress.save();
  }
  state.phase = "doctor";
  progress.save();
  const checks: unknown[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (state.doctors.includes(i)) continue;
    await admit("body-scoped-doctor", i);
    checks.push(await finish([input[i]!.number], "issues"));
    state.doctors.push(i);
    progress.save();
  }
  state.phase = "completed";
  progress.save();
  return {
    results: input.map((row, index) => ({
      number: row.number,
      id: state.identities[index],
      verified: true,
    })),
    mode: "issues" as const,
    check: checks,
    verification_interval: {
      started_at: state.started_at,
      completed_at: state.updated_at,
      checked: state.checked.length,
      scoped_checks: state.doctors.length,
      atomic_global_snapshot: false,
    },
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));
function loadBodyEdits(specPath: string, directory: string) {
  const spec: unknown = JSON.parse(readSetManyInput(specPath).toString("utf8"));
  if (!Array.isArray(spec)) throw new Error("Batch specification must be an array");
  const read = (file: string) =>
    new TextDecoder("utf-8", { fatal: true }).decode(readSetManyInput(path.resolve(root, file)));
  return spec.map((value: unknown, index) => {
    if (
      !isRecord(value) ||
      typeof value.body_file !== "string" ||
      typeof value.previous_body_file !== "string"
    )
      throw new Error("Invalid batch entry");
    const bodyFile = value.body_file,
      previousFile = value.previous_body_file;
    return {
      operation: "issue-edit",
      target: value.target,
      get body() {
        return validateGitHubBody(read(bodyFile));
      },
      get previousBody() {
        return read(previousFile);
      },
      observe: (observation: unknown) =>
        writeFileSync(
          path.join(directory, `${index}-${Date.now()}-${randomUUID()}.json`),
          JSON.stringify(observation),
          { flag: "wx" },
        ),
    };
  });
}
function inputIdentity(edits: readonly BodyWriteOptions[]) {
  return bodyOperationHash({
    contract: 1,
    config,
    input: edits.map((edit) => ({
      number: Number(edit.target),
      body_sha256: bodyOperationHash(edit.body),
      previous_sha256: bodyOperationHash(edit.previousBody),
    })),
  });
}
async function runBodyEdits(specPath: string) {
  const lockPath = roadmapLockPath(root);
  const key = bodyOperationHash(path.resolve(specPath));
  const directory = path.join(path.dirname(lockPath), "body-edits", key);
  mkdirSync(directory, { recursive: true });
  const operationLock = await acquireOwnedProcessLock(
    `${directory}.lock`,
    { workspace: root, command: "roadmap-edit" },
    { label: "Roadmap body operation" },
  );
  let roadmapLock;
  let observations: unknown[] = [];
  try {
    roadmapLock = await acquireOwnedProcessLock(
      lockPath,
      { workspace: root, command: "roadmap-edit" },
      { label: "Portcove Roadmap operation" },
    );
    const edits = loadBodyEdits(specPath, directory);
    const identity = inputIdentity(edits);
    const progress = new RoadmapBodyJournal(
      path.join(directory, "journal.json"),
      identity,
      edits.length,
    );
    const api = new GitHubApiClient(),
      client = new RoadmapClient(validateConfig(config), api);
    observations = api.observations;
    const rates = new Map<string, GitHubRateLimit>();
    let offset = 0;
    let observedCost = progress.state.graphql_cost ?? 10;
    const sample = () => {
      const body = api.request("GET", "rate_limit").body;
      const core = isRecord(body) && isRecord(body.resources) ? body.resources.core : null;
      if (
        !isRecord(core) ||
        !Number.isSafeInteger(core.remaining) ||
        !Number.isSafeInteger(core.limit) ||
        !Number.isSafeInteger(core.reset)
      )
        throw new Error("REST capacity is unknown; progress retained");
      rates.set("core", {
        resource: "core",
        remaining: Number(core.remaining),
        limit: Number(core.limit),
        used: null,
        resetAt: new Date(Number(core.reset) * 1000).toISOString(),
      });
      client.sampleGraphqlRate();
    };
    sample();
    const result = await editRoadmapBatch(
      edits,
      {
        request: (method, endpoint, payload) => api.request(method, endpoint, payload),
        validateRoadmapReplacement: (number, previous, body) =>
          validateLiveRoadmapReplacement(number, previous, body, client),
      },
      async (issues) => {
        const checked = await checkContextualDoctor({
          capture: () => captureCheckoutContext(root),
          check: () => runScopedDoctor(client.config, client, { issues }),
        });
        const receipt = {
          format: 1,
          kind: "roadmap-doctor",
          status: "passed",
          context: checked.context,
          ...checked.result,
        };
        writeFileSync(
          path.join(directory, `doctor-${issues[0]}-${randomUUID()}.json`),
          JSON.stringify(receipt),
          { flag: "wx" },
        );
        return receipt;
      },
      {
        progress,
        identity: () =>
          bodyOperationHash({
            spec: readSetManyInput(specPath).toString("utf8"),
            configuration: readSetManyInput(path.join(root, ".github/roadmap.json")).toString(
              "utf8",
            ),
          }),
        admit: (phase, index) => {
          const newObservations = api.observations.slice(offset);
          observedCost = Math.max(
            observedCost,
            newObservations.reduce(
              (sum, entry) =>
                sum + (entry.rate?.resource === "graphql" ? (entry.rate.cost ?? 0) : 0),
              0,
            ),
          );
          progress.state.graphql_cost = observedCost;
          for (const entry of newObservations)
            if (entry.rate?.resource && entry.rate.remaining !== null)
              rates.set(entry.rate.resource, entry.rate);
          offset = api.observations.length;
          for (const resource of ["core", "graphql"]) {
            const rate = rates.get(resource);
            if (
              !rate ||
              rate.remaining === null ||
              rate.limit === null ||
              !rate.resetAt ||
              !Number.isFinite(Date.parse(rate.resetAt))
            )
              throw new Error(`${resource} capacity is unknown; progress retained`);
            const reserve = Math.max(100, Math.ceil(rate.limit * 0.05));
            const cost = resource === "core" ? 4 : observedCost;
            if (rate.remaining < reserve + cost)
              throw roadmapQuotaDeferred(
                phase,
                { index, resource, completed: progress.state.verified.length },
                { remaining: rate.remaining, resetAt: rate.resetAt },
              );
          }
        },
      },
    );
    const output = { ...result, evidence: directory };
    writeFileSync(path.join(directory, `result-${randomUUID()}.json`), JSON.stringify(output), {
      flag: "wx",
    });
    console.log(JSON.stringify(output));
  } catch (error) {
    writeFileSync(
      path.join(directory, `error-${randomUUID()}.json`),
      JSON.stringify(sanitizeOperationError(error)),
      { flag: "wx" },
    );
    throw error;
  } finally {
    try {
      if (observations.length)
        writeFileSync(
          path.join(directory, `provider-${randomUUID()}.json`),
          JSON.stringify(observations),
          { flag: "wx" },
        );
    } finally {
      await roadmapLock?.release();
      await operationLock.release();
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--spec-file")
      throw new Error(
        "Usage: roadmap-edit.mts --spec-file FILE (JSON array of {target, body_file, previous_body_file})",
      );
    const spec = path.resolve(root, process.argv[3]!);
    await continueRoadmapCapacity(() => runBodyEdits(spec), {
      identity: () =>
        bodyOperationHash({
          input: inputIdentity(loadBodyEdits(spec, path.join(root, "work/roadmap-edit"))),
          configuration: readSetManyInput(path.join(root, ".github/roadmap.json")).toString("utf8"),
        }),
      observe: (error) => retainRoadmapQuotaDeferral(root, error),
    });
  } catch (error) {
    console.error(sanitizeOperationError(error).message);
    process.exitCode = 1;
  }
}
