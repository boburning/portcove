using Portcove.ReferenceClient;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading.Tasks;

// Sequential fixture ownership: each action completes its existing cleanup/drain
// before the next independent scenario starts. Failures are never retried.
internal static class ScenarioRunner
{
    internal sealed class Scenario
    {
        internal readonly string Id;
        internal readonly Func<Task> Execute;
        internal readonly Func<string> Skip;
        internal Scenario(string id, Func<Task> execute, Func<string> skip = null)
        { Id = id; Execute = execute; Skip = skip; }
    }

    internal static Scenario Sync(string id, Action execute) =>
        new Scenario(id, () => { execute(); return Task.CompletedTask; });

    internal static async Task<int> Run(string[] args,
        Func<string, string, Scenario[]> create, Func<int> checks, Action controlPass)
    {
        var selected = new HashSet<string>(StringComparer.Ordinal);
        var positional = new List<string>();
        var list = false;
        var control = false;
        var reportingControl = false;
        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--scenario":
                    if (++index == args.Length || args[index].StartsWith("--", StringComparison.Ordinal)
                        || !selected.Add(args[index]))
                        throw new InvalidOperationException("Each --scenario requires one unique exact scenario name.");
                    break;
                case "--list-scenarios":
                    if (list) throw new InvalidOperationException("Duplicate --list-scenarios.");
                    list = true; break;
                case "--runner-control":
                    if (control) throw new InvalidOperationException("Duplicate --runner-control.");
                    control = true; break;
                case "--runner-reporting-control":
                    if (control) throw new InvalidOperationException("Duplicate runner control.");
                    control = true; reportingControl = true; break;
                default:
                    if (args[index].StartsWith("--", StringComparison.Ordinal))
                        throw new InvalidOperationException("Unknown contract-runner option: " + args[index]);
                    positional.Add(args[index]); break;
            }
        }
        if ((positional.Count != 0 && positional.Count != 2)
            || (list && args.Length != 1) || (control && args.Length != 1))
            throw new InvalidOperationException("Use [CLI LIBRARY] [--scenario NAME ...], --list-scenarios, or --runner-control.");
        var scenarios = control ? new[] {
            Sync("control-failure", () => { throw new InvalidOperationException("Intentional runner control failure."); }),
            Sync("control-after-failure", controlPass)
        } : create(positional.Count == 2 ? positional[0] : null, positional.Count == 2 ? positional[1] : null);
        if (scenarios.Select(value => value.Id).Distinct(StringComparer.Ordinal).Count() != scenarios.Length)
            throw new InvalidOperationException("Duplicate registered contract scenario.");
        if (selected.Any(id => !scenarios.Any(value => value.Id == id)))
            throw new InvalidOperationException("Unknown contract scenario: " + string.Join(", ", selected.Where(id => !scenarios.Any(value => value.Id == id))));
        if (list)
        {
            foreach (var scenario in scenarios) Console.WriteLine(scenario.Id);
            return 0;
        }
        var failed = false;
        var executed = 0;
        var skipped = 0;
        var scenarioFailures = 0;
        var reported = 0;
        var invocation = Guid.NewGuid().ToString("N");
        string sourceDigest = null;
        var chosen = scenarios.Where(value => selected.Count == 0 || selected.Contains(value.Id)).ToArray();
        foreach (var scenario in chosen)
        {
            var before = checks();
            var timer = Stopwatch.StartNew();
            Exception failure = null;
            string skip = null;
            try
            {
                skip = scenario.Skip == null ? null : scenario.Skip();
                if (skip == null)
                {
                    executed++;
                    await scenario.Execute();
                }
            }
            catch (Exception error)
            {
                failed = true;
                failure = error;
                Console.Error.WriteLine(error);
            }
            timer.Stop();
            if (skip != null) skipped++;
            if (failure != null) scenarioFailures++;
            try
            {
                if (reportingControl && scenario.Id == "control-failure")
                    throw new IOException("Intentional scenario reporting failure.");
                // Hash the exact executed assembly, rather than claiming that
                // a mutable checkout describes a previously compiled binary.
                if (sourceDigest == null) sourceDigest = AssemblyDigest();
                Console.WriteLine("SCENARIO " + Json.Print(new {
                    format_version = 1, kind = "playnite-contract-scenario", id = scenario.Id,
                    invocation_id = invocation, runner = "Portcove.ContractTests",
                    source = new { kind = "compiled-contract-assembly", sha256 = sourceDigest },
                    platform = Environment.OSVersion.Platform.ToString(),
                    process_bits = Environment.Is64BitProcess ? 64 : 32,
                    runtime_version = Environment.Version.ToString(),
                    status = failure != null ? "failed" : skip != null ? "skipped" : "passed",
                    elapsed_ms = timer.ElapsedMilliseconds, checks = checks() - before,
                    skip_reason = skip == null ? null : Bounded(skip),
                    failure = failure == null ? null : new {
                        type = failure.GetType().FullName, message = Bounded(failure.Message)
                    }
                }));
                reported++;
            }
            catch (Exception error)
            {
                // Reporting failure cannot replace an earlier failed outcome or
                // prevent a later independent action from producing its result.
                failed = true;
                Console.Error.WriteLine("Scenario reporting failed for " + scenario.Id + ": " + error);
            }
        }
        try
        {
            if (sourceDigest == null) sourceDigest = AssemblyDigest();
            Console.WriteLine("SCENARIO_INVENTORY " + Json.Print(new {
                format_version = 1, kind = "playnite-contract-inventory",
                runner = "Portcove.ContractTests", invocation_id = invocation,
                source = new { kind = "compiled-contract-assembly", sha256 = sourceDigest },
                platform = Environment.OSVersion.Platform.ToString(),
                process_bits = Environment.Is64BitProcess ? 64 : 32, runtime_version = Environment.Version.ToString(),
                discovered = scenarios.Select(value => value.Id).ToArray(),
                selected = chosen.Select(value => value.Id).ToArray(),
                discovered_count = scenarios.Length, selected_count = chosen.Length,
                executed, skipped, failed = scenarioFailures, reported,
                records_complete = reported == chosen.Length
            }));
        }
        catch (Exception error)
        {
            failed = true;
            Console.Error.WriteLine("Scenario inventory reporting failed: " + error);
        }
        if (executed == 0)
        {
            failed = true;
            Console.Error.WriteLine("No selected contract scenario was executed.");
        }
        Console.WriteLine((failed ? "FAIL " : "PASS ") + checks() + " reference-client contract checks");
        return failed ? 1 : 0;
    }

    private static string AssemblyDigest()
    {
        using (var stream = File.OpenRead(Assembly.GetExecutingAssembly().Location))
        using (var digest = SHA256.Create())
        {
            if (stream.Length > 16 * 1024 * 1024)
                throw new IOException("Contract assembly exceeds reporting identity boundary.");
            return string.Concat(digest.ComputeHash(stream).Select(value => value.ToString("x2")));
        }
    }

    private static string Bounded(string value) => value.Length > 2048 ? value.Substring(0, 2048) : value;
}
