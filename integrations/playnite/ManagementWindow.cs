using Playnite.SDK.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Portcove.ReferenceClient
{
    internal sealed class ManagementWindow
    {
        private readonly PortcovePlugin plugin;
        private readonly Game game;
        private readonly Window window;
        private readonly TextBlock state = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 8) };
        private readonly TextBlock progress = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 8) };
        private readonly TextBox source = new TextBox();
        private readonly TextBox bios = new TextBox();
        private readonly TextBox technical = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 220 };
        private readonly List<Button> actions = new List<Button>();
        private readonly Button cancel = new Button { Content = "Request cancellation", IsEnabled = false, Margin = new Thickness(4), Padding = new Thickness(10, 6, 10, 6) };
        private PublicCli cli;
        private string port;
        private string operationId;
        private bool busy;
        private bool cancellationRequested;
        private bool detached;
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
            AddPath(panel, "Original game file or folder", source);
            AddPath(panel, "BIOS file (when required)", bios);
            var buttons = new WrapPanel();
            panel.Children.Add(buttons);
            AddAction(buttons, "Refresh readiness and activity", Refresh);
            AddAction(buttons, "Register supplied files", RegisterSources);
            AddAction(buttons, "Install / use existing", () => Manage("ensure"));
            AddAction(buttons, "Check and update", () => Manage("update"));
            AddAction(buttons, "Review preparation", Prepare);
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

        private static void AddPath(Panel panel, string label, TextBox field)
        {
            panel.Children.Add(new TextBlock { Text = label });
            field.Margin = new Thickness(0, 4, 0, 10);
            panel.Children.Add(field);
        }

        private void AddAction(Panel panel, string label, Func<Task> action)
        {
            var button = new Button { Content = label, Margin = new Thickness(4), Padding = new Thickness(10, 6, 10, 6) };
            button.Click += async (sender, args) => await Execute(action);
            actions.Add(button);
            panel.Children.Add(button);
        }

        private async Task Execute(Func<Task> action)
        {
            if (busy) return;
            busy = true; operationId = null; cancellationRequested = false;
            actions.ForEach(button => button.IsEnabled = false);
            source.IsEnabled = bios.IsEnabled = false;
            try { await action(); }
            catch (Exception error) { progress.Text = error.Message; CurrentStatus = null; }
            finally
            {
                busy = false; cancel.IsEnabled = false;
                source.IsEnabled = bios.IsEnabled = true;
                actions.ForEach(button => button.IsEnabled = cli != null && port != null);
            }
        }

        private async Task Refresh()
        {
            if (detached) return;
            await cli.AssertIdentity();
            CurrentStatus = null;
            var status = await cli.Read("status", "status", port);
            var activity = Json.Array(await cli.Read("activity", "activity", "--limit", "200"));
            var catalog = await cli.Read("catalog.show", "catalog", "show", port);
            await cli.AssertIdentity();
            if (detached) return;
            var active = Json.Field(status, "active");
            var readiness = Json.Field(status, "readiness");
            var blockers = readiness == null ? "Readiness unknown" : string.Join(", ", Json.Array(Json.Field(readiness, "blockers")).Select(value => Convert.ToString(value).Replace('_', ' ')));
            var definitionOperations = DefinitionOperations.Summary(status);
            state.Text = (active == null ? "Not installed." : "Installed: " + Json.Text(active, "version") + ".") + "\n" +
                (readiness != null && Json.Boolean(readiness, "launchable") ? "Portcove reports this game is ready to launch." : "Setup: " + blockers + ".") +
                "\nSource profile: " + (Json.Field(catalog, "source_profile") ?? "none") +
                "\nBIOS profile: " + (Json.Field(catalog, "bios_source_profile") ?? "none") +
                "\nCatalog support: " + Json.Text(catalog, "support_tier") + ". Gameplay evidence is separate from launch readiness." +
                (definitionOperations == null ? "" : "\n" + definitionOperations);
            var entries = activity.Where(item => (Json.Field(item, "target_id") as string) == port).Take(8).ToArray();
            progress.Text = entries.Length == 0 ? "No retained activity for this game in the latest 200 library entries." :
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
            for (var index = 0; index < paths.Length; index++)
                if (paths[index].Length != 0) await cli.Manage("source.add", new[] { "source", "add", profiles[index], paths[index] }, OnProgress);
            await Refresh();
        }

        private async Task Manage(string command)
        {
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
