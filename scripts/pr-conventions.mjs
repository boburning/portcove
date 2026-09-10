import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const configPath = new URL("../.github/pr-conventions.json", import.meta.url);

function exactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function stringList(value, label) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => typeof item !== "string" || !item)
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length)
    throw new Error(`${label} must not contain duplicates`);
  return value;
}

export function validatePrConventionConfig(config) {
  exactKeys(
    config,
    ["schema_version", "repository", "title", "branch", "body", "bot_actors"],
    "PR conventions config",
  );
  if (config.schema_version !== 1)
    throw new Error("PR conventions schema_version must be 1");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "")) {
    throw new Error("PR conventions repository must be owner/name");
  }

  exactKeys(config.title, ["types", "max_length"], "title config");
  const types = stringList(config.title.types, "title types");
  if (types.some((type) => !/^[a-z]+$/.test(type))) {
    throw new Error("title types must use lowercase ASCII letters");
  }
  if (
    !Number.isInteger(config.title.max_length) ||
    config.title.max_length < 40
  ) {
    throw new Error("title max_length must be an integer of at least 40");
  }

  exactKeys(config.branch, ["prefixes", "bot_prefixes"], "branch config");
  const prefixes = stringList(config.branch.prefixes, "branch prefixes");
  const botPrefixes = stringList(
    config.branch.bot_prefixes,
    "bot branch prefixes",
  );
  if (
    [...prefixes, ...botPrefixes].some(
      (prefix) => !/^[a-z][a-z-]*\/$/.test(prefix),
    )
  ) {
    throw new Error(
      "branch prefixes must be lowercase kebab-case and end with /",
    );
  }

  exactKeys(config.body, ["headings", "issue_keywords"], "body config");
  stringList(config.body.headings, "body headings");
  stringList(config.body.issue_keywords, "issue keywords");
  stringList(config.bot_actors, "bot actors");
  return config;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function finding(code, message) {
  return { code, message };
}

function titleFindings(subject, config, label) {
  const findings = [];
  const types = config.title.types.map(escapeRegex).join("|");
  const pattern = new RegExp(
    `^(?:${types})(?:\\([a-z0-9]+(?:-[a-z0-9]+)*\\))?!?: \\S.*$`,
  );
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
    findings.push(
      finding(`${label}-punctuation`, `${label} should not end with a period.`),
    );
  }
  return findings;
}

function branchFindings(branch, config, bot) {
  if (
    bot &&
    config.branch.bot_prefixes.some((prefix) => branch.startsWith(prefix))
  )
    return [];
  const prefix = config.branch.prefixes.find((candidate) =>
    branch.startsWith(candidate),
  );
  if (
    !prefix ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch.slice(prefix?.length ?? 0))
  ) {
    return [
      finding(
        "branch-format",
        `branch must use an approved project-purpose prefix and lowercase kebab-case name: ${branch}`,
      ),
    ];
  }
  return [];
}

function stripComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function bodySections(body, headings) {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const heading = matches[index][1];
    if (!headings.includes(heading)) continue;
    const entry = {
      content: body.slice(
        matches[index].index + matches[index][0].length,
        matches[index + 1]?.index ?? body.length,
      ),
      index: matches[index].index,
    };
    const existing = sections.get(heading) ?? [];
    existing.push(entry);
    sections.set(heading, existing);
  }
  return sections;
}

function bodyFindings(pull, config) {
  const findings = [];
  const body = pull.body ?? "";
  const sections = bodySections(body, config.body.headings);
  const positions = [];
  for (const heading of config.body.headings) {
    const entries = sections.get(heading) ?? [];
    if (!entries.length) {
      findings.push(
        finding(
          "body-heading",
          `pull request body is missing the '${heading}' section.`,
        ),
      );
      continue;
    }
    if (entries.length > 1) {
      findings.push(
        finding(
          "body-heading",
          `pull request body repeats the '${heading}' section.`,
        ),
      );
    }
    positions.push(entries[0].index);
    if (!stripComments(entries[0].content)) {
      findings.push(
        finding(
          "body-empty",
          `pull request body has no visible content under '${heading}'.`,
        ),
      );
    }
  }
  if (
    positions.some(
      (position, index) => index > 0 && position < positions[index - 1],
    )
  ) {
    findings.push(
      finding(
        "body-order",
        "pull request body sections must remain in the configured order.",
      ),
    );
  }

  const visibleBody = stripComments(body);
  const keywordPattern = config.body.issue_keywords.map(escapeRegex).join("|");
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
    new RegExp(`(?:${keywordPattern})\\s+#\\s*(?:$|\\r?\\n)`, "im").test(
      visibleBody,
    ) ||
    /\b(?:TBD|TODO|REPLACE ME)\b|\[\s*replace[^\]]*\]/i.test(visibleBody)
  ) {
    findings.push(
      finding(
        "body-placeholder",
        "pull request body contains a visible unfinished placeholder.",
      ),
    );
  }

  const verification = stripComments(
    sections.get("Verification")?.[0]?.content ?? "",
  );
  const draftPending = pull.isDraft && /\bpending\b/i.test(verification);
  if (
    verification &&
    !draftPending &&
    !/`[^`\r\n]+`|```/.test(verification) &&
    !/\b(?:Not run|Not applicable)\s*[—:-]\s*\S/i.test(verification)
  ) {
    findings.push(
      finding(
        "verification-detail",
        "Verification should name an exact command or use 'Not run — reason' / 'Not applicable — reason'.",
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
    const review = stripComments(
      sections.get("Review and risk")?.[0]?.content ?? "",
    );
    if (/\b(?:pending|in progress|TBD|TODO)\b|- \[ \]/i.test(review)) {
      findings.push(
        finding(
          "review-pending",
          "a ready pull request should replace pending review text with the distinct review result.",
        ),
      );
    }
    if (review && !/\breview(?:ed)?\b/i.test(review)) {
      findings.push(
        finding(
          "review-result",
          "Review and risk should state the distinct review result.",
        ),
      );
    }
    const reviewedHead =
      pull.headSha &&
      (review.includes(pull.headSha) ||
        review.includes(pull.headSha.slice(0, 7)));
    if (review && !reviewedHead) {
      findings.push(
        finding(
          "review-head",
          "Review and risk should identify the exact reviewed head commit.",
        ),
      );
    }
  }
  return findings;
}

function commitFindings(pull, config) {
  if (config.bot_actors.includes(pull.actor)) return [];
  const findings = [];
  for (const commit of pull.commits) {
    const subject = String(commit.message ?? "").split(/\r?\n/, 1)[0];
    if (/^Merge\b/.test(subject) || /^Revert\s+"/.test(subject)) continue;
    if (pull.isDraft && /^(?:fixup|squash)!\s*/.test(subject)) continue;
    for (const result of titleFindings(subject, config, "commit subject")) {
      findings.push(
        finding(result.code, `${commit.sha.slice(0, 7)}: ${result.message}`),
      );
    }
  }
  return findings;
}

export function evaluatePullRequest(pull, unvalidatedConfig) {
  const config = validatePrConventionConfig(unvalidatedConfig);
  if (
    !pull ||
    typeof pull.title !== "string" ||
    typeof pull.body !== "string" ||
    typeof pull.branch !== "string" ||
    typeof pull.actor !== "string" ||
    typeof pull.isDraft !== "boolean" ||
    !Array.isArray(pull.commits)
  ) {
    throw new Error("pull request metadata is incomplete");
  }
  const bot = config.bot_actors.includes(pull.actor);
  return [
    ...titleFindings(pull.title, config, "pull request title"),
    ...branchFindings(pull.branch, config, bot),
    ...(bot ? [] : bodyFindings(pull, config)),
    ...commitFindings(pull, config),
  ];
}

export function flattenCommitPages(value, expectedCount) {
  if (
    !Array.isArray(value) ||
    value.some((page) => {
      const connection = page?.data?.repository?.pullRequest?.commits;
      return !connection || !Array.isArray(connection.nodes);
    })
  ) {
    throw new Error("GitHub commit pagination returned an invalid response");
  }
  const commits = value.flatMap((page) =>
    page.data.repository.pullRequest.commits.nodes.map((node) => {
      const commit = node?.commit;
      if (
        typeof commit?.oid !== "string" ||
        typeof commit?.message !== "string"
      ) {
        throw new Error("GitHub commit pagination returned an invalid commit");
      }
      return { sha: commit.oid, message: commit.message };
    }),
  );
  if (commits.length !== expectedCount) {
    throw new Error(
      `GitHub returned ${commits.length} of ${expectedCount} pull request commits`,
    );
  }
  return commits;
}

export function parsePullRequestReference(value, repository) {
  if (/^[1-9]\d*$/.test(value)) return Number(value);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "--pr must be a positive number or a GitHub pull request URL",
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    parts.length !== 4 ||
    parts[2] !== "pull" ||
    !/^[1-9]\d*$/.test(parts[3]) ||
    `${parts[0]}/${parts[1]}`.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error(`--pr must identify a pull request in ${repository}`);
  }
  return Number(parts[3]);
}

function ghApi(endpoint) {
  const args = ["api", endpoint];
  const result = spawnSync("gh", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() || `gh api failed with exit ${result.status}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api returned invalid JSON: ${error.message}`);
  }
}

function ghCommitPages(repository, number) {
  const [owner, name] = repository.split("/");
  const query = `
    query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          commits(first: 100, after: $endCursor) {
            nodes { commit { oid message } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const result = spawnSync(
    "gh",
    [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      result.stderr.trim() ||
        `gh api graphql failed with exit ${result.status}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`gh api graphql returned invalid JSON: ${error.message}`);
  }
}

export async function loadLivePullRequest(reference, config) {
  const number = parsePullRequestReference(reference, config.repository);
  const pull = ghApi(`repos/${config.repository}/pulls/${number}`);
  const commits = flattenCommitPages(
    ghCommitPages(config.repository, number),
    pull.commits,
  );
  return {
    number,
    url: pull.html_url,
    title: pull.title ?? "",
    body: pull.body ?? "",
    branch: pull.head?.ref ?? "",
    headSha: pull.head?.sha ?? "",
    actor: pull.user?.login ?? "",
    isDraft: pull.draft === true,
    commits,
  };
}

function githubEscape(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function markdownEscape(value) {
  return value
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function renderFindings(pull, findings) {
  if (!findings.length)
    return `PR #${pull.number} follows the advisory contribution conventions.`;
  return [
    `PR #${pull.number} has ${findings.length} advisory convention finding${findings.length === 1 ? "" : "s"}:`,
    ...findings.map((item) => `- [${item.code}] ${item.message}`),
  ].join("\n");
}

async function writeGithubOutput(pull, findings) {
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
        (item) =>
          `| ${markdownEscape(item.code)} | ${markdownEscape(item.message)} |`,
      ),
      "",
    );
  }
  await appendFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--pr") {
    throw new Error(
      "usage: node scripts/pr-conventions.mjs --pr <number-or-url>",
    );
  }
  const config = validatePrConventionConfig(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const pull = await loadLivePullRequest(argv[1], config);
  const findings = evaluatePullRequest(pull, config);
  console.log(renderFindings(pull, findings));
  await writeGithubOutput(pull, findings);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`pr-conventions: ${error.message}`);
    process.exitCode = 1;
  }
}
