using System;
using System.Collections.Generic;
using System.Linq;

namespace Portcove.ReferenceClient
{
    // Presentation and checked transport only. Core owns admission and execution.
    internal sealed class InstallationReview
    {
        internal string Fingerprint { get; private set; }
        internal string Description { get; private set; }
        private string sharedDescription;
        private bool sharedAcknowledged;
        private string port;

        internal bool ConfirmSharedScope(Func<string, bool> confirm)
        {
            if (sharedDescription == null) return true;
            sharedAcknowledged = confirm(sharedDescription);
            return sharedAcknowledged;
        }

        internal string[] InstallationArguments()
        {
            if (sharedDescription != null && !sharedAcknowledged)
                throw new InvalidOperationException("The reviewed shared preferences need separate confirmation.");
            var args = new List<string> { "installation", "run", port, "--expected-plan", Fingerprint, "--yes" };
            if (sharedAcknowledged) args.Add("--acknowledge-shared-preferences");
            return args.ToArray();
        }

        private static string SharedScope(object plan)
        {
            var shared = Json.OptionalObjectField(plan, "shared_preferences");
            if (shared == null) return null;
            var binding = Json.Field(shared, "binding");
            if (RequiredText(binding, "contract") != "regaiden041-windows")
                throw new InvalidOperationException("Unsupported managed shared preferences contract.");
            Digest(binding, "account_sid_sha256");
            var sharedPath = RequiredText(binding, "path");
            var fallback = RequiredText(shared, "local_fallback_path");
            PublicCli.RequireAbsolute(sharedPath);
            PublicCli.RequireAbsolute(fallback);
            Json.Boolean(shared, "shared_present");
            Json.Boolean(shared, "local_fallback_present");
            return "This game can rewrite shared preferences at " + sharedPath +
                ", discard unknown entries and affect other copies in this Windows account. Portcove never owns, moves, backs up, restores or deletes that shared file. If unavailable, the game can instead use " + fallback +
                ". That local fallback is part of this installation's managed saves and settings.";
        }

        private static string RequiredText(object value, string field)
        {
            var text = Json.Text(value, field);
            if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("Incomplete installation review: " + field);
            return text;
        }

        private static string ChannelLabel(string channel) =>
            channel == "beta" ? "Preview" : channel == "stable" ? "Stable" : channel == "rolling" ? "Rolling" : "Unknown channel";

        private static string Digest(object value, string field)
        {
            var text = RequiredText(value, field);
            if (text.Length != 64 || text.Any(c => !Uri.IsHexDigit(c)))
                throw new InvalidOperationException("Invalid installation identity: " + field);
            return text;
        }

        internal static InstallationReview Read(object value, string port, string library)
        {
            var plan = Json.Field(value, "plan");
            if (RequiredText(plan, "port_id") != port || RequiredText(plan, "platform") != "windows-x86-64")
                throw new InvalidOperationException("Installation review targets another game or platform.");
            var action = RequiredText(plan, "action");
            if (!new[] { "download", "use_staged", "reuse_retained" }.Contains(action))
                throw new InvalidOperationException("Refresh installation readiness before continuing: " + action);
            var output = Json.Field(plan, "output_location");
            if (RequiredText(output, "port_id") != port || RequiredText(output, "library_root") != library)
                throw new InvalidOperationException("Installation review targets another library or game.");
            var destination = RequiredText(output, "effective_output_directory");
            var saves = RequiredText(output, "user_data_root");
            PublicCli.RequireAbsolute(destination);
            PublicCli.RequireAbsolute(saves);
            var release = Json.Field(plan, "release");
            var channel = RequiredText(plan, "channel");
            if (!new[] { "stable", "beta", "rolling" }.Contains(channel) || RequiredText(release, "channel") != channel)
                throw new InvalidOperationException("Installation review has an inconsistent channel.");
            var asset = Json.Field(release, "asset");
            var bytes = Json.Number(plan, "download_bytes");
            if (bytes < 0 || Json.Number(asset, "size") < 0 || bytes < Json.Number(asset, "size"))
                throw new InvalidOperationException("Installation review has an invalid download size.");
            var sources = new List<string>();
            var profiles = new HashSet<string>(StringComparer.Ordinal);
            foreach (var source in Json.Array(Json.Field(plan, "source_requirements")))
            {
                var profile = RequiredText(source, "profile_id");
                if (!profiles.Add(profile) || !new[] { "game_source", "bios" }.Contains(RequiredText(source, "role")))
                    throw new InvalidOperationException("Installation review has inconsistent original-file requirements.");
                sources.Add(RequiredText(source, "label") +
                    (Json.Boolean(source, "registered") ? " (registered)" : " (not registered; core checks whether required)"));
            }
            var runtime = Json.Field(plan, "bundled_runtime");
            var runtimeDescription = "";
            if (runtime != null)
            {
                var runtimeAsset = Json.Field(runtime, "asset");
                runtimeDescription = "\nBundled runtime: " + RequiredText(runtimeAsset, "name") +
                    "\nRuntime SHA-256: " + Digest(runtimeAsset, "sha256");
            }
            var selected = Json.OptionalObjectField(value, "selected_install");
            var destinationDescription = "Managed versions folder: " + destination;
            var downloadDescription = "Download size: " + bytes + " bytes";
            if (action == "download")
            {
                if (selected != null) throw new InvalidOperationException("Download review unexpectedly selects an existing installation.");
            }
            else
            {
                if (selected == null || RequiredText(selected, "port_id") != port ||
                    !Json.Boolean(selected, "verified") ||
                    !string.Equals(Digest(Json.Field(selected, "artifact"), "sha256"), Digest(asset, "sha256"), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Installation review has no matching verified retained copy.");
                RequiredText(selected, "id");
                var actualDestination = RequiredText(selected, "path");
                PublicCli.RequireAbsolute(actualDestination);
                var storedChannel = RequiredText(selected, "channel");
                if (!new[] { "stable", "beta", "rolling" }.Contains(storedChannel))
                    throw new InvalidOperationException("Existing copy has an unsupported channel.");
                destinationDescription = "Existing copy to activate: " + actualDestination +
                    "\nExisting copy version: " + RequiredText(selected, "version") + "\nExisting copy channel: " + ChannelLabel(storedChannel);
                downloadDescription = "No artifact download; use the verified existing copy (" + action.Replace('_', ' ') + ")";
            }
            return new InstallationReview
            {
                port = port,
                sharedDescription = SharedScope(plan),
                Fingerprint = Digest(value, "plan_sha256"),
                Description = "Install and activate this reviewed release? Portcove rechecks these inputs before applying it. Changed inputs require another review.\n\n" +
                    "Requested release version: " + RequiredText(release, "version") + "\nRequested channel: " + ChannelLabel(channel) +
                    "\nArtifact: " + RequiredText(asset, "name") + "\nSHA-256: " + Digest(asset, "sha256") +
                    runtimeDescription + "\n" + downloadDescription +
                    "\n" + destinationDescription + "\nSaved data: " + saves +
                    "\nOriginal inputs: " + (sources.Count == 0 ? "none required" : string.Join(", ", sources)) +
                    PreservationNotices(plan) +
                    "\n\nOriginal files remain in place. Free space, source bytes and destination safety are checked at execution. Cancellation may retain private work for recovery."
            };
        }

        internal static string PreservationNotices(object plan)
        {
            object value;
            if (!Json.TryField(plan, "preservation_notices", out value)) return "";
            return string.Concat(Json.Array(value).Select(item =>
            {
                var text = item as string;
                if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("Invalid preservation notice.");
                return "\n" + text;
            }));
        }
    }
}
