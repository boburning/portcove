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
        public override UserControl GetSettingsView(bool firstRunSettings) => settings.View();

        internal string SelectExecutable() => PlayniteApi.Dialogs.SelectFile("Portcove CLI|portcove.exe|Applications|*.exe");
        internal string SelectLibrary() => PlayniteApi.Dialogs.SelectFolder();

        internal Task<PublicCli> Connect() => Connect(settings.Active);

        private async Task<PublicCli> Connect(ClientSettings accepted)
        {
            RuntimeSelection.RequireAccepted(accepted);
            var client = new PublicCli(accepted.Executable, accepted.LibraryRoot);
            await client.Connect().ConfigureAwait(false);
            RuntimeSelection.RequireAccepted(accepted);
            if (!RuntimeSelection.SameConnection(settings.Active, accepted))
                throw new InvalidOperationException("The Portcove runtime or library selection changed. Refresh again.");
            if (!string.Equals(client.LibraryId, accepted.LibraryId, StringComparison.Ordinal))
                throw new InvalidOperationException("The selected library identity changed. Reconnect it in extension settings.");
            return client;
        }

        internal void Error(Exception error) => PlayniteApi.MainView.UIDispatcher.Invoke(() =>
            PlayniteApi.Dialogs.ShowErrorMessage(error.Message, "Portcove"));
        internal void OnUi(Action action) => PlayniteApi.MainView.UIDispatcher.Invoke(action);
        internal bool ConfirmRemoval(string message) => PlayniteApi.MainView.UIDispatcher.Invoke(() =>
            MessageBox.Show(message, "Review Portcove game removal", MessageBoxButton.OKCancel,
                MessageBoxImage.Warning) == MessageBoxResult.OK);

        internal void RememberLaunch(string game, string request) => PlayniteApi.MainView.UIDispatcher.Invoke(() => settings.RememberLaunch(game, request));
        internal string RecentLaunch(string game) => PlayniteApi.MainView.UIDispatcher.Invoke(() =>
            settings.Active.LastLaunchGame == game ? settings.Active.LastLaunchRequest : null);

        public override IEnumerable<GameMetadata> GetGames(LibraryGetGamesArgs args)
        {
            // Playnite refreshes a newly installed extension before first-use settings can be saved.
            if (string.IsNullOrEmpty(settings.Active.LibraryId)) return Array.Empty<GameMetadata>();
            return Discover().GetAwaiter().GetResult();
        }

        private async Task<IEnumerable<GameMetadata>> Discover()
        {
            var accepted = settings.Active;
            var selected = (accepted.SelectedPortIds ?? new List<string>()).ToArray();
            var catalog = await ReadCatalog(accepted).ConfigureAwait(false);
            if (!RuntimeSelection.SameConnection(settings.Active, accepted))
                throw new InvalidOperationException("The Portcove library selection changed during refresh. Refresh again.");
            return PersonalLibrary.Default(catalog, selected).Select(game => game.Metadata()).ToArray();
        }

        private async Task<IReadOnlyList<PortcoveCatalogGame>> ReadCatalog(ClientSettings accepted)
        {
            var cli = await Connect(accepted).ConfigureAwait(false);
            var catalog = Json.Array(await cli.Read("catalog.list", "catalog", "list").ConfigureAwait(false));
            var statuses = Json.Array(await cli.Read("status", "status").ConfigureAwait(false));
            await cli.AssertIdentity().ConfigureAwait(false);
            if (!RuntimeSelection.SameConnection(settings.Active, accepted))
                throw new InvalidOperationException("The Portcove library selection changed during discovery. Refresh again.");
            return PersonalLibrary.Read(catalog, statuses, cli.LibraryId);
        }

        public override IEnumerable<MainMenuItem> GetMainMenuItems(GetMainMenuItemsArgs args)
        {
            yield return new MainMenuItem
            {
                MenuSection = "Portcove",
                Description = "Browse and add compatible games…",
                Action = action => AddGames()
            };
            yield return new MainMenuItem
            {
                MenuSection = "Portcove",
                Description = "Review prior library entries…",
                Action = action => ReviewPriorEntries()
            };
        }

        private async void AddGames()
        {
            try
            {
                var accepted = settings.Active;
                if (string.IsNullOrEmpty(accepted.LibraryId))
                    throw new InvalidOperationException("Connect a Portcove CLI and library in extension settings before adding games.");
                var catalog = await ReadCatalog(accepted);
                var chosen = CatalogBrowser.Choose(PlayniteApi, catalog, accepted.SelectedPortIds);
                if (chosen.Count == 0) return;
                if (!RuntimeSelection.SameConnection(settings.Active, accepted))
                    throw new InvalidOperationException("The Portcove library changed while choosing games. Refresh the catalog and choose again.");
                foreach (var game in chosen)
                {
                    if (!PlayniteApi.Database.Games.Any(existing => existing.PluginId == Id && existing.GameId == game.GameId))
                        PlayniteApi.Database.ImportGame(game.Metadata(), this);
                    settings.RememberSelection(new[] { game.PortId }, game.LibraryId);
                }
            }
            catch (Exception error) { Error(error); }
        }

        private async void ReviewPriorEntries()
        {
            try
            {
                var accepted = settings.Active;
                var catalog = await ReadCatalog(accepted);
                var current = PersonalLibrary.Default(catalog, accepted.SelectedPortIds);
                var candidates = PersonalLibrary.PriorVisibleEntries(PlayniteApi.Database.Games, Id, current);
                var chosen = LegacyEntriesWindow.Choose(PlayniteApi, candidates);
                if (chosen.Count == 0) return;
                var latest = await ReadCatalog(accepted);
                var stillCurrent = new HashSet<string>(PersonalLibrary.Default(latest, settings.Active.SelectedPortIds)
                    .Select(game => game.GameId), StringComparer.Ordinal);
                foreach (var game in chosen)
                {
                    var live = PlayniteApi.Database.Games.Get(game.Id);
                    if (live == null || live.PluginId != Id || live.GameId != game.GameId ||
                        live.Hidden || stillCurrent.Contains(live.GameId)) continue;
                    live.Hidden = true;
                    PlayniteApi.Database.Games.Update(live);
                }
            }
            catch (Exception error) { Error(error); }
        }

        public override IEnumerable<PlayController> GetPlayActions(GetPlayActionsArgs args)
        {
            if (args.Game.PluginId == Id) yield return new SupervisedPlay(this, args.Game);
        }
        public override IEnumerable<InstallController> GetInstallActions(GetInstallActionsArgs args)
        {
            if (args.Game.PluginId == Id) yield return new ManagedInstall(this, args.Game);
        }
        public override IEnumerable<UninstallController> GetUninstallActions(GetUninstallActionsArgs args)
        {
            if (args.Game.PluginId == Id) yield return new ManagedUninstall(this, args.Game);
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
                var installed = StatusInstallation.Current(status);
                if (installed != null) InvokeOnInstalled(new GameInstalledEventArgs
                {
                    InstalledInfo = new GameInstallationData { InstallDirectory = Json.Text(installed, "path") }
                });
                else InvokeOnInstallationCancelled(new GameInstallationCancelledEventArgs());
            }
            catch (Exception error) { plugin.Error(error); InvokeOnInstallationCancelled(new GameInstallationCancelledEventArgs()); }
        }
    }

    internal sealed class ManagedUninstall : UninstallController
    {
        private readonly PortcovePlugin plugin;
        internal ManagedUninstall(PortcovePlugin plugin, Game game) : base(game)
        {
            this.plugin = plugin;
            Name = "Remove managed Portcove versions";
        }

        public override void Uninstall(UninstallActionArgs args)
        {
            try
            {
                var cli = plugin.Connect().GetAwaiter().GetResult();
                if (cli.ApiSchemaVersion < 56)
                    throw new InvalidOperationException("Reviewed managed removal needs Portcove CLI API schema 56 or newer. Update the selected CLI; external installations are not owned by this action.");
                var port = Identity.Port(Game.GameId, cli.LibraryId);
                var preview = ManagedRemovalReview.Read(
                    cli.Read("remove.preview", "remove-preview", port).GetAwaiter().GetResult(), port);
                if (!plugin.ConfirmRemoval(preview.Confirmation(Game.Name, cli.LibraryRoot))) return;
                var result = cli.Manage("remove", new[]
                {
                    "remove", port, "--expected-preview", preview.PreviewSha256, "--yes"
                }, null).GetAwaiter().GetResult();
                preview.RequireApplied(result);
                var status = cli.Read("status", "status", port).GetAwaiter().GetResult();
                if (Json.Field(status, "active") != null)
                    throw new InvalidOperationException("Portcove still reports an active managed version. Refresh activity before deciding whether removal completed.");
                InvokeOnUninstalled();
            }
            catch (Exception error) { plugin.Error(error); }
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
            DefinitionOperations.RequireEligible(status, "launch");
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
                    await LaunchObserver.Observe(cli, launch, port, request, childPid =>
                    {
                        observedStart = DateTime.UtcNow;
                        plugin.OnUi(() => InvokeOnStarted(new GameStartedEventArgs { StartedProcessId = childPid }));
                        started = true;
                    }).ConfigureAwait(false);
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
