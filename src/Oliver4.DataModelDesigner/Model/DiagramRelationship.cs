using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace Oliver4.DataModelDesigner.Model
{
    /// <summary>
    /// A connector on the canvas. Multiple relationships between the same pair of tables are
    /// always kept as separate objects - the diagram never collapses them into one line.
    /// </summary>
    public class DiagramRelationship
    {
        [JsonProperty("id")]
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        [JsonProperty("schemaName")]
        public string SchemaName { get; set; }

        [JsonProperty("displayName")]
        public string DisplayName { get; set; }

        [JsonProperty("kind")]
        [JsonConverter(typeof(StringEnumConverter))]
        public RelationshipKind Kind { get; set; } = RelationshipKind.OneToMany;

        [JsonProperty("status")]
        [JsonConverter(typeof(StringEnumConverter))]
        public ObjectStatus Status { get; set; } = ObjectStatus.Existing;

        /// <summary>Diagram id of the table on the "one" end (the referenced table).</summary>
        [JsonProperty("fromTableId")]
        public string FromTableId { get; set; }

        /// <summary>Diagram id of the table on the "many" end (the referencing table).</summary>
        [JsonProperty("toTableId")]
        public string ToTableId { get; set; }

        // --- Dataverse facts ----------------------------------------------

        [JsonProperty("metadataId")]
        public string MetadataId { get; set; }

        [JsonProperty("referencedEntity")]
        public string ReferencedEntity { get; set; }

        [JsonProperty("referencingEntity")]
        public string ReferencingEntity { get; set; }

        [JsonProperty("referencedAttribute")]
        public string ReferencedAttribute { get; set; }

        /// <summary>The lookup column that physically creates the relationship.</summary>
        [JsonProperty("referencingAttribute")]
        public string ReferencingAttribute { get; set; }

        [JsonProperty("intersectEntity")]
        public string IntersectEntity { get; set; }

        [JsonProperty("entity1IntersectAttribute")]
        public string Entity1IntersectAttribute { get; set; }

        [JsonProperty("entity2IntersectAttribute")]
        public string Entity2IntersectAttribute { get; set; }

        [JsonProperty("isCustom")]
        public bool IsCustom { get; set; }

        [JsonProperty("isManaged")]
        public bool IsManaged { get; set; }

        [JsonProperty("isHierarchical")]
        public bool IsHierarchical { get; set; }

        /// <summary>True when the lookup behind this relationship can point at several tables.</summary>
        [JsonProperty("isPolymorphic")]
        public bool IsPolymorphic { get; set; }

        [JsonProperty("lookupTargets")]
        public List<string> LookupTargets { get; set; } = new List<string>();

        [JsonProperty("cascade")]
        public CascadeConfiguration Cascade { get; set; }

        /// <summary>Free text for a proposed relationship's intended cascade behaviour.</summary>
        [JsonProperty("cascadeNotes")]
        public string CascadeNotes { get; set; }

        // --- diagram state -------------------------------------------------

        /// <summary>
        /// Legacy file property. False means the relationship is excluded: kept in the file but not
        /// drawn, the same as <see cref="Hidden"/>. It stays on the model so older .dvmd files still
        /// read, and DiagramFile.Normalise turns an excluded relationship into a hidden one, so
        /// anything loaded through it has this true.
        ///
        /// The export filters test it alongside <see cref="Hidden"/>, because a document can reach
        /// them from the canvas without passing through Normalise, and an excluded relationship
        /// must stay out of the exports either way.
        /// </summary>
        [JsonProperty("included")]
        public bool Included { get; set; } = true;

        /// <summary>
        /// The user has taken it off the canvas: it stays in the file, carrying its notes and
        /// routing, but is not drawn and is not exported.
        /// </summary>
        [JsonProperty("hidden")]
        public bool Hidden { get; set; }

        [JsonProperty("highlight")]
        public string Highlight { get; set; }

        [JsonProperty("notes")]
        public string Notes { get; set; }

        /// <summary>Manual routing points in canvas coordinates. Empty means auto-route.</summary>
        [JsonProperty("waypoints")]
        public List<PointD> Waypoints { get; set; } = new List<PointD>();

        /// <summary>
        /// How far the user dragged the connector's middle segment away from its automatic
        /// position, in canvas units. The two end anchors never move, so this only separates
        /// connectors that would otherwise sit on top of each other.
        /// </summary>
        [JsonProperty("routeOffset")]
        public double RouteOffset { get; set; }

        /// <summary>
        /// How far the user dragged the middle of the connector across its own axis - the other
        /// direction from <see cref="RouteOffset"/>. Together the two move the middle of a route
        /// anywhere on the canvas while both end anchors stay on the columns they point at.
        ///
        /// Additive, so the file format version does not change: a build that does not know it
        /// ignores it and draws the route with the offset at zero.
        /// </summary>
        [JsonProperty("routeOffsetCross")]
        public double RouteOffsetCross { get; set; }

        [JsonProperty("missingSinceRefresh")]
        public bool MissingSinceRefresh { get; set; }
    }

    /// <summary>
    /// Dataverse cascade behaviour. Values are the metadata enum names, for example
    /// "Cascade", "NoCascade", "Active", "UserOwned", "RemoveLink", "Restrict".
    /// </summary>
    public class CascadeConfiguration
    {
        [JsonProperty("assign")]
        public string Assign { get; set; }

        [JsonProperty("delete")]
        public string Delete { get; set; }

        [JsonProperty("merge")]
        public string Merge { get; set; }

        [JsonProperty("reparent")]
        public string Reparent { get; set; }

        [JsonProperty("share")]
        public string Share { get; set; }

        [JsonProperty("unshare")]
        public string Unshare { get; set; }

        [JsonProperty("rollupView")]
        public string RollupView { get; set; }

        public bool ValueEquals(CascadeConfiguration other)
        {
            if (other == null) return false;
            return string.Equals(Assign, other.Assign, StringComparison.Ordinal)
                && string.Equals(Delete, other.Delete, StringComparison.Ordinal)
                && string.Equals(Merge, other.Merge, StringComparison.Ordinal)
                && string.Equals(Reparent, other.Reparent, StringComparison.Ordinal)
                && string.Equals(Share, other.Share, StringComparison.Ordinal)
                && string.Equals(Unshare, other.Unshare, StringComparison.Ordinal)
                && string.Equals(RollupView, other.RollupView, StringComparison.Ordinal);
        }
    }

    public class PointD
    {
        [JsonProperty("x")]
        public double X { get; set; }

        [JsonProperty("y")]
        public double Y { get; set; }
    }

    /// <summary>
    /// Something drawn on top of the model rather than being part of it: a sticky note, a plain
    /// text box or an arrow.
    /// </summary>
    public class DiagramAnnotation
    {
        [JsonProperty("id")]
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>
        /// "note", "text" or "arrow". Empty means a sticky note.
        ///
        /// Not part of the format version stamp, like <see cref="DiagramTable.OwnershipType"/>.
        /// Files written before tool 1.6.0 have no kind, and every annotation in them is a sticky
        /// note, so a missing kind reads as a note. A build that does not know the property draws
        /// arrows and text boxes as empty notes rather than refusing to open the file.
        /// </summary>
        [JsonProperty("kind")]
        public string Kind { get; set; }

        [JsonProperty("text")]
        public string Text { get; set; } = string.Empty;

        [JsonProperty("x")]
        public double X { get; set; }

        [JsonProperty("y")]
        public double Y { get; set; }

        /// <summary>
        /// Zero means "no size of its own", which is what an annotation in a hand-edited or
        /// pre-1.6.0 file has. <see cref="Export.ExportRowBuilder.AnnotationRect"/> is the single
        /// place that turns that into a drawn size, and it applies the canvas's own defaults.
        ///
        /// These have no property initialisers: a JSON annotation with no width deserialises to the
        /// initialiser, so an initialiser would make the "no size" fallback unreachable. The canvas
        /// reaches the same answer - `Number(undefined)` is NaN, which is falsy, so its `||`
        /// fallback fires.
        /// </summary>
        [JsonProperty("width")]
        public double Width { get; set; }

        [JsonProperty("height")]
        public double Height { get; set; }

        [JsonProperty("fontSize")]
        public double FontSize { get; set; }

        /// <summary>
        /// Sticky notes only: how far the paper is turned, in degrees, positive clockwise.
        ///
        /// Null means the note has never been turned by hand, and the canvas then derives a small
        /// slant from the note's own id - stable for the life of the note, so it does not twitch
        /// on every redraw. That derivation is `stickyTilt` in Web/js/geometry.js and it is where
        /// the meaning of "no tilt in the file" lives; nothing in C# reproduces it, because the
        /// exporters that need a number ask <see cref="Export.ExportRowBuilder.AnnotationRect"/>
        /// for a box rather than drawing the paper themselves.
        ///
        /// Nullable because zero is a real angle - it is what a note the user has straightened
        /// carries, and it has to survive a save. Additive, so the file format version does not
        /// change.
        /// </summary>
        [JsonProperty("tilt")]
        public double? Tilt { get; set; }

        [JsonProperty("bold")]
        public bool Bold { get; set; }

        /// <summary>
        /// Drawn behind the model - the table cards and the relationship lines both - rather than
        /// on top of it. False - the default - is in front, which is what a new annotation is and
        /// what a file written before 1.9.0 means.
        ///
        /// Additive, so the file format version does not change: a build that does not know the
        /// property ignores it.
        ///
        /// The exporters honour it as well as the canvas. In both draw.io and Visio the order
        /// shapes are written in *is* the z-order, so a behind annotation is written before the
        /// tables and the connectors, and a front one after them.
        /// </summary>
        [JsonProperty("behind")]
        public bool Behind { get; set; }

        // A note's text is always drawn in the theme's ink so it stays legible in light and dark.
        // Background and border are what the swatch row in the inspector sets.

        [JsonProperty("background")]
        public string Background { get; set; } = "#fff8e1";

        [JsonProperty("border")]
        public string Border { get; set; } = "#e8d9a8";

        /// <summary>
        /// Arrows only: the vector from <see cref="X"/>,<see cref="Y"/> to the head. Either
        /// component can be negative.
        ///
        /// Held as a vector so that moving an arrow is the same change of X and Y that every other
        /// annotation gets, with no special case in the drag handler, undo snapshot or layout code.
        /// </summary>
        [JsonProperty("dx")]
        public double Dx { get; set; }

        [JsonProperty("dy")]
        public double Dy { get; set; }

        /// <summary>
        /// Text and arrow colour, as a CSS colour string. Null means the theme's own ink.
        ///
        /// Used by text boxes and arrows, which have no paper to distinguish them, so the colour
        /// carries that. Sticky note text is always drawn in the theme ink.
        /// </summary>
        [JsonProperty("ink")]
        public string Ink { get; set; }

        /// <summary>
        /// Optional association with a table or relationship id, drawn as a leader line to the
        /// card's centre or the connector's midpoint.
        /// </summary>
        [JsonProperty("attachedToId")]
        public string AttachedToId { get; set; }
    }

    /// <summary>
    /// Reading an annotation's kind without every caller repeating the default.
    ///
    /// Static methods rather than a property on the annotation itself, because a computed public
    /// property would be serialised into every .dvmd file alongside the real one.
    /// </summary>
    public static class AnnotationKinds
    {
        public const string Note = "note";
        public const string Text = "text";
        public const string Arrow = "arrow";

        /// <summary>
        /// The kind of an annotation. Anything unrecognised - including the empty value every
        /// annotation written before 1.6.0 carries - is a sticky note.
        /// </summary>
        public static string Of(DiagramAnnotation annotation)
        {
            var kind = annotation == null ? null : annotation.Kind;

            if (string.Equals(kind, Text, StringComparison.OrdinalIgnoreCase)) return Text;
            if (string.Equals(kind, Arrow, StringComparison.OrdinalIgnoreCase)) return Arrow;
            return Note;
        }

        public static bool IsArrow(DiagramAnnotation annotation)
        {
            return Of(annotation) == Arrow;
        }

        public static bool IsText(DiagramAnnotation annotation)
        {
            return Of(annotation) == Text;
        }

        public static bool IsNote(DiagramAnnotation annotation)
        {
            return Of(annotation) == Note;
        }

        /// <summary>
        /// The annotations on one side of the model, in the order they should be written.
        ///
        /// In both draw.io and Visio the order shapes are written in *is* the z-order, so this is
        /// the exporters' half of what the canvas does with two SVG groups. Sticky notes go out
        /// before text boxes and arrows for the same reason they are painted first there: a note
        /// is opaque paper, and a label or an arrow lying on one has to stay readable.
        ///
        /// OrderBy is a stable sort in LINQ to Objects, so two notes keep their document order.
        /// </summary>
        public static IEnumerable<DiagramAnnotation> PaintOrder(
            IEnumerable<DiagramAnnotation> annotations, bool behind)
        {
            return (annotations ?? Enumerable.Empty<DiagramAnnotation>())
                .Where(a => a != null && a.Behind == behind)
                .OrderBy(a => IsNote(a) ? 0 : 1);
        }
    }
}
