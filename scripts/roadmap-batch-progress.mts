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
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const read = readSync(descriptor, bytes, length, maximum + 1 - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(descriptor);
    if (
      length > maximum ||
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
interface Transition {
  itemId: string;
  fieldName: string;
  from: string | null;
  to: string;
  observed: unknown;
  mutation_identity?: { project_id: string; field_id: string; option_id: string };
}
export interface SetManyProgress {
  phase: "plan" | "attempted" | "readback" | "completed";
  assignments: readonly Transition[];
  changes: readonly Transition[];
}
interface Journal {
  format: 1;
  input_sha256: string;
  configuration_sha256: string;
  bindings_sha256: string;
  verified: string[];
  uncertain: string[];
  sequence: number;
  phase: SetManyProgress["phase"];
}
const key = (change: Pick<Transition, "itemId" | "fieldName">) =>
  JSON.stringify([change.itemId, change.fieldName]);
export class SetManyJournal {
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
        !["plan", "attempted", "readback", "completed"].includes(String(value.phase)) ||
        !Array.isArray(value.verified) ||
        !value.verified.every((entry) => typeof entry === "string") ||
        !Array.isArray(value.uncertain) ||
        !value.uncertain.every((entry) => typeof entry === "string")
      )
        throw new Error("set-many journal identity or content differs; preserve and reconcile");
      this.journal = value as unknown as Journal;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
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
    if (previous && previous.bindings_sha256 !== bindingsHash)
      throw new Error(
        "set-many resolved Project item/field identities changed; preserve and reconcile",
      );
    const desired = new Set(
      progress.assignments.filter((change) => change.observed === change.to).map(key),
    );
    if (progress.phase === "plan" && previous) {
      if (previous.verified.some((id) => !desired.has(id)))
        throw new Error("set-many previously verified state changed concurrently; no overwrite");
      if (previous.uncertain.some((id) => !desired.has(id)))
        throw new Error("set-many ambiguous writes remain unresolved; no automatic retry");
    }
    const verified = new Set(previous?.verified ?? []);
    const uncertain = new Set(previous?.uncertain ?? []);
    if (progress.phase === "plan") {
      for (const id of desired) {
        verified.add(id);
        uncertain.delete(id);
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
    };
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > maximumJournalBytes)
      throw new Error("set-many journal storage envelope exhausted; retain prior receipt");
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.next`;
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, this.file);
    this.journal = next;
  }
}
export function setManyJournalName(inputFile: string) {
  return `${digest(path.resolve(inputFile))}.json`;
}
