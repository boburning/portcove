/**
 * Hosted-intake source for the #4129 maintenance inventory.
 *
 * Reads every marker-bearing owner request on #177 through the executor's own
 * read-only `hostedStatusAll` (one complete, drift-checked comment read; the
 * executor's request, receipt and reconciliation validation and its
 * `status()` classification). No comment text is parsed here. The executor
 * and its receipts keep their authority: this projection grants no intake,
 * admission, Priority or support authority, and keeps only stable per-request
 * facts so routine re-reads stay quiet in changes-only storage.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MaintenanceStoreError } from "./maintenance-store.mts";
import type { HostedCandidateSlot, HostedStatusAll } from "./hosted-discovery-intake.mts";

export interface HostedIntakeGap {
  subject_key: string;
  code: string;
  message: string;
}

export interface HostedIntakeObservation {
  revision: string;
  failed: boolean;
  expected: number | null;
  facts: ReadonlyMap<string, unknown>;
  gaps: HostedIntakeGap[];
}

/** One stored request fact, as the report reads it. */
export interface HostedIntakeFact {
  request_comment: number;
  receipt_comment: number | null;
  withdrawn: boolean;
  reconciles: number | null;
  superseded_by: number[];
  body_request_comment: number;
  status: string;
  candidates: number;
  delivered: number;
  existing: number;
  held: number;
  pending: number;
  full_doctor_required: boolean;
  doctor: { status: unknown; coverage: unknown; global_health: unknown } | null;
  blocker: { code: string } | null;
  slots: HostedCandidateSlot[];
}

const failedSubject = "source:hosted-intake-queue";
export const intakeSubject = (request: number) => `intake:${request}`;

/**
 * The run revision binds #177's node, comment count and revision and the digest
 * of every (comment id, body SHA-256), within the store's 200-character limit.
 */
export function hostedIntakeRevision(queue: HostedStatusAll["queue"]) {
  const revision = `hosted-intake:${queue.node_id}:${queue.comments}@${queue.updated_at}#sha256:${queue.comments_sha256}`;
  return revision.length <= 200
    ? revision
    : `hosted-intake:sha256:${createHash("sha256").update(revision).digest("hex")}`;
}

/**
 * Per-request facts from one complete status read. Receipt clocks, run and head
 * identities, plan origin, hold observation times, doctor receipt digests,
 * error messages and diagnostic times are never stored, so an unchanged
 * request stays quiet. A request the executor cannot validate is an
 * `invalid-receipt` gap and its prior facts stay current.
 */
export function hostedIntakeFacts(read: HostedStatusAll) {
  const facts = new Map<string, HostedIntakeFact>();
  const gaps: HostedIntakeGap[] = [];
  const seen = new Set<number>();
  for (const row of read.requests) {
    if (!Number.isSafeInteger(row.request_comment) || seen.has(row.request_comment))
      throw new MaintenanceStoreError("Unsupported hosted intake status read");
    seen.add(row.request_comment);
    const key = intakeSubject(row.request_comment);
    if ("error" in row) {
      gaps.push({
        subject_key: key,
        code: "invalid-receipt",
        message:
          `The executor could not validate this request, its receipt or its reconciliation; prior facts stay current. ${row.error.code}: ${row.error.message}`.slice(
            0,
            1000,
          ),
      });
      continue;
    }
    const doctor = row.doctor as Record<string, unknown> | null;
    const error = row.last_error as { code?: unknown } | null;
    facts.set(key, {
      request_comment: row.request_comment,
      receipt_comment: row.receipt_comment,
      withdrawn: row.withdrawn,
      reconciles: row.reconciles,
      superseded_by: [...row.superseded_by].sort((left, right) => left - right),
      body_request_comment: row.body_request_comment,
      status: row.status,
      candidates: row.candidates,
      delivered: row.delivered,
      existing: row.existing,
      held: row.held,
      pending: row.pending,
      full_doctor_required: row.full_doctor_required,
      doctor: doctor
        ? {
            status: doctor.status ?? null,
            coverage: doctor.coverage ?? null,
            global_health: doctor.global_health ?? null,
          }
        : null,
      blocker: error ? { code: typeof error.code === "string" ? error.code : "unknown" } : null,
      slots: row.slots.map((slot) => ({
        candidate_index: slot.candidate_index,
        port_key: slot.port_key,
        repository_id: slot.repository_id,
        upstream: slot.upstream,
        delivery_status: slot.delivery_status,
        linked_issue: slot.linked_issue,
        existing: slot.existing,
        hold: slot.hold ? { http_status: slot.hold.http_status, resume: slot.hold.resume } : null,
      })),
    });
  }
  return {
    revision: hostedIntakeRevision(read.queue),
    expected: read.requests.length,
    facts: new Map([...facts].sort(([left], [right]) => (left < right ? -1 : 1))),
    gaps: gaps.sort((left, right) => (left.subject_key < right.subject_key ? -1 : 1)),
  };
}

/**
 * Projects one read. Drift during the read (`inventory_changed`) and any other
 * read or budget failure are a failed run with one gap: nothing is observed,
 * so every prior fact stays current.
 */
export async function hostedIntakeObservation(
  read: () => Promise<HostedStatusAll>,
): Promise<HostedIntakeObservation> {
  try {
    return { failed: false, ...hostedIntakeFacts(await read()) };
  } catch (error) {
    const changed = (error as { code?: unknown } | null)?.code === "inventory_changed";
    return {
      revision: changed ? "hosted-intake:inventory-changed" : "hosted-intake:unavailable",
      failed: true,
      expected: null,
      facts: new Map(),
      gaps: [
        {
          subject_key: failedSubject,
          code: changed ? "inventory-changed" : "unavailable",
          message: `${
            changed
              ? "The #177 request queue changed during the read"
              : "The #177 request queue could not be read completely"
          }; prior facts stay current. ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            1000,
          ),
        },
      ],
    };
  }
}

/** The complete read-only status read, GET-only within the executor's request budget. */
export async function readHostedIntake(): Promise<HostedStatusAll> {
  const { hostedStatusAll, readOnlyHostedBridge } = await import("./hosted-discovery-intake.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const { validateConfig } = await import("./roadmap.mts");
  const config = validateConfig(
    JSON.parse(readFileSync(new URL("../.github/roadmap.json", import.meta.url), "utf8")),
  );
  const deadline = performance.now() + 120_000;
  const bridge = await readOnlyHostedBridge(config, {
    credential: localDeveloperCredential({ deadline, command: process.env.PORTCOVE_ROADMAP_GH }),
    deadline,
  });
  return await hostedStatusAll(bridge);
}

const stored = (payload: unknown) => payload as HostedIntakeFact | null | undefined;

/**
 * Owner-actionable conditions, reusing the executor's classification: a blocked
 * request names its receipt blocker and reconciliation; `complete_with_holds`
 * carries the executor's owner `process` resume condition. Routine `partial`
 * continuation, `submitted` and withdrawn requests stay quiet.
 */
export function hostedIntakeAttention(payload: unknown) {
  const fact = stored(payload);
  if (!fact || fact.withdrawn) return [];
  const where = fact.receipt_comment
    ? `receipt comment ${fact.receipt_comment}`
    : `request comment ${fact.request_comment}`;
  if (fact.status === "blocked")
    return [
      `hosted intake blocked: ${fact.blocker?.code ?? "no recorded error"} (${where}${
        fact.reconciles ? `; reconciles request ${fact.reconciles}` : ""
      })`,
    ];
  if (fact.status === "complete_with_holds")
    return [
      ...new Set(
        fact.slots.flatMap((slot) =>
          slot.hold ? [`hosted intake held candidates (${where}): ${slot.hold.resume}`] : [],
        ),
      ),
    ];
  return [];
}

/** One line of request state: classification, counts and linked canonical issues. */
export function hostedIntakeSummary(payload: unknown) {
  const fact = stored(payload);
  if (!fact) return null;
  const linked = [
    ...new Set(fact.slots.flatMap((slot) => (slot.linked_issue ? [slot.linked_issue] : []))),
  ];
  return [
    `${fact.withdrawn ? "withdrawn; " : ""}${fact.status}`,
    `${fact.candidates} candidates: ${fact.delivered} delivered, ${fact.existing} existing, ${fact.held} held, ${fact.pending} pending`,
    fact.reconciles ? `reconciles request ${fact.reconciles}` : "",
    fact.superseded_by.length ? `superseded by ${fact.superseded_by.join(", ")}` : "",
    linked.length ? `issues ${linked.map((number) => `#${number}`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
