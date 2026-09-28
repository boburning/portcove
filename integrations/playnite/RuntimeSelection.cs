using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.Security.Cryptography;

namespace Portcove.ReferenceClient
{
    public sealed class ClientSettings
    {
        public string Executable { get; set; } = "";
        public string LibraryRoot { get; set; } = "";
        public bool CreateNewLibrary { get; set; }
        public string ApprovedExecutable { get; set; } = "";
        public string ApprovedLibraryRoot { get; set; } = "";
        public string ExecutableSha256 { get; set; } = "";
        public string LibraryId { get; set; } = "";
        public List<string> SelectedPortIds { get; set; } = new List<string>();
        // A reconnect pointer only. Core's retained record is the sole outcome authority.
        public string LastLaunchGame { get; set; } = "";
        public string LastLaunchRequest { get; set; } = "";
    }

    internal sealed class RuntimeInspection
    {
        internal string Executable { get; set; }
        internal string LibraryRoot { get; set; }
        internal string Sha256 { get; set; }
        internal bool CreateNewLibrary { get; set; }

        internal bool Matches(RuntimeInspection other) => other != null &&
            string.Equals(Executable, other.Executable, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(LibraryRoot, other.LibraryRoot, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(Sha256, other.Sha256, StringComparison.OrdinalIgnoreCase) &&
            CreateNewLibrary == other.CreateNewLibrary;
    }

    internal static class RuntimeSelection
    {
        private const long MaximumExecutableBytes = 512L * 1024 * 1024;

        internal static RuntimeInspection Inspect(ClientSettings draft)
        {
            PublicCli.RequireAbsolute(draft.Executable);
            PublicCli.RequireAbsolute(draft.LibraryRoot);
            var executable = Path.GetFullPath(draft.Executable);
            var libraryRoot = Path.GetFullPath(draft.LibraryRoot);
            if (!string.Equals(Path.GetFileName(executable), "portcove.exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Choose portcove.exe from a trusted standalone Windows CLI package.");
            var sha256 = HashExecutable(executable);
            var database = Path.Combine(libraryRoot, "portcove.sqlite3");
            if (draft.CreateNewLibrary)
            {
                if (File.Exists(database))
                    throw new InvalidOperationException("This folder already contains a Portcove library. Clear the new-library choice to reuse it.");
                if (Directory.Exists(libraryRoot) && Directory.EnumerateFileSystemEntries(libraryRoot).Any())
                    throw new InvalidOperationException("Choose an empty folder for a new Portcove library. Existing files will not be adopted silently.");
            }
            else if (!File.Exists(database))
                throw new InvalidOperationException("Choose an existing Portcove library folder, or explicitly select Create a new library.");
            return new RuntimeInspection
            {
                Executable = executable, LibraryRoot = libraryRoot, Sha256 = sha256,
                CreateNewLibrary = draft.CreateNewLibrary
            };
        }

        internal static string HashExecutable(string executable)
        {
            var file = new FileInfo(executable);
            if (!file.Exists || (file.Attributes & FileAttributes.ReparsePoint) != 0 ||
                file.Length == 0 || file.Length > MaximumExecutableBytes)
                throw new InvalidOperationException("The selected CLI must be a regular, nonempty portcove.exe under 512 MiB.");
            using (var stream = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        internal static void RequireAccepted(ClientSettings accepted)
        {
            if (accepted.CreateNewLibrary)
                throw new InvalidOperationException("Inspect and connect the new library before saving or using it.");
            if (string.IsNullOrEmpty(accepted.ApprovedExecutable) ||
                string.IsNullOrEmpty(accepted.ApprovedLibraryRoot) ||
                string.IsNullOrEmpty(accepted.ExecutableSha256) ||
                string.IsNullOrEmpty(accepted.LibraryId))
                throw new InvalidOperationException("Inspect and connect a selected Portcove CLI and library in extension settings first.");
            var current = Inspect(new ClientSettings
            {
                Executable = accepted.Executable, LibraryRoot = accepted.LibraryRoot
            });
            if (!string.Equals(current.Executable, accepted.ApprovedExecutable, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(current.LibraryRoot, accepted.ApprovedLibraryRoot, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(current.Sha256, accepted.ExecutableSha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The selected CLI or library changed. Inspect and connect it again before use.");
        }
    }
}
