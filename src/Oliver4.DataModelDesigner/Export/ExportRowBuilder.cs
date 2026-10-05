using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Xml;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Export
{
    /// <summary>One rendered column row inside a table card.</summary>
    public class ExportRow
    {
        public string Text { get; set; }
        public string KeyMarker { get; set; }
        public string Name { get; set; }
        public string TypeName { get; set; }
        public ObjectStatus Status { get; set; }
        public bool IsPrimaryKey { get; set; }
        public bool IsForeignKey { get; set; }
    }

    /// <summary>The box an annotation occupies on the canvas, in canvas pixels.</summary>
    public class AnnotationBox
    {
        public double X { get; set; }
        public double Y { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
    }

    /// <summary>Text handling every exporter needs, wherever the file format is stricter than a string.</summary>
    public static class ExportText
    {
        /// <summary>
        /// Drops anything XML cannot carry - a vertical tab or another C0 control picked up by a
        /// copy and paste into a display name, say.
        ///
        /// XmlWriter.Create defaults to CheckCharacters=true, so such a character would make the
        /// draw.io and Visio exporters throw ArgumentException from deep inside the writer. The
        /// Markdown and HTML exporters use it too, because the character is equally invalid there.
        /// </summary>
        public static string StripInvalidXml(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;

            StringBuilder cleaned = null;

            for (var i = 0; i < value.Length; i++)
            {
                var c = value[i];

                // A surrogate pair is legal in XML but each half fails IsXmlChar on its own, so the
                // pair has to be tested as a unit or every astral character would be stripped.
                var pair = char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]);

                if (pair || XmlConvert.IsXmlChar(c))
                {
                    if (cleaned != null)
                    {
                        cleaned.Append(c);
                        if (pair) cleaned.Append(value[i + 1]);
                    }

                    if (pair) i++;
                    continue;
                }

                if (cleaned == null) cleaned = new StringBuilder(value, 0, i, value.Length);
            }

            return cleaned == null ? value : cleaned.ToString();
        }
    }

    /// <summary>
    /// Decides which columns a table shows for the current display settings.
    ///
    /// This mirrors the rules the canvas renderer applies in JavaScript. The text exporters need
    /// the rules server side, and the canvas needs them client side without a round trip on
    /// every redraw. If the visibility rules change, change both.
    /// </summary>
    public static class ExportRowBuilder
    {
        /// <summary>
        /// The columns a table draws, in the order it draws them: the detail mode, the collapsed
        /// flag and the column order, all together. The mirror of `visibleColumns` in
        /// Web/js/geometry.js, which ends every branch with `orderColumns`.
        ///
        /// Every caller belongs here rather than on SelectColumns, which answers only half the
        /// question and ignores collapsed cards.
        /// </summary>
        public static IEnumerable<DiagramColumn> SelectedColumns(DiagramDocument document, DiagramTable table)
        {
            var mode = table.DetailOverride ?? document.Settings.FieldDetail;
            if (table.Collapsed) mode = FieldDetailMode.TablesOnly;
            if (mode == FieldDetailMode.TablesOnly) return new List<DiagramColumn>();

            return OrderColumns(SelectColumns(document, table, mode), document.Settings.FieldOrder, table);
        }

        /// <summary>
        /// The canvas's column order, ported from `orderColumns` in Web/js/geometry.js.
        ///
        /// The canvas floats the primary key, the primary name column and lookups to the top - on
        /// the default setting, not only when a sort has been chosen - so every export applies the
        /// same order to keep a table's rows matching the picture beside it.
        /// </summary>
        private static List<DiagramColumn> OrderColumns(List<DiagramColumn> columns, string order, DiagramTable table)
        {
            // A card whose rows the user has dragged into an order is in that order, and neither
            // the sort nor the key float gets to move them back. The mirror of the manual branch in
            // `orderColumns` in Web/js/geometry.js: change one, change the other.
            var manual = ManualOrder(table);
            if (manual != null)
            {
                return columns
                    .OrderBy(c => ManualRank(manual, c))
                    .ToList();
            }

            var ranked = columns;

            if (string.Equals(order, "displayName", StringComparison.OrdinalIgnoreCase))
            {
                ranked = ranked
                    .OrderBy(c => c.DisplayName ?? string.Empty, ColumnNameComparer)
                    .ToList();
            }
            else if (string.Equals(order, "schemaName", StringComparison.OrdinalIgnoreCase))
            {
                ranked = ranked
                    .OrderBy(c => c.LogicalName ?? string.Empty, ColumnNameComparer)
                    .ToList();
            }

            // Keys float to the top whatever the sort, because that is what makes a card scannable.
            // OrderBy is a stable sort, so within a rank the order chosen above survives - which is
            // what the JavaScript relies on too.
            return ranked.OrderBy(Rank).ToList();
        }

        /// <summary>
        /// The canvas pins its sort to en-GB - `localeCompare(..., 'en-GB')` in orderColumns - so
        /// the export has to pin it too. Sorting by the current culture would put the exported
        /// columns in a different order from the picture on a non-English Windows: Zebra, Ärende
        /// and apple come out apple, Ärende, Zebra under en-GB and apple, Zebra, Ärende under sv-SE.
        /// </summary>
        private static readonly StringComparer ColumnNameComparer =
            StringComparer.Create(CultureInfo.GetCultureInfo("en-GB"), true);

        /// <summary>
        /// The card's manual field order as name to position, or null when it has none. Mirrors
        /// `manualColumnOrder` in Web/js/geometry.js, duplicate names and blanks included.
        /// </summary>
        private static Dictionary<string, int> ManualOrder(DiagramTable table)
        {
            var order = table == null ? null : table.ColumnOrder;
            if (order == null || order.Count == 0) return null;

            var positions = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            for (var i = 0; i < order.Count; i++)
            {
                var key = order[i];
                if (string.IsNullOrEmpty(key) || positions.ContainsKey(key)) continue;
                positions[key] = i;
            }

            return positions.Count == 0 ? null : positions;
        }

        /// <summary>
        /// Where one column sits in a manual order. A column the order has never heard of - added
        /// by a refresh, or renamed since - sorts after everything it has, in the order it would
        /// have had on its own. OrderBy is stable, so equal ranks keep their metadata order, which
        /// is what the JavaScript's own sort relies on too.
        /// </summary>
        private static int ManualRank(Dictionary<string, int> manual, DiagramColumn column)
        {
            int at;
            return manual.TryGetValue(ColumnOrderKey(column), out at) ? at : manual.Count + Rank(column);
        }

        /// <summary>
        /// The key a column is written into a card's manual order under. The mirror of
        /// `columnOrderKey` in Web/js/geometry.js, fallbacks and all.
        ///
        /// Written with IsNullOrEmpty rather than ??, because the JavaScript's `||` falls through
        /// on an empty string and ?? only falls through on null, so a column with an empty logical
        /// name and a schema name is keyed the same way on both sides.
        /// The id is the last resort: every column has to have a key, or the order cannot describe
        /// it and it is sorted after every column that the order does name.
        /// </summary>
        private static string ColumnOrderKey(DiagramColumn column)
        {
            if (column == null) return string.Empty;
            if (!string.IsNullOrEmpty(column.LogicalName)) return column.LogicalName;
            if (!string.IsNullOrEmpty(column.SchemaName)) return column.SchemaName;
            return column.Id ?? string.Empty;
        }

        private static int Rank(DiagramColumn column)
        {
            if (column.IsPrimaryId) return 0;
            if (column.IsPrimaryName) return 1;
            if (column.IsLookup) return 2;
            return 3;
        }

        public static IEnumerable<ExportRow> RowsFor(DiagramDocument document, DiagramTable table)
        {
            foreach (var column in SelectedColumns(document, table))
            {
                var marker = MarkerFor(document, column);

                var name = ColumnLabel(document, column);
                var text = string.IsNullOrEmpty(marker) ? name : marker + "  " + name;

                if (document.Settings.ShowFieldType && !string.IsNullOrEmpty(column.TypeName))
                    text += "  :  " + column.TypeName;

                if (column.Status == ObjectStatus.Proposed) text = "* " + text;
                if (column.Status == ObjectStatus.Deprecated) text += "  (deprecated)";

                yield return new ExportRow
                {
                    Text = text,
                    KeyMarker = marker,
                    Name = name,
                    TypeName = column.TypeName,
                    Status = column.Status,
                    IsPrimaryKey = column.IsPrimaryId,
                    IsForeignKey = column.IsLookup && !column.IsPrimaryId
                };
            }
        }

        /// <summary>
        /// The key marker drawn beside a column, ported from `markerFor` in Web/js/geometry.js.
        ///
        /// Three branches, each gated on its own toggle, and the order between them matters: a
        /// column can be more than one of these things and the canvas shows exactly one. In
        /// relationship-fields mode "Show alternate keys" is also what pulls an alternate-key
        /// column onto the card, so the AK marker explains why it is there.
        /// </summary>
        public static string MarkerFor(DiagramDocument document, DiagramColumn column)
        {
            var settings = document.Settings;

            if (column.IsPrimaryId && settings.ShowPrimaryKey) return "PK";
            if (column.IsLookup && settings.ShowForeignKey) return "FK";
            if (column.IsAlternateKey && settings.ShowAlternateKeys) return "AK";
            return string.Empty;
        }

        /// <summary>
        /// The side of a sticky note that carries no size of its own, matching NOTE_DEFAULT_SIZE
        /// in Web/js/state.js. A *new* note is square; the grip resizes each side independently,
        /// so this is the starting size and the fallback, not a shape the exports can assume.
        /// </summary>
        public const double NoteDefaultSize = 140;

        /// <summary>
        /// Point size used for annotation text that carries none, matching the canvas defaults in
        /// Web/js/render.js. New sticky notes and text boxes both carry 14 explicitly; this is the
        /// floor for a hand-edited or pre-1.6.0 file.
        /// </summary>
        public const double DefaultFontSize = 14;

        /// <summary>
        /// The box an annotation occupies, mirroring `annotationRect` in Web/js/geometry.js -
        /// defaults and floors included, because those are not the model's own property defaults.
        /// Every exporter goes through this rather than reading Width and Height straight through,
        /// so a zero-sized or size-less annotation is drawn at the size the canvas draws it.
        ///
        /// <see cref="NoteDefaultSize"/> is the same number as NOTE_DEFAULT_SIZE in Web/js/state.js
        /// and has to move with it.
        /// </summary>
        public static AnnotationBox AnnotationRect(DiagramAnnotation annotation)
        {
            if (annotation == null) return new AnnotationBox();

            if (AnnotationKinds.IsArrow(annotation))
            {
                // An arrow is a start point and a vector, and either component can be negative, so
                // its box is the two points normalised rather than X/Y plus a size.
                var endX = annotation.X + annotation.Dx;
                var endY = annotation.Y + annotation.Dy;

                return new AnnotationBox
                {
                    X = Math.Min(annotation.X, endX),
                    Y = Math.Min(annotation.Y, endY),
                    Width = Math.Abs(endX - annotation.X),
                    Height = Math.Abs(endY - annotation.Y)
                };
            }

            var isText = AnnotationKinds.IsText(annotation);

            var width = annotation.Width;
            if (double.IsNaN(width) || width == 0) width = isText ? 220 : NoteDefaultSize;

            var height = annotation.Height;
            if (double.IsNaN(height) || height == 0) height = isText ? 40 : NoteDefaultSize;

            return new AnnotationBox
            {
                X = annotation.X,
                Y = annotation.Y,
                Width = Math.Max(120, width),
                Height = Math.Max(isText ? 24 : 56, height)
            };
        }

        public static List<DiagramColumn> SelectColumns(DiagramDocument document, DiagramTable table, FieldDetailMode mode)
        {
            if (mode == FieldDetailMode.TablesOnly) return new List<DiagramColumn>();

            if (mode == FieldDetailMode.AllFields)
                return table.Columns.Where(c => c.Selected).ToList();

            // Relationship-fields mode: keys plus the lookup columns that actually create the
            // relationships currently drawn on this diagram.
            var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            if (!string.IsNullOrEmpty(table.PrimaryIdAttribute))
                wanted.Add(table.PrimaryIdAttribute);

            // Both ends have to resolve, exactly as `visibleRelationships` in Web/js/state.js
            // requires. DiagramFile.Normalise only drops a dangling relationship when both end ids
            // are non-empty, so one with a null end survives the load: the canvas filters it out,
            // and so must the export, or the extra lookup row would appear on the card.
            foreach (var relationship in document.Relationships.Where(r =>
                         r.Included && !r.Hidden &&
                         document.FindTableById(r.FromTableId) != null &&
                         document.FindTableById(r.ToTableId) != null))
            {
                if (string.Equals(relationship.ToTableId, table.Id, StringComparison.Ordinal) &&
                    !string.IsNullOrEmpty(relationship.ReferencingAttribute))
                {
                    wanted.Add(relationship.ReferencingAttribute);
                }

                if (string.Equals(relationship.FromTableId, table.Id, StringComparison.Ordinal) &&
                    !string.IsNullOrEmpty(relationship.ReferencedAttribute))
                {
                    wanted.Add(relationship.ReferencedAttribute);
                }
            }

            if (document.Settings.ShowAlternateKeys)
            {
                foreach (var key in table.AlternateKeys)
                    foreach (var column in key.Columns)
                        wanted.Add(column);
            }

            var selected = table.Columns
                .Where(c => c.Selected &&
                            (c.IsPrimaryId ||
                             c.Status == ObjectStatus.Proposed ||
                             (!string.IsNullOrEmpty(c.LogicalName) && wanted.Contains(c.LogicalName))))
                .ToList();

            // A table with no relationship columns at all would render as an empty box, which reads
            // as an error rather than a design choice. Fall back to the primary name column - but
            // never to a column the user deliberately unticked in the inspector.
            if (selected.Count == 0)
            {
                var available = table.Columns.Where(c => c.Selected).ToList();
                var primaryName = available.FirstOrDefault(c => c.IsPrimaryName)
                                  ?? available.FirstOrDefault();
                if (primaryName != null) selected.Add(primaryName);
            }

            return selected;
        }

        public static string ColumnLabel(DiagramDocument document, DiagramColumn column)
        {
            var showDisplay = document.Settings.ShowFieldDisplayName;
            var showSchema = document.Settings.ShowFieldSchemaName;

            var schema = column.LogicalName ?? column.SchemaName ?? string.Empty;
            var display = column.DisplayName ?? schema;

            if (showDisplay && showSchema && !string.Equals(display, schema, StringComparison.OrdinalIgnoreCase))
                return display + " (" + schema + ")";

            if (showDisplay) return display;
            return schema;
        }

        public static string TitleFor(DiagramDocument document, DiagramTable table)
        {
            var showDisplay = document.Settings.ShowTableDisplayName;
            var showSchema = document.Settings.ShowTableSchemaName;

            var schema = table.LogicalName ?? table.SchemaName ?? string.Empty;
            var display = table.DisplayName ?? schema;

            string title;
            if (showDisplay && showSchema && !string.IsNullOrEmpty(schema) &&
                !string.Equals(display, schema, StringComparison.OrdinalIgnoreCase))
            {
                title = display + " (" + schema + ")";
            }
            else if (showDisplay)
            {
                title = display;
            }
            else
            {
                title = string.IsNullOrEmpty(schema) ? display : schema;
            }

            if (document.Settings.ShowStatusBadges && table.Status != ObjectStatus.Existing)
                title += "  [" + table.Status.ToString().ToUpperInvariant() + "]";

            return title;
        }

        public static string CardinalityText(RelationshipKind kind)
        {
            switch (kind)
            {
                case RelationshipKind.ManyToMany: return "N:N";
                case RelationshipKind.ManyToOne: return "N:1";
                default: return "1:N";
            }
        }
    }
}
