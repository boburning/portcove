/** Presentation only: Core validates the reviewed links and decides what may be opened. */
export interface FundingLink {
  url: string;
  /** Platform or site name; brand names are not translated. */
  label: string;
  /** The account on a known platform, when the link names one. */
  account?: string | undefined;
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

/** One labelled link per distinct HTTPS URL, in catalog order. */
export function fundingLinks(urls: readonly string[] | undefined): FundingLink[] {
  const links: FundingLink[] = [];
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
      links.push({ url: value, label: host });
      continue;
    }
    const [, label, prefix] = platform;
    const account = prefix ? url.pathname.slice(prefix.length).split("/")[0] : "";
    links.push({ url: value, label, account: account ? decodeSegment(account) : undefined });
  }
  return links;
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
