using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace Portcove.ReferenceClient
{
    internal sealed class PublicCli
    {
        internal string Executable { get; }
        internal string LibraryRoot { get; }
        internal string LibraryId { get; private set; }

        internal PublicCli(string executable, string libraryRoot)
        {
            RequireAbsolute(executable);
            RequireAbsolute(libraryRoot);
            if (!string.Equals(Path.GetExtension(executable), ".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(executable))
                throw new InvalidOperationException("Select an existing, verified standalone portcove.exe in the extension settings.");
            Executable = executable;
            LibraryRoot = libraryRoot;
        }

        internal static void RequireAbsolute(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || path.IndexOf('\0') >= 0 ||
                !(path.StartsWith(@"\\", StringComparison.Ordinal) ||
                  (path.Length >= 3 && char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/'))))
                throw new InvalidOperationException("Choose a fully qualified Windows path for the CLI and library.");
            Path.GetFullPath(path);
        }

        internal async Task Connect()
        {
            ProtocolStream.Negotiate(await Read("capabilities", "capabilities").ConfigureAwait(false));
            var identity = await Read("library.identity", "library", "identity").ConfigureAwait(false);
            LibraryId = Json.Text(identity, "id");
            if (LibraryId.Length == 0) throw new InvalidOperationException("The CLI returned an empty library identity.");
        }

        internal async Task AssertIdentity()
        {
            var identity = await Read("library.identity", "library", "identity").ConfigureAwait(false);
            if (LibraryId == null || Json.Text(identity, "id") != LibraryId)
                throw new InvalidOperationException("The selected library changed. Refresh before starting another operation.");
        }

        internal Task<object> Read(string command, params string[] arguments) => Run(command, arguments, false, null);

        internal async Task<object> Manage(string command, string[] arguments, Action<Dictionary<string, object>> progress)
        {
            await AssertIdentity().ConfigureAwait(false);
            return await Run(command, arguments, true, progress).ConfigureAwait(false);
        }

        private Process Start(IEnumerable<string> arguments)
        {
            var all = new List<string> { "--library", LibraryRoot, "--non-interactive" };
            all.AddRange(arguments);
            var info = new ProcessStartInfo(Executable, WindowsArguments.Join(all))
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false, true),
                StandardErrorEncoding = new UTF8Encoding(false, true),
                WorkingDirectory = Path.GetDirectoryName(Executable)
            };
            var process = new Process { StartInfo = info };
            try
            {
                if (!process.Start()) throw new InvalidOperationException("Could not start the selected Portcove CLI.");
                process.StandardInput.Close();
                return process;
            }
            catch { process.Dispose(); throw; }
        }

        private async Task<object> Run(string command, string[] arguments, bool mutation, Action<Dictionary<string, object>> progress)
        {
            var args = new List<string> { mutation ? "--jsonl" : "--json" };
            args.AddRange(arguments);
            var parser = new ProtocolStream(command, progress);
            using (var process = Start(args))
            {
                var output = Pump(process.StandardOutput, parser.Line);
                // Raw stderr may contain local paths or tool output. Drain without exporting it.
                var errors = Drain(process.StandardError.BaseStream);
                var exited = await Task.Run(() => process.WaitForExit(mutation ? -1 : 45000)).ConfigureAwait(false);
                if (!exited)
                {
                    // Only this owned read process is stopped. Mutations and game supervisors are never killed here.
                    try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { }
                    await Task.Run(() => process.WaitForExit(5000)).ConfigureAwait(false);
                    ObserveDrainFailures(Task.WhenAll(output, errors));
                    throw new InvalidOperationException("The CLI read timed out. No success is inferred; inspect Portcove activity before retrying.");
                }
                var drained = Task.WhenAll(output, errors);
                if (await Task.WhenAny(drained, Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false) != drained)
                {
                    ObserveDrainFailures(drained);
                    throw new InvalidOperationException("The CLI exited but an output stream stayed open. Refresh durable state; the operation is unconfirmed.");
                }
                await drained.ConfigureAwait(false);
                var value = parser.Finish(process.ExitCode);
                if (parser.EventGap)
                    throw new InvalidOperationException("The final CLI result arrived after missing or reordered events. Refresh activity and current state; do not replay the command automatically.");
                return value;
            }
        }

        private static void ObserveDrainFailures(Task task) => task.ContinueWith(completed =>
        {
            var ignored = completed.Exception;
        }, TaskContinuationOptions.OnlyOnFaulted);

        internal async Task<RawLaunch> Launch(string port, string requestId)
        {
            await AssertIdentity().ConfigureAwait(false);
            return new RawLaunch(Start(new[] { "exec", port, "--request-id", requestId }));
        }

        internal static async Task Pump(StreamReader reader, Action<string> line)
        {
            try { await ReadRecords(reader, line).ConfigureAwait(false); }
            catch (DecoderFallbackException)
            {
                // Keep draining after invalid UTF-8 so the writer cannot hang on a full pipe.
                await Drain(reader.BaseStream).ConfigureAwait(false);
                throw new InvalidOperationException("The CLI emitted invalid UTF-8. Refresh durable state; no success was confirmed.");
            }
        }

        private static async Task ReadRecords(StreamReader reader, Action<string> line)
        {
            var buffer = new char[4096];
            var pending = new StringBuilder();
            Exception failure = null;
            int count;
            while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
            {
                if (line == null || failure != null) continue;
                for (var index = 0; index < count; index++)
                {
                    var c = buffer[index];
                    if (c == '\n')
                    {
                        try { line(pending.ToString().TrimEnd('\r')); }
                        catch (Exception error) { failure = error; }
                        pending.Clear();
                        if (failure != null) break;
                    }
                    else if (pending.Length >= 16 * 1024 * 1024)
                    {
                        failure = new InvalidOperationException("The CLI output exceeded the bounded record limit. Refresh durable state.");
                        pending.Clear();
                        break;
                    }
                    else pending.Append(c);
                }
            }
            if (failure != null) throw failure;
            if (line != null && pending.Length != 0) line(pending.ToString().TrimEnd('\r'));
        }

        internal static async Task Drain(Stream stream)
        {
            var buffer = new byte[4096];
            while (await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false) != 0) { }
        }
    }

    internal sealed class RawLaunch : IDisposable
    {
        private readonly Process process;
        private readonly Task output;
        private readonly Task errors;
        internal RawLaunch(Process process)
        {
            this.process = process;
            output = PublicCli.Drain(process.StandardOutput.BaseStream);
            errors = PublicCli.Drain(process.StandardError.BaseStream);
        }
        internal bool HasExited => process.HasExited;
        internal int ProcessId => process.Id;
        public void Dispose()
        {
            // Closing the client never signals a game or invents a completed core session.
            // Keep draining inherited streams until their owners close them.
            Task.WhenAll(output, errors).ContinueWith(task => { var ignored = task.Exception; process.Dispose(); }, TaskScheduler.Default);
        }
    }
}
