import { ActionReviewFailure } from "./ActionReviewFailure";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { PortDefinition, SourceRecord, SourceRemovalPreview } from "../types";
import { useActionReview } from "../use-action-review";
import { gameIdentityLabel } from "../port-identity";
import { Button } from "./ui/button";
import { useAppTranslation } from "../localization";

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
  const { t } = useAppTranslation("removal");
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
        {t("source.review")}
      </Button>
      {refreshFailure === identity && (
        <div className="basis-full">
          <p role="status">{t("source.removedRefresh")}</p>
          <Button data-focusable variant="outline" size="sm" onClick={() => void completed()}>
            {t("source.refreshList")}
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
  const { t } = useAppTranslation("removal");
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
    failureMessage: t("source.failure"),
  });
  return (
    <section
      id={id}
      className="source-removal-review mt-3 min-w-0 basis-full border-t border-pc-border pt-3 text-sm wrap-anywhere"
      aria-label={t("source.sectionLabel")}
      aria-busy={Boolean(pending)}
    >
      <h3 className="text-base">{t("source.title")}</h3>
      <p>{t("source.description")}</p>
      {pending === "review" && <p role="status">{t("source.checking")}</p>}
      {preview && <SourceRemovalDetails preview={preview} ports={ports} />}
      <ActionReviewFailure error={error} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button data-focusable variant="outline" disabled={pending === "apply"} onClick={dismiss}>
          {t("source.keep")}
        </Button>
        {!preview && (
          <Button data-focusable disabled={Boolean(pending)} onClick={() => void review()}>
            {t("source.checkAgain")}
          </Button>
        )}
        {preview && (
          <Button
            data-focusable
            variant="destructive"
            disabled={Boolean(pending)}
            onClick={() => void execute()}
          >
            {pending === "apply" ? t("source.confirmInDialog") : t("source.remove")}
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
  const { t } = useAppTranslation("removal");
  const name = (id: string) => {
    const port = ports.find((port) => port.id === id);
    return port ? gameIdentityLabel(port) : t("source.unavailablePort", { id });
  };
  return (
    <div className="source-removal-details" aria-label={t("source.detailsLabel")}>
      <p>
        <strong>{t("source.exactLocation")}</strong>
      </p>
      <code dir="ltr" className="block break-all whitespace-normal [unicode-bidi:isolate]">
        {preview.source.path}
      </code>
      <p>{t("source.notDeleted")}</p>
      <p role="status">
        {t("source.installedAffected", { count: preview.installed_dependent_port_ids.length })}
      </p>
      <h4>{t("source.installedHeading")}</h4>
      {preview.installed_dependent_port_ids.length ? (
        <ul>
          {preview.installed_dependent_port_ids.map((id) => (
            <li key={id}>{name(id)}</li>
          ))}
        </ul>
      ) : (
        <p>{t("source.noInstalled")}</p>
      )}
      <details>
        <summary data-focusable className="cursor-pointer py-2">
          {t("source.allEntries", { total: preview.dependent_port_ids.length })}
        </summary>
        <ul>
          {preview.dependent_port_ids.map((id) => (
            <li key={id}>{name(id)}</li>
          ))}
        </ul>
      </details>
      <p>{t("source.interrupted")}</p>
    </div>
  );
}
