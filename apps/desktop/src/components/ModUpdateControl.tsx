import { useId, useState } from "react";
import { desktopApi } from "../api";
import { requestStandingSetup } from "../features/game-file-discovery/use-standing-setup";
import { useAppTranslation } from "../localization";
import type { ModAutoUpdateCheck, ModUpdatePolicy, ProviderUpdateObservation } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";

export type ModUpdateControlProps = {
  portId: string;
  profileId: string;
  generation: number;
  policy: ModUpdatePolicy;
  automaticChecks: ModAutoUpdateCheck[];
  disabled: boolean;
  setPolicy: (policy: ModUpdatePolicy) => void;
  providerForPackage: (nativeId: string) => string | undefined;
  showProject: (projectId: string, provider: string, files: string[]) => void;
};

const policies = ["keep_current", "review_updates", "automatic_eligible"] as const;

export function ModUpdateControl({
  portId,
  profileId,
  generation,
  policy,
  automaticChecks,
  disabled,
  setPolicy,
  providerForPackage,
  showProject,
}: ModUpdateControlProps) {
  const { t, i18n } = useAppTranslation("gameSettings");
  const labels = {
    policy: {
      keep_current: t("mods.updates.policy.keep_current"),
      review_updates: t("mods.updates.policy.review_updates"),
      automatic_eligible: t("mods.updates.policy.automatic_eligible"),
    },
    detail: {
      keep_current: t("mods.updates.detail.keep_current"),
      review_updates: t("mods.updates.detail.review_updates"),
      automatic_eligible: t("mods.updates.detail.automatic_eligible"),
    },
    automatic: {
      applied: t("mods.updates.automatic.applied"),
      current: t("mods.updates.automatic.current"),
      deferred: t("mods.updates.automatic.deferred"),
      held: t("mods.updates.automatic.held"),
      unavailable: t("mods.updates.automatic.unavailable"),
    },
    manual: {
      current: t("mods.updates.manual.current"),
      installed_file_removed: t("mods.updates.manual.installed_file_removed"),
      newer_files: t("mods.updates.manual.newer_files"),
      unavailable: t("mods.updates.manual.unavailable"),
    },
  };
  const policyId = useId();
  const helpId = useId();
  const [checked, setChecked] = useState<ProviderUpdateObservation[]>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function check() {
    setBusy(true);
    setFailure(undefined);
    setChecked(undefined);
    try {
      const observations = await desktopApi.checkProviderModUpdates(portId, profileId, generation);
      setChecked(observations);
      if (
        policy === "automatic_eligible" &&
        observations.some(({ state }) => state !== "unavailable")
      )
        requestStandingSetup();
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="grid min-w-0 gap-2 [overflow-wrap:anywhere]"
      aria-label={t("mods.updates.heading")}
    >
      <label htmlFor={policyId} className="text-sm font-semibold">
        {t("mods.updates.heading")}
      </label>
      <select
        id={policyId}
        className="min-w-0 rounded-pc-sm border border-pc-border bg-pc-background p-2 text-sm"
        value={policy}
        disabled={disabled || busy}
        aria-describedby={helpId}
        onChange={({ currentTarget }) => {
          const next = policies.find((choice) => choice === currentTarget.value);
          if (next) setPolicy(next);
        }}
      >
        {policies.map((choice) => (
          <option key={choice} value={choice}>
            {labels.policy[choice]}
          </option>
        ))}
      </select>
      <p id={helpId} className="text-sm text-pc-muted-foreground">
        {labels.detail[policy]}
      </p>
      {policy === "automatic_eligible" &&
        (automaticChecks.length > 0 ? (
          <ul
            className="grid min-w-0 list-none divide-y divide-pc-border p-0 text-sm"
            aria-label={t("mods.updates.lastAutomatic")}
          >
            {automaticChecks.map(
              ({ checked_at, profile_id, native_ids, project_id, candidate_file_id, result }) => {
                const providers = [...new Set(native_ids.map(providerForPackage))];
                const provider = providers.length === 1 ? providers[0] : undefined;
                return (
                  <li
                    className="grid min-w-0 gap-1 py-2"
                    key={JSON.stringify([profile_id, native_ids])}
                  >
                    <p>
                      <bdi className="font-medium">
                        {native_ids.join(t("mods.separator")) || t("mods.updates.setup")}
                      </bdi>{" "}
                      {labels.automatic[result?.outcome ?? "current"]}
                    </p>
                    <time
                      className="text-xs text-pc-muted-foreground"
                      dateTime={new Date(checked_at * 1000).toISOString()}
                    >
                      {new Date(checked_at * 1000).toLocaleString(i18n.resolvedLanguage)}
                    </time>
                    {result && result.outcome !== "applied" && (
                      <p>
                        <bdi>{result.reason}</bdi>
                      </p>
                    )}
                    {result?.outcome === "held" && project_id && candidate_file_id && provider && (
                      <Button
                        className="justify-self-start"
                        variant="outline"
                        disabled={disabled || busy}
                        onClick={() => showProject(project_id, provider, [candidate_file_id])}
                      >
                        {t("mods.updates.reviewFiles")}
                      </Button>
                    )}
                  </li>
                );
              },
            )}
          </ul>
        ) : (
          <p className="text-sm">{t("mods.updates.noAutomaticCheck")}</p>
        ))}
      <Button
        className="justify-self-start"
        variant="outline"
        disabled={disabled}
        aria-busy={busy}
        focusableWhenDisabled={busy}
        onClick={() => void check()}
      >
        {busy ? t("mods.updates.checking") : t("mods.updates.check")}
      </Button>
      <p role="status" className="sr-only">
        {busy
          ? t("mods.updates.checking")
          : checked
            ? t(checked.length ? "mods.updates.manualResults" : "mods.updates.noProviderMods")
            : ""}
      </p>
      {failure && (
        <p role="alert">
          <bdi>{failure}</bdi>
        </p>
      )}
      {checked &&
        (checked.length === 0 ? (
          <p className="text-sm">{t("mods.updates.noProviderMods")}</p>
        ) : (
          <ul
            className="grid min-w-0 list-none divide-y divide-pc-border p-0 text-sm"
            aria-label={t("mods.updates.manualResults")}
          >
            {checked.map((observation) => (
              <li className="grid min-w-0 gap-1 py-2" key={observation.native_id}>
                <p>
                  <bdi className="font-medium">{observation.native_id}</bdi>{" "}
                  {labels.manual[observation.state]}
                </p>
                {observation.reason && (
                  <p>
                    <bdi>{observation.reason}</bdi>
                  </p>
                )}
                {observation.state === "newer_files" && (
                  <Button
                    className="justify-self-start"
                    variant="outline"
                    disabled={disabled || busy}
                    onClick={() =>
                      showProject(
                        observation.provider.project,
                        observation.provider.provider,
                        observation.newer_files.map((file) => file.file_id),
                      )
                    }
                  >
                    {t("mods.updates.reviewFiles")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
