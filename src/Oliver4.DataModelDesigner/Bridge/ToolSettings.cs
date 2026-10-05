using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Oliver4.DataModelDesigner.Services;

namespace Oliver4.DataModelDesigner.Bridge
{
    /// <summary>
    /// Preferences that outlive a single diagram, stored by the XrmToolBox settings manager.
    /// Nothing environment-specific belongs here; it is shared across all connections.
    /// </summary>
    public class ToolSettings
    {
        [JsonProperty("lastDiagramFolder")] public string LastDiagramFolder { get; set; }
        [JsonProperty("lastExportFolder")] public string LastExportFolder { get; set; }

        [JsonProperty("recentFiles")] public List<string> RecentFiles { get; set; } = new List<string>();

        /// <summary>Starting point for the depth-discovery dialog.</summary>
        [JsonProperty("defaultDiscovery")] public DiscoveryOptions DefaultDiscovery { get; set; } = new DiscoveryOptions();

        /// <summary>"light" or "dark". Applies to the tool's own canvas, not to XrmToolBox.</summary>
        [JsonProperty("theme")] public string Theme { get; set; } = "light";

        [JsonProperty("showWelcomeOnStart")] public bool ShowWelcomeOnStart { get; set; } = true;
        [JsonProperty("confirmBeforeClosingUnsaved")] public bool ConfirmBeforeClosingUnsaved { get; set; } = true;
        [JsonProperty("leftPanelWidth")] public int LeftPanelWidth { get; set; } = 288;
        [JsonProperty("inspectorWidth")] public int InspectorWidth { get; set; } = 320;
        [JsonProperty("suppressedWarnings")] public List<string> SuppressedWarnings { get; set; } = new List<string>();

        public void AddRecentFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            if (RecentFiles == null) RecentFiles = new List<string>();

            RecentFiles.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            RecentFiles.Insert(0, path);

            while (RecentFiles.Count > 10) RecentFiles.RemoveAt(RecentFiles.Count - 1);
        }

        /// <summary>Drops an entry, used when a recent file turns out to have gone.</summary>
        public void RemoveRecentFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || RecentFiles == null) return;
            RecentFiles.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>
        /// Takes the preferences the canvas owns from a settings blob the canvas has posted.
        ///
        /// Not a full copy. RecentFiles, LastDiagramFolder and LastExportFolder are written by the
        /// host - opening a diagram, saving one, running an export all update them - but the canvas
        /// only re-reads settings at boot and after a save, so the blob it posts can carry stale
        /// values for those three. Copying them back would silently revert them on something as
        /// small as toggling dark mode, so the host is their sole writer.
        /// </summary>
        public void CopyFrom(ToolSettings other)
        {
            if (other == null) return;

            DefaultDiscovery = other.DefaultDiscovery ?? DefaultDiscovery;
            Theme = string.IsNullOrWhiteSpace(other.Theme) ? Theme : other.Theme;
            ShowWelcomeOnStart = other.ShowWelcomeOnStart;
            ConfirmBeforeClosingUnsaved = other.ConfirmBeforeClosingUnsaved;
            LeftPanelWidth = other.LeftPanelWidth > 0 ? other.LeftPanelWidth : LeftPanelWidth;
            InspectorWidth = other.InspectorWidth > 0 ? other.InspectorWidth : InspectorWidth;
            SuppressedWarnings = other.SuppressedWarnings ?? SuppressedWarnings;
        }

        /// <summary>
        /// Recent files that still exist on disk.
        ///
        /// A method rather than a property: XrmToolBox persists tool settings with
        /// XmlSerializer, which throws on a read-only property of an interface type.
        /// </summary>
        public List<string> GetExistingRecentFiles()
        {
            return (RecentFiles ?? new List<string>()).Where(System.IO.File.Exists).ToList();
        }
    }

    /// <summary>Assembly-level identity shared with the UI and saved into diagram files.</summary>
    public static class PluginInfo
    {
        public const string ToolName = "Oliver4 Data Model Designer";
        public const string Company = "Oliver4";
        public const string Copyright = "© 2026 Oliver4 Data Model Designer";
        public const string RepositoryOwner = "oliver4-devtools";
        public const string RepositoryName = "data-model-designer";
        public const string HelpUrl = "https://github.com/oliver4-devtools/data-model-designer#readme";

        /// <summary>
        /// Three-part version: major.minor.patch. The assembly version is four-part because the
        /// CLR requires it, but a trailing ".0" on every release note and About box is noise, so
        /// everything user-facing - the About dialog and the ToolVersion stamped into a .dvmd
        /// file - uses this.
        /// </summary>
        public static string Version
        {
            get
            {
                var version = typeof(PluginInfo).Assembly.GetName().Version;
                if (version == null) return "1.2.0";

                return version.Major + "." + version.Minor + "." + Math.Max(0, version.Build);
            }
        }
    }
}
