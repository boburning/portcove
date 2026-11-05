/** Navigation only. Provider facts and package permissions remain Core-owned. */
export function upstreamUpdatesDestination(projectUrl: string, releaseUrl?: string | null) {
  for (const value of [releaseUrl, projectUrl]) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port) continue;
    const parts = url.pathname.replace(/\/$/u, "").split("/").slice(1);
    const component = (part: string) =>
      /^[a-zA-Z0-9_.-]+$/u.test(part) && part !== "." && part !== "..";
    if (url.hostname === "github.com" && parts.length >= 2 && parts.slice(0, 2).every(component)) {
      // Accept project and release routes, not unrelated provider account pages.
      if (parts.length !== 2 && parts[2] !== "releases") continue;
      const name = parts[1]!.replace(/\.git$/u, "");
      if (!component(name)) continue;
      const repository = `${parts[0]}/${name}`;
      return { url: `https://github.com/${repository}/releases`, releases: true };
    }
    if (url.hostname === "gitlab.com") {
      const separator = parts.indexOf("-");
      const project = separator === -1 ? parts : parts.slice(0, separator);
      if (
        project.length < 2 ||
        !project.every(component) ||
        (separator !== -1 && parts[separator + 1] !== "releases")
      )
        continue;
      project[project.length - 1] = project.at(-1)!.replace(/\.git$/u, "");
      if (!project.every(component)) continue;
      return { url: `https://gitlab.com/${project.join("/")}/-/releases`, releases: true };
    }
  }
  // A custom site's release URL may be historical evidence. Its project page
  // is the accurate fallback when a stable update destination is not known.
  return { url: projectUrl, releases: false };
}
