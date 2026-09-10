using Playnite.SDK;
using Playnite.SDK.Models;
using Playnite.SDK.Plugins;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Portcove.ReferenceClient
{
    public sealed class PortcovePlugin : LibraryPlugin
    {
        private readonly SettingsModel settings;
        public override Guid Id { get; } = Guid.Parse("7e856602-b63b-46db-8231-74e4610e4971");
        public override string Name => "Portcove";
        public PortcovePlugin(IPlayniteAPI api) : base(api)
        {
            settings = new SettingsModel(this);
            Properties = new LibraryPluginProperties { HasSettings = true };
        }
        public override ISettings GetSettings(bool firstRunSettings) => settings;
        public override UserControl GetSettingsView(bool firstRunSettings) => SettingsModel.View();

        internal async Task<PublicCli> Connect()
        {
            var accepted = settings.Active;
            var client = new PublicCli(accepted.Executable, accepted.LibraryRoot);
            await client.Connect().ConfigureAwait(false);
            return client;
        }

        internal void Error(Exception error) => PlayniteApi.MainView.UIDispatcher.Invoke(() =>
            PlayniteApi.Dialogs.ShowErrorMessage(error.Message, "Portcove"));
        internal void OnUi(Action action) => PlayniteApi.MainView.UIDispatcher.Invoke(action);

        internal void RememberLaunch(string game, string request) => PlayniteApi.MainView.UIDispatcher.Invoke(() => settings.RememberLaunch(game, request));
        internal string RecentLaunch(string game) => PlayniteApi.MainView.UIDispatcher.Invoke(() =>
            settings.Active.LastLaunchGame == game ? settings.Active.LastLaunchRequest : null);

        public override IEnumerable<GameMetadata> GetGames(LibraryGetGamesArgs args) => Discover().GetAwaiter().GetResult();

        private async Task<IEnumerable<GameMetadata>> Discover()
        {
            var cli = await Connect().ConfigureAwait(false);
            var catalog = Json.Array(await cli.Read("catalog.list", "catalog", "list").ConfigureAwait(false));
            var statuses = Json.Array(await cli.Read("status", "status").ConfigureAwait(false))
                .ToDictionary(status => Json.Text(status, "port_id"), StringComparer.Ordinal);
            await cli.AssertIdentity().ConfigureAwait(false);
            var result = new List<GameMetadata>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var port in catalog)
            {
                if (!Json.Array(Json.Field(port, "platforms")).Contains("windows-x86-64")) continue;
                var portId = Json.Text(port, "id");
                var key = Identity.Game(cli.LibraryId, portId);
                if (!seen.Add(key)) throw new InvalidOperationException("The catalog repeats a port identity. Refresh after repairing the catalog.");
                object status;
                if (!statuses.TryGetValue(portId, out status)) throw new InvalidOperationException("The catalog changed during discovery. Refresh again.");
                var active = Json.Field(status, "active");
                result.Add(new GameMetadata
                {
                    GameId = key, Name = Json.Text(port, "name"),
                    Description = System.Net.WebUtility.HtmlEncode(Json.Text(port, "summary")),
                    IsInstalled = active != null,
                    InstallDirectory = active == null ? null : Json.Text(active, "path"),
                    Version = active == null ? null : Json.Text(active, "version")
                });
            }
            return result;
        }

        public override IEnumerable<PlayController> GetPlayActions(GetPlayActionsArgs args)
        {
            if (args.Game.PluginId == Id) yield return new SupervisedPlay(this, args.Game);
        }
        public override IEnumerable<InstallController> GetInstallActions(GetInstallActionsArgs args)
        {
            if (args.Game.PluginId == Id) yield return new ManagedInstall(this, args.Game);
        }
        public override IEnumerable<GameMenuItem> GetGameMenuItems(GetGameMenuItemsArgs args)
        {
            if (args.Games.Count != 1 || args.Games[0].PluginId != Id) yield break;
            yield return new GameMenuItem
            {
                MenuSection = "Portcove", Description = "Manage and review activity…",
                Action = action => ShowManagement(action.Games.Single())
            };
        }
        internal object ShowManagement(Game game)
        {
            return PlayniteApi.MainView.UIDispatcher.Invoke(() =>
            {
                var window = new ManagementWindow(this, game, PlayniteApi.Dialogs.CreateWindow(new WindowCreationOptions
                {
                    ShowMinimizeButton = false, ShowMaximizeButton = true, ShowCloseButton = true
                }));
                window.ShowDialog();
                return window.CurrentStatus;
            });
        }
    }

    internal sealed class ManagedInstall : InstallController
    {
        private readonly PortcovePlugin plugin;
        internal ManagedInstall(PortcovePlugin plugin, Game game) : base(game) { this.plugin = plugin; Name = "Set up with Portcove"; }
        public override void Install(InstallActionArgs args)
        {
            try
            {
                var status = plugin.ShowManagement(Game);
                var active = status == null ? null : Json.Field(status, "active");
                if (active != null) InvokeOnInstalled(new GameInstalledEventArgs
                {
                    InstalledInfo = new GameInstallationData { InstallDirectory = Json.Text(active, "path") }
                });
                else InvokeOnInstallationCancelled(new GameInstallationCancelledEventArgs());
            }
            catch (Exception error) { plugin.Error(error); InvokeOnInstallationCancelled(new GameInstallationCancelledEventArgs()); }
        }
    }

    internal sealed class SupervisedPlay : PlayController
    {
        private readonly PortcovePlugin plugin;
        internal SupervisedPlay(PortcovePlugin plugin, Game game) : base(game) { this.plugin = plugin; Name = "Play through Portcove"; }
        public override void Play(PlayActionArgs args)
        {
            // Playnite's controller call reports prelaunch failures synchronously; actual tracking is asynchronous.
            var cli = plugin.Connect().GetAwaiter().GetResult();
            var port = Identity.Port(Game.GameId, cli.LibraryId);
            var status = cli.Read("status", "status", port).GetAwaiter().GetResult();
            var readiness = Json.Field(status, "readiness");
            if (readiness == null || !Json.Boolean(readiness, "launchable"))
                throw new InvalidOperationException("Portcove reports that setup is required. Open Manage and review activity for its current reasons.");
            var request = Guid.NewGuid().ToString("D");
            plugin.RememberLaunch(Game.GameId, request);
            var launch = cli.Launch(port, request).GetAwaiter().GetResult();
            Track(cli, port, request, launch);
        }

        private async void Track(PublicCli cli, string port, string request, RawLaunch launch)
        {
            var started = false;
            var observedStart = DateTime.UtcNow;
            try
            {
                using (launch)
                {
                    while (true)
                    {
                        // If exit happens after this snapshot, read once more on the next poll.
                        // The durable terminal write precedes an already-observed wrapper exit.
                        var exitedBeforeRead = launch.HasExited;
                        var record = await cli.Read("launch.show", "launch", "show", request).ConfigureAwait(false);
                        var observation = LaunchObservation.Read(record, request, port, launch.ProcessId);
                        if (observation != null)
                        {
                            if (!started && observation.ChildPid.HasValue)
                            {
                                observedStart = DateTime.UtcNow;
                                plugin.OnUi(() => InvokeOnStarted(new GameStartedEventArgs { StartedProcessId = observation.ChildPid.Value }));
                                started = true;
                            }
                            if (observation.Outcome != null)
                            {
                                if (observation.Outcome != "succeeded")
                                    throw new InvalidOperationException("Portcove launch " + observation.Outcome + ". Review activity for recovery and save-collection details.");
                                break;
                            }
                        }
                        if (exitedBeforeRead)
                            throw new InvalidOperationException("The CLI exited without an observed terminal launch outcome. Review activity and refresh; do not launch again automatically.");
                        await Task.Delay(750).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception error) { plugin.Error(error); }
            finally
            {
                // Stopped ends Playnite tracking, not a successful-game or successful-save assertion.
                plugin.OnUi(() => InvokeOnStopped(new GameStoppedEventArgs(started ? (ulong)Math.Max(0, (DateTime.UtcNow - observedStart).TotalSeconds) : 0)));
            }
        }
    }
}
