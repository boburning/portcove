using Portcove.ReferenceClient;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

internal static class ContractTests
{
    private static int passed;
    private static readonly string Binary = Assembly.GetExecutingAssembly().Location;
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length > 0 && args[0] == "argv") { Console.Write(Json.Print(args.Skip(1).ToArray())); return 0; }
        if (args.Length > 0 && args[0] == "--library") return FakeCli(args);
        try
        {
            Run(args).GetAwaiter().GetResult();
            Console.WriteLine("PASS " + passed + " reference-client contract checks");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    private static void Check(bool ok, string description)
    {
        if (!ok) throw new Exception(description);
        passed++; Console.WriteLine("PASS " + description);
    }
    private static void Reject(Action action, string description)
    {
        try { action(); } catch (InvalidOperationException) { Check(true, description); return; }
        throw new Exception("Accepted invalid input: " + description);
    }
    private static string Result(string command, object data, bool ok = true) => Json.Print(new
    {
        schema_version = 42, type = "result", command, ok, data,
        error = ok ? null : new { code = "conflict", message = "Owned fixture port is busy" }
    });
    private static string Event(int sequence) => Json.Print(new
    {
        schema_version = 2, operation_id = "request", parent_operation_id = (string)null,
        sequence, timestamp_ms = 1, operation = "install", type = sequence == 0 ? "started" : "progress"
    });
    private static object Capabilities() => new
    {
        schema_version = 42, product = "Portcove",
        commands = new[] { "catalog", "source", "status", "activity", "cancel", "library.identity", "launch.show", "exec", "ensure", "update", "preparation" },
        machine_formats = new[] { "json", "jsonl" }, raw_stream_commands = new[] { "exec" }
    };
    private static async Task Run(string[] args)
    {
        var id = Identity.Game("library/a:% 雪", "port/b:% 雪");
        Check(Identity.Port(id, "library/a:% 雪") == "port/b:% 雪", "opaque library/port identity round trip");
        Reject(() => Identity.Port(id, "other"), "stale library identity rejected");
        Check(Identity.Game("ab", "c") != Identity.Game("a", "bc"), "component identities do not collide");
        var literal = new[] { "", "plain", "space here", "雪 café", "a\"b", @"C:\path with spaces\", @"x\\\" + '"', "&|<>^%!$(echo injected)`", "line\nline" };
        var start = new ProcessStartInfo(Binary, WindowsArguments.Join(new[] { "argv" }.Concat(literal)))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true,
            StandardOutputEncoding = Encoding.UTF8
        };
        using (var process = Process.Start(start))
        {
            var actual = Json.Array(Json.Parse(process.StandardOutput.ReadToEnd())).Cast<string>();
            process.WaitForExit();
            Check(actual.SequenceEqual(literal) && process.ExitCode == 0, "real child receives literal Windows argv including quotes/metacharacters");
        }
        try { WindowsArguments.Quote("a\0b"); throw new Exception("Accepted NUL"); } catch (ArgumentException) { Check(true, "NUL argument rejected"); }
        Reject(() => PublicCli.RequireAbsolute("C:relative"), "drive-relative path rejected");
        Reject(() => PublicCli.RequireAbsolute(@"\root-relative"), "root-relative path rejected");
        ProtocolStream.Negotiate(Json.Parse(Json.Print(Capabilities())));
        Check(true, "supported capabilities negotiated");
        var bad = Json.Object(Json.Parse(Json.Print(Capabilities()))); bad["schema_version"] = 43;
        ProtocolStream.Negotiate(bad);
        Check(true, "retained-contract API schema negotiated");
        bad["schema_version"] = 44;
        Reject(() => ProtocolStream.Negotiate(bad), "future schema rejected with migration guidance");
        bad["schema_version"] = 42; bad["commands"] = new object[0];
        Reject(() => ProtocolStream.Negotiate(bad), "missing command capability rejected");
        bad = Json.Object(Json.Parse(Json.Print(Capabilities())));
        bad["commands"] = Json.Array(Json.Field(bad, "commands")).Where(command => !Equals(command, "cancel")).ToArray();
        Reject(() => ProtocolStream.Negotiate(bad), "missing cancellation capability rejected before management");
        var absent = new ProtocolStream("launch.show"); absent.Line(Result("launch.show", null));
        Check(absent.Finish(0) == null, "absent launch remains unknown/null");
        var stream = new ProtocolStream("ensure"); stream.Line(Event(0)); stream.Line(Event(1)); stream.Line(Result("ensure", new { id = "owned" }));
        Check(Json.Text(stream.Finish(0), "id") == "owned" && !stream.EventGap, "events terminate in one verified result");
        Reject(() => stream.Line(Result("ensure", null)), "duplicate terminal result rejected");
        var wrong = new ProtocolStream("status");
        Reject(() => wrong.Line(Result("ensure", null)), "wrong command result rejected");
        var lost = new ProtocolStream("ensure"); lost.Line(Event(0));
        Reject(() => lost.Finish(0), "lost final stream never succeeds from exit code");
        var gap = new ProtocolStream("ensure"); gap.Line(Event(0)); gap.Line(Event(3)); gap.Line(Result("ensure", null)); gap.Finish(0);
        Check(gap.EventGap, "sequence gap requires durable readback");
        var disagreement = new ProtocolStream("ensure"); disagreement.Line(Result("ensure", null));
        Reject(() => disagreement.Finish(1), "exit/result disagreement rejected");
        var failure = new ProtocolStream("ensure"); failure.Line(Result("ensure", null, false));
        Reject(() => failure.Finish(14), "structured busy-port failure remains a failure");
        LaunchRecords();
        var root = Path.Combine(Path.GetDirectoryName(Binary), "fixture-library");
        var client = new PublicCli(Binary, root);
        await client.Connect();
        Check(client.LibraryId == "owned-fixture", "external consumer negotiates through actual child CLI processes");
        var observed = new List<string>();
        await client.Manage("ensure", new[] { "ensure", "shape-a" }, value => observed.Add(Json.Text(value, "type")));
        Check(observed.SequenceEqual(new[] { "started", "progress" }), "stream progress crosses process boundary");
        await client.Manage("update", new[] { "update", "shape-b" }, null);
        Check(true, "same management transport handles a second synthetic adapter identity");
        var missing = new PublicCli(Binary, root + "-lost"); await missing.Connect();
        try { await missing.Manage("ensure", new[] { "ensure", "shape-a" }, null); throw new Exception("Missing final accepted"); }
        catch (InvalidOperationException) { Check(true, "real process lost-stream scenario is unconfirmed"); }
        foreach (var scenario in new[] { "gap", "invalid-utf8", "bad-json", "oversize", "conflict", "cancelled" })
        {
            var broken = new PublicCli(Binary, root + "-" + scenario); await broken.Connect();
            var rejected = false;
            try { await broken.Manage("ensure", new[] { "ensure", "shape-a" }, null); }
            catch (InvalidOperationException) { rejected = true; }
            catch (ArgumentException) { rejected = true; }
            Check(rejected, "owned process " + scenario + " never fabricates success or blocks pipe draining");
        }
        await client.Manage("cancel", new[] { "cancel", "request" }, null);
        Check(true, "cancellation request accepts a result-only response");
        if (args.Length == 2)
        {
            var real = new PublicCli(args[0], args[1]); await real.Connect();
            var statuses = Json.Array(await real.Read("status", "status"));
            var catalog = Json.Array(await real.Read("catalog.list", "catalog", "list"));
            Check(catalog.Length > 1 && statuses.Length == catalog.Length, "real standalone CLI discovery through reference consumer");
            Check(await real.Read("launch.show", "launch", "show", Guid.NewGuid().ToString("D")) == null, "real standalone CLI absent launch readback");
        }
    }
    private static void LaunchRecords()
    {
        var record = Json.Object(Json.Parse(Json.Print(new
        {
            id = "request", port_id = "port", supervisor_pid = 123, child_pid = (int?)456,
            phase = "running", outcome = (string)null, finished_at = (long?)null
        })));
        Check(LaunchObservation.Read(null, "request", "port", 123) == null, "null launch observation is not terminal success");
        var running = LaunchObservation.Read(record, "request", "port", 123);
        Check(running.ChildPid == 456 && running.Outcome == null, "running child remains unresolved");
        Reject(() => LaunchObservation.Read(record, "other", "port", 123), "wrong request observation rejected");
        Reject(() => LaunchObservation.Read(record, "request", "other", 123), "wrong port observation rejected");
        Reject(() => LaunchObservation.Read(record, "request", "port", 789), "wrong supervisor observation rejected");
        record["phase"] = "future_phase";
        Reject(() => LaunchObservation.Read(record, "request", "port", 123), "unknown consequential phase rejected");
        record["phase"] = "running"; record["outcome"] = "future_outcome";
        Reject(() => LaunchObservation.Read(record, "request", "port", 123), "unknown outcome rejected");
        record["outcome"] = "succeeded";
        Reject(() => LaunchObservation.Read(record, "request", "port", 123), "terminal outcome without completion evidence rejected");
        record["finished_at"] = 42;
        Check(LaunchObservation.Read(record, "request", "port", 123).Outcome == "succeeded", "terminal result wins over retained running phase");
        record["child_pid"] = null;
        Reject(() => LaunchObservation.Read(record, "request", "port", 123), "success without child observation rejected");
        record["outcome"] = "failed";
        Check(LaunchObservation.Read(record, "request", "port", 123).ChildPid == null, "prelaunch failure does not invent a started child");
    }
    private static int FakeCli(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var jsonl = Array.IndexOf(args, "--jsonl");
        var commandIndex = (jsonl >= 0 ? jsonl : Array.IndexOf(args, "--json")) + 1;
        var command = args[commandIndex];
        if (command == "capabilities") Console.WriteLine(Result(command, Capabilities()));
        else if (command == "library") Console.WriteLine(Result("library.identity", new { id = "owned-fixture", root = args[1] }));
        else
        {
            if (args[1].EndsWith("-invalid-utf8", StringComparison.Ordinal))
            {
                var output = Console.OpenStandardOutput(); output.WriteByte(255);
                var bytes = Enumerable.Repeat((byte)'x', 4096).ToArray();
                for (var index = 0; index < 256; index++) output.Write(bytes, 0, bytes.Length);
                output.Flush(); return 0;
            }
            if (args[1].EndsWith("-bad-json", StringComparison.Ordinal))
            {
                Console.WriteLine("broken JSON");
                for (var index = 0; index < 256; index++) Console.WriteLine(new string('x', 4096));
                return 0;
            }
            if (args[1].EndsWith("-oversize", StringComparison.Ordinal))
            {
                for (var index = 0; index < 4352; index++) Console.Write(new string('x', 4096));
                Console.WriteLine(); return 0;
            }
            if (args[1].EndsWith("-cancelled", StringComparison.Ordinal))
            {
                Console.WriteLine(Json.Print(new { schema_version = 42, type = "result", command, ok = false, data = (object)null,
                    error = new { code = "cancelled", message = "Owned fixture operation cancelled" } })); return 130;
            }
            if (args[1].EndsWith("-conflict", StringComparison.Ordinal))
            {
                Console.WriteLine(Result(command, null, false)); return 14;
            }
            if (command == "cancel") { Console.WriteLine(Result(command, new { requested = true })); return 0; }
            Console.WriteLine(Event(0)); Console.WriteLine(Event(1));
            if (args[1].EndsWith("-gap", StringComparison.Ordinal)) Console.WriteLine(Event(4));
            if (!args[1].EndsWith("-lost", StringComparison.Ordinal)) Console.WriteLine(Result(command, new { id = "owned" }));
        }
        return 0;
    }
}
