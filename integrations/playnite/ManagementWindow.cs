using Playnite.SDK.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Portcove.ReferenceClient
{
    internal sealed class ManagementWindow
    {
        private readonly PortcovePlugin plugin;
        private readonly Game game;
        private readonly Window window;
        private readonly TextBlock state = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 8) };
        private readonly TextBlock progress = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 8) };
        private readonly TextBlock nextDetail = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(4, 2, 4, 10) };
        private readonly TextBox source = new TextBox();
        private readonly TextBox bios = new TextBox();
        private readonly TextBox technical = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 220 };
        private readonly List<Button> actions = new List<Button>();
        private readonly List<Button> pathButtons = new List<Button>();
        private readonly Button cancel = new Button { Content = "Request cancellation", IsEnabled = false, Margin = new Thickness(4), Padding = new Thickness(10, 6, 10, 6) };
        private Button cleanupAction;
        private Button installAction;
        private Button updateAction;
        private Button prepareAction;
        private Button primaryAction;
        private GuidedSetup nextStep;
        private object currentCatalog;
        private bool externalRoute;
        private PublicCli cli;
        private string port;
        private string operationId;
        private bool busy;
        private bool cancellationRequested;
        private bool detached;
        private bool retainedCleanupAvailable;
        private DateTime lastProgress;
        internal object CurrentStatus { get; private set; }

        internal void ShowDialog() => window.ShowDialog();

        internal ManagementWindow(PortcovePlugin plugin, Game game, Window window)
        {
            this.plugin = plugin;
            this.game = game;
            this.window = window;
            window.SetResourceReference(Control.ForegroundProperty, "TextBrush");
            window.SetResourceReference(Control.FontFamilyProperty, "FontFamily");
            window.SetResourceReference(Control.FontSizeProperty, "FontSize");
            window.Title = "Portcove · " + game.Name;
            window.Width = 740; window.Height = 710; window.MinWidth = 520; window.MinHeight = 480;
            window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            var panel = new StackPanel { Margin = new Thickness(20) };
            window.Content = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            panel.Children.Add(new TextBlock { Text = game.Name, FontSize = 24, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(state);
            panel.Children.Add(new TextBlock
            {
                Text = "Original game files stay yours. Supply a source or BIOS path only when needed; blank fields use Portcove's registered files. Portcove checks requirements and trusted downloads.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12)
            });
            AddPath(panel, "Original game file or folder", source, true);
            AddPath(panel, "BIOS file (when required)", bios, false);
            primaryAction = new Button { Content = "Checking next step…", Margin = new Thickness(4), Padding = new Thickness(16, 9, 16, 9), IsEnabled = false };
            primaryAction.Click += async (sender, args) => await RunPrimary();
            panel.Children.Add(primaryAction);
            panel.Children.Add(nextDetail);
            updateAction = AddAction(panel, "Check and update", () => Manage("update"));
            var buttons = new WrapPanel();
            AddAction(buttons, "Refresh readiness and activity", Refresh);
            AddAction(buttons, "Register supplied files", RegisterSources);
            installAction = AddAction(buttons, "Install / use existing", () => Manage("ensure"));
            prepareAction = AddAction(buttons, "Review preparation", Prepare);
            cleanupAction = AddAction(buttons, "Review retained cleanup", CleanupPreparation);
            cleanupAction.IsEnabled = false;
            panel.Children.Add(new Expander { Header = "Other Portcove actions", Content = buttons });
            source.TextChanged += (sender, args) => UpdatePrimary();
            bios.TextChanged += (sender, args) => UpdatePrimary();
            cancel.Click += async (sender, args) =>
            {
                cancel.IsEnabled = false;
                cancellationRequested = true;
                try
                {
                    if (operationId == null) return;
                    await cli.Manage("cancel", new[] { "cancel", operationId }, null);
                    progress.Text = "Cancellation requested. Waiting for Portcove's terminal result and retained activity.";
                }
                catch (Exception error) { progress.Text = error.Message; }
            };
            buttons.Children.Add(cancel);
            panel.Children.Add(progress);
            panel.Children.Add(new Expander { Header = "Technical response (local only)", Content = technical });
            panel.Children.Add(new TextBlock
            {
                Text = "Closing while idle makes no management request. During work, request cancellation and wait, or explicitly stop watching. Portcove may continue after disconnect; refresh its retained activity before retrying.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 0)
            });
            window.Loaded += async (sender, args) => await Execute(async () =>
            {
                cli = await plugin.Connect();
                port = Identity.Port(game.GameId, cli.LibraryId);
                await Refresh();
            });
            window.Closing += (sender, args) =>
            {
                if (busy && MessageBox.Show(window, "Stop watching this operation? Portcove may continue working. This does not cancel it or confirm success. Reopen management and refresh retained activity before deciding on another action.",
                    "Disconnect from operation", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) args.Cancel = true;
                else { detached = true; if (busy) CurrentStatus = null; }
            };
        }

        private void AddPath(Panel panel, string label, TextBox field, bool allowFolder)
        {
            panel.Children.Add(new TextBlock { Text = label });
            var row = new DockPanel { Margin = new Thickness(0, 4, 0, 10) };
            var browse = new Button { Content = "Choose file…", Margin = new Thickness(8, 0, 0, 0) };
            browse.Click += (sender, args) =>
            {
                var path = plugin.PlayniteApi.Dialogs.SelectFile("Game files|*.*");
                if (!string.IsNullOrWhiteSpace(path)) field.Text = path;
            };
            pathButtons.Add(browse);
            DockPanel.SetDock(browse, Dock.Right);
            row.Children.Add(browse);
            if (allowFolder)
            {
                var folder = new Button { Content = "Choose folder…", Margin = new Thickness(8, 0, 0, 0) };
                folder.Click += (sender, args) =>
                {
                    var path = plugin.PlayniteApi.Dialogs.SelectFolder();
                    if (!string.IsNullOrWhiteSpace(path)) field.Text = path;
                };
                pathButtons.Add(folder);
                DockPanel.SetDock(folder, Dock.Right);
                row.Children.Add(folder);
            }
            row.Children.Add(field);
            panel.Children.Add(row);
        }

        private Button AddAction(Panel panel, string label, Func<Task> action)
        {
            var button = new Button { Content = label, Margin = new Thickness(4), Padding = new Thickness(10, 6, 10, 6) };
            button.Click += async (sender, args) => await Execute(action);
            actions.Add(button);
            panel.Children.Add(button);
            return button;
        }

        private async Task Execute(Func<Task> action)
        {
            if (busy) return;
            busy = true; operationId = null; cancellationRequested = false;
            actions.ForEach(button => button.IsEnabled = false);
            pathButtons.ForEach(button => button.IsEnabled = false);
            source.IsEnabled = bios.IsEnabled = false;
            try { await action(); }
            catch (Exception error) { progress.Text = error.Message; CurrentStatus = null; }
            finally
            {
                busy = false; cancel.IsEnabled = false;
                source.IsEnabled = bios.IsEnabled = true;
                pathButtons.ForEach(button => button.IsEnabled = true);
                actions.ForEach(button => button.IsEnabled = cli != null && port != null);
                if (cleanupAction != null) cleanupAction.IsEnabled = cleanupAction.IsEnabled && retainedCleanupAvailable;
                if (externalRoute)
                {
                    installAction.IsEnabled = false;
                    updateAction.IsEnabled = false;
                    prepareAction.IsEnabled = false;
                }
                if (updateAction != null)
                    updateAction.IsEnabled = !externalRoute && CurrentStatus != null && Json.Field(CurrentStatus, "active") != null;
                UpdatePrimary();
            }
        }

        private void UpdatePrimary()
        {
            if (primaryAction == null || CurrentStatus == null || currentCatalog == null)
            {
                nextStep = null;
                if (primaryAction != null) primaryAction.IsEnabled = false;
                return;
            }
            try
            {
                nextStep = GuidedSetup.Choose(CurrentStatus, currentCatalog, source.Text.Trim(), bios.Text.Trim());
                primaryAction.Content = nextStep.Label;
                primaryAction.IsEnabled = !busy;
                nextDetail.Text = nextStep.Detail;
            }
            catch (Exception error)
            {
                nextStep = null;
                primaryAction.Content = "Review readiness";
                primaryAction.IsEnabled = false;
                nextDetail.Text = error.Message;
            }
        }

        private async Task RunPrimary()
        {
            if (busy || nextStep == null) return;
            switch (nextStep.Kind)
            {
                case GuidedStepKind.ChooseSource:
                    var selectedSource = plugin.PlayniteApi.Dialogs.SelectFile("Game files|*.*");
                    if (!string.IsNullOrWhiteSpace(selectedSource)) source.Text = selectedSource;
                    break;
                case GuidedStepKind.ChooseBios:
                    var selectedBios = plugin.PlayniteApi.Dialogs.SelectFile("BIOS files|*.*");
                    if (!string.IsNullOrWhiteSpace(selectedBios)) bios.Text = selectedBios;
                    break;
                case GuidedStepKind.ValidateSources:
                    await Execute(RegisterSources);
                    break;
                case GuidedStepKind.Install:
                    await Execute(() => Manage("ensure"));
                    break;
                case GuidedStepKind.FinishSetup:
                    await Execute(Prepare);
                    break;
                case GuidedStepKind.Play:
                    // Let a pending Playnite install controller publish its installed event
                    // after the dialog returns before requesting the ordinary play action.
                    window.Close();
                    if (detached)
                        _ = window.Dispatcher.BeginInvoke(new Action(() => { _ = StartReadyGame(); }), DispatcherPriority.ApplicationIdle);
                    break;
                default:
                    MessageBox.Show(window, nextStep.Detail + "\n\n" + state.Text,
                        "Portcove readiness", MessageBoxButton.OK, MessageBoxImage.Information);
                    break;
            }
        }

        private async Task StartReadyGame()
        {
            try
            {
                await cli.AssertIdentity();
                var fresh = await cli.Read("status", "status", port);
                await cli.AssertIdentity();
                if (Json.Text(fresh, "port_id") != port)
                    throw new InvalidOperationException("Portcove returned another game's status. Refresh before playing.");
                DefinitionOperations.RequireEligible(fresh, "launch");
                var readiness = Json.Field(fresh, "readiness");
                var launch = PortActions.Read(fresh).FirstOrDefault(value => value.Action == "launch");
                var installation = StatusInstallation.Current(fresh);
                if (installation == null || readiness == null || !Json.Boolean(readiness, "launchable") ||
                    (launch != null && launch.Availability != "allowed"))
                    throw new InvalidOperationException("Portcove no longer reports a playable installation. Refresh readiness before playing.");
                var installPath = Json.Text(installation, "path");
                // The modal is closed while the reads await. Check the currently accepted
                // connection after the final await, before changing Playnite metadata.
                var current = await plugin.Connect();
                if (current.LibraryId != cli.LibraryId ||
                    !string.Equals(current.LibraryRoot, cli.LibraryRoot, StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(current.Executable, cli.Executable, StringComparison.OrdinalIgnoreCase) ||
                    Identity.Port(game.GameId, current.LibraryId) != port)
                    throw new InvalidOperationException("The selected Portcove runtime or library changed. Refresh before playing.");
                var live = plugin.PlayniteApi.Database.Games.Get(game.Id);
                if (live == null || live.PluginId != plugin.Id || live.GameId != game.GameId)
                    throw new InvalidOperationException("The selected Playnite game changed. Refresh the library before playing.");
                // A game-menu management session has no pending InstallController event.
                // Sync only the installed flag and directory that core already reported.
                if (!live.IsInstalled)
                {
                    if (live.OverrideInstallState)
                        throw new InvalidOperationException("Playnite marks this game uninstalled by your manual override. Remove that override before playing.");
                    live.IsInstalled = true;
                    live.InstallDirectory = installPath;
                    plugin.PlayniteApi.Database.Games.Update(live);
                }
                plugin.PlayniteApi.StartGame(game.Id);
            }
            catch (Exception error) { plugin.Error(error); }
        }

        private async Task Refresh()
        {
            if (detached) return;
            await cli.AssertIdentity();
            CurrentStatus = null;
            retainedCleanupAvailable = false;
            var status = await cli.Read("status", "status", port);
            var activityFeed = await cli.ReadActivity(200);
            var activity = activityFeed.Records;
            var catalog = await cli.Read("catalog.show", "catalog", "show", port);
            var repairs = RetainedPreparationRepair.Read(await cli.Read("doctor", "doctor"), port);
            await cli.AssertIdentity();
            if (detached) return;
            retainedCleanupAvailable = repairs.Length != 0;
            var active = Json.Field(status, "active");
            var external = Json.OptionalObjectField(status, "external_runtime");
            externalRoute = external != null || Json.Text(Json.Field(catalog, "release"), "provider") == "user-prepared";
            var readiness = Json.Field(status, "readiness");
            var blockers = readiness == null ? "Readiness unknown" : string.Join(", ", Json.Array(Json.Field(readiness, "blockers")).Select(value => Convert.ToString(value).Replace('_', ' ')));
            var definitionOperations = DefinitionOperations.Summary(status);
            var portActions = PortActions.Summary(status);
            state.Text = (active != null ? "Installed: " + Json.Text(active, "version") + "." :
                external != null ? "External runtime registered: " + Json.Text(external, "version") + ". Portcove does not own its files." :
                externalRoute ? "User-prepared runtime not registered. Register it in Portcove Desktop or CLI before launching from Playnite." : "Not installed.") + "\n" +
                (readiness != null && Json.Boolean(readiness, "launchable") ? "Portcove reports this game is ready to launch." : "Setup: " + blockers + ".") +
                "\nSource profile: " + (Json.Field(catalog, "source_profile") ?? "none") +
                "\nBIOS profile: " + (Json.Field(catalog, "bios_source_profile") ?? "none") +
                "\nCatalog support: " + Json.Text(catalog, "support_tier") + ". Gameplay evidence is separate from launch readiness." +
                "\nRetained private preparations: " + repairs.Length + "." +
                (definitionOperations == null ? "" : "\n" + definitionOperations) +
                (portActions == null ? "" : "\n" + portActions);
            var entries = activityFeed.VisibleRecords(
                item => (Json.Field(item, "target_id") as string) == port,
                8);
            progress.Text = entries.Length == 0 ?
                (activityFeed.TerminalHistoryComplete ? "No retained activity for this game." :
                    activityFeed.ActiveAndActionableComplete ? "No activity for this game appears in the available history. In-progress tasks and items needing attention remain covered by this feed." :
                    "No retained activity for this game in the bounded legacy window; older current or actionable work may be absent.") :
                string.Join("\n", entries.Select(item => Json.Text(item, "operation").Replace('_', ' ') + ": " + Json.Text(item, "status") +
                    (Json.Field(item, "message") == null ? "" : " — " + Json.Field(item, "message"))));
            technical.Text = Json.Print(new { status, activity = entries, catalog });
            var request = plugin.RecentLaunch(game.GameId);
            if (!string.IsNullOrEmpty(request))
            {
                Guid parsed;
                if (!Guid.TryParseExact(request, "D", out parsed)) throw new InvalidOperationException("The saved launch pointer is malformed. No request was replayed.");
                var launch = await cli.Read("launch.show", "launch", "show", request);
                if (launch != null && (Json.Text(launch, "id") != request || Json.Text(launch, "port_id") != port))
                    throw new InvalidOperationException("The retained launch identity does not match this game.");
                progress.Text += "\nLast launch: " + (launch == null ? "absent or expired; outcome unknown" :
                    Json.Text(launch, "phase") + ", " + (Json.Field(launch, "outcome") ?? "unresolved")) + ".";
            }
            CurrentStatus = status;
            currentCatalog = catalog;
            UpdatePrimary();
        }

        private async Task RegisterSources()
        {
            var catalog = await cli.Read("catalog.show", "catalog", "show", port);
            var paths = new[] { source.Text.Trim(), bios.Text.Trim() };
            var profiles = new[] { Json.Field(catalog, "source_profile") as string, Json.Field(catalog, "bios_source_profile") as string };
            if (paths.All(string.IsNullOrEmpty)) throw new InvalidOperationException("Enter at least one original file or folder path first.");
            for (var index = 0; index < paths.Length; index++)
            {
                if (paths[index].Length == 0) continue;
                PublicCli.RequireAbsolute(paths[index]);
                if (profiles[index] == null) throw new InvalidOperationException("The catalog does not request that source input.");
            }
            if (MessageBox.Show(window, "Register these original paths under this game's catalog profiles? Portcove validates their identity. Original files stay in place. Each registration is separate; a later failure does not undo an earlier registration.\n\n" +
                string.Join("\n", paths.Where(path => path.Length != 0)), "Register original files", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            CurrentStatus = null;
            var selectedCount = paths.Count(path => path.Length != 0);
            for (var index = 0; index < paths.Length; index++)
                if (paths[index].Length != 0) await cli.Manage("source.add", new[] { "source", "add", profiles[index], paths[index] }, OnProgress);
            await Refresh();
            source.Clear(); bios.Clear();
            progress.Text = "Portcove validated and registered " + selectedCount +
                " selected original input(s). Current readiness is shown above.\n" + progress.Text;
        }

        private async Task Manage(string command)
        {
            if (externalRoute) throw new InvalidOperationException("This user-prepared runtime is registered and removed through Portcove Desktop or CLI; Playnite cannot install or update its external files.");
            var status = await cli.Read("status", "status", port);
            DefinitionOperations.RequireEligible(status, "install");
            var sourcePath = source.Text.Trim();
            var biosPath = bios.Text.Trim();
            if (sourcePath.Length != 0) PublicCli.RequireAbsolute(sourcePath);
            if (biosPath.Length != 0) PublicCli.RequireAbsolute(biosPath);
            var args = new List<string> { command, port };
            if (sourcePath.Length != 0) args.AddRange(new[] { "--source", sourcePath });
            if (biosPath.Length != 0) args.AddRange(new[] { "--bios", biosPath });
            var prompt = command == "ensure"
                ? "Use the current installation if present, or download, verify and activate the selected channel's release? This may register the supplied source files."
                : "Check the selected channel now, then download, verify and activate its eligible update? The release is resolved when you continue. Supplied source files may be registered.";
            if (MessageBox.Show(window, prompt + "\n\nLibrary: " + cli.LibraryRoot + "\nGame: " + game.Name,
                "Portcove", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            CurrentStatus = null;
            await cli.Manage(command, args.ToArray(), OnProgress);
            await Refresh();
        }

        private async Task Prepare()
        {
            if (externalRoute) throw new InvalidOperationException("Portcove does not prepare this player-owned external runtime. Use Portcove Desktop or CLI to register the accepted folder.");
            var status = await cli.Read("status", "status", port);
            DefinitionOperations.RequireEligible(status, "prepare");
            var plan = await cli.Read("preparation.plan", "preparation", "plan", port);
            technical.Text = Json.Print(plan);
            var inputs = Json.Field(plan, "inputs");
            var install = Json.Field(inputs, "install");
            var sourceRecord = Json.Field(inputs, "source");
            var tool = Json.Field(inputs, "setup_tool");
            var conversion = Json.Field(inputs, "conversion_tool");
            var message = "Prepare a private installation from the reviewed artifact and registered source? Portcove checks this exact plan before applying it. Original files and the existing version remain. Cancellation may retain private work for recovery.\n\nInstallation: " + Json.Text(install, "path") +
                "\nVersion: " + Json.Text(install, "version") + "\nSource: " + Json.Text(sourceRecord, "path") +
                "\nSetup tool: " + Json.Text(tool, "path") + "\nSetup SHA-256: " + Json.Text(tool, "sha256") +
                (conversion == null ? "" : "\nConversion tool: " + Json.Text(conversion, "path") + "\nConversion SHA-256: " + Json.Text(conversion, "sha256")) +
                "\nCopy bytes: " + Json.Field(Json.Field(plan, "copy"), "total_bytes") +
                "\nMode: " + Json.Text(Json.Field(inputs, "options"), "mode") + "\nTarget: " + Json.Text(Json.Field(inputs, "options"), "target");
            if (MessageBox.Show(window, message, "Review preparation", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
            CurrentStatus = null;
            await cli.Manage("preparation.run", new[] { "preparation", "run", port, "--expected-plan", Json.Text(plan, "plan_sha256"), "--yes" }, OnProgress);
            await Refresh();
        }

        private async Task CleanupPreparation()
        {
            var doctor = await cli.Read("doctor", "doctor");
            var repairs = RetainedPreparationRepair.Read(doctor, port);
            retainedCleanupAvailable = repairs.Length != 0;
            if (repairs.Length == 0)
                throw new InvalidOperationException("Portcove reports no retained private preparation for this game. Refresh activity before deciding what to do.");
            var repair = repairs[0];
            var rawPreview = await cli.Read(
                "preparation.cleanup-plan", "preparation", "cleanup-plan", repair.OperationId);
            var preview = PreparationCleanupReview.Read(rawPreview, repair.OperationId, port);
            if (preview.RetainedPath != repair.Path)
                throw new InvalidOperationException("The cleanup preview path changed from the current repair plan. Refresh before changing retained data.");
            technical.Text = Json.Print(rawPreview);
            if (MessageBox.Show(window, preview.Confirmation(1, repairs.Length), "Review retained preparation cleanup",
                MessageBoxButton.OKCancel, MessageBoxImage.Warning) != MessageBoxResult.OK) return;
            CurrentStatus = null;
            var applied = await cli.Manage("preparation.cleanup", new[]
            {
                "preparation", "cleanup", repair.OperationId,
                "--expected-preview", preview.PreviewSha256, "--yes"
            }, OnProgress);
            PreparationCleanupReview.ReadApplied(applied, preview);
            await Refresh();
        }

        private void OnProgress(Dictionary<string, object> record)
        {
            if (detached) return;
            var root = Json.Field(record, "parent_operation_id") == null;
            var now = DateTime.UtcNow;
            var firstRoot = root && operationId != Json.Text(record, "operation_id");
            if (!firstRoot && now - lastProgress < TimeSpan.FromMilliseconds(200)) return;
            lastProgress = now;
            window.Dispatcher.Invoke(() =>
            {
                if (root) { operationId = Json.Text(record, "operation_id"); cancel.IsEnabled = !cancellationRequested; }
                progress.Text = Json.Text(record, "operation").Replace('_', ' ') + ": " + Json.Text(record, "type").Replace('_', ' ');
            });
        }
    }
}
