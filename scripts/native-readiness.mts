import type {
  ActivityRecord,
  LaunchReadiness,
} from "../apps/desktop/src/transport-types.generated.js";
import { errorMessage } from "./runtime-values.mts";
import { writeFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { fileIdentity } from "./development-evidence.mts";
import assert from "node:assert/strict";

type PreparationActivity = Pick<ActivityRecord, "id" | "operation" | "target_id" | "status"> &
  Partial<Pick<ActivityRecord, "started_at" | "finished_at">>;
type ObservationPhase = "activity" | "status" | "review";
interface PreparationSample {
  observed_at: string;
  readiness: boolean | "not-read-before-terminal";
  review_closed: boolean | "not-read-before-readiness";
  phase?: ObservationPhase | "complete";
  activity_ms?: number;
  status_ms?: number;
  review_ms?: number;
  new_activity_count?: number;
  activities?: {
    id: ActivityRecord["id"];
    status: ActivityRecord["status"];
    started_at: ActivityRecord["started_at"] | undefined;
    finished_at: ActivityRecord["finished_at"] | undefined;
  }[];
}
export interface PreparationObservation {
  samples?: number;
  last?: PreparationSample;
  activity_reads?: number;
  status_reads?: number;
  review_reads?: number;
}
interface PreparationOptions<Status> {
  readActivities(this: void): Promise<{ records: PreparationActivity[] }>;
  readStatus(this: void): Promise<Status>;
  isReviewClosed(this: void): Promise<boolean>;
  portId: string;
  priorPreparationIds: ReadonlySet<string>;
  observation: PreparationObservation;
}

export async function observePreparationCompletion<
  Status extends { readiness: Pick<LaunchReadiness, "launchable"> },
>({
  readActivities,
  readStatus,
  isReviewClosed,
  portId,
  priorPreparationIds,
  observation,
}: PreparationOptions<Status>) {
  observation.samples = (observation.samples ?? 0) + 1;
  const sample: PreparationSample = {
    observed_at: new Date().toISOString(),
    readiness: "not-read-before-terminal",
    review_closed: "not-read-before-readiness",
  };
  observation.last = sample;
  const read = async <Value,>(
    kind: ObservationPhase,
    action: () => Promise<Value>,
  ): Promise<Value> => {
    sample.phase = kind;
    observation[`${kind}_reads`] = (observation[`${kind}_reads`] ?? 0) + 1;
    const started = performance.now();
    try {
      return await action();
    } finally {
      sample[`${kind}_ms`] = performance.now() - started;
    }
  };
  const records = (await read("activity", readActivities)).records.filter(
    (item) =>
      item.operation === "prepare" &&
      item.target_id === portId &&
      !priorPreparationIds.has(item.id),
  );
  sample.new_activity_count = records.length;
  sample.activities = records.slice(0, 8).map(({ id, status, started_at, finished_at }) => ({
    id,
    status,
    started_at,
    finished_at,
  }));
  const terminal = records.find((item) => item.status === "succeeded");
  // Full catalog status hydration performs filesystem/readiness work. Avoid
  // repeating it while the owned mutation is still running. The caller keeps
  // one unchanged deadline around all three completion conditions.
  if (!terminal) return false;
  const value = await read("status", readStatus);
  sample.readiness = value.readiness.launchable;
  if (!sample.readiness) return false;
  sample.review_closed = await read("review", isReviewClosed);
  if (!sample.review_closed) return false;
  assert.equal(
    records.length,
    1,
    "One deliberate preparation must produce exactly one new operation",
  );
  sample.phase = "complete";
  return { status: value, activity: terminal };
}

export function capabilityRequirement(observation: { outcome: string }, requirement: unknown) {
  if (
    typeof requirement !== "string" ||
    !["declared-api-fallback", "injected-controller", "physical-controller"].includes(requirement)
  )
    throw new Error("Unknown controller requirement");
  if (requirement === "declared-api-fallback")
    return {
      outcome: ["api-absent", "api-access-failed-or-restricted", "no-exposed-device"].includes(
        observation.outcome,
      )
        ? "passed"
        : "unsupported",
      claim: "declared absence fallback only",
    };
  return {
    outcome: "unsupported",
    claim:
      requirement === "physical-controller"
        ? "Exposed devices alone do not establish physical observations"
        : "Requires actual injected-controller behavior",
  };
}

export interface VisualTargetObservation {
  visible: boolean;
  viewport: { width: number; height: number };
  application_state: { document_ready: string; loading: number };
}
interface CaptureOptions<
  State extends VisualTargetObservation,
  Semantic extends { ready: boolean },
> {
  browser: { takeScreenshot(): Promise<string> };
  output: string;
  name: string;
  scenario: string;
  target: string;
  // Browser execution belongs to the adapter. Node evidence code consumes the
  // resulting wire observation without importing a DOM implementation.
  observeTarget(this: void): Promise<State>;
  readiness(this: void): Promise<Semantic>;
  timeoutMs?: number;
  write?: (
    file: string,
    bytes: string | Uint8Array,
    options: { flag: "wx"; signal: AbortSignal },
  ) => Promise<void>;
}

export async function captureSettledVisual<
  State extends VisualTargetObservation,
  Semantic extends { ready: boolean },
>({
  browser,
  output,
  name,
  scenario,
  target,
  observeTarget,
  readiness,
  timeoutMs = 5000,
  write = writeFile,
}: CaptureOptions<State, Semantic>) {
  if (
    !scenario ||
    !target ||
    typeof observeTarget !== "function" ||
    typeof readiness !== "function" ||
    !/^[a-z0-9-]+$/u.test(name) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new Error("Settled capture requires a bounded caller-specific contract");
  const end = Date.now() + timeoutMs;
  const observations: { semantic: Semantic; state: State }[] = [];
  let image: string | undefined;
  async function writeJoined(file: string, bytes: string | Uint8Array) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("Settled capture timed out");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Settled capture timed out")),
      remaining,
    );
    try {
      // Cancellation requests stop work; they never substitute for joining it.
      await write(file, bytes, { flag: "wx", signal: controller.signal });
      if (controller.signal.aborted || Date.now() >= end)
        throw new Error("Settled capture timed out");
    } finally {
      clearTimeout(timer);
    }
  }
  async function bounded<Value>(operation: () => Value | Promise<Value>): Promise<Value> {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("Settled capture timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Settled capture timed out")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function observe() {
    const semantic = await bounded(readiness);
    const state = await bounded(observeTarget);
    const value = { semantic, state };
    observations.push(value);
    if (observations.length > 16) observations.shift();
    return value;
  }
  const ready = (value: { semantic: Semantic; state: State }) =>
    value.semantic?.ready === true &&
    value.state.visible &&
    value.state.viewport.width > 0 &&
    value.state.viewport.height > 0 &&
    value.state.application_state.document_ready === "complete" &&
    value.state.application_state.loading === 0;
  try {
    let before: { semantic: Semantic; state: State };
    let previous: typeof before | undefined;
    for (;;) {
      before = await observe();
      // Semantic readiness can precede a returning panel's layout transition.
      // Require two matching observations before taking the one candidate PNG;
      // the post-capture check still rejects any later state change.
      if (ready(before) && previous && JSON.stringify(previous) === JSON.stringify(before)) break;
      previous = before;
      await bounded(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    const bytes = Buffer.from(await bounded(() => browser.takeScreenshot()), "base64");
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Screenshot is not PNG evidence");
    const after = await observe();
    if (!ready(after) || JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Application state changed during capture");
    const imagePath = path.join(output, `${name}.png`);
    image = imagePath;
    await writeJoined(imagePath, bytes);
    const identity = await bounded(() => fileIdentity(imagePath));
    const receipt = path.join(output, `${name}-capture.json`);
    const record = {
      format_version: 1,
      outcome: "captured",
      scenario,
      image: identity,
      observation: after,
    };
    const staging = path.join(output, `${name}-capture.partial`);
    await writeJoined(staging, JSON.stringify(record, null, 2) + "\n");
    if (Date.now() >= end) throw new Error("Settled capture timed out");
    await link(staging, receipt); // no-clobber publication; await its actual result
    if (Date.now() >= end) {
      await unlink(receipt); // only our just-created link; retain staging and image
      throw new Error("Settled capture timed out");
    }
    await unlink(staging);
    return { ...record, receipt };
  } catch (error) {
    const diagnostic = path.join(output, `${name}-capture-failure.json`);
    await writeFile(
      diagnostic,
      JSON.stringify(
        {
          format_version: 1,
          outcome: "failed",
          scenario,
          target,
          message: errorMessage(error),
          observations,
          partial_image: image ?? null,
          acceptance: false,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    ).catch(() => {});
    throw new Error(`${errorMessage(error)}; capture diagnostics ${diagnostic}`, { cause: error });
  }
}
