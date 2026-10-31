import { SettingsRow } from "./ui/patterns";
import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickSignedCatalogPath } from "../file-picker";
import type {
  ListingDeliveryStatus,
  CatalogProvenance,
  CatalogStatus,
  CatalogUpdatePlan,
  CatalogUpdateSource,
} from "../types";
import { errorText, isCancellation } from "../view-model";
import { ChoiceSelect } from "./ChoiceSelect";
import { OperationCancellation } from "./OperationCancellation";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function CatalogSettings({
  provenance,
  disabled,
  onChanged,
}: {
  provenance?: CatalogProvenance | undefined;
  disabled: boolean;
  onChanged?: (() => Promise<unknown>) | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow className="" data-focus-group>
      <h2>Custom catalog sources</h2>
      <CatalogOrigin provenance={provenance} />
      <p>
        Install a signed catalog from a publisher you trust and review each update. This is
        optional; ordinary catalog changes can arrive with Portcove updates. The built-in catalog
        remains available offline.
      </p>
      <Button
        data-focusable
        data-settings-control="catalog-updates"
        className="justify-self-start"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Manage catalog updates
      </Button>
      <ListingDeliveryControls disabled={disabled} onChanged={onChanged} />
      {open && <CatalogUpdatesDialog close={() => setOpen(false)} onChanged={onChanged} />}
    </SettingsRow>
  );
}

export function CatalogOrigin({ provenance }: { provenance?: CatalogProvenance | undefined }) {
  if (!provenance) return <p>Loading catalog information…</p>;
  return (
    <>
      <p>
        {provenance.origin === "embedded"
          ? "Built-in catalog"
          : `Signed catalog · version ${provenance.sequence}`}
        {provenance.origin === "signed_previous" && " · using the previous valid update"}
      </p>
      {provenance.expires_at && (
        <p>Valid until {new Date(provenance.expires_at * 1000).toLocaleString()}.</p>
      )}
      {provenance.fallback_reasons.map((reason, index) => (
        <CatalogFallbackReason
          key={`${index}:${reason}`}
          reason={reason}
          position={index + 1}
          count={provenance.fallback_reasons.length}
        />
      ))}
    </>
  );
}

function CatalogFallbackReason({
  reason,
  position,
  count,
}: {
  reason: string;
  position: number;
  count: number;
}) {
  return (
    <div className="catalog-fallback-reason">
      <p>{catalogFallbackSummary(reason)}</p>
      <details>
        <summary
          data-focusable
          aria-label={`Technical details for catalog fallback ${position} of ${count}`}
        >
          Technical details
        </summary>
        <code className="[overflow-wrap:anywhere]">{reason}</code>
      </details>
    </div>
  );
}

function catalogFallbackSummary(reason: string) {
  if (reason.includes("selected definition was not loaded"))
    return "The selected catalog definition could not be loaded. Portcove continued with the available catalog information.";
  if (reason.includes("replay floor"))
    return "A saved catalog did not match the accepted update sequence. Portcove continued with the available catalog information.";
  if (reason.includes("signing key is not trusted"))
    return "A saved catalog was signed by a publisher that is no longer trusted. Portcove continued with the available catalog information.";
  if (reason.includes("signature verification failed"))
    return "A saved catalog did not pass signature verification. Portcove continued with the available catalog information.";
  if (reason.includes("validity interval"))
    return "A saved catalog was expired or had invalid dates. Portcove continued with the available catalog information.";
  return "A saved catalog could not be used. Portcove continued with the available catalog information.";
}

function CatalogUpdatesDialog({
  close,
  onChanged,
}: {
  close: () => void;
  onChanged?: (() => Promise<unknown>) | undefined;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState<CatalogStatus>();
  const [busy, setBusy] = useState("Loading catalog settings…");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [operationId, setOperationId] = useState<string>();
  const [sourceSelectOpen, setSourceSelectOpen] = useState(false);
  const sourceSelectOpenRef = useRef(false);
  const sourceSelectDismissal = useRef(false);
  useEffect(() => {
    let current = true;
    void desktopApi
      .catalogStatus()
      .then((value) => {
        if (current) setStatus(value);
      })
      .catch((value) => {
        if (current) setError(errorText(value));
      })
      .finally(() => {
        if (current) setBusy("");
      });
    return () => {
      current = false;
    };
  }, []);
  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await task();
    } catch (value) {
      if (isCancellation(value)) setNotice("Catalog action cancelled.");
      else setError(errorText(value));
    } finally {
      setBusy("");
      setOperationId(undefined);
    }
  };
  const changed = async (next: CatalogStatus | null, message: string) => {
    if (!next) return;
    setStatus(next);
    setNotice(message);
    await onChanged?.();
  };
  const actions = { busy: Boolean(busy), run, changed };
  return (
    <Dialog
      open
      onOpenChange={(nextOpen, eventDetails) => {
        const nestedEscape =
          eventDetails.reason === "escape-key" &&
          (sourceSelectOpenRef.current || sourceSelectDismissal.current);
        if (!nextOpen && nestedEscape) {
          sourceSelectOpenRef.current = false;
          sourceSelectDismissal.current = false;
          setSourceSelectOpen(false);
          eventDetails.cancel();
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>("#catalog-update-source")?.focus(),
          );
          return;
        }
        sourceSelectOpenRef.current = false;
        sourceSelectDismissal.current = false;
        if (!nextOpen && !busy) close();
      }}
    >
      <DialogContent
        initialFocus={heading}
        showCloseButton={false}
        reviewSize="wide"
        className="catalog-update-dialog"
        aria-describedby="catalog-update-description"
      >
        <p className="eyebrow mb-[6px] text-[length:var(--text-xs)] font-bold tracking-[0.16em] text-[var(--color-primary-text)]">
          CATALOG
        </p>
        <DialogTitle ref={heading} tabIndex={-1} id="catalog-update-title" className="mb-2 text-xl">
          Manage catalog updates
        </DialogTitle>
        <DialogDescription id="catalog-update-description" className="mb-4 leading-relaxed">
          Trust a publisher, review a signed update, and choose which verified catalog Portcove
          uses. The built-in catalog remains available offline.
        </DialogDescription>
        <NavigationHints />
        <CatalogOrigin provenance={status?.provenance} />
        {status && (
          <>
            <PublisherTrust status={status} {...actions} />
            <CatalogReview
              status={status}
              {...actions}
              started={setOperationId}
              sourceSelectOpen={sourceSelectOpen}
              onSourceSelectOpenChange={(nextOpen, reason) => {
                if (nextOpen) sourceSelectOpenRef.current = true;
                if (!nextOpen && reason === "escape-key") sourceSelectDismissal.current = true;
                setSourceSelectOpen(nextOpen);
              }}
              onSourceSelectOpenChangeComplete={(nextOpen) => {
                if (!nextOpen) {
                  setTimeout(() => {
                    sourceSelectOpenRef.current = false;
                    sourceSelectDismissal.current = false;
                  }, 0);
                }
              }}
            />
            <CatalogSelection status={status} {...actions} />
          </>
        )}
        {busy && <p role="status">{busy}</p>}
        {operationId && (
          <OperationCancellation
            key={operationId}
            operationId={operationId}
            label="Cancel update"
          />
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4 border-t border-pc-border pt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CatalogActions {
  status: CatalogStatus;
  busy: boolean;
  run: (label: string, task: () => Promise<void>) => Promise<void>;
  changed: (status: CatalogStatus | null, message: string) => Promise<void>;
}

function PublisherTrust({ status, busy, run, changed }: CatalogActions) {
  const [publicKey, setPublicKey] = useState("");
  return (
    <section className="catalog-publisher-trust mt-6 grid gap-3">
      <h3>Trusted publishers</h3>
      <p>
        Verify the publisher key through a trusted channel. Trust allows that publisher to change
        release download locations.
      </p>
      {status.trusted_keys.length === 0 && <p>No trusted publishers.</p>}
      {status.trusted_keys.map((key) => (
        <div
          className="source-health-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-3"
          key={key.key_id}
        >
          <div className="min-w-0">
            <span>Publisher fingerprint</span>
            <code className="mt-1 block overflow-hidden bg-transparent p-0 text-ellipsis whitespace-nowrap text-pc-muted-foreground">
              {key.key_id}
            </code>
          </div>
          <Button
            data-focusable
            variant="destructive"
            disabled={Boolean(busy)}
            onClick={() => {
              void run("Removing publisher…", async () =>
                changed(
                  await desktopApi.revokeCatalogKey(key.key_id, status.state_sha256),
                  "Publisher trust removed.",
                ),
              );
            }}
          >
            Stop trusting
          </Button>
        </div>
      ))}
      <label
        className="mb-2 block text-xs font-bold text-pc-muted-foreground"
        htmlFor="catalog-public-key"
      >
        Publisher public key (64 hex characters)
      </label>
      <div className="flex items-stretch gap-2 [&_input]:min-w-0">
        <Input
          data-focusable
          id="catalog-public-key"
          autoComplete="off"
          value={publicKey}
          disabled={Boolean(busy)}
          onChange={(event) => setPublicKey(event.target.value)}
        />
        <Button
          data-focusable
          variant="primary"
          disabled={Boolean(busy) || !publicKey.trim()}
          onClick={() => {
            void run("Confirming publisher…", async () => {
              await changed(
                await desktopApi.trustCatalogKey(publicKey.trim()),
                "Publisher trusted.",
              );
            });
          }}
        >
          Trust publisher
        </Button>
      </div>
    </section>
  );
}

function CatalogReview({
  status,
  busy,
  run,
  changed,
  started,
  sourceSelectOpen,
  onSourceSelectOpenChange,
  onSourceSelectOpenChangeComplete,
}: CatalogActions & {
  started: (id: string) => void;
  sourceSelectOpen: boolean;
  onSourceSelectOpenChange: (open: boolean, reason: string) => void;
  onSourceSelectOpenChangeComplete: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<CatalogUpdateSource["kind"]>("file");
  const [location, setLocation] = useState("");
  const [planState, setPlanState] = useState<{
    baseline: string;
    value: CatalogUpdatePlan | undefined;
  }>();
  const plan = planState?.baseline === status.state_sha256 ? planState.value : undefined;
  const setPlan = (value?: CatalogUpdatePlan) =>
    setPlanState({ baseline: status.state_sha256, value });
  return (
    <section className="catalog-update-source-review mt-6 grid gap-3">
      <h3>Review an update</h3>
      <ChoiceSelect
        triggerId="catalog-update-source"
        label="Update source"
        value={kind}
        options={[
          { value: "file", label: "Local file" },
          { value: "https", label: "HTTPS address" },
        ]}
        disabled={Boolean(busy)}
        open={sourceSelectOpen}
        onOpenChange={onSourceSelectOpenChange}
        onOpenChangeComplete={onSourceSelectOpenChangeComplete}
        onChange={(value) => {
          setKind(value);
          setLocation("");
          setPlan(undefined);
        }}
      />
      <label
        className="mb-2 block text-xs font-bold text-pc-muted-foreground"
        htmlFor="catalog-update-location"
      >
        {kind === "file" ? "Signed catalog file" : "Signed catalog HTTPS address"}
      </label>
      <div className="flex items-stretch gap-2 [&_input]:min-w-0">
        <Input
          data-focusable
          id="catalog-update-location"
          value={location}
          disabled={Boolean(busy)}
          onChange={(event) => {
            setLocation(event.target.value);
            setPlan(undefined);
          }}
        />
        {kind === "file" && (
          <Button
            data-focusable
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => {
              void run("Choosing a catalog…", async () => {
                const path = await pickSignedCatalogPath();
                if (path) {
                  setLocation(path);
                  setPlan(undefined);
                }
              });
            }}
          >
            Choose file
          </Button>
        )}
      </div>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !location.trim()}
        onClick={() => {
          void run("Verifying catalog…", async () => {
            setPlan(
              await desktopApi.planCatalogUpdate({
                kind,
                value: location.trim(),
              }),
            );
          });
        }}
      >
        Review update
      </Button>
      {plan && (
        <section className="mt-3 grid gap-3" aria-label="Catalog update review">
          <h3>Review catalog information</h3>
          <p>Signature verified with a trusted publisher key.</p>
          <p>{catalogChangeSummary(plan.changed_ports.length)}</p>
          {plan.changed_ports.length > 0 && (
            <ul aria-label="Affected ports">
              {plan.changed_ports.map((port) => (
                <li key={port.id}>{port.name}</li>
              ))}
            </ul>
          )}
          <p>This does not install game updates.</p>
          <p>Trusting a publisher allows changes to release download locations.</p>
          <details>
            <summary
              data-focusable
              aria-label={`Technical details for catalog update sequence ${plan.sequence}`}
            >
              Technical details
            </summary>
            <dl>
              <dt>Signature</dt>
              <dd>Valid</dd>
              <dt>Publisher key</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{plan.key_id}</code>
              </dd>
              <dt>Publisher trust</dt>
              <dd>Trusted</dd>
              <dt>Sequence</dt>
              <dd>{plan.sequence} accepted</dd>
              <dt>Valid until</dt>
              <dd>{new Date(plan.expires_at * 1000).toLocaleString()}</dd>
              <dt>Changed port IDs</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">
                  {plan.changed_ports.map((port) => port.id).join(", ") || "None"}
                </code>
              </dd>
              <dt>Envelope SHA-256</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{plan.envelope_sha256}</code>
              </dd>
            </dl>
          </details>
          <Button
            data-focusable
            variant="primary"
            disabled={Boolean(busy)}
            onClick={() => {
              const reviewed = plan;
              setPlan(undefined);
              void run("Applying catalog update…", async () => {
                await changed(
                  await desktopApi.applyCatalogUpdate(
                    reviewed.source,
                    reviewed.plan_sha256,
                    (event) => {
                      if (event.type === "started") started(event.operation_id);
                    },
                  ),
                  "Catalog update applied.",
                );
              });
            }}
          >
            Apply catalog update
          </Button>
        </section>
      )}
    </section>
  );
}

function catalogChangeSummary(count: number) {
  if (count === 0) return "No port information will change.";
  return `Catalog information will change for ${count.toLocaleString()} ${count === 1 ? "port" : "ports"}.`;
}

function CatalogSelection({ status, busy, run, changed }: CatalogActions) {
  return (
    <div className="actions compact mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !status.can_rollback}
        onClick={() => {
          void run("Restoring previous catalog…", async () =>
            changed(
              await desktopApi.rollbackCatalog(status.state_sha256),
              "Previous catalog restored.",
            ),
          );
        }}
      >
        Restore previous catalog
      </Button>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || status.updates_enabled || !status.can_use_cached}
        onClick={() => {
          void run("Selecting cached catalog…", async () =>
            changed(
              await desktopApi.useCachedCatalog(status.state_sha256),
              "Cached signed catalog selected.",
            ),
          );
        }}
      >
        Use cached signed catalog
      </Button>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !status.updates_enabled}
        onClick={() => {
          void run("Selecting built-in catalog…", async () =>
            changed(
              await desktopApi.useEmbeddedCatalog(status.state_sha256),
              "Built-in catalog selected.",
            ),
          );
        }}
      >
        Use built-in catalog
      </Button>
    </div>
  );
}

function ListingDeliveryControls({
  disabled,
  onChanged,
}: {
  disabled: boolean;
  onChanged?: (() => Promise<unknown>) | undefined;
}) {
  const metadataId = useId();
  const targetsId = useId();
  const [status, setStatus] = useState<ListingDeliveryStatus>();
  const [metadata, setMetadata] = useState("");
  const [targets, setTargets] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    void desktopApi
      .listingDeliveryStatus()
      .then((value) => {
        if (current) setStatus(value);
      })
      .catch((cause: unknown) => {
        if (current) setError(errorText(cause));
      });
    return () => {
      current = false;
    };
  }, []);
  const refresh = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await desktopApi.refreshCatalogListings(metadata, targets, () => {}));
      await onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>Directory updates</summary>
      <p>
        Refresh port listings, artwork and setup information from the configured official publisher.
        Game installations keep their existing permissions and files.
      </p>
      {status && (
        <p>
          {status.selected
            ? `Directory revision ${status.revision} · ${status.listing_count} published listings`
            : "Using the built-in directory"}
        </p>
      )}
      {status?.fallback_reason && <p>{status.fallback_reason}</p>}
      <label htmlFor={metadataId}>
        Catalog metadata address
        <Input
          id={metadataId}
          value={metadata}
          onChange={(event) => setMetadata(event.target.value)}
          placeholder="https://"
          disabled={disabled || busy}
        />
      </label>
      <label htmlFor={targetsId}>
        Catalog content address
        <Input
          id={targetsId}
          value={targets}
          onChange={(event) => setTargets(event.target.value)}
          placeholder="https://"
          disabled={disabled || busy}
        />
      </label>
      <Button
        disabled={disabled || busy || !metadata || !targets}
        onClick={() => {
          void refresh();
        }}
      >
        {busy ? "Refreshing directory…" : "Refresh directory"}
      </Button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
