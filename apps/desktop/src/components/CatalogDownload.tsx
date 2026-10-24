import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { CatalogEntry } from "../features/browsing/catalog-entry";
import type { Perform } from "../features/operations/use-operation-state";
import { pickInstallFolder } from "../file-picker";
import { gameIdentityLabel } from "../port-identity";
import { LatestRequestGeneration } from "../shared/concurrency-state";
import type {
  CatalogDownloadCandidate,
  CatalogDownloadCandidates,
  CatalogDownloadRequest,
  PendingSetupRecord,
} from "../types";
import { useActionReview } from "../use-action-review";
import { formatBytes } from "../view-model";
import { ActionReviewFailure } from "./ActionReviewFailure";
import { ChoiceSelect } from "./ChoiceSelect";
import { ExternalLink } from "./ExternalLink";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { ActionRow } from "./ui/patterns";

interface DownloadControlProps {
  entry: CatalogEntry;
  generation: number;
  busy: boolean;
  perform: Perform;
  autoCheck?: boolean;
}

export function CatalogDownloadControl(props: DownloadControlProps) {
  return <DownloadChoices key={`${props.entry.id}:${props.generation}`} {...props} />;
}

function assetKey(asset: CatalogDownloadCandidate): string {
  return `${asset.release_id}:${asset.asset_id}`;
}

function DownloadChoices({
  entry,
  generation,
  busy,
  perform,
  autoCheck = false,
}: DownloadControlProps) {
  const extractionId = useId();
  const downloadRegion = useRef<HTMLElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<CatalogDownloadCandidates>();
  const [selectedKey, setSelectedKey] = useState("");
  const [releaseChoice, setReleaseChoice] = useState<number>();
  const [packageChoice, setPackageChoice] = useState("");
  const [channel, setChannel] = useState("stable");
  const [showOther, setShowOther] = useState(false);
  const [destination, setDestination] = useState("");
  const [extract, setExtract] = useState(true);
  const [checking, setChecking] = useState(autoCheck);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [error, setError] = useState<unknown>();
  const [request, setRequest] = useState<CatalogDownloadRequest>();
  const requests = useRef(new LatestRequestGeneration());
  useLayoutEffect(() => {
    const current = requests.current;
    return () => {
      current.begin();
    };
  }, []);

  const candidates = result?.allowed ? result.candidates : [];
  const ordinary = candidates.filter((candidate) =>
    result?.packages.some(
      (item) => item.asset_id === candidate.asset_id && item.suitability === "suitable",
    ),
  );
  // Keep Core's recommendation and the player's explicit choice visible even
  // when upstream publishes more packages than fit in the concise list.
  const preferred = candidates.filter(
    (candidate) =>
      candidate.asset_id === result?.recommended_asset_id || assetKey(candidate) === selectedKey,
  );
  const concise = [
    ...preferred,
    ...ordinary.filter((candidate) => !preferred.includes(candidate)),
  ].slice(0, 8);
  const displayed = showOther ? candidates : concise;
  const matches = candidates.filter((candidate) => assetKey(candidate) === selectedKey);
  const selected = matches.length === 1 ? matches[0] : undefined;
  const controlsBusy = busy || checking || choosingFolder;
  const loadCandidates = useCallback(
    (releaseId?: number, selectedChannel = "stable", retainedPackage?: string) => {
      const observation = requests.current.begin();
      return Promise.resolve()
        .then(() =>
          desktopApi.catalogDownloadCandidates(entry.id, generation, releaseId, selectedChannel),
        )
        .then((next) => {
          if (!requests.current.isCurrent(observation)) return;
          if (next.port_id !== entry.id)
            throw new Error("The download list no longer matches this game. Check again.");
          setResult(next);
          const retained = retainedPackage
            ? next.candidates.find((candidate) => assetKey(candidate) === retainedPackage)
            : undefined;
          const recommended = next.candidates.find(
            (candidate) => candidate.asset_id === next.recommended_asset_id,
          );
          if (next.allowed && retained) setSelectedKey(assetKey(retained));
          else if (next.allowed && retainedPackage)
            setError(
              new Error(
                "Your selected package is no longer available in this release. Choose another file or review upstream releases.",
              ),
            );
          else if (next.allowed && recommended) setSelectedKey(assetKey(recommended));
          setDestination((current) => current || next.default_destination_parent || "");
        })
        .catch((failure: unknown) => {
          if (requests.current.isCurrent(observation)) setError(failure);
        })
        .finally(() => {
          if (requests.current.isCurrent(observation)) setChecking(false);
        });
    },
    [entry.id, generation],
  );
  const check = (releaseId?: number, selectedChannel = channel, keepPackage = false) => {
    if (controlsBusy) return;
    setChecking(true);
    setError(undefined);
    setResult(undefined);
    setSelectedKey("");
    return loadCandidates(releaseId, selectedChannel, keepPackage ? packageChoice : undefined);
  };
  const chooseFolder = async () => {
    if (controlsBusy) return;
    const observation = requests.current.begin();
    setChoosingFolder(true);
    setError(undefined);
    try {
      const path = await pickInstallFolder(destination || result?.default_destination_parent || "");
      if (requests.current.isCurrent(observation) && typeof path === "string") setDestination(path);
    } catch (failure) {
      if (requests.current.isCurrent(observation)) setError(failure);
    } finally {
      if (requests.current.isCurrent(observation)) setChoosingFolder(false);
    }
  };
  useEffect(() => {
    if (autoCheck) void loadCandidates();
  }, [autoCheck, loadCandidates]);

  return (
    <section
      ref={downloadRegion}
      tabIndex={-1}
      className="grid gap-3"
      aria-label="Download from upstream"
    >
      <ActionRow>
        <Button
          data-focusable
          variant={result ? "outline" : "primary"}
          disabled={controlsBusy}
          onClick={() => void check(releaseChoice, channel, true)}
        >
          {checking
            ? "Checking upstream downloads…"
            : result
              ? "Check downloads again"
              : "Check upstream downloads"}
        </Button>
        {result && <ExternalLink href={result.upstream_url}>View upstream releases</ExternalLink>}
      </ActionRow>
      <ActionReviewFailure error={error} />
      {result && (result.reason || !result.allowed || !candidates.length) && (
        <p role="status">
          {result.reason ||
            "No downloadable package is currently offered here. Check the upstream project for setup instructions."}
        </p>
      )}
      {result?.allowed && (
        <>
          <ChoiceSelect
            label="Release channel"
            value={channel}
            disabled={controlsBusy}
            options={[
              { value: "stable", label: "Stable" },
              { value: "beta", label: "Preview" },
            ]}
            onChange={(value) => {
              setChannel(value);
              setReleaseChoice(undefined);
              setPackageChoice("");
              void check(undefined, value);
            }}
          />
          {result.releases.length > 0 && (
            <ChoiceSelect
              label="Release"
              value={String(result.selected_release_id ?? "")}
              disabled={controlsBusy}
              options={[
                { value: "", label: "Choose a release" },
                ...result.releases.map((release) => ({
                  value: String(release.id),
                  label: `${release.tag}${release.preview ? " · Preview" : " · Stable"}`,
                })),
              ]}
              onChange={(value) => {
                if (value) {
                  setReleaseChoice(Number(value));
                  setPackageChoice("");
                  void check(Number(value));
                }
              }}
            />
          )}
          <p role="status">{result.recommendation_reason}</p>
          {displayed.length > 0 && (
            <ChoiceSelect
              label="Package"
              value={selectedKey}
              disabled={controlsBusy}
              options={[
                { value: "", label: "Choose a file…" },
                ...displayed.map((candidate) => ({
                  value: assetKey(candidate),
                  label: `${candidate.asset_id === result.recommended_asset_id ? "Recommended · " : ""}${candidate.name} · ${formatBytes(candidate.size)}`,
                })),
              ]}
              onChange={(value) => {
                setSelectedKey(value);
                setPackageChoice(value);
                const packageRelease = candidates.find(
                  (candidate) => assetKey(candidate) === value,
                )?.release_id;
                if (packageRelease) setReleaseChoice(packageRelease);
                setExtract(true);
              }}
              description="Packages belong to the selected release. Check its notes for setup requirements."
            />
          )}
          {candidates.length > concise.length && (
            <Button
              variant="outline"
              disabled={controlsBusy}
              aria-expanded={showOther}
              onClick={() => setShowOther((value) => !value)}
            >
              {showOther ? "Show recommended packages" : "Other and uncertain downloads"}
            </Button>
          )}
          {selected && (
            <p className="text-sm">
              {result.packages.find((item) => item.asset_id === selected.asset_id)?.reason}
            </p>
          )}
          {selected && (
            <ExternalLink href={selected.release_url}>Release notes and requirements</ExternalLink>
          )}
          <ActionRow>
            <Button
              data-focusable
              variant="outline"
              disabled={controlsBusy}
              onClick={() => void chooseFolder()}
            >
              {destination ? "Change download folder…" : "Choose download folder…"}
            </Button>
            {destination && <code className="min-w-0 [overflow-wrap:anywhere]">{destination}</code>}
          </ActionRow>
          <p className="text-sm text-pc-muted-foreground">
            Choose a folder outside your Portcove library. Portcove will create a new folder for
            this download without replacing existing files.
          </p>
          {selected?.can_extract && (
            <label htmlFor={extractionId} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={extractionId}
                checked={extract}
                disabled={controlsBusy}
                onCheckedChange={setExtract}
              />
              Extract the archive after downloading
            </label>
          )}
          <ActionRow>
            <Button
              data-focusable
              variant="primary"
              disabled={controlsBusy || !selected || !destination}
              ref={reviewButton}
              onClick={() => {
                if (!selected || !destination) return;
                setRequest({
                  port_id: entry.id,
                  release_id: selected.release_id,
                  asset_id: selected.asset_id,
                  destination_parent: destination,
                  extract_archive: selected.can_extract && extract,
                });
              }}
            >
              Review download
            </Button>
          </ActionRow>
        </>
      )}
      {request && (
        <DownloadReview
          entry={entry}
          generation={generation}
          busy={busy}
          perform={perform}
          request={request}
          close={() => setRequest(undefined)}
          returnFocus={() =>
            reviewButton.current?.disabled ? downloadRegion.current : reviewButton.current
          }
        />
      )}
    </section>
  );
}

function DownloadReview({
  entry,
  generation,
  busy,
  perform,
  request,
  close,
  returnFocus,
}: DownloadControlProps & {
  request: CatalogDownloadRequest;
  close: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity: JSON.stringify([request, generation]),
    load: () => desktopApi.previewCatalogDownload(request, generation),
    apply: async (value) => {
      if (busy) return false;
      const transfer = perform(
        "download",
        (reportEvent) =>
          desktopApi.downloadCatalogPackage(
            value.request,
            value.preview_sha256,
            generation,
            reportEvent,
          ),
        {
          context: {
            action: "Download package",
            target: { kind: "port", id: entry.id, label: gameIdentityLabel(entry) },
            libraryGeneration: generation,
            exclusionScope: "target",
          },
        },
      );
      // The workspace operation owner keeps progress and recovery alive after this
      // review closes or the user navigates away from the game.
      close();
      return (await transfer) !== undefined;
    },
    close,
    failureMessage:
      "The download could not start. Check Activity for the reported reason, then review again.",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent initialFocus={cancel} finalFocus={returnFocus} showCloseButton={false}>
        <DialogTitle>Download for {gameIdentityLabel(entry)}?</DialogTitle>
        <DialogDescription>
          This downloads an upstream file into a folder you own. Complete setup with the upstream
          instructions, then choose the game executable. Portcove will not run an installer, manage
          updates or delete these files.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking the upstream file and destination…</p>}
        <ActionReviewFailure error={error} />
        {preview && (
          <>
            <dl className="grid gap-2 [overflow-wrap:anywhere]">
              <dt>File</dt>
              <dd>
                {preview.artifact.name} · {formatBytes(preview.artifact.size)}
              </dd>
              <dt>Release</dt>
              <dd>
                <ExternalLink href={preview.artifact.release_url}>
                  {preview.artifact.release_tag}
                </ExternalLink>
              </dd>
              <dt>New folder</dt>
              <dd>
                <code>{preview.destination_path}</code>
              </dd>
              <dt>After downloading</dt>
              <dd>
                {preview.request.extract_archive
                  ? "Extract the archive in the new folder"
                  : "Keep the downloaded file for upstream setup"}
              </dd>
            </dl>
            {!preview.artifact.sha256 && (
              <p>No upstream checksum is supplied. Download authenticity is unverified.</p>
            )}
            <details className="min-w-0 [overflow-wrap:anywhere]">
              <summary data-focusable>Download verification details</summary>
              <dl className="mt-2 grid gap-2">
                <dt>Download URL</dt>
                <dd>
                  <code>{preview.artifact.download_url}</code>
                </dd>
                <dt>Upstream SHA-256</dt>
                <dd>
                  {preview.artifact.sha256 ? (
                    <code>{preview.artifact.sha256}</code>
                  ) : (
                    "Not supplied. Portcove will record a SHA-256 for the downloaded file."
                  )}
                </dd>
              </dl>
            </details>
          </>
        )}
        <DialogFooter>
          <Button
            ref={cancel}
            data-focusable
            variant="outline"
            disabled={pending === "apply"}
            onClick={dismiss}
          >
            Cancel
          </Button>
          {preview ? (
            <Button
              data-focusable
              variant="primary"
              disabled={Boolean(pending) || busy}
              onClick={() => void execute()}
            >
              Download
            </Button>
          ) : (
            <Button disabled={Boolean(pending) || busy} onClick={() => void review()}>
              Check again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PendingSetupActions(props: DownloadControlProps & { pending: PendingSetupRecord }) {
  return <PendingActions key={`${props.pending.id}:${props.generation}`} {...props} />;
}

function PendingActions({
  entry,
  pending,
  generation,
  busy,
  perform,
}: DownloadControlProps & { pending: PendingSetupRecord }) {
  const [removing, setRemoving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>();
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const current = useRef(true);
  useLayoutEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const context = {
    target: { kind: "port" as const, id: entry.id, label: gameIdentityLabel(entry) },
    libraryGeneration: generation,
    exclusionScope: "target" as const,
  };
  const forget = async () => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setApplying(true);
    setError(undefined);
    let failure: unknown;
    const removed = await perform(
      "remove-setup-entry",
      async () => {
        try {
          await desktopApi.forgetPendingSetup(entry.id, pending.id, generation);
          return true;
        } catch (value) {
          failure = value;
          throw value;
        }
      },
      { context: { ...context, action: "Remove setup entry" } },
    );
    if (current.current) {
      setApplying(false);
      if (removed) setRemoving(false);
      else
        setError(
          failure ?? "The setup entry could not be removed. Refresh the workspace and try again.",
        );
    }
    inFlight.current = false;
  };
  return (
    <>
      <ActionRow>
        <Button
          data-focusable
          variant={pending.state === "attention-required" ? "primary" : "outline"}
          disabled={busy}
          onClick={() =>
            void perform(
              "open-setup-folder",
              () => desktopApi.openPendingSetupFolder(entry.id, pending.id, generation),
              {
                refresh: "none",
                invalidateDiagnostics: false,
                context: { ...context, action: "Open download folder" },
              },
            )
          }
        >
          Open download folder
        </Button>
        <Button
          data-focusable
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setError(undefined);
            setRemoving(true);
          }}
        >
          Remove setup entry…
        </Button>
      </ActionRow>
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !inFlight.current) setRemoving(false);
          }}
        >
          <DialogContent initialFocus={cancel} showCloseButton={false}>
            <DialogTitle>Remove this setup entry?</DialogTitle>
            <DialogDescription>
              This removes Portcove’s saved setup reminder for {gameIdentityLabel(entry)}. The
              download folder and all files inside it stay where they are.
            </DialogDescription>
            <code className="[overflow-wrap:anywhere]">{pending.path}</code>
            <ActionReviewFailure error={error} />
            <DialogFooter>
              <Button
                ref={cancel}
                variant="outline"
                disabled={applying}
                onClick={() => setRemoving(false)}
              >
                Cancel
              </Button>
              <Button disabled={applying || busy} onClick={() => void forget()}>
                Remove setup entry
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
