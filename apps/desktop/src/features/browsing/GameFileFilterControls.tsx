import { GameFileObservationSummary } from "./GameFileObservationSummary";
import { ChoiceSelect } from "../../components/ChoiceSelect";
import { OperationCancellation } from "../../components/OperationCancellation";
import { Button } from "../../components/ui/button";
import { platformLabel, releaseChannelPresentation } from "../../view-model";
import { useAppTranslation } from "../../localization";
import {
  gameFileCheckFailureText,
  gameFileRouteLabel,
  routeValues,
} from "./game-file-query-context";
import type { GameFileFilterState } from "./use-game-file-filter-context";

export function GameFileFilterControls({ state }: { state: GameFileFilterState }) {
  const { selection } = state;
  const { t } = useAppTranslation("gameFiles");
  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">{t("controls.legend")}</legend>
      <ChoiceSelect
        label={t("controls.route")}
        value={selection.route}
        options={routeValues.map((value) => ({ value, label: gameFileRouteLabel(t, value) }))}
        disabled={state.pending}
        onChange={(route) => state.setSelection((current) => ({ ...current, route }))}
      />
      <ChoiceSelect
        label={t("controls.platform")}
        value={selection.platform}
        options={(["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"] as const).map(
          (value) => ({ value, label: platformLabel(value) }),
        )}
        disabled={state.pending}
        onChange={(platform) => state.setSelection((current) => ({ ...current, platform }))}
      />
      <ChoiceSelect
        label={t("controls.channel")}
        value={selection.channel}
        options={(["stable", "beta", "rolling"] as const).map((value) => ({
          value,
          label: releaseChannelPresentation(value).label,
        }))}
        disabled={state.pending}
        onChange={(channel) => state.setSelection((current) => ({ ...current, channel }))}
      />
      <p>{t("controls.description")}</p>
      <Button
        data-focusable
        variant="outline"
        disabled={state.pending || !state.available}
        onClick={() => {
          void state.refresh();
        }}
      >
        {state.pending ? t("controls.checking") : t("controls.check")}
      </Button>
      {state.pending && state.operationId && (
        <OperationCancellation
          key={state.operationId}
          operationId={state.operationId}
          label={t("controls.cancel")}
        />
      )}
      <GameFileObservationSummary observation={state.observation} catalog />
      {state.error && <p role="alert">{gameFileCheckFailureText(t, state.error)}</p>}
    </fieldset>
  );
}
