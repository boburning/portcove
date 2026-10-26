function diagnosticText(value: unknown): string {
  return String(value);
}

export interface RoadmapFieldValue {
  name?: unknown;
  value?: unknown;
  field?: { name?: unknown } | null;
  option?: { name?: unknown } | null;
}
export interface RoadmapIssueItem {
  id?: string | undefined;
  number?: number | string | undefined;
  type?: string | undefined;
  __typename?: string | undefined;
  title?: string | null | undefined;
  body?: string | null | undefined;
  url?: string | null | undefined;
  state?: string | null | undefined;
  content?: RoadmapIssueItem | null;
  fieldValues?: readonly RoadmapFieldValue[] | undefined;
  blockedBy?:
    | readonly RoadmapIssueItem[]
    | { nodes?: readonly RoadmapIssueItem[]; totalCount?: number }
    | null;
  // The CLI normalizes configurable Project field names onto the item itself.
  // Their values remain untrusted and fieldValue preserves direct-key precedence.
  [fieldName: string]: unknown;
}

export function captureText(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error("Required issue marker capture is missing");
  return value;
}

export const portMarker = "<!-- portcove-port -->";
export const portTitlePrefix = /^\s*\[port\]\s*/i;
export const canonicalPortTitlePrefix = /^\[Port\]\s+\S/;
const portFormLabels = Object.freeze({
  upstream: "Direct upstream URL",
  portKey: "Durable game or target key",
});

export function portCatalogMarkers(body: unknown) {
  return [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-catalog-id:\s*([^\s>]+)\s*-->/gi),
  ].map((match) => captureText(match, 1));
}

export function portUpstreamMarkers(body: unknown) {
  return [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-upstream:\s*([^\s>]+)\s*-->/gi),
  ].map((match) => captureText(match, 1));
}

export function portKeyMarkers(body: unknown) {
  return [
    ...diagnosticText(body ?? "").matchAll(/<!--\s*portcove-port-key:\s*([^\s>]+)\s*-->/gi),
  ].map((match) => captureText(match, 1));
}

export function normalizePortKey(value: unknown) {
  return diagnosticText(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizedPortTitle(value: unknown) {
  return normalizePortKey(diagnosticText(value ?? "").replace(portTitlePrefix, ""));
}

function normalizedUpstream(value: unknown) {
  try {
    const parsed = new URL(diagnosticText(value));
    const pathname = parsed.pathname.replace(/\/+$/g, "").replace(/\.git$/i, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname.toLowerCase()}`;
  } catch {
    return diagnosticText(value ?? "")
      .trim()
      .replace(/\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
  }
}

export function issueNumber(item: RoadmapIssueItem | null | undefined) {
  const direct = Number(item?.content?.number ?? item?.number);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const match = String(itemUrl(item) ?? "").match(/\/issues\/(\d+)(?:$|[?#])/i);
  return match ? Number(match[1]) : null;
}

function repositoryIssueContent(item: RoadmapIssueItem): RoadmapIssueItem {
  return item?.content?.type === "Issue" || item?.content?.__typename === "Issue"
    ? item.content
    : item;
}

function isOpenPortTitleIssue(issue: RoadmapIssueItem) {
  return repositoryState(issue) === "open" && portTitlePrefix.test(itemTitle(issue));
}

export function discoveredPortIssues(issues: readonly RoadmapIssueItem[] | null | undefined) {
  return (issues ?? [])
    .map(repositoryIssueContent)
    .filter((issue) => itemBody(issue).includes(portMarker) || isOpenPortTitleIssue(issue));
}

function issueFormSection(body: unknown, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = diagnosticText(body ?? "").match(
    new RegExp(`^###\\s+${escaped}\\s*$([\\s\\S]*?)(?=^###\\s|(?![\\s\\S]))`, "im"),
  );
  if (!match) return null;
  const value = captureText(match, 1).trim();
  return !value || /^_?No response_?$/i.test(value) ? null : value;
}

export function parsePortIssueForm(body: unknown) {
  const upstream = issueFormSection(body, portFormLabels.upstream);
  if (!upstream) throw new Error(`issue form is missing ${portFormLabels.upstream}`);
  let parsedUrl;
  try {
    parsedUrl = new URL(upstream);
  } catch {
    throw new Error(`${portFormLabels.upstream} must be a valid https URL`);
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${portFormLabels.upstream} must be a valid https URL`);
  }
  const portKey = issueFormSection(body, portFormLabels.portKey);
  if (!portKey) throw new Error(`issue form is missing ${portFormLabels.portKey}`);
  const canonical = normalizePortKey(portKey);
  if (!canonical || canonical !== portKey) {
    throw new Error(
      `durable port key must use canonical lowercase kebab-case: ${canonical || "a-non-empty-key"}`,
    );
  }
  return { upstream, portKey };
}

export function portIdentity(issue: RoadmapIssueItem) {
  const body = itemBody(issue);
  let form: ReturnType<typeof parsePortIssueForm> | null = null;
  if (portTitlePrefix.test(itemTitle(issue))) {
    try {
      form = parsePortIssueForm(body);
    } catch {
      // Invalid form submissions remain discoverable; doctor reports their exact contract errors.
    }
  }
  const ids = portCatalogMarkers(body);
  const keys = portKeyMarkers(body).map(normalizePortKey);
  const upstreams = portUpstreamMarkers(body).map(normalizedUpstream);
  return {
    ids,
    keys: keys.length ? keys : form?.portKey ? [normalizePortKey(form.portKey)] : [],
    upstreams: upstreams.length
      ? upstreams
      : form?.upstream
        ? [normalizedUpstream(form.upstream)]
        : [],
    title: normalizedPortTitle(itemTitle(issue)),
  };
}

export function sourceProvenancePortIdentity(issue: RoadmapIssueItem) {
  const identity = portIdentity(repositoryIssueContent(issue));
  return {
    catalogIds: [...identity.ids],
    portKeys: [...identity.keys],
    upstreams: [...identity.upstreams],
    title: identity.title,
  };
}

export function sourceProvenancePortIssues(issues: readonly RoadmapIssueItem[] | null | undefined) {
  return discoveredPortIssues(issues);
}

export function findPortIssueDuplicates(
  issues: readonly RoadmapIssueItem[] | null | undefined,
  {
    title,
    upstream,
    catalogId,
    portKey,
  }: {
    title: string;
    upstream: string;
    catalogId?: string | null | undefined;
    portKey?: string | null | undefined;
  },
) {
  const candidateTitle = normalizedPortTitle(title);
  const candidateUpstream = normalizedUpstream(upstream);
  const candidateKey = portKey ? normalizePortKey(portKey) : null;
  const candidateIdentity = catalogId ?? candidateKey ?? candidateTitle;
  const matches = [];
  for (const issue of discoveredPortIssues(issues)) {
    const reasons = [];
    const { ids, keys, upstreams, title: titleIdentity } = portIdentity(issue);
    const issueIdentity = ids[0] ?? keys[0] ?? titleIdentity;
    if (catalogId && ids.includes(catalogId)) reasons.push(`catalog ID ${catalogId}`);
    if (candidateKey && keys.includes(candidateKey)) reasons.push(`port key ${candidateKey}`);
    if (candidateTitle && titleIdentity === candidateTitle)
      reasons.push(`normalized title ${candidateTitle}`);
    if (
      candidateUpstream &&
      upstreams.includes(candidateUpstream) &&
      issueIdentity === candidateIdentity
    ) {
      reasons.push("direct upstream plus game/target identity");
    }
    if (reasons.length) matches.push({ issue, reasons: [...new Set(reasons)] });
  }
  return matches;
}

export function reconcilePortIssueMarkers(
  body: unknown,
  {
    upstream,
    catalogId,
    portKey,
  }: {
    upstream: string;
    catalogId?: string | null | undefined;
    portKey?: string | null | undefined;
  },
) {
  const retained = diagnosticText(body ?? "")
    .replace(/^\s*<!--\s*portcove-port\s*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-upstream:\s*[^>]*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-catalog-id:\s*[^>]*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-port-key:\s*[^>]*-->\s*$/gim, "")
    .replace(/^\s*<!--\s*portcove-research:\s*[^>]*-->\s*$/gim, "")
    .trimEnd();
  const identityMarker = catalogId
    ? `<!-- portcove-catalog-id: ${catalogId} -->`
    : `<!-- portcove-port-key: ${portKey} -->\n${renderPortResearchDeclaration()}`;
  return `${retained}\n\n${portMarker}\n<!-- portcove-upstream: ${upstream} -->\n${identityMarker}`;
}

export function isNonCatalogResearchBody(body: string) {
  return (
    body.includes(renderPortResearchDeclaration()) ||
    (/Catalog ID:\s*Not assigned \(researched candidate\)/i.test(body) &&
      /(?:does not grant support|not supported merely|does not change catalog\.json)/i.test(body))
  );
}

export function renderPortResearchDeclaration() {
  return "<!-- portcove-research: catalog=unassigned; support=not-granted -->";
}

export function renderPortIssueBody({
  title,
  upstream,
  catalogId,
  portKey,
  currentEvidence = "Initial intake; evidence pending triage.",
  blocker = "No current blocker has been established. Exact resume condition pending triage.",
}: {
  title: string;
  upstream: string;
  catalogId?: string | null | undefined;
  portKey?: string | null | undefined;
  currentEvidence?: string;
  blocker?: string;
}) {
  const normalizedPortKey = portKey ? normalizePortKey(portKey) : null;
  if (!catalogId && !normalizedPortKey) {
    throw new Error("a non-catalog port requires a durable --port-key");
  }
  if (portKey && normalizedPortKey !== portKey) {
    throw new Error(`port key must use canonical lowercase slug form: ${normalizedPortKey}`);
  }
  const catalogLine = catalogId ?? "Not assigned (researched candidate)";
  const catalogMarker = catalogId ? `\n<!-- portcove-catalog-id: ${catalogId} -->` : "";
  const portKeyLine = normalizedPortKey ?? "Catalog ID is the durable identity";
  const portKeyMarker = normalizedPortKey
    ? `\n<!-- portcove-port-key: ${normalizedPortKey} -->`
    : "";
  return `## User outcome\n\n${title} can be researched, prioritized, qualified, advanced, blocked, and closed independently.\n\n## Current behavior and evidence\n\n${currentEvidence}\n\n## Scope\n\n- Direct upstream: ${upstream}\n- Game/title identity: ${title}\n- Catalog ID: ${catalogLine}\n- Durable port key: ${portKeyLine}\n- Supported and candidate platforms: Unknown until evidenced\n- Release assets and integrity: Pending\n- Source requirements and accepted revisions: Pending\n- Executable/setup boundary: Pending\n- Persistence and user-data boundary: Pending\n- Adapter fit and dependencies: Pending\n- Initial Port stage: Watchlist. The live Port stage is maintained in the Portcove Roadmap.\n- Current blocker and exact resume condition: ${blocker}\n- Automated qualification: Not yet recorded\n- Manual qualification: Not yet recorded\n\n## Non-goals\n\nThis issue does not grant support, expand V1 scope, weaken source or artifact validation, or replace shared engineering dependencies.\n\n## Acceptance criteria\n\n- [ ] Every promised operation and owned port fact has explicit evidence or an honest Unknown/Not run limitation.\n- [ ] The catalog and Project agree with the independently closable port state.\n- [ ] Completion evidence links the implementation and exact qualification results.\n\n## Required tests\n\nValidate applicable admission, source, artifact, archive, executable and lifecycle checks for each promised operation/platform. Record absent optional gameplay evidence as Unknown, not failure. Integration completion does not require personal playtesting; explicit hands-on support claims still require actual observations. Unsupported management operations remain unavailable with reasons.\n\n## Documentation impact\n\nUpdate catalog.json only when actual support or qualification changes; keep mutable priority and stage in the Project.\n\n## Dependencies and blockers\n\n${blocker}\n\n## Completion evidence\n\nNo completion evidence yet.\n\n${portMarker}\n<!-- portcove-upstream: ${upstream} -->${catalogMarker}${portKeyMarker}${catalogId ? "" : `\n${renderPortResearchDeclaration()}`}`;
}

export function itemTitle(item: RoadmapIssueItem | null | undefined) {
  return item?.title ?? item?.content?.title ?? "Untitled";
}

export function itemUrl(item: RoadmapIssueItem | null | undefined) {
  return item?.content?.url ?? item?.url;
}

export function itemBody(item: RoadmapIssueItem | null | undefined) {
  return item?.content?.body ?? item?.body ?? "";
}

export function repositoryState(item: RoadmapIssueItem | null | undefined) {
  return diagnosticText(item?.content?.state ?? item?.state ?? "").toLowerCase();
}
