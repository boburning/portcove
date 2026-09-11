using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

namespace Portcove.ReferenceClient
{
    // Public transport only. No installation, source, release or recovery rules live here.
    internal static class Json
    {
        internal static object Parse(string text) => new JavaScriptSerializer
        {
            MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 100
        }.DeserializeObject(text);

        internal static string Print(object value) => new JavaScriptSerializer
        {
            MaxJsonLength = 16 * 1024 * 1024
        }.Serialize(value);

        internal static Dictionary<string, object> Object(object value)
        {
            var result = value as Dictionary<string, object>;
            if (result == null) throw new InvalidOperationException("Expected a Portcove JSON object. Check client/CLI compatibility.");
            return result;
        }

        internal static object Field(object value, string key)
        {
            object result;
            if (!Object(value).TryGetValue(key, out result))
                throw new InvalidOperationException("Portcove response lacks " + key + ". Check client/CLI compatibility.");
            return result;
        }

        internal static string Text(object value, string key)
        {
            var result = Field(value, key) as string;
            if (result == null) throw new InvalidOperationException("Invalid Portcove text field: " + key);
            return result;
        }

        internal static object[] Array(object value)
        {
            var result = value as object[];
            if (result == null) throw new InvalidOperationException("Expected a Portcove JSON array.");
            return result;
        }

        internal static bool Boolean(object value, string key)
        {
            var result = Field(value, key);
            if (!(result is bool)) throw new InvalidOperationException("Invalid Portcove boolean: " + key);
            return (bool)result;
        }

        internal static long Number(object value, string key)
        {
            var result = Field(value, key);
            if (!(result is int) && !(result is long)) throw new InvalidOperationException("Invalid Portcove integer: " + key);
            return Convert.ToInt64(result);
        }
    }

    internal static class Identity
    {
        internal static string Game(string library, string port) => Uri.EscapeDataString(library) + "/" + Uri.EscapeDataString(port);

        internal static string Port(string key, string library)
        {
            var prefix = Uri.EscapeDataString(library) + "/";
            if (!key.StartsWith(prefix, StringComparison.Ordinal) || key.Length == prefix.Length)
                throw new InvalidOperationException("This game belongs to another Portcove library. Select its library and refresh Playnite.");
            var port = Uri.UnescapeDataString(key.Substring(prefix.Length));
            if (Game(library, port) != key) throw new InvalidOperationException("Malformed Portcove game identity. Refresh the library.");
            return port;
        }
    }

    internal static class WindowsArguments
    {
        // Microsoft C runtime argv rules; ProcessStartInfo never invokes a shell.
        internal static string Quote(string value)
        {
            if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Arguments must be Unicode text without NUL.");
            var result = new StringBuilder("\"");
            var slashes = 0;
            foreach (var c in value)
            {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }

        internal static string Join(IEnumerable<string> values) => string.Join(" ", values.Select(Quote));
    }

    internal sealed class ProtocolStream
    {
        internal const int Schema = 47;
        private static bool SupportedSchema(long version) => version >= 42 && version <= Schema;
        private readonly string command;
        private readonly Action<Dictionary<string, object>> progress;
        private readonly Dictionary<string, long> sequences = new Dictionary<string, long>(StringComparer.Ordinal);
        private Dictionary<string, object> result;
        internal bool EventGap { get; private set; }
        internal string OperationId { get; private set; }

        internal ProtocolStream(string command, Action<Dictionary<string, object>> progress = null)
        {
            this.command = command;
            this.progress = progress;
        }

        internal void Line(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) throw new InvalidOperationException("Empty machine-output record.");
            if (result != null) throw new InvalidOperationException("Portcove emitted data after its final result.");
            var record = Json.Object(Json.Parse(line));
            object type;
            record.TryGetValue("type", out type);
            if (type == null || (type as string) == "result")
            {
                if (!SupportedSchema(Json.Number(record, "schema_version")) || Json.Text(record, "command") != command)
                    throw new InvalidOperationException("Unsupported Portcove response. This client requires API schema 42 through 47; install a matching CLI/client pair.");
                Json.Boolean(record, "ok");
                result = record;
                return;
            }
            if (Json.Number(record, "schema_version") != 2)
                throw new InvalidOperationException("Unsupported Portcove event schema. Refresh durable activity and update the client.");
            var id = Json.Text(record, "operation_id");
            if (id.Length == 0 || id.Length > 1024 || (!sequences.ContainsKey(id) && sequences.Count >= 1024))
                throw new InvalidOperationException("The CLI event identities exceed the bounded reference-client contract. Refresh durable state.");
            var sequence = Json.Number(record, "sequence");
            long previous;
            if (sequence < 0 || (sequences.TryGetValue(id, out previous) ? sequence != previous + 1 : sequence != 0)) EventGap = true;
            sequences[id] = sequence;
            if (Json.Field(record, "parent_operation_id") == null)
            {
                if (OperationId != null && OperationId != id) EventGap = true;
                OperationId = id;
            }
            progress?.Invoke(record);
        }

        internal object Finish(int exitCode)
        {
            if (result == null) throw new InvalidOperationException("The CLI stream ended without a final result. Refresh activity and current state before deciding what to do; do not retry automatically.");
            var ok = Json.Boolean(result, "ok");
            if (ok != (exitCode == 0)) throw new InvalidOperationException("The CLI result and exit status disagree. Refresh durable state; success is unconfirmed.");
            if (!ok)
            {
                var error = Json.Field(result, "error");
                throw new InvalidOperationException(Json.Text(error, "code") + ": " + Json.Text(error, "message") + "\nRefresh readiness and activity for the current core outcome.");
            }
            return Json.Field(result, "data");
        }

        internal static void Negotiate(object capabilities)
        {
            if (!SupportedSchema(Json.Number(capabilities, "schema_version")) || Json.Text(capabilities, "product") != "Portcove")
                throw new InvalidOperationException("This reference client requires Portcove API schema 42 through 47. Select a compatible CLI or update the client.");
            var commands = Json.Array(Json.Field(capabilities, "commands")).OfType<string>().ToArray();
            foreach (var required in new[] { "catalog", "source", "status", "activity", "cancel", "library.identity", "launch.show", "exec", "ensure", "update", "preparation" })
                if (!commands.Contains(required)) throw new InvalidOperationException("The CLI lacks " + required + ". Select a compatible standalone Portcove CLI.");
            var formats = Json.Array(Json.Field(capabilities, "machine_formats")).OfType<string>();
            if (!formats.Contains("json") || !formats.Contains("jsonl") || !Json.Array(Json.Field(capabilities, "raw_stream_commands")).Contains("exec"))
                throw new InvalidOperationException("The CLI lacks the required JSON/JSONL and raw supervised launch contracts.");
        }
    }
}
