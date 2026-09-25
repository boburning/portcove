import { useState } from "react";
import { Gamepad2, FolderOpen } from "lucide-react";
import { desktopApi } from "../api";
import { pickSteamFolder } from "../file-picker";
import type {
  PortDefinition,
  SteamEntryApplyResult,
  SteamEntryOperation,
  SteamEntryReview,
  SteamBatchReview,
  SteamBatchSelection,
} from "../types";
import { errorText } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function SteamEntryControl({
  port,
  generation,
  installed,
  busy,
}: {
  port: PortDefinition;
  generation: number;
  installed: boolean;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-focusable variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        <Icon glyph={Gamepad2} />
        Steam shortcut
      </Button>
      {open && (
        <SteamEntryDialog
          port={port}
          generation={generation}
          installed={installed}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function SteamEntryDialog({
  port,
  generation,
  installed,
  close,
}: {
  port: PortDefinition;
  generation: number;
  installed: boolean;
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
          Manage Steam shortcut
        </DialogTitle>
        <DialogDescription id="steam-entry-description" className="mb-4 leading-relaxed">
          {installed
            ? `Add, repair, or remove the Steam shortcut for ${port.name} in one selected local profile.`
            : "Remove a previously added Portcove shortcut from one selected local Steam profile. The game is not installed here."}
        </DialogDescription>
        {!result && (
          <SteamProfileFields
            idPrefix="steam"
            steamRoot={steamRoot}
            steamUserId={steamUserId}
            pending={Boolean(pending)}
            setSteamRoot={setSteamRoot}
            setSteamUserId={setSteamUserId}
            resetReview={resetReview}
          />
        )}
        {pending === "review" && <p role="status">Inspecting the selected Steam profile…</p>}
        {review && <SteamEntryReviewDetails review={review} />}
        {result && <SteamEntryResult result={result} batch={false} />}
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
                disabled={!installed || !selected || Boolean(pending)}
                onClick={() => void loadReview("add_or_repair")}
              >
                Review shortcut setup
              </Button>
              <Button
                data-focusable
                variant="destructive"
                disabled={!selected || Boolean(pending)}
                onClick={() => void loadReview("remove")}
              >
                Review shortcut removal
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
                {review.steam_client_state === "running"
                  ? "Check again"
                  : "Review current state again"}
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
                      ? "Remove shortcut"
                      : "Add or repair shortcut"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SteamBatchEntryDialog({
  ports,
  generation,
  close,
}: {
  ports: PortDefinition[];
  generation: number;
  close: () => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [steamRoot, setSteamRoot] = useState("");
  const [steamUserId, setSteamUserId] = useState("");
  const [review, setReview] = useState<SteamBatchReview>();
  const [reviewedSelection, setReviewedSelection] = useState<SteamBatchSelection>();
  const [result, setResult] = useState<SteamEntryApplyResult>();
  const [pending, setPending] = useState<"review" | "apply">();
  const [error, setError] = useState<string>();
  const resetReview = () => {
    setReview(undefined);
    setReviewedSelection(undefined);
    setResult(undefined);
    setError(undefined);
  };
  const dismiss = () => {
    if (pending !== "apply") close();
  };
  const loadReview = async () => {
    if (pending || selectedIds.length < 2) return;
    const selection: SteamBatchSelection = {
      portIds: selectedIds,
      steamRoot,
      steamUserId,
    };
    setPending("review");
    resetReview();
    try {
      const next = await desktopApi.previewSteamBatchAdd(selection, generation);
      setReview(next);
      setReviewedSelection(selection);
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(undefined);
    }
  };
  const apply = async () => {
    if (!review || !reviewedSelection || pending) return;
    setPending("apply");
    setError(undefined);
    try {
      const applied = await desktopApi.applySteamBatchAdd(
        reviewedSelection,
        review.review_sha256,
        generation,
      );
      if (applied) {
        setResult(applied);
        setReview(undefined);
      }
    } catch (value) {
      resetReview();
      setError(errorText(value));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-var(--space-8))] w-[min(680px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="steam-batch-description"
      >
        <DialogTitle id="steam-batch-title" className="mb-2 text-xl">
          Add selected games to Steam
        </DialogTitle>
        <DialogDescription id="steam-batch-description" className="mb-4 leading-relaxed">
          Select at least two installed games to add or repair their shortcuts in one selected local
          Steam profile.
        </DialogDescription>
        {!result && (
          <>
            <fieldset disabled={Boolean(pending)} className="mb-4">
              <legend className="mb-2 font-bold">Installed games</legend>
              {ports.map((port) => (
                <label key={port.id} className="flex items-center gap-2 py-1">
                  <input
                    data-focusable
                    type="checkbox"
                    checked={selectedIds.includes(port.id)}
                    onChange={(event) => {
                      setSelectedIds((current) =>
                        event.target.checked
                          ? [...current, port.id]
                          : current.filter((id) => id !== port.id),
                      );
                      resetReview();
                    }}
                  />
                  {port.name}
                </label>
              ))}
            </fieldset>
            <SteamProfileFields
              idPrefix="steam-batch"
              steamRoot={steamRoot}
              steamUserId={steamUserId}
              pending={Boolean(pending)}
              setSteamRoot={setSteamRoot}
              setSteamUserId={setSteamUserId}
              resetReview={resetReview}
            />
          </>
        )}
        {pending === "review" && <p role="status">Inspecting selected games and Steam profile…</p>}
        {review && <SteamEntryReviewDetails review={review} />}
        {result && <SteamEntryResult result={result} batch />}
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
            <Button
              data-focusable
              disabled={
                selectedIds.length < 2 ||
                !steamRoot.trim() ||
                !steamUserId.trim() ||
                Boolean(pending)
              }
              onClick={() => void loadReview()}
            >
              Review selected shortcuts
            </Button>
          )}
          {review && (
            <>
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() => void loadReview()}
              >
                {review.steam_client_state === "running"
                  ? "Check again"
                  : "Review current state again"}
              </Button>
              {review.writes_required && (
                <Button
                  data-focusable
                  variant="primary"
                  disabled={Boolean(pending) || review.steam_client_state !== "closed"}
                  onClick={() => void apply()}
                >
                  {pending === "apply"
                    ? "Applying reviewed batch…"
                    : "Add or repair selected shortcuts"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SteamProfileFields({
  idPrefix,
  steamRoot,
  steamUserId,
  pending,
  setSteamRoot,
  setSteamUserId,
  resetReview,
}: {
  idPrefix: string;
  steamRoot: string;
  steamUserId: string;
  pending: boolean;
  setSteamRoot: (value: string) => void;
  setSteamUserId: (value: string) => void;
  resetReview: () => void;
}) {
  const chooseSteam = async () => {
    const selected = await pickSteamFolder(steamRoot);
    if (selected) {
      setSteamRoot(selected);
      resetReview();
    }
  };
  return (
    <>
      <label
        className="mb-2 block text-xs font-bold text-pc-muted-foreground"
        htmlFor={`${idPrefix}-installation`}
      >
        Steam installation folder
      </label>
      <div className="path-entry">
        <Input
          data-focusable
          id={`${idPrefix}-installation`}
          value={steamRoot}
          disabled={pending}
          onChange={(event) => {
            setSteamRoot(event.target.value);
            resetReview();
          }}
          placeholder="C:\\Program Files (x86)\\Steam"
        />
        <Button
          data-focusable
          variant="outline"
          disabled={pending}
          onClick={() => void chooseSteam()}
        >
          <Icon glyph={FolderOpen} />
          Choose folder
        </Button>
      </div>
      <label
        className="mb-2 block text-xs font-bold text-pc-muted-foreground"
        htmlFor={`${idPrefix}-profile`}
      >
        Steam profile ID
      </label>
      <Input
        data-focusable
        id={`${idPrefix}-profile`}
        inputMode="numeric"
        pattern="[0-9]+"
        value={steamUserId}
        disabled={pending}
        onChange={(event) => {
          setSteamUserId(event.target.value);
          resetReview();
        }}
        placeholder="Numeric folder under Steam userdata"
      />
      <p>
        Choose the Steam installation containing <code>userdata</code> and enter the exact numeric
        profile folder. Portcove does not guess another profile or library.
      </p>
    </>
  );
}

function SteamEntryResult({ result, batch }: { result: SteamEntryApplyResult; batch: boolean }) {
  const removed = result.changes.every((change) => change.kind === "remove");
  const message = result.wrote
    ? removed
      ? "Steam shortcut removed."
      : batch
        ? "Selected Steam shortcuts updated."
        : "Steam shortcut updated."
    : removed
      ? "No Portcove shortcut was found for this game."
      : batch
        ? "The selected shortcuts already match this setup."
        : "The shortcut already matches this setup.";
  return (
    <section
      className="removal-review-details"
      aria-label={batch ? "Steam batch result" : "Steam shortcut result"}
    >
      <p role="status">
        <strong>{message}</strong>
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
  );
}

function SteamEntryReviewDetails({ review }: { review: SteamEntryReview | SteamBatchReview }) {
  return (
    <section className="removal-review-details" aria-label="Reviewed Steam shortcut change">
      <p>
        <strong>
          {review.writes_required
            ? "Review the exact change before applying it."
            : "operation" in review && review.operation === "remove"
              ? "No Portcove shortcut was found for this game in the selected profile."
              : "The Portcove shortcut already matches this setup."}
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
        {("selected_games" in review ? (review as SteamBatchReview).selected_games : []).map(
          (game) => (
            <li key={game.port_id}>Selected: {game.display_name}</li>
          ),
        )}
        {review.changes.map((change) => (
          <li key={change.port_id}>
            {change.display_name ?? change.port_id}: {change.kind.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
      {review.steam_client_state === "running" && (
        <p role="alert">
          Close Steam, then choose Check again. Portcove will not close Steam for you.
        </p>
      )}
      {review.steam_client_state === "unknown" && (
        <p role="alert">
          Portcove could not determine whether Steam is running, so no change can be applied.
        </p>
      )}
      {review.steam_client_state === "closed" && review.writes_required && (
        <p>
          Keep Steam closed until this finishes. The selected profile and shortcut are checked again
          before the change is made.
        </p>
      )}
      <p>
        {"operation" in review && review.operation === "remove"
          ? "Remove affects only this Portcove-owned shortcut. It does not uninstall the game, delete saves, or remove unrelated Steam shortcuts and customization."
          : "Add / Repair affects only the selected Portcove-owned shortcuts. It does not uninstall games, delete saves, or remove unrelated Steam shortcuts and customization."}
      </p>
    </section>
  );
}
