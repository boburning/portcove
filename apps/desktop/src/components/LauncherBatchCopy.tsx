import { useEffect, useRef, useState } from "react";
import { FolderInput } from "lucide-react";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import type { AdoptionBatchItem, AdoptionBatchPreview, AdoptionBatchResult } from "../types";

export type LauncherBatchSelection = { item: AdoptionBatchItem; label: string };

/** Core refuses larger batches; the list keeps selections within it. */
export const LAUNCHER_BATCH_LIMIT = 32;

const OUTCOME_LABELS: Record<AdoptionBatchResult["items"][number]["outcome"], string> = {
  copied: "Copied",
  changed: "Changed after review; not copied",
  failed: "Not copied",
};

/** Complete per-count messages; English suffixes are never appended. */
function apps(count: number) {
  return count === 1 ? "1 app" : `${count} apps`;
}
function files(count: number) {
  return count === 1 ? "1 file" : `${count} files`;
}

/**
 * Reviews the selected launcher apps as one batch and copies them after one native
 * confirmation. Core re-reviews each app just before copying it.
 */
export function LauncherBatchCopy({
  selection,
  disabled,
  reviewBatch,
  copyBatch,
  copied,
  gameName = (portId) => portId,
}: {
  selection: readonly LauncherBatchSelection[];
  disabled: boolean;
  reviewBatch: (items: AdoptionBatchItem[]) => Promise<AdoptionBatchPreview | undefined>;
  copyBatch: (
    items: AdoptionBatchItem[],
    batchSha256: string,
  ) => Promise<AdoptionBatchResult | null | undefined>;
  /** Called after a copy ran, so copied apps are not offered again. */
  copied: () => void;
  gameName?: (portId: string) => string;
}) {
  const [preview, setPreview] = useState<AdoptionBatchPreview>();
  const [result, setResult] = useState<{
    value: AdoptionBatchResult;
    labels: ReadonlyMap<string, string>;
  }>();
  const [phase, setPhase] = useState<"idle" | "reviewing" | "copying">("idle");
  const resultRef = useRef<HTMLParagraphElement>(null);
  // A review belongs to exactly the selection it was made for.
  const key = selection.map(({ item }) => `${item.source}\n${item.port_id}`).join("\n--\n");
  const [reviewedKey, setReviewedKey] = useState<string>();
  const current = preview && reviewedKey === key ? preview : undefined;
  const label = (source: string) =>
    selection.find(({ item }) => item.source === source)?.label ?? source;
  const items = selection.map(({ item }) => item);
  const busy = disabled || phase !== "idle";
  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);
  return (
    <section aria-label="Copy several apps" className="mt-3">
      <p className="text-[var(--color-text-secondary)]">
        {selection.length === 0
          ? "Select apps above to copy several at once."
          : selection.length === 1
            ? "1 app selected. Select at least one more to copy them together, or review it on its own above."
            : `${apps(selection.length)} selected.`}
      </p>
      <Button
        data-focusable
        type="button"
        variant="outline"
        disabled={busy || selection.length < 2}
        onClick={() => {
          setPhase("reviewing");
          setResult(undefined);
          void reviewBatch(items)
            .then((reviewed) => {
              setPreview(reviewed);
              setReviewedKey(reviewed ? key : undefined);
            })
            .finally(() => setPhase("idle"));
        }}
      >
        <Icon glyph={FolderInput} />
        {phase === "reviewing" ? "Reviewing…" : "Review copying the selected apps"}
      </Button>
      {current && (
        <div
          className="mt-3 rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-3 [overflow-wrap:anywhere]"
          aria-label="Several apps copy plan"
          role="group"
        >
          <p>
            <strong>{apps(current.items.length)}</strong> · {files(current.total_files)} ·{" "}
            {formatBytes(current.total_bytes)} to copy into Portcove.
          </p>
          <ul className="ps-5">
            {current.items.map((item) => (
              <li key={item.source}>
                {label(item.source)} → {gameName(item.selected_port_id ?? "")}
                {item.destination?.active_install && (
                  <>
                    <br />
                    <small>
                      Becomes the active version; {item.destination.active_install.version} stays
                      installed.
                    </small>
                  </>
                )}
                {(item.destination?.imported_user_data_paths.length ?? 0) > 0 && (
                  <>
                    <br />
                    <small>Saved files are copied in.</small>
                  </>
                )}
                {item.copy_plan.skipped_entries.length > 0 && (
                  <>
                    <br />
                    <small className="text-[var(--color-warning-text)]">
                      {item.copy_plan.skipped_entries.length === 1
                        ? "1 unsupported item stays only in the original folder."
                        : `${item.copy_plan.skipped_entries.length} unsupported items stay only in the original folder.`}
                    </small>
                  </>
                )}
              </li>
            ))}
          </ul>
          {current.items_replacing_saved_files > 0 && (
            <p role="note" className="text-[var(--color-warning-text)]">
              {current.items_replacing_saved_files === 1
                ? "For 1 game, matching saved files already in Portcove are replaced."
                : `For ${current.items_replacing_saved_files} games, matching saved files already in Portcove are replaced.`}{" "}
              Portcove does not create a backup first, and removing a copy later does not restore
              them.
            </p>
          )}
          <p className="text-[var(--color-text-secondary)]">
            Each app is checked again just before it is copied; one that changed is held, not
            copied. The original folders stay unchanged. Stop the games before copying.
          </p>
          <Button
            data-focusable
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => {
              const labels = new Map(selection.map(({ item, label }) => [item.source, label]));
              setPhase("copying");
              void copyBatch(items, current.batch_sha256)
                .then((value) => {
                  if (value) {
                    setResult({ value, labels });
                    setPreview(undefined);
                    copied();
                  }
                })
                .finally(() => setPhase("idle"));
            }}
          >
            <Icon glyph={FolderInput} />
            {phase === "copying"
              ? "Waiting for confirmation or copying…"
              : "Continue to copy confirmation"}
          </Button>
        </div>
      )}
      <div aria-live="polite">
        {result && (
          <div className="mt-3" role="group" aria-label="Several apps copy result">
            <p
              ref={resultRef}
              tabIndex={-1}
              className="rounded-sm focus:outline-2 focus:outline-offset-2 focus:outline-pc-ring"
            >
              Copied {apps(result.value.items.filter((item) => item.outcome === "copied").length)}{" "}
              of {result.value.items.length}.
            </p>
            <ul className="ps-5">
              {result.value.items.map((item) => (
                <li key={item.source}>
                  {result.labels.get(item.source) ?? item.source}: {OUTCOME_LABELS[item.outcome]}
                  {item.message && (
                    <>
                      <br />
                      <small className="text-[var(--color-text-secondary)]">{item.message}</small>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
