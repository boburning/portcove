using Playnite.SDK;
using Playnite.SDK.Models;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;

namespace Portcove.ReferenceClient
{
    internal static class LegacyEntriesWindow
    {
        private sealed class Choice
        {
            internal Game Game { get; set; }
            public string Label => Game.Name + " — " + Game.GameId;
        }

        internal static IReadOnlyList<Game> Choose(IPlayniteAPI api, IReadOnlyList<Game> candidates)
        {
            if (candidates.Count == 0)
            {
                MessageBox.Show("No visible Portcove entries fall outside the currently installed and selected games.",
                    "Portcove library review", MessageBoxButton.OK, MessageBoxImage.Information);
                return Array.Empty<Game>();
            }
            var window = api.Dialogs.CreateWindow(new WindowCreationOptions
            {
                ShowMinimizeButton = false, ShowMaximizeButton = true, ShowCloseButton = true
            });
            window.SetResourceReference(Control.ForegroundProperty, "TextBrush");
            window.SetResourceReference(Control.FontFamilyProperty, "FontFamily");
            window.SetResourceReference(Control.FontSizeProperty, "FontSize");
            window.Title = "Review prior Portcove entries";
            window.Width = 720;
            window.Height = 560;
            var panel = new DockPanel { Margin = new Thickness(16) };
            var explanation = new TextBlock
            {
                Text = "These visible Playnite entries came from a previous broad import or another Portcove library. Select any you want to hide in Playnite. Their metadata stays in Playnite, and no Portcove game, original file, save, or installation is removed. You can show them again with Playnite's Hidden filter.",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 12)
            };
            DockPanel.SetDock(explanation, Dock.Top);
            panel.Children.Add(explanation);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var hide = new Button { Content = "Hide selected in Playnite", IsEnabled = false, Margin = new Thickness(0, 8, 8, 0), Padding = new Thickness(12, 6, 12, 6) };
            var cancel = new Button { Content = "Keep all", Margin = new Thickness(0, 8, 0, 0), Padding = new Thickness(12, 6, 12, 6) };
            buttons.Children.Add(hide);
            buttons.Children.Add(cancel);
            DockPanel.SetDock(buttons, Dock.Bottom);
            panel.Children.Add(buttons);
            var list = new ListBox { SelectionMode = SelectionMode.Multiple, DisplayMemberPath = "Label" };
            list.ItemsSource = candidates.Select(game => new Choice { Game = game })
                .OrderBy(choice => choice.Game.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
            list.SelectionChanged += (sender, args) => hide.IsEnabled = list.SelectedItems.Count > 0;
            panel.Children.Add(list);
            window.Content = panel;
            Choice[] result = null;
            hide.Click += (sender, args) =>
            {
                result = list.SelectedItems.Cast<Choice>().ToArray();
                window.DialogResult = true;
                window.Close();
            };
            cancel.Click += (sender, args) => { window.DialogResult = false; window.Close(); };
            window.ShowDialog();
            return result == null ? Array.Empty<Game>() : result.Select(choice => choice.Game).ToArray();
        }
    }
}
