import { reloadWorkspace } from "../reload-workspace";
import { useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { pickInstallFolder, pickMetadataImportPath } from "../file-picker";
import { useAppTranslation } from "../localization";
import type { LibraryImportPlan } from "../types";
import { errorText } from "../view-model";
import { LibraryCopySummary, transferRecoveryRoot } from "./LibraryMove";
import { NavigationHints } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

export function LibraryImportButton({
  disabled,
  libraryRoot,
}: {
  disabled: boolean;
  libraryRoot: string;
}) {
  const { t } = useAppTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        data-focusable
        data-settings-control="import-library"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t("libraryRestore.open")}
      </Button>
      {open && <LibraryImportDialog libraryRoot={libraryRoot} close={() => setOpen(false)} />}
    </>
  );
}

/** App-owned progress states; each renders one complete message. */
type Busy = "" | "choosing" | "reviewing" | "copying" | "recovering";

function LibraryImportDialog({ libraryRoot, close }: { libraryRoot: string; close: () => void }) {
  const { t } = useAppTranslation("settings");
  const metadataInput = useRef<HTMLInputElement>(null);
  const [metadata, setMetadata] = useState("");
  const [content, setContent] = useState("");
  const [plan, setPlan] = useState<LibraryImportPlan>();
  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState<unknown>();
  const [transferAttempted, setTransferAttempted] = useState(false);
  const dismiss = () => {
    if (!busy) {
      if (transferAttempted) reloadWorkspace();
      else close();
    }
  };
  const recoveryRoot = transferRecoveryRoot(error, "import_destination");
  const run = async (label: Exclude<Busy, "">, operation: () => Promise<void>) => {
    setBusy(label);
    setError(undefined);
    try {
      await operation();
    } catch (value) {
      setError(value);
      setPlan(undefined);
    } finally {
      setBusy("");
    }
  };
  const choose = (field: "metadata" | "content") =>
    run("choosing", async () => {
      const path =
        field === "metadata" ? await pickMetadataImportPath() : await pickInstallFolder(content);
      if (path) {
        (field === "metadata" ? setMetadata : setContent)(path);
        setPlan(undefined);
      }
    });
  const locked = Boolean(busy) || Boolean(recoveryRoot);
  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        initialFocus={metadataInput}
        showCloseButton={false}
        reviewSize="large"
        aria-describedby="import-library-description"
      >
        <DialogTitle id="import-library-title" className="mb-2 text-xl">
          {t("libraryRestore.title")}
        </DialogTitle>
        <DialogDescription id="import-library-description" className="mb-4 leading-relaxed">
          {t("libraryRestore.description")}
        </DialogDescription>
        <p>
          <Trans t={t} i18nKey="libraryRestore.trust" components={{ strong: <strong /> }} />
        </p>
        <p className="min-w-0 [overflow-wrap:anywhere]">
          <Trans
            t={t}
            i18nKey="libraryRestore.destination"
            components={{
              path: (
                <bdi dir="ltr">
                  <code>{libraryRoot}</code>
                </bdi>
              ),
            }}
          />
        </p>
        <NavigationHints />
        <label htmlFor="import-metadata">{t("libraryRestore.metadata")}</label>
        <div className="grid min-w-0 gap-2 min-[48rem]:grid-cols-[minmax(0,1fr)_auto] [&_input]:min-w-0">
          <Input
            ref={metadataInput}
            data-focusable
            id="import-metadata"
            value={metadata}
            disabled={locked}
            onChange={(event) => {
              setMetadata(event.target.value);
              setPlan(undefined);
            }}
            placeholder={t("libraryRestore.metadataPlaceholder")}
          />
          <Button
            data-focusable
            variant="outline"
            disabled={locked}
            onClick={() => {
              void choose("metadata");
            }}
          >
            {t("libraryRestore.chooseFile")}
          </Button>
        </div>
        <label htmlFor="import-content">{t("libraryRestore.content")}</label>
        <div className="grid min-w-0 gap-2 min-[48rem]:grid-cols-[minmax(0,1fr)_auto] [&_input]:min-w-0">
          <Input
            data-focusable
            id="import-content"
            value={content}
            disabled={locked}
            onChange={(event) => {
              setContent(event.target.value);
              setPlan(undefined);
            }}
            placeholder={t("libraryRestore.contentPlaceholder")}
          />
          <Button
            data-focusable
            variant="outline"
            disabled={locked}
            onClick={() => {
              void choose("content");
            }}
          >
            {t("libraryRestore.chooseFolder")}
          </Button>
        </div>
        {plan && (
          <LibraryCopySummary
            plan={plan}
            source={plan.content_root}
            label={t("libraryRestore.plan")}
          />
        )}
        {busy && (
          <p role="status">
            {busy === "choosing"
              ? t("libraryRestore.busy.choosing")
              : busy === "reviewing"
                ? t("libraryRestore.busy.reviewing")
                : busy === "copying"
                  ? t("libraryRestore.busy.copying")
                  : t("libraryRestore.busy.recovering")}
          </p>
        )}
        {error != null && <p role="alert">{errorText(error)}</p>}
        {transferAttempted && !busy && <p>{t("libraryRestore.closeRefreshes")}</p>}
        {recoveryRoot && (
          <LibraryImportRecovery
            destination={recoveryRoot}
            onBusyChange={(active) => setBusy(active ? "recovering" : "")}
          />
        )}
        <DialogFooter className="mt-4">
          <Button data-focusable variant="outline" disabled={Boolean(busy)} onClick={dismiss}>
            {t("libraryRestore.close")}
          </Button>
          {!recoveryRoot &&
            (plan ? (
              <Button
                data-focusable
                variant="primary"
                disabled={Boolean(busy)}
                onClick={() => {
                  void run("copying", async () => {
                    setTransferAttempted(true);
                    await desktopApi.importLibrary(
                      plan.metadata_file.path,
                      plan.content_root,
                      plan.plan_sha256,
                    );
                    reloadWorkspace();
                  });
                }}
              >
                {t("libraryRestore.restore")}
              </Button>
            ) : (
              <Button
                data-focusable
                disabled={Boolean(busy) || !metadata.trim() || !content.trim()}
                onClick={() => {
                  void run("reviewing", async () =>
                    setPlan(await desktopApi.planLibraryImport(metadata, content)),
                  );
                }}
              >
                {t("libraryRestore.review")}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LibraryImportRecovery({
  destination,
  onBusyChange,
  disabled = false,
}: {
  destination: string;
  onBusyChange?: (active: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useAppTranslation("settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recover = async () => {
    if (busy || disabled) return;
    setBusy(true);
    setError(undefined);
    onBusyChange?.(true);
    try {
      await desktopApi.recoverLibraryImport(destination);
      reloadWorkspace();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <section aria-label={t("libraryRestore.recovery.label")}>
      <h2 className="text-base">{t("libraryRestore.recovery.heading")}</h2>
      <p className="[overflow-wrap:anywhere] [unicode-bidi:plaintext]">
        <Trans
          t={t}
          i18nKey="libraryRestore.recovery.destination"
          components={{ path: <bdi dir="ltr">{destination}</bdi> }}
        />
      </p>
      <p>{t("libraryRestore.recovery.intro")}</p>
      <Button
        data-focusable
        variant="primary"
        disabled={busy || disabled}
        onClick={() => {
          void recover();
        }}
      >
        {t("libraryRestore.recovery.resume")}
      </Button>
      {busy && <p role="status">{t("libraryRestore.recovery.busy")}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
