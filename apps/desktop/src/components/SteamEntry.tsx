import { useState } from "react";
import { Gamepad2, FolderOpen } from "lucide-react";
import { desktopApi } from "../api";
import { pickSteamFolder } from "../file-picker";
import type {
  PortDefinition,
  SteamEntryApplyResult,
  SteamEntryOperation,
  SteamEntryReview,
} from "../types";
import { errorText } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

export function SteamEntryControl({
  port,
  generation,
  busy,
}: {
  port: PortDefinition;
  generation: number;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-focusable variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        <Icon glyph={Gamepad2} />
        Steam entry
      </Button>
      {open && (
        <SteamEntryDialog port={port} generation={generation} close={() => setOpen(false)} />
      )}
    </>
  );
}

export function SteamEntryDialog({
  port,
  generation,
  close,
}: {
  port: PortDefinition;
  generation: number;
  close: () => void;
}) {
  const [steamRoot, setSteamRoot] = useState("");
  const [steamUserId, setSteamUserId] = useState("");
  const [review, setReview] = useState<SteamEntryReview>();
  const [result, setResult] = useState<SteamEntryApplyResult>();
  const [pending, setPending] = useState<"review" | "apply">();
  const [error, setError] = useState<string>();
  const dismiss = () => {
    if (pending !== "apply") close();
  };

  const resetReview = () => {
    setReview(undefined);
    setResult(undefined);
    setError(undefined);
  };
  const chooseSteam = async () => {
    const selected = await pickSteamFolder(steamRoot);
    if (selected) {
      setSteamRoot(selected);
      resetReview();
    }
  };
  const loadReview = async (operation: SteamEntryOperation) => {
    if (pending) return;
    setPending("review");
    setReview(undefined);
    setResult(undefined);
    setError(undefined);
    try {
      setReview(
        await desktopApi.previewSteamEntry(port.id, steamRoot, steamUserId, operation, generation),
      );
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(undefined);
    }
  };
  const apply = async () => {
    if (!review || pending) return;
    setPending("apply");
    setResult(undefined);
    setError(undefined);
    try {
      const applied = await desktopApi.applySteamEntry(
        port.id,
        review.steam_root,
        review.steam_user_id,
        review.operation,
        review.plan_sha256,
        generation,
      );
      if (applied) {
        setResult(applied);
        setReview(undefined);
      }
    } catch (value) {
      setReview(undefined);
      setError(errorText(value));
    } finally {
      setPending(undefined);
    }
  };
  const selected = steamRoot.trim() && steamUserId.trim();
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-var(--space-8))] w-[min(680px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="steam-entry-description"
      >
        <DialogTitle id="steam-entry-title" className="mb-2 text-xl">
          Manage Steam entry
        </DialogTitle>
        <DialogDescription id="steam-entry-description" className="mb-4 leading-relaxed">
          Add, repair, or remove the selected Portcove game in one exact Steam profile.
        </DialogDescription>
        {!result && (
          <>
            <label
              className="mb-2 block text-xs font-bold text-pc-muted-foreground"
              htmlFor="steam-installation"
            >
              Steam installation folder
            </label>
            <div className="path-entry">
              <input
                data-focusable
                id="steam-installation"
                className="w-full rounded-[var(--radius-md)] border border-pc-input bg-[var(--color-bg-inset)] p-[11px] text-pc-foreground shadow-[inset_0_1px_2px_var(--color-bg)] outline-none focus-visible:border-pc-ring focus-visible:ring-3 focus-visible:ring-pc-ring/50"
                value={steamRoot}
                onChange={(event) => {
                  setSteamRoot(event.target.value);
                  resetReview();
                }}
                placeholder="C:\\Program Files (x86)\\Steam"
              />
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() => void chooseSteam()}
              >
                <Icon glyph={FolderOpen} />
                Choose folder
              </Button>
            </div>
            <label
              className="mb-2 block text-xs font-bold text-pc-muted-foreground"
              htmlFor="steam-profile"
            >
              Steam profile ID
            </label>
            <input
              data-focusable
              id="steam-profile"
              className="w-full rounded-[var(--radius-md)] border border-pc-input bg-[var(--color-bg-inset)] p-[11px] text-pc-foreground shadow-[inset_0_1px_2px_var(--color-bg)] outline-none focus-visible:border-pc-ring focus-visible:ring-3 focus-visible:ring-pc-ring/50"
              inputMode="numeric"
              pattern="[0-9]+"
              value={steamUserId}
              onChange={(event) => {
                setSteamUserId(event.target.value);
                resetReview();
              }}
              placeholder="Numeric folder under Steam userdata"
            />
            <p>
              Choose the Steam installation that contains <code>userdata</code>, then enter the
              exact numeric profile folder. Portcove does not guess another account or library.
            </p>
          </>
        )}
        {pending === "review" && <p role="status">Inspecting the selected Steam profile…</p>}
        {review && <SteamEntryReviewDetails review={review} />}
        {result && (
          <section className="removal-review-details" aria-label="Steam entry result">
            <p role="status">
              <strong>
                {result.wrote
                  ? "The reviewed Steam entry change was written."
                  : "No write was needed."}
              </strong>
            </p>
            <p>
              Shortcut file: <code>{result.shortcuts_path}</code>
            </p>
            {result.backup_path && (
              <p>
                Backup: <code>{result.backup_path}</code>
              </p>
            )}
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button
            data-autofocus
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {!review && !result && (
            <>
              <Button
                data-focusable
                disabled={!selected || Boolean(pending)}
                onClick={() => void loadReview("add_or_repair")}
              >
                Review Add / Repair
              </Button>
              <Button
                data-focusable
                variant="destructive"
                disabled={!selected || Boolean(pending)}
                onClick={() => void loadReview("remove")}
              >
                Review Remove
              </Button>
            </>
          )}
          {review && (
            <>
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() => void loadReview(review.operation)}
              >
                Review current state again
              </Button>
              {review.writes_required && (
                <Button
                  data-focusable
                  variant={review.operation === "remove" ? "destructive" : "primary"}
                  disabled={Boolean(pending) || review.steam_client_state !== "closed"}
                  onClick={() => void apply()}
                >
                  {pending === "apply"
                    ? "Applying reviewed change…"
                    : review.operation === "remove"
                      ? "Remove reviewed entry"
                      : "Apply reviewed Add / Repair"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SteamEntryReviewDetails({ review }: { review: SteamEntryReview }) {
  return (
    <section className="removal-review-details" aria-label="Reviewed Steam entry change">
      <p>
        <strong>
          {review.writes_required
            ? "Review the exact change before applying it."
            : review.operation === "remove"
              ? "No Portcove-owned entry exists for this game in the selected profile."
              : "The Portcove-owned Steam entry is already current."}
        </strong>
      </p>
      <dl>
        <div>
          <dt>Steam profile</dt>
          <dd>{review.steam_user_id}</dd>
        </div>
        <div>
          <dt>Shortcut file</dt>
          <dd>{review.shortcuts_path}</dd>
        </div>
        <div>
          <dt>Portcove library</dt>
          <dd>{review.library_root}</dd>
        </div>
        <div>
          <dt>Standalone CLI</dt>
          <dd>{review.cli_path ?? "Not required for this removal review"}</dd>
        </div>
        {review.cli_sha256 && (
          <div>
            <dt>CLI identity</dt>
            <dd>
              Portcove {review.cli_product_version}; SHA-256 {review.cli_sha256}
            </dd>
          </div>
        )}
      </dl>
      <ul>
        {review.changes.map((change) => (
          <li key={change.port_id}>
            {change.display_name ?? change.port_id}: {change.kind.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
      {review.steam_client_state === "running" && (
        <p role="alert">
          Steam is running. Close it yourself, then review the current state again. Portcove will
          never force Steam to close.
        </p>
      )}
      {review.steam_client_state === "unknown" && (
        <p role="alert">
          Portcove could not determine whether Steam is running, so no change can be applied.
        </p>
      )}
      {review.steam_client_state === "closed" && review.writes_required && (
        <p>
          Steam appears closed. Final consent rechecks this process state, the installed game,
          Portcove library, compatible CLI bytes, and exact reviewed profile before writing. A
          concurrent change is rejected.
        </p>
      )}
      <p>
        Remove affects only this Portcove-owned shortcut. It does not uninstall the game, delete
        saves, or remove unrelated Steam entries and customization.
      </p>
    </section>
  );
}
