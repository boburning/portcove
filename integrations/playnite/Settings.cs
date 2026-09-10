using Playnite.SDK;
using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;

namespace Portcove.ReferenceClient
{
    public sealed class ClientSettings
    {
        public string Executable { get; set; } = "";
        public string LibraryRoot { get; set; } = "";
        // A reconnect pointer only. Core's retained record is the sole outcome authority.
        public string LastLaunchGame { get; set; } = "";
        public string LastLaunchRequest { get; set; } = "";
    }

    public sealed class SettingsModel : ObservableObject, ISettings
    {
        private readonly PortcovePlugin plugin;
        private ClientSettings saved;
        private ClientSettings settings;
        public ClientSettings Settings
        {
            get => settings;
            set { settings = value; OnPropertyChanged(); }
        }
        internal SettingsModel(PortcovePlugin plugin)
        {
            this.plugin = plugin;
            Settings = plugin.LoadPluginSettings<ClientSettings>() ?? new ClientSettings();
        }
        public void BeginEdit() => saved = new ClientSettings
        {
            Executable = Settings.Executable, LibraryRoot = Settings.LibraryRoot,
            LastLaunchGame = Settings.LastLaunchGame, LastLaunchRequest = Settings.LastLaunchRequest
        };
        public void CancelEdit() => Settings = saved;
        public void EndEdit() => plugin.SavePluginSettings(Settings);
        internal void RememberLaunch(string game, string request)
        {
            Settings.LastLaunchGame = game; Settings.LastLaunchRequest = request;
            if (saved != null) { saved.LastLaunchGame = game; saved.LastLaunchRequest = request; }
            plugin.SavePluginSettings(Settings);
        }
        public bool VerifySettings(out List<string> errors)
        {
            errors = new List<string>();
            try { new PublicCli(Settings.Executable, Settings.LibraryRoot); }
            catch (Exception error) { errors.Add(error.Message); }
            return errors.Count == 0;
        }
        internal static UserControl View()
        {
            var panel = new StackPanel { Margin = new Thickness(12) };
            panel.Children.Add(new TextBlock
            {
                Text = "Select a verified standalone Portcove CLI and the library to use. Connecting may initialize an empty library. The extension runs this executable with your account's permissions.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12)
            });
            AddPath(panel, "Portcove CLI (.exe)", "Executable");
            AddPath(panel, "Portcove library folder", "LibraryRoot");
            return new UserControl { Content = panel };
        }
        private static void AddPath(Panel panel, string label, string property)
        {
            panel.Children.Add(new TextBlock { Text = label });
            var text = new TextBox { Margin = new Thickness(0, 4, 0, 12), MinWidth = 350 };
            text.SetBinding(TextBox.TextProperty, new Binding("Settings." + property) { UpdateSourceTrigger = UpdateSourceTrigger.PropertyChanged });
            panel.Children.Add(text);
        }
    }
}
