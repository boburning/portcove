import { cn } from "cn";
import { LoaderCircle } from "lucide-react";
import type { OperationEvent } from "../types";
import { progressPresentation } from "../view-model";
import { Icon } from "./ui";

export function OperationProgress({
  operation,
  busy,
  embedded = false,
  announcePhase = true,
}: {
  operation?: OperationEvent | undefined;
  busy: string;
  embedded?: boolean;
  announcePhase?: boolean;
}) {
  const { label, detail, range } = progressPresentation(operation, busy);
  return (
    <div
      className={cn(
        "operation-bar mb-4 grid grid-cols-[auto_minmax(8rem,_auto)_minmax(12rem,_1fr)] items-center gap-3 rounded-pc-md border border-pc-info bg-pc-info-subtle px-3 py-2 text-xs text-pc-muted-foreground",
        embedded && "operation-progress-embedded",
      )}
    >
      <span className="text-pc-info-foreground motion-safe:[&_.icon]:animate-spin">
        <Icon glyph={LoaderCircle} />
      </span>
      <div className="min-w-0 break-words">
        <strong
          className="block font-medium text-pc-foreground"
          role={announcePhase ? "status" : undefined}
          aria-live={announcePhase ? "polite" : undefined}
          aria-atomic={announcePhase ? "true" : undefined}
        >
          {label}
        </strong>
        <span className="mt-0.5 block">{detail}</span>
      </div>
      <div
        className={`progress-track h-[5px] overflow-hidden rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)]${range ? "" : " indeterminate"}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={range ? 0 : undefined}
        aria-valuemax={range?.total}
        aria-valuenow={range?.current}
        aria-valuetext={detail}
      >
        <i
          className={cn(
            "block h-full bg-pc-loading motion-safe:transition-[width] motion-safe:duration-300 motion-reduce:animate-none",
            !range && "w-[32%] animate-pc-progress",
          )}
          style={range ? { width: `${range.percent}%` } : undefined}
        />
      </div>
    </div>
  );
}
