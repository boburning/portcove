// Keep diff-selected formatting aligned with the repository-owned Oxfmt inventory.
const excludedPath =
  /^(?:node_modules\/|apps\/desktop\/(?:dist|node_modules|src-tauri\/gen)\/|target\/|work\/|outputs\/|release-assets\/|\.codex-remote-attachments\/|\.fallow(?:-review)?\/|\.rscheck\/|\.tmp\/|mutants\.out(?:\.old)?\/|Portcove-CI-FiveMinutes\/|integrations\/playnite\/(?:bin|obj|tests\/(?:bin|obj))\/|crates\/portcove-core\/catalog\/|crates\/[^/]+\/tests\/fixtures\/|docs\/archive\/|docs\/releases\/[0-9][^/]*\.md$)/;
const excludedFile =
  /(?:\.generated\.[^/]+$|(?:^|\/)pnpm-lock\.yaml$|integrations\/playnite\/(?:tests\/)?packages\.lock\.json$)/;

export function isExcludedOxfmtPath(file) {
  return excludedPath.test(file) || excludedFile.test(file);
}
