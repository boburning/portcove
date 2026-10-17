import { isRecord, errorMessage } from "./runtime-values.mts";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { hasHazardousClosingNegation } from "./closure-intent.mts";

export interface PrConventionConfig {
  schema_version: 1;
  repository: string;
  title: { types: string[]; max_length: number };
  branch: { prefixes: string[]; bot_prefixes: string[] };
  body: { headings: string[]; issue_keywords: string[] };
  bot_actors: string[];
}
export interface PrConventionFinding {
  code: string;
  message: string;
}
interface PullMetadata {
  title: string;
  body: string;
  branch: string;
  actor: string;
  isDraft: boolean;
  commits: unknown[];
  headSha?: unknown;
}
interface CommitConnection {
  totalCount: number;
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = new URL("../.github/pr-conventions.json", import.meta.url);

function exactKeys(
  value: unknown,
  expected: string[],
  label: string,
): asserts value is Record<string, unknown> {
  const actual = isRecord(value) ? Object.keys(value).sort() : [];
  const wanted = [...expected].sort();
  if (!isRecord(value) || JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error(`${label} must be a non-empty string array`);
  const items: unknown[] = value;
  if (!items.every((item): item is string => typeof item === "string" && item.length > 0))
    throw new Error(`${label} must be a non-empty string array`);
  if (new Set(items).size !== items.length) throw new Error(`${label} must not contain duplicates`);
  return items;
}

function assertPrConventionConfig(config: unknown): asserts config is PrConventionConfig {
  exactKeys(
    config,
    ["schema_version", "repository", "title", "branch", "body", "bot_actors"],
    "PR conventions config",
  );
  if (config.schema_version !== 1) throw new Error("PR conventions schema_version must be 1");
  if (
    typeof config.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)
  ) {
    throw new Error("PR conventions repository must be owner/name");
  }

  exactKeys(config.title, ["types", "max_length"], "title config");
  const types = stringList(config.title.types, "title types");
  if (types.some((type) => !/^[a-z]+$/.test(type))) {
    throw new Error("title types must use lowercase ASCII letters");
  }
  if (
    typeof config.title.max_length !== "number" ||
    !Number.isInteger(config.title.max_length) ||
    config.title.max_length < 40
  ) {
    throw new Error("title max_length must be an integer of at least 40");
  }

  exactKeys(config.branch, ["prefixes", "bot_prefixes"], "branch config");
  const prefixes = stringList(config.branch.prefixes, "branch prefixes");
  const botPrefixes = stringList(config.branch.bot_prefixes, "bot branch prefixes");
  if ([...prefixes, ...botPrefixes].some((prefix) => !/^[a-z][a-z-]*\/$/.test(prefix))) {
    throw new Error("branch prefixes must be lowercase kebab-case and end with /");
  }

  exactKeys(config.body, ["headings", "issue_keywords"], "body config");
  stringList(config.body.headings, "body headings");
  stringList(config.body.issue_keywords, "issue keywords");
  stringList(config.bot_actors, "bot actors");
}
export function validatePrConventionConfig(config: unknown): PrConventionConfig {
  assertPrConventionConfig(config);
  return config;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finding(code: string, message: string): PrConventionFinding {
  return { code, message };
}

function titleFindings(subject: string, config: PrConventionConfig, label: string) {
  const findings = [];
  const types = config.title.types.map(escapeRegex).join("|");
  const pattern = new RegExp(`^(?:${types})(?:\\([a-z0-9]+(?:-[a-z0-9]+)*\\))?!?: \\S.*$`);
  if (!pattern.test(subject)) {
    findings.push(
      finding(
        `${label}-format`,
        `${label} must use type(scope): imperative summary; scope is optional and ! may mark a breaking change.`,
      ),
    );
  }
  if (subject.length > config.title.max_length) {
    findings.push(
      finding(
        `${label}-length`,
        `${label} is ${subject.length} characters; keep it at ${config.title.max_length} or fewer when practical.`,
      ),
    );
  }
  if (subject.endsWith(".")) {
    findings.push(finding(`${label}-punctuation`, `${label} should not end with a period.`));
  }
  return findings;
}

function branchFindings(branch: string, config: PrConventionConfig, bot: boolean) {
  if (bot && config.branch.bot_prefixes.some((prefix) => branch.startsWith(prefix))) return [];
  const prefix = config.branch.prefixes.find((candidate) => branch.startsWith(candidate));
  if (!prefix || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch.slice(prefix?.length ?? 0))) {
    return [
      finding(
        "branch-format",
        `branch must use an approved project-purpose prefix and lowercase kebab-case name: ${branch}`,
      ),
    ];
  }
  return [];
}

function stripComments(value: string) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function bodySections(body: string, headings: string[]) {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map<string, { content: string; index: number }[]>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) throw new Error("Heading match disappeared");
    const heading = match[1] ?? "";
    if (!headings.includes(heading)) continue;
    const entry = {
      content: body.slice(match.index + match[0].length, matches[index + 1]?.index ?? body.length),
      index: match.index,
    };
    const existing = sections.get(heading) ?? [];
    existing.push(entry);
    sections.set(heading, existing);
  }
  return sections;
}

function bodyFindings(pull: PullMetadata, config: PrConventionConfig) {
  const findings = [];
  const body = pull.body ?? "";
  const sections = bodySections(body, config.body.headings);
  const positions: number[] = [];
  for (const heading of config.body.headings) {
    const entries = sections.get(heading) ?? [];
    if (!entries.length) {
      findings.push(
        finding("body-heading", `pull request body is missing the '${heading}' section.`),
      );
      continue;
    }
    if (entries.length > 1) {
      findings.push(finding("body-heading", `pull request body repeats the '${heading}' section.`));
    }
    const entry = entries[0];
    if (!entry) throw new Error("Heading entry disappeared");
    positions.push(entry.index);
    if (!stripComments(entry.content)) {
      findings.push(
        finding("body-empty", `pull request body has no visible content under '${heading}'.`),
      );
    }
  }
  if (
    positions.some((position, index) => index > 0 && position < (positions[index - 1] ?? position))
  ) {
    findings.push(
      finding("body-order", "pull request body sections must remain in the configured order."),
    );
  }

  const visibleBody = stripComments(body);
  const keywordPattern = config.body.issue_keywords.map(escapeRegex).join("|");
  if (hasHazardousClosingNegation(body)) {
    findings.push(
      finding(
        "negated-closing-keyword",
        "GitHub can still interpret a negated closing keyword; say 'keeps #123 open' instead.",
      ),
    );
  }
  if (
    !new RegExp(
      `(?:${keywordPattern})\\s+(?:[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)?#\\d+\\b`,
      "i",
    ).test(visibleBody)
  ) {
    findings.push(
      finding(
        "linked-issue",
        "Linked issue must use Closes/Fixes/Resolves, Refs, or Related to with an issue number.",
      ),
    );
  }
  if (
    new RegExp(`(?:${keywordPattern})\\s+#\\s*(?:$|\\r?\\n)`, "im").test(visibleBody) ||
    /\b(?:TBD|TODO|REPLACE ME)\b|\[\s*replace[^\]]*\]/i.test(visibleBody)
  ) {
    findings.push(
      finding("body-placeholder", "pull request body contains a visible unfinished placeholder."),
    );
  }

  const verification = stripComments(sections.get("Verification")?.[0]?.content ?? "");
  const draftPending = pull.isDraft && /\bpending\b/i.test(verification);
  if (
    verification &&
    !draftPending &&
    !/`[^`\r\n]+`|```|https:\/\/(?:github\.com|[A-Za-z0-9.-]+)\/[^\s)]+/u.test(verification) &&
    !/\b(?:Not run|Not applicable)\s*[—:-]\s*\S/i.test(verification)
  ) {
    findings.push(
      finding(
        "verification-detail",
        "Verification should link the exact-head CI result or name observed validation.",
      ),
    );
  }

  if (!pull.isDraft) {
    if (/\b(?:pending|in progress|TBD|TODO)\b|- \[ \]/i.test(verification)) {
      findings.push(
        finding(
          "verification-pending",
          "a ready pull request should replace pending verification with observed results.",
        ),
      );
    }
    const review = stripComments(sections.get("Review and risk")?.[0]?.content ?? "");
    if (/\b(?:pending|in progress|TBD|TODO)\b|- \[ \]/i.test(review)) {
      findings.push(
        finding(
          "review-pending",
          "a ready pull request should replace pending review text with the applicable review result.",
        ),
      );
    }
    if (review && !/\breview(?:ed)?\b/i.test(review)) {
      findings.push(
        finding("review-result", "Review and risk should state the applicable review result."),
      );
    }
    const reviewedHead =
      typeof pull.headSha === "string" &&
      pull.headSha.length > 0 &&
      (review.includes(pull.headSha) || review.includes(pull.headSha.slice(0, 7)));
    if (review && !reviewedHead) {
      findings.push(
        finding("review-head", "Review and risk should identify the exact reviewed head commit."),
      );
    }
  }
  return findings;
}

// Preserve the existing advisory text coercion; this does not admit provider data.
const diagnosticText = (value: unknown) => String(value);

function commitFindings(pull: PullMetadata, config: PrConventionConfig) {
  if (config.bot_actors.includes(pull.actor)) return [];
  const findings = [];
  for (const commit of pull.commits) {
    if (!isRecord(commit) || typeof commit.sha !== "string")
      throw new Error("pull request commit identity is incomplete");
    const subject = diagnosticText(commit.message ?? "").split(/\r?\n/, 1)[0] ?? "";
    if (/^Merge\b/.test(subject) || /^Revert\s+"/.test(subject)) continue;
    if (pull.isDraft && /^(?:fixup|squash)!\s*/.test(subject)) continue;
    for (const result of titleFindings(subject, config, "commit subject")) {
      findings.push(finding(result.code, `${commit.sha.slice(0, 7)}: ${result.message}`));
    }
  }
  return findings;
}

export function evaluatePullRequest(pull: unknown, unvalidatedConfig: unknown) {
  const config = validatePrConventionConfig(unvalidatedConfig);
  if (
    !isRecord(pull) ||
    typeof pull.title !== "string" ||
    typeof pull.body !== "string" ||
    typeof pull.branch !== "string" ||
    typeof pull.actor !== "string" ||
    typeof pull.isDraft !== "boolean" ||
    !Array.isArray(pull.commits)
  ) {
    throw new Error("pull request metadata is incomplete");
  }
  const metadata: PullMetadata = {
    title: pull.title,
    body: pull.body,
    branch: pull.branch,
    actor: pull.actor,
    isDraft: pull.isDraft,
    commits: pull.commits,
    headSha: pull.headSha,
  };
  const bot = config.bot_actors.includes(pull.actor);
  return [
    ...titleFindings(pull.title, config, "pull request title"),
    ...branchFindings(pull.branch, config, bot),
    ...(bot ? [] : bodyFindings(metadata, config)),
    ...commitFindings(metadata, config),
  ];
}

function commitConnection(page: unknown): CommitConnection {
  const data = isRecord(page) ? page.data : undefined;
  const repository = isRecord(data) ? data.repository : undefined;
  const pull = isRecord(repository) ? repository.pullRequest : undefined;
  const connection = isRecord(pull) ? pull.commits : undefined;
  if (
    !isRecord(connection) ||
    !Array.isArray(connection.nodes) ||
    typeof connection.totalCount !== "number" ||
    !Number.isSafeInteger(connection.totalCount) ||
    connection.totalCount < 0 ||
    !isRecord(connection.pageInfo) ||
    typeof connection.pageInfo.hasNextPage !== "boolean" ||
    !(connection.pageInfo.endCursor === null || typeof connection.pageInfo.endCursor === "string")
  )
    throw new Error("GitHub commit pagination returned an invalid response");
  return {
    totalCount: connection.totalCount,
    nodes: connection.nodes,
    pageInfo: {
      hasNextPage: connection.pageInfo.hasNextPage,
      endCursor: connection.pageInfo.endCursor,
    },
  };
}
export function flattenCommitPages(value: unknown, expectedCount: number) {
  if (!Array.isArray(value))
    throw new Error("GitHub commit pagination returned an invalid response");
  const pages: unknown[] = value;
  const connections = pages.map(commitConnection);
  const identities = new Set();
  let reportedTotal: number | null = null;
  const commits = connections.flatMap((connection, pageIndex) => {
    reportedTotal ??= connection.totalCount;
    if (reportedTotal !== connection.totalCount) {
      throw new Error("GitHub commit total changed during pagination");
    }
    const terminal = pageIndex === connections.length - 1;
    if (connection.pageInfo.hasNextPage === terminal) {
      throw new Error("GitHub commit pagination returned an invalid terminal page");
    }
    return connection.nodes.map((node) => {
      const commit = isRecord(node) ? node.commit : undefined;
      if (
        !isRecord(commit) ||
        typeof commit.oid !== "string" ||
        !commit.oid ||
        identities.has(commit.oid) ||
        typeof commit.message !== "string"
      ) {
        throw new Error("GitHub commit pagination returned an invalid commit");
      }
      identities.add(commit.oid);
      return { sha: commit.oid, message: commit.message };
    });
  });
  if (reportedTotal !== expectedCount || commits.length !== expectedCount) {
    throw new Error(`GitHub returned ${commits.length} of ${expectedCount} pull request commits`);
  }
  return commits;
}

export function parsePullRequestReference(value: string, repository: string) {
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--pr must be a positive number or a GitHub pull request URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !/^[1-9]\d*$/.test(parts[3] ?? "") ||
    `${parts[0]}/${parts[1]}`.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(`--pr must identify a pull request in ${repository}`);
  }
  return Number(parts[3]);
}

function ghCommitPages(repository: string, number: number, api: Pick<GitHubApiClient, "graphql">) {
  const [owner, name] = repository.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          commits(first: 100, after: $endCursor) {
            totalCount
            nodes { commit { oid message } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const pages = [];
  const cursors = new Set();
  let endCursor: string | null = null;
  for (;;) {
    const data = api.graphql(query, { owner, name, number, endCursor }).data;
    const connection = commitConnection({ data });
    pages.push({ data });
    if (connection?.pageInfo?.hasNextPage !== true) break;
    endCursor = connection.pageInfo.endCursor;
    if (!connection.nodes?.length || !endCursor || cursors.has(endCursor)) {
      throw new Error("GitHub commit pagination did not advance");
    }
    cursors.add(endCursor);
  }
  return pages;
}

function providerText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("pull request metadata contains non-text fields");
  return value;
}

export async function loadLivePullRequest(
  reference: string,
  config: PrConventionConfig,
  api = new GitHubApiClient(createGitHubRunner({ cwd: projectRoot })),
) {
  const number = parsePullRequestReference(reference, config.repository);
  const pull = api.request("GET", `repos/${config.repository}/pulls/${number}`).body;
  if (!isRecord(pull) || typeof pull.commits !== "number")
    throw new Error("pull request metadata is incomplete");
  const commits = flattenCommitPages(ghCommitPages(config.repository, number, api), pull.commits);
  return {
    number,
    url: providerText(pull.html_url),
    title: providerText(pull.title),
    body: providerText(pull.body),
    branch: providerText(isRecord(pull.head) ? pull.head.ref : undefined),
    headSha: providerText(isRecord(pull.head) ? pull.head.sha : undefined),
    actor: providerText(isRecord(pull.user) ? pull.user.login : undefined),
    isDraft: pull.draft === true,
    commits,
  };
}

function githubEscape(value: string) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function markdownEscape(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

export function renderFindings(pull: { number: number }, findings: PrConventionFinding[]) {
  if (!findings.length) return `PR #${pull.number} follows the advisory contribution conventions.`;
  return [
    `PR #${pull.number} has ${findings.length} advisory convention finding${findings.length === 1 ? "" : "s"}:`,
    ...findings.map((item) => `- [${item.code}] ${item.message}`),
  ].join("\n");
}

async function writeGithubOutput(pull: { number: number }, findings: PrConventionFinding[]) {
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const item of findings) {
      console.log(
        `::warning title=PR conventions (${githubEscape(item.code)})::${githubEscape(item.message)}`,
      );
    }
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    "## PR conventions (advisory)",
    "",
    "This check reports consistency suggestions and never replaces required review, CI, Roadmap, or merge-authority gates.",
    "",
  ];
  if (!findings.length) {
    lines.push(`✅ PR #${pull.number} follows the configured conventions.`, "");
  } else {
    lines.push("| Code | Finding |", "| --- | --- |");
    lines.push(
      ...findings.map(
        (item) => `| ${markdownEscape(item.code)} | ${markdownEscape(item.message)} |`,
      ),
      "",
    );
  }
  await appendFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

async function main(argv: string[]) {
  if (argv.length !== 2 || argv[0] !== "--pr") {
    throw new Error("usage: node scripts/pr-conventions.mts --pr <number-or-url>");
  }
  const config = validatePrConventionConfig(JSON.parse(await readFile(configPath, "utf8")));
  const pull = await loadLivePullRequest(argv[1] ?? "", config);
  const findings = evaluatePullRequest(pull, config);
  console.log(renderFindings(pull, findings));
  await writeGithubOutput(pull, findings);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`pr-conventions: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
