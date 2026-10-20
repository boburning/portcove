import { useState } from "react";
import type { PortDefinition, PortStatus, SourceProfile, SourceRecord } from "../types";
import { gameIdentityLabel } from "../port-identity";
import { useSetupReviewSelection } from "../features/game-file-discovery/setup-review-selection";
import { GameFileLibraries } from "./GameFileLibraries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function AddGames({
  active,
  generation,
  ports,
  profiles,
  statuses,
  sources,
  refreshFailed,
  onAdded,
  onOpenPort,
  onCheckFiles,
  onBrowseCatalog,
  onCopyInstallation,
  setupSource,
  setSetupSource,
  close,
}: {
  active: boolean;
  generation: number;
  ports: PortDefinition[];
  profiles: SourceProfile[];
  statuses: ReadonlyMap<string, PortStatus>;
  sources: SourceRecord[];
  refreshFailed: boolean;
  onAdded: () => Promise<unknown>;
  onOpenPort: (id: string, origin: string) => void;
  onCheckFiles: (id: string, profileId: string) => void;
  onBrowseCatalog: () => void;
  onCopyInstallation: () => void;
  setupSource?: SourceRecord | undefined;
  setSetupSource: (source?: SourceRecord) => void;
  close: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "files" | "folders">("choose");
  const [foldersVisited, setFoldersVisited] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const { requestReview } = useSetupReviewSelection();
  const port = ports.find((candidate) => candidate.id === selected);
  const status = port ? statuses.get(port.id) : undefined;
  const candidates = ports.filter((candidate) =>
    gameIdentityLabel(candidate).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const profile = profiles.find((candidate) => candidate.id === port?.source_profile);
  return (
    <section hidden={!active} aria-label="Add games workspace" className="min-w-0 wrap-anywhere">
      <Button variant="outline" size="sm" onClick={close}>
        Back to library
      </Button>
      <h2>Choose how to add games</h2>
      <p>
        Use your original game files, search folders you choose, or find a port first. Checking does
        not install anything.
      </p>
      <ol
        aria-label="Add games stages"
        className="flex flex-wrap gap-x-6 gap-y-2 ps-5 text-xs text-pc-muted-foreground"
      >
        <li>Choose inputs</li>
        <li>Recognize files / select a port</li>
        <li>Check the setup route</li>
        <li>Review consequences</li>
        <li>Prepare</li>
        <li>Completion / Play</li>
      </ol>
      <div className="my-4 flex flex-wrap gap-2" role="group" aria-label="Ways to add games">
        <Button
          variant={mode === "files" ? "selected" : "outline"}
          aria-pressed={mode === "files"}
          onClick={() => setMode("files")}
        >
          Choose game files
        </Button>
        <Button
          variant={mode === "folders" ? "selected" : "outline"}
          aria-pressed={mode === "folders"}
          onClick={() => {
            setFoldersVisited(true);
            setMode("folders");
          }}
        >
          Search game-file folders
        </Button>
        <Button variant="outline" onClick={onBrowseCatalog}>
          Browse Find games
        </Button>
      </div>
      <p>
        Already have a supported installation?{" "}
        <Button variant="link" size="sm" onClick={onCopyInstallation}>
          Copy an existing installation
        </Button>{" "}
        You can also review a supported external-installation route from its game page.
      </p>
      <section hidden={mode !== "files"} aria-label="Selected game-file check">
        <h3>Select the game and port to check</h3>
        <p>
          File checks use the chosen port’s requirements. Folder search can recognize multiple
          games; an unknown file or an ambiguous match stays unconfirmed.
        </p>
        <label htmlFor={active && mode === "files" ? "port-search" : undefined}>
          Find a game or port
        </label>
        <Input
          id={active && mode === "files" ? "port-search" : undefined}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="mt-3 block" htmlFor="add-games-port">
          Game and port
        </label>
        <select
          id="add-games-port"
          className="my-2 min-h-10 w-full max-w-full rounded-pc-md border border-pc-border bg-pc-surface p-2 text-pc-foreground"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose a port</option>
          {port && !candidates.includes(port) && (
            <option value={port.id}>{gameIdentityLabel(port)} (selected; outside search)</option>
          )}
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {gameIdentityLabel(candidate)}
            </option>
          ))}
        </select>
        {candidates.length === 0 && (
          <p role="status">
            No game or port matches this search. Change the search or browse Find games.
          </p>
        )}
        {port && (
          <>
            <p className="font-semibold">{gameIdentityLabel(port)}</p>
            {profile ? (
              <Button
                id="add-games-check-files"
                variant="primary"
                disabled={refreshFailed}
                onClick={() => onCheckFiles(port.id, profile.id)}
              >
                Choose files to check…
              </Button>
            ) : (
              <p>
                This port has no original-game-file requirement in the current catalog. Review its
                available setup route.
              </p>
            )}
            <p>
              After saving a checked location, review this port’s current route, release/channel,
              destination and requirements. Unknown saved-data facts stay unknown. Preparing uses
              the reviewed plan; selecting this port grants no execution permission.
            </p>
            <Button
              variant="outline"
              data-detail-origin="add-games:selected-setup"
              onClick={() => {
                if (
                  !refreshFailed &&
                  status?.channel &&
                  status.port_actions?.some(
                    (action) => action.action === "install" && action.availability === "allowed",
                  )
                )
                  requestReview(port.id, status.channel);
                onOpenPort(port.id, "add-games:selected-setup");
              }}
            >
              Review setup for {gameIdentityLabel(port)}
            </Button>
          </>
        )}
      </section>
      {foldersVisited && (
        <div hidden={mode !== "folders"}>
          <GameFileLibraries
            instanceId="add-games-folders"
            generation={generation}
            ports={ports}
            profiles={profiles}
            registeredSources={sources}
            statuses={statuses}
            workspaceRefreshFailed={refreshFailed}
            onAdded={onAdded}
            onOpenPort={onOpenPort}
            setupSource={setupSource}
            setSetupSource={setSetupSource}
          />
        </div>
      )}
      <p className="mt-4 text-xs text-pc-muted-foreground">
        Draft choices stay in this library workspace while you visit another view. Navigation does
        not cancel Core work. A cancellation request stays pending until the operation settles;
        resume is offered only when Core has a valid recovery plan.
      </p>
    </section>
  );
}
