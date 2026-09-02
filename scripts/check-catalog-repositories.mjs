import { readFile } from "node:fs/promises";

const catalogPath = new URL("../crates/portcove-core/catalog/catalog.json", import.meta.url);
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const hosted = catalog.ports.filter(port => (port.release.provider ?? "github") !== "direct-manifest");
const repositories = [...new Map(hosted.map(port => [
  `${port.release.provider ?? "github"}:${port.release.repository}`,
  { provider: port.release.provider ?? "github", repository: port.release.repository },
])).values()];
const githubHeaders = { Accept: "application/vnd.github+json", "User-Agent": "Portcove-catalog-audit" };
if (process.env.GITHUB_TOKEN) githubHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const gitlabHeaders = { "User-Agent": "Portcove-catalog-audit" };
if (process.env.GITLAB_TOKEN) gitlabHeaders["PRIVATE-TOKEN"] = process.env.GITLAB_TOKEN;

const failures = [];
for (const { provider, repository } of repositories) {
  const url = provider === "gitlab"
    ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(repository)}`
    : `https://api.github.com/repos/${repository}`;
  const response = await fetch(url, { headers: provider === "gitlab" ? gitlabHeaders : githubHeaders });
  if (!response.ok) {
    failures.push(`${repository}: ${provider} returned ${response.status}`);
    continue;
  }
  const metadata = await response.json();
  if (metadata.archived) failures.push(`${repository}: repository is archived`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Verified ${repositories.length} active hosted catalog repositories.`);
