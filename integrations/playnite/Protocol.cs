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

        internal static bool TryField(object value, string key, out object result) => Object(value).TryGetValue(key, out result);

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

        internal static string OptionalText(object value, string key)
        {
            var result = Field(value, key);
            if (result == null) return null;
            var text = result as string;
            if (text == null) throw new InvalidOperationException("Invalid Portcove text field: " + key);
            return text;
        }
    }

    internal sealed class DefinitionOperationDecision
    {
        internal string Operation { get; private set; }
        internal string Outcome { get; private set; }
        internal string Reason { get; private set; }
        internal bool Retained { get; private set; }

        internal static DefinitionOperationDecision Read(object value)
        {
            var operation = Json.Text(value, "operation");
            if (!new[] { "availability", "install", "prepare", "launch" }.Contains(operation))
                throw new InvalidOperationException("Unknown Portcove definition operation. Update the client before managing this game.");
            var eligibility = Json.Field(value, "eligibility");
            var outcome = Json.Text(eligibility, "outcome");
            if (!new[] { "eligible", "hold", "escalate" }.Contains(outcome))
                throw new InvalidOperationException("Unknown Portcove definition eligibility outcome. Update the client before managing this game.");
            var reason = Json.Text(eligibility, "reason");
            if (!new[]
            {
                "mandatory_checks_passed", "publisher_revoked", "unknown_safety_semantics",
                "publisher_scope_required", "engine_capability_required", "ownership_migration_required",
                "metadata_replay", "refresh_incomplete", "metadata_stale", "recorded_identity_changed",
                "authenticated_integrity_required", "local_integrity_failed", "mandatory_check_failed",
                "source_identity_mismatch", "required_source_missing"
            }.Contains(reason))
                throw new InvalidOperationException("Unknown Portcove definition eligibility reason. Update the client before managing this game.");
            if ((outcome == "eligible") != (reason == "mandatory_checks_passed"))
                throw new InvalidOperationException("Portcove definition eligibility outcome and reason disagree. Refresh state and use a compatible CLI/client pair.");
            return new DefinitionOperationDecision
            {
                Operation = operation,
                Outcome = outcome,
                Reason = reason,
                Retained = Json.Boolean(value, "retained")
            };
        }
    }

    internal static class DefinitionOperations
    {
        internal static DefinitionOperationDecision[] Read(object status)
        {
            object raw;
            if (!Json.TryField(status, "definition_operations", out raw))
                return new DefinitionOperationDecision[0];
            var decisions = Json.Array(raw).Select(DefinitionOperationDecision.Read).ToArray();
            if (decisions.Select(decision => decision.Operation).Distinct(StringComparer.Ordinal).Count() != decisions.Length)
                throw new InvalidOperationException("Portcove repeated a definition operation decision. Refresh state and update the client if it persists.");
            return decisions;
        }

        internal static void RequireEligible(object status, string operation)
        {
            var decision = Read(status).SingleOrDefault(value => value.Operation == operation);
            if (decision == null || decision.Outcome == "eligible") return;
            throw new InvalidOperationException(
                "Portcove reports that definition " + operation + " requires attention: " +
                decision.Reason.Replace('_', ' ') + " [" + decision.Reason + ", " + decision.Outcome + "]. " +
                "Refresh readiness and use Portcove's supported recovery or trust action; the client did not override this decision.");
        }

        internal static string Summary(object status)
        {
            var decisions = Read(status);
            if (decisions.Length == 0) return null;
            return string.Join("\n", decisions.Select(decision =>
                "Definition " + decision.Operation + ": " + decision.Outcome + " — " +
                decision.Reason.Replace('_', ' ') + " [" + decision.Reason + "]" +
                (decision.Retained ? " (retained installed contract)" : " (selected definition)")));
        }
    }

    internal sealed class RetainedPreparationRepair
    {
        private static readonly string[] KnownKinds =
        {
            "retained_preparation", "partial_operation", "cleanup_pending",
            "orphaned_final_directory", "missing_registered_path", "degraded_backup",
            "backup_recovery_required"
        };

        internal string OperationId { get; private set; }
        internal string PortId { get; private set; }
        internal string Path { get; private set; }

        internal static RetainedPreparationRepair[] Read(object doctor, string port)
        {
            var repair = Json.Field(doctor, "repair");
            Json.Number(repair, "generated_at");
            var result = new List<RetainedPreparationRepair>();
            foreach (var raw in Json.Array(Json.Field(repair, "items")))
            {
                var kind = Json.Text(raw, "kind");
                if (!KnownKinds.Contains(kind))
                    throw new InvalidOperationException("Unknown Portcove repair action. Update the client before changing retained data.");
                var operationId = Json.OptionalText(raw, "operation_id");
                var portId = Json.OptionalText(raw, "port_id");
                var path = Json.OptionalText(raw, "path");
                Json.Text(raw, "message");
                Json.Text(raw, "proposed_action");
                if (kind != "retained_preparation") continue;
                if (string.IsNullOrWhiteSpace(operationId) || string.IsNullOrWhiteSpace(portId) || string.IsNullOrWhiteSpace(path))
                    throw new InvalidOperationException("A retained preparation repair lacks its operation, game, or path. Refresh with a compatible CLI before changing files.");
                PublicCli.RequireAbsolute(path);
                if (portId == port)
                    result.Add(new RetainedPreparationRepair { OperationId = operationId, PortId = portId, Path = path });
            }
            if (result.Select(value => value.OperationId).Distinct(StringComparer.Ordinal).Count() != result.Count)
                throw new InvalidOperationException("Portcove repeated a retained preparation repair. Refresh state before changing files.");
            return result.ToArray();
        }
    }

    internal sealed class PreparationCleanupReview
    {
        internal string OperationId { get; private set; }
        internal string PortId { get; private set; }
        internal string RetainedPath { get; private set; }
        internal string OriginalInstallPath { get; private set; }
        internal string SourcePath { get; private set; }
        internal string PersistentDataPath { get; private set; }
        internal string BackupPath { get; private set; }
        internal string LogsPath { get; private set; }
        internal bool CleanupIsIrreversible { get; private set; }
        internal bool InterruptedCleanupWillRetry { get; private set; }
        internal string PreviewSha256 { get; private set; }
        internal string[] AffectedEntries { get; private set; }
        internal long TotalBytes { get; private set; }

        private static string RequiredText(object value, string key)
        {
            var text = Json.Text(value, key);
            if (string.IsNullOrWhiteSpace(text) || text.IndexOf('\0') >= 0)
                throw new InvalidOperationException("Portcove returned an empty or invalid cleanup field: " + key);
            return text;
        }

        private static string RequiredArrayText(object value, string label)
        {
            var text = value as string;
            if (string.IsNullOrWhiteSpace(text) || text.IndexOf('\0') >= 0)
                throw new InvalidOperationException("Portcove returned an empty or invalid cleanup " + label + ".");
            return text;
        }

        private static string RequiredPath(object value, string key)
        {
            var path = RequiredText(value, key);
            PublicCli.RequireAbsolute(path);
            return path;
        }

        private static bool IsSha256(string value) =>
            value.Length == 64 && value.All(character =>
                (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'));

        internal static PreparationCleanupReview Read(object value, string operation, string port)
        {
            if (Json.Number(value, "format_version") != 1)
                throw new InvalidOperationException("Unknown preparation cleanup preview format. Update the client before changing retained data.");
            var operationId = RequiredText(value, "operation_id");
            var portId = RequiredText(value, "port_id");
            if (operationId != operation || portId != port)
                throw new InvalidOperationException("The cleanup preview belongs to another operation or game. Refresh before changing retained data.");

            var retained = Json.Field(value, "retained");
            var entries = new List<string>();
            long observedBytes = 0;
            foreach (var raw in Json.Array(Json.Field(retained, "files")))
            {
                var relativePath = RequiredText(raw, "relative_path");
                var size = Json.Number(raw, "size");
                var sha256 = RequiredText(raw, "sha256");
                if (size < 0 || !IsSha256(sha256))
                    throw new InvalidOperationException("A retained file has an invalid size or SHA-256. Refresh before changing retained data.");
                observedBytes = checked(observedBytes + size);
                entries.Add("File: " + relativePath + " (" + size + " bytes, SHA-256 " + sha256 + ")");
            }
            foreach (var raw in Json.Array(Json.Field(retained, "directories")))
                entries.Add("Empty folder: " + RequiredArrayText(raw, "folder path"));
            foreach (var raw in Json.Array(Json.Field(retained, "skipped_entries")))
                entries.Add("Link or special entry: " + RequiredText(raw, "relative_path") + " — " + RequiredText(raw, "reason"));
            var totalBytes = Json.Number(retained, "total_bytes");
            if (totalBytes < 0 || totalBytes != observedBytes)
                throw new InvalidOperationException("The cleanup preview byte total is inconsistent. Refresh before changing retained data.");
            if (entries.Count == 0)
                entries.Add("The retained private folder is empty.");

            var previewSha256 = RequiredText(value, "preview_sha256");
            if (!IsSha256(previewSha256))
                throw new InvalidOperationException("The cleanup preview has an invalid fingerprint. Refresh before changing retained data.");
            return new PreparationCleanupReview
            {
                OperationId = operationId,
                PortId = portId,
                RetainedPath = RequiredPath(value, "retained_path"),
                OriginalInstallPath = RequiredPath(value, "original_install_path"),
                SourcePath = RequiredPath(value, "source_path"),
                PersistentDataPath = RequiredPath(value, "persistent_data_path"),
                BackupPath = RequiredPath(value, "backup_path"),
                LogsPath = RequiredPath(value, "logs_path"),
                CleanupIsIrreversible = Json.Boolean(value, "cleanup_is_irreversible"),
                InterruptedCleanupWillRetry = Json.Boolean(value, "interrupted_cleanup_will_retry"),
                PreviewSha256 = previewSha256,
                AffectedEntries = entries.ToArray(),
                TotalBytes = totalBytes
            };
        }

        internal string Confirmation(int position, int count) =>
            "Discard this exact retained private preparation?" + (count == 1 ? "" : " This is " + position + " of " + count + " retained attempts; repeat this action to review another.") +
            "\n\nRetained folder: " + RetainedPath + "\nAffected entries:\n" + string.Join("\n", AffectedEntries) +
            "\nTotal file bytes: " + TotalBytes +
            "\n\nPreserved original installation: " + OriginalInstallPath +
            "\nPreserved registered source: " + SourcePath +
            "\nPreserved saved data: " + PersistentDataPath +
            "\nPreserved backups: " + BackupPath +
            "\nPreserved logs: " + LogsPath +
            "\n\nIrreversible: " + (CleanupIsIrreversible ? "yes; removed private files cannot be recovered." : "no.") +
            "\nInterrupted cleanup will retry: " + (InterruptedCleanupWillRetry ? "yes." : "no; inspect repair state before another action.") +
            "\nEnsure any external setup process from this failed attempt has stopped before continuing.";
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
        internal const int Schema = 48;
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
                    throw new InvalidOperationException("Unsupported Portcove response. This client requires API schema 42 through 48; install a matching CLI/client pair.");
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
            var schema = Json.Number(capabilities, "schema_version");
            if (!SupportedSchema(schema) || Json.Text(capabilities, "product") != "Portcove")
                throw new InvalidOperationException("This reference client requires Portcove API schema 42 through 48. Select a compatible CLI or update the client.");
            var commands = Json.Array(Json.Field(capabilities, "commands")).OfType<string>().ToArray();
            foreach (var required in new[] { "catalog", "source", "status", "activity", "cancel", "library.identity", "launch.show", "exec", "ensure", "update", "preparation" })
                if (!commands.Contains(required)) throw new InvalidOperationException("The CLI lacks " + required + ". Select a compatible standalone Portcove CLI.");
            if (schema >= 48 && !commands.Contains("preparation.cleanup"))
                throw new InvalidOperationException("The schema-48 CLI lacks preparation.cleanup. Select a complete matching CLI or update the client.");
            var formats = Json.Array(Json.Field(capabilities, "machine_formats")).OfType<string>();
            if (!formats.Contains("json") || !formats.Contains("jsonl") || !Json.Array(Json.Field(capabilities, "raw_stream_commands")).Contains("exec"))
                throw new InvalidOperationException("The CLI lacks the required JSON/JSONL and raw supervised launch contracts.");
        }
    }
}
