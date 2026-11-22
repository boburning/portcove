import { useState } from "react";
import { savedScanResultIdentity } from "../features/game-file-discovery/use-game-file-scan";
import type { GameFileScanSnapshot } from "../types";
import type { TFunction } from "i18next";
import { countMessage, useAppTranslation } from "../localization";
import { focusRegion } from "../focus";
import { Button } from "./ui/button";
import { Notice } from "./ui/patterns";

export function savedScanSummary(t: TFunction<"gameFiles">, snapshot: GameFileScanSnapshot) {
  const exact = snapshot.matches?.exact_matches ?? snapshot.report.candidates.length;
  const label = snapshot.coverage?.can_resume
    ? t("savedScan.progress")
    : snapshot.coverage?.frontier_exhausted === false || snapshot.report.limits_reached.length
      ? t("savedScan.partial")
      : t("savedScan.saved");
  return label + " " + countMessage(exact, "exactMatches");
}

export function SavedScanFeedback({
  snapshot,
  show,
  open,
}: {
  snapshot: GameFileScanSnapshot | undefined;
  show: boolean;
  open: (identity: string) => void;
}) {
  const { t } = useAppTranslation("gameFiles");
  const [dismissed, setDismissed] = useState<string>();
  const identity = savedScanResultIdentity(snapshot);
  if (!show || !snapshot || !identity || dismissed === identity) return null;
  return (
    <Notice
      intent="neutral"
      role="group"
      aria-label={t("savedScan.label")}
      className="items-center"
    >
      <p data-slot="notice-body">{savedScanSummary(t, snapshot)}</p>
      <div data-slot="notice-actions">
        {snapshot.freshness === "inputs_match" && (
          <Button
            data-focusable
            variant="outline"
            size="sm"
            onClick={() => open(identity)}
            data-scan-result-trigger={identity}
          >
            {t("savedScan.review")}
          </Button>
        )}
        <Button
          data-focusable
          variant="ghost"
          size="sm"
          onClick={() => {
            setDismissed(identity);
            focusRegion("workspace");
          }}
        >
          {t("savedScan.dismiss")}
        </Button>
      </div>
    </Notice>
  );
}
