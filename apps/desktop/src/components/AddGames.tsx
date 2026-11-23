import { useState } from "react";
import type { PortDefinition, PortStatus, SourceProfile, SourceRecord } from "../types";
import { GameFileLibraries } from "./GameFileLibraries";
import type { ScanResultRequest } from "../features/game-file-discovery/use-game-file-scan";
import { RegisteredSourceSetup } from "./RegisteredSourceSetup";
import type { Perform } from "../features/operations/use-operation-state";
import { Button } from "./ui/button";
import { ArrowRight, ChevronDown, FolderInput, FolderSearch, Gamepad2 } from "lucide-react";
import { Icon } from "./ui";

export function AddGames({
  active,
  scanRequest,
  generation,
  ports,
  profiles,
  statuses,
  sources,
  refreshFailed,
  perform,
  onAdded,
  onOpenPort,
  onBrowseCatalog,
  onCopyInstallation,
  setupSource,
  setSetupSource,
}: {
  active: boolean;
  scanRequest?: ScanResultRequest | undefined;
  generation: number;
  ports: PortDefinition[];
  profiles: SourceProfile[];
  statuses: ReadonlyMap<string, PortStatus>;
  sources: SourceRecord[];
  refreshFailed: boolean;
  perform: Perform;
  onAdded: () => Promise<unknown>;
  onOpenPort: (id: string, origin: string) => void;
  onBrowseCatalog: () => void;
  onCopyInstallation: () => void;
  setupSource?: SourceRecord | undefined;
  setSetupSource: (source?: SourceRecord) => void;
}) {
  // Choosing a game always happens in Discover, where artwork and details help.
  const [mode, setMode] = useState<"choose" | "folders" | "existing">(
    scanRequest ? "folders" : "choose",
  );
  const [foldersVisited, setFoldersVisited] = useState(Boolean(scanRequest));
  const [seenScanRequest, setSeenScanRequest] = useState(scanRequest?.sequence);
  if (scanRequest?.sequence !== seenScanRequest) {
    setSeenScanRequest(scanRequest?.sequence);
    setFoldersVisited(true);
    setMode("folders");
  }
  return (
    <section hidden={!active} aria-label="Add games workspace" className="add-games">
      <p className="add-games-intro">
        Start with a game you want to play, original files, or a game you’ve already installed.
      </p>
      <div
        className="add-route-choices"
        data-route-selected={mode !== "choose"}
        role="group"
        aria-label="Ways to add games"
      >
        <Button
          data-focusable
          variant={mode === "choose" ? "ghost" : "outline"}
          className="add-route-choice"
          aria-describedby="add-game-description"
          onClick={onBrowseCatalog}
        >
          <Icon glyph={Gamepad2} />
          <span>
            <strong className="block">Browse games</strong>
            <span id="add-game-description" className="add-route-description" aria-hidden="true">
              Pick a game in Discover, then see what you need to play it.
            </span>
          </span>
          <Icon glyph={ArrowRight} size="sm" className="add-route-arrow" />
        </Button>
        <Button
          data-focusable
          variant={mode === "folders" ? "selected" : mode === "choose" ? "ghost" : "outline"}
          className="add-route-choice"
          aria-describedby="add-folder-description"
          aria-pressed={mode === "folders"}
          aria-controls={foldersVisited ? "add-games-scan" : undefined}
          onClick={() => {
            setFoldersVisited(true);
            setMode("folders");
          }}
        >
          <Icon glyph={FolderSearch} />
          <span>
            <strong className="block">Scan a folder</strong>
            <span id="add-folder-description" className="add-route-description" aria-hidden="true">
              Choose a folder of your game files; Portcove finds the supported ones.
            </span>
          </span>
          <Icon glyph={ChevronDown} size="sm" className="add-route-arrow" />
        </Button>
        <Button
          data-focusable
          variant={mode === "existing" ? "selected" : mode === "choose" ? "ghost" : "outline"}
          aria-pressed={mode === "existing"}
          aria-controls="add-games-existing"
          className="add-route-choice"
          aria-describedby="add-existing-description"
          onClick={() => setMode("existing")}
        >
          <Icon glyph={FolderInput} />
          <span>
            <strong className="block">Use an existing installation</strong>
            <span
              id="add-existing-description"
              className="add-route-description"
              aria-hidden="true"
            >
              Copy a supported installation or keep using its current folder.
            </span>
          </span>
          <Icon glyph={ChevronDown} size="sm" className="add-route-arrow" />
        </Button>
      </div>
      <section
        id="add-games-existing"
        hidden={mode !== "existing"}
        className="add-route-panel add-existing-options"
        aria-label="Existing installation options"
      >
        <div className="add-existing-choice">
          <div>
            <h2 className="text-lg">Bring a copy into your library</h2>
            <p className="max-w-[65ch] text-pc-muted-foreground">
              Review the detected port, destination and supported saved data before copying. The
              original folder stays in place.
            </p>
          </div>
          <Button data-focusable variant="primary" onClick={onCopyInstallation}>
            Copy an existing installation
            <Icon glyph={ArrowRight} size="sm" />
          </Button>
        </div>
        <div className="add-existing-choice">
          <div>
            <h2 className="text-lg">Use the game where it is</h2>
            <p className="max-w-[65ch] text-pc-muted-foreground">
              Some ports can use an installation where it is. Choose the game to check its setup
              options. For this option, you’ll handle updates and backups.
            </p>
          </div>
          <Button data-focusable variant="outline" onClick={onBrowseCatalog}>
            Browse games
            <Icon glyph={ArrowRight} size="sm" />
          </Button>
        </div>
      </section>
      {foldersVisited && (
        <div id="add-games-scan" hidden={mode !== "folders"} className="add-route-panel">
          <GameFileLibraries
            active={active && mode === "folders"}
            scanAfterAdd
            instanceId="add-games-folders"
            scanRequest={scanRequest}
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
      <RegisteredSourceSetup
        sources={sources}
        profiles={profiles}
        statuses={statuses}
        generation={generation}
        current={active && !refreshFailed}
        perform={perform}
        onChanged={onAdded}
        onOpenPort={onOpenPort}
      />
    </section>
  );
}
