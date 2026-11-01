import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import type { GameSettingsView } from "../types";
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
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (busy || request === 0) return;
    let current = true;
    void desktopApi.gameSettings(portId, generation).then(
      (next) => {
        if (!current) return;
        if (next.port_id !== portId || (next.available && next.install_id !== installId)) {
          setError("This installation changed. Refresh its details before editing settings.");
          return;
        }
        setView(next);
      },
      (failure: unknown) => {
        if (current) setError(errorText(failure));
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
  if (busy)
    return <p role="status">Finish the current operation before reviewing game settings.</p>;
  if (error)
    return (
      <section aria-label="Game settings">
        <p role="alert">{error}</p>
        <Button variant="outline" onClick={reread}>
          Read settings again
        </Button>
      </section>
    );
  if (request === 0)
    return (
      <section aria-label="Game settings">
        <h3 className="text-sm font-semibold">Game settings</h3>
        <p>Check the settings offered by this installed version.</p>
        <Button variant="outline" onClick={() => setRequest(1)}>
          Read game settings
        </Button>
      </section>
    );
  if (!view) return <p role="status">Reading game settings…</p>;
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
            setError("This installation changed. Refresh its details before editing settings.");
          } else setView(next);
        }}
      />
      <Button variant="outline" onClick={reread}>
        Read settings again
      </Button>
    </>
  );
}
