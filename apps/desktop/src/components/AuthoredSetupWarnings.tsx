import secondHunt from "../../../../crates/portcove-core/catalog/ports/bountyhunterkanden-secondhunt.json";
import type { PortStatus } from "../types";

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

// Keep the inspected startup hazard visible when an older directory provides
// this listing. The authored guide owns the exact version and filename scope.
const secondHuntStartupWarning = secondHunt.listing.manual_setup.warnings[0]!;

export function setupWarningsBeforeAction(portId: string, warnings: readonly string[] = []) {
  return portId === secondHunt.listing.id && !warnings.includes(secondHuntStartupWarning)
    ? [secondHuntStartupWarning, ...warnings]
    : warnings;
}

export function ExternalLaunchWarnings({
  portId,
  status,
}: {
  portId: string;
  status?: PortStatus | undefined;
}) {
  if (portId !== secondHunt.listing.id || status?.external_runtime?.platform !== "windows-x86-64")
    return null;
  return <AuthoredSetupWarnings warnings={[secondHuntStartupWarning]} />;
}
