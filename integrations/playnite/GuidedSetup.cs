using System;
using System.Linq;

namespace Portcove.ReferenceClient
{
    internal enum GuidedStepKind
    {
        ChooseSource, ChooseBios, ValidateSources, Install, FinishSetup, Play, ReviewProblem
    }

    // A presentation decision over core status. The selected action still rechecks
    // authority through the ordinary CLI or Playnite launch controller.
    internal sealed class GuidedSetup
    {
        internal GuidedStepKind Kind { get; private set; }
        internal string Label { get; private set; }
        internal string Detail { get; private set; }

        private static GuidedSetup Step(GuidedStepKind kind, string label, string detail) =>
            new GuidedSetup { Kind = kind, Label = label, Detail = detail };

        internal static GuidedSetup Choose(object status, object catalog, string sourcePath, string biosPath)
        {
            var sourceProfile = Json.OptionalText(catalog, "source_profile");
            var biosProfile = Json.OptionalText(catalog, "bios_source_profile");
            if (!string.IsNullOrWhiteSpace(sourcePath) || !string.IsNullOrWhiteSpace(biosPath))
            {
                if ((!string.IsNullOrWhiteSpace(sourcePath) && sourceProfile == null) ||
                    (!string.IsNullOrWhiteSpace(biosPath) && biosProfile == null))
                    return Step(GuidedStepKind.ReviewProblem, "Review source selection",
                        "This catalog entry does not request one of the selected inputs. Clear that path and refresh readiness.");
                return Step(GuidedStepKind.ValidateSources, "Validate original files",
                    "Portcove checks the selected original files before registering them. They remain in place.");
            }

            var readiness = Json.Field(status, "readiness");
            var blockers = Json.Array(Json.Field(readiness, "blockers")).Select(value => value as string).ToArray();
            if (blockers.Any(value => value == null))
                throw new InvalidOperationException("Portcove returned an unknown readiness blocker. Refresh with a compatible CLI.");
            var actions = PortActions.Read(status);
            var launch = actions.FirstOrDefault(value => value.Action == "launch");
            var installed = StatusInstallation.Current(status) != null;
            if (installed && Json.Boolean(readiness, "launchable") &&
                (launch == null || launch.Availability == "allowed"))
                return Step(GuidedStepKind.Play, "Play",
                    "Playnite launches the current installation through Portcove. It does not install or update the game.");
            if (Json.Text(Json.Field(catalog, "release"), "provider") == "user-prepared")
                return Step(GuidedStepKind.ReviewProblem, "Review external setup",
                    "Register this player-owned runtime in Portcove Desktop or CLI, then refresh Playnite. Portcove does not install its files.");
            if (sourceProfile != null && blockers.Any(value => value == "missing_source" ||
                value == "unreadable_source" || value == "changed_source"))
                return Step(GuidedStepKind.ChooseSource, "Choose original files…",
                    "Choose your own game file, or use Choose folder below. Portcove will validate it before use.");
            if (biosProfile != null && blockers.Any(value => value == "missing_bios" ||
                value == "unreadable_bios" || value == "changed_bios"))
                return Step(GuidedStepKind.ChooseBios, "Choose BIOS file…",
                    "Choose your own BIOS file. Portcove will validate it before use.");
            if (installed && Json.Boolean(readiness, "pending_setup"))
                return Step(GuidedStepKind.FinishSetup, "Finish setup",
                    "Review the exact preparation plan before Portcove makes a private playable copy.");

            var install = actions.FirstOrDefault(value => value.Action == "install");
            if (!installed && (install == null || install.Availability == "allowed"))
                return Step(GuidedStepKind.Install, "Install",
                    "Review the destination and selected release before Portcove downloads or activates anything.");
            return Step(GuidedStepKind.ReviewProblem, "Review problem",
                "Portcove has not reported a safe next setup step. Read the readiness and action reasons, then refresh after resolving them.");
        }
    }
}
