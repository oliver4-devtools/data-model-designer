using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Oliver4.DataModelDesigner.Export;
using Oliver4.DataModelDesigner.Metadata;
using Oliver4.DataModelDesigner.Model;
using Oliver4.DataModelDesigner.Services;

namespace Oliver4.DataModelDesigner.Bridge
{
    /// <summary>
    /// Everything the canvas is allowed to ask the host to do. The canvas never touches Dataverse
    /// or the file system itself; it posts a method name and a payload, and gets JSON back.
    /// </summary>
    public interface IHostServices
    {
        MetadataService Metadata { get; }
        ConnectionInfo Connection { get; }
        ToolSettings Settings { get; }

        void SaveSettings();
        void ReportProgress(string message, int percent);
        void ProgressDone();

        /// <summary>Shows a save dialog on the UI thread. Returns null when the user cancels.</summary>
        string PromptSaveFile(string filter, string defaultFileName, string initialDirectory);

        /// <summary>Shows an open dialog on the UI thread. Returns null when the user cancels.</summary>
        string PromptOpenFile(string filter, string initialDirectory);

        void ShowMessage(string level, string text);
        bool Confirm(string caption, string text);
        void OpenUrl(string url);
        void SetDirty(bool dirty, string title);
    }

    /// <summary>Dispatches bridge calls. Every handler runs off the UI thread.</summary>
    public class HostBridge
    {
        private readonly IHostServices _host;

        public HostBridge(IHostServices host)
        {
            _host = host ?? throw new ArgumentNullException(nameof(host));
        }

        /// <summary>
        /// True for the methods whose answer only means anything for the environment they were
        /// started against, so the host can refuse to deliver a stale one after the connection has
        /// changed underneath it.
        ///
        /// Not every method. diagram.open, diagram.save and export.run block on a
        /// modal file dialog, so a connection change while one is on screen is ordinary and
        /// fencing them would abort a save the user had just confirmed. The rest touch no
        /// environment at all.
        /// </summary>
        public static bool IsEnvironmentSensitive(string method)
        {
            switch (method)
            {
                case BridgeMethods.ListSolutions:
                case BridgeMethods.ListTables:
                case BridgeMethods.LoadTables:
                case BridgeMethods.DiscoverRelationships:
                case BridgeMethods.ExploreGraph:
                case BridgeMethods.AnalyseCascade:
                case BridgeMethods.FindPaths:
                case BridgeMethods.DiagramRefresh:
                case BridgeMethods.DiagramPromote:
                    return true;

                default:
                    return false;
            }
        }

        public object Handle(BridgeRequest request, CancellationToken cancellation)
        {
            var payload = request.Payload ?? new JObject();

            switch (request.Method)
            {
                case BridgeMethods.AppInfo:
                    return new
                    {
                        toolName = PluginInfo.ToolName,
                        version = PluginInfo.Version,
                        company = PluginInfo.Company,
                        copyright = PluginInfo.Copyright,
                        helpUrl = PluginInfo.HelpUrl
                    };

                case BridgeMethods.GetConnection:
                    return _host.Connection;

                case BridgeMethods.ListSolutions:
                    return RequireMetadata().GetSolutions();

                case BridgeMethods.ListTables:
                    return ListTables(payload);

                case BridgeMethods.LoadTables:
                    return LoadTables(payload, cancellation);

                case BridgeMethods.DiscoverRelationships:
                    return RequireMetadata().GetRelationshipsWithin(StringList(payload, "logicalNames"), cancellation);

                case BridgeMethods.ExploreGraph:
                    return Explore(payload, cancellation);

                case BridgeMethods.AnalyseCascade:
                    return AnalyseCascade(payload, cancellation);

                case BridgeMethods.FindPaths:
                    return NewDiscoveryService().FindPaths(
                        (string)payload["from"],
                        (string)payload["to"],
                        (int?)payload["maxDepth"] ?? 4,
                        (int?)payload["maxPaths"] ?? 10,
                        cancellation);

                case BridgeMethods.DiagramOpen:
                    return OpenDiagram(payload);

                case BridgeMethods.DiagramSave:
                    return SaveDiagram(payload);

                case BridgeMethods.DiagramRefresh:
                    return new RefreshService(RequireMetadata(), _host.ReportProgress)
                        .Refresh(DocumentFrom(payload), cancellation);

                case BridgeMethods.DiagramPromote:
                    return new RefreshService(RequireMetadata()).Promote(
                        DocumentFrom(payload),
                        payload["promotions"]?.ToObject<List<PromotionInstruction>>());

                case BridgeMethods.ExportRun:
                    return RunExport(payload);

                case BridgeMethods.SettingsGet:
                    return _host.Settings;

                case BridgeMethods.SettingsSave:
                    ApplySettings(payload);
                    return new { saved = true };

                case BridgeMethods.UiMessage:
                    _host.ShowMessage((string)payload["level"] ?? "info", (string)payload["text"] ?? string.Empty);
                    return new { shown = true };

                case BridgeMethods.UiConfirm:
                    return new { confirmed = _host.Confirm((string)payload["caption"] ?? "Confirm", (string)payload["text"] ?? string.Empty) };

                case BridgeMethods.UiOpenUrl:
                    _host.OpenUrl((string)payload["url"]);
                    return new { opened = true };

                case BridgeMethods.UiDirty:
                    _host.SetDirty((bool?)payload["dirty"] ?? false, (string)payload["title"]);
                    return new { ok = true };

                default:
                    throw new NotSupportedException("Unknown bridge method: " + request.Method);
            }
        }

        // ------------------------------------------------------------------

        private object ListTables(JObject payload)
        {
            var metadata = RequireMetadata();
            var catalogue = metadata.GetCatalogue();

            var solutionId = (string)payload["solutionId"];
            if (string.IsNullOrWhiteSpace(solutionId)) return catalogue;

            Guid parsed;
            if (!Guid.TryParse(solutionId, out parsed)) return catalogue;

            var ids = metadata.GetSolutionTableIds(parsed);
            return catalogue.Where(t =>
            {
                Guid metadataId;
                return Guid.TryParse(t.MetadataId, out metadataId) && ids.Contains(metadataId);
            }).ToList();
        }

        private object LoadTables(JObject payload, CancellationToken cancellation)
        {
            List<string> unreadable;
            var tables = RequireMetadata()
                .GetTables(StringList(payload, "logicalNames"), out unreadable, cancellation);

            return new { tables, unreadable };
        }

        private object Explore(JObject payload, CancellationToken cancellation)
        {
            var options = payload["options"]?.ToObject<DiscoveryOptions>()
                ?? new DiscoveryOptions();

            // A user can ask for unrestricted depth, but not for an unrestricted number of live
            // metadata calls: every table in the frontier is one round trip.
            if (options.MaxTables <= 0 || options.MaxTables > 400) options.MaxTables = 400;
            if (options.Depth > 8) options.Depth = 8;

            return NewDiscoveryService().Discover(options, cancellation);
        }

        private object AnalyseCascade(JObject payload, CancellationToken cancellation)
        {
            var options = payload["options"]?.ToObject<CascadeOptions>() ?? new CascadeOptions();

            return new CascadeService(RequireMetadata(), _host.ReportProgress)
                .Analyse(options, cancellation);
        }

        private object OpenDiagram(JObject payload)
        {
            var path = (string)payload["path"];

            // Passed explicitly rather than inferred from "a path was supplied", so a caller that
            // passes a path for another reason - a drag and drop, a reopen-last-diagram - does not
            // have an unrelated recent entry pruned on its behalf.
            var fromRecent = (bool?)payload["fromRecent"] ?? false;

            if (string.IsNullOrWhiteSpace(path))
            {
                path = _host.PromptOpenFile(DiagramFile.FilterText, _host.Settings.LastDiagramFolder);
                if (string.IsNullOrWhiteSpace(path)) return new { cancelled = true };
            }

            DiagramLoadResult loaded;
            try
            {
                loaded = DiagramFile.LoadWithNotes(path);
            }
            catch (FileNotFoundException) when (fromRecent)
            {
                // A recent-files entry pointing at something that has been moved or deleted is a
                // dead menu item, not an error worth a dialog. Drop it and say so.
                _host.Settings.RemoveRecentFile(path);
                _host.SaveSettings();

                throw new FileNotFoundException(
                    "That diagram is no longer at " + path + ", so it has been removed from the " +
                    "recent list. Use Open diagram to find it if it has moved.", path);
            }

            _host.Settings.LastDiagramFolder = Path.GetDirectoryName(path);
            _host.Settings.AddRecentFile(path);
            _host.SaveSettings();

            return new
            {
                cancelled = false,
                path,
                document = loaded.Document,
                notes = loaded.Notes,
                upgradedFromVersion = loaded.UpgradedFromVersion,
                environmentMismatch = IsEnvironmentMismatch(loaded.Document)
            };
        }

        private object SaveDiagram(JObject payload)
        {
            var document = DocumentFrom(payload);
            var path = (string)payload["path"];
            var saveAs = (bool?)payload["saveAs"] ?? false;

            if (saveAs || string.IsNullOrWhiteSpace(path))
            {
                var suggested = SanitiseFileName(document.Title) + DiagramFile.Extension;
                path = _host.PromptSaveFile(DiagramFile.FilterText, suggested, _host.Settings.LastDiagramFolder);
                if (string.IsNullOrWhiteSpace(path)) return new { cancelled = true };
            }

            document.ToolVersion = PluginInfo.Version;
            DiagramFile.Save(document, path);

            _host.Settings.LastDiagramFolder = Path.GetDirectoryName(path);
            _host.Settings.AddRecentFile(path);
            _host.SaveSettings();
            _host.SetDirty(false, document.Title);

            return new { cancelled = false, path, savedUtc = DateTime.UtcNow };
        }

        private object RunExport(JObject payload)
        {
            var request = payload.ToObject<ExportRequest>(JsonSerializer.Create(DiagramFile.SerializerSettings));
            if (request?.Document == null)
                throw new InvalidOperationException("The export request did not include a diagram.");

            var product = ExportService.Build(request);

            var path = request.Path;
            if (string.IsNullOrWhiteSpace(path))
            {
                var suggested = SanitiseFileName(request.Document.Title) + ExportService.DefaultExtension(request.Format);
                path = _host.PromptSaveFile(
                    ExportService.FileFilter(request.Format), suggested, _host.Settings.LastExportFolder);

                if (string.IsNullOrWhiteSpace(path))
                    return new ExportResponse { Cancelled = true };
            }

            ExportService.Write(product, path);

            _host.Settings.LastExportFolder = Path.GetDirectoryName(path);
            _host.SaveSettings();

            return new ExportResponse
            {
                Path = path,
                Warnings = product.Warnings ?? new List<string>(),
                Cancelled = false
            };
        }

        private void ApplySettings(JObject payload)
        {
            var incoming = payload["settings"]?.ToObject<ToolSettings>();
            if (incoming == null) return;

            _host.Settings.CopyFrom(incoming);
            _host.SaveSettings();
        }

        // ------------------------------------------------------------------

        private MetadataService RequireMetadata()
        {
            var metadata = _host.Metadata;
            if (metadata == null)
            {
                throw new InvalidOperationException(
                    "This needs a Dataverse connection. Use the connection bar at the top of " +
                    "XrmToolBox to pick an environment, then try again. Everything that does not " +
                    "read metadata - layout, proposed objects, notes, saving and export - keeps " +
                    "working without one.");
            }

            return metadata;
        }

        private DiscoveryService NewDiscoveryService()
        {
            return new DiscoveryService(RequireMetadata(), _host.ReportProgress);
        }

        private bool IsEnvironmentMismatch(DiagramDocument document)
        {
            var source = document?.Source;
            var connection = _host.Connection;

            if (source == null || connection == null || !connection.Connected) return false;
            if (string.IsNullOrWhiteSpace(source.OrganizationId)) return false;
            if (string.IsNullOrWhiteSpace(connection.OrganizationId)) return false;

            return !string.Equals(source.OrganizationId, connection.OrganizationId, StringComparison.OrdinalIgnoreCase);
        }

        private static DiagramDocument DocumentFrom(JObject payload)
        {
            var token = payload["document"];
            if (token == null)
                throw new InvalidOperationException("The request did not include a diagram document.");

            var document = token.ToObject<DiagramDocument>(JsonSerializer.Create(DiagramFile.SerializerSettings));
            if (document == null)
                throw new InvalidOperationException("The diagram document could not be read.");

            return document;
        }

        private static List<string> StringList(JObject payload, string property)
        {
            var token = payload[property];
            return token == null ? new List<string>() : token.ToObject<List<string>>();
        }

        private static string SanitiseFileName(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "diagram";
            var invalid = Path.GetInvalidFileNameChars();
            var cleaned = new string(value.Where(c => !invalid.Contains(c)).ToArray()).Trim();
            return cleaned.Length == 0 ? "diagram" : cleaned;
        }
    }
}
