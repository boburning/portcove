/** The narrow shell reads in document flow; wide workspaces scroll independently. */
function scrollOwner(workspace: HTMLElement | null | undefined) {
  if (!workspace) return undefined;
  const document = workspace.ownerDocument;
  return document.defaultView?.getComputedStyle(workspace).overflowY === "visible"
    ? (document.scrollingElement ?? document.documentElement)
    : workspace;
}

export function workspaceScrollTop(workspace: HTMLElement | null | undefined) {
  return scrollOwner(workspace)?.scrollTop ?? 0;
}

export function scrollWorkspaceTo(workspace: HTMLElement | null | undefined, top: number) {
  scrollOwner(workspace)?.scrollTo({ top });
}
