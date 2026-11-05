import type { CatalogEntry } from "../features/browsing/catalog-entry";

/** Authored cautions stay visible before setup, download and route-change decisions. */
export function AuthoredSetupWarnings({ warnings }: { warnings?: readonly string[] | undefined }) {
  if (!warnings?.length) return null;
  return (
    <aside
      aria-label="Before you begin"
      className="border-pc-warning rounded-pc-md border bg-pc-warning-subtle p-3 text-pc-warning-foreground"
    >
      <h4 className="font-semibold">Before you begin</h4>
      <ul className="mt-2 grid list-disc gap-2 pl-5">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </aside>
  );
}

export function ExternalLaunchWarnings({ port }: { port: CatalogEntry }) {
  const warnings = port.listingStatus?.capabilities?.advisories
    .filter(
      ({ notice, applicability }) => notice.feature === "launch" && applicability !== "historical",
    )
    .map(({ notice }) => notice.explanation);
  return <AuthoredSetupWarnings warnings={warnings} />;
}
