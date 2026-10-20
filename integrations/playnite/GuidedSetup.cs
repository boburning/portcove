using System;
using System.Linq;

namespace Portcove.ReferenceClient
{
    // Descriptive instructions only. No step is treated as completed or authorized.
    internal static class SetupInstructions
    {
        internal static object ForRuntime(object status, object catalog)
        {
            // A current managed definition cannot describe preparation of a
            // previously registered, player-owned external installation.
            if (Json.OptionalObjectField(status, "external_runtime") != null &&
                Json.Text(Json.Field(catalog, "release"), "provider") != "user-prepared") return null;
            return Json.OptionalObjectField(catalog, "presentation");
        }

        internal static string Summary(object presentation)
        {
            if (presentation == null) return null;
            var guide = Json.OptionalObjectField(presentation, "manual_setup");
            if (guide == null) return OptionalTextField(presentation, "manual_preparation");
            if (Json.Object(guide).Keys.Any(key => !new[] { "steps", "warnings", "help_url" }.Contains(key)))
                throw new InvalidOperationException("Unknown manual setup guidance field.");
            var steps = Json.Array(Json.Field(guide, "steps"));
            var warnings = Json.Array(Json.Field(guide, "warnings"));
            if (steps.Length < 1 || steps.Length > 8 || warnings.Length > 8)
                throw new InvalidOperationException("Incomplete manual setup guidance.");
            if (steps.Any(step => Json.Object(step).Keys.Any(key => key != "title" && key != "instruction")))
                throw new InvalidOperationException("Unknown manual setup step field.");
            var result = string.Join("\n", warnings.Select(value => "Before you begin: " + Text(value)));
            result += "\n" + string.Join("\n", steps.Select((step, index) =>
                (index + 1) + ". " + Text(Json.Field(step, "title")) + ": " + Text(Json.Field(step, "instruction"))));
            var help = OptionalTextField(guide, "help_url");
            if (help != null)
            {
                help = Text(help);
                Uri url;
                if (!Uri.TryCreate(help, UriKind.Absolute, out url) || url.Scheme != "https" || string.IsNullOrEmpty(url.Host) || !string.IsNullOrEmpty(url.UserInfo))
                    throw new InvalidOperationException("Unsafe manual setup guide URL.");
            }
            return result.Trim();
        }

        internal static string HelpUrl(object presentation)
        {
            Summary(presentation); // Apply the same strict guidance and URL checks before opening a link.
            if (presentation == null) return null;
            var guide = Json.OptionalObjectField(presentation, "manual_setup");
            return guide == null ? null : OptionalTextField(guide, "help_url");
        }

        internal static string TechnicalNotes(object presentation)
        {
            if (presentation == null || Json.OptionalObjectField(presentation, "manual_setup") == null) return null;
            return OptionalTextField(presentation, "manual_preparation");
        }

        private static string OptionalTextField(object value, string key)
        {
            object result;
            return Json.TryField(value, key, out result) ? Json.OptionalText(value, key) : null;
        }

        private static string Text(object value)
        {
            var text = value as string;
            if (string.IsNullOrWhiteSpace(text) || text.Trim() != text || text.Any(char.IsControl))
                throw new InvalidOperationException("Invalid manual setup instruction.");
            return text;
        }
    }

    internal enum GuidedStepKind
    {
        ChooseSource, ChooseBios, ValidateSources, RegisterExternal, Install, FinishSetup, Play, ReviewProblem
    }

    // Descriptive Core claims only; these helpers never grant an operation.
    internal static class SourceInputAssessment
    {
        internal static void Validate(object readiness, long schema)
        {
            if (readiness == null) return;
            object launchable, declaredBlockers;
            if (Json.TryField(readiness, "launchable", out launchable) && launchable is bool && (bool)launchable
                && Json.TryField(readiness, "blockers", out declaredBlockers) && Json.Array(declaredBlockers).Length != 0)
                throw new InvalidOperationException("Launch readiness contradicts its blockers.");
            foreach (var role in new[] { "source", "bios" })
            {
                var assessment = Json.OptionalObjectField(readiness, role + "_assessment");
                if (assessment == null) continue; // Missing legacy evidence remains unknown.
                if (schema < 70) throw new InvalidOperationException("Source assessments require API schema 70.");
                var health = Json.Text(assessment, "health");
                if (!new[] { "unregistered", "not_checked", "not_baselined", "current", "missing", "unreadable", "changed" }.Contains(health))
                    throw new InvalidOperationException("Unknown source assessment health.");
                var recordedHealth = Json.OptionalText(readiness, role);
                if (recordedHealth != null && recordedHealth != health)
                    throw new InvalidOperationException("Source assessment and byte health disagree.");
                var classification = Json.Field(assessment, "classification");
                var identityState = Json.Text(classification, "state");
                if (!new[] { "not_evaluated", "unrecognized", "recognized", "ambiguous" }.Contains(identityState))
                    throw new InvalidOperationException("Unknown source classification.");
                if (identityState == "recognized")
                    foreach (var field in new[] { "game_id", "variant_id", "representation_id" })
                        if (string.IsNullOrWhiteSpace(Json.Text(Json.Field(classification, "identity"), field)))
                            throw new InvalidOperationException("Incomplete source identity.");
                var contract = Json.Field(assessment, "contract");
                var contractState = Json.Text(contract, "state");
                if (!new[] { "not_evaluated", "unreviewed_for_release", "supported", "recognized_not_listed", "known_incompatible", "informational" }.Contains(contractState))
                    throw new InvalidOperationException("Unknown source contract result.");
                if (new[] { "supported", "recognized_not_listed", "known_incompatible", "informational" }.Contains(contractState)
                    && string.IsNullOrWhiteSpace(Json.Text(contract, "contract_id")))
                    throw new InvalidOperationException("Source contract identity is missing.");
                var admission = Json.Field(assessment, "admission");
                var admissionState = Json.Text(admission, "state");
                if (!new[] { "not_evaluated", "admitted", "rejected" }.Contains(admissionState))
                    throw new InvalidOperationException("Unknown source admission result.");
                if (admissionState == "admitted" && !new[] { "exact_identity", "structural_checks", "informational_consent", "upstream_validator" }.Contains(Json.Text(admission, "mode")))
                    throw new InvalidOperationException("Unknown source admission mode.");
                if (admissionState == "rejected" && !new[] { "missing", "unreadable", "changed", "known_mismatch", "ambiguous_identity", "missing_tool", "check_failed", "consent_required" }.Contains(Json.Text(admission, "reason")))
                    throw new InvalidOperationException("Unknown source rejection reason.");
                if (KnownFailure(readiness, role) && Json.Boolean(readiness, "launchable"))
                    throw new InvalidOperationException("Launch readiness contradicts a known input failure.");
            }
            object blockers;
            if (schema < 70 && Json.TryField(readiness, "blockers", out blockers) && Json.Array(blockers).Contains("incompatible_bios"))
                throw new InvalidOperationException("BIOS compatibility guidance requires API schema 70.");
        }

        internal static bool Confirmed(object readiness, string profile, string role)
        {
            if (profile == null) return true;
            var assessment = Json.OptionalObjectField(readiness, role + "_assessment");
            if (assessment == null) return false;
            var classification = Json.Field(assessment, "classification");
            var admission = Json.Field(assessment, "admission");
            return Json.Text(assessment, "health") == "current"
                && Json.Text(classification, "state") == "recognized"
                && Json.Text(Json.Field(classification, "identity"), "game_id") == profile
                && Json.Text(Json.Field(assessment, "contract"), "state") == "supported"
                && Json.Text(admission, "state") == "admitted" && Json.Text(admission, "mode") == "exact_identity";
        }

        internal static bool KnownFailure(object readiness, string role)
        {
            var assessment = Json.OptionalObjectField(readiness, role + "_assessment");
            if (assessment == null || Json.Text(assessment, "health") != "current") return false;
            var contract = Json.Text(Json.Field(assessment, "contract"), "state");
            var admission = Json.Field(assessment, "admission");
            return new[] { "recognized_not_listed", "known_incompatible" }.Contains(contract)
                || (Json.Text(admission, "state") == "rejected" && new[] { "known_mismatch", "ambiguous_identity", "check_failed" }.Contains(Json.Text(admission, "reason")));
        }
    }

    // A presentation decision over core status. The selected action still rechecks
    // authority through the ordinary CLI or Playnite launch controller.
    internal sealed class GuidedSetup
    {
        private static readonly string[] KnownBlockers =
        {
            "missing_source", "unreadable_source", "changed_source", "incompatible_source", "missing_bios",
            "unreadable_bios", "changed_bios", "incompatible_bios", "missing_runtime", "preparation_required",
            "invalid_installation"
        };

        internal GuidedStepKind Kind { get; private set; }
        internal string Label { get; private set; }
        internal string Detail { get; private set; }

        private static GuidedSetup Step(GuidedStepKind kind, string label, string detail) =>
            new GuidedSetup { Kind = kind, Label = label, Detail = detail };

        internal static GuidedSetup Choose(object status, object catalog, string sourcePath, string biosPath, bool reviewedExternal = false)
        {
            var sourceProfile = Json.OptionalText(catalog, "source_profile");
            var biosProfile = Json.OptionalText(catalog, "bios_source_profile");
            var readiness = Json.Field(status, "readiness");
            var blockers = Json.Array(Json.Field(readiness, "blockers")).Select(value => value as string).ToArray();
            if (blockers.Any(value => value == null || !KnownBlockers.Contains(value)))
                return Step(GuidedStepKind.ReviewProblem, "Review readiness",
                    "Portcove returned an unknown readiness blocker. Refresh with a compatible CLI before managing this game.");
            if (blockers.Length != 0 && Json.Boolean(readiness, "launchable"))
                return Step(GuidedStepKind.ReviewProblem, "Refresh readiness", "The reported launch state and requirements disagree. Refresh before launching.");
            object requiredExtension;
            Json.TryField(readiness, "required_source_extension", out requiredExtension);
            var extension = requiredExtension as string;
            if ((requiredExtension != null && (extension == null || extension.Length == 0 ||
                extension.Length > 16 || extension.Any(character => !((character >= 'a' && character <= 'z') ||
                    (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9'))) || sourceProfile == null)) ||
                (blockers.Contains("incompatible_source") && ((extension == null && !SourceInputAssessment.KnownFailure(readiness, "source")) || Json.Boolean(readiness, "launchable"))))
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
            var external = Json.OptionalObjectField(status, "external_runtime") != null ||
                Json.Text(Json.Field(catalog, "release"), "provider") == "user-prepared";
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
            {
                object pendingSetup;
                if (Json.TryField(readiness, "pending_setup", out pendingSetup) && pendingSetup is bool && (bool)pendingSetup)
                    return Step(GuidedStepKind.Play, "Start setup", "Start the port's first-time setup. Portcove checks the required files again before starting it.");
                return SourceInputAssessment.Confirmed(readiness, sourceProfile, "source") && SourceInputAssessment.Confirmed(readiness, biosProfile, "bios")
                    ? Step(GuidedStepKind.Play, "Play", "Playnite launches the current installation through Portcove. It does not install or update the game.")
                    : Step(GuidedStepKind.Play, "Try launch", "The files are available, but compatibility with the installed version is unconfirmed. Portcove checks them again before launching; setup may still be needed. A clean process exit does not establish gameplay.");
            }
            if (sourceProfile != null && blockers.Any(value => value == "missing_source" ||
                value == "unreadable_source" || value == "changed_source" || value == "incompatible_source"))
                return Step(GuidedStepKind.ChooseSource, "Choose original files…",
                    extension == null ? "Choose your own game file, or use Choose folder below. Portcove will validate it before use." :
                    "Choose your own uncompressed ." + extension + " original game file. Select the file itself rather than a ZIP containing it. Portcove will validate the selected file before registering it; originals remain in place.");
            if (biosProfile != null && blockers.Any(value => value == "missing_bios" ||
                value == "unreadable_bios" || value == "changed_bios" || value == "incompatible_bios"))
                return Step(GuidedStepKind.ChooseBios, "Choose BIOS file…",
                    "Choose your own BIOS file. Portcove will validate it before use.");
            if (external && !installed && !reviewedExternal)
                return Step(GuidedStepKind.ReviewProblem, "Update Portcove CLI",
                    "Reviewed external registration requires supported public API schema 67 or later and external.review. Update the selected CLI; existing managed Play remains available.");
            if (external && installed && blockers.Any(value => value == "preparation_required" || value == "invalid_installation"))
            {
                var runtime = Json.OptionalObjectField(status, "external_runtime");
                var shared = runtime == null ? null : Json.OptionalObjectField(runtime, "shared_preferences");
                if (shared != null && Json.Text(shared, "contract") == "smb1r-1.1-stable-windows")
                    return Step(GuidedStepKind.ReviewProblem, "Prepare shared game data manually",
                        "Copy your recognized Super Mario Bros. (World) NES original to " + Json.Text(shared, "path") +
                        " as baserom.nes. If settings.cfg exists there, review it as ordinary data without Godot object or resource constructors and use only the BaseAssets resource pack. Move custom levels and autosaves, blueprints, custom characters, extra resource packs and Godot loader metadata elsewhere manually, preserving their files. Refresh afterward. Portcove does not seed, own, update, back up or delete this shared directory.");
            }
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
