import { useEffect, useRef, useState } from "react";
import { Gamepad2, FolderOpen } from "lucide-react";
import { gameIdentityLabel } from "../port-identity";
import { desktopApi } from "../api";
import { pickSteamFolder } from "../file-picker";
import type {
  PortDefinition,
  SteamArtworkApplyResult,
  SteamArtworkOperation,
  SteamArtworkReview,
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
import { Field, Fieldset } from "./ui/field";
import { Checkbox } from "./ui/checkbox";
import { ActionRow } from "./ui/patterns";

function steamChangeLabel(kind: SteamEntryReview["changes"][number]["kind"]) {
  const labels: Record<SteamEntryReview["changes"][number]["kind"], string> = {
    add: "Add shortcut",
    repair: "Repair shortcut",
    remove: "Remove shortcut",
    unchanged: "No shortcut change",
  };
  return Object.hasOwn(labels, kind) ? labels[kind] : "Shortcut change unavailable";
}

type SteamArtworkRole = SteamArtworkReview["roles"][number];

const artworkRoleNames: Record<SteamArtworkRole["role"], string> = {
  portrait_cover: "Portrait cover",
  landscape_cover: "Landscape cover",
  hero_banner: "Hero banner",
};

function steamArtworkRoleName(role: SteamArtworkRole["role"]) {
  return Object.hasOwn(artworkRoleNames, role) ? artworkRoleNames[role] : "Artwork";
}

function steamArtworkUnavailableLabel(reason: SteamArtworkRole["unavailable_reason"]) {
  switch (reason) {
    case "no_local_original":
      return "Not available: choose an imported image for this game in Portcove first";
    case "selected_original_unavailable":
      return "Not available: the selected image could not be read; import it again";
    default:
      return "Not available: Portcove has no image for this role yet";
  }
}

function steamArtworkPlanLabel(role: SteamArtworkRole) {
  switch (role.action) {
    case "write":
      return "Will be added";
    case "replace":
      return "Will replace the current Steam artwork, which is backed up first";
    case "preserve":
      return "Kept: Steam already has artwork here";
    case "unchanged":
      return "Already up to date";
    case "unavailable":
      return steamArtworkUnavailableLabel(role.unavailable_reason);
    case "remove":
      return "Will be removed, with a backup kept";
    case "preserve_modified":
      return "Kept: it was changed outside Portcove";
    case "absent":
      return "No Portcove artwork to remove";
    default:
      return "Change unavailable";
  }
}

function steamArtworkResultLabel(role: SteamArtworkRole) {
  switch (role.action) {
    case "write":
      return "Added";
    case "replace":
      return "Replaced";
    case "remove":
      return "Removed";
    default:
      return steamArtworkPlanLabel(role);
  }
}

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
      <Button
        data-focusable
        data-steam-shortcut
        variant="outline"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
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
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [steamRoot, setSteamRoot] = useState("");
  const [steamUserId, setSteamUserId] = useState("");
  const [review, setReview] = useState<SteamEntryReview>();
  const [result, setResult] = useState<SteamEntryApplyResult>();
  const [artworkReview, setArtworkReview] = useState<SteamArtworkReview>();
  const [artworkResult, setArtworkResult] = useState<SteamArtworkApplyResult>();
  const [replaceArtwork, setReplaceArtwork] = useState(false);
  const [includeArtwork, setIncludeArtwork] = useState(true);
  const [pending, setPending] = useState<"review" | "apply">();
  const [error, setError] = useState<string>();
  const dismiss = () => {
    if (pending !== "apply") close();
  };

  const resetReview = () => {
    setReview(undefined);
    setResult(undefined);
    setArtworkReview(undefined);
    setArtworkResult(undefined);
    setError(undefined);
  };
  const loadArtworkReview = async (operation: SteamArtworkOperation) => {
    if (pending) return;
    setPending("review");
    resetReview();
    try {
      setArtworkReview(
        await desktopApi.previewSteamArtwork(
          { portId: port.id, steamRoot, steamUserId, operation },
          generation,
        ),
      );
    } catch (value) {
      setError(errorText(value));
    } finally {
      setPending(undefined);
    }
  };
  const applyArtwork = async () => {
    if (!artworkReview || pending) return;
    setPending("apply");
    setError(undefined);
    try {
      const applied = await desktopApi.applySteamArtwork(
        {
          portId: port.id,
          steamRoot: artworkReview.steam_root,
          steamUserId: artworkReview.steam_user_id,
          operation: artworkReview.operation,
        },
        artworkReview.plan_sha256,
        generation,
      );
      if (applied) {
        setArtworkResult(applied);
        setArtworkReview(undefined);
      }
    } catch (value) {
      setArtworkReview(undefined);
      setError(errorText(value));
    } finally {
      setPending(undefined);
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
        await desktopApi.previewSteamEntry(
          port.id,
          steamRoot,
          steamUserId,
          operation,
          operation === "add_or_repair" && includeArtwork,
          generation,
        ),
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
        review.artwork_review_sha256 !== null,
        review.plan_sha256,
        review.artwork_review_sha256,
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
  const reviewing = Boolean(review || result || artworkReview || artworkResult);
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={cancelButton}
        showCloseButton={false}
        reviewSize="standard"
        aria-describedby="steam-entry-description"
      >
        <DialogTitle id="steam-entry-title" className="mb-2 text-xl">
          Manage Steam shortcut
        </DialogTitle>
        <DialogDescription id="steam-entry-description" className="mb-4 leading-relaxed">
          <strong className="mb-2 block wrap-anywhere text-pc-foreground">
            {gameIdentityLabel(port)}
          </strong>
          {installed
            ? `Add, repair, or remove the Steam shortcut for ${port.name} in one selected local profile.`
            : "Remove a previously added Portcove shortcut from one selected local Steam profile. The game is not installed here."}
        </DialogDescription>
        {!result && !artworkResult && (
          <SteamProfileFields
            key={generation}
            idPrefix="steam"
            generation={generation}
            steamRoot={steamRoot}
            steamUserId={steamUserId}
            pending={Boolean(pending)}
            setSteamRoot={setSteamRoot}
            setSteamUserId={setSteamUserId}
            resetReview={resetReview}
          />
        )}
        {installed && !reviewing && (
          <IncludeArtworkChoice
            id="steam-include-artwork"
            checked={includeArtwork}
            disabled={Boolean(pending)}
            onChange={setIncludeArtwork}
          />
        )}
        {pending === "review" && <p role="status">Inspecting the selected Steam profile…</p>}
        {!reviewing && (
          <Fieldset legend="Steam artwork" disabled={Boolean(pending)} className="mt-6 grid gap-3">
            <p>
              Add this game's selected Portcove cover to its Portcove shortcut. Artwork already in
              Steam is kept unless you choose to replace it.
            </p>
            <label
              htmlFor="steam-artwork-replace"
              className="flex min-h-10 cursor-pointer items-center gap-3 py-2"
            >
              <Checkbox
                data-focusable
                id="steam-artwork-replace"
                data-steam-artwork-replace
                checked={replaceArtwork}
                onCheckedChange={(checked) => setReplaceArtwork(checked === true)}
              />
              Replace artwork already in Steam
            </label>
            <ActionRow>
              <Button
                data-focusable
                variant="outline"
                disabled={!selected || Boolean(pending)}
                onClick={() =>
                  void loadArtworkReview({ kind: "update", replace_existing: replaceArtwork })
                }
              >
                Review artwork update
              </Button>
              <Button
                data-focusable
                variant="outline"
                disabled={!selected || Boolean(pending)}
                onClick={() => void loadArtworkReview({ kind: "remove_owned" })}
              >
                Review artwork removal
              </Button>
            </ActionRow>
          </Fieldset>
        )}
        {review && <SteamEntryReviewDetails review={review} />}
        {result && <SteamEntryResult result={result} batch={false} />}
        {artworkReview && <SteamArtworkReviewDetails review={artworkReview} />}
        {artworkResult && <SteamArtworkResult result={artworkResult} />}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button
            ref={cancelButton}
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            {result || artworkResult ? "Close" : "Cancel"}
          </Button>
          {!reviewing && (
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
                {review.steam_client_state === "running" ? "Check again" : "Check shortcuts again"}
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
          {artworkReview && (
            <>
              <Button
                data-focusable
                variant="outline"
                disabled={Boolean(pending)}
                onClick={() => void loadArtworkReview(artworkReview.operation)}
              >
                Check again
              </Button>
              {artworkReview.writes_required && (
                <Button
                  data-focusable
                  variant={
                    artworkReview.operation.kind === "remove_owned" ? "destructive" : "primary"
                  }
                  disabled={Boolean(pending) || artworkReview.steam_client_state !== "closed"}
                  onClick={() => void applyArtwork()}
                >
                  {pending === "apply"
                    ? "Applying reviewed change…"
                    : artworkReview.operation.kind === "remove_owned"
                      ? "Remove Portcove artwork"
                      : "Update Steam artwork"}
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
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [steamRoot, setSteamRoot] = useState("");
  const [steamUserId, setSteamUserId] = useState("");
  const [review, setReview] = useState<SteamBatchReview>();
  const [reviewedSelection, setReviewedSelection] = useState<SteamBatchSelection>();
  const [result, setResult] = useState<SteamEntryApplyResult>();
  const [includeArtwork, setIncludeArtwork] = useState(true);
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
      includeArtwork,
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
        review.artwork_review_sha256,
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
        initialFocus={cancelButton}
        showCloseButton={false}
        reviewSize="standard"
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
            <Fieldset legend="Installed games" disabled={Boolean(pending)} className="mb-4">
              {ports.map((port) => (
                <label
                  key={port.id}
                  className="flex min-h-10 cursor-pointer items-center gap-3 py-2"
                >
                  <Checkbox
                    data-focusable
                    checked={selectedIds.includes(port.id)}
                    onCheckedChange={(checked) => {
                      setSelectedIds((current) =>
                        checked ? [...current, port.id] : current.filter((id) => id !== port.id),
                      );
                      resetReview();
                    }}
                  />
                  {port.name}
                </label>
              ))}
            </Fieldset>
            <SteamProfileFields
              key={generation}
              idPrefix="steam-batch"
              generation={generation}
              steamRoot={steamRoot}
              steamUserId={steamUserId}
              pending={Boolean(pending)}
              setSteamRoot={setSteamRoot}
              setSteamUserId={setSteamUserId}
              resetReview={resetReview}
            />
            <IncludeArtworkChoice
              id="steam-batch-include-artwork"
              checked={includeArtwork}
              disabled={Boolean(pending)}
              onChange={(checked) => {
                setIncludeArtwork(checked);
                resetReview();
              }}
            />
          </>
        )}
        {pending === "review" && <p role="status">Inspecting selected games and Steam profile…</p>}
        {review && <SteamEntryReviewDetails review={review} />}
        {result && <SteamEntryResult result={result} batch />}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4">
          <Button
            ref={cancelButton}
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
                {review.steam_client_state === "running" ? "Check again" : "Check shortcuts again"}
              </Button>
              {review.writes_required && (
                <Button
                  data-focusable
                  variant="primary"
                  disabled={Boolean(pending) || review.steam_client_state !== "closed"}
                  onClick={() => void apply()}
                >
                  {pending === "apply" ? "Updating shortcuts…" : "Add or repair selected shortcuts"}
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
  generation,
  steamRoot,
  steamUserId,
  pending,
  setSteamRoot,
  setSteamUserId,
  resetReview,
}: {
  idPrefix: string;
  generation: number;
  steamRoot: string;
  steamUserId: string;
  pending: boolean;
  setSteamRoot: (value: string) => void;
  setSteamUserId: (value: string) => void;
  resetReview: () => void;
}) {
  const [profiles, setProfiles] = useState<string[]>();
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string>();
  const requestId = useRef(0);
  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [generation],
  );
  const changeRoot = (value: string) => {
    requestId.current += 1;
    setListing(false);
    setProfiles(undefined);
    setListError(undefined);
    if (value !== steamRoot) setSteamUserId("");
    setSteamRoot(value);
    resetReview();
  };
  const chooseSteam = async () => {
    const currentRequest = requestId.current;
    const selected = await pickSteamFolder(steamRoot);
    if (selected && requestId.current === currentRequest) changeRoot(selected);
  };
  const findProfiles = async () => {
    if (!steamRoot.trim() || listing) return;
    const currentRequest = ++requestId.current;
    setListing(true);
    setProfiles(undefined);
    setListError(undefined);
    try {
      const found = await desktopApi.listSteamProfiles(steamRoot, generation);
      if (requestId.current === currentRequest) setProfiles(found);
    } catch (value) {
      if (requestId.current === currentRequest) setListError(errorText(value));
    } finally {
      if (requestId.current === currentRequest) setListing(false);
    }
  };
  return (
    <div className="steam-profile-fields mt-6 grid gap-3">
      <Field label="Steam installation folder">
        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] [&_input]:min-w-0">
          <Input
            data-focusable
            id={`${idPrefix}-installation`}
            value={steamRoot}
            disabled={pending}
            onChange={(event) => {
              changeRoot(event.target.value);
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
      </Field>
      <Button
        data-focusable
        variant="outline"
        disabled={pending || listing || !steamRoot.trim()}
        onClick={() => void findProfiles()}
      >
        {listing ? "Finding profiles…" : "Find local profiles"}
      </Button>
      {listError && <p role="alert">{listError}</p>}
      {profiles && (
        <div role="group" aria-label="Local Steam profiles" className="mb-4">
          {profiles.length === 0 ? (
            <p>No local profiles found. Enter the numeric profile ID manually if you know it.</p>
          ) : (
            <>
              <p className="mb-2">Select the exact local profile:</p>
              <ActionRow>
                {profiles.map((id) => (
                  <Button
                    key={id}
                    data-focusable
                    variant={id === steamUserId ? "selected" : "outline"}
                    disabled={pending}
                    aria-pressed={id === steamUserId}
                    onClick={() => {
                      setSteamUserId(id);
                      resetReview();
                    }}
                  >
                    {id}
                  </Button>
                ))}
              </ActionRow>
            </>
          )}
        </div>
      )}
      <Field
        label="Steam profile ID"
        description="Use the numeric folder name under Steam userdata."
        className="max-w-sm"
      >
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
      </Field>
      <p>
        Choose the Steam installation containing <code>userdata</code>, then find and select the
        exact local profile or enter its numeric folder ID. Portcove does not guess another profile
        or library.
      </p>
    </div>
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
      <p className="[overflow-wrap:anywhere]" role="status">
        <strong>{message}</strong>
      </p>
      <p className="[overflow-wrap:anywhere]">
        Shortcut file: <code>{result.shortcuts_path}</code>
      </p>
      {result.backup_path && (
        <p className="[overflow-wrap:anywhere]">
          Backup: <code>{result.backup_path}</code>
        </p>
      )}
      {result.artwork.length > 0 && (
        <ul aria-label="Steam artwork result">
          {result.artwork.flatMap((outcome) => {
            const name = gameName(result.changes, outcome.port_id);
            return outcome.error
              ? [
                  <li className="[overflow-wrap:anywhere]" key={outcome.port_id}>
                    {name}: shortcut added; artwork was not completed. Open Review artwork update to
                    check and finish it. <span className="block">Reason: {outcome.error}</span>
                  </li>,
                ]
              : outcome.roles.map((role) => (
                  <li className="[overflow-wrap:anywhere]" key={`${outcome.port_id}-${role.role}`}>
                    {name}, {steamArtworkRoleName(role.role).toLowerCase()}:{" "}
                    {steamArtworkResultLabel(role)}
                  </li>
                ));
          })}
        </ul>
      )}
    </section>
  );
}

function SteamEntryReviewDetails({ review }: { review: SteamEntryReview | SteamBatchReview }) {
  return (
    <section
      className="removal-review-details mt-6 grid gap-3"
      aria-label="Reviewed Steam shortcut change"
    >
      <p className="[overflow-wrap:anywhere]">
        <strong>
          {review.writes_required
            ? "Review the exact change before applying it."
            : "operation" in review && review.operation === "remove"
              ? "No Portcove shortcut was found for this game in the selected profile."
              : "The Portcove shortcut already matches this setup."}
        </strong>
      </p>
      <dl className="grid gap-3 [&>div]:grid [&>div]:gap-1">
        <div>
          <dt>Steam profile</dt>
          <dd>{review.steam_user_id}</dd>
        </div>
      </dl>
      <ul>
        {("selected_games" in review ? (review as SteamBatchReview).selected_games : []).map(
          (game) => (
            <li className="[overflow-wrap:anywhere]" key={game.port_id}>
              Selected: {game.display_name}
            </li>
          ),
        )}
        {review.changes.map((change) => (
          <li className="[overflow-wrap:anywhere]" key={change.port_id}>
            {change.display_name ?? change.port_id}: {steamChangeLabel(change.kind)}
          </li>
        ))}
      </ul>
      {review.artwork.length > 0 && (
        <div aria-label="Included Steam artwork" role="group">
          <p>Artwork for new shortcuts (art already in Steam is kept):</p>
          <ul>
            {review.artwork.flatMap((preview) => {
              const name = gameName(review.changes, preview.port_id);
              return preview.unavailable
                ? [
                    <li className="[overflow-wrap:anywhere]" key={preview.port_id}>
                      {name}: artwork can't be added with this shortcut. The shortcut is still
                      added; try Review artwork update later.{" "}
                      <span className="block">Reason: {preview.unavailable}</span>
                    </li>,
                  ]
                : preview.roles.map((role) => (
                    <li
                      className="[overflow-wrap:anywhere]"
                      key={`${preview.port_id}-${role.role}`}
                    >
                      {name}, {steamArtworkRoleName(role.role).toLowerCase()}:{" "}
                      {steamArtworkPlanLabel(role)}
                    </li>
                  ));
            })}
          </ul>
        </div>
      )}
      {review.steam_client_state === "running" && (
        <p className="[overflow-wrap:anywhere]" role="alert">
          Close Steam, then choose Check again. Portcove will not close Steam for you.
        </p>
      )}
      {review.steam_client_state === "unknown" && (
        <p className="[overflow-wrap:anywhere]" role="alert">
          Portcove could not determine whether Steam is running, so no change can be applied.
        </p>
      )}
      {review.steam_client_state === "closed" && review.writes_required && (
        <p className="[overflow-wrap:anywhere]">
          Keep Steam closed until this finishes. The selected profile and shortcut are checked again
          before the change is made.
        </p>
      )}
      <p className="[overflow-wrap:anywhere]">
        {"operation" in review && review.operation === "remove"
          ? "Remove affects only this Portcove-owned shortcut. It does not uninstall the game, delete saves, or remove unrelated Steam shortcuts and customization."
          : "Add / Repair affects only the selected Portcove-owned shortcuts. It does not uninstall games, delete saves, or remove unrelated Steam shortcuts and customization."}
      </p>
      <details>
        <summary data-focusable>Technical details</summary>
        <dl className="grid gap-3 wrap-anywhere">
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
      </details>
    </section>
  );
}

function SteamArtworkReviewDetails({ review }: { review: SteamArtworkReview }) {
  const removing = review.operation.kind === "remove_owned";
  return (
    <section className="removal-review-details mt-6 grid gap-3" aria-label="Reviewed Steam artwork">
      <p className="[overflow-wrap:anywhere]">
        <strong>
          {review.writes_required
            ? "Review the exact artwork change before applying it."
            : removing
              ? "There is no Portcove artwork to remove for this game in the selected profile."
              : "No artwork will change for this game in the selected profile."}
        </strong>
      </p>
      {review.recovered && (
        <p className="[overflow-wrap:anywhere]" role="status">
          Portcove first finished an interrupted artwork change for this profile. Each image is
          either the one you confirmed earlier or the one that was there before.
        </p>
      )}
      <ul>
        {review.roles.map((role) => (
          <li className="[overflow-wrap:anywhere]" key={role.role}>
            {steamArtworkRoleName(role.role)}: {steamArtworkPlanLabel(role)}
          </li>
        ))}
      </ul>
      {review.steam_client_state === "running" && (
        <p className="[overflow-wrap:anywhere]" role="alert">
          Close Steam, then choose Check again. Portcove will not close Steam for you.
        </p>
      )}
      {review.steam_client_state === "unknown" && (
        <p className="[overflow-wrap:anywhere]" role="alert">
          Portcove could not determine whether Steam is running, so no change can be applied.
        </p>
      )}
      <p className="[overflow-wrap:anywhere]">
        {removing
          ? "Only artwork Portcove added and that has not changed since is removed. The shortcut, the game, its saves and your other Steam artwork are not affected."
          : "Only this game's Portcove shortcut artwork changes. The shortcut, the game, its saves and your other Steam artwork are not affected."}
      </p>
      <details>
        <summary data-focusable>Technical details</summary>
        <dl className="grid gap-3 wrap-anywhere">
          <div>
            <dt>Steam profile</dt>
            <dd>{review.steam_user_id}</dd>
          </div>
          <div>
            <dt>Artwork folder</dt>
            <dd>{review.grid_path}</dd>
          </div>
          {review.app_id !== null && review.app_id !== undefined && (
            <div>
              <dt>Shortcut app ID</dt>
              <dd>{review.app_id}</dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}

function SteamArtworkResult({ result }: { result: SteamArtworkApplyResult }) {
  return (
    <section className="removal-review-details" aria-label="Steam artwork result">
      <p className="[overflow-wrap:anywhere]" role="status">
        <strong>
          {result.wrote
            ? "Steam artwork updated. Restart Steam to see the change."
            : "Steam artwork already matches this review."}
        </strong>
      </p>
      <ul>
        {result.roles.map((role) => (
          <li className="[overflow-wrap:anywhere]" key={role.role}>
            {steamArtworkRoleName(role.role)}: {steamArtworkResultLabel(role)}
          </li>
        ))}
      </ul>
      {result.backup_paths.map((path) => (
        <p className="[overflow-wrap:anywhere]" key={path}>
          Backup: <code>{path}</code>
        </p>
      ))}
    </section>
  );
}

function gameName(changes: SteamEntryReview["changes"], portId: string) {
  return changes.find((change) => change.port_id === portId)?.display_name ?? portId;
}

function IncludeArtworkChoice({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex min-h-10 cursor-pointer items-center gap-3 py-2">
      <Checkbox
        data-focusable
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      Include artwork when adding a shortcut
    </label>
  );
}
