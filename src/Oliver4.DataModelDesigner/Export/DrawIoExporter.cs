using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Xml;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Export
{
    /// <summary>
    /// Writes a draw.io / diagrams.net file. Tables become stack-layout list shapes so each column
    /// stays an individually selectable row, and relationships become entity-relation edges with
    /// crow's-foot terminators. The result is meant to be edited further, not just viewed.
    /// </summary>
    public static class DrawIoExporter
    {
        private const double HeaderHeight = 30;
        private const double RowHeight = 24;
        private const double DefaultWidth = 220;

        public static ExportProduct Export(DiagramDocument document)
        {
            var warnings = new List<string>();
            var settings = new XmlWriterSettings
            {
                Indent = true,
                IndentChars = "  ",
                OmitXmlDeclaration = false,
                Encoding = new UTF8Encoding(false)
            };

            var builder = new StringBuilder();
            using (var writer = XmlWriter.Create(builder, settings))
            {
                writer.WriteStartElement("mxfile");
                writer.WriteAttributeString("host", "Oliver4.DataModelDesigner");
                writer.WriteAttributeString("type", "device");

                writer.WriteStartElement("diagram");
                writer.WriteAttributeString("id", document.Id);
                // The page name is drawn as plain text on the tab, not as an html=1 label, so it
                // gets the invalid-character strip but not the HTML escaping Sanitise applies.
                writer.WriteAttributeString("name", ExportText.StripInvalidXml(document.Title));

                writer.WriteStartElement("mxGraphModel");
                writer.WriteAttributeString("dx", "1400");
                writer.WriteAttributeString("dy", "900");
                writer.WriteAttributeString("grid", "1");
                writer.WriteAttributeString("gridSize", "10");
                writer.WriteAttributeString("page", "1");
                writer.WriteAttributeString("pageWidth", "1169");
                writer.WriteAttributeString("pageHeight", "826");
                writer.WriteAttributeString("math", "0");
                writer.WriteAttributeString("shadow", "0");

                writer.WriteStartElement("root");
                WriteCell(writer, "0", null, null, null, false, false);
                WriteCell(writer, "1", null, null, "0", false, false);

                var visibleTables = document.Tables.ToList();
                var cellIds = new Dictionary<string, string>(StringComparer.Ordinal);
                var index = 0;

                // Order is z-order in draw.io, so an annotation the user has sent behind the model
                // is written before it and one left in front is written after. The index runs
                // across both passes, so the cell ids stay unique. AnnotationKinds.PaintOrder puts
                // the sticky notes of each pass out before its text boxes and arrows, matching the
                // canvas.
                var noteIndex = 0;

                foreach (var annotation in AnnotationKinds.PaintOrder(document.Annotations, true))
                {
                    noteIndex++;
                    WriteAnnotation(writer, annotation, "note" + noteIndex);
                }

                foreach (var table in visibleTables)
                {
                    index++;
                    var cellId = "tbl" + index;
                    cellIds[table.Id] = cellId;
                    WriteTable(writer, document, table, cellId, warnings);
                }

                var edgeIndex = 0;
                foreach (var relationship in document.Relationships.Where(r => r.Included && !r.Hidden))
                {
                    string source, target;
                    if (!cellIds.TryGetValue(relationship.FromTableId ?? string.Empty, out source)) continue;
                    if (!cellIds.TryGetValue(relationship.ToTableId ?? string.Empty, out target)) continue;

                    edgeIndex++;
                    WriteRelationship(writer, document, relationship, "edge" + edgeIndex, source, target);
                }

                foreach (var annotation in AnnotationKinds.PaintOrder(document.Annotations, false))
                {
                    noteIndex++;
                    WriteAnnotation(writer, annotation, "note" + noteIndex);
                }

                if (document.Settings.ShowLegend)
                    WriteLegend(writer, document);

                writer.WriteEndElement(); // root
                writer.WriteEndElement(); // mxGraphModel
                writer.WriteEndElement(); // diagram
                writer.WriteEndElement(); // mxfile
            }

            if (document.Relationships.Any(r => r.Included && !r.Hidden && r.Kind == RelationshipKind.ManyToMany))
            {
                warnings.Add(
                    "N:N relationships are drawn as a single many-to-many edge. draw.io has no intersect-table concept, " +
                    "so the intersect entity name is kept only in the edge tooltip.");
            }

            if (document.Annotations.Any(a => !string.IsNullOrEmpty(a.AttachedToId)))
                warnings.Add("Notes attached to a table or relationship are exported as free-floating notes; the leader line is not carried over.");

            return new ExportProduct
            {
                Text = builder.ToString(),
                Warnings = warnings
            };
        }

        private static void WriteTable(XmlWriter writer, DiagramDocument document, DiagramTable table, string cellId, List<string> warnings)
        {
            var rows = ExportRowBuilder.RowsFor(document, table).ToList();
            var width = table.Width ?? DefaultWidth;
            var height = HeaderHeight + rows.Count * RowHeight;

            var title = ExportRowBuilder.TitleFor(document, table);
            var fill = StatusFill(table.Status);
            var stroke = StatusStroke(table.Status);

            var style = "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=" +
                        Num(HeaderHeight) + ";horizontalStack=0;resizeParent=1;resizeParentMax=0;html=1;" +
                        "whiteSpace=wrap;marginBottom=0;rounded=1;arcSize=6;" +
                        "fillColor=" + fill + ";strokeColor=" + stroke + ";fontColor=#101725;" +
                        (table.Status == ObjectStatus.Existing ? string.Empty : "dashed=1;");

            if (!string.IsNullOrEmpty(table.Highlight))
                style += "strokeWidth=3;strokeColor=" + table.Highlight + ";";

            writer.WriteStartElement("mxCell");
            writer.WriteAttributeString("id", cellId);
            writer.WriteAttributeString("value", Sanitise(title));
            writer.WriteAttributeString("style", style);
            writer.WriteAttributeString("vertex", "1");
            writer.WriteAttributeString("parent", "1");
            WriteGeometry(writer, table.X, table.Y, width, height);
            writer.WriteEndElement();

            var rowIndex = 0;
            foreach (var row in rows)
            {
                rowIndex++;
                var rowStyle = "text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;" +
                               "spacingLeft=6;spacingRight=6;overflow=hidden;points=[[0,0.5],[1,0.5]];" +
                               "portConstraint=eastwest;rotatable=0;whiteSpace=wrap;html=1;fontSize=11;";

                if (row.Status == ObjectStatus.Proposed) rowStyle += "fontColor=#a4700f;";
                else if (row.Status == ObjectStatus.Deprecated) rowStyle += "fontColor=#9b2c22;fontStyle=8;";

                writer.WriteStartElement("mxCell");
                writer.WriteAttributeString("id", cellId + "r" + rowIndex);
                writer.WriteAttributeString("value", Sanitise(row.Text));
                writer.WriteAttributeString("style", rowStyle);
                writer.WriteAttributeString("vertex", "1");
                writer.WriteAttributeString("parent", cellId);
                WriteGeometry(writer, 0, HeaderHeight + (rowIndex - 1) * RowHeight, width, RowHeight);
                writer.WriteEndElement();
            }

            // SelectedColumns forces TablesOnly for a collapsed card, so rows is always empty here
            // and draw.io gets a header-only swimlane.
            if (table.Collapsed)
            {
                warnings.Add("Table '" + table.DisplayName +
                             "' is collapsed on the canvas, so it exports as a header-only card with no columns.");
            }
        }

        private static void WriteRelationship(
            XmlWriter writer, DiagramDocument document, DiagramRelationship relationship,
            string cellId, string source, string target)
        {
            string startArrow, endArrow;
            switch (relationship.Kind)
            {
                case RelationshipKind.ManyToMany:
                    startArrow = "ERmany";
                    endArrow = "ERmany";
                    break;
                case RelationshipKind.ManyToOne:
                    startArrow = "ERmany";
                    endArrow = "ERone";
                    break;
                default:
                    startArrow = "ERone";
                    endArrow = "ERmany";
                    break;
            }

            var stroke = relationship.Highlight
                         ?? (relationship.Status == ObjectStatus.Proposed ? "#c98a12"
                         : relationship.Status == ObjectStatus.Deprecated ? "#c0392f"
                         : "#8ea3c4");

            var style = "edgeStyle=entityRelationEdgeStyle;rounded=0;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" +
                        "startArrow=" + startArrow + ";startFill=0;endArrow=" + endArrow + ";endFill=0;" +
                        "strokeColor=" + stroke + ";" +
                        (relationship.Status == ObjectStatus.Existing ? string.Empty : "dashed=1;");

            var label = BuildEdgeLabel(document, relationship);

            writer.WriteStartElement("mxCell");
            writer.WriteAttributeString("id", cellId);
            writer.WriteAttributeString("value", Sanitise(label));
            writer.WriteAttributeString("style", style);
            writer.WriteAttributeString("edge", "1");
            writer.WriteAttributeString("parent", "1");
            writer.WriteAttributeString("source", source);
            writer.WriteAttributeString("target", target);

            writer.WriteStartElement("mxGeometry");
            writer.WriteAttributeString("relative", "1");
            writer.WriteAttributeString("as", "geometry");
            writer.WriteEndElement();

            writer.WriteEndElement();
        }

        private static string BuildEdgeLabel(DiagramDocument document, DiagramRelationship relationship)
        {
            var parts = new List<string>();

            if (document.Settings.ShowCardinality)
                parts.Add(ExportRowBuilder.CardinalityText(relationship.Kind));

            if (document.Settings.ShowRelationshipName && !string.IsNullOrEmpty(relationship.SchemaName))
                parts.Add(relationship.SchemaName);

            if (relationship.Kind == RelationshipKind.ManyToMany && !string.IsNullOrEmpty(relationship.IntersectEntity))
                parts.Add("via " + relationship.IntersectEntity);

            if (relationship.Status == ObjectStatus.Proposed) parts.Insert(0, "proposed");

            return string.Join(" ", parts);
        }

        /// <summary>
        /// One annotation, drawn according to its kind: an arrow's geometry lives entirely in
        /// Dx/Dy, a text box has no background and no border, and a sticky note is a note shape.
        /// </summary>
        private static void WriteAnnotation(XmlWriter writer, DiagramAnnotation annotation, string cellId)
        {
            if (AnnotationKinds.IsArrow(annotation))
            {
                WriteArrow(writer, annotation, cellId);
                return;
            }

            var style = AnnotationKinds.IsText(annotation)
                ? "text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;" +
                  "fillColor=none;strokeColor=none;" +
                  "fontColor=" + (annotation.Ink ?? "#3d4759") + ";" +
                  "fontSize=" + Num(annotation.FontSize <= 0
                      ? ExportRowBuilder.DefaultFontSize : annotation.FontSize) + ";" +
                  (annotation.Bold ? "fontStyle=1;" : string.Empty)
                // fontSize and fontStyle carry the note's text size and weight, so a new note (14px
                // bold) is not drawn in draw.io's own default face. `size=14` above is the note
                // shape's folded corner, not a font size.
                : "shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;" +
                  "fillColor=" + (annotation.Background ?? "#fff8e1") + ";" +
                  "strokeColor=" + (annotation.Border ?? "#e8d9a8") + ";" +
                  "fontColor=#3d4759;" +
                  "fontSize=" + Num(annotation.FontSize <= 0
                      ? ExportRowBuilder.DefaultFontSize : annotation.FontSize) + ";" +
                  (annotation.Bold ? "fontStyle=1;" : string.Empty) +
                  "align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;size=14;";

            // A note the user has turned by hand. draw.io rotates a vertex about its own centre in
            // degrees, clockwise, which is what the canvas stores - so the number goes straight
            // through. Only an angle set by hand is carried: the small slant the canvas gives an
            // untouched note is derived from its id and is not written to the export.
            if (AnnotationKinds.IsNote(annotation) && annotation.Tilt.HasValue &&
                Math.Abs(annotation.Tilt.Value) > 0.01)
            {
                style += "rotation=" + Num(annotation.Tilt.Value) + ";";
            }

            // Through AnnotationRect, which applies the canvas's defaults and floors, so a
            // zero-sized or size-less annotation is exported at the drawn size.
            var rect = ExportRowBuilder.AnnotationRect(annotation);

            writer.WriteStartElement("mxCell");
            writer.WriteAttributeString("id", cellId);
            writer.WriteAttributeString("value", Sanitise(annotation.Text));
            writer.WriteAttributeString("style", style);
            writer.WriteAttributeString("vertex", "1");
            writer.WriteAttributeString("parent", "1");
            WriteGeometry(writer, rect.X, rect.Y, rect.Width, rect.Height);
            writer.WriteEndElement();
        }

        /// <summary>
        /// A free-standing arrow, as an edge with two fixed points and neither end attached to a
        /// shape. draw.io keeps it draggable and re-routable, which is what somebody who opens the
        /// file to adjust the diagram will expect of it.
        /// </summary>
        private static void WriteArrow(XmlWriter writer, DiagramAnnotation annotation, string cellId)
        {
            writer.WriteStartElement("mxCell");
            writer.WriteAttributeString("id", cellId);
            writer.WriteAttributeString("value", string.Empty);
            writer.WriteAttributeString("style",
                "endArrow=block;endFill=1;html=1;rounded=0;strokeWidth=2;strokeColor=" +
                (annotation.Ink ?? "#c0392f") + ";");
            writer.WriteAttributeString("edge", "1");
            writer.WriteAttributeString("parent", "1");

            writer.WriteStartElement("mxGeometry");
            writer.WriteAttributeString("relative", "1");
            writer.WriteAttributeString("as", "geometry");

            WritePoint(writer, "sourcePoint", annotation.X, annotation.Y);
            WritePoint(writer, "targetPoint", annotation.X + annotation.Dx, annotation.Y + annotation.Dy);

            writer.WriteEndElement(); // mxGeometry
            writer.WriteEndElement(); // mxCell
        }

        private static void WritePoint(XmlWriter writer, string name, double x, double y)
        {
            writer.WriteStartElement("mxPoint");
            writer.WriteAttributeString("x", Num(x));
            writer.WriteAttributeString("y", Num(y));
            writer.WriteAttributeString("as", name);
            writer.WriteEndElement();
        }

        private static void WriteLegend(XmlWriter writer, DiagramDocument document)
        {
            var entries = new[]
            {
                new { Label = "Existing", Fill = "#ffffff", Stroke = "#d5dceb", Dashed = false },
                new { Label = "Proposed", Fill = "#fff8e6", Stroke = "#c98a12", Dashed = true },
                new { Label = "External", Fill = "#f6f1ff", Stroke = "#7a4fd1", Dashed = true },
                new { Label = "Deprecated", Fill = "#fdf0ee", Stroke = "#c0392f", Dashed = true }
            };

            var x = 20.0;
            var y = 20.0;

            writer.WriteStartElement("mxCell");
            writer.WriteAttributeString("id", "legendTitle");
            writer.WriteAttributeString("value", Sanitise(document.Title + " - legend"));
            writer.WriteAttributeString("style", "text;html=1;fontStyle=1;align=left;verticalAlign=middle;fontSize=12;");
            writer.WriteAttributeString("vertex", "1");
            writer.WriteAttributeString("parent", "1");
            WriteGeometry(writer, x, y, 240, 24);
            writer.WriteEndElement();

            var i = 0;
            foreach (var entry in entries)
            {
                i++;
                var style = "rounded=1;whiteSpace=wrap;html=1;align=left;spacingLeft=8;fontSize=11;" +
                            "fillColor=" + entry.Fill + ";strokeColor=" + entry.Stroke + ";" +
                            (entry.Dashed ? "dashed=1;" : string.Empty);

                writer.WriteStartElement("mxCell");
                writer.WriteAttributeString("id", "legend" + i);
                writer.WriteAttributeString("value", entry.Label);
                writer.WriteAttributeString("style", style);
                writer.WriteAttributeString("vertex", "1");
                writer.WriteAttributeString("parent", "1");
                WriteGeometry(writer, x, y + 8 + i * 26, 140, 22);
                writer.WriteEndElement();
            }

            // Every emphasis colour in use is exported as a card or edge stroke, so a legend with
            // only the four status entries leaves the reader with coloured borders it cannot
            // explain. The canvas writes EmphasisNames keyed by lower-case hex and this dictionary
            // uses the default ordinal comparer, so the key has to be looked up lower-cased; the
            // raw hex is the fallback when the user has not named the colour.
            foreach (var colour in EmphasisColours(document))
            {
                i++;

                string name;
                if (document.Settings.EmphasisNames == null ||
                    !document.Settings.EmphasisNames.TryGetValue(colour.ToLowerInvariant(), out name) ||
                    string.IsNullOrWhiteSpace(name))
                {
                    name = colour;
                }

                var style = "rounded=1;whiteSpace=wrap;html=1;align=left;spacingLeft=8;fontSize=11;" +
                            "fillColor=none;strokeWidth=3;strokeColor=" + colour + ";";

                writer.WriteStartElement("mxCell");
                writer.WriteAttributeString("id", "legend" + i);
                writer.WriteAttributeString("value", Sanitise(name));
                writer.WriteAttributeString("style", style);
                writer.WriteAttributeString("vertex", "1");
                writer.WriteAttributeString("parent", "1");
                WriteGeometry(writer, x, y + 8 + i * 26, 140, 22);
                writer.WriteEndElement();
            }
        }

        /// <summary>The distinct emphasis colours actually carried into the exported file.</summary>
        private static List<string> EmphasisColours(DiagramDocument document)
        {
            return document.Tables.Select(t => t.Highlight)
                .Concat(document.Relationships
                    .Where(r => r.Included && !r.Hidden)
                    .Select(r => r.Highlight))
                .Where(h => !string.IsNullOrWhiteSpace(h))
                .Select(h => h.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static void WriteCell(XmlWriter writer, string id, string value, string style, string parent, bool vertex, bool edge)
        {
            writer.WriteStartElement("mxCell");
            writer.WriteAttributeString("id", id);
            if (value != null) writer.WriteAttributeString("value", value);
            if (style != null) writer.WriteAttributeString("style", style);
            if (parent != null) writer.WriteAttributeString("parent", parent);
            if (vertex) writer.WriteAttributeString("vertex", "1");
            if (edge) writer.WriteAttributeString("edge", "1");
            writer.WriteEndElement();
        }

        private static void WriteGeometry(XmlWriter writer, double x, double y, double width, double height)
        {
            writer.WriteStartElement("mxGeometry");
            writer.WriteAttributeString("x", Num(x));
            writer.WriteAttributeString("y", Num(y));
            writer.WriteAttributeString("width", Num(width));
            writer.WriteAttributeString("height", Num(height));
            writer.WriteAttributeString("as", "geometry");
            writer.WriteEndElement();
        }

        private static string StatusFill(ObjectStatus status)
        {
            switch (status)
            {
                case ObjectStatus.Proposed: return "#fff8e6";
                case ObjectStatus.External: return "#f6f1ff";
                case ObjectStatus.Deprecated: return "#fdf0ee";
                default: return "#ffffff";
            }
        }

        private static string StatusStroke(ObjectStatus status)
        {
            switch (status)
            {
                case ObjectStatus.Proposed: return "#c98a12";
                case ObjectStatus.External: return "#7a4fd1";
                case ObjectStatus.Deprecated: return "#c0392f";
                default: return "#d5dceb";
            }
        }

        private static string Num(double value)
        {
            return Math.Round(value, 2).ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// A value for a cell whose style carries html=1 - which is every label-bearing style this
        /// exporter writes.
        ///
        /// draw.io renders such a label through innerHTML, so a markup token in a name is swallowed
        /// as an unknown tag: a table called "Order &lt;Legacy&gt; header" would lose the middle
        /// word. The XML layer is XmlWriter's job and is already correct; this is the layer
        /// underneath it. Newlines have to become br for the same reason - HTML collapses them.
        /// </summary>
        private static string Sanitise(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;

            return ExportText.StripInvalidXml(value)
                .Replace("&", "&amp;")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;")
                .Replace("\r\n", "<br>")
                .Replace("\n", "<br>")
                .Replace("\r", "<br>");
        }
    }
}
