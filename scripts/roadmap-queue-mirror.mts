import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only projection of the Project-derived readiness queue for readers that
 * cannot query GitHub Projects (for example cloud agent sessions limited to
 * repository-scoped REST). The Project stays the sole planning authority; this
 * comment is overwritten on every run and is never edited or consumed as state.
 */
export const mirrorMarker = "<!-- portcove-roadmap-queue-mirror -->";
export const mirrorIssue = 2414;
const repository = "boburning/portcove";
const maximumBodyCharacters = 60000;

export function renderQueueMirror(input: {
  readiness: string;
  release: string;
  generatedAt: string;
  commit: string;
}) {
  if (!input.readiness.startsWith(`# ${input.release} readiness`))
    throw new Error("Readiness output is not the requested release summary");
  const header = `${mirrorMarker}\n# ${input.release} queue mirror\n\n> Derived, read-only projection of the live [Portcove Roadmap](https://github.com/users/boburning/projects/1). The Project remains the planning authority and is overwritten here on every run. Refresh Project state before acting on it, and treat an absent or truncated list as UNKNOWN.\n\n- Generated: ${input.generatedAt}\n- Commit: \`${input.commit}\`\n\n`;
  const budget = maximumBodyCharacters - header.length - 200;
  let body = input.readiness.trim();
  if (body.length > budget) {
    body = `${body.slice(0, body.lastIndexOf("\n", budget))}\n\n**Truncated: the remaining items are UNKNOWN.** Run \`node scripts/roadmap.mts readiness --release "${input.release}"\` with Project access.`;
  }
  return `${header}${body}\n`;
}

type Comment = { id: number; body?: string; user?: { login?: string; type?: string } };

export function selectMirrorComment(comments: readonly Comment[]) {
  const found = comments.filter(
    (comment) =>
      comment.user?.type === "Bot" &&
      comment.user.login === "github-actions[bot]" &&
      typeof comment.body === "string" &&
      comment.body.startsWith(mirrorMarker),
  );
  if (found.length > 1)
    throw new Error("Multiple queue mirror comments; reconcile before publishing");
  return found[0];
}

async function api(token: string, method: string, url: string, body?: string) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify({ body }) }),
  });
  if (!response.ok)
    throw new Error(`${method} ${new URL(url).pathname} failed: ${response.status}`);
  return response;
}

async function publish(token: string, body: string) {
  const base = `https://api.github.com/repos/${repository}/issues`;
  const comments: Comment[] = [];
  let next: string | undefined = `${base}/${mirrorIssue}/comments?per_page=100`;
  while (next) {
    const page = await api(token, "GET", next);
    comments.push(...((await page.json()) as Comment[]));
    next = /<([^>]+)>;\s*rel="next"/u.exec(page.headers.get("link") ?? "")?.[1];
  }
  const existing = selectMirrorComment(comments);
  if (existing) await api(token, "PATCH", `${base}/comments/${existing.id}`, body);
  else await api(token, "POST", `${base}/${mirrorIssue}/comments`, body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, file, output] = process.argv.slice(2);
  try {
    if (operation === "render" && file && output) {
      writeFileSync(
        output,
        renderQueueMirror({
          readiness: readFileSync(file, "utf8"),
          release: process.env.MIRROR_RELEASE ?? "Public beta",
          generatedAt: new Date().toISOString(),
          commit: process.env.GITHUB_SHA ?? "unknown",
        }),
      );
    } else if (operation === "publish" && file) {
      const token = process.env.GH_TOKEN;
      if (!token) throw new Error("Publishing requires GH_TOKEN");
      await publish(token, readFileSync(file, "utf8"));
    } else
      throw new Error("Usage: roadmap-queue-mirror.mts render <readiness> <body> | publish <body>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Queue mirror failed");
    process.exitCode = 1;
  }
}
