import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { GameSettingsChangeSetView } from "../types";
import { useAppTranslation } from "../localization";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { GameSettingsPanel, type ReportSettingsDraft } from "./GameSettingsPanel";

type Props = {
  portId: string;
  installId: string;
  generation: number;
  busy: boolean;
  reportDraft?: ReportSettingsDraft | undefined;
};

export function GameSettingsControl(props: Props) {
  return (
    <BoundGameSettingsControl
      key={JSON.stringify([props.portId, props.installId, props.generation])}
      {...props}
    />
  );
}

function BoundGameSettingsControl({ portId, installId, generation, busy, reportDraft }: Props) {
  const [view, setView] = useState<GameSettingsChangeSetView>();
  const [error, setError] = useState<{ kind: "changed" } | { kind: "failure"; text: string }>();
  const { t } = useAppTranslation("gameSettings");
  const [request, setRequest] = useState(0);
  const [complete, setComplete] = useState(0);
  const [fileReadRevisions, setFileReadRevisions] = useState(() => new Map<string, number>());
  const loading = complete !== request;

  useEffect(() => {
    if (busy || !loading) return;
    let current = true;
    void desktopApi.gameSettingsChangeSetView(portId, generation).then(
      (next) => {
        if (!current) return;
        setComplete(request);
        if (
          next.settings.port_id !== portId ||
          (next.settings.available &&
            (!next.settings.install_id ||
              !next.installed_version ||
              (next.setup ? !next.setup_name : next.settings.install_id !== installId)))
        ) {
          setError({ kind: "changed" });
          return;
        }
        if (next.settings.available) {
          setFileReadRevisions((previous) => {
            const revisions = new Map(previous);
            for (const file of next.settings.files) {
              if (file.available && file.configuration_sha256) revisions.set(file.id, request);
            }
            return revisions;
          });
        }
        // Keep file drafts mounted while a refresh cannot read their source.
        setView((previous) => {
          if (!previous) return next;
          const missing = previous.settings.files.filter(
            (file) => !next.settings.files.some(({ id }) => id === file.id),
          );
          if (!missing.length) return next;
          return {
            ...next,
            settings: {
              ...next.settings,
              files: [
                ...next.settings.files,
                ...missing.map((file) => ({
                  ...file,
                  available: false,
                  configuration_sha256: null,
                })),
              ],
            },
          };
        });
      },
      (failure: unknown) => {
        if (!current) return;
        setError({ kind: "failure", text: errorText(failure) });
        setComplete(request);
      },
    );
    return () => {
      current = false;
    };
  }, [portId, installId, generation, busy, loading, request]);

  const reread = () => {
    setError(undefined);
    setRequest((value) => value + 1);
  };

  if (!request && !busy)
    return (
      <section aria-label={t("control.label")}>
        <h3 className="text-sm font-semibold">{t("control.heading")}</h3>
        <p>{t("control.intro")}</p>
        <Button variant="outline" onClick={reread}>
          {t("control.read")}
        </Button>
      </section>
    );
  return (
    <>
      {busy && <p role="status">{t("control.busy")}</p>}
      {loading && !busy && <p role="status">{t("control.reading")}</p>}
      {error && (
        <p role="alert">
          {error.kind === "changed" ? t("control.installationChanged") : error.text}
        </p>
      )}
      {view && (
        <GameSettingsPanel
          view={view}
          generation={generation}
          fileReadRevisions={fileReadRevisions}
          reportDraft={reportDraft}
          disabled={busy || loading || !!error}
          actions={{
            review: (fileId, edits) =>
              desktopApi.reviewGameSettingsChangeSet(portId, fileId, edits, generation),
            apply: (review) => desktopApi.applyGameSettingsChangeSet(review, generation),
          }}
          changed={(next) => {
            if (next.port_id !== portId || next.install_id !== view.settings.install_id) {
              setError({ kind: "changed" });
            } else {
              setView({ ...view, settings: next });
            }
          }}
        />
      )}
      {!!request && (
        <Button variant="outline" disabled={busy || loading} onClick={reread}>
          {t("control.reread")}
        </Button>
      )}
    </>
  );
}
