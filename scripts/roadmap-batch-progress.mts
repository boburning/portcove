import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { errorCode, isRecord } from "./runtime-values.mts";

// Physical input/receipt bounds, independent of logical assignment count.
export const maximumSetManyInputBytes = 8 * 1024 * 1024;
const maximumJournalBytes = 32 * 1024 * 1024;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function readSetManyInput(file: string, maximum = maximumSetManyInputBytes) {
  const leaf = lstatSync(file);
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size > maximum)
    throw new Error("set-many input must be a bounded regular file");
  const descriptor = openSync(file, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== leaf.dev || before.ino !== leaf.ino)
      throw new Error("set-many input identity changed while opening");
    const bytes = Buffer.alloc(Math.min(maximum, before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(descriptor);
    if (
      length > maximum ||
      length > before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("set-many input exceeded its bound or changed while reading");
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}
export interface Transition {
  target: string;
  itemId: string;
  fieldName: string;
  from: string | null;
  to: string;
  observed: unknown;
  mutation_identity?: { project_id: string; field_id: string; option_id: string };
  target_identity?: { content_id: string; kind: string };
}
export interface SetManyProgress {
  phase: "plan" | "attempted" | "readback" | "completed";
  assignments: readonly Transition[];
  changes: readonly Transition[];
}
interface Planning {
  next_update: number;
  total_updates: number;
  context: unknown;
  assignments: Transition[];
  sha256: string;
  started_at: string;
  updated_at: string;
  read_cost_per_update?: number | undefined;
}
interface FinalVerification {
  checked: Record<string, string>;
  assignments_sha256: string;
  started_at: string;
}

interface Journal {
  format: 1;
  input_sha256: string;
  configuration_sha256: string;
  bindings_sha256: string;
  verified: string[];
  uncertain: string[];
  sequence: number;
  phase: SetManyProgress["phase"] | "preflight" | "preview-completed";
  planning?: Planning;
  final_verification?: FinalVerification;
  resumption_verification?: FinalVerification;
  doctor_pending?: boolean;
}
const key = (change: Pick<Transition, "itemId" | "fieldName">) =>
  JSON.stringify([change.itemId, change.fieldName]);
/** Shared bounded atomic publication for local Roadmap operation journals. */
export function writeRoadmapJournal(file: string, value: unknown) {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > maximumJournalBytes)
    throw new Error("Roadmap journal storage envelope exhausted; retain prior receipt");
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.next`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, file);
}
export class SetManyJournal {
  private readonly openedAt = new Date().toISOString();
  readonly inputHash: string;
  readonly configurationHash: string;
  journal?: Journal;
  readonly file: string;
  readonly inputFile: string;
  constructor(file: string, inputFile: string, input: Uint8Array, configuration: unknown) {
    this.file = file;
    this.inputFile = inputFile;
    this.inputHash = digest(input);
    this.configurationHash = digest(JSON.stringify(configuration));
    try {
      const value: unknown = JSON.parse(
        readSetManyInput(file, maximumJournalBytes).toString("utf8"),
      );
      if (
        !isRecord(value) ||
        value.format !== 1 ||
        value.input_sha256 !== this.inputHash ||
        value.configuration_sha256 !== this.configurationHash ||
        typeof value.bindings_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.bindings_sha256) ||
        !Number.isSafeInteger(value.sequence) ||
        Number(value.sequence) < 0 ||
        !["preflight", "plan", "attempted", "readback", "completed", "preview-completed"].includes(
          String(value.phase),
        ) ||
        !Array.isArray(value.verified) ||
        !value.verified.every((entry) => typeof entry === "string") ||
        !Array.isArray(value.uncertain) ||
        !value.uncertain.every((entry) => typeof entry === "string")
      )
        throw new Error("set-many journal identity or content differs; preserve and reconcile");
      if (value.planning !== undefined) {
        const planning = value.planning;
        if (
          !isRecord(planning) ||
          !Number.isSafeInteger(planning.next_update) ||
          Number(planning.next_update) < 0 ||
          !Number.isSafeInteger(planning.total_updates) ||
          Number(planning.total_updates) < Number(planning.next_update) ||
          !Array.isArray(planning.assignments) ||
          typeof planning.started_at !== "string" ||
          typeof planning.updated_at !== "string" ||
          !Number.isFinite(Date.parse(planning.started_at)) ||
          !Number.isFinite(Date.parse(planning.updated_at)) ||
          Date.parse(planning.started_at) > Date.parse(planning.updated_at) ||
          (planning.read_cost_per_update !== undefined &&
            (!Number.isSafeInteger(planning.read_cost_per_update) ||
              Number(planning.read_cost_per_update) < 1)) ||
          planning.sha256 !==
            digest(
              JSON.stringify({
                next_update: planning.next_update,
                total_updates: planning.total_updates,
                context: planning.context,
                assignments: planning.assignments,
                started_at: planning.started_at,
                updated_at: planning.updated_at,
                read_cost_per_update: planning.read_cost_per_update,
              }),
            ) ||
          planning.assignments.some(
            (change) =>
              !isRecord(change) ||
              typeof change.target !== "string" ||
              typeof change.itemId !== "string" ||
              typeof change.fieldName !== "string" ||
              typeof change.to !== "string" ||
              !(change.from === null || typeof change.from === "string") ||
              (change.observed !== change.from && change.observed !== change.to),
          )
        )
          throw new Error("set-many planning checkpoint is corrupt or incomplete");
      }
      if (value.doctor_pending !== undefined && typeof value.doctor_pending !== "boolean")
        throw new Error("set-many doctor continuation is corrupt");
      for (const final of [value.final_verification, value.resumption_verification]) {
        if (final === undefined) continue;
        if (
          !isRecord(final) ||
          !isRecord(final.checked) ||
          Object.values(final.checked).some(
            (clock) =>
              typeof clock !== "string" ||
              !Number.isFinite(Date.parse(clock)) ||
              typeof final.started_at !== "string" ||
              Date.parse(clock) < Date.parse(final.started_at) ||
              Date.parse(clock) > Date.now(),
          ) ||
          typeof final.assignments_sha256 !== "string" ||
          typeof final.started_at !== "string" ||
          !Number.isFinite(Date.parse(final.started_at)) ||
          Date.parse(final.started_at) > Date.now()
        )
          throw new Error("set-many verification checkpoint is corrupt");
      }
      this.journal = value as unknown as Journal;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  private save(next: Journal) {
    if (digest(readSetManyInput(this.inputFile)) !== this.inputHash)
      throw new Error("set-many specification changed during continuation; no further mutation");
    writeRoadmapJournal(this.file, next);
    this.journal = next;
  }
  beginPreview() {
    if (!this.journal) return;
    if (
      this.journal.verified.length ||
      this.journal.uncertain.length ||
      !["preflight", "preview-completed"].includes(this.journal.phase)
    )
      throw new Error("Read-only preview cannot replace an applied operation journal");
    if (this.journal.phase !== "preview-completed") return;
    this.save({
      format: 1,
      input_sha256: this.inputHash,
      configuration_sha256: this.configurationHash,
      bindings_sha256: digest(JSON.stringify([])),
      verified: [],
      uncertain: [],
      phase: "preflight",
      sequence: this.journal.sequence + 1,
    });
  }
  markPreviewCompleted() {
    if (!this.journal || this.journal.verified.length || this.journal.uncertain.length)
      throw new Error("Read-only preview has mutation state");
    this.save({ ...this.journal, sequence: this.journal.sequence + 1, phase: "preview-completed" });
  }
  stagePlanning(
    nextUpdate: number,
    totalUpdates: number,
    context: unknown,
    assignments: Transition[],
    readCostPerUpdate?: number,
  ) {
    const snapshot = {
      next_update: nextUpdate,
      total_updates: totalUpdates,
      context,
      assignments,
      started_at: this.journal?.planning?.started_at ?? this.openedAt,
      updated_at: new Date().toISOString(),
      read_cost_per_update: readCostPerUpdate,
    };
    const previous = this.journal;
    const next: Journal = {
      format: 1,
      input_sha256: this.inputHash,
      configuration_sha256: this.configurationHash,
      bindings_sha256: previous?.bindings_sha256 ?? digest(JSON.stringify([])),
      verified: previous?.verified ?? [],
      uncertain: previous?.uncertain ?? [],
      phase: previous?.phase ?? "preflight",
      sequence: (previous?.sequence ?? 0) + 1,
      planning: { ...structuredClone(snapshot), sha256: digest(JSON.stringify(snapshot)) },
      ...(previous?.resumption_verification
        ? { resumption_verification: previous.resumption_verification }
        : {}),
      ...(previous?.final_verification ? { final_verification: previous.final_verification } : {}),
    };
    this.save(next);
  }
  get planning() {
    return this.journal?.planning;
  }
  assertChunk(changes: readonly Transition[]) {
    const observed = new Map(changes.map((change) => [key(change), change]));
    for (const id of [...(this.journal?.verified ?? []), ...(this.journal?.uncertain ?? [])]) {
      const current = observed.get(id);
      if (current && current.observed !== current.to)
        throw new Error(
          "set-many verified reversal or ambiguous write remains unresolved; no automatic overwrite or retry",
        );
    }
  }
  resumptionReads(assignments: readonly Transition[]) {
    const fingerprint = digest(
      JSON.stringify(assignments.map(({ itemId, fieldName, to }) => ({ itemId, fieldName, to }))),
    );
    const prior = this.journal?.resumption_verification;
    return prior?.assignments_sha256 === fingerprint ? { ...prior.checked } : {};
  }
  stageResumptionReads(checked: Record<string, string>, assignments: readonly Transition[]) {
    if (!this.journal) throw new Error("set-many resumption has no planning receipt");
    const fingerprint = digest(
      JSON.stringify(assignments.map(({ itemId, fieldName, to }) => ({ itemId, fieldName, to }))),
    );
    this.save({
      ...this.journal,
      sequence: this.journal.sequence + 1,
      resumption_verification: {
        checked: { ...checked },
        assignments_sha256: fingerprint,
        started_at:
          this.journal.resumption_verification?.assignments_sha256 === fingerprint
            ? this.journal.resumption_verification.started_at
            : new Date().toISOString(),
      },
    });
  }
  verificationReads(assignments: readonly Transition[]) {
    const fingerprint = digest(
      JSON.stringify(assignments.map(({ itemId, fieldName, to }) => ({ itemId, fieldName, to }))),
    );
    const prior = this.journal?.final_verification;
    if (prior && prior.assignments_sha256 !== fingerprint)
      throw new Error("set-many final verification scope changed");
    const keys = new Set(assignments.map(key));
    if (prior && Object.keys(prior.checked).some((id) => !keys.has(id)))
      throw new Error("set-many final verification contains foreign assignments");
    return { ...prior?.checked };
  }
  stageVerification(
    checked: Record<string, string>,
    assignments: readonly Transition[],
    reset = false,
  ) {
    if (!this.journal) throw new Error("set-many final verification has no planning receipt");
    this.save({
      ...this.journal,
      sequence: this.journal.sequence + 1,
      doctor_pending: false,
      final_verification: {
        checked: { ...checked },
        started_at: reset
          ? new Date().toISOString()
          : (this.journal.final_verification?.started_at ?? new Date().toISOString()),
        assignments_sha256: digest(
          JSON.stringify(
            assignments.map(({ itemId, fieldName, to }) => ({ itemId, fieldName, to })),
          ),
        ),
      },
    });
  }
  markDoctorPending() {
    if (!this.journal) throw new Error("set-many doctor has no verification receipt");
    this.save({ ...this.journal, sequence: this.journal.sequence + 1, doctor_pending: true });
  }
  get hasFinalVerification() {
    return this.journal?.final_verification !== undefined;
  }
  observe(progress: SetManyProgress) {
    if (digest(readSetManyInput(this.inputFile)) !== this.inputHash)
      throw new Error("set-many specification changed during continuation; no further mutation");
    const bindingsHash = digest(
      JSON.stringify(
        progress.assignments
          .map(({ itemId, fieldName, from, to, mutation_identity }) => ({
            itemId,
            fieldName,
            from,
            to,
            mutation_identity: mutation_identity ?? null,
          }))
          .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
      ),
    );
    const previous = this.journal;
    if (previous && previous.phase !== "preflight" && previous.bindings_sha256 !== bindingsHash)
      throw new Error(
        "set-many resolved Project item/field identities changed; preserve and reconcile",
      );
    const assignmentKeys = new Set(progress.assignments.map(key));
    if (
      previous &&
      [...previous.verified, ...previous.uncertain].some((id) => !assignmentKeys.has(id))
    )
      throw new Error("set-many journal contains foreign verified or uncertain assignments");
    const desired = new Set(
      progress.assignments.filter((change) => change.observed === change.to).map(key),
    );
    if (progress.phase === "plan" && previous && !previous.planning) {
      if (previous.verified.some((id) => !desired.has(id)))
        throw new Error("set-many previously verified state changed concurrently; no overwrite");
      if (previous.uncertain.some((id) => !desired.has(id)))
        throw new Error("set-many ambiguous writes remain unresolved; no automatic retry");
    }
    const verified = new Set(previous?.verified ?? []);
    const uncertain = new Set(previous?.uncertain ?? []);
    if (progress.phase === "plan") {
      for (const id of desired) {
        if (!previous?.planning || !uncertain.has(id)) verified.add(id);
        if (!previous?.planning) uncertain.delete(id);
      }
    }
    for (const change of progress.changes) {
      const id = key(change);
      if (progress.phase === "attempted") uncertain.add(id);
      if (progress.phase === "readback" && change.observed === change.to) {
        verified.add(id);
        uncertain.delete(id);
      }
    }
    const next: Journal = {
      format: 1,
      input_sha256: this.inputHash,
      configuration_sha256: this.configurationHash,
      bindings_sha256: bindingsHash,
      verified: [...verified],
      uncertain: [...uncertain],
      sequence: (previous?.sequence ?? 0) + 1,
      phase: progress.phase,
      doctor_pending: progress.phase === "completed" ? false : (previous?.doctor_pending ?? false),
      ...(previous?.planning ? { planning: previous.planning } : {}),
      ...(previous?.resumption_verification
        ? { resumption_verification: previous.resumption_verification }
        : {}),
      ...(previous?.final_verification ? { final_verification: previous.final_verification } : {}),
    };
    this.save(next);
  }
}
export function setManyJournalName(inputFile: string) {
  return `${digest(path.resolve(inputFile))}.json`;
}

export function setManyPreviewJournalName(
  inputFile: string,
  input: Uint8Array,
  configuration: unknown,
) {
  return `${digest(`${path.resolve(inputFile)}\0preview\0${digest(input)}\0${JSON.stringify(configuration)}`)}.json`;
}
