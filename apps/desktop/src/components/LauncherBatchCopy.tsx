import { useState } from "react";
import { FolderInput } from "lucide-react";
import { formatBytes } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import type { AdoptionBatchItem, AdoptionBatchPreview, AdoptionBatchResult } from "../types";

export type LauncherBatchSelection = { item: AdoptionBatchItem; label: string };

const OUTCOME_LABELS: Record<AdoptionBatchResult["items"][number]["outcome"], string> = {
  copied: "Copied",
  changed: "Changed after review; not copied",
  failed: "Not copied",
};

/** Complete per-count message; English suffixes are never appended. */
function apps(count: number) {
  return count === 1 ? "1 app" : `${count} apps`;
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
}: {
  selection: readonly LauncherBatchSelection[];
  disabled: boolean;
  reviewBatch: (items: AdoptionBatchItem[]) => Promise<AdoptionBatchPreview | undefined>;
  copyBatch: (
    items: AdoptionBatchItem[],
    batchSha256: string,
  ) => Promise<AdoptionBatchResult | null | undefined>;
}) {
  const [preview, setPreview] = useState<AdoptionBatchPreview>();
  const [result, setResult] = useState<AdoptionBatchResult>();
  const [working, setWorking] = useState(false);
  // A review belongs to exactly the selection it was made for.
  const key = selection.map(({ item }) => `${item.source}\n${item.port_id}`).join("\n--\n");
  const [reviewedKey, setReviewedKey] = useState<string>();
  const current = preview && reviewedKey === key ? preview : undefined;
  const label = (source: string) =>
    selection.find(({ item }) => item.source === source)?.label ?? source;
  const items = selection.map(({ item }) => item);
  return (
    <section aria-label="Copy several apps" className="mt-3">
      <Button
        data-focusable
        type="button"
        variant="outline"
        disabled={disabled || working || selection.length < 2}
        onClick={() => {
          setWorking(true);
          setResult(undefined);
          void reviewBatch(items)
            .then((reviewed) => {
              setPreview(reviewed);
              setReviewedKey(reviewed ? key : undefined);
            })
            .finally(() => setWorking(false));
        }}
      >
        <Icon glyph={FolderInput} />
        {selection.length < 2
          ? "Select two or more apps to copy them together"
          : `Review copying ${apps(selection.length)}`}
      </Button>
      {current && (
        <div
          className="mt-3 rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-3 [overflow-wrap:anywhere]"
          aria-label="Several apps copy plan"
          role="group"
        >
          <p>
            <strong>{apps(current.items.length)}</strong> ·{" "}
            {current.total_files === 1 ? "1 file" : `${current.total_files} files`} ·{" "}
            {formatBytes(current.total_bytes)} will be copied into the managed library.
          </p>
          <ul className="ps-5">
            {current.items.map((item) => (
              <li key={item.source}>
                {label(item.source)}
                {item.destination?.active_install &&
                  ` — becomes the active version; ${item.destination.active_install.version} stays installed`}
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
            disabled={disabled || working}
            onClick={() => {
              setWorking(true);
              void copyBatch(items, current.batch_sha256)
                .then((copied) => {
                  if (copied) {
                    setResult(copied);
                    setPreview(undefined);
                  }
                })
                .finally(() => setWorking(false));
            }}
          >
            <Icon glyph={FolderInput} />
            {working ? "Copying…" : "Continue to copy confirmation"}
          </Button>
        </div>
      )}
      <div aria-live="polite">
        {result && (
          <div className="mt-3" role="group" aria-label="Several apps copy result">
            <p>
              Copied {apps(result.items.filter((item) => item.outcome === "copied").length)} of{" "}
              {result.items.length}.
            </p>
            <ul className="ps-5">
              {result.items.map((item) => (
                <li key={item.source}>
                  {label(item.source)}: {OUTCOME_LABELS[item.outcome]}
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
