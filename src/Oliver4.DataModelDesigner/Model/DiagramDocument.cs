using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;

namespace Oliver4.DataModelDesigner.Model
{
    /// <summary>
    /// The editable diagram. This object is the single source of truth for a design and is
    /// what gets written to a .dvmd file. The web canvas holds the same shape in JavaScript,
    /// so the JSON contract on both sides must stay in step.
    /// </summary>
    public class DiagramDocument
    {
        /// <summary>
        /// Incremented whenever the persisted shape changes in a way older builds cannot read.
        /// <see cref="DiagramFile"/> refuses to open a file written by a newer format version, and
        /// upgrades anything older on the way in (see DiagramFile.Upgrade).
        ///
        /// Version 2 (tool 1.3.0) has no displayProfile setting and no DBML or JSON export formats.
        /// </summary>
        public const int CurrentFormatVersion = 2;

        [JsonProperty("formatVersion")]
        public int FormatVersion { get; set; } = CurrentFormatVersion;

        [JsonProperty("id")]
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        [JsonProperty("title")]
        public string Title { get; set; } = "Untitled diagram";

        [JsonProperty("description")]
        public string Description { get; set; }

        [JsonProperty("createdUtc")]
        public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

        [JsonProperty("modifiedUtc")]
        public DateTime ModifiedUtc { get; set; } = DateTime.UtcNow;

        [JsonProperty("toolVersion")]
        public string ToolVersion { get; set; }

        /// <summary>Identifies the environment the existing metadata came from.</summary>
        [JsonProperty("source")]
        public DiagramSource Source { get; set; } = new DiagramSource();

        [JsonProperty("settings")]
        public DiagramSettings Settings { get; set; } = new DiagramSettings();

        [JsonProperty("view")]
        public ViewState View { get; set; } = new ViewState();

        [JsonProperty("tables")]
        public List<DiagramTable> Tables { get; set; } = new List<DiagramTable>();

        [JsonProperty("relationships")]
        public List<DiagramRelationship> Relationships { get; set; } = new List<DiagramRelationship>();

        [JsonProperty("annotations")]
        public List<DiagramAnnotation> Annotations { get; set; } = new List<DiagramAnnotation>();
        public DiagramTable FindTableById(string id)
        {
            return Tables.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.Ordinal));
        }
        public DiagramTable FindExistingTable(string logicalName)
        {
            if (string.IsNullOrEmpty(logicalName)) return null;
            return Tables.FirstOrDefault(t =>
                t.Status != ObjectStatus.Proposed &&
                string.Equals(t.LogicalName, logicalName, StringComparison.OrdinalIgnoreCase));
        }
    }

    /// <summary>
    /// Enough information to recognise the source environment on a later refresh, and to warn
    /// the user when they open a diagram while connected somewhere else.
    /// </summary>
    public class DiagramSource
    {
        [JsonProperty("environmentUrl")]
        public string EnvironmentUrl { get; set; }

        [JsonProperty("organizationFriendlyName")]
        public string OrganizationFriendlyName { get; set; }

        [JsonProperty("organizationId")]
        public string OrganizationId { get; set; }

        [JsonProperty("organizationVersion")]
        public string OrganizationVersion { get; set; }

        [JsonProperty("solutionUniqueName")]
        public string SolutionUniqueName { get; set; }

        [JsonProperty("lastRefreshUtc")]
        public DateTime? LastRefreshUtc { get; set; }
    }

    /// <summary>Canvas viewport, saved so a diagram reopens where the user left it.</summary>
    public class ViewState
    {
        [JsonProperty("zoom")]
        public double Zoom { get; set; } = 1.0;

        [JsonProperty("panX")]
        public double PanX { get; set; }

        [JsonProperty("panY")]
        public double PanY { get; set; }
    }

    /// <summary>
    /// Display settings for the whole diagram. Individual tables may override
    /// <see cref="FieldDetail"/> through <see cref="DiagramTable.DetailOverride"/>.
    /// </summary>
    public class DiagramSettings
    {
        [JsonProperty("fieldDetail")]
        [JsonConverter(typeof(Newtonsoft.Json.Converters.StringEnumConverter))]
        public FieldDetailMode FieldDetail { get; set; } = FieldDetailMode.RelationshipFields;

        [JsonProperty("layoutMode")]
        [JsonConverter(typeof(Newtonsoft.Json.Converters.StringEnumConverter))]
        public LayoutMode LayoutMode { get; set; } = LayoutMode.Auto;

        [JsonProperty("autoLayoutOnAdd")]
        public bool AutoLayoutOnAdd { get; set; } = true;

        [JsonProperty("fieldOrder")]
        public string FieldOrder { get; set; } = "metadata";

        // --- independent display toggles ------------------------------------

        [JsonProperty("showTableDisplayName")]
        public bool ShowTableDisplayName { get; set; } = true;

        [JsonProperty("showTableSchemaName")]
        public bool ShowTableSchemaName { get; set; } = true;

        [JsonProperty("showFieldDisplayName")]
        public bool ShowFieldDisplayName { get; set; }

        [JsonProperty("showFieldSchemaName")]
        public bool ShowFieldSchemaName { get; set; } = true;

        [JsonProperty("showFieldType")]
        public bool ShowFieldType { get; set; } = true;

        [JsonProperty("showPrimaryKey")]
        public bool ShowPrimaryKey { get; set; } = true;

        [JsonProperty("showForeignKey")]
        public bool ShowForeignKey { get; set; } = true;

        [JsonProperty("showRelationshipName")]
        public bool ShowRelationshipName { get; set; }

        [JsonProperty("showCardinality")]
        public bool ShowCardinality { get; set; } = true;

        /// <summary>
        /// Off by default. Full cascade detail on every connector makes a diagram unreadable;
        /// the relationship inspector always shows it in full.
        /// </summary>
        [JsonProperty("showCascade")]
        public bool ShowCascade { get; set; }

        [JsonProperty("showStatusBadges")]
        public bool ShowStatusBadges { get; set; } = true;

        [JsonProperty("showLegend")]
        public bool ShowLegend { get; set; } = true;

        /// <summary>
        /// Where the legend has been dragged to, in CSS pixels from the top-left of the window.
        /// Null - the default - means the bottom-right corner the stylesheet puts it in, which is
        /// what every diagram written before 1.8.0 means too.
        ///
        /// A diagram setting rather than a tool preference: it is part of how this drawing is laid
        /// out, so it travels with the file the way the view and the grid do. Purely additive, so
        /// the file format version stays at 2 - a build that does not know the properties ignores
        /// them and draws the legend in the default corner.
        ///
        /// Held in window coordinates rather than diagram ones because the legend is furniture: it
        /// does not pan or zoom with the drawing. The canvas clamps the point into the window when
        /// it draws, so a position saved on a large display is still reachable on a small one.
        /// </summary>
        [JsonProperty("legendX")]
        public double? LegendX { get; set; }

        [JsonProperty("legendY")]
        public double? LegendY { get; set; }

        [JsonProperty("showGrid")]
        public bool ShowGrid { get; set; } = true;

        [JsonProperty("showTitleBlock")]
        public bool ShowTitleBlock { get; set; } = true;

        [JsonProperty("showAlternateKeys")]
        public bool ShowAlternateKeys { get; set; }

        /// <summary>
        /// Marks each card with how its records are owned. Off by default: it is a security
        /// question rather than a data-model one, and it is noise on a diagram drawn for any other
        /// purpose. It is a marker rather than a recolour because the four status colours are
        /// load-bearing and tinting cards by ownership as well would make neither readable.
        /// </summary>
        [JsonProperty("showOwnership")]
        public bool ShowOwnership { get; set; }

        /// <summary>
        /// What the user calls each emphasis colour, keyed by lower-case hex.
        ///
        /// A colour applied by hand stands for something - a phase, a workstream, an owning team -
        /// and naming it puts that meaning in the legend and in every export.
        ///
        /// A diagram setting rather than a tool preference: the scheme is part of the design, so
        /// it travels with the .dvmd file. Purely additive, so the format version stays at 2 - a
        /// build that does not know the property simply ignores it.
        /// </summary>
        [JsonProperty("emphasisNames")]
        public Dictionary<string, string> EmphasisNames { get; set; } = new Dictionary<string, string>();
    }
}
