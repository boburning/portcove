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
      <legend className="font-medium">Game files to check</legend>
      <ChoiceSelect
        label="Setup option"
        value={selection.route}
        options={routes}
        disabled={state.pending}
        onChange={(route) => state.setSelection((current) => ({ ...current, route }))}
      />
      <ChoiceSelect
        label="Platform"
        value={selection.platform}
        options={(["windows-x86-64", "linux-x86-64", "macos-x86-64", "macos-aarch64"] as const).map(
          (value) => ({ value, label: platformLabel(value) }),
        )}
        disabled={state.pending}
        onChange={(platform) => state.setSelection((current) => ({ ...current, platform }))}
      />
      <ChoiceSelect
        label="Channel"
        value={selection.channel}
        options={(["stable", "beta", "rolling"] as const).map((value) => ({
          value,
          label: releaseChannelPresentation(value).label,
        }))}
        disabled={state.pending}
        onChange={(channel) => state.setSelection((current) => ({ ...current, channel }))}
      />
      <p>
        Check game files for this setup option, platform and channel. Changing filters alone does
        not scan files or install anything.
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
