import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createGitHubClient, iterateGitHubPages } from "./github-client.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const api = `https://api.github.com/repos/${repository}`;
const admissionBranchPattern = "refs/heads/automation/catalog-admission-*";

export function checkCatalogAdmissionBranchFence(
  ruleset: unknown,
  applicable: unknown,
  id: number,
  reviewedAt: string,
) {
  const conditions =
    isRecord(ruleset) && isRecord(ruleset.conditions) && ruleset.conditions.ref_name;
  const isFence = (rule: unknown, type: string) =>
    isRecord(rule) &&
    rule.type === type &&
    (type !== "update" ||
      rule.parameters === undefined ||
      (isRecord(rule.parameters) && rule.parameters.update_allows_fetch_and_merge === false));
  if (
    !isRecord(ruleset) ||
    ruleset.id !== id ||
    ruleset.target !== "branch" ||
    ruleset.enforcement !== "active" ||
    ruleset.updated_at !== reviewedAt ||
    ruleset.source_type !== "Repository" ||
    ruleset.source !== repository ||
    (ruleset.bypass_actors !== undefined &&
      (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0)) ||
    !isRecord(conditions) ||
    !Array.isArray(conditions.include) ||
    conditions.include.length !== 1 ||
    conditions.include[0] !== admissionBranchPattern ||
    !Array.isArray(conditions.exclude) ||
    conditions.exclude.length !== 0 ||
    !Array.isArray(ruleset.rules) ||
    ruleset.rules.length !== 2 ||
    !Array.isArray(applicable)
  )
    throw new Error("The reviewed catalog admission branch ruleset differs.");
  for (const type of ["update", "deletion"])
    if (
      !ruleset.rules.some((rule: unknown) => isFence(rule, type)) ||
      !applicable.some(
        (rule: unknown) =>
          isRecord(rule) &&
          rule.ruleset_id === id &&
          rule.ruleset_source_type === "Repository" &&
          rule.ruleset_source === repository &&
          isFence(rule, type),
      )
    )
      throw new Error("The reviewed ruleset does not lock the exact catalog admission branch.");
}

export async function openCatalogAdmissionProposal({
  lookup,
  create,
  verify,
}: {
  lookup: () => Promise<unknown[]>;
  create: () => Promise<unknown>;
  verify: (rows: unknown[]) => string;
}) {
  const before = await lookup();
  if (before.length) return verify(before);
  let failure: unknown;
  try {
    await create();
  } catch (error) {
    failure = error;
  }
  const after = await lookup();
  if (!after.length && failure)
    throw new Error("App proposal creation failed without exact remote readback.", {
      cause: failure,
    });
  return verify(after);
}

export async function catalogAdmissionGitHub(
  mode: string | undefined,
  environment: NodeJS.ProcessEnv,
  fetch?: typeof globalThis.fetch,
) {
  const {
    DISCOVERY_RUN: run,
    DISCOVERY_ATTEMPT: attempt,
    EXPECTED_APP: app,
    APP_SLUG: minted,
    GH_TOKEN: token,
    COMMIT: commit,
    PROPOSAL: expectedProposal,
    ADMISSION_RULESET_ID: rulesetId,
    ADMISSION_RULESET_REVIEWED_AT: reviewedAt,
    GITHUB_REPOSITORY: actualRepository,
  } = environment;
  if (
    !run ||
    !/^[1-9]\d*$/u.test(run) ||
    !attempt ||
    !/^[1-9]\d*$/u.test(attempt) ||
    !app ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(app) ||
    !token ||
    actualRepository !== repository ||
    !["gate", "prior", "deliver", "review", "qualification", "branch-fence"].includes(mode ?? "") ||
    (mode !== "gate" && (!commit || !/^[a-f0-9]{40}$/u.test(commit))) ||
    ((mode === "prior" || mode === "deliver") && app !== minted) ||
    (mode === "branch-fence" &&
      (!rulesetId ||
        !/^[1-9]\d{0,14}$/u.test(rulesetId) ||
        !reviewedAt ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          reviewedAt,
        ) ||
        !Number.isFinite(Date.parse(reviewedAt))))
  )
    throw new Error("Catalog admission requires the exact workflow and App context.");
  const branch = `automation/catalog-admission-${run}-${attempt}`;
  const actor = `${app}[bot]`;
  const pullPath = `/repos/${repository}/pulls`;
  const artifactPath = `/repos/${repository}/actions/runs/${run}/artifacts`;
  const refPath = `/repos/${repository}/git/ref/heads/${branch}`;
  const rulesetPath = `/repos/${repository}/rulesets/${rulesetId}`;
  const rulePath = `/repos/${repository}/rules/branches/${encodeURIComponent(branch)}`;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline: performance.now() + 75_000,
    maxBytes: 4 * 1024 * 1024,
    ...(fetch ? { fetch } : {}),
    allowRequest: (method, url) =>
      (method === "POST" && mode === "deliver" && url.pathname === pullPath && !url.search) ||
      (method === "GET" &&
        (url.pathname === pullPath ||
          (mode === "gate" && url.pathname === artifactPath) ||
          (mode === "branch-fence" &&
            (url.pathname === rulesetPath || url.pathname === rulePath)) ||
          (mode === "deliver" && url.pathname === refPath))),
  });
  const get = async (url: string): Promise<unknown> =>
    (
      await client.request({
        method: "GET",
        url,
        request: { portcove: { replay: "safe-read", attempts: 0 } },
      })
    ).data;

  if (mode === "branch-fence") {
    const [ruleset, applicable] = await Promise.all([
      get(`https://api.github.com${rulesetPath}`),
      get(`https://api.github.com${rulePath}`),
    ]);
    checkCatalogAdmissionBranchFence(ruleset, applicable, Number(rulesetId), reviewedAt!);
    return "locked";
  }

  if (mode === "gate") {
    const artifact = `listing-admission-replay-${run}-${attempt}`;
    const response = await get(`${api}/actions/runs/${run}/artifacts?name=${artifact}`);
    if (!isRecord(response) || (response.total_count !== 0 && response.total_count !== 1))
      throw new Error("Expected at most one discovery replay receipt.");
    if (response.total_count === 0) return "No listing admission receipt for this attempt.";
    let pages = 0;
    for await (const { data } of iterateGitHubPages(client, {
      url: `${api}/pulls?state=open&base=main&per_page=100`,
      prepareRequest: async (page) => {
        if (++pages > 20) throw new Error("Open proposal inventory exceeds its page limit.");
        const url = new URL(page);
        const query = url.searchParams;
        const keys = [...query.keys()];
        if (
          url.origin !== "https://api.github.com" ||
          (url.pathname !== pullPath && url.pathname !== `/repositories/${repositoryId}/pulls`) ||
          new Set(keys).size !== keys.length ||
          keys.some((key) => !["state", "base", "per_page", "page"].includes(key)) ||
          query.get("state") !== "open" ||
          query.get("base") !== "main" ||
          query.get("per_page") !== "100" ||
          (query.has("page") && !/^[1-9]\d*$/u.test(query.get("page") ?? ""))
        )
          throw new Error("Open proposal pagination left its exact repository or scope.");
        url.pathname = pullPath;
        return url.href;
      },
    })) {
      if (!Array.isArray(data)) throw new Error("Expected an open pull request inventory.");
      if (
        data.some(
          (row: unknown) =>
            isRecord(row) &&
            isRecord(row.user) &&
            row.user.login === actor &&
            isRecord(row.head) &&
            typeof row.head.ref === "string" &&
            row.head.ref.startsWith("automation/catalog-admission-") &&
            row.head.ref !== branch &&
            isRecord(row.head.repo) &&
            row.head.repo.full_name === repository,
        )
      )
        return "An open catalog admission proposal is still in review.";
    }
    return "eligible";
  }

  const lookup = async () => {
    const data = await get(
      `${api}/pulls?state=all&base=main&head=${encodeURIComponent(`boburning:${branch}`)}&per_page=100`,
    );
    if (!Array.isArray(data)) throw new Error("Expected an exact proposal inventory.");
    return data as unknown[];
  };
  const verify = (rows: unknown[]) => {
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !isRecord(row) ||
      ((mode === "review" || mode === "qualification") &&
        row.state !== "open" &&
        row.state !== "closed") ||
      !isRecord(row.head) ||
      row.head.sha !== commit ||
      row.head.ref !== branch ||
      !isRecord(row.head.repo) ||
      row.head.repo.full_name !== repository ||
      !isRecord(row.base) ||
      row.base.ref !== "main" ||
      !isRecord(row.base.repo) ||
      row.base.repo.full_name !== repository ||
      !isRecord(row.user) ||
      row.user.login !== actor ||
      !Number.isSafeInteger(row.number) ||
      Number(row.number) < 1 ||
      row.html_url !== `https://github.com/${repository}/pull/${String(row.number)}`
    )
      throw new Error("Exact catalog admission proposal readback differs.");
    return mode === "review" && row.state === "closed" ? "" : row.html_url;
  };
  if (mode === "qualification") {
    const rows = await lookup();
    const proposal = verify(rows);
    const row = rows[0];
    if (proposal !== expectedProposal || !isRecord(row) || typeof row.draft !== "boolean")
      throw new Error("Catalog admission qualification proposal differs.");
    return row.state === "closed" ? "closed" : row.draft ? "draft" : "ready";
  }
  if (mode === "review") return verify(await lookup());
  if (mode === "prior") {
    const rows = await lookup();
    return rows.length ? verify(rows) : "";
  }

  const ref = await get(`${api}/git/ref/heads/${branch}`);
  if (
    !isRecord(ref) ||
    ref.ref !== `refs/heads/${branch}` ||
    !isRecord(ref.object) ||
    ref.object.sha !== commit
  )
    throw new Error("Catalog admission branch differs from the validated commit.");
  return openCatalogAdmissionProposal({
    lookup,
    verify,
    create: () =>
      client.request({
        method: "POST",
        url: `${api}/pulls`,
        head: branch,
        base: "main",
        title: `feat(catalog): admit scheduled discovery listings (${run}/${attempt})`,
        body: [
          "## Linked issue",
          "",
          "Refs #1422.",
          "",
          "## Outcome and scope",
          "",
          "Add eligible listings from scheduled discovery.",
          "",
          "## Verification",
          "",
          `Replayed [the scheduled discovery attempt](https://github.com/${repository}/actions/runs/${run}/attempts/${attempt}) through released Core and catalog generation.`,
          "",
          "## Review and risk",
          "",
          "The batch adds descriptive listings and their derived counts. Independent review and required CI are pending.",
        ].join("\n"),
        draft: true,
        request: { portcove: { replay: "once", attempts: 0 } },
      }),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(await catalogAdmissionGitHub(process.argv[2], process.env));
