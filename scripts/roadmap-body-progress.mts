import { createHash } from "node:crypto";
import { readSetManyInput, writeRoadmapJournal } from "./roadmap-batch-progress.mts";
import { errorCode, isRecord } from "./runtime-values.mts";
export const bodyOperationHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface RoadmapBodyProgress {
  format: 1;
  resumption?: { binding: string; checked: number[] };
  graphql_cost?: number;
  authority: "roadmap-issue-body-operation";
  input_sha256: string;
  identities: number[];
  verified: number[];
  uncertain: number[];
  checked: number[];
  doctors: number[];
  phase: "preflight" | "mutate" | "verify" | "doctor" | "completed";
  started_at: string;
  updated_at: string;
}
export class RoadmapBodyJournal {
  state: RoadmapBodyProgress;
  readonly file: string | null;
  readonly identity: string;
  constructor(file: string | null, identity: string, count: number) {
    this.file = file;
    this.identity = identity;
    this.state = {
      format: 1,
      authority: "roadmap-issue-body-operation",
      input_sha256: identity,
      identities: [],
      verified: [],
      uncertain: [],
      checked: [],
      doctors: [],
      phase: "preflight",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (file)
      try {
        const raw: unknown = JSON.parse(readSetManyInput(file, 32 * 1024 * 1024).toString("utf8"));
        if (
          !isRecord(raw) ||
          raw.format !== 1 ||
          raw.authority !== this.state.authority ||
          raw.input_sha256 !== identity ||
          !["preflight", "mutate", "verify", "doctor", "completed"].includes(String(raw.phase)) ||
          typeof raw.started_at !== "string" ||
          !Number.isFinite(Date.parse(raw.started_at)) ||
          typeof raw.updated_at !== "string" ||
          !Number.isFinite(Date.parse(raw.updated_at)) ||
          Date.parse(raw.started_at) > Date.parse(raw.updated_at) ||
          Date.parse(raw.updated_at) > Date.now()
        )
          throw new Error(
            "Body operation journal binding or shape changed; preserve and reconcile",
          );
        for (const field of [
          "identities",
          "verified",
          "uncertain",
          "checked",
          "doctors",
        ] as const) {
          const rows = raw[field];
          if (
            !Array.isArray(rows) ||
            rows.length > count ||
            rows.some(
              (n: unknown) =>
                !Number.isSafeInteger(n) ||
                Number(n) < (field === "identities" ? 1 : 0) ||
                (field !== "identities" && Number(n) >= count),
            ) ||
            new Set(rows).size !== rows.length
          )
            throw new Error("Body operation journal positions are corrupt");
        }
        const state = raw as unknown as RoadmapBodyProgress;
        if (
          state.verified.some((i) => state.uncertain.includes(i)) ||
          [...state.verified, ...state.uncertain, ...state.checked, ...state.doctors].some(
            (i) => i >= state.identities.length,
          ) ||
          (state.phase !== "preflight" && state.identities.length !== count)
        )
          throw new Error("Body operation journal phase is incomplete");
        if (
          state.checked.some((i) => !state.verified.includes(i)) ||
          state.doctors.some((i) => !state.checked.includes(i)) ||
          (state.phase === "completed" &&
            (state.verified.length !== count ||
              state.uncertain.length ||
              state.checked.length !== count ||
              state.doctors.length !== count))
        )
          throw new Error("Body operation journal claims incomplete completion");
        if (
          state.graphql_cost !== undefined &&
          (!Number.isSafeInteger(state.graphql_cost) || state.graphql_cost < 1)
        )
          throw new Error("Body operation cost evidence is invalid");
        if (
          state.resumption !== undefined &&
          (!isRecord(state.resumption) ||
            typeof state.resumption.binding !== "string" ||
            !Array.isArray(state.resumption.checked) ||
            state.resumption.checked.some(
              (i) => !Number.isSafeInteger(i) || !state.verified.includes(i),
            ) ||
            new Set(state.resumption.checked).size !== state.resumption.checked.length)
        )
          throw new Error("Body resumption read positions are invalid");
        this.state = state;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
  }
  save() {
    this.state.updated_at = new Date().toISOString();
    if (this.file) writeRoadmapJournal(this.file, this.state);
  }
}
