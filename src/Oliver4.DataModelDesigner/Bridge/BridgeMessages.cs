using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Oliver4.DataModelDesigner.Bridge
{
    /// <summary>A call from the canvas to the host.</summary>
    public class BridgeRequest
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("method")] public string Method { get; set; }
        [JsonProperty("payload")] public JObject Payload { get; set; }
    }

    /// <summary>The host's reply to a <see cref="BridgeRequest"/>.</summary>
    public class BridgeResponse
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("ok")] public bool Ok { get; set; }
        [JsonProperty("payload")] public object Payload { get; set; }
        [JsonProperty("error")] public string Error { get; set; }
        [JsonProperty("errorDetail")] public string ErrorDetail { get; set; }
    }

    /// <summary>An unsolicited message from the host, such as progress or a connection change.</summary>
    public class BridgeEvent
    {
        [JsonProperty("event")] public string Event { get; set; }
        [JsonProperty("payload")] public object Payload { get; set; }
    }

    /// <summary>Method names shared with the JavaScript side. Keep in step with js/bridge.js.</summary>
    public static class BridgeMethods
    {
        /// <summary>Tool name, version and copyright, for the About dialog on the canvas.</summary>
        public const string AppInfo = "app.info";

        public const string GetConnection = "connection.get";
        public const string ListSolutions = "solutions.list";
        public const string ListTables = "tables.list";
        public const string LoadTables = "tables.load";

        /// <summary>Relationships where both ends are inside a set of tables the caller names.</summary>
        public const string DiscoverRelationships = "relationships.discover";

        /// <summary>Breadth-first walk out from one table to a chosen depth.</summary>
        public const string ExploreGraph = "relationships.explore";

        /// <summary>What a delete or an assign on one table's records reaches, following cascade.</summary>
        public const string AnalyseCascade = "cascade.analyse";

        public const string FindPaths = "paths.find";

        public const string DiagramOpen = "diagram.open";
        public const string DiagramSave = "diagram.save";
        public const string DiagramRefresh = "diagram.refresh";
        public const string DiagramPromote = "diagram.promote";

        public const string ExportRun = "export.run";

        public const string SettingsGet = "settings.get";
        public const string SettingsSave = "settings.save";

        public const string UiMessage = "ui.message";
        public const string UiConfirm = "ui.confirm";
        public const string UiOpenUrl = "ui.openUrl";
        public const string UiDirty = "ui.dirty";

        /// <summary>
        /// Stop a request that is still running, named by its request id.
        ///
        /// Answered in ModelDesignerControl rather than in HostBridge. The cancellation token
        /// sources live with the control that created them, and this has to be handled while the
        /// request it is cancelling is still in flight - so it must not be dispatched through the
        /// same path, where it would be one more piece of work rather than the end of one.
        /// </summary>
        public const string CancelWork = "work.cancel";
    }

    /// <summary>Event names pushed from the host to the canvas.</summary>
    public static class BridgeEvents
    {
        public const string Progress = "progress";
        public const string ProgressDone = "progress.done";
        public const string ConnectionChanged = "connection.changed";
        public const string OpenDocument = "document.open";
        public const string Command = "command";
    }
}
