using System;
using System.Linq;

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
}
