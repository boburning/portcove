using Playnite.SDK.Models;
using System;
using System.Collections.Generic;
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
                    Name = Json.Text(port, "name"),
                    Summary = Json.Text(port, "summary"),
                    Installation = StatusInstallation.Current(status),
                    LibraryId = libraryId
                });
            }
            return result;
        }

        internal static IReadOnlyList<PortcoveCatalogGame> Default(
            IReadOnlyList<PortcoveCatalogGame> catalog, IEnumerable<string> selectedPortIds)
        {
            var selected = new HashSet<string>(selectedPortIds ?? Enumerable.Empty<string>(), StringComparer.Ordinal);
            return catalog.Where(game => game.IsInstalled || selected.Contains(game.PortId)).ToArray();
        }
    }
}
