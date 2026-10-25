/** Scheduling observations only. Success here never admits signed inputs or a
 * native result; the original post-sign producer independently authenticates both. */
import assert from "node:assert/strict";
import { isRecord } from "./runtime-values.mts";

const requiredNames = [
  "Sign admitted updater payloads",
  "Sign authenticated Timestamp metadata",
] as const;

export function inspectNativePostSignReadiness(raw: unknown, run: string, revision: string) {
  assert.match(run, /^[1-9][0-9]{0,15}$/u);
  assert.match(revision, /^[a-f0-9]{40}$/u);
  assert.ok(isRecord(raw) && Array.isArray(raw.jobs));
  const jobs: unknown[] = raw.jobs;
  assert.ok(Number.isSafeInteger(raw.total_count) && Number(raw.total_count) > 0);
  assert.ok(Number(raw.total_count) <= 100 && jobs.length === raw.total_count);
  const ids = new Set<number>();
  for (const job of jobs) {
    assert.ok(isRecord(job) && Number.isSafeInteger(job.id) && Number(job.id) > 0);
    assert.ok(!ids.has(Number(job.id)), "duplicate native prerequisite job identity");
    ids.add(Number(job.id));
  }
  return requiredNames.map((name) => {
    const matches = jobs.filter((job) => isRecord(job) && job.name === name);
    assert.ok(matches.length <= 1, "ambiguous native prerequisite job");
    if (!matches.length) return { name, status: "not-yet-observed" };
    const job = matches[0];
    assert.ok(isRecord(job));
    assert.ok(typeof job.run_id === "number" && Number.isSafeInteger(job.run_id));
    assert.equal(String(job.run_id), run);
    assert.equal(job.head_sha, revision);
    assert.equal(typeof job.status, "string");
    assert.ok(
      ["queued", "in_progress", "completed", "waiting", "pending"].includes(job.status as string),
    );
    if (job.status === "completed")
      assert.equal(
        job.conclusion,
        "success",
        "native prerequisite refused; preserve effects and recover",
      );
    else assert.equal(job.conclusion, null);
    return { name, status: job.status as string, job_id: Number(job.id) };
  });
}

/** Only a valid pending GET can be observed again. Transport errors, malformed
 * inventories and terminal refusals escape immediately; no effect is retried. */
export async function waitForNativePostSignReadiness(input: {
  run: string;
  revision: string;
  active: () => void;
  read: () => unknown;
  retain: (observation: unknown) => Promise<void>;
  pause: () => Promise<void>;
}) {
  for (let observation = 0; observation < 120; observation++) {
    input.active();
    const raw = input.read();
    input.active();
    const jobs = inspectNativePostSignReadiness(raw, input.run, input.revision);
    await input.retain({ observation, jobs, authority: "none" });
    input.active();
    if (jobs.every((job) => job.status === "completed"))
      return { prerequisites_observed: true, authority: "none" } as const;
    await input.pause();
    input.active();
  }
  throw new Error("native prerequisite observation bound exhausted; retain and recover");
}
