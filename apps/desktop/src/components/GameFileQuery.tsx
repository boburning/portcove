import { useObservationExpired } from "../features/browsing/use-observation-expiry";
import { useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { GameFileQuerySnapshot, PortDefinition, ReleaseChannel } from "../types";
import { errorText, platformLabel, releaseChannelPresentation } from "../view-model";
import { Button } from "./ui/button";
import { ChoiceSelect } from "./ChoiceSelect";
import { OperationCancellation } from "./OperationCancellation";

import {
  acceptedGameFileQuery,
  routes,
  states,
  reasons,
  type Route,
} from "../features/browsing/game-file-query-context";
export { acceptedGameFileQuery } from "../features/browsing/game-file-query-context";

export function GameFileQueryControl({
  port,
  channel,
  generation,
  context,
  busy,
}: {
  port: PortDefinition;
  channel: ReleaseChannel;
  generation: number;
  /** Accepted catalog, registration and installation observations; change invalidates the result. */
  context: string;
  busy?: boolean;
}) {
  const [route, setRoute] = useState<Route["route"]>("managed_install");
  const [platform, setPlatform] = useState<Route["platform"]>(port.platforms[0]);
  const [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<{ epoch: number; id: string }>();
  type Observation = { epoch: number; snapshot: GameFileQuerySnapshot; deadline: number };
  const [result, setResult] = useState<Observation>();
  const [error, setError] = useState<{ epoch: number; message: string }>();
  const key = JSON.stringify([port.id, channel, generation, context, route, platform]);
  const [identity, setIdentity] = useState({ key, epoch: 0 });
  const currentIdentity = identity.key === key ? identity : { key, epoch: identity.epoch + 1 };
  if (identity.key !== key) setIdentity(currentIdentity);
  const epoch = currentIdentity.epoch;
  const owner = useRef({ epoch: 0, closed: false });
  const processing = useRef(false);
  useLayoutEffect(() => {
    const lifecycle = owner.current;
    lifecycle.epoch = epoch;
    lifecycle.closed = false;
    return () => {
      lifecycle.closed = true;
    };
  }, [epoch]);
  const window = result
    ? {
        observedAt: result.snapshot.observed_at,
        expiresAt: result.snapshot.expires_at,
        deadline: result.deadline,
      }
    : undefined;
  const windowExpired = useObservationExpired(result, window);
  const expired = Boolean(result?.epoch === epoch && windowExpired);
  const current = result?.epoch === epoch && !expired ? result.snapshot : undefined;
  const check = async () => {
    if (processing.current || busy || !platform || !port.platforms.includes(platform)) return;
    processing.current = true;
    const selected: Route = { port_id: port.id, platform, channel, route };
    const requestEpoch = epoch;
    const active = () => !owner.current.closed && owner.current.epoch === requestEpoch;
    setPending(true);
    setOperation(undefined);
    setResult(undefined);
    setError(undefined);
    try {
      const library = await desktopApi.libraryIdentity(generation);
      if (!active()) return;
      const snapshot = await desktopApi.refreshGameFileQuery(
        {
          routes: [selected],
          maximum_age_seconds: 300,
          limits: {
            max_file_bytes: 2 * 1024 ** 3,
            max_hash_bytes: 32 * 1024 ** 3,
            max_elapsed_ms: 30_000,
          },
        },
        generation,
        (event) => {
          if (
            active() &&
            (event.schema_version === 2 || event.schema_version === 3) &&
            event.type === "started" &&
            event.operation === "verify_source"
          )
            setOperation({ epoch: requestEpoch, id: event.operation_id });
        },
      );
      if (!active()) return;
      if (!acceptedGameFileQuery(snapshot, selected, library, Math.floor(Date.now() / 1000)))
        throw new Error("The game-file observation no longer matches this selection. Check again.");
      setResult({
        epoch: requestEpoch,
        snapshot,
        deadline:
          performance.now() +
          Math.max(0, Math.min(300_000, snapshot.expires_at * 1000 - Date.now())),
      });
    } catch (value) {
      if (active()) setError({ epoch: requestEpoch, message: errorText(value) });
    } finally {
      processing.current = false;
      if (!owner.current.closed) {
        setPending(false);
        setOperation(undefined);
      }
    }
  };
  const projection = current?.routes[0];
  return (
    <section className="my-4 grid gap-3" aria-label="Selected route game files">
      <h2>Game files for this route</h2>
      <ChoiceSelect
        label="Route"
        value={route}
        options={routes}
        disabled={pending || busy}
        onChange={setRoute}
      />
      <ChoiceSelect
        label="Target platform"
        value={platform}
        options={port.platforms.map((value) => ({ value, label: platformLabel(value) }))}
        disabled={pending || busy}
        onChange={setPlatform}
      />
      <p>
        Channel: {releaseChannelPresentation(channel).label}. This check observes connected files;
        setup and launch still require their own reviews and prerequisites.
      </p>
      <Button
        data-focusable
        variant="outline"
        disabled={pending || busy || !port.platforms.includes(platform)}
        onClick={() => {
          void check();
        }}
      >
        {pending ? "Checking game files…" : "Check selected route game files"}
      </Button>
      {pending && operation?.epoch === epoch && (
        <OperationCancellation
          key={operation.id}
          operationId={operation.id}
          label="Cancel game-file check"
        />
      )}
      <p role="status">
        {projection
          ? states[projection.state]
          : pending
            ? "Checking selected route…"
            : expired && result?.epoch === epoch
              ? "Observation expired. Check again."
              : "No current observation for this selection."}
      </p>
      {projection && <p>{reasons[projection.reason]}</p>}
      {error?.epoch === epoch && <p role="alert">{error.message}</p>}
    </section>
  );
}
