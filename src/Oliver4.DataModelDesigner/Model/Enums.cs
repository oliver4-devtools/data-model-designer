using System;

namespace Oliver4.DataModelDesigner.Model
{
    /// <summary>
    /// Lifecycle status of a diagram object. Status is a diagram-level concept only.
    /// Nothing in this tool ever writes back to Dataverse, so marking an object
    /// Deprecated or Proposed has no effect on the environment.
    /// </summary>
    public enum ObjectStatus
    {
        /// <summary>Present in the connected environment's metadata.</summary>
        Existing = 0,

        /// <summary>Intended future Dataverse object, entered by the user.</summary>
        Proposed = 1,

        /// <summary>Conceptual object outside Dataverse (ERP, warehouse, API-owned store).</summary>
        External = 2,

        /// <summary>Existing object the user has marked as planned for retirement.</summary>
        Deprecated = 3
    }

    /// <summary>Cardinality of a relationship as rendered on the canvas.</summary>
    public enum RelationshipKind
    {
        OneToMany = 0,
        ManyToOne = 1,
        ManyToMany = 2
    }

    /// <summary>How much column detail is rendered inside each table card.</summary>
    public enum FieldDetailMode
    {
        /// <summary>Table names only, no column rows.</summary>
        TablesOnly = 0,

        /// <summary>Primary keys plus the lookup columns behind visible relationships.</summary>
        RelationshipFields = 1,

        /// <summary>All columns flagged for display.</summary>
        AllFields = 2
    }

    /// <summary>
    /// Automatic layout algorithms offered by the canvas. Horizontal lays the layers out along
    /// the x axis and packs each layer tightly.
    /// </summary>
    public enum LayoutMode
    {
        Manual = 0,
        Auto = 1,
        Horizontal = 2,
        Vertical = 3,
        Hierarchical = 4,
        Grid = 5
    }

    /// <summary>
    /// Formats the export pipeline can produce. Every value here must also appear in the canvas
    /// export dialog (Web/js/exporter.js), otherwise the user has no way to select it.
    /// </summary>
    public enum ExportFormat
    {
        Png = 0,
        Svg = 1,
        DrawIo = 2,
        Visio = 3,
        Mermaid = 4,

        /// <summary>The data-model section of a design document, as Azure DevOps wiki markdown.</summary>
        DocumentationMarkdown = 5,

        /// <summary>The same document as a self-contained HTML page that prints.</summary>
        DocumentationHtml = 6
    }
}
