using Playnite.SDK;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;

namespace Portcove.ReferenceClient
{
    public sealed class SettingsModel : ObservableObject, ISettings
    {
        private readonly PortcovePlugin plugin;
        private RuntimeInspection inspection;
        private string validationStatus = "Choose a CLI and library, inspect the CLI bytes, then explicitly connect.";
        public string ValidationStatus
        {
            get => validationStatus;
            private set { validationStatus = value; OnPropertyChanged(); }
        }
        internal ClientSettings Active { get; private set; }
        private ClientSettings settings;
        public ClientSettings Settings
        {
            get => settings;
            set { settings = value; OnPropertyChanged(); }
        }
        internal SettingsModel(PortcovePlugin plugin)
        {
            this.plugin = plugin;
            Active = plugin.LoadPluginSettings<ClientSettings>() ?? new ClientSettings();
            Settings = Copy(Active);
        }
        private static ClientSettings Copy(ClientSettings value) => new ClientSettings
        {
            Executable = value.Executable, LibraryRoot = value.LibraryRoot,
            CreateNewLibrary = value.CreateNewLibrary,
            ApprovedExecutable = value.ApprovedExecutable, ApprovedLibraryRoot = value.ApprovedLibraryRoot,
            ExecutableSha256 = value.ExecutableSha256, LibraryId = value.LibraryId,
            SelectedPortIds = new List<string>(value.SelectedPortIds ?? new List<string>()),
            LastLaunchGame = value.LastLaunchGame, LastLaunchRequest = value.LastLaunchRequest
        };
        public void BeginEdit() { inspection = null; Settings = Copy(Active); }
        public void CancelEdit() { inspection = null; Settings = Copy(Active); }
        public void EndEdit()
        {
            RuntimeSelection.RequireAccepted(Settings);
            var accepted = Copy(Settings);
            plugin.SavePluginSettings(accepted);
            Active = accepted;
        }
        internal void RememberLaunch(string game, string request)
        {
            Settings.LastLaunchGame = game; Settings.LastLaunchRequest = request;
            var remembered = Copy(Active);
            remembered.LastLaunchGame = game; remembered.LastLaunchRequest = request;
            plugin.SavePluginSettings(remembered);
            Active = remembered;
        }
        internal void RememberSelection(IEnumerable<string> portIds, string libraryId)
        {
            if (!string.Equals(Active.LibraryId, libraryId, StringComparison.Ordinal))
                throw new InvalidOperationException("The selected library changed. Reconnect it before adding games.");
            var next = Copy(Active);
            next.SelectedPortIds = next.SelectedPortIds.Concat(portIds).Distinct(StringComparer.Ordinal).ToList();
            plugin.SavePluginSettings(next);
            Active = next;
            Settings = Copy(next);
        }
        public bool VerifySettings(out List<string> errors)
        {
            errors = new List<string>();
            try { RuntimeSelection.RequireAccepted(Settings); }
            catch (Exception error) { errors.Add(error.Message); }
            return errors.Count == 0;
        }
        internal UserControl View()
        {
            var panel = new StackPanel { Margin = new Thickness(12) };
            panel.Children.Add(new TextBlock
            {
                Text = "Choose portcove.exe from a trusted standalone Windows CLI package and the exact library to use. Inspect its SHA-256 before authorizing Playnite to run it. Compatibility checking executes the selected program with your account's permissions.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12)
            });
            AddPath(panel, "Portcove CLI (.exe)", "Executable", () => plugin.SelectExecutable());
            AddPath(panel, "Portcove library folder", "LibraryRoot", () => plugin.SelectLibrary());
            var create = new CheckBox
            {
                Content = "Create a separate library in this empty folder",
                Margin = new Thickness(0, 0, 0, 12)
            };
            create.SetBinding(CheckBox.IsCheckedProperty, new Binding("Settings.CreateNewLibrary")
            {
                UpdateSourceTrigger = UpdateSourceTrigger.PropertyChanged
            });
            panel.Children.Add(create);
            var buttons = new WrapPanel();
            var inspect = new Button { Content = "Inspect selected CLI", Margin = new Thickness(0, 0, 8, 8) };
            inspect.Click += (sender, args) =>
            {
                try
                {
                    inspection = RuntimeSelection.Inspect(Settings);
                    ValidationStatus = "Selected CLI SHA-256: " + inspection.Sha256 + "\nLibrary: " +
                        inspection.LibraryRoot + (inspection.CreateNewLibrary ? " (new library, created only after Connect)" : " (existing library)") +
                        "\nConfirm this is the CLI package you intended before connecting.";
                }
                catch (Exception error) { inspection = null; ValidationStatus = error.Message; }
            };
            buttons.Children.Add(inspect);
            var connect = new Button { Content = "Connect this runtime", Margin = new Thickness(0, 0, 0, 8) };
            connect.Click += async (sender, args) =>
            {
                connect.IsEnabled = false;
                try { await ConnectSelection(); }
                catch (Exception error) { ValidationStatus = error.Message; }
                finally { connect.IsEnabled = true; }
            };
            buttons.Children.Add(connect);
            panel.Children.Add(buttons);
            var status = new TextBlock { TextWrapping = TextWrapping.Wrap };
            status.SetBinding(TextBlock.TextProperty, new Binding("ValidationStatus"));
            panel.Children.Add(status);
            return new UserControl { Content = panel, DataContext = this };
        }
        private async System.Threading.Tasks.Task ConnectSelection()
        {
            var current = RuntimeSelection.Inspect(Settings);
            if (inspection == null || !inspection.Matches(current))
                throw new InvalidOperationException("The selected file or library changed. Inspect it again before connecting.");
            var client = new PublicCli(current.Executable, current.LibraryRoot);
            await client.Connect();
            if (!string.Equals(RuntimeSelection.HashExecutable(current.Executable), current.Sha256, StringComparison.OrdinalIgnoreCase) ||
                !File.Exists(Path.Combine(current.LibraryRoot, "portcove.sqlite3")) ||
                !string.Equals(Path.GetFullPath(Settings.Executable), current.Executable, StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Path.GetFullPath(Settings.LibraryRoot), current.LibraryRoot, StringComparison.OrdinalIgnoreCase) ||
                Settings.CreateNewLibrary != current.CreateNewLibrary)
                throw new InvalidOperationException("The selected runtime or library changed during connection. Inspect again; no success is assumed.");
            var accepted = Copy(Settings);
            accepted.Executable = accepted.ApprovedExecutable = current.Executable;
            accepted.LibraryRoot = accepted.ApprovedLibraryRoot = current.LibraryRoot;
            accepted.ExecutableSha256 = current.Sha256;
            if (!string.Equals(accepted.LibraryId, client.LibraryId, StringComparison.Ordinal))
                accepted.SelectedPortIds = new List<string>();
            accepted.LibraryId = client.LibraryId;
            accepted.CreateNewLibrary = false;
            Settings = accepted;
            inspection = null;
            ValidationStatus = "Compatible Portcove CLI connected. Library identity: " + client.LibraryId +
                ". Save these settings to use this exact runtime and library.";
        }
        private void AddPath(Panel panel, string label, string property, Func<string> browse)
        {
            panel.Children.Add(new TextBlock { Text = label });
            var row = new DockPanel { Margin = new Thickness(0, 4, 0, 12) };
            var button = new Button { Content = "Browse…", Margin = new Thickness(8, 0, 0, 0) };
            button.Click += (sender, args) =>
            {
                var path = browse();
                if (string.IsNullOrWhiteSpace(path)) return;
                var draft = Copy(Settings);
                if (property == "Executable") draft.Executable = path;
                else draft.LibraryRoot = path;
                Settings = draft;
                inspection = null;
                ValidationStatus = "Selection changed. Inspect the selected CLI before connecting.";
            };
            DockPanel.SetDock(button, Dock.Right);
            row.Children.Add(button);
            var text = new TextBox { MinWidth = 280 };
            text.SetBinding(TextBox.TextProperty, new Binding("Settings." + property) { UpdateSourceTrigger = UpdateSourceTrigger.PropertyChanged });
            row.Children.Add(text);
            panel.Children.Add(row);
        }
    }
}
