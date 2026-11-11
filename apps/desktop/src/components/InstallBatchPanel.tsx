import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { errorText } from "../view-model";
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

const stateLabel: Record<InstallBatchRecord["items"][number]["state"], string> = {
  queued: "Not started",
  running: "Installing",
  ready: "Installed",
  held: "Waiting for review",
  failed: "Couldn't install",
  cancelled: "Cancelled",
  interrupted: "Interrupted. Review its installation again",
};

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
    <section aria-label="Install selected games" className="col-span-full">
      {error && <p role="alert">{error}</p>}
      {phase.kind === "idle" && unfinished && (
        <div>
          <p>
            A setup batch didn't finish. {unfinished.items.length}{" "}
            {unfinished.items.length === 1 ? "game was" : "games were"} included. Continuing checks
            each game again and doesn't repeat finished installs.
          </p>
          <Button data-focusable onClick={() => void run(unfinished.id, unfinished.items.length)}>
            Continue setup batch
          </Button>
        </div>
      )}
      {phase.kind === "reviewing" && <p role="status">Reviewing selected games…</p>}
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
          <p role="status">
            Installing {phase.total} {phase.total === 1 ? "game" : "games"}. Each game is checked
            again before anything changes. No game will be launched.
          </p>
          <Button data-focusable variant="outline" onClick={() => void cancel(phase.batchId)}>
            Stop games that haven't started
          </Button>
        </div>
      )}
      {phase.kind === "finished" && (
        <div>
          <h3>{stillRunning(phase.record) ? "Setup batch in progress" : "Setup batch results"}</h3>
          {stillRunning(phase.record) && (
            <p role="status">
              Another Portcove window is still installing part of this batch. Check again after it
              finishes.
            </p>
          )}
          <ul>
            {phase.record.items.map((item) => (
              <li key={item.port_id}>
                <strong>{name(item.port_id)}</strong>: {stateLabel[item.state]}
                {item.detail ? `. ${item.detail}` : ""}
              </li>
            ))}
          </ul>
          <Button data-focusable onClick={onDone}>
            Done
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
  const ready = review.items.filter((item) => item.plan && !item.hold);
  const waiting = review.items.length - ready.length;
  return (
    <div>
      <h3>Review installing selected games</h3>
      <p>
        {ready.length} ready to install, {waiting} waiting. Every selected game is saved to your
        Library. Waiting games aren't installed.
      </p>
      <ul>
        {review.items.map((item) => (
          <li key={item.port_id}>
            <strong>{name(item.port_id)}</strong>:{" "}
            {item.plan && !item.hold
              ? `Install ${item.plan.plan.release.version}`
              : `Waiting. ${item.hold ?? "Review this game's setup."}`}
          </li>
        ))}
      </ul>
      <Button data-focusable onClick={() => onConfirm(review)}>
        {ready.length
          ? `Add ${review.items.length} to Library and install ${ready.length}`
          : `Add ${review.items.length} to Library`}
      </Button>
      <Button data-focusable variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
