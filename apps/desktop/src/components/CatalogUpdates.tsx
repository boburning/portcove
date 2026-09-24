import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickSignedCatalogPath } from "../file-picker";
import type {
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
  provenance?: CatalogProvenance;
  disabled: boolean;
  onChanged?: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article className="settings-card" data-focus-group>
      <p className="eyebrow">CATALOG</p>
      <h2>Catalog updates</h2>
      <CatalogOrigin provenance={provenance} />
      <p>
        Optional signed updates refresh port information and release locations. Choose a publisher
        you trust and review each update. The built-in catalog is always available offline.
      </p>
      <Button
        data-focusable
        data-settings-control="catalog-updates"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Manage catalog updates
      </Button>
      {open && <CatalogUpdatesDialog close={() => setOpen(false)} onChanged={onChanged} />}
    </article>
  );
}

function CatalogOrigin({ provenance }: { provenance?: CatalogProvenance }) {
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
        <code>{reason}</code>
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
  onChanged?: () => Promise<unknown>;
}) {
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
      if (isCancellation(value)) setNotice("Catalog update cancelled.");
      else setError(errorText(value));
    } finally {
      setBusy("");
      setOperationId(undefined);
    }
  };
  const changed = async (next: CatalogStatus | null) => {
    if (!next) return;
    setStatus(next);
    setNotice("Catalog settings saved.");
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
        showCloseButton={false}
        className="catalog-update-dialog max-h-[calc(100dvh-var(--space-8))] w-[min(760px,90vw)] max-w-none gap-0 overflow-y-auto overscroll-contain p-8 [scroll-padding-block:var(--space-4)] sm:max-w-none"
        aria-describedby="catalog-update-description"
      >
        <p className="eyebrow">CATALOG</p>
        <DialogTitle id="catalog-update-title" className="mb-2 text-xl">
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
  changed: (status: CatalogStatus | null) => Promise<void>;
}

function PublisherTrust({ status, busy, run, changed }: CatalogActions) {
  const [publicKey, setPublicKey] = useState("");
  return (
    <>
      <h3>Trusted publishers</h3>
      <p>
        Verify the publisher key through a trusted channel. Trust allows that publisher to change
        release download locations.
      </p>
      {status.trusted_keys.length === 0 && <p>No trusted publishers.</p>}
      {status.trusted_keys.map((key) => (
        <div className="source-health-row" key={key.key_id}>
          <div>
            <span>Publisher fingerprint</span>
            <code>{key.key_id}</code>
          </div>
          <Button
            data-focusable
            variant="destructive"
            disabled={Boolean(busy)}
            onClick={() => {
              void run("Removing publisher…", async () =>
                changed(await desktopApi.revokeCatalogKey(key.key_id, status.state_sha256)),
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
      <div className="path-entry">
        <Input
          data-focusable
          data-autofocus={status.trusted_keys.length === 0 || undefined}
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
              await changed(await desktopApi.trustCatalogKey(publicKey.trim()));
            });
          }}
        >
          Trust publisher
        </Button>
      </div>
    </>
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
    value?: CatalogUpdatePlan;
  }>();
  const plan = planState?.baseline === status.state_sha256 ? planState.value : undefined;
  const setPlan = (value?: CatalogUpdatePlan) =>
    setPlanState({ baseline: status.state_sha256, value });
  return (
    <>
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
      <div className="path-entry">
        <Input
          data-focusable
          data-autofocus={status.trusted_keys.length > 0 || undefined}
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
        <section aria-label="Catalog update review">
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
                <code>{plan.key_id}</code>
              </dd>
              <dt>Publisher trust</dt>
              <dd>Trusted</dd>
              <dt>Sequence</dt>
              <dd>{plan.sequence} accepted</dd>
              <dt>Valid until</dt>
              <dd>{new Date(plan.expires_at * 1000).toLocaleString()}</dd>
              <dt>Changed port IDs</dt>
              <dd>
                <code>{plan.changed_ports.map((port) => port.id).join(", ") || "None"}</code>
              </dd>
              <dt>Envelope SHA-256</dt>
              <dd>
                <code>{plan.envelope_sha256}</code>
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
                );
              });
            }}
          >
            Apply catalog update
          </Button>
        </section>
      )}
    </>
  );
}

function catalogChangeSummary(count: number) {
  if (count === 0) return "No port information will change.";
  return `Catalog information will change for ${count.toLocaleString()} ${count === 1 ? "port" : "ports"}.`;
}

function CatalogSelection({ status, busy, run, changed }: CatalogActions) {
  return (
    <div className="actions compact">
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !status.can_rollback}
        onClick={() => {
          void run("Restoring previous catalog…", async () =>
            changed(await desktopApi.rollbackCatalog(status.state_sha256)),
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
            changed(await desktopApi.useCachedCatalog(status.state_sha256)),
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
            changed(await desktopApi.useEmbeddedCatalog(status.state_sha256)),
          );
        }}
      >
        Use built-in catalog
      </Button>
    </div>
  );
}
