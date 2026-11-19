/** Presentation only: Core validates the reviewed links and decides what may be opened. */
export interface FundingLink {
  url: string;
  /** Platform or site name; brand names are not translated. */
  label: string;
  /** The account on a known platform, or the page path when links would look alike. */
  detail?: string | undefined;
}

const platforms: readonly (readonly [host: string, label: string, prefix: string])[] = [
  ["github.com", "GitHub Sponsors", "/sponsors/"],
  ["patreon.com", "Patreon", "/"],
  ["opencollective.com", "Open Collective", "/"],
  ["ko-fi.com", "Ko-fi", "/"],
  ["liberapay.com", "Liberapay", "/"],
  ["buymeacoffee.com", "Buy Me a Coffee", "/"],
  ["paypal.me", "PayPal", "/"],
  ["paypal.com", "PayPal", ""],
];
const accountSegment = /^[A-Za-z0-9_.-]+$/u;

/** One labelled link per distinct HTTPS URL, in catalog order. */
export function fundingLinks(urls: readonly string[] | null | undefined): FundingLink[] {
  const links: (FundingLink & { parsed: URL })[] = [];
  for (const value of new Set(urls ?? [])) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const host = url.hostname.replace(/^www\./u, "");
    const platform = platforms.find(
      ([known, , prefix]) => host === known && (prefix === "" || url.pathname.startsWith(prefix)),
    );
    if (!platform) {
      links.push({ url: value, label: host, parsed: url });
      continue;
    }
    const [, label, prefix] = platform;
    // Only a single plain path segment names an account; `/join/x` or `/s/x` do not.
    const rest = prefix ? url.pathname.slice(prefix.length).replace(/\/$/u, "") : "";
    const account = accountSegment.test(rest) ? rest : undefined;
    links.push({ url: value, label, detail: account, parsed: url });
  }
  // Links that would read the same are told apart by their page.
  const shown = (link: FundingLink) => `${link.label}\u0000${link.detail ?? ""}`;
  return links.map(({ parsed, ...link }) =>
    links.filter((other) => shown(other) === shown(link)).length > 1
      ? { ...link, detail: pagePath(parsed) }
      : link,
  );
}

function pagePath(url: URL) {
  let path = `${url.pathname}${url.search}${url.hash}`.replace(/^\//u, "");
  try {
    path = decodeURI(path);
  } catch {
    // Keep the encoded form when it does not decode.
  }
  return path.length > 48 ? `${path.slice(0, 47)}…` : path || "/";
}
