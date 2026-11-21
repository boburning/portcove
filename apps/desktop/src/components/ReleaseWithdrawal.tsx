import type { PortStatus } from "../types";
import { Button } from "./ui/button";

function withdrawal(status: PortStatus | undefined) {
  const holds = status?.definition_operations?.filter(
    ({ operation, eligibility }) =>
      operation === "install" &&
      eligibility.outcome === "hold" &&
      eligibility.reason === "curated_distribution_withdrawn",
  );
  if (status?.active && holds?.some(({ retained }) => retained)) return "installed";
  if (holds?.some(({ retained }) => !retained)) return "recommended";
  return null;
}

export function ReleaseWithdrawalBadge({ status }: { status: PortStatus | undefined }) {
  const target = withdrawal(status);
  if (!target) return null;
  return (
    <span className="inline-flex rounded-sm border border-pc-border px-1.5 py-0.5 text-xs font-semibold">
      {target === "installed" ? "Installed release withdrawn" : "Recommended release withdrawn"}
    </span>
  );
}

export function ReleaseWithdrawalNotice({
  status,
  reviewVersions,
}: {
  status: PortStatus | undefined;
  reviewVersions: () => void;
}) {
  const target = withdrawal(status);
  if (!target) return null;
  const installed = target === "installed";
  const canRollBack =
    installed &&
    status?.previous &&
    status.port_actions?.some(
      ({ action, availability }) => action === "rollback" && availability === "allowed",
    );
  return (
    <section
      aria-label="Withdrawn release"
      className="grid justify-items-start gap-2 rounded-pc-md border border-pc-border bg-pc-surface p-4"
    >
      <p className="m-0 font-semibold">
        {installed
          ? `Installed release ${status?.active?.version ?? ""} withdrawn by the catalog maintainer.`
          : "The recommended release was withdrawn by the catalog maintainer."}
      </p>
      <p className="m-0 text-sm text-pc-muted-foreground">
        {installed
          ? "You can keep your installed copy and its saves. Play remains available if your installation meets the existing launch checks."
          : "Wait for a compatible release or review the available versions."}
      </p>
      {canRollBack && (
        <Button variant="outline" onClick={reviewVersions}>
          Review rollback
        </Button>
      )}
      {!installed && (
        <Button variant="outline" onClick={reviewVersions}>
          View versions
        </Button>
      )}
    </section>
  );
}
