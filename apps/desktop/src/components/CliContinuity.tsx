import { useEffect, useState } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { desktopApi } from "../api";
import { primaryCliCommand } from "../cli-command";
import { usesUserSelectedRuntime } from "../shared/external-runtime-trust";
import { copyText } from "../clipboard";
import type { CliCommandContext, PortDefinition, PortStatus, ReleaseChannel } from "../types";
import { errorText } from "../view-model";
import { Icon } from "./ui";
import { Button } from "./ui/button";

function useCliContinuity({
  generation,
  port,
  status,
  channel,
  sourcePath,
  biosPath,
}: {
  generation: number;
  port: PortDefinition;
  status?: PortStatus | undefined;
  channel: ReleaseChannel;
  sourcePath: string;
  biosPath: string;
}) {
  const [loaded, setLoaded] = useState<{
    generation: number;
    context: CliCommandContext;
  }>();
  const context = loaded?.generation === generation ? loaded.context : undefined;
  const [failed, setFailed] = useState<{
    generation: number;
    attempt: number;
    message: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const error =
    failed?.generation === generation && failed.attempt === attempt ? failed.message : undefined;
  useEffect(() => {
    let current = true;
    desktopApi
      .cliCommandContext(generation)
      .then((value) => {
        if (current) setLoaded({ generation, context: value });
      })
      .catch((value) => {
        if (current) setFailed({ generation, attempt, message: errorText(value) });
      });
    return () => {
      current = false;
    };
  }, [generation, attempt]);
  return { port, status, channel, sourcePath, biosPath, context, setAttempt, error };
}

export function CliContinuity(props: Parameters<typeof useCliContinuity>[0]) {
  return <CliContinuityView {...useCliContinuity(props)} />;
}

function CliContinuityView(model: ReturnType<typeof useCliContinuity>) {
  const { installed, stagedOnly, useInPlace, userSelected, title, copyLabel, disclosure } =
    cliPresentation(model.port, model.status);
  if (!model.context)
    return (
      <section
        className="cli-continuity mt-5 grid gap-2 rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-3"
        aria-label={title}
      >
        <strong>{title}</strong>
        {model.error ? (
          <>
            <p role="alert">{model.error}</p>
            <Button
              data-focusable
              variant="outline"
              onClick={() => model.setAttempt((value) => value + 1)}
            >
              Retry command details
            </Button>
          </>
        ) : (
          <p role="status">Finding the command-line app…</p>
        )}
      </section>
    );
  let command;
  try {
    command = primaryCliCommand(
      model.context,
      model.port,
      model.status,
      model.channel,
      model.sourcePath,
      model.biosPath,
    );
  } catch {
    return (
      <section
        className="cli-continuity mt-5 grid gap-2 rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-3"
        aria-label={title}
      >
        <strong>{title}</strong>
        <p role="alert">
          Remove invalid characters from the selected paths before copying a command.
        </p>
      </section>
    );
  }
  return (
    <section
      className="cli-continuity mt-5 grid gap-2 rounded-pc-md border border-[var(--color-border)] bg-[var(--color-bg-inset)] p-3"
      aria-label={title}
    >
      <div className="grid gap-1 [overflow-wrap:anywhere]">
        <strong>{title}</strong>
        <span>
          Uses this library: <code>{model.context.library_root}</code>
        </span>
      </div>
      <p>
        {command.interpreter === "powershell" ? "PowerShell 7" : "sh / bash"}
        {command.missing.length ? " template" : " command"}
      </p>
      {command.missing.length > 0 && (
        <p>
          Template — replace: {command.missing.join(", ")}.
          {!model.context.executable &&
            " Install the standalone Portcove CLI or locate its executable first."}
        </p>
      )}
      <CopyField
        key={command.shell}
        value={command.shell}
        label={command.missing.length ? "Copy command template" : copyLabel}
      />
      {<CliFollowUp {...{ userSelected, command }} />}
      <p>{disclosure}</p>
      {!installed && !stagedOnly && !useInPlace && model.channel === "beta" && (
        <p>
          This command uses the compatible beta spelling: beta selects Preview. The selected CLI's
          preview input support has not been verified, so the copied command retains beta for
          compatibility.
        </p>
      )}
      <details>
        <summary data-focusable>Separate program and arguments</summary>
        <p>
          For integrations that accept a program path and an argument array. The shell command above
          is for a terminal.
        </p>
        <CopyField key={command.executable} value={command.executable} label="Copy program path" />
        <CopyField
          key={JSON.stringify(command.args)}
          value={JSON.stringify(command.args)}
          label="Copy argument array"
        />
      </details>
    </section>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  };
  return (
    <>
      <div className="command-line grid grid-cols-[minmax(0,_1fr)_auto] items-stretch gap-1">
        <code className="min-w-0 rounded-pc-sm border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] p-[var(--space-2)_var(--space-3)] text-[length:var(--text-xs)] [overflow-wrap:anywhere] whitespace-pre-wrap text-[var(--color-interactive-text)]">
          {value}
        </code>
        <Button
          data-focusable
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={() => {
            void copy();
          }}
        >
          <Icon glyph={copied ? ClipboardCheck : Clipboard} />
        </Button>
      </div>
      {copied && <small role="status">Copied</small>}
      {failed && <small role="alert">Clipboard unavailable. Select and copy the text above.</small>}
    </>
  );
}

function CliFollowUp({
  userSelected,
  command,
}: Pick<
  ReturnType<typeof useCliContinuity> & {
    command: ReturnType<typeof primaryCliCommand>;
    userSelected: boolean;
  },
  "userSelected" | "command"
>) {
  return (
    command.followUp && (
      <>
        <p>
          {userSelected
            ? "After reviewing the executable, working directory and any --arg values, replace review-sha256 with the returned review fingerprint and save the same launch details. All external files stay where they are."
            : "After the folder check passes, review and save this installation. Its files stay where they are."}
        </p>
        <CopyField
          key={command.followUp.shell}
          value={command.followUp.shell}
          label="Copy use-in-place command template"
        />
      </>
    )
  );
}

function cliPresentation(port: PortDefinition, status: PortStatus | undefined) {
  const installed = Boolean(status?.active || status?.external_runtime);
  const stagedOnly = !installed && Boolean(status?.staged);
  const useInPlace = !installed && !stagedOnly && port.release.provider === "user-prepared";
  const userSelected = usesUserSelectedRuntime(port, status);
  const title = installed
    ? "Launch from another app"
    : stagedOnly
      ? "Activate staged version"
      : "Set up from the command line";
  const copyLabel = installed
    ? "Copy launch command"
    : stagedOnly
      ? "Copy activation command"
      : useInPlace
        ? userSelected
          ? "Copy launch-review command"
          : "Copy folder-check command"
        : "Copy setup command";
  const disclosure = installed
    ? "The CLI checks this installation before launching it. This does not install or update the game."
    : stagedOnly
      ? "The CLI checks the retained staged version before making it active. This does not download a new release or register an external installation."
      : useInPlace
        ? userSelected
          ? "Complete upstream setup, then replace game-executable and working-directory with your selected paths. Add documented arguments with one --arg per argument to both commands. You or the upstream launcher manage setup and updates; Portcove has not authenticated the selected bytes as an official package."
          : "Prepare the required version yourself. Replace game-folder with its folder path, check it, then save the location after review. Portcove does not download, copy, update, back up, or delete these files."
        : "Running this command can download and install the selected release. Required game files are checked before use.";
  return { installed, stagedOnly, useInPlace, userSelected, title, copyLabel, disclosure };
}
