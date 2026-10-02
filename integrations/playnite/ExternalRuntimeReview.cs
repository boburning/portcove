using System;
using System.IO;
using System.Linq;

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

        private static bool SamePath(string left, string right) =>
            string.Equals(System.IO.Path.GetFullPath(left).TrimEnd('\\', '/'),
                System.IO.Path.GetFullPath(right).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);

        internal static ExternalRuntimeReview Read(object value, string port, string selectedPath, bool removal = false)
        {
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
                if (!review.executable.StartsWith(path.TrimEnd('\\', '/') + System.IO.Path.DirectorySeparatorChar,
                    StringComparison.OrdinalIgnoreCase) || Json.Number(value, "immutable_file_count") <= 0)
                    throw new InvalidOperationException("External-runtime review has an inconsistent executable or inventory.");
                review.archive = Digest(value, "archive_sha256");
                review.tree = Digest(value, "immutable_tree_sha256");
                review.Description = "Use this accepted runtime in place? Portcove rechecks the reviewed identity before registering it.\n\n" +
                    "Executable: " + review.executable + "\nAccepted package SHA-256: " + review.archive +
                    "\nChecked extracted-tree SHA-256: " + review.tree +
                    "\nChecked immutable files: " + Json.Number(value, "immutable_file_count") + "\n";
            }
            review.Description += "Folder: " + path + "\nVersion: " + review.version +
                "\n\nPortcove does not copy, update, back up or delete these external files. Game-owned saves and settings remain in this folder and are outside managed save protection. Original game files remain in place. Registration does not guarantee launch readiness or gameplay compatibility.";
            return review;
        }

        internal string RequireRegistered(object record)
        {
            if (removal || Text(record, "port_id") != port || !SamePath(Text(record, "path"), Path) ||
                !SamePath(Text(record, "executable"), executable) || Text(record, "version") != version ||
                !string.Equals(Digest(record, "archive_sha256"), archive, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Digest(record, "immutable_tree_sha256"), tree, StringComparison.OrdinalIgnoreCase) ||
                Text(record, "platform") != "windows-x86-64")
                throw new InvalidOperationException("Portcove did not confirm the reviewed external runtime. Refresh before retrying.");
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
