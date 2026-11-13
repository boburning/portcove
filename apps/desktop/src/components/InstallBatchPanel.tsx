import type { TFunction } from "i18next";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import { errorText, formatBytes } from "../view-model";
import type { InstallBatchRecord, InstallBatchReview, PortDefinition } from "../types";
import { Button } from "./ui/button";

type Phase =
  | { kind: "idle" }
  | { kind: "reviewing" }
  | { kind: "review"; review: InstallBatchReview }
  | { kind: "running"; batchId: string; total: number }
  | { kind: "finished"; record: InstallBatchRecord };

const stillRunning = (record: InstallBatchRecord) =>
  record.items.some((item) => item.state === "running" || item.state === "queued");

function stateLabel(
  t: TFunction<"installation">,
  state: InstallBatchRecord["items"][number]["state"],
): string {
  switch (state) {
    case "queued":
      return t("batch.state.queued");
    case "running":
      return t("batch.state.running");
    case "ready":
      return t("batch.state.ready");
    case "held":
      return t("batch.state.held");
    case "failed":
      return t("batch.state.failed");
    case "cancelled":
      return t("batch.state.cancelled");
    case "interrupted":
      return t("batch.state.interrupted");
  }
}

/** Game names stay exact; only the conjunction between the last two is copy. */
function gameList(t: TFunction<"installation">, names: string[]): ReactNode {
  if (names.length <= 1) return <bdi>{names[0]}</bdi>;
  return (
    <Trans
      t={t}
      i18nKey="batch.list"
      components={{
        rest: <bdi>{names.slice(0, -1).join(t("batch.separator"))}</bdi>,
        last: <bdi>{names.at(-1)}</bdi>,
      }}
    />
  );
}

/**
 * One review and one confirmation for first installs of several games. Core
 * re-plans and freshly authorizes each game before it changes anything, so a
 * game whose plan changed waits for review while the others continue. Nothing
 * is launched.
 */
export function InstallBatchPanel({
  generation,
  ports,
  portIds,
  onDone,
}: {
  generation: number;
  ports: PortDefinition[];
  /** Games to review now, or undefined to only offer continuing an unfinished batch. */
  portIds: string[] | undefined;
  onDone: () => void;
}) {
  // The parent remounts this panel for each new selection, so a selection
  // starts in review without resetting state from an effect.
  const [phase, setPhase] = useState<Phase>(
    portIds?.length ? { kind: "reviewing" } : { kind: "idle" },
  );
  const { t } = useAppTranslation("installation");
  const [unfinished, setUnfinished] = useState<InstallBatchRecord>();
  const [error, setError] = useState<string>();
  const owner = useRef(generation);
  useEffect(() => {
    owner.current = generation;
  }, [generation]);
  const accepts = (expected: number) => owner.current === expected;
  const name = (id: string) => ports.find((port) => port.id === id)?.name ?? id;

  useEffect(() => {
    const expected = generation;
    desktopApi
      .unfinishedInstallBatches(expected)
      .then((batches) => {
        if (accepts(expected)) setUnfinished(batches[0]);
      })
      .catch(() => undefined);
  }, [generation]);

  useEffect(() => {
    if (!portIds?.length) return;
    const expected = generation;
    desktopApi
      .planInstallBatch(portIds, expected)
      .then((review) => {
        if (accepts(expected)) setPhase({ kind: "review", review });
      })
      .catch((value: unknown) => {
        if (!accepts(expected)) return;
        setError(errorText(value));
        setPhase({ kind: "idle" });
      });
  }, [portIds, generation]);

  const run = async (batchId: string, total: number) => {
    const expected = generation;
    setError(undefined);
    setPhase({ kind: "running", batchId, total });
    try {
      const record = await desktopApi.runInstallBatch(batchId, expected, () => undefined);
      if (!accepts(expected)) return;
      // Games another Portcove window is still installing keep the batch unfinished.
      setUnfinished(stillRunning(record) ? record : undefined);
      setPhase({ kind: "finished", record });
    } catch (value) {
      if (!accepts(expected)) return;
      setError(errorText(value));
      const record = await desktopApi.installBatch(batchId, expected).catch(() => null);
      if (accepts(expected)) setPhase(record ? { kind: "finished", record } : { kind: "idle" });
    }
  };

  const confirm = async (review: InstallBatchReview) => {
    const expected = generation;
    const ready = review.items.filter((item) => item.plan && !item.hold);
    const waiting = review.items.filter((item) => !ready.includes(item));
    setError(undefined);
    try {
      // Waiting games keep their place in the Library without being installed.
      if (waiting.length)
        await desktopApi.addGamesToLibrary(
          waiting.map((item) => ({ port_id: item.port_id, origin: "game_file_discovery" })),
          expected,
        );
      if (!ready.length) {
        if (accepts(expected)) onDone();
        return;
      }
      const batch = await desktopApi.startInstallBatch(
        ready.map((item) => ({
          port_id: item.port_id,
          expected_plan_sha256: item.plan!.plan_sha256,
        })),
        expected,
      );
      if (accepts(expected)) await run(batch.id, batch.items.length);
    } catch (value) {
      if (accepts(expected)) setError(errorText(value));
    }
  };

  const cancel = async (batchId: string) => {
    try {
      await desktopApi.cancelInstallBatch(batchId, generation);
      setError(undefined);
    } catch (value) {
      setError(errorText(value));
    }
  };

  return (
    <section aria-label={t("batch.label")} className="col-span-full">
      {error && <p role="alert">{error}</p>}
      {phase.kind === "idle" && unfinished && (
        <div>
          <p>{t("batch.unfinished", { count: unfinished.items.length })}</p>
          <Button data-focusable onClick={() => void run(unfinished.id, unfinished.items.length)}>
            {t("batch.continue")}
          </Button>
        </div>
      )}
      {phase.kind === "reviewing" && <p role="status">{t("batch.reviewing")}</p>}
      {phase.kind === "review" && (
        <ReviewList
          review={phase.review}
          name={name}
          onConfirm={(review) => void confirm(review)}
          onCancel={onDone}
        />
      )}
      {phase.kind === "running" && (
        <div>
          <p role="status">{t("batch.running", { count: phase.total })}</p>
          <Button data-focusable variant="outline" onClick={() => void cancel(phase.batchId)}>
            {t("batch.stop")}
          </Button>
        </div>
      )}
      {phase.kind === "finished" && (
        <div>
          <h3>{stillRunning(phase.record) ? t("batch.inProgress") : t("batch.results")}</h3>
          {stillRunning(phase.record) && <p role="status">{t("batch.stillRunning")}</p>}
          <ul>
            {phase.record.items.map((item) => (
              <li key={item.port_id}>
                <Trans
                  t={t}
                  i18nKey={item.detail ? "batch.resultDetail" : "batch.result"}
                  values={{ state: stateLabel(t, item.state) }}
                  components={{
                    name: <strong>{name(item.port_id)}</strong>,
                    detail: <>{item.detail}</>,
                  }}
                />
              </li>
            ))}
          </ul>
          <Button data-focusable onClick={onDone}>
            {t("batch.done")}
          </Button>
        </div>
      )}
    </section>
  );
}

function ReviewList({
  review,
  name,
  onConfirm,
  onCancel,
}: {
  review: InstallBatchReview;
  name: (id: string) => string;
  onConfirm: (review: InstallBatchReview) => void;
  onCancel: () => void;
}) {
  const { t } = useAppTranslation("installation");
  const ready = review.items.filter((item) => item.plan && !item.hold);
  const waiting = review.items.length - ready.length;
  return (
    <div>
      <h3>{t("batch.reviewHeading")}</h3>
      <p>{t("batch.reviewSummary", { ready: ready.length, waiting })}</p>
      <BatchCapacity capacity={review.capacity} name={name} />
      <ul>
        {review.items.map((item) => (
          <li key={item.port_id}>
            {item.plan && !item.hold ? (
              <Trans
                t={t}
                i18nKey="batch.itemInstall"
                components={{
                  name: <strong>{name(item.port_id)}</strong>,
                  version: <bdi>{item.plan.plan.release.version}</bdi>,
                }}
              />
            ) : item.hold ? (
              <Trans
                t={t}
                i18nKey="batch.itemHeld"
                components={{ name: <strong>{name(item.port_id)}</strong>, hold: <>{item.hold}</> }}
              />
            ) : (
              <Trans
                t={t}
                i18nKey="batch.itemWaiting"
                components={{ name: <strong>{name(item.port_id)}</strong> }}
              />
            )}
          </li>
        ))}
      </ul>
      <Button data-focusable onClick={() => onConfirm(review)}>
        {ready.length
          ? t("batch.confirmInstall", { total: review.items.length, ready: ready.length })
          : t("batch.confirmAdd", { total: review.items.length })}
      </Button>
      <Button data-focusable variant="outline" onClick={onCancel}>
        {t("batch.cancel")}
      </Button>
    </div>
  );
}

/** What the ready games need together, so shared volume pressure is visible before confirming. */
function BatchCapacity({
  capacity,
  name,
}: {
  capacity: InstallBatchReview["capacity"] | undefined;
  name: (id: string) => string;
}) {
  const { t } = useAppTranslation("installation");
  if (!capacity) return null;
  return (
    <div>
      {capacity.download_bytes > 0 && (
        <p>{t("batch.downloads", { size: formatBytes(capacity.download_bytes) })}</p>
      )}
      {capacity.volumes.map((volume) => {
        const games = volume.port_ids.map(name);
        const unknown = volume.available_bytes === undefined || volume.available_bytes === null;
        const available = unknown ? "" : formatBytes(volume.available_bytes!);
        return (
          <p key={volume.volume_identity ?? volume.path}>
            <Trans
              t={t}
              i18nKey={
                unknown
                  ? "batch.volumeUnknown"
                  : volume.sufficient === false
                    ? "batch.volumeShort"
                    : "batch.volumeEnough"
              }
              count={games.length}
              values={{ required: formatBytes(volume.required_bytes), available }}
              components={{ games: <>{gameList(t, games)}</> }}
            />
          </p>
        );
      })}
      {capacity.unknown_space && capacity.unknown_space.length > 0 && (
        <p>
          <Trans
            t={t}
            i18nKey="batch.unknownSpace"
            components={{
              games: <bdi>{capacity.unknown_space.map(name).join(t("batch.separator"))}</bdi>,
            }}
          />
        </p>
      )}
    </div>
  );
}
