using Playnite.SDK.Models;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Portcove.ReferenceClient
{
    internal sealed class PortcoveCatalogGame
    {
        internal string PortId { get; set; }
        internal string Name { get; set; }
        internal string Summary { get; set; }
        internal object Installation { get; set; }
        internal string LibraryId { get; set; }
        internal string GameId => Identity.Game(LibraryId, PortId);
        internal bool IsInstalled => Installation != null;

        internal bool MatchesSearch(string query) => string.IsNullOrEmpty(query) ||
            CultureInfo.CurrentCulture.CompareInfo.IndexOf(Name, query, CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace) >= 0 ||
            PortId.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0;

        internal GameMetadata Metadata() => new GameMetadata
        {
            GameId = GameId,
            Name = Name,
            Description = System.Net.WebUtility.HtmlEncode(Summary),
            IsInstalled = IsInstalled,
            InstallDirectory = IsInstalled ? Json.Text(Installation, "path") : null,
            Version = IsInstalled ? Json.Text(Installation, "version") : null
        };
    }

    internal static class PersonalLibrary
    {
        internal static IReadOnlyList<PortcoveCatalogGame> Read(object[] catalog, object[] statuses, string libraryId)
        {
            var statusByPort = statuses.ToDictionary(status => Json.Text(status, "port_id"), StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<PortcoveCatalogGame>();
            foreach (var port in catalog)
            {
                if (!Json.Array(Json.Field(port, "platforms")).Contains("windows-x86-64")) continue;
                var portId = Json.Text(port, "id");
                if (!seen.Add(portId)) throw new InvalidOperationException("The catalog repeats a port identity. Refresh after repairing the catalog.");
                object status;
                if (!statusByPort.TryGetValue(portId, out status))
                    throw new InvalidOperationException("The catalog changed during discovery. Refresh again.");
                result.Add(new PortcoveCatalogGame
                {
                    PortId = portId,
                    Name = DisplayName(port),
                    Summary = Json.Text(port, "summary"),
                    Installation = StatusInstallation.Current(status),
                    LibraryId = libraryId
                });
            }
            return result;
        }

        // Presentation changes never replace the library/port identity or merge
        // independent implementations. Include the project to disambiguate them.
        private static string DisplayName(object port)
        {
            var project = Json.Text(port, "name");
            object presentation;
            if (!Json.TryField(port, "presentation", out presentation) || presentation == null) return project;
            var title = DisplayText(presentation, "original_game_title") ?? project;
            var variant = DisplayText(presentation, "variant_label");
            var label = title == project ? title : title + " (" + project + ")";
            return variant == null ? label : label + " · " + variant;
        }

        private static string DisplayText(object presentation, string key)
        {
            object value;
            if (!Json.TryField(presentation, key, out value) || value == null) return null;
            var text = value as string;
            if (string.IsNullOrWhiteSpace(text) || text.Trim() != text || text.Any(char.IsControl))
                throw new InvalidOperationException("Portcove catalog presentation contains invalid " + key + ". Refresh the catalog.");
            return text;
        }

        internal static IReadOnlyList<PortcoveCatalogGame> Default(
            IReadOnlyList<PortcoveCatalogGame> catalog, IEnumerable<string> selectedPortIds)
        {
            var selected = new HashSet<string>(selectedPortIds ?? Enumerable.Empty<string>(), StringComparer.Ordinal);
            return catalog.Where(game => game.IsInstalled || selected.Contains(game.PortId)).ToArray();
        }

        internal static IReadOnlyList<Game> PriorVisibleEntries(
            IEnumerable<Game> playniteGames, Guid pluginId, IReadOnlyList<PortcoveCatalogGame> current)
        {
            var currentIds = new HashSet<string>(current.Select(game => game.GameId), StringComparer.Ordinal);
            return playniteGames.Where(game => game.PluginId == pluginId && !game.Hidden &&
                !currentIds.Contains(game.GameId)).ToArray();
        }
    }
}
