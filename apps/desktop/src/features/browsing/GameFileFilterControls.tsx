import { GameFileObservationSummary } from "./GameFileObservationSummary";
import { ChoiceSelect } from "../../components/ChoiceSelect";
import { OperationCancellation } from "../../components/OperationCancellation";
import { Button } from "../../components/ui/button";
import { platformLabel, releaseChannelPresentation } from "../../view-model";
import { routes } from "./game-file-query-context";
import type { GameFileFilterState } from "./use-game-file-filter-context";

export function GameFileFilterControls({ state }: { state: GameFileFilterState }) {
  const { selection } = state;
  return (
    <fieldset className="grid gap-2">
      <legend className="font-medium">Game-file observation context</legend>
      <ChoiceSelect
        label="Observed route"
        value={selection.route}
        options={routes}
        disabled={state.pending}
        onChange={(route) => state.setSelection((current) => ({ ...current, route }))}
      />
      <ChoiceSelect
        label="Observed target platform"
        value={selection.platform}
        options={(["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"] as const).map(
          (value) => ({ value, label: platformLabel(value) }),
        )}
        disabled={state.pending}
        onChange={(platform) => state.setSelection((current) => ({ ...current, platform }))}
      />
      <ChoiceSelect
        label="Observed channel"
        value={selection.channel}
        options={(["stable", "beta", "rolling"] as const).map((value) => ({
          value,
          label: releaseChannelPresentation(value).label,
        }))}
        disabled={state.pending}
        onChange={(channel) => state.setSelection((current) => ({ ...current, channel }))}
      />
      <p>
        Game-file choices use this exact route, platform and channel. Other filter groups remain
        independent. Checking reads connected files within the existing limits; changing filters
        does not scan, plan or install.
      </p>
      <Button
        data-focusable
        variant="outline"
        disabled={state.pending || !state.available}
        onClick={() => {
          void state.refresh();
        }}
      >
        {state.pending ? "Checking game-file filters…" : "Check game-file filters"}
      </Button>
      {state.pending && state.operationId && (
        <OperationCancellation
          key={state.operationId}
          operationId={state.operationId}
          label="Cancel game-file filter check"
        />
      )}
      <GameFileObservationSummary observation={state.observation} catalog />
      {state.error && <p role="alert">{state.error}</p>}
    </fieldset>
  );
}
