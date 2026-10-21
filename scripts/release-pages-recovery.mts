import { mkdtemp, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { inspectCapacityOperation, capacityDigest } from "./release-capacity.mts";
import { createPagesProviderTransport } from "./release-pages-provider.mts";
import {
  materializePublishedCompleteSite,
  requirePublishedCompleteSite,
} from "./release-site-readback.mts";
import { recoverOwnedCapacityEffect } from "./release-capacity-executor.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";

/** Inert intent inspection; a parser never establishes a provider result. */
export function inspectPendingPagesReadback(raw: unknown) {
  const operation = inspectCapacityOperation(raw);
  if (
    !operation ||
    !operation.site_expectation ||
    operation.executor_identity?.role !== "site-publication" ||
    !["pending", "ambiguous", "capacity-refused"].includes(operation.outcome) ||
    operation.receipt_limit !== 1 ||
    operation.completed_effects.length > 1
  )
    throw new Error("exact unresolved single-effect Pages intent required");
  const expected = operation.site_expectation;
  const remoteIdentity = `github-pages:boburning/portcove:${expected.site_generation_sha256}`;
  if (operation.completed_effects.some((effect) => effect.remote_identity !== remoteIdentity))
    throw new Error("retained Pages effect differs from durable generation");
  return { operation, expected, remote_identity: remoteIdentity };
}

/** GET-only observation shared by the actual coordinator and inert transport
 * tests. The returned JSON has no authenticated-source or journal authority. */
export async function readPendingPagesPublication(
  directory: string,
  raw: unknown,
  phaseDeadline: number,
  options: {
    provider?: ReturnType<typeof createPagesProviderTransport>;
    readPublic?: (
      expected: ReturnType<typeof inspectPendingPagesReadback>["expected"],
    ) => Promise<unknown>;
  } = {},
) {
  if (!Number.isFinite(phaseDeadline) || performance.now() >= phaseDeadline)
    throw new Error("Pages recovery deadline exhausted before observation");
  const { operation, expected, remote_identity } = inspectPendingPagesReadback(raw);
  const check = () => {
    if (!Number.isFinite(phaseDeadline) || performance.now() >= phaseDeadline)
      throw new Error("Pages recovery deadline exhausted; retain unresolved intent");
  };
  check();
  const provider = options.provider ?? createPagesProviderTransport(directory, {}, phaseDeadline);
  const identity = {
    artifact_id: expected.artifact_id,
    generation: expected.site_generation_sha256,
    controller_revision: operation.executor_identity!.controller_revision,
  };
  const before = provider.observeByGeneration(identity);
  if (before.status !== "succeed")
    throw new Error("Pages provider completion unavailable; no no-effect inference or retry");
  check();
  const publicReadback = options.readPublic
    ? await options.readPublic(structuredClone(expected))
    : (
        await materializePublishedCompleteSite(
          {
            site_generation_sha256: expected.site_generation_sha256,
            root_sha256: expected.root_sha256,
            repository_sha256: expected.repository_sha256,
          },
          directory,
          phaseDeadline,
        )
      ).receipt;
  let publicProjection: unknown = publicReadback;
  if (!options.readPublic) {
    const verified = await requirePublishedCompleteSite(publicReadback);
    publicProjection = { generation: verified.generation, pins: verified.pins };
  }
  check();
  const after = provider.observeByGeneration(identity);
  if (after.status !== "succeed")
    throw new Error("Pages provider status changed around complete public readback");
  check();
  const evidence = {
    operation_id: operation.id,
    expected,
    provider_before: before,
    provider_after: after,
    public_readback: publicProjection,
    evidence_scope: options.provider || options.readPublic ? "injected-provider" : "github.com",
    authority: "none",
    provider_mutations: 0,
  };
  const evidenceSha = capacityDigest(evidence);
  return {
    evidence,
    complete_site: publicReadback,
    resolution: {
      resolution: "effect-completed" as const,
      evidence_sha256: evidenceSha,
      ...(operation.completed_effects.length === 0
        ? {
            completed_effect: { remote_identity, evidence_sha256: evidenceSha },
          }
        : {}),
    },
  };
}

/** Separate actual coordinator, original publisher observed terminal before
 * and after the callback, exact remote ownership and existing journal recovery.
 * No Pages POST exists on this continuation. Tough/current eligibility and the
 * later published_metadata handoff remain independently required. */
export async function recoverPendingPagesPublication(
  executor: Parameters<typeof recoverOwnedCapacityEffect>[0],
  raw: Parameters<typeof recoverOwnedCapacityEffect>[1],
  privateParent: string,
  phaseDeadline: number,
) {
  if (!Number.isFinite(phaseDeadline) || performance.now() >= phaseDeadline)
    throw new Error("Pages recovery deadline exhausted before observation");
  if (!path.isAbsolute(privateParent))
    throw new Error("absolute private Pages recovery parent required");
  const parent = await lstat(privateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(privateParent)) !== path.resolve(privateParent)
  )
    throw new Error("private Pages recovery parent is linked or unavailable");
  await assertOwnedUnlinkedPath(
    path.dirname(privateParent),
    privateParent,
    "Pages recovery parent",
  );
  const directory = await mkdtemp(path.join(privateParent, "pages-pending-readback-"));
  let observation: Awaited<ReturnType<typeof readPendingPagesPublication>> | undefined;
  try {
    const settled = await withCoordinatorDeadline(phaseDeadline, () =>
      recoverOwnedCapacityEffect(executor, raw, async (operation) => {
        observation = await readPendingPagesPublication(directory, operation, phaseDeadline);
        await writeFile(
          path.join(directory, "readback.json"),
          JSON.stringify(observation.evidence),
          {
            flag: "wx",
            mode: 0o600,
          },
        );
        return observation.resolution;
      }),
    );
    if (!observation) throw new Error("actual Pages readback was not completed");
    await requirePublishedCompleteSite(observation.complete_site);
    if (performance.now() >= phaseDeadline)
      throw new Error("Pages recovery settlement exceeded deadline; reread journal");
    await writeFile(path.join(directory, "settled.json"), JSON.stringify(settled), {
      flag: "wx",
      mode: 0o600,
    });
    return {
      directory,
      settled,
      complete_site: observation.complete_site,
      authority: "none" as const,
    };
  } catch (error) {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        outcome: "unresolved-or-settlement-ambiguous",
        provider_mutations: 0,
        automatic_retry: false,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`Pages pending recovery stopped; retain ${directory}`, { cause: error });
  }
}
