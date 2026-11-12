import { useId } from "react";
import { Trans } from "react-i18next";
import type { useOrganization } from "../features/organization/use-organization";
import { setupConfirmed } from "../features/organization/organization";
import { useAppTranslation } from "../localization";
import type { PortStatus } from "../types";
import { currentUpdateSnapshot } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export type DetailOrganization = ReturnType<typeof useOrganization>;

export function ChoiceFailure({ organization }: { organization: DetailOrganization }) {
  const { t } = useAppTranslation("organization");
  return organization.failure ? (
    <p role="alert" className="mt-3 text-sm">
      {organization.failure === "read" ? t("choices.readFailed") : t("choices.writeFailed")}{" "}
      <Button
        variant="link"
        disabled={organization.busy}
        onClick={() => void organization.refresh()}
      >
        {t("choices.refresh")}
      </Button>
    </p>
  ) : null;
}

/** A user's statement about one installation, never a Core launch assessment. */
export function SetupStatement({
  portId,
  status,
  organization,
}: {
  portId: string;
  status?: PortStatus | undefined;
  organization?: DetailOrganization | undefined;
}) {
  const { t } = useAppTranslation("organization");
  const confirmationId = useId();
  const context = status?.external_runtime
    ? { kind: "external" as const, installation_id: status.external_runtime.id }
    : status?.active
      ? { kind: "managed" as const, installation_id: status.active.id }
      : undefined;
  if (!organization || !context || status?.port_id !== portId) return null;
  const confirmed = setupConfirmed(organization.snapshot, portId, context);
  return (
    <section aria-label={t("choices.setup.label")} className="mt-6 grid gap-3 text-sm">
      <h3 className="text-base">{t("choices.setup.label")}</h3>
      <label htmlFor={confirmationId} className="flex cursor-pointer items-start gap-3">
        <Checkbox
          id={confirmationId}
          checked={confirmed}
          disabled={!organization.snapshot || organization.busy}
          onCheckedChange={(checked) =>
            void organization.commit({
              kind: "set_setup_confirmation",
              confirmation: { port_id: portId, context },
              confirmed: checked,
            })
          }
        />
        <span>{t("choices.setup.confirm")}</span>
      </label>
      <p className="max-w-prose text-pc-muted-foreground">{t("choices.setup.explanation")}</p>
      <ChoiceFailure organization={organization} />
    </section>
  );
}

export function UpdateNoticePreferences({
  portId,
  status,
  organization,
}: {
  portId: string;
  status?: PortStatus | undefined;
  organization?: DetailOrganization | undefined;
}) {
  const { t } = useAppTranslation("organization");
  if (!organization) return null;
  const choice = organization.snapshot?.update_notices[portId] ?? {
    paused: false,
    skipped_release: null,
  };
  const check = currentUpdateSnapshot(status)?.check;
  const release = check?.port_id === portId && check.update_available ? check.release : undefined;
  const exactRelease =
    release && /^[a-f0-9]{64}$/i.test(release.asset.sha256 ?? "")
      ? { version: release.version, artifact_sha256: release.asset.sha256 }
      : undefined;
  const disabled = !organization.snapshot || organization.busy;
  return (
    <section aria-label={t("choices.notices.label")} className="mt-7 grid gap-3 text-sm">
      <h3 className="text-base">{t("choices.notices.heading")}</h3>
      <p className="max-w-prose text-pc-muted-foreground">
        {choice.paused ? t("choices.notices.introPaused") : t("choices.notices.introActive")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            void organization.commit({
              kind: "set_update_notice",
              port_id: portId,
              choice: { ...choice, paused: !choice.paused },
            })
          }
        >
          {choice.paused ? t("choices.notices.resume") : t("choices.notices.pause")}
        </Button>
        {exactRelease && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void organization.commit({
                kind: "set_update_notice",
                port_id: portId,
                choice: { ...choice, skipped_release: exactRelease },
              })
            }
            aria-label={t("choices.notices.skipLabel", { version: exactRelease.version })}
          >
            {t("choices.notices.skip")}
          </Button>
        )}
        {choice.skipped_release && (
          <Button
            variant="link"
            size="sm"
            disabled={disabled}
            onClick={() =>
              void organization.commit({
                kind: "set_update_notice",
                port_id: portId,
                choice: { ...choice, skipped_release: null },
              })
            }
          >
            {t("choices.notices.unskip")}
          </Button>
        )}
      </div>
      {choice.skipped_release && (
        <p className="text-pc-muted-foreground">
          <Trans
            t={t}
            i18nKey="choices.notices.skipped"
            components={{ version: <bdi>{choice.skipped_release.version}</bdi> }}
          />
        </p>
      )}
      <ChoiceFailure organization={organization} />
    </section>
  );
}
