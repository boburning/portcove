import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickSourcePath } from "../file-picker";
import { errorText } from "../view-model";
import type { PortStatus, SourceProfile, SourceRecord, SourceReuseReview } from "../types";
import { useSetupReviewSelection } from "../features/game-file-discovery/setup-review-selection";
import type { Perform } from "../features/operations/use-operation-state";
import { targetInvocationContext } from "../features/operations/invocation-state";
import { Button } from "./ui/button";

// Ephemeral readback only. Core owns identity, compatibility, baseline and repair.
export function RegisteredSourceSetup({
  sources,
  profiles,
  statuses,
  generation,
  current,
  perform,
  onChanged,
  onOpenPort,
}: {
  sources: SourceRecord[];
  profiles: SourceProfile[];
  statuses: ReadonlyMap<string, PortStatus>;
  generation: number;
  current: boolean;
  perform: Perform;
  onChanged: () => Promise<unknown>;
  onOpenPort: (id: string, origin: string) => void;
}) {
  const [selected, setSelected] = useState("");
  const [read, setRead] = useState<{ baseline: string; review: SourceReuseReview }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const { requestReview } = useSetupReviewSelection();
  const source = sources.find((item) => item.profile_id === selected);
  const baseline = JSON.stringify([generation, source, current]);
  const owner = useRef<string | undefined>(undefined);
  const flight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    owner.current = baseline;
    return () => {
      owner.current = undefined;
    };
  }, [baseline]);
  const review = read?.baseline === baseline ? read.review : undefined;
  const run = async (operation: (accepts: () => boolean) => Promise<void>) => {
    if (!source || !current || flight.current) return;
    const accepts = () => owner.current === baseline;
    flight.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation(accepts);
    } catch (value) {
      if (accepts()) setError(errorText(value));
    } finally {
      flight.current = false;
      if (owner.current !== undefined) setBusy(false);
    }
  };
  const check = () =>
    run(async (accepts) => {
      const result = await desktopApi.reviewSourceReuse(selected, generation);
      if (!accepts()) return;
      if (JSON.stringify(result.registration) !== JSON.stringify(source))
        throw new Error(
          "The saved game-file location changed. Refresh the library and check it again.",
        );
      setRead({ baseline, review: result });
      window.requestAnimationFrame(() => {
        if (accepts()) heading.current?.focus();
      });
    });
  const repair = () =>
    run(async (accepts) => {
      const profile = profiles.find((item) => item.id === selected);
      if (!profile || !source)
        throw new Error("Refresh the library to review this file's requirements.");
      const path = await pickSourcePath(profile, source.path, "game");
      if (!path || !accepts()) return;
      const repaired = await perform(
        "repair game-file location",
        async () => {
          const plan = await desktopApi.planSourceRelink(selected, path, generation);
          if (JSON.stringify(plan.original) !== JSON.stringify(source))
            throw new Error(
              "The saved registration changed. Refresh before repairing its location.",
            );
          return desktopApi.relinkSource(selected, path, plan.preview_sha256, generation);
        },
        {
          context: targetInvocationContext(
            "Repair game-file location",
            { kind: "source", id: source.profile_id, label: profile.label },
            generation,
            "library",
          ),
          refresh: "none",
          propagateFailure: true,
        },
      );
      if (!repaired) return;
      if (accepts()) {
        setRead(undefined);
        setNotice(
          `Location repaired. The saved original-file identity is unchanged: ${repaired.path}`,
        );
      }
      await onChanged();
    });
  if (!sources.length) return null;
  return (
    <section aria-label="Reuse saved game files" className="my-4 grid gap-3">
      <h3>Use saved original files</h3>
      <p>
        Check an existing registration for each game's own requirements. Your originals stay where
        they are.
      </p>
      <label>
        Saved game files
        <select
          data-focusable
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setError(undefined);
            setNotice(undefined);
            setRead(undefined);
          }}
        >
          <option value="">Choose saved files</option>
          {sources.map((item) => (
            <option key={item.profile_id} value={item.profile_id}>
              {profiles.find((profile) => profile.id === item.profile_id)?.label ?? item.profile_id}{" "}
              — {item.path}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          data-focusable
          disabled={!source || !current || busy}
          aria-busy={busy}
          focusableWhenDisabled={Boolean(source) && current && busy}
          onClick={() => void check()}
        >
          Check saved game files
        </Button>
        <Button
          data-focusable
          variant="outline"
          disabled={!source || !current || busy}
          onClick={() => void repair()}
          focusableWhenDisabled={Boolean(source) && current && busy}
        >
          Repair moved file location
        </Button>
      </div>
      {!current && <p role="status">Refresh the library before using these saved files.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {review && (
        <div aria-live="polite">
          <h4 ref={heading} tabIndex={-1}>
            Choose an implementation for these files
          </h4>
          <p>{review.inspection.summary}</p>
          <p>{review.inspection.next_action}</p>
          {!review.applications.length && (
            <p>
              No integration currently offers checked reuse of these files. Review the game's
              existing setup requirements; this does not prevent an otherwise valid existing launch
              or prepared-copy route.
            </p>
          )}
          {review.applications.map((application) => {
            const status = statuses.get(application.port_id);
            const available =
              application.can_review_setup &&
              !status?.active &&
              !status?.external_runtime &&
              status?.port_actions?.some(
                (action) => action.action === "install" && action.availability === "allowed",
              );
            return (
              <article
                key={`${application.port_id}:${application.role}`}
                className="my-3 grid gap-2"
              >
                <h4>{application.port_name}</h4>
                <p>{application.summary}</p>
                <ul>
                  {application.additional_checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
                {available && (
                  <Button
                    data-focusable
                    disabled={busy || !current}
                    onClick={() => {
                      requestReview(application.port_id, status!.channel, review.reference);
                      onOpenPort(application.port_id, "add-games:saved-source");
                    }}
                  >
                    Review {application.port_name} setup using these files
                  </Button>
                )}
                <Button
                  data-focusable
                  variant="outline"
                  disabled={busy || !current}
                  onClick={() => onOpenPort(application.port_id, "add-games:saved-source")}
                >
                  View {application.port_name} requirements
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
