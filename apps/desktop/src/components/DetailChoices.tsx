import { useId } from "react";
import type { useOrganization } from "../features/organization/use-organization";
import { setupConfirmed } from "../features/organization/organization";
import type { PortStatus } from "../types";
import { currentUpdateSnapshot } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

export type DetailOrganization = ReturnType<typeof useOrganization>;

export function ChoiceFailure({ organization }: { organization: DetailOrganization }) {
  return organization.failure ? (
    <p role="alert" className="mt-3 text-sm">
      {organization.failure === "read"
        ? "Saved choices could not be read."
        : "This choice was not saved."}{" "}
      <Button
        variant="link"
        disabled={organization.busy}
        onClick={() => void organization.refresh()}
      >
        Refresh choices
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
  const confirmationId = useId();
  const context = status?.external_runtime
    ? { kind: "external" as const, installation_id: status.external_runtime.id }
    : status?.active
      ? { kind: "managed" as const, installation_id: status.active.id }
      : undefined;
  if (!organization || !context || status?.port_id !== portId) return null;
  const confirmed = setupConfirmed(organization.snapshot, portId, context);
  return (
    <section aria-label="Your setup reminder" className="mt-6 grid gap-3 text-sm">
      <h3 className="text-base">Your setup reminder</h3>
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
        <span>I’ve finished this game’s first-time setup.</span>
      </label>
      <p className="max-w-prose text-pc-muted-foreground">
        This optional reminder doesn’t check your files, test the game, or change whether Play is
        available. A replacement installation needs its own reminder.
      </p>
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
    <section aria-label="Library update notice choices" className="mt-7 grid gap-3 text-sm">
      <h3 className="text-base">Library update notices</h3>
      <p className="max-w-prose text-pc-muted-foreground">
        {choice.paused ? "Notices are paused for this port." : "Show notices for new releases."}{" "}
        These choices only affect notices for this port in this library. They do not change your
        update policy, pause downloads, or hide a downloaded update. You can still review and apply
        available updates here.
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
          {choice.paused ? "Resume update notices" : "Pause update notices"}
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
            aria-label={`Hide the update notice for this version: ${exactRelease.version}`}
          >
            Hide the update notice for this version
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
            Show this update notice again
          </Button>
        )}
      </div>
      {choice.skipped_release && (
        <p className="text-pc-muted-foreground">
          Notice hidden for {choice.skipped_release.version} and this download. We’ll show the
          notice again if the publisher replaces the download.
        </p>
      )}
      <ChoiceFailure organization={organization} />
    </section>
  );
}
