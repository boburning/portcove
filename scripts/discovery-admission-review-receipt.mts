import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { inspectBoundedZip } from "./bounded-zip.mts";
import { downloadGitHubArtifactArchive } from "./github-artifact-download.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { createGitHubClient } from "./github-client.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const repositoryId = 1354613114;
const workflow = ".github/workflows/catalog-admission.yml";
const workflowId = 432038839;
const leaf = "catalog-admission-review.json";
const receiptLimit = 16 * 1024;
const gitSha = /^[a-f0-9]{40}$/u;

type ReviewRequest = {
  review: string;
  producer: string;
  pull: number;
  source: string;
  head: string;
  tree: string;
};

function locator(value: string) {
  const fields = value.split("/");
  if (
    fields.length !== 2 ||
    fields.some((field) => !/^[1-9]\d*$/u.test(field) || !Number.isSafeInteger(Number(field)))
  )
    throw new Error("Expected an exact RUN/ATTEMPT locator.");
  return { run: Number(fields[0]), attempt: Number(fields[1]) };
}

async function reviewReader(routes: readonly string[]) {
  const deadline = performance.now() + 90_000;
  const credential = localDeveloperCredential({ deadline });
  const client = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 1024 * 1024,
    allowRequest: (method, url) =>
      method === "GET" && routes.includes(`${url.pathname.slice(1)}${url.search}`),
  });
  return async (route: string): Promise<unknown> =>
    routes.includes(route)
      ? (await client.request({ method: "GET", url: `https://api.github.com/${route}` })).data
      : downloadGitHubArtifactArchive(route, { credential, deadline, maxBytes: receiptLimit });
}

/** Evidence for a future guarded delivery step, never permission to merge. */
export async function verifyCatalogAdmissionReview(
  request: ReviewRequest,
  read?: (route: string) => Promise<unknown>,
) {
  const { run, attempt } = locator(request.review);
  const producer = locator(request.producer);
  if (
    !Number.isSafeInteger(request.pull) ||
    request.pull < 1 ||
    ![request.source, request.head, request.tree].every((value) => gitSha.test(value))
  )
    throw new Error("Expected the exact admission proposal and Git identities.");

  const route = `repos/${repository}/actions/runs/${run}`;
  const attemptRoute = `${route}/attempts/${attempt}`;
  const jobsRoute = `${attemptRoute}/jobs?per_page=100`;
  const artifactName = `catalog-admission-review-${run}-${attempt}`;
  const artifactRoute = `${route}/artifacts?name=${artifactName}&per_page=100`;
  const load = read ?? (await reviewReader([attemptRoute, jobsRoute, artifactRoute]));
  const [review, jobs, artifacts] = await Promise.all([
    load(attemptRoute),
    load(jobsRoute),
    load(artifactRoute),
  ]);
  if (
    !isRecord(review) ||
    review.id !== run ||
    review.run_attempt !== attempt ||
    review.workflow_id !== workflowId ||
    review.path !== workflow ||
    review.status !== "completed" ||
    review.event !== "workflow_run" ||
    review.head_branch !== "main" ||
    !isRecord(review.repository) ||
    review.repository.id !== repositoryId ||
    !isRecord(review.head_repository) ||
    review.head_repository.id !== repositoryId ||
    typeof review.head_sha !== "string" ||
    !gitSha.test(review.head_sha)
  )
    throw new Error("Expected a completed catalog admission review on main.");
  if (!isRecord(jobs) || !Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)
    throw new Error("Admission review job enumeration is incomplete.");
  const reviewers = (jobs.jobs as unknown[]).filter(
    (job) => isRecord(job) && job.name === "review",
  );
  const job = reviewers[0];
  if (
    reviewers.length !== 1 ||
    !isRecord(job) ||
    job.run_id !== run ||
    job.run_attempt !== attempt ||
    job.head_sha !== review.head_sha ||
    job.conclusion !== "success" ||
    !Array.isArray(job.steps) ||
    !["Independently replay the exact draft tree", "Retain the independent replay receipt"].every(
      (name) =>
        (job.steps as unknown[]).filter(
          (step) => isRecord(step) && step.name === name && step.conclusion === "success",
        ).length === 1,
    )
  )
    throw new Error("Expected exact replay verification and a successful receipt upload.");

  if (
    !isRecord(artifacts) ||
    artifacts.total_count !== 1 ||
    !Array.isArray(artifacts.artifacts) ||
    artifacts.artifacts.length !== 1
  )
    throw new Error("Expected exactly one retained admission review receipt.");
  const artifact: unknown = artifacts.artifacts[0];
  if (
    !isRecord(artifact) ||
    artifact.name !== artifactName ||
    artifact.expired !== false ||
    typeof artifact.id !== "number" ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    typeof artifact.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
    !isRecord(artifact.workflow_run) ||
    artifact.workflow_run.id !== run ||
    artifact.workflow_run.repository_id !== repositoryId ||
    artifact.workflow_run.head_repository_id !== repositoryId ||
    artifact.workflow_run.head_branch !== "main" ||
    artifact.workflow_run.head_sha !== review.head_sha
  )
    throw new Error("Admission review artifact differs from the exact workflow attempt.");
  const archive = await load(`repos/${repository}/actions/artifacts/${artifact.id}/zip`);
  if (
    !Buffer.isBuffer(archive) ||
    `sha256:${createHash("sha256").update(archive).digest("hex")}` !== artifact.digest
  )
    throw new Error("Admission review archive differs from GitHub's artifact digest.");
  const { entries } = inspectBoundedZip(
    archive,
    {
      compressedBytes: receiptLimit,
      expandedBytes: receiptLimit,
      files: 1,
      nameBytes: 64,
      allowedPaths: new Set([leaf]),
    },
    { deadline: Date.now() + 1_000 },
  );
  const entry = entries[0];
  if (!entry || entries.length !== 1) throw new Error("Admission review archive has no receipt.");
  const payload = archive.subarray(entry.data, entry.dataEnd);
  const bytes =
    entry.method === 0
      ? payload
      : inflateRawSync(payload, { maxOutputLength: Math.max(1, entry.bytes) });
  if (bytes.length !== entry.bytes || crc32(bytes) !== entry.crc)
    throw new Error("Admission review receipt member integrity differs.");
  const body: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 7 ||
    body.format_version !== 1 ||
    body.discovery_run !== String(producer.run) ||
    body.discovery_attempt !== String(producer.attempt) ||
    body.source !== request.source ||
    body.head !== request.head ||
    body.tree !== request.tree ||
    body.pull_request !== request.pull
  )
    throw new Error("Admission review receipt differs from the exact proposal or producer.");
  return {
    ...body,
    review: request.review,
    controller: review.head_sha,
    artifact: artifact.id,
    digest: artifact.digest,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      review: { type: "string" },
      producer: { type: "string" },
      pull: { type: "string" },
      source: { type: "string" },
      head: { type: "string" },
      tree: { type: "string" },
    },
  });
  const { review, producer, pull, source, head, tree } = values;
  if (!review || !producer || !pull || !/^[1-9]\d*$/u.test(pull) || !source || !head || !tree)
    throw new Error(
      "Use --review RUN/ATTEMPT --producer RUN/ATTEMPT --pull NUMBER --source SHA --head SHA --tree SHA.",
    );
  console.log(
    JSON.stringify(
      await verifyCatalogAdmissionReview({
        review,
        producer,
        pull: Number(pull),
        source,
        head,
        tree,
      }),
    ),
  );
}
