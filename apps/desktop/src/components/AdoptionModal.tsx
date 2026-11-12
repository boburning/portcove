import { type ReactNode, useEffect, useRef } from "react";
import { FolderInput, FolderOpen, ShieldCheck, X } from "lucide-react";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import { formatBytes } from "../view-model";
import { gameIdentityLabel } from "../port-identity";
import { Icon, NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import type { AdoptionPreview, PortDefinition } from "../types";

export function AdoptionModal({
  path,
  setPath,
  preview,
  busy,
  applying = false,
  copyFailed,
  close,
  review,
  adopt,
  pickFolder,
  ports = [],
  launcherImport,
}: {
  path: string;
  setPath: (path: string) => void;
  preview?: AdoptionPreview | undefined;
  busy?: string | undefined;
  applying?: boolean;
  copyFailed?: boolean;
  close: () => void;
  review: (selectedPortId?: string) => void;
  adopt: () => void;
  pickFolder?: () => void;
  ports?: readonly PortDefinition[];
  /** Optional read-only list of another launcher's apps that fills `path`. */
  launcherImport?: ReactNode;
}) {
  const { t } = useAppTranslation("installation");
  const dismiss = () => {
    if (!applying) close();
  };
  const titleRef = useRef<HTMLHeadingElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const portIdentityRef = useRef<HTMLParagraphElement>(null);
  const pendingCandidate = useRef<{ path: string; id: string } | null>(null);
  useEffect(() => {
    const pending = pendingCandidate.current;
    if (!pending) return;
    if (pending.path !== path) {
      pendingCandidate.current = null;
      return;
    }
    if (preview?.selected_port_id === pending.id && preview.destination) {
      if (document.activeElement === titleRef.current || document.activeElement === document.body)
        portIdentityRef.current?.focus();
      pendingCandidate.current = null;
    }
  }, [path, preview]);
  const portIdentity = preview ? adoptionPortIdentity(preview, ports) : undefined;
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={() => (preview || busy || applying ? titleRef.current : pathInput.current)}
        showCloseButton={false}
        reviewSize="compact"
        aria-describedby="adopt-description"
      >
        <Button
          data-focusable
          variant="ghost"
          size="icon-sm"
          className="absolute top-2 right-2"
          aria-label={t("adoption.closeLabel")}
          onClick={dismiss}
          disabled={applying}
        >
          <Icon glyph={X} />
        </Button>
        <span className="mb-4 grid size-11 place-items-center rounded-lg border border-pc-interactive bg-pc-selection text-pc-selection-foreground">
          <Icon glyph={FolderInput} size="lg" />
        </span>
        <DialogTitle ref={titleRef} tabIndex={-1} id="adopt-title" className="mb-2 text-xl">
          {t("adoption.title")}
        </DialogTitle>
        <DialogDescription id="adopt-description" className="mb-4 leading-relaxed">
          {t("adoption.description")}
        </DialogDescription>
        <p className="inline-assurance mb-5 flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-success-text)]">
          <Icon glyph={ShieldCheck} /> {t("adoption.assurance")}
        </p>
        <NavigationHints />
        {launcherImport}
        <label htmlFor="adopt-path">{t("adoption.folder")}</label>
        <div className="flex items-stretch gap-2 [&_input]:min-w-0">
          <Input
            ref={pathInput}
            data-focusable
            id="adopt-path"
            value={path}
            disabled={Boolean(busy) || applying}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t("adoption.folderPlaceholder")}
          />
          {pickFolder && (
            <Button
              data-focusable
              variant="outline"
              type="button"
              disabled={Boolean(busy) || applying}
              onClick={pickFolder}
            >
              <Icon glyph={FolderOpen} />
              {t("adoption.browse")}
            </Button>
          )}
        </div>
        {preview && (
          <section
            className="adoption-plan adoption-review m-[var(--space-4)_0] max-h-[none] overflow-visible rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-4 [overflow-wrap:anywhere]"
            aria-label={t("adoption.plan")}
          >
            <p
              ref={portIdentityRef}
              id="adopt-port-identity"
              tabIndex={preview.selected_port_id ? -1 : undefined}
              className="m-[0_0_var(--space-2)] rounded-sm text-[var(--color-text-secondary)] focus:outline-2 focus:outline-offset-2 focus:outline-pc-ring"
            >
              <strong>
                {portIdentity?.kind === "selected"
                  ? (portIdentity.ports[0]?.name ?? t("adoption.unknownPort"))
                  : portIdentity?.kind === "ambiguous"
                    ? t("adoption.multiple")
                    : t("adoption.none")}
              </strong>
              {portIdentity?.kind === "selected" && portIdentity.ports[0]?.id && (
                <>
                  <br />
                  <small>
                    <Trans
                      t={t}
                      i18nKey="adoption.catalogId"
                      components={{ id: <code dir="ltr">{portIdentity.ports[0].id}</code> }}
                    />
                  </small>
                </>
              )}
            </p>
            {portIdentity?.kind === "ambiguous" && (
              <>
                <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
                  {t("adoption.ambiguous")}
                </p>
                <ul className="ps-5" aria-label={t("adoption.detected")}>
                  {portIdentity.ports.map((port) => (
                    <li key={port.id}>
                      <Button
                        data-focusable
                        variant="outline"
                        type="button"
                        className="h-auto min-h-(--control-height-md) w-full max-w-full min-w-0 justify-start py-2 text-start break-words whitespace-normal"
                        disabled={Boolean(busy) || applying}
                        onClick={() => {
                          pendingCandidate.current = { path, id: port.id };
                          titleRef.current?.focus();
                          review(port.id);
                        }}
                      >
                        {t("adoption.reviewPort", {
                          name: port.name ?? t("adoption.unknownPort"),
                          id: port.id,
                        })}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
              {preview.selected_port_id
                ? t("adoption.copyCount", {
                    count: preview.copy_plan.files.length,
                    size: formatBytes(preview.copy_plan.total_bytes),
                  })
                : t("adoption.foundCount", {
                    count: preview.copy_plan.files.length,
                    size: formatBytes(preview.copy_plan.total_bytes),
                  })}
            </p>
            {preview.copy_plan.skipped_entries.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[var(--color-warning-text)]">
                  {t("adoption.skipped", { count: preview.copy_plan.skipped_entries.length })}
                </summary>
                <ul className="ps-5">
                  {preview.copy_plan.skipped_entries.map((entry) => (
                    <li key={entry.relative_path}>
                      <Trans
                        t={t}
                        i18nKey="adoption.skippedEntry"
                        components={{
                          path: <code dir="ltr">{entry.relative_path}</code>,
                          reason: <bdi>{entry.reason}</bdi>,
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
              <Trans
                t={t}
                i18nKey="adoption.original"
                components={{ strong: <strong />, path: <bdi dir="ltr">{preview.source}</bdi> }}
              />
            </p>
            {preview.destination && <AdoptionConsequences destination={preview.destination} />}
            <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
              {t("adoption.unchanged")}
            </p>
            <p className="m-[0_0_var(--space-2)] text-[var(--color-text-secondary)]">
              {t("adoption.noUndo")}
            </p>
            <p className="m-[0_0_var(--space-2)] mb-0 text-[var(--color-text-secondary)]">
              {t("adoption.stopFirst")}
            </p>
          </section>
        )}
        {copyFailed && <p role="alert">{t("adoption.copyFailed")}</p>}
        <AdoptionActions
          path={path}
          preview={preview}
          busy={busy}
          applying={applying}
          dismiss={dismiss}
          review={review}
          adopt={adopt}
        />
      </DialogContent>
    </Dialog>
  );
}

function AdoptionActions({
  path,
  preview,
  busy,
  applying,
  dismiss,
  review,
  adopt,
}: {
  path: string;
  preview?: AdoptionPreview | undefined;
  busy?: string | undefined;
  applying: boolean;
  dismiss: () => void;
  review: () => void;
  adopt: () => void;
}) {
  const { t } = useAppTranslation("installation");
  return (
    <DialogFooter className="mt-4">
      <Button data-focusable variant="outline" onClick={dismiss} disabled={applying}>
        {t("adoption.cancel")}
      </Button>
      {preview ? (
        <Button
          data-focusable
          variant="primary"
          aria-describedby={
            preview.destination?.imported_user_data_paths.length ? "adopt-save-warning" : undefined
          }
          disabled={Boolean(busy) || applying || !preview.selected_port_id || !preview.destination}
          onClick={adopt}
        >
          <Icon glyph={FolderInput} />
          {applying ? t("adoption.copying") : t("adoption.continue")}
        </Button>
      ) : (
        <Button
          data-focusable
          variant="primary"
          disabled={!path.trim() || Boolean(busy) || applying}
          onClick={() => review()}
        >
          <Icon glyph={FolderInput} />
          {applying
            ? t("adoption.copying")
            : busy === "preview adoption"
              ? t("adoption.reviewing")
              : t("adoption.review")}
        </Button>
      )}
    </DialogFooter>
  );
}

function adoptionPortIdentity(preview: AdoptionPreview, ports: readonly PortDefinition[]) {
  const presentation = (id: string) => {
    const port = ports.find((candidate) => candidate.id === id);
    return { id, name: port ? gameIdentityLabel(port) : undefined };
  };
  if (preview.selected_port_id)
    return { kind: "selected" as const, ports: [presentation(preview.selected_port_id)] };
  if (preview.detected_port_ids.length > 0)
    return { kind: "ambiguous" as const, ports: preview.detected_port_ids.map(presentation) };
  return { kind: "none" as const, ports: [] };
}

function AdoptionConsequences({
  destination,
}: {
  destination: NonNullable<AdoptionPreview["destination"]>;
}) {
  const { t } = useAppTranslation("installation");
  return (
    <>
      <p>
        <Trans
          t={t}
          i18nKey="adoption.appDestination"
          components={{
            strong: <strong />,
            br: <br />,
            path: <bdi dir="ltr">{destination.output_location.effective_output_directory}</bdi>,
          }}
        />
      </p>
      {destination.active_install && (
        <p>
          <Trans
            t={t}
            i18nKey="adoption.activeVersion"
            components={{
              strong: <strong />,
              br: <br />,
              version: <bdi>{destination.active_install.version}</bdi>,
              path: <bdi dir="ltr">{destination.active_install.path}</bdi>,
            }}
          />
        </p>
      )}
      <p>
        <Trans
          t={t}
          i18nKey="adoption.savedDestination"
          count={destination.current_user_data_files}
          components={{
            strong: <strong />,
            br: <br />,
            path: <bdi dir="ltr">{destination.output_location.user_data_root}</bdi>,
          }}
        />
      </p>
      {destination.imported_user_data_paths.length > 0 ? (
        <div
          id="adopt-save-warning"
          className="adoption-save-warning m-[var(--space-2)_0] rounded-pc-md border border-[var(--color-warning-border)] bg-[var(--color-warning-subtle)] p-3 text-[var(--color-warning-text)]"
          role="note"
        >
          <strong>{t("adoption.replace.heading")}</strong>
          <p>{t("adoption.replace.text")}</p>
          <p>{t("adoption.replace.paths")}</p>
          <ul aria-label={t("adoption.replace.pathsLabel")}>
            {destination.imported_user_data_paths.map((path) => (
              <li key={path}>
                <bdi dir="ltr">{path}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p>{t("adoption.noSavedPaths")}</p>
      )}
    </>
  );
}
