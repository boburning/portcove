import { useId, useLayoutEffect, useRef, useState } from "react";
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
}

export function CatalogDownloadControl(props: DownloadControlProps) {
  return <DownloadChoices key={`${props.entry.id}:${props.generation}`} {...props} />;
}

function assetKey(asset: CatalogDownloadCandidate): string {
  return `${asset.release_id}:${asset.asset_id}`;
}

function DownloadChoices({ entry, generation, busy, perform }: DownloadControlProps) {
  const extractionId = useId();
  const [result, setResult] = useState<CatalogDownloadCandidates>();
  const [selectedKey, setSelectedKey] = useState("");
  const [destination, setDestination] = useState("");
  const [extract, setExtract] = useState(true);
  const [checking, setChecking] = useState(false);
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
  const complete =
    result?.coverage?.release_history_complete && result.coverage.candidates_complete;
  const matches = candidates.filter((candidate) => assetKey(candidate) === selectedKey);
  const selected = matches.length === 1 ? matches[0] : undefined;
  const controlsBusy = busy || checking || choosingFolder;
  const check = async () => {
    if (controlsBusy) return;
    const observation = requests.current.begin();
    setChecking(true);
    setError(undefined);
    setResult(undefined);
    setSelectedKey("");
    try {
      const next = await desktopApi.catalogDownloadCandidates(entry.id, generation);
      if (!requests.current.isCurrent(observation)) return;
      if (next.port_id !== entry.id)
        throw new Error("The download list no longer matches this game. Check again.");
      setResult(next);
      if (
        next.allowed &&
        next.candidates.length === 1 &&
        next.coverage?.release_history_complete &&
        next.coverage.candidates_complete
      )
        setSelectedKey(assetKey(next.candidates[0]!));
    } catch (failure) {
      if (requests.current.isCurrent(observation)) setError(failure);
    } finally {
      if (requests.current.isCurrent(observation)) setChecking(false);
    }
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

  return (
    <section className="grid gap-3" aria-label="Download from upstream">
      <ActionRow>
        <Button
          data-focusable
          variant={result ? "outline" : "primary"}
          disabled={controlsBusy}
          onClick={() => void check()}
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
      {result?.allowed && candidates.length > 0 && (
        <>
          {candidates.length > 1 || !complete ? (
            <ChoiceSelect
              label="Upstream file"
              value={selectedKey}
              disabled={controlsBusy}
              options={[
                { value: "", label: "Choose a file…" },
                ...candidates.map((candidate) => ({
                  value: assetKey(candidate),
                  label: `${candidate.release_tag} · ${candidate.name} · ${formatBytes(candidate.size)}`,
                })),
              ]}
              onChange={(value) => {
                setSelectedKey(value);
                setExtract(true);
              }}
              description="Choose the file for your operating system. Check the release notes for setup requirements."
            />
          ) : (
            <p>
              <strong>{selected?.name}</strong> · {selected?.release_tag} ·{" "}
              {selected && formatBytes(selected.size)}
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
}: DownloadControlProps & {
  request: CatalogDownloadRequest;
  close: () => void;
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
      <DialogContent initialFocus={cancel} showCloseButton={false}>
        <DialogTitle>Download for {gameIdentityLabel(entry)}?</DialogTitle>
        <DialogDescription>
          This downloads an upstream file into a folder you own. Complete setup with the upstream
          instructions, then choose the game executable. Portcove will not run an installer, manage
          updates or delete these files.
        </DialogDescription>
        {pending === "review" && <p role="status">Checking the upstream file and destination…</p>}
        <ActionReviewFailure error={error} />
        {preview && (
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
            <dt>Download URL</dt>
            <dd>
              <code>{preview.artifact.download_url}</code>
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
            <dt>Upstream SHA-256</dt>
            <dd>
              {preview.artifact.sha256 ? (
                <code>{preview.artifact.sha256}</code>
              ) : (
                "Not supplied. Portcove will record a SHA-256 for the downloaded file."
              )}
            </dd>
          </dl>
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
