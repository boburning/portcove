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
import type { TFunction } from "i18next";
import { useAppTranslation } from "../localization";

type CatalogBusy =
  | ""
  | "loading"
  | "removingPublisher"
  | "confirmingPublisher"
  | "choosingCatalog"
  | "verifyingCatalog"
  | "applyingUpdate"
  | "restoringPrevious"
  | "selectingCached"
  | "selectingBuiltIn";
type CatalogNotice =
  | "cancelled"
  | "publisherRemoved"
  | "publisherTrusted"
  | "updateApplied"
  | "previousRestored"
  | "cachedSelected"
  | "builtInSelected";

function busyCopy(t: TFunction<"catalogUpdates">, busy: Exclude<CatalogBusy, "">) {
  switch (busy) {
    case "loading":
      return t("custom.busyLoading");
    case "removingPublisher":
      return t("custom.busyRemovingPublisher");
    case "confirmingPublisher":
      return t("custom.busyConfirmingPublisher");
    case "choosingCatalog":
      return t("custom.busyChoosingCatalog");
    case "verifyingCatalog":
      return t("custom.busyVerifyingCatalog");
    case "applyingUpdate":
      return t("custom.busyApplyingUpdate");
    case "restoringPrevious":
      return t("custom.busyRestoringPrevious");
    case "selectingCached":
      return t("custom.busySelectingCached");
    case "selectingBuiltIn":
      return t("custom.busySelectingBuiltIn");
  }
}

function noticeCopy(t: TFunction<"catalogUpdates">, notice: CatalogNotice) {
  switch (notice) {
    case "cancelled":
      return t("custom.noticeCancelled");
    case "publisherRemoved":
      return t("custom.noticePublisherRemoved");
    case "publisherTrusted":
      return t("custom.noticePublisherTrusted");
    case "updateApplied":
      return t("custom.noticeUpdateApplied");
    case "previousRestored":
      return t("custom.noticePreviousRestored");
    case "cachedSelected":
      return t("custom.noticeCachedSelected");
    case "builtInSelected":
      return t("custom.noticeBuiltInSelected");
  }
}

export function CatalogSettings({
  provenance,
  disabled,
  onChanged,
}: {
  provenance?: CatalogProvenance | undefined;
  disabled: boolean;
  onChanged?: (() => Promise<unknown>) | undefined;
}) {
  const { t } = useAppTranslation("catalogUpdates");
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow className="" data-focus-group>
      <h2>{t("custom.title")}</h2>
      <CatalogOrigin provenance={provenance} />
      <p>{t("custom.description")}</p>
      <Button
        data-focusable
        data-settings-control="catalog-updates"
        className="justify-self-start"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t("custom.manage")}
      </Button>
      <ListingDeliveryControls disabled={disabled} onChanged={onChanged} />
      {open && <CatalogUpdatesDialog close={() => setOpen(false)} onChanged={onChanged} />}
    </SettingsRow>
  );
}

export function CatalogOrigin({ provenance }: { provenance?: CatalogProvenance | undefined }) {
  const { t } = useAppTranslation("catalogUpdates");
  if (!provenance) return <p>{t("custom.loadingInformation")}</p>;
  return (
    <>
      <p>
        {provenance.origin === "embedded"
          ? t("custom.originBuiltIn")
          : provenance.origin === "signed_previous"
            ? t("custom.originSignedPrevious", { version: String(provenance.sequence) })
            : t("custom.originSigned", { version: String(provenance.sequence) })}
      </p>
      {provenance.expires_at && (
        <p>
          {/* Dates follow the system's regional format, separate from message language. */}
          {t("custom.validUntil", {
            time: new Date(provenance.expires_at * 1000).toLocaleString(),
          })}
        </p>
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
  const { t } = useAppTranslation("catalogUpdates");
  return (
    <div className="catalog-fallback-reason">
      <p>{catalogFallbackSummary(t, reason)}</p>
      <details>
        <summary
          data-focusable
          aria-label={t("custom.fallbackDetailsLabel", { position, total: count })}
        >
          {t("custom.technicalDetails")}
        </summary>
        <code className="[overflow-wrap:anywhere]">{reason}</code>
      </details>
    </div>
  );
}

// Known limitation: Core reports fallback reasons as English diagnostics without
// stable codes, so this classifier still matches their text. Unknown reasons use
// the generic message; the original diagnostic stays visible verbatim.
function catalogFallbackSummary(t: TFunction<"catalogUpdates">, reason: string) {
  if (reason.includes("selected definition was not loaded")) return t("custom.fallbackNotLoaded");
  if (reason.includes("replay floor")) return t("custom.fallbackReplay");
  if (reason.includes("signing key is not trusted")) return t("custom.fallbackUntrusted");
  if (reason.includes("signature verification failed")) return t("custom.fallbackSignature");
  if (reason.includes("validity interval")) return t("custom.fallbackExpired");
  return t("custom.fallbackGeneric");
}

function CatalogUpdatesDialog({
  close,
  onChanged,
}: {
  close: () => void;
  onChanged?: (() => Promise<unknown>) | undefined;
}) {
  const { t } = useAppTranslation("catalogUpdates");
  const heading = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState<CatalogStatus>();
  const [busy, setBusy] = useState<CatalogBusy>("loading");
  // Errors keep Core's diagnostic text verbatim.
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<CatalogNotice>();
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
  const run = async (label: Exclude<CatalogBusy, "">, task: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await task();
    } catch (value) {
      if (isCancellation(value)) setNotice("cancelled");
      else setError(errorText(value));
    } finally {
      setBusy("");
      setOperationId(undefined);
    }
  };
  const changed = async (next: CatalogStatus | null, message: CatalogNotice) => {
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
          {t("custom.eyebrow")}
        </p>
        <DialogTitle ref={heading} tabIndex={-1} id="catalog-update-title" className="mb-2 text-xl">
          {t("custom.manage")}
        </DialogTitle>
        <DialogDescription id="catalog-update-description" className="mb-4 leading-relaxed">
          {t("custom.dialogDescription")}
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
        {busy && <p role="status">{busyCopy(t, busy)}</p>}
        {operationId && (
          <OperationCancellation
            key={operationId}
            operationId={operationId}
            label={t("custom.cancelUpdate")}
          />
        )}
        {notice && <p role="status">{noticeCopy(t, notice)}</p>}
        {error && <p role="alert">{error}</p>}
        <DialogFooter className="mt-4 border-t border-pc-border pt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={close}>
            {t("custom.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CatalogActions {
  status: CatalogStatus;
  busy: boolean;
  run: (label: Exclude<CatalogBusy, "">, task: () => Promise<void>) => Promise<void>;
  changed: (status: CatalogStatus | null, message: CatalogNotice) => Promise<void>;
}

function PublisherTrust({ status, busy, run, changed }: CatalogActions) {
  const { t } = useAppTranslation("catalogUpdates");
  const [publicKey, setPublicKey] = useState("");
  return (
    <section className="catalog-publisher-trust mt-6 grid gap-3">
      <h3>{t("custom.trustedTitle")}</h3>
      <p>{t("custom.trustedDescription")}</p>
      {status.trusted_keys.length === 0 && <p>{t("custom.noTrusted")}</p>}
      {status.trusted_keys.map((key) => (
        <div
          className="source-health-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-pc-md border border-pc-border bg-[var(--color-bg-inset)] p-3"
          key={key.key_id}
        >
          <div className="min-w-0">
            <span>{t("custom.fingerprint")}</span>
            <code className="mt-1 block overflow-hidden bg-transparent p-0 text-ellipsis whitespace-nowrap text-pc-muted-foreground">
              {key.key_id}
            </code>
          </div>
          <Button
            data-focusable
            variant="destructive"
            disabled={Boolean(busy)}
            onClick={() => {
              void run("removingPublisher", async () =>
                changed(
                  await desktopApi.revokeCatalogKey(key.key_id, status.state_sha256),
                  "publisherRemoved",
                ),
              );
            }}
          >
            {t("custom.stopTrusting")}
          </Button>
        </div>
      ))}
      <label
        className="mb-2 block text-xs font-bold text-pc-muted-foreground"
        htmlFor="catalog-public-key"
      >
        {t("custom.publicKeyLabel")}
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
            void run("confirmingPublisher", async () => {
              await changed(await desktopApi.trustCatalogKey(publicKey.trim()), "publisherTrusted");
            });
          }}
        >
          {t("custom.trustPublisher")}
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
  const { t } = useAppTranslation("catalogUpdates");
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
      <h3>{t("custom.reviewTitle")}</h3>
      <ChoiceSelect
        triggerId="catalog-update-source"
        label={t("custom.sourceLabel")}
        value={kind}
        options={[
          { value: "file", label: t("custom.sourceFile") },
          { value: "https", label: t("custom.sourceHttps") },
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
        {kind === "file" ? t("custom.locationFile") : t("custom.locationHttps")}
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
              void run("choosingCatalog", async () => {
                const path = await pickSignedCatalogPath();
                if (path) {
                  setLocation(path);
                  setPlan(undefined);
                }
              });
            }}
          >
            {t("custom.chooseFile")}
          </Button>
        )}
      </div>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !location.trim()}
        onClick={() => {
          void run("verifyingCatalog", async () => {
            setPlan(
              await desktopApi.planCatalogUpdate({
                kind,
                value: location.trim(),
              }),
            );
          });
        }}
      >
        {t("custom.reviewUpdate")}
      </Button>
      {plan && (
        <section className="mt-3 grid gap-3" aria-label={t("custom.reviewSection")}>
          <h3>{t("custom.reviewInformation")}</h3>
          <p>{t("custom.signatureVerified")}</p>
          <p>{t("custom.changes", { count: plan.changed_ports.length })}</p>
          {plan.changed_ports.length > 0 && (
            <ul aria-label={t("custom.affectedPorts")}>
              {plan.changed_ports.map((port) => (
                <li key={port.id}>{port.name}</li>
              ))}
            </ul>
          )}
          <p>{t("custom.noGameUpdates")}</p>
          <p>{t("custom.trustLocations")}</p>
          <details>
            <summary
              data-focusable
              aria-label={t("custom.planDetailsLabel", { sequence: plan.sequence })}
            >
              {t("custom.technicalDetails")}
            </summary>
            <dl>
              <dt>{t("custom.detailSignature")}</dt>
              <dd>{t("custom.detailValid")}</dd>
              <dt>{t("custom.detailPublisherKey")}</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">{plan.key_id}</code>
              </dd>
              <dt>{t("custom.detailPublisherTrust")}</dt>
              <dd>{t("custom.detailTrusted")}</dd>
              <dt>{t("custom.detailSequence")}</dt>
              <dd>{t("custom.detailSequenceAccepted", { sequence: plan.sequence })}</dd>
              <dt>{t("custom.detailValidUntil")}</dt>
              <dd>{new Date(plan.expires_at * 1000).toLocaleString()}</dd>
              <dt>{t("custom.detailChangedIds")}</dt>
              <dd>
                <code className="[overflow-wrap:anywhere]">
                  {plan.changed_ports.map((port) => port.id).join(", ") || t("custom.detailNone")}
                </code>
              </dd>
              <dt>{t("custom.detailEnvelope")}</dt>
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
              void run("applyingUpdate", async () => {
                await changed(
                  await desktopApi.applyCatalogUpdate(
                    reviewed.source,
                    reviewed.plan_sha256,
                    (event) => {
                      if (event.type === "started") started(event.operation_id);
                    },
                  ),
                  "updateApplied",
                );
              });
            }}
          >
            {t("custom.applyUpdate")}
          </Button>
        </section>
      )}
    </section>
  );
}

function CatalogSelection({ status, busy, run, changed }: CatalogActions) {
  const { t } = useAppTranslation("catalogUpdates");
  return (
    <div className="actions compact mt-[24px] flex flex-wrap gap-[8px] [&.compact]:mt-[14px]">
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !status.can_rollback}
        onClick={() => {
          void run("restoringPrevious", async () =>
            changed(await desktopApi.rollbackCatalog(status.state_sha256), "previousRestored"),
          );
        }}
      >
        {t("custom.restorePrevious")}
      </Button>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || status.updates_enabled || !status.can_use_cached}
        onClick={() => {
          void run("selectingCached", async () =>
            changed(await desktopApi.useCachedCatalog(status.state_sha256), "cachedSelected"),
          );
        }}
      >
        {t("custom.useCached")}
      </Button>
      <Button
        data-focusable
        variant="outline"
        disabled={Boolean(busy) || !status.updates_enabled}
        onClick={() => {
          void run("selectingBuiltIn", async () =>
            changed(await desktopApi.useEmbeddedCatalog(status.state_sha256), "builtInSelected"),
          );
        }}
      >
        {t("custom.useBuiltIn")}
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
  const { t } = useAppTranslation("catalogUpdates");
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
      <summary>{t("listings.title")}</summary>
      <p>{t("listings.description")}</p>
      {status && (
        <p>
          {status.selected
            ? t("listings.revision", {
                revision: String(status.revision),
                count: status.listing_count,
              })
            : t("listings.builtIn")}
        </p>
      )}
      {status?.fallback_reason && <p>{status.fallback_reason}</p>}
      <label htmlFor={metadataId}>
        {t("listings.metadataAddress")}
        <Input
          id={metadataId}
          value={metadata}
          onChange={(event) => setMetadata(event.target.value)}
          placeholder={t("listings.addressPlaceholder")}
          disabled={disabled || busy}
        />
      </label>
      <label htmlFor={targetsId}>
        {t("listings.contentAddress")}
        <Input
          id={targetsId}
          value={targets}
          onChange={(event) => setTargets(event.target.value)}
          placeholder={t("listings.addressPlaceholder")}
          disabled={disabled || busy}
        />
      </label>
      <Button
        disabled={disabled || busy || !metadata || !targets}
        onClick={() => {
          void refresh();
        }}
      >
        {busy ? t("listings.refreshing") : t("listings.refresh")}
      </Button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
