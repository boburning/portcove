import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { GitHubApiError } from "./github-operation.mts";
import {
  validateRepositorySettings,
  reconcileRepositorySettings,
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
  --help      Show this help without reading configuration or contacting GitHub.

Applying protection or security changes requires explicit owner authorization.
This command does not create replacement protection or bypass its migration guards.

Example:
  node scripts/repository-settings.mts --validate`);
    return;
  }
  const mode = argv[0] ?? "--validate";
  if (
    (mode !== "--validate" && mode !== "--plan" && mode !== "--check" && mode !== "--apply") ||
    argv.length > 1
  ) {
    throw new Error(
      "Usage: node scripts/repository-settings.mts [--validate|--plan|--check|--apply]. Run with --help for an example.",
    );
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
      if (method === "GET")
        return (
          url.pathname === prefix ||
          url.pathname === `${prefix}/rulesets` ||
          url.pathname === `${prefix}/private-vulnerability-reporting` ||
          (url.pathname.startsWith(`${prefix}/rulesets/`) &&
            /^[1-9][0-9]*$/u.test(url.pathname.slice(`${prefix}/rulesets/`.length)))
        );
      return (
        (method === "PATCH" && url.pathname === prefix) ||
        (method === "PUT" &&
          (url.pathname === `${prefix}/private-vulnerability-reporting` ||
            (url.pathname.startsWith(`${prefix}/rulesets/`) &&
              /^[1-9][0-9]*$/u.test(url.pathname.slice(`${prefix}/rulesets/`.length)))))
      );
    },
  });
  const request = async (method: "GET" | "PUT" | "PATCH", suffix: string, data?: unknown) =>
    (
      await sdk.request({
        method,
        url: `https://api.github.com${prefix}${suffix}`,
        headers,
        ...(data === undefined ? {} : { data }),
        request: { portcove: { replay: method === "GET" ? "safe-read" : "once", attempts: 0 } },
      })
    ).data as unknown;
  const result = await reconcileRepositorySettings(ruleset, security, mode, {
    async readRulesets() {
      const rows: unknown[] = [];
      for await (const page of iterateGitHubPages(sdk, {
        url: `https://api.github.com${prefix}/rulesets?per_page=100`,
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
      return rows;
    },
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
