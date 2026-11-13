import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { GameSettingsView } from "../types";
import { useAppTranslation } from "../localization";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { GameSettingsPanel } from "./GameSettingsPanel";

type Props = {
  portId: string;
  installId: string;
  generation: number;
  busy: boolean;
};

export function GameSettingsControl(props: Props) {
  return (
    <BoundGameSettingsControl
      key={JSON.stringify([props.portId, props.installId, props.generation, props.busy])}
      {...props}
    />
  );
}

function BoundGameSettingsControl({ portId, installId, generation, busy }: Props) {
  const [view, setView] = useState<GameSettingsView>();
  // App-owned "changed" is a typed code translated at render; Core failures stay verbatim.
  const [error, setError] = useState<{ kind: "changed" } | { kind: "failure"; text: string }>();
  const { t } = useAppTranslation("gameSettings");
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (busy || request === 0) return;
    let current = true;
    void desktopApi.gameSettings(portId, generation).then(
      (next) => {
        if (!current) return;
        if (next.port_id !== portId || (next.available && next.install_id !== installId)) {
          setError({ kind: "changed" });
          return;
        }
        setView(next);
      },
      (failure: unknown) => {
        if (current) setError({ kind: "failure", text: errorText(failure) });
      },
    );
    return () => {
      current = false;
    };
  }, [portId, installId, generation, busy, request]);
  const reread = () => {
    setError(undefined);
    setView(undefined);
    setRequest((value) => value + 1);
  };
  if (busy) return <p role="status">{t("control.busy")}</p>;
  if (error)
    return (
      <section aria-label={t("control.label")}>
        <p role="alert">
          {error.kind === "changed" ? t("control.installationChanged") : error.text}
        </p>
        <Button variant="outline" onClick={reread}>
          {t("control.reread")}
        </Button>
      </section>
    );
  if (request === 0)
    return (
      <section aria-label={t("control.label")}>
        <h3 className="text-sm font-semibold">{t("control.heading")}</h3>
        <p>{t("control.intro")}</p>
        <Button variant="outline" onClick={() => setRequest(1)}>
          {t("control.read")}
        </Button>
      </section>
    );
  if (!view) return <p role="status">{t("control.reading")}</p>;
  return (
    <>
      <GameSettingsPanel
        view={view}
        generation={generation}
        actions={{
          review: (fileId, settingId, change) =>
            desktopApi.reviewGameSetting(portId, fileId, settingId, change, generation),
          apply: (review) => desktopApi.applyGameSetting(review, generation),
        }}
        changed={(next) => {
          if (next.port_id !== portId || (next.available && next.install_id !== installId)) {
            setView(undefined);
            setError({ kind: "changed" });
          } else setView(next);
        }}
      />
      <Button variant="outline" onClick={reread}>
        {t("control.reread")}
      </Button>
    </>
  );
}
