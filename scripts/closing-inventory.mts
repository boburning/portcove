import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closingInventoryFindings, readClosingRelationshipsGraphql } from "./closure-intent.mts";
import { GitHubApiError } from "./github-operation.mts";
import { errorMessage } from "./runtime-values.mts";

/**
 * Hosted closing-inventory check. GitHub's GraphQL inventory is the authority
 * for what a pull request will close; sessions without GraphQL reconstruct it
 * from closing keywords over REST. This check fails when the inventory holds a
 * manual Development link the body does not name, or a relationship hidden
 * from the workflow token, so a successful run lets that reconstruction stand.
 */
export async function closingInventoryCheck(repository: string, number: number) {
  const { createGitHubClient } = await import("./github-client.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const deadline = performance.now() + 120000;
  let bytes = 0;
  const sdk = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    allowRequest: (method, url) => method === "POST" && url.pathname === "/graphql",
    reserve: () => ({
      consumeBytes(received) {
        bytes += received;
        if (bytes > 16 * 1024 * 1024)
          throw new GitHubApiError("budget_exhausted", "Closing inventory budget exhausted");
      },
      settle() {},
    }),
  });
  const observation = await readClosingRelationshipsGraphql(sdk, repository, number);
  return { observation, manual: closingInventoryFindings(observation, repository) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const number = Number(process.env.PR_NUMBER);
  const summary = (line: string) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  try {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      throw new Error("GITHUB_REPOSITORY and a positive PR_NUMBER are required");
    const { observation, manual } = await closingInventoryCheck(repository, number);
    summary(
      `Closing inventory for #${number} at ${observation.head}: ${observation.relationships.join(", ") || "none"}.`,
    );
    if (manual.length) {
      summary(
        `Manual Development links are not named by a closing keyword: ${manual.join(", ")}. Name them with a closing keyword in the PR body or remove the link.`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    summary(`Closing inventory is unknown: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
