using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;

namespace Portcove.ReferenceClient
{
    // Checked presentation of core's accepted-runtime identity; not admission policy.
    internal sealed class ExternalRuntimeReview
    {
        internal string Fingerprint { get; private set; }
        internal string Description { get; private set; }
        internal string Path { get; private set; }
        private string port;
        private string version;
        private string executable;
        private string archive;
        private string tree;
        private bool removal;
        private string sharedContract;
        private string sharedAccount;
        private string sharedPath;
        private string sharedDescription;
        private bool sharedAcknowledged;

        internal bool ConfirmSharedScope(Func<string, bool> confirm)
        {
            if (sharedDescription == null) return true;
            sharedAcknowledged = confirm(sharedDescription);
            return sharedAcknowledged;
        }

        internal string[] RegistrationArguments()
        {
            if (removal || (sharedDescription != null && !sharedAcknowledged))
                throw new InvalidOperationException("The reviewed shared write scope needs separate confirmation.");
            var args = new List<string> { "external", "register", port, Path, "--expected-preview", Fingerprint, "--yes" };
            if (sharedAcknowledged) args.Add("--acknowledge-shared-preferences");
            return args.ToArray();
        }

        private void ReadSharedScope(object value)
        {
            var shared = Json.OptionalObjectField(value, "shared_preferences");
            if (shared == null) return;
            var binding = Json.Field(shared, "binding");
            sharedContract = Text(binding, "contract");
            sharedAccount = Digest(binding, "account_sid_sha256");
            sharedPath = Text(binding, "path");
            PublicCli.RequireAbsolute(sharedPath);
            Json.Boolean(shared, "present");
            var fallbackPresent = Json.Boolean(shared, "local_fallback_present");
            object fallback;
            Json.TryField(shared, "local_fallback_path", out fallback);
            if (sharedContract == "regaiden041-windows" && fallback is string && !string.IsNullOrWhiteSpace((string)fallback))
            {
                PublicCli.RequireAbsolute((string)fallback);
                sharedDescription = "This game can rewrite shared preferences at " + sharedPath +
                    ", discard unknown entries and affect other runtime copies in this Windows account. If unavailable, it can instead rewrite " + fallback +
                    ". Portcove does not own, migrate, back up, restore or delete these files.";
            }
            else if (sharedContract == "smb1r-1.1-stable-windows" && fallback == null && !fallbackPresent)
                sharedDescription = "This game uses the shared directory " + sharedPath +
                    " for original game files, settings, saves and custom data. Other copies use the same data. The game can regenerate or trash generated caches and prune its logs. This route accepts only vanilla BaseAssets; custom levels and autosaves, blueprints, custom characters and extra resource packs require manual relocation before use. Portcove refuses these inputs without changing them. Portcove does not seed, own, migrate, back up, restore or delete this directory or its files.";
            else throw new InvalidOperationException("Unsupported or inconsistent shared write scope review.");
        }

        private string registrationId;

        internal static ExternalRuntimeReview ReadRelink(object value, string port, string selectedPath)
        {
            if (Text(value, "port_id") != port || !Json.Boolean(value, "external_files_will_be_preserved"))
                throw new InvalidOperationException("Folder change does not preserve the selected registration and external files.");
            var previous = Text(value, "previous_path");
            PublicCli.RequireAbsolute(previous);
            var proposed = Json.Field(value, "proposed");
            object shared;
            if (Json.TryField(proposed, "shared_preferences", out shared) && shared != null)
                throw new InvalidOperationException("This runtime requires shared-preferences acknowledgment. Change its folder in Portcove Desktop or use the reviewed CLI flow with explicit acknowledgment.");
            var review = Read(proposed, port, selectedPath);
            review.registrationId = Text(value, "registration_id");
            review.Fingerprint = Digest(value, "preview_sha256");
            review.Description = "Change the registered game folder? Previous folder: " + previous +
                "\nIts files stay where they are. The registration and retained version stay the same.\n\n" + review.Description;
            return review;
        }

        private static string Text(object value, string field)
        {
            var text = Json.Text(value, field);
            if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("Incomplete external-runtime review: " + field);
            return text;
        }

        private static string Digest(object value, string field)
        {
            var digest = Text(value, field);
            if (digest.Length != 64 || digest.Any(c => !Uri.IsHexDigit(c)))
                throw new InvalidOperationException("Invalid external-runtime identity: " + field);
            return digest;
        }

        private static string ComparablePath(string path)
        {
            path = path.Replace('/', '\\');
            if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path.Substring(8);
            else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
            PublicCli.RequireAbsolute(path);
            return System.IO.Path.GetFullPath(path).TrimEnd('\\');
        }

        private static bool SamePath(string left, string right) =>
            string.Equals(ComparablePath(left), ComparablePath(right), StringComparison.OrdinalIgnoreCase);

        internal static ExternalRuntimeReview Read(object value, string port, string selectedPath, bool removal = false)
        {
            object userSelected;
            if (!removal && Json.TryField(value, "user_selected", out userSelected) && userSelected != null)
                throw new InvalidOperationException("User-selected executable registration requires Portcove Desktop or the CLI external select flow. This client cannot treat selected bytes as an accepted official package.");
            var path = Text(value, "path");
            PublicCli.RequireAbsolute(path);
            if (Text(value, "port_id") != port || (selectedPath != null && !SamePath(path, selectedPath)))
                throw new InvalidOperationException("External-runtime review targets another game or folder.");
            var review = new ExternalRuntimeReview
            {
                port = port, Path = path, version = Text(value, "version"),
                Fingerprint = Digest(value, "preview_sha256"), removal = removal
            };
            if (removal)
            {
                if (!Json.Boolean(value, "external_files_will_be_preserved"))
                    throw new InvalidOperationException("External-runtime removal does not promise file preservation.");
                review.Description = "Stop using this registered runtime? Only Portcove's registration is removed.\n\n";
            }
            else
            {
                review.executable = Text(value, "executable");
                PublicCli.RequireAbsolute(review.executable);
                if (!ComparablePath(review.executable).StartsWith(ComparablePath(path) + System.IO.Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase) || Json.Number(value, "immutable_file_count") <= 0)
                    throw new InvalidOperationException("External-runtime review has an inconsistent executable or inventory.");
                review.archive = Digest(value, "archive_sha256");
                review.tree = Digest(value, "immutable_tree_sha256");
                review.ReadSharedScope(value);
                review.Description = "Use this accepted runtime in place? Portcove rechecks the reviewed identity before registering it.\n\n" +
                    "Executable: " + review.executable + "\nAccepted package SHA-256: " + review.archive +
                    "\nChecked extracted-tree SHA-256: " + review.tree +
                    "\nChecked immutable files: " + Json.Number(value, "immutable_file_count") + "\n";
            }
            review.Description += "Folder: " + path + "\nVersion: " + review.version +
                "\n\nPortcove does not copy, update, back up or delete these external files. Game-owned files in this external folder remain outside managed save protection. Save location and protection follow the retained runtime contract; library-owned save locations keep their existing protection. Original game files remain in place. Registration does not guarantee launch readiness or gameplay compatibility.";
            return review;
        }

        internal string RequireRegistered(object record)
        {
            if (registrationId != null && Text(record, "id") != registrationId)
                throw new InvalidOperationException("Folder change replaced the registration identity. Refresh before retrying.");
            if (removal || Text(record, "port_id") != port || !SamePath(Text(record, "path"), Path) ||
                !SamePath(Text(record, "executable"), executable) || Text(record, "version") != version ||
                !string.Equals(Digest(record, "archive_sha256"), archive, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Digest(record, "immutable_tree_sha256"), tree, StringComparison.OrdinalIgnoreCase) ||
                Text(record, "platform") != "windows-x86-64")
                throw new InvalidOperationException("Portcove did not confirm the reviewed external runtime. Refresh before retrying.");
            var shared = Json.OptionalObjectField(record, "shared_preferences");
            if (sharedContract == null ? shared != null : shared == null ||
                Text(shared, "contract") != sharedContract || Digest(shared, "account_sid_sha256") != sharedAccount ||
                !SamePath(Text(shared, "path"), sharedPath))
                throw new InvalidOperationException("Portcove did not confirm the reviewed shared write location and account.");
            return Text(record, "id");
        }

        internal void RequireRemoved(object record)
        {
            if (!removal || Text(record, "port_id") != port || !SamePath(Text(record, "path"), Path) ||
                Text(record, "version") != version)
                throw new InvalidOperationException("Portcove did not confirm removal of the reviewed registration. Refresh before retrying.");
            Text(record, "id");
        }
    }
}
