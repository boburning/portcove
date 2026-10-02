using Playnite.SDK.Models;
using Playnite.SDK.Plugins;
using System;

namespace Portcove.ReferenceClient
{
    internal sealed class ManagedUninstall : UninstallController
    {
        private readonly Action<Game> remove;
        internal ManagedUninstall(Game game, Action<Game> remove) : base(game)
        {
            this.remove = remove ?? throw new ArgumentNullException(nameof(remove));
            Name = "Remove managed Portcove versions";
        }

        public override void Uninstall(UninstallActionArgs args)
        {
            // SDK 6 has no uninstall-cancel event. Playnite clears its busy state
            // and unregisters this controller when the operation throws. Returning
            // on cancellation or swallowing a failure leaves the entry stuck.
            remove(Game);
            InvokeOnUninstalled();
        }
    }
}
