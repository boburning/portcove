using System;
using System.Linq;

namespace Portcove.ReferenceClient
{
    internal enum GuidedStepKind
    {
        ChooseSource, ChooseBios, ValidateSources, RegisterExternal, Install, FinishSetup, Play, ReviewProblem
    }

    // A presentation decision over core status. The selected action still rechecks
    // authority through the ordinary CLI or Playnite launch controller.
    internal sealed class GuidedSetup
    {
        private static readonly string[] KnownBlockers =
        {
            "missing_source", "unreadable_source", "changed_source", "incompatible_source", "missing_bios",
            "unreadable_bios", "changed_bios", "missing_runtime", "preparation_required",
            "invalid_installation"
        };

        internal GuidedStepKind Kind { get; private set; }
        internal string Label { get; private set; }
        internal string Detail { get; private set; }

        private static GuidedSetup Step(GuidedStepKind kind, string label, string detail) =>
            new GuidedSetup { Kind = kind, Label = label, Detail = detail };

        internal static GuidedSetup Choose(object status, object catalog, string sourcePath, string biosPath)
        {
            var sourceProfile = Json.OptionalText(catalog, "source_profile");
            var biosProfile = Json.OptionalText(catalog, "bios_source_profile");
            var readiness = Json.Field(status, "readiness");
            var blockers = Json.Array(Json.Field(readiness, "blockers")).Select(value => value as string).ToArray();
            if (blockers.Any(value => value == null || !KnownBlockers.Contains(value)))
                return Step(GuidedStepKind.ReviewProblem, "Review readiness",
                    "Portcove returned an unknown readiness blocker. Refresh with a compatible CLI before managing this game.");
            object requiredExtension;
            Json.TryField(readiness, "required_source_extension", out requiredExtension);
            var extension = requiredExtension as string;
            if ((requiredExtension != null && (extension == null || extension.Length == 0 ||
                extension.Length > 16 || extension.Any(character => !((character >= 'a' && character <= 'z') ||
                    (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9'))) || sourceProfile == null)) ||
                (blockers.Contains("incompatible_source") && (extension == null || Json.Boolean(readiness, "launchable"))))
                return Step(GuidedStepKind.ReviewProblem, "Review source requirement",
                    "Portcove returned an invalid source representation requirement. Refresh with a compatible CLI before registering files.");
            var actions = PortActions.Read(status);
            var launch = actions.FirstOrDefault(value => value.Action == "launch");
            var installed = StatusInstallation.Current(status) != null;
            var install = actions.FirstOrDefault(value => value.Action == "install");
            if (!installed && install != null && install.Availability == "held")
                return Step(GuidedStepKind.ReviewProblem, "Review installation hold",
                    "Portcove has held installation. Review the action reason above before registering more files or retrying.");
            if (installed && launch != null && launch.Availability == "held")
                return Step(GuidedStepKind.ReviewProblem, "Review launch hold",
                    "This game is registered, but Portcove has held launch. Review the action reason above before registering more files or retrying.");
            var external = Json.Text(Json.Field(catalog, "release"), "provider") == "user-prepared";
            var register = actions.FirstOrDefault(value => value.Action == "register_external");
            if (external && !installed && register != null && register.Availability == "held")
                return Step(GuidedStepKind.ReviewProblem, "Review registration hold",
                    "Portcove has held runtime registration. Review its action reason before selecting another folder.");
            if (!string.IsNullOrWhiteSpace(sourcePath) || !string.IsNullOrWhiteSpace(biosPath))
            {
                if ((!string.IsNullOrWhiteSpace(sourcePath) && sourceProfile == null) ||
                    (!string.IsNullOrWhiteSpace(biosPath) && biosProfile == null))
                    return Step(GuidedStepKind.ReviewProblem, "Review source selection",
                        "This catalog entry does not request one of the selected inputs. Clear that path and refresh readiness.");
                return Step(GuidedStepKind.ValidateSources, "Check and register original files",
                    "Portcove checks the selected paths against their source profiles before registering them. Game-specific revision checks may also occur during setup. Originals remain in place." +
                    (extension == null ? "" : " This runtime requires an uncompressed ." + extension + " original file for launch."));
            }
            if (installed && Json.Boolean(readiness, "launchable") &&
                (launch == null || launch.Availability == "allowed"))
                return Step(GuidedStepKind.Play, "Play",
                    "Playnite launches the current installation through Portcove. It does not install or update the game.");
            if (sourceProfile != null && blockers.Any(value => value == "missing_source" ||
                value == "unreadable_source" || value == "changed_source" || value == "incompatible_source"))
                return Step(GuidedStepKind.ChooseSource, "Choose original files…",
                    extension == null ? "Choose your own game file, or use Choose folder below. Portcove will validate it before use." :
                    "Choose your own uncompressed ." + extension + " original game file. Select the file itself rather than a ZIP containing it. Portcove will validate the selected file before registering it; originals remain in place.");
            if (biosProfile != null && blockers.Any(value => value == "missing_bios" ||
                value == "unreadable_bios" || value == "changed_bios"))
                return Step(GuidedStepKind.ChooseBios, "Choose BIOS file…",
                    "Choose your own BIOS file. Portcove will validate it before use.");
            if (external)
                return installed ? Step(GuidedStepKind.ReviewProblem, "Review external runtime",
                    "This player-owned runtime is registered but cannot launch. Review the readiness and launch-action reasons above; refresh after resolving them.") :
                    Step(GuidedStepKind.RegisterExternal, "Choose prepared runtime folder…",
                        "Choose your already extracted official runtime. Portcove checks the exact accepted package identity and reviews its use in place; it does not install or update these files.");
            if (installed && Json.Boolean(readiness, "pending_setup"))
                return Step(GuidedStepKind.FinishSetup, "Finish setup",
                    "Review the exact preparation plan before Portcove makes a private playable copy.");

            if (!installed && (install == null || install.Availability == "allowed"))
                return Step(GuidedStepKind.Install, "Install",
                    "Review the destination and selected release before Portcove downloads or activates anything.");
            return Step(GuidedStepKind.ReviewProblem, "Review problem",
                "Portcove has not reported a safe next setup step. Read the readiness and action reasons, then refresh after resolving them.");
        }
    }
}
