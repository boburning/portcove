import { ActionReviewFailure } from "./ActionReviewFailure";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { PortDefinition, SourceRecord, SourceRemovalPreview } from "../types";
import { useActionReview } from "../use-action-review";
import { gameIdentityLabel } from "../port-identity";
import { Button } from "./ui/button";

type SourceRemovalProps = {
  source: SourceRecord;
  generation: number;
  ports: PortDefinition[];
  disabled: boolean;
  onRemoved?: (() => Promise<unknown>) | undefined;
};

export function SourceRemovalControl(props: SourceRemovalProps) {
  const { source, generation } = props;
  return (
    <SourceRemovalForIdentity
      key={`${generation}:${source.profile_id}:${source.path}:${source.sha256}`}
      {...props}
    />
  );
}

function SourceRemovalForIdentity({
  source,
  generation,
  ports,
  disabled,
  onRemoved,
}: SourceRemovalProps) {
  const identity = `${generation}:${source.profile_id}:${source.path}:${source.sha256}`;
  const [intent, setIntent] = useState<string>();
  const [refreshFailure, setRefreshFailure] = useState<string>();
  const current = useRef<string | undefined>(identity);
  useLayoutEffect(() => {
    current.current = identity;
    return () => {
      current.current = undefined;
    };
  }, [identity]);
  const trigger = useRef<HTMLButtonElement>(null);
  const regionId = useId();
  const open = intent === identity;
  const completed = async () => {
    if (current.current !== identity) return;
    try {
      await onRemoved?.();
      if (current.current === identity) setRefreshFailure(undefined);
    } catch {
      if (current.current === identity) setRefreshFailure(identity);
    }
  };
  const close = () => {
    setIntent(undefined);
    trigger.current?.focus();
  };
  return (
    <>
      <Button
        ref={trigger}
        data-focusable
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-disabled={disabled || open}
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onClick={() => {
          if (!open) setIntent(identity);
        }}
      >
        Review saved location removal
      </Button>
      {refreshFailure === identity && (
        <div className="basis-full">
          <p role="status">
            The saved location was removed. Refresh the list to see the current files.
          </p>
          <Button data-focusable variant="outline" size="sm" onClick={() => void completed()}>
            Refresh saved-file list
          </Button>
        </div>
      )}
      {open && (
        <SourceRemovalReview
          key={identity}
          id={regionId}
          profileId={source.profile_id}
          generation={generation}
          ports={ports}
          close={close}
          onRemoved={completed}
        />
      )}
    </>
  );
}

/** Inline impact is information; the host dialog remains the sole final approval. */
export function SourceRemovalReview({
  id,
  profileId,
  generation,
  ports,
  close,
  onRemoved,
}: {
  id?: string;
  profileId: string;
  generation: number;
  ports: PortDefinition[];
  close: () => void;
  onRemoved: () => Promise<unknown>;
}) {
  const identity = `${profileId}:${generation}`;
  const active = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    active.current = identity;
    return () => {
      active.current = undefined;
    };
  }, [identity]);
  const { preview, pending, error, review, execute, dismiss } = useActionReview({
    identity,
    load: () => desktopApi.previewSourceRemoval(profileId, generation),
    apply: async (preview) => {
      const result = await desktopApi.removeSource(profileId, preview.preview_sha256, generation);
      if (result === null) return "cancelled";
      if (active.current === identity) await onRemoved();
      return true;
    },
    close,
    failureMessage:
      "The saved location was not removed. Check the current location and affected entries before trying again.",
  });
  return (
    <section
      id={id}
      className="source-removal-review mt-3 min-w-0 basis-full border-t border-pc-border pt-3 text-sm wrap-anywhere"
      aria-label="Saved-location removal impact"
      aria-busy={Boolean(pending)}
    >
      <h3 className="text-base">Saved-location removal</h3>
      <p>
        Review the location and affected entries below. Remove saved location… opens the native
        approval.
      </p>
      {pending === "review" && (
        <p role="status">Checking the saved location and affected entries…</p>
      )}
      {preview && <SourceRemovalDetails preview={preview} ports={ports} />}
      <ActionReviewFailure error={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button data-focusable variant="outline" disabled={pending === "apply"} onClick={dismiss}>
          Keep location
        </Button>
        {!preview && (
          <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
            Check saved location again
          </Button>
        )}
        {preview && (
          <Button
            data-focusable
            variant="destructive"
            disabled={Boolean(pending)}
            onClick={() => void execute()}
          >
            {pending === "apply" ? "Waiting for native approval…" : "Remove saved location…"}
          </Button>
        )}
      </div>
    </section>
  );
}

function SourceRemovalDetails({
  preview,
  ports,
}: {
  preview: SourceRemovalPreview;
  ports: PortDefinition[];
}) {
  const name = (id: string) => {
    const port = ports.find((port) => port.id === id);
    return port ? gameIdentityLabel(port) : `Unavailable port (${id})`;
  };
  return (
    <div className="source-removal-details" aria-label="Affected entries and preserved files">
      <p>
        <strong>Exact saved location:</strong>
      </p>
      <code dir="ltr" className="block break-all whitespace-normal [unicode-bidi:isolate]">
        {preview.source.path}
      </code>
      <p>
        Removing this location does not move or delete files at the path above, installed game
        versions, game saves, backups, or other saved locations. Only this library's location is
        removed.
      </p>
      <p role="status">
        {preview.installed_dependent_port_ids.length} installed{" "}
        {preview.installed_dependent_port_ids.length === 1 ? "entry may" : "entries may"} ask you to
        add these files again.
      </p>
      <h4>Installed entries affected</h4>
      {preview.installed_dependent_port_ids.length ? (
        <ul>
          {preview.installed_dependent_port_ids.map((id) => (
            <li key={id}>{name(id)}</li>
          ))}
        </ul>
      ) : (
        <p>No installed game currently depends on this location.</p>
      )}
      <details>
        <summary data-focusable className="cursor-pointer py-2">
          All catalog entries using these files ({preview.dependent_port_ids.length})
        </summary>
        <ul>
          {preview.dependent_port_ids.map((id) => (
            <li key={id}>{name(id)}</li>
          ))}
        </ul>
      </details>
      <p>
        If interrupted, reopen Settings and check whether the location remains before trying again.
      </p>
    </div>
  );
}
