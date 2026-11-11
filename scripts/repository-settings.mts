import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { GitHubApiError } from "./github-operation.mts";
import {
  validateRepositorySettings,
  reconcileRepositorySettings,
  planReleaseRulesets,
} from "./repository-settings-policy.mts";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const rulesetPath = path.join(projectRoot, ".github", "repository-ruleset.json");
const securityPath = path.join(projectRoot, ".github", "repository-security.json");
const record = (value: unknown) => {
  if (!isRecord(value)) throw new Error("Repository settings must be an object");
  return value;
};

async function loadDesired() {
  const [ruleset, security] = await Promise.all([
    readFile(rulesetPath, "utf8").then((text): unknown => JSON.parse(text)),
    readFile(securityPath, "utf8").then((text): unknown => JSON.parse(text)),
  ]);
  validateRepositorySettings(ruleset, security);
  return { ruleset: record(ruleset), security: record(security) };
}

async function main(argv: readonly string[]) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(`Usage: node scripts/repository-settings.mts [--validate|--plan|--check|--apply|--help]

Validate the checked-in repository protection and security contract, or compare it
with GitHub. Live operations use the configured SDK and an approved credential.
Eligible local tooling can resolve an existing GitHub CLI login.

Options (choose one):
  --validate  Validate local artifacts only; this is the default.
  --plan      Read live settings and print the supported changes as JSON.
  --check     Read live settings and fail if they differ from the checked-in contract.
  --apply     Apply only the supported migration, then read back the live settings.
  --plan-release-rulesets   Inspect the stable release policy and next migration stage.
  --check-release-rulesets  Verify the permanent release policy is in effect.
  --apply-release-rulesets <observation>  Apply one reviewed stage at a settled boundary.
  --help      Show this help without reading configuration or contacting GitHub.

Applying protection or security changes requires explicit owner authorization.
Run the release ruleset migration from its owning release operation.

Example:
  node scripts/repository-settings.mts --validate`);
    return;
  }
  const mode = argv[0] ?? "--validate";
  const releasePlan = mode === "--plan-release-rulesets";
  const releaseCheck = mode === "--check-release-rulesets";
  const releaseApply = mode === "--apply-release-rulesets";
  if (
    releaseApply
      ? argv.length !== 2 || !/^[a-f0-9]{64}$/u.test(argv[1]!)
      : argv.length > 1 ||
        (!releasePlan &&
          !releaseCheck &&
          mode !== "--validate" &&
          mode !== "--plan" &&
          mode !== "--check" &&
          mode !== "--apply")
  ) {
    throw new Error("Usage: node scripts/repository-settings.mts [option]. Run with --help.");
  }
  const { ruleset, security } = await loadDesired();
  if (mode === "--validate") {
    console.log("Repository settings artifacts are valid.");
    return;
  }
  const repo = security.repository;
  if (typeof repo !== "string") throw new Error("Invalid configured repository");
  const { createGitHubClient, iterateGitHubPages } = await import("./github-client.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const deadline = performance.now() + 120000;
  const prefix = `/repos/${repo}`;
  const headers = { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  let received = 0;
  const rulesetPath = `${prefix}/rulesets`;
  const isRulesetDetail = (pathname: string) =>
    pathname.startsWith(`${rulesetPath}/`) &&
    /^[1-9][0-9]*$/u.test(pathname.slice(rulesetPath.length + 1));
  const releaseWorkflows = [
    "application-update-production.yml",
    "application-update-wake.yml",
    "application-release.yml",
  ];
  const pauseRef = "/git/ref/heads/portcove-release-pause";
  const pauseDocument = "/contents/publication.json";
  const activeReleaseVariables = new Set([
    "PORTCOVE_APPLICATION_RELEASE_ACTIVE",
    "PORTCOVE_CONTROLLER_ADMISSION",
    "PORTCOVE_CONTROLLER_WAKE",
    "PORTCOVE_CATALOG_CONTROLLER_ADMISSION",
    "PORTCOVE_CATALOG_CONTROLLER_WAKE",
  ]);
  const sdk = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    reserve: () => ({
      consumeBytes(bytes) {
        received += bytes;
        if (received > 16 * 1024 * 1024)
          throw new GitHubApiError(
            "budget_exhausted",
            "Repository settings exceeded its metadata budget",
          );
      },
      settle() {},
    }),
    allowRequest(method, url) {
      if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) return false;
      const suffix = url.pathname.slice(prefix.length);
      if (method === "GET")
        return (
          url.pathname === prefix ||
          url.pathname === rulesetPath ||
          isRulesetDetail(url.pathname) ||
          url.pathname === `${prefix}/private-vulnerability-reporting` ||
          (releaseApply &&
            (suffix === pauseRef ||
              suffix === pauseDocument ||
              suffix === "/actions/variables" ||
              releaseWorkflows.some((name) => suffix === `/actions/workflows/${name}/runs`) ||
              /^\/rules\/branches\/portcove-[a-z-]+$/u.test(suffix)))
        );
      if (releaseApply)
        return (
          (method === "POST" && url.pathname === rulesetPath) ||
          ((method === "PUT" || method === "DELETE") && isRulesetDetail(url.pathname))
        );
      return (
        (method === "PATCH" && url.pathname === prefix) ||
        (method === "PUT" &&
          (url.pathname === `${prefix}/private-vulnerability-reporting` ||
            isRulesetDetail(url.pathname)))
      );
    },
  });
  const request = async (
    method: "GET" | "PUT" | "PATCH" | "POST" | "DELETE",
    suffix: string,
    data?: unknown,
  ) =>
    (
      await sdk.request({
        method,
        url: `https://api.github.com${prefix}${suffix}`,
        headers,
        ...(data === undefined ? {} : { data }),
        request: { portcove: { replay: method === "GET" ? "safe-read" : "once", attempts: 0 } },
      })
    ).data as unknown;
  const readRulesets = async () => {
    const rows: unknown[] = [];
    for await (const page of iterateGitHubPages(sdk, {
      url: `https://api.github.com${rulesetPath}?includes_parents=true&per_page=100`,
      headers,
      deadline,
    })) {
      if (new URL(page.url).pathname !== `${prefix}/rulesets` || !Array.isArray(page.data))
        throw new GitHubApiError(
          "invalid_response",
          "Repository ruleset pagination changed scope or shape",
        );
      rows.push(...(page.data as unknown[]));
    }
    return rows.map(record);
  };
  const readRule = (id: number) =>
    request("GET", `/rulesets/${id}?includes_parents=true`).then(record);
  if (releasePlan || releaseCheck || releaseApply) {
    const repository = record(await request("GET", ""));
    if (repository.id !== 1354613114 || repository.full_name !== repo)
      throw new Error("Release ruleset repository identity differs");
    const snapshot = async () => {
      const summaries = await readRulesets();
      const rows = [];
      for (let start = 0; start < summaries.length; start += 4) {
        const details = await Promise.all(
          summaries.slice(start, start + 4).map(async (summary) => {
            if (
              typeof summary.id !== "number" ||
              !Number.isSafeInteger(summary.id) ||
              summary.id < 1
            )
              throw new Error("Invalid ruleset summary ID");
            const detail = await readRule(summary.id);
            for (const key of [
              "id",
              "name",
              "target",
              "enforcement",
              "updated_at",
              "source",
              "source_type",
            ])
              if (summary[key] !== detail[key])
                throw new Error("Ruleset changed during inspection");
            return detail;
          }),
        );
        rows.push(...details);
      }
      const { stdout } = await promisify(execFile)(
        "git",
        [
          "ls-remote",
          "--refs",
          `https://github.com/${repo}.git`,
          "refs/heads/portcove-*",
          "refs/tags/portcove-*",
          "refs/tags/v*",
        ],
        { timeout: 15_000, maxBuffer: 1024 * 1024 },
      );
      const refs = Object.fromEntries(
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const match = /^([a-f0-9]{40})\t(refs\/(?:heads|tags)\/[^\s]+)$/u.exec(line);
            if (!match) throw new Error("Unexpected protected Git ref response");
            return [match[2]!, match[1]!];
          }),
      );
      const byId = (rows: Record<string, unknown>[]) =>
        rows.toSorted((a, b) => Number(a.id) - Number(b.id));
      if (!isDeepStrictEqual(byId(summaries), byId(await readRulesets())))
        throw new Error("Ruleset inventory changed during inspection");
      return { rows, plan: planReleaseRulesets(rows, refs, ruleset) };
    };
    const before = await snapshot();
    if (releasePlan) {
      console.log(JSON.stringify(before.plan, null, 2));
      return;
    }
    const { next } = before.plan;
    if (releaseCheck || !next) {
      if (next) throw new Error("Permanent release ruleset migration is pending");
      console.log(`Release rulesets match the contract (${before.plan.count} policies).`);
      return;
    }
    if (argv[1] !== before.plan.observation)
      throw new Error("Live rulesets or protected refs changed since the reviewed observation");
    const expectedPause = before.plan.identities["refs/heads/portcove-release-pause"];
    const pause = record(await request("GET", `${pauseDocument}?ref=${expectedPause}`));
    if (pause.encoding !== "base64" || typeof pause.content !== "string")
      throw new Error("Publication pause document is unavailable");
    const { inspectApplicationPublicationPause } = await import("./application-release-policy.mts");
    const paused = inspectApplicationPublicationPause(
      JSON.parse(Buffer.from(pause.content, "base64").toString("utf8")),
    );
    if (!paused.paused)
      throw new Error("Release ruleset migration requires a closed publication pause");
    const variables = record(await request("GET", "/actions/variables?per_page=100"));
    if (
      !Array.isArray(variables.variables) ||
      variables.variables.length !== variables.total_count ||
      variables.variables.some(
        (row: unknown) =>
          !isRecord(row) || typeof row.name !== "string" || activeReleaseVariables.has(row.name),
      )
    )
      throw new Error("Active release configuration must settle before ruleset migration");
    for (const workflow of releaseWorkflows) {
      const active = await Promise.all(
        ["queued", "in_progress", "pending", "waiting", "requested"].map(async (status) =>
          record(
            await request("GET", `/actions/workflows/${workflow}/runs?status=${status}&per_page=1`),
          ),
        ),
      );
      if (active.some((row) => row.total_count !== 0))
        throw new Error(`Release ruleset migration found an unsettled ${workflow} run`);
    }
    const assertPause = async () => {
      const observed = record(await request("GET", pauseRef));
      if (
        observed.ref !== "refs/heads/portcove-release-pause" ||
        !isRecord(observed.object) ||
        observed.object.type !== "commit" ||
        observed.object.sha !== expectedPause
      )
        throw new Error("Publication pause ref changed before migration write");
    };
    let writeFailure: unknown;
    let attempted = false;
    const write = async (method: "POST" | "PUT" | "DELETE", suffix: string, data?: unknown) => {
      await assertPause();
      attempted = true;
      try {
        await request(method, suffix, data);
        return true;
      } catch (error) {
        writeFailure = error;
        return false;
      }
    };
    try {
      if (next.action === "delete") {
        for (const id of next.replacements) {
          const replacement = before.rows.find((row) => row.id === id);
          if (!isDeepStrictEqual(await readRule(id), replacement))
            throw new Error(`Replacement ruleset ${id} changed before deletion`);
          const policy = record(record(record(replacement).conditions).ref_name);
          if (replacement?.target === "branch") {
            for (const ref of policy.include as string[]) {
              const branch = ref.slice("refs/heads/".length);
              const effective = await request("GET", `/rules/branches/${branch}?per_page=100`);
              if (
                !Array.isArray(effective) ||
                effective.length >= 100 ||
                !(replacement.rules as { type: string }[]).every(({ type }) =>
                  effective.some(
                    (rule: unknown) =>
                      isRecord(rule) && rule.type === type && rule.ruleset_id === id,
                  ),
                )
              )
                throw new Error(`Replacement ruleset ${id} is unproven on ${branch}`);
            }
          }
        }
        for (const { id } of next.policies) {
          await Promise.all(
            [id, ...next.replacements].map(async (preimageId) => {
              const preimage = before.rows.find((row) => row.id === preimageId);
              if (!isDeepStrictEqual(await readRule(preimageId), preimage))
                throw new Error(`Ruleset ${preimageId} changed before deletion of ${id}`);
            }),
          );
          if (!(await write("DELETE", `/rulesets/${id}`))) break;
          console.error(`GitHub acknowledged deletion of redundant ruleset ${id}.`);
        }
      } else if (next.action === "update") {
        if (
          !isDeepStrictEqual(
            await readRule(next.id),
            before.rows.find((row) => row.id === next.id),
          )
        )
          throw new Error(`Ruleset ${next.id} changed before expansion`);
        await write("PUT", `/rulesets/${next.id}`, next.payload);
      } else {
        await write("POST", "/rulesets", next.payload);
      }
    } catch (error) {
      if (!attempted) throw error;
      writeFailure = error;
    }
    const after = await snapshot().catch((cause: unknown) => {
      throw new Error("Migration outcome is unknown. Rerun the read-only plan.", { cause });
    });
    if (
      releaseCanonicalDigest(before.plan.identities) !==
      releaseCanonicalDigest(after.plan.identities)
    )
      throw new Error("Git refs changed during the migration stage. Reconcile before proceeding.");
    const stableId =
      next.action === "delete"
        ? undefined
        : Object.values(after.plan.stable).find((rule) => rule?.name === next.payload.name)?.id;
    const excluded = new Set(
      next.action === "delete" ? next.policies.map(({ id }) => id) : [stableId],
    );
    const preserved = (rows: typeof after.rows) =>
      rows
        .filter((row) => !excluded.has(Number(row.id)))
        .sort((a, b) => Number(a.id) - Number(b.id));
    if (
      (next.action === "delete" && after.rows.some((row) => excluded.has(Number(row.id)))) ||
      (next.action === "update" && stableId !== next.id) ||
      (next.action === "create" &&
        (stableId === undefined || before.rows.some((row) => row.id === stableId))) ||
      !isDeepStrictEqual(preserved(before.rows), preserved(after.rows))
    ) {
      console.log(JSON.stringify(after.plan, null, 2));
      throw new Error(
        "Migration stage is incomplete or drifted. Reconcile the live plan before resuming.",
        {
          cause: writeFailure,
        },
      );
    }
    console.log(JSON.stringify(after.plan, null, 2));
    return;
  }
  if (mode !== "--plan" && mode !== "--check" && mode !== "--apply")
    throw new Error("Invalid repository settings mode");
  const result = await reconcileRepositorySettings(ruleset, security, mode, {
    readRulesets,
    readRuleset: (id) => request("GET", `/rulesets/${id}`),
    readRepository: () => request("GET", ""),
    readPrivateReporting: () => request("GET", "/private-vulnerability-reporting"),
    updateRuleset: (id, payload) => request("PUT", `/rulesets/${id}`, payload),
    updateRepository: (payload) => request("PATCH", "", payload),
    enablePrivateReporting: () => request("PUT", "/private-vulnerability-reporting"),
  });
  if (result.kind === "plan") console.log(JSON.stringify(result.output, null, 2));
  else console.log(`Repository settings match the checked-in contract for ${result.repository}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath)
  await main(process.argv.slice(2));
