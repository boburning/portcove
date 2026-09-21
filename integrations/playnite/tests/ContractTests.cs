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
            if (args.Length > 0 && args[0].StartsWith("qualification-", StringComparison.Ordinal))
                RunQualification(args).GetAwaiter().GetResult();
            else
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
    private static string Event(int sequence) => sequence == 0
        ? Json.Print(new
        {
            schema_version = 2, operation_id = "request", parent_operation_id = (string)null,
            sequence, timestamp_ms = 1, operation = "install", target = (object)null, type = "started"
        })
        : Json.Print(new
        {
            schema_version = 2, operation_id = "request", parent_operation_id = (string)null,
            sequence, timestamp_ms = 1, operation = "install", target = (object)null, type = "progress",
            phase = "download", completed = sequence, total = (long?)null
        });
    private static object Capabilities() => new
    {
        schema_version = 42, product = "Portcove",
        commands = new[] { "capabilities", "catalog", "source", "status", "activity", "cancel", "doctor", "library.identity", "launch.show", "launch.recover", "exec", "ensure", "update", "preparation", "preparation.cleanup" },
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
        var contradictoryLegacyEvent = Json.Object(Json.Parse(Json.Print(Capabilities())));
        contradictoryLegacyEvent["operation_event_schema_version"] = 3;
        Reject(() => ProtocolStream.Negotiate(contradictoryLegacyEvent),
            "contradictory legacy event schema rejected");
        var launchOnly = Json.Object(Json.Parse(Json.Print(Capabilities())));
        launchOnly["commands"] = new[] { "capabilities", "status", "library.identity", "launch.show", "exec" };
        launchOnly["machine_formats"] = new[] { "json" };
        ProtocolStream.Negotiate(launchOnly, ConsumerCapability.LaunchOnly);
        Check(true, "launch-only negotiation does not require unused library or lifecycle commands");
        var libraryOnly = Json.Object(Json.Parse(Json.Print(Capabilities())));
        libraryOnly["commands"] = new[] { "capabilities", "catalog", "status", "library.identity" };
        libraryOnly["machine_formats"] = new[] { "json" };
        libraryOnly["raw_stream_commands"] = new object[0];
        ProtocolStream.Negotiate(libraryOnly, ConsumerCapability.Library);
        Check(true, "library negotiation does not require launch or lifecycle contracts");
        var lifecycleOnly = Json.Object(Json.Parse(Json.Print(Capabilities())));
        lifecycleOnly["schema_version"] = 50;
        lifecycleOnly["operation_event_schema_version"] = 2;
        lifecycleOnly["commands"] = new[] { "capabilities", "source", "status", "activity", "cancel", "doctor", "library.identity", "ensure", "update", "preparation", "preparation.cleanup" };
        lifecycleOnly["raw_stream_commands"] = new object[0];
        Check(ProtocolStream.Negotiate(lifecycleOnly, ConsumerCapability.Lifecycle) == 2,
            "lifecycle negotiation consumes the advertised operation-event schema");
        var badEvent = Json.Object(Json.Parse(Json.Print(lifecycleOnly)));
        badEvent["operation_event_schema_version"] = 3;
        Reject(() => ProtocolStream.Negotiate(badEvent, ConsumerCapability.Lifecycle),
            "unknown lifecycle event schema rejected");
        var missingEvent = Json.Object(Json.Parse(Json.Print(lifecycleOnly)));
        missingEvent.Remove("operation_event_schema_version");
        Reject(() => ProtocolStream.Negotiate(missingEvent, ConsumerCapability.Lifecycle),
            "schema 50 lifecycle without its event-schema authority rejected");
        var launchWithoutEvent = Json.Object(Json.Parse(Json.Print(launchOnly)));
        launchWithoutEvent["schema_version"] = 50;
        launchWithoutEvent["commands"] = new[] { "capabilities", "status", "library.identity", "launch.show", "exec" };
        ProtocolStream.Negotiate(launchWithoutEvent, ConsumerCapability.LaunchOnly);
        Check(true, "launch-only negotiation ignores an unused lifecycle event channel");
        var bad = Json.Object(Json.Parse(Json.Print(Capabilities()))); bad["schema_version"] = 43;
        ProtocolStream.Negotiate(bad);
        Check(true, "retained-contract API schema negotiated");
        bad["schema_version"] = 44;
        ProtocolStream.Negotiate(bad);
        Check(true, "additive artwork API schema negotiated");
        bad["schema_version"] = 45;
        ProtocolStream.Negotiate(bad);
        Check(true, "additive engine capability API schema negotiated");
        bad["schema_version"] = 46;
        ProtocolStream.Negotiate(bad);
        Check(true, "selected definition provenance API schema negotiated");
        bad["schema_version"] = 47;
        ProtocolStream.Negotiate(bad);
        Check(true, "definition operation eligibility API schema negotiated");
        bad["schema_version"] = 48;
        ProtocolStream.Negotiate(bad);
        Check(true, "retained preparation cleanup API schema negotiated");
        var incomplete48 = Json.Object(Json.Parse(Json.Print(Capabilities())));
        incomplete48["schema_version"] = 48;
        incomplete48["commands"] = Json.Array(Json.Field(incomplete48, "commands"))
            .Where(command => !Equals(command, "preparation.cleanup")).ToArray();
        Reject(() => ProtocolStream.Negotiate(incomplete48),
            "schema 48 without its cleanup capability rejected");
        bad["schema_version"] = 49;
        ProtocolStream.Negotiate(bad);
        Check(true, "explicit launch recovery API schema negotiated");
        var launch49WithoutRecovery = Json.Object(Json.Parse(Json.Print(launchOnly)));
        launch49WithoutRecovery["schema_version"] = 49;
        ProtocolStream.Negotiate(launch49WithoutRecovery, ConsumerCapability.LaunchOnly);
        Check(true, "schema 49 launch-only negotiation ignores unused launch recovery");
        bad["schema_version"] = 50;
        bad["operation_event_schema_version"] = 2;
        ProtocolStream.Negotiate(bad);
        Check(true, "operation-event negotiation API schema accepted");
        bad["schema_version"] = 51;
        ProtocolStream.Negotiate(bad);
        var activityRecord = new { id = "activity-1", operation = "install", target_kind = "port", target_id = "port", status = "running" };
        var activityFeed = Json.Parse(Json.Print(new
        {
            records = new[] { activityRecord },
            current_activity_ids = new[] { "activity-1" },
            attention_required_activity_ids = new string[0],
            recovery_required_activity_ids = new string[0],
            active_and_actionable_complete = true,
            terminal_history_limit = 50,
            terminal_history_count = 0,
            terminal_history_complete = true
        }));
        Check(ActivityFeedContract.Read(activityFeed, 51).Records.Length == 1,
            "schema 51 activity feed consumes completeness and classification");
        var activityRecords = Enumerable.Range(0, 9).Select(index => (object)new
        {
            id = "ordinary-" + index,
            operation = "install",
            target_kind = "port",
            target_id = "port",
            status = "succeeded"
        }).Concat(new[] { (object)activityRecord }).ToArray();
        var protectedActivityFeed = Json.Parse(Json.Print(new
        {
            records = activityRecords,
            current_activity_ids = new[] { "activity-1" },
            attention_required_activity_ids = new string[0],
            recovery_required_activity_ids = new string[0],
            active_and_actionable_complete = true,
            terminal_history_limit = 50,
            terminal_history_count = 9,
            terminal_history_complete = true
        }));
        var protectedActivity = ActivityFeedContract.Read(protectedActivityFeed, 51);
        Check(protectedActivity.VisibleRecords(record => Json.Text(record, "target_id") == "port", 8)
                .Any(record => Json.Text(record, "id") == "activity-1"),
            "schema 51 protected activity remains visible beyond the ordinary display window");
        var contradictoryActivity = Json.Object(Json.Parse(Json.Print(activityFeed)));
        contradictoryActivity["current_activity_ids"] = new[] { "missing" };
        Reject(() => ActivityFeedContract.Read(contradictoryActivity, 51),
            "schema 51 contradictory activity classification rejected");
        var omittedActivity = Json.Object(Json.Parse(Json.Print(activityFeed)));
        omittedActivity["current_activity_ids"] = new string[0];
        Reject(() => ActivityFeedContract.Read(omittedActivity, 51),
            "schema 51 incomplete activity classification rejected");
        var incompleteActivity = Json.Object(Json.Parse(Json.Print(activityFeed)));
        incompleteActivity.Remove("active_and_actionable_complete");
        Reject(() => ActivityFeedContract.Read(incompleteActivity, 51),
            "schema 51 missing completeness authority rejected");
        var legacyActivity = ActivityFeedContract.Read(new object[] { activityRecord }, 50);
        Check(legacyActivity.Records.Length == 1 && !legacyActivity.ActiveAndActionableComplete && !legacyActivity.TerminalHistoryComplete,
            "legacy activity arrays remain supported without invented completeness");
        bad["schema_version"] = 52;
        ProtocolStream.Negotiate(bad);
        Check(true, "additive saved-root API schema negotiated without requiring unused commands");
        bad["schema_version"] = 53;
        Reject(() => ProtocolStream.Negotiate(bad), "future schema rejected with migration guidance");
        bad["schema_version"] = 42; bad["commands"] = new object[0];
        Reject(() => ProtocolStream.Negotiate(bad), "missing command capability rejected");
        bad = Json.Object(Json.Parse(Json.Print(Capabilities())));
        bad["commands"] = Json.Array(Json.Field(bad, "commands")).Where(command => !Equals(command, "cancel")).ToArray();
        Reject(() => ProtocolStream.Negotiate(bad), "missing cancellation capability rejected before management");
        bad = Json.Object(Json.Parse(Json.Print(Capabilities())));
        bad["commands"] = Json.Array(Json.Field(bad, "commands")).Where(command => !Equals(command, "doctor")).ToArray();
        Reject(() => ProtocolStream.Negotiate(bad), "missing doctor capability rejected before management");
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
        var unknownEvent = Json.Object(Json.Parse(Event(0))); unknownEvent["type"] = "future_consequential_event";
        Reject(() => new ProtocolStream("ensure").Line(Json.Print(unknownEvent)), "unknown event type rejected");
        var incompleteProgress = Json.Object(Json.Parse(Event(1))); incompleteProgress.Remove("phase");
        Reject(() => new ProtocolStream("ensure").Line(Json.Print(incompleteProgress)), "malformed progress event rejected");
        var invalidProgress = Json.Object(Json.Parse(Event(1))); invalidProgress["completed"] = -1;
        Reject(() => new ProtocolStream("ensure").Line(Json.Print(invalidProgress)), "negative progress event rejected");
        var unknownFinished = Json.Object(Json.Parse(Event(0))); unknownFinished["type"] = "finished"; unknownFinished["result"] = "future_result";
        Reject(() => new ProtocolStream("ensure").Line(Json.Print(unknownFinished)), "unknown finished result rejected");
        var disagreement = new ProtocolStream("ensure"); disagreement.Line(Result("ensure", null));
        Reject(() => disagreement.Finish(1), "exit/result disagreement rejected");
        var failure = new ProtocolStream("ensure"); failure.Line(Result("ensure", null, false));
        Reject(() => failure.Finish(14), "structured busy-port failure remains a failure");
        DefinitionOperationRecords();
        PreparationCleanupRecords();
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
        await ConsumerMeasurements();
        if (args.Length == 2)
        {
            var real = new PublicCli(args[0], args[1]); await real.Connect();
            var statuses = Json.Array(await real.Read("status", "status"));
            var catalog = Json.Array(await real.Read("catalog.list", "catalog", "list"));
            Check(catalog.Length > 1 && statuses.Length == catalog.Length, "real standalone CLI discovery through reference consumer");
            Check(await real.Read("launch.show", "launch", "show", Guid.NewGuid().ToString("D")) == null, "real standalone CLI absent launch readback");
        }
    }

    private static async Task ConsumerMeasurements()
    {
        var root = Path.Combine(Path.GetDirectoryName(Binary), "measurement library 雪");
        Directory.CreateDirectory(root);
        try
        {
            var client = new PublicCli(Binary, root);
            var connect = Stopwatch.StartNew();
            await client.Connect();
            connect.Stop();
            Check(client.InvocationCount == 2, "consumer connection has a two-process capability and identity budget");

            var refreshStart = client.InvocationCount;
            var refresh = Stopwatch.StartNew();
            var catalog = Json.Array(await client.Read("catalog.list", "catalog", "list"));
            var statuses = Json.Array(await client.Read("status", "status"));
            await client.AssertIdentity();
            refresh.Stop();
            Check(catalog.Length == 256 && statuses.Length == catalog.Length,
                "representative 256-port refresh consumes complete batched catalog and status reads");
            Check(client.InvocationCount - refreshStart == 3,
                "representative refresh stays within three CLI processes instead of one process per game");

            var concurrentStart = client.InvocationCount;
            var concurrent = Stopwatch.StartNew();
            await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => client.Read("status", "status", "shape-a")));
            concurrent.Stop();
            Check(client.InvocationCount - concurrentStart == 4 && client.MaximumConcurrentCommands == 4,
                "caller-bounded four-read concurrency starts no hidden extra CLI processes");

            var launchStart = client.InvocationCount;
            var launchTimer = Stopwatch.StartNew();
            await client.Read("status", "status", "shape-a");
            using (var launch = await client.Launch("shape-a", "measurement-request"))
            {
                var launchPid = Path.Combine(root, "measurement-launch-pid");
                for (var attempt = 0; attempt < 100 && !File.Exists(launchPid); attempt++)
                    await Task.Delay(10);
                if (!File.Exists(launchPid)) throw new Exception("The offline launch fixture did not start within one second.");
                var record = await client.Read("launch.show", "launch", "show", "measurement-request");
                var observation = LaunchObservation.Read(record, "measurement-request", "shape-a", launch.ProcessId);
                Check(observation != null && observation.Outcome == "succeeded",
                    "prepared offline launch is observed through the public launch record");
            }
            launchTimer.Stop();
            Check(client.InvocationCount - launchStart == 4,
                "launch readiness, identity, raw exec and first observation stay within four CLI processes");

            var cancelStart = client.InvocationCount;
            var cancellation = Stopwatch.StartNew();
            await client.Manage("cancel", new[] { "cancel", "measurement-request" }, null);
            cancellation.Stop();
            Check(client.InvocationCount - cancelStart == 2,
                "cancellation rechecks library identity and uses one mutation process without replay");

            Console.WriteLine("MEASUREMENT " + Json.Print(new
            {
                schema_version = 1,
                fixture = "local-offline-256-port-consumer",
                library_ports = catalog.Length,
                process_invocations = new { connect = 2, refresh = 3, four_concurrent_reads = 4, launch_through_first_observation = 4, cancel = 2 },
                elapsed_ms = new
                {
                    connect = connect.ElapsedMilliseconds,
                    refresh = refresh.ElapsedMilliseconds,
                    four_concurrent_reads = concurrent.ElapsedMilliseconds,
                    launch_through_first_observation = launchTimer.ElapsedMilliseconds,
                    cancel = cancellation.ElapsedMilliseconds
                },
                maximum_observed_concurrent_commands = client.MaximumConcurrentCommands,
                polling = new { processes_per_observation = 1, overlapping_polls = 0 },
                prepared_offline = true
            }));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, true);
        }
    }

    private static async Task RunQualification(string[] args)
    {
        if (args.Length < 4) throw new ArgumentException("Qualification mode requires a CLI, library, and fixture port.");
        var mode = args[0];
        var client = new PublicCli(args[1], args[2]);
        var connect = Stopwatch.StartNew();
        await client.Connect();
        connect.Stop();
        var port = args[3];

        if (mode == "qualification-concurrency")
        {
            var operation = new OperationCapture();
            var install = client.Manage("ensure", new[] { "ensure", port }, operation.Observe);
            if (await Task.WhenAny(operation.Root, Task.Delay(TimeSpan.FromSeconds(15))) != operation.Root)
                throw new Exception("The real install emitted no root operation identity before the qualification timeout.");

            var competing = new PublicCli(args[1], args[2]);
            await competing.Connect();
            var conflict = new OperationCapture();
            await ExpectFailure(
                competing.Manage("ensure", new[] { "ensure", port }, conflict.Observe),
                "conflict:",
                "a real busy port is reported as conflict without fabricated success");
            await CheckActivity(competing, conflict.RequireId(), port, "install", "failed");
            await competing.Manage("cancel", new[] { "cancel", await operation.Root }, null);
            await ExpectFailure(
                install,
                "cancelled:",
                "a real cancellation remains a failed operation until durable readback");
            Check(ActiveVersion(await Status(client, port)) == null, "cancelled install leaves no active version");
            await CheckActivity(client, operation.RequireId(), port, "install", "cancelled");
            return;
        }

        if (args.Length < 5) throw new ArgumentException("Qualification phase requires an expected library identity.");
        var expectedLibrary = args[4];
        Check(client.LibraryId == expectedLibrary, "library identity is stable across compiled-client reconnects");

        if (mode == "qualification-measurement")
        {
            var start = client.InvocationCount;
            var refresh = Stopwatch.StartNew();
            var catalog = Json.Array(await client.Read("catalog.list", "catalog", "list"));
            var statuses = Json.Array(await client.Read("status", "status"));
            await client.AssertIdentity();
            refresh.Stop();
            Check(catalog.Length == statuses.Length && catalog.Length > 1,
                "real standalone CLI returns one complete batched status set for the qualification catalog");
            Check(client.InvocationCount - start == 3,
                "real standalone CLI refresh uses three processes independent of catalog size");
            Console.WriteLine("REAL_MEASUREMENT " + Json.Print(new
            {
                schema_version = 1,
                library_ports = catalog.Length,
                process_invocations = new { connect = 2, refresh = 3 },
                elapsed_ms = new { connect = connect.ElapsedMilliseconds, refresh = refresh.ElapsedMilliseconds },
                artifact_server_online = false
            }));
            return;
        }

        if (mode == "qualification-install" || mode == "qualification-update")
        {
            var expectedVersion = args.Length > 5 ? args[5] : null;
            var before = Identity.Game(client.LibraryId, port);
            var operation = new OperationCapture();
            var command = mode == "qualification-install" ? "ensure" : "update";
            await client.Manage(command, new[] { command, port }, operation.Observe);
            Check(operation.Events.Contains("started") && operation.Events.Contains("progress") && operation.Events.Contains("finished"),
                "real " + command + " exposes started, progress, and finished events through the compiled client");
            var status = await Status(client, port);
            Check(ActiveVersion(status) == expectedVersion, "real " + command + " reaches the expected active version");
            Check(Json.Boolean(Json.Field(status, "readiness"), "launchable"), "real " + command + " reaches core-owned launch readiness");
            Check(Identity.Game(client.LibraryId, port) == before, "version activation preserves Playnite launch routing identity");
            await CheckActivity(client, operation.RequireId(), port, command == "ensure" ? "install" : "update", "succeeded");
            return;
        }

        if (mode == "qualification-failure")
        {
            if (args.Length != 7) throw new ArgumentException("Failure qualification requires active version and error code.");
            var operation = new OperationCapture();
            await ExpectFailure(
                client.Manage("update", new[] { "update", port }, operation.Observe),
                args[6] + ":",
                "real " + args[6] + " update failure remains actionable and cannot fabricate success");
            Check(ActiveVersion(await Status(client, port)) == args[5], "failed update preserves the verified active version");
            await CheckActivity(client, operation.RequireId(), port, "update", "failed");
            return;
        }

        if (mode == "qualification-definition")
        {
            var status = await Status(client, port);
            Check(ActiveVersion(status) != null, "source-managed definition fixture exposes an active installation");
            var decisions = DefinitionOperations.Read(status);
            Check(decisions.Any(value => value.Operation == "install" && value.Outcome == "eligible" && !value.Retained),
                "compiled client consumes selected-definition install eligibility from core");
            Check(decisions.Any(value => value.Operation == "prepare" && value.Outcome == "eligible" && value.Retained) &&
                  decisions.Any(value => value.Operation == "launch" && value.Outcome == "eligible" && value.Retained),
                "compiled client consumes retained preparation and launch eligibility for the source-managed definition fixture");
            return;
        }

        if (mode == "qualification-definition-revoked")
        {
            var status = await Status(client, port);
            var decisions = DefinitionOperations.Read(status);
            Check(!decisions.Any(value => value.Operation == "install"),
                "revoked selected definition is no longer exposed as the current install contract");
            Check(decisions.Any(value => value.Operation == "launch" && value.Outcome == "hold" &&
                  value.Reason == "publisher_revoked" && value.Retained),
                "compiled client preserves the revoked retained launch hold without overriding core");
            Check(!Json.Boolean(Json.Field(status, "readiness"), "launchable"),
                "revoked selected-definition state removes launch readiness");
            try
            {
                DefinitionOperations.RequireEligible(status, "launch");
                throw new Exception("The client accepted launch through a revoked retained definition.");
            }
            catch (InvalidOperationException error)
            {
                Check(error.Message.Contains("publisher_revoked"),
                    "compiled client refuses launch for the real revoked retained definition");
            }
            return;
        }

        throw new ArgumentException("Unknown qualification mode: " + mode);
    }

    private static async Task<object> Status(PublicCli client, string port) =>
        await client.Read("status", "status", port);

    private static string ActiveVersion(object status)
    {
        var active = Json.Field(status, "active");
        return active == null ? null : Json.Text(active, "version");
    }

    private static async Task ExpectFailure(Task<object> operation, string expected, string description)
    {
        try { await operation; }
        catch (InvalidOperationException error)
        {
            Check(error.Message.StartsWith(expected, StringComparison.OrdinalIgnoreCase), description);
            return;
        }
        throw new Exception("Operation unexpectedly succeeded: " + description);
    }

    private sealed class OperationCapture
    {
        private readonly TaskCompletionSource<string> root = new TaskCompletionSource<string>();
        private string id;
        internal readonly List<string> Events = new List<string>();
        internal Task<string> Root { get { return root.Task; } }

        internal void Observe(Dictionary<string, object> record)
        {
            Events.Add(Json.Text(record, "type"));
            if (Json.Field(record, "parent_operation_id") != null) return;
            var current = Json.Text(record, "operation_id");
            if (id != null && id != current)
                throw new InvalidOperationException("The CLI emitted multiple root operation identities.");
            id = current;
            root.TrySetResult(current);
        }

        internal string RequireId()
        {
            if (id == null) throw new Exception("The CLI emitted no root operation identity.");
            return id;
        }
    }

    private static async Task CheckActivity(PublicCli client, string id, string port, string operation, string status)
    {
        var activities = (await client.ReadActivity(200)).Records;
        Check(activities.Any(value =>
            (Json.Field(value, "id") as string) == id &&
            (Json.Field(value, "target_id") as string) == port &&
            Json.Text(value, "operation") == operation &&
            Json.Text(value, "status") == status),
            "durable activity readback records exact operation " + id + " as " + operation + "/" + status);
    }
    private static void DefinitionOperationRecords()
    {
        var legacy = Json.Parse(Json.Print(new { port_id = "legacy" }));
        Check(DefinitionOperations.Read(legacy).Length == 0, "legacy status has no invented definition restriction");
        var status = Json.Parse(Json.Print(new
        {
            port_id = "successor",
            definition_operations = new object[]
            {
                new { operation = "install", eligibility = new { outcome = "eligible", reason = "mandatory_checks_passed" }, retained = false },
                new { operation = "prepare", eligibility = new { outcome = "escalate", reason = "engine_capability_required" }, retained = true },
                new { operation = "launch", eligibility = new { outcome = "hold", reason = "metadata_stale" }, retained = true }
            },
            additive_future_field = true
        }));
        var decisions = DefinitionOperations.Read(status);
        Check(decisions.Length == 3 && decisions[0].Operation == "install" && !decisions[0].Retained,
            "definition operation decisions retain core operation and contract scope");
        DefinitionOperations.RequireEligible(status, "install");
        Check(true, "eligible definition operation remains available");
        var summary = DefinitionOperations.Summary(status);
        Check(summary.Contains("metadata stale [metadata_stale]") && summary.Contains("retained installed contract"),
            "definition decision presents the exact stable core reason and retained scope");
        Reject(() => DefinitionOperations.RequireEligible(status, "prepare"), "escalated definition preparation is not overridden by the client");
        Reject(() => DefinitionOperations.RequireEligible(status, "launch"), "held definition launch is not overridden by the client");

        foreach (var field in new[] { "operation", "outcome", "reason" })
        {
            var assessment = Json.Object(Json.Parse(Json.Print(new
            {
                operation = "install",
                eligibility = new { outcome = "eligible", reason = "mandatory_checks_passed" },
                retained = false
            })));
            if (field == "operation") assessment[field] = "future_operation";
            else Json.Object(Json.Field(assessment, "eligibility"))[field] = "future_" + field;
            Reject(() => DefinitionOperationDecision.Read(assessment), "unknown definition " + field + " is rejected with migration guidance");
        }
        var inconsistent = Json.Parse(Json.Print(new
        {
            operation = "launch",
            eligibility = new { outcome = "eligible", reason = "publisher_revoked" },
            retained = true
        }));
        Reject(() => DefinitionOperationDecision.Read(inconsistent), "inconsistent definition eligibility outcome and reason rejected");
        var explicitNull = Json.Parse(Json.Print(new { definition_operations = (object)null }));
        try { DefinitionOperations.Read(explicitNull); throw new Exception("Accepted null definition operations"); }
        catch (InvalidOperationException) { Check(true, "explicit null definition operation list rejected"); }
        var duplicate = Json.Parse(Json.Print(new
        {
            definition_operations = new object[]
            {
                new { operation = "install", eligibility = new { outcome = "eligible", reason = "mandatory_checks_passed" }, retained = false },
                new { operation = "install", eligibility = new { outcome = "hold", reason = "metadata_stale" }, retained = false }
            }
        }));
        Reject(() => DefinitionOperations.Read(duplicate), "duplicate definition operation decision rejected");
    }
    private static object Repair(string kind, string operation, string port, string path) => new
    {
        kind, operation_id = operation, port_id = port, path,
        message = "Owned retained preparation", proposed_action = "Review before cleanup"
    };
    private static object CleanupPreview() => new
    {
        format_version = 1,
        operation_id = "retained-operation",
        port_id = "shape-a",
        retained_path = @"C:\Portcove\staging\retained-operation",
        retained = new
        {
            directories = new[] { "empty", "payload", "payload/generated" },
            files = new[] { new { relative_path = "payload/private.bin", size = 4, sha256 = new string('a', 64) } },
            skipped_entries = new[] { new { relative_path = "linked-save", reason = "symbolic link" } },
            total_bytes = 4
        },
        original_install_path = @"C:\Portcove\versions\shape-a\original",
        source_path = @"C:\Sources\shape-a.iso",
        persistent_data_path = @"C:\Portcove\user\shape-a",
        backup_path = @"C:\Portcove\backups\shape-a",
        logs_path = @"C:\Portcove\logs",
        cleanup_is_irreversible = true,
        interrupted_cleanup_will_retry = true,
        preview_sha256 = new string('b', 64)
    };
    private static void PreparationCleanupRecords()
    {
        var doctor = Json.Parse(Json.Print(new
        {
            repair = new
            {
                generated_at = 1,
                items = new object[]
                {
                    Repair("retained_preparation", "retained-operation", "shape-a", @"C:\Portcove\staging\retained-operation"),
                    Repair("partial_operation", "other-operation", "shape-a", @"C:\Portcove\staging\other-operation"),
                    Repair("retained_preparation", "other-port-operation", "shape-b", @"C:\Portcove\staging\other-port-operation")
                }
            }
        }));
        var repairs = RetainedPreparationRepair.Read(doctor, "shape-a");
        Check(repairs.Length == 1 && repairs[0].OperationId == "retained-operation" &&
            repairs[0].Path == @"C:\Portcove\staging\retained-operation",
            "schema 48 repair plan selects the retained preparation for the stable port identity");

        var preview = PreparationCleanupReview.Read(
            Json.Parse(Json.Print(CleanupPreview())), "retained-operation", "shape-a");
        var confirmation = preview.Confirmation(1, 2);
        Check(preview.TotalBytes == 4 && preview.AffectedEntries.Length == 5 &&
            confirmation.Contains("payload/private.bin") && confirmation.Contains(new string('a', 64)) &&
            confirmation.Contains("Folder: payload/generated") &&
            confirmation.Contains(@"C:\Sources\shape-a.iso") && confirmation.Contains("1 of 2"),
            "cleanup review consumes exact affected and preserved state");
        Check(PreparationCleanupReview.ReadApplied(
                Json.Parse(Json.Print(CleanupPreview())), preview).PreviewSha256 == preview.PreviewSha256,
            "cleanup mutation result must exactly match its reviewed preview");

        var unknownRepair = Json.Object(Json.Parse(Json.Print(doctor)));
        var unknownItems = Json.Array(Json.Field(Json.Field(unknownRepair, "repair"), "items"));
        Json.Object(unknownItems[0])["kind"] = "future_repair";
        Reject(() => RetainedPreparationRepair.Read(unknownRepair, "shape-a"),
            "unknown repair kind cannot hide a cleanup decision");

        var duplicateRepair = Json.Object(Json.Parse(Json.Print(doctor)));
        var duplicateItems = Json.Array(Json.Field(Json.Field(duplicateRepair, "repair"), "items"));
        duplicateItems[2] = Json.Parse(Json.Print(
            Repair("retained_preparation", "retained-operation", "shape-a", @"C:\Portcove\staging\retained-operation")));
        Reject(() => RetainedPreparationRepair.Read(duplicateRepair, "shape-a"),
            "duplicate retained preparation operation rejected");

        var wrongPort = Json.Object(Json.Parse(Json.Print(CleanupPreview())));
        wrongPort["port_id"] = "shape-b";
        Reject(() => PreparationCleanupReview.Read(wrongPort, "retained-operation", "shape-a"),
            "cross-port cleanup preview rejected");
        var futurePreview = Json.Object(Json.Parse(Json.Print(CleanupPreview())));
        futurePreview["format_version"] = 2;
        Reject(() => PreparationCleanupReview.Read(futurePreview, "retained-operation", "shape-a"),
            "future cleanup preview format rejected");
        var inconsistentBytes = Json.Object(Json.Parse(Json.Print(CleanupPreview())));
        Json.Object(Json.Field(inconsistentBytes, "retained"))["total_bytes"] = 5;
        Reject(() => PreparationCleanupReview.Read(inconsistentBytes, "retained-operation", "shape-a"),
            "inconsistent cleanup inventory bytes rejected");
        var invalidRetry = Json.Object(Json.Parse(Json.Print(CleanupPreview())));
        invalidRetry["interrupted_cleanup_will_retry"] = "unknown";
        Reject(() => PreparationCleanupReview.Read(invalidRetry, "retained-operation", "shape-a"),
            "unknown cleanup retry behavior rejected");
        var changedResult = Json.Object(Json.Parse(Json.Print(CleanupPreview())));
        var changedRetained = Json.Object(Json.Field(changedResult, "retained"));
        changedRetained["total_bytes"] = 8L;
        Json.Object(Json.Array(Json.Field(changedRetained, "files"))[0])["size"] = 8L;
        Reject(() => PreparationCleanupReview.ReadApplied(changedResult, preview),
            "cleanup mutation result with another inventory rejected");
        Reject(() => PreparationCleanupReview.ReadApplied(null, preview),
            "missing cleanup mutation result rejected");
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
        var json = Array.IndexOf(args, "--json");
        var commandIndex = jsonl >= 0 ? jsonl + 1 : json >= 0 ? json + 1 : Array.IndexOf(args, "--non-interactive") + 1;
        var command = args[commandIndex];
        if (command == "capabilities") Console.WriteLine(Result(command, Capabilities()));
        else if (command == "library") Console.WriteLine(Result("library.identity", new { id = "owned-fixture", root = args[1] }));
        else if (command == "catalog") Console.WriteLine(Result("catalog.list", Enumerable.Range(0, 256).Select(index => new
        {
            id = index == 0 ? "shape-a" : "fixture-" + index,
            name = "Fixture " + index,
            summary = "Offline consumer measurement fixture",
            platforms = new[] { "windows-x86-64" }
        }).ToArray()));
        else if (command == "status")
        {
            var status = new { port_id = "shape-a", active = new { version = "1.0.0", path = @"C:\Portcove\shape-a" }, readiness = new { launchable = true } };
            Console.WriteLine(Result(command, commandIndex + 1 < args.Length ? (object)status : Enumerable.Range(0, 256).Select(index => new
            {
                port_id = index == 0 ? "shape-a" : "fixture-" + index,
                active = index == 0 ? new { version = "1.0.0", path = @"C:\Portcove\shape-a" } : null,
                readiness = new { launchable = index == 0 }
            }).ToArray()));
        }
        else if (command == "exec")
        {
            File.WriteAllText(Path.Combine(args[1], "measurement-launch-pid"), Process.GetCurrentProcess().Id.ToString());
        }
        else if (command == "launch")
        {
            var pid = int.Parse(File.ReadAllText(Path.Combine(args[1], "measurement-launch-pid")));
            Console.WriteLine(Result("launch.show", new
            {
                id = "measurement-request", port_id = "shape-a", supervisor_pid = pid, child_pid = (int?)pid,
                phase = "running", outcome = "succeeded", finished_at = (long?)42
            }));
        }
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
