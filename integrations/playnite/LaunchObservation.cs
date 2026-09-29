using System;
using System.Linq;
using System.Threading.Tasks;

namespace Portcove.ReferenceClient
{
    // Decode an observation; never infer core lifecycle state from wrapper or PID liveness.
    internal sealed class LaunchObservation
    {
        internal int? ChildPid { get; private set; }
        internal string Outcome { get; private set; }

        internal static LaunchObservation Read(object record, string request, string port, int supervisor)
        {
            if (record == null) return null;
            if (Json.Text(record, "id") != request || Json.Text(record, "port_id") != port || Json.Number(record, "supervisor_pid") != supervisor)
                throw new InvalidOperationException("Launch observation returned another request, port or supervisor. No session success is confirmed.");
            if (!new[] { "preparing", "spawning", "running", "collecting", "recovering" }.Contains(Json.Text(record, "phase")))
                throw new InvalidOperationException("Unknown launch phase. Update the client and inspect retained activity.");
            var outcomeValue = Json.Field(record, "outcome");
            var outcome = outcomeValue as string;
            if (outcomeValue != null && !new[] { "succeeded", "failed", "cancelled" }.Contains(outcome))
                throw new InvalidOperationException("Unknown launch outcome. Update the client and inspect retained activity.");
            if (outcome != null && Json.Field(record, "finished_at") == null)
                throw new InvalidOperationException("A terminal launch lacks its completion time. Refresh retained activity.");
            int? child = null;
            if (Json.Field(record, "child_pid") != null)
            {
                child = checked((int)Json.Number(record, "child_pid"));
                if (child <= 0) throw new InvalidOperationException("Invalid child process observation.");
            }
            if (outcome == "succeeded" && child == null)
                throw new InvalidOperationException("A successful launch lacks a child observation. No gameplay success is confirmed.");
            return new LaunchObservation { ChildPid = child, Outcome = outcome };
        }
    }

    // Poll promptly until core reports the child. The owned supervisor then
    // signals when final durable readback is due, without a CLI process per poll.
    internal static class LaunchObserver
    {
        internal static async Task Observe(PublicCli cli, RawLaunch launch, string port, string request, Action<int> onStarted,
            TimeSpan? reconciliationInterval = null)
        {
            var started = false;
            Task supervisorExit = null;
            var interval = reconciliationInterval ?? TimeSpan.FromSeconds(60);
            if (interval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(reconciliationInterval));
            while (true)
            {
                // Core records its terminal result before the supervisor exits.
                // A missing result after an already-observed exit stays unknown.
                var exitedBeforeRead = launch.HasExited;
                var record = await cli.Read("launch.show", "launch", "show", request).ConfigureAwait(false);
                var observation = LaunchObservation.Read(record, request, port, launch.ProcessId);
                if (observation != null)
                {
                    if (!started && observation.ChildPid.HasValue)
                    {
                        onStarted(observation.ChildPid.Value);
                        started = true;
                        supervisorExit = launch.WaitForExitAsync();
                    }
                    if (observation.Outcome != null)
                    {
                        if (observation.Outcome != "succeeded")
                            throw new InvalidOperationException("Portcove launch " + observation.Outcome + ". Review activity for recovery and save-collection details.");
                        return;
                    }
                }
                if (exitedBeforeRead)
                    throw new InvalidOperationException("The CLI exited without an observed terminal launch outcome. Review activity and refresh; do not launch again automatically.");
                if (started)
                {
                    var signal = await Task.WhenAny(supervisorExit, Task.Delay(interval)).ConfigureAwait(false);
                    if (signal == supervisorExit) await supervisorExit.ConfigureAwait(false);
                }
                else await Task.Delay(750).ConfigureAwait(false);
            }
        }
    }
}
