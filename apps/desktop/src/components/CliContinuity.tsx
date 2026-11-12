import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { Clipboard, ClipboardCheck } from "lucide-react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { primaryCliCommand } from "../cli-command";
import { usesUserSelectedRuntime } from "../shared/external-runtime-trust";
import { copyText } from "../clipboard";
import { useAppTranslation } from "../localization";
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

/** Command placeholder tokens stay literal inside translated guidance. */
const tokens = {
  arg: <code>--arg</code>,
  review: <code>review-sha256</code>,
  executable: <code>game-executable</code>,
  workdir: <code>working-directory</code>,
  folder: <code>game-folder</code>,
};

function CliContinuityView(model: ReturnType<typeof useCliContinuity>) {
  const { t } = useAppTranslation("cli");
  const { installed, stagedOnly, useInPlace, userSelected, title, copyLabel, disclosure } =
    cliPresentation(t, model.port, model.status);
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
              {t("retry")}
            </Button>
          </>
        ) : (
          <p role="status">{t("finding")}</p>
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
        <p role="alert">{t("invalidPaths")}</p>
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
          <Trans
            t={t}
            i18nKey="library"
            components={{ path: <code>{model.context.library_root}</code> }}
          />
        </span>
      </div>
      <p>
        {command.interpreter === "powershell"
          ? command.missing.length
            ? t("interpreter.powershellTemplate")
            : t("interpreter.powershellCommand")
          : command.missing.length
            ? t("interpreter.shTemplate")
            : t("interpreter.shCommand")}
      </p>
      {command.missing.length > 0 && (
        <p>
          <Trans
            t={t}
            i18nKey={model.context.executable ? "template.replace" : "template.replaceAndInstall"}
            components={{ names: <bdi>{command.missing.join(", ")}</bdi> }}
          />
        </p>
      )}
      <CopyField
        key={command.shell}
        value={command.shell}
        label={command.missing.length ? t("copy.template") : copyLabel}
      />
      {<CliFollowUp {...{ userSelected, command }} />}
      <p>{disclosure}</p>
      {!installed && !stagedOnly && !useInPlace && model.channel === "beta" && (
        <p>{t("previewBeta")}</p>
      )}
      <details>
        <summary data-focusable>{t("separate.summary")}</summary>
        <p>{t("separate.explanation")}</p>
        <CopyField key={command.executable} value={command.executable} label={t("copy.program")} />
        <CopyField
          key={JSON.stringify(command.args)}
          value={JSON.stringify(command.args)}
          label={t("copy.arguments")}
        />
      </details>
    </section>
  );
}

function CopyField({ value, label }: { value: string; label: string }) {
  const { t } = useAppTranslation("cli");
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
      {copied && <small role="status">{t("copy.copied")}</small>}
      {failed && <small role="alert">{t("copy.unavailable")}</small>}
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
  const { t } = useAppTranslation("cli");
  return (
    command.followUp && (
      <>
        <p>
          {userSelected ? (
            <Trans t={t} i18nKey="followUp.userSelected" components={tokens} />
          ) : (
            t("followUp.folder")
          )}
        </p>
        <CopyField
          key={command.followUp.shell}
          value={command.followUp.shell}
          label={t("copy.useInPlace")}
        />
      </>
    )
  );
}

function cliPresentation(
  t: TFunction<"cli">,
  port: PortDefinition,
  status: PortStatus | undefined,
) {
  const installed = Boolean(status?.active || status?.external_runtime);
  const stagedOnly = !installed && Boolean(status?.staged);
  const useInPlace = !installed && !stagedOnly && port.release.provider === "user-prepared";
  const userSelected = usesUserSelectedRuntime(port, status);
  const title = installed
    ? t("title.installed")
    : stagedOnly
      ? t("title.staged")
      : t("title.setup");
  const copyLabel = installed
    ? t("copy.launch")
    : stagedOnly
      ? t("copy.activation")
      : useInPlace
        ? userSelected
          ? t("copy.launchReview")
          : t("copy.folderCheck")
        : t("copy.setup");
  const disclosure = installed ? (
    t("disclosure.installed")
  ) : stagedOnly ? (
    t("disclosure.staged")
  ) : useInPlace ? (
    userSelected ? (
      <Trans t={t} i18nKey="disclosure.userSelected" components={tokens} />
    ) : (
      <Trans t={t} i18nKey="disclosure.folder" components={tokens} />
    )
  ) : (
    t("disclosure.setup")
  );
  return { installed, stagedOnly, useInPlace, userSelected, title, copyLabel, disclosure };
}
