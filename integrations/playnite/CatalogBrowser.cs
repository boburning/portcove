using Playnite.SDK;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows;
using System.Windows.Controls;

namespace Portcove.ReferenceClient
{
    internal sealed class CatalogBrowser
    {
        private sealed class Choice
        {
            internal PortcoveCatalogGame Game { get; set; }
            public string Label => Game.Name + " — " + Game.PortId + (Game.IsInstalled ? " (installed)" : "");
        }

        internal static IReadOnlyList<PortcoveCatalogGame> Choose(
            IPlayniteAPI api, IReadOnlyList<PortcoveCatalogGame> catalog, IEnumerable<string> alreadySelected)
        {
            var selected = new HashSet<string>(alreadySelected ?? Enumerable.Empty<string>(), StringComparer.Ordinal);
            var choices = catalog.Where(game => !game.IsInstalled && !selected.Contains(game.PortId))
                .Select(game => new Choice { Game = game }).OrderBy(choice => choice.Game.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
            if (choices.Length == 0) return Array.Empty<PortcoveCatalogGame>();

            var window = api.Dialogs.CreateWindow(new WindowCreationOptions
            {
                ShowMinimizeButton = false, ShowMaximizeButton = true, ShowCloseButton = true
            });
            window.SetResourceReference(Control.ForegroundProperty, "TextBrush");
            window.SetResourceReference(Control.FontFamilyProperty, "FontFamily");
            window.SetResourceReference(Control.FontSizeProperty, "FontSize");
            window.Title = "Add Portcove games";
            window.Width = 650;
            window.Height = 570;
            var panel = new DockPanel { Margin = new Thickness(16) };
            var heading = new TextBlock
            {
                Text = "Choose compatible catalog entries to add to this Playnite library. Adding an entry does not install it or claim ownership of original game files.",
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 12)
            };
            DockPanel.SetDock(heading, Dock.Top);
            panel.Children.Add(heading);
            var searchLabel = new TextBlock { Text = "Search by title or port ID" };
            DockPanel.SetDock(searchLabel, Dock.Top);
            panel.Children.Add(searchLabel);
            var search = new TextBox { Margin = new Thickness(0, 0, 0, 12) };
            DockPanel.SetDock(search, Dock.Top);
            panel.Children.Add(search);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            var add = new Button { Content = "Add selected", IsEnabled = false, Margin = new Thickness(0, 8, 8, 0), Padding = new Thickness(12, 6, 12, 6) };
            var cancel = new Button { Content = "Cancel", Margin = new Thickness(0, 8, 0, 0), Padding = new Thickness(12, 6, 12, 6) };
            buttons.Children.Add(add);
            buttons.Children.Add(cancel);
            DockPanel.SetDock(buttons, Dock.Bottom);
            panel.Children.Add(buttons);
            var list = new ListBox { SelectionMode = SelectionMode.Multiple, DisplayMemberPath = "Label" };
            list.ItemsSource = choices;
            list.SelectionChanged += (sender, args) => add.IsEnabled = list.SelectedItems.Count > 0;
            search.TextChanged += (sender, args) =>
            {
                var query = search.Text.Trim();
                list.ItemsSource = choices.Where(choice => query.Length == 0 ||
                    choice.Game.Name.IndexOf(query, StringComparison.CurrentCultureIgnoreCase) >= 0 ||
                    choice.Game.PortId.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0).ToArray();
            };
            panel.Children.Add(list);
            window.Content = panel;
            Choice[] result = null;
            add.Click += (sender, args) =>
            {
                result = list.SelectedItems.Cast<Choice>().ToArray();
                window.DialogResult = true;
                window.Close();
            };
            cancel.Click += (sender, args) => { window.DialogResult = false; window.Close(); };
            window.ShowDialog();
            return result == null ? Array.Empty<PortcoveCatalogGame>() : result.Select(choice => choice.Game).ToArray();
        }
    }
}
