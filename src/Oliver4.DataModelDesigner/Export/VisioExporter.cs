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
    /// Writes a Visio 2003 XML drawing (.vdx).
    ///
    /// VDX rather than VSDX: a .vsdx is an OPC package with many interdependent parts and a
    /// master-shape catalogue, while VDX is a single self-describing XML file that current Visio
    /// still opens and converts, with no Visio automation dependency. Visio will offer to convert
    /// the file on save.
    ///
    /// Each table becomes one rectangle whose text is the table name followed by its visible
    /// columns; each relationship becomes a routed connector with a cardinality label. It carries
    /// the table and relationship information rather than full canvas fidelity.
    /// </summary>
    public static class VisioExporter
    {
        private const double PixelsPerInch = 96.0;

        /// <summary>
        /// The page never shrinks below a comfortable landscape sheet, and grows to whatever the
        /// diagram actually spans, so no shape is positioned off the page.
        /// </summary>
        private const double MinPageWidthInches = 16.0;
        private const double MinPageHeightInches = 11.0;

        /// <summary>Matches the 0.5in offset every shape's Pin is placed at.</summary>
        private const double PageMarginInches = 0.5;

        private const double HeaderHeightPx = 26;
        private const double RowHeightPx = 17;
        private const double DefaultWidthPx = 220;

        public static ExportProduct Export(DiagramDocument document)
        {
            var warnings = new List<string>
            {
                "Visio export is experimental. It is written as Visio 2003 XML (.vdx); Visio opens it and offers to convert it to .vsdx on save. Check the file opens as expected before relying on it.",
                "Each table is a single shape with its columns as text, not as separately selectable rows.",
                "Highlight colours, note leader lines and the legend panel are not carried over."
            };

            if (document.Relationships.Any(r => r.Included && !r.Hidden && r.Kind == RelationshipKind.ManyToMany))
                warnings.Add("N:N relationships are drawn as a plain connector; the intersect table name is added to the connector label.");

            var settings = new XmlWriterSettings
            {
                Indent = true,
                IndentChars = "  ",
                Encoding = new UTF8Encoding(false)
            };

            var builder = new StringBuilder();
            using (var writer = XmlWriter.Create(builder, settings))
            {
                writer.WriteStartDocument();
                writer.WriteStartElement("VisioDocument", "http://schemas.microsoft.com/visio/2003/core");
                writer.WriteAttributeString("xml", "space", null, "preserve");

                WriteDocumentProperties(writer, document);
                WriteFaceNames(writer);
                WriteStyleSheets(writer);

                writer.WriteStartElement("Pages");
                writer.WriteStartElement("Page");
                writer.WriteAttributeString("ID", "0");
                writer.WriteAttributeString("NameU", "Model");
                writer.WriteAttributeString("Name", "Model");

                // Before PageProps, because the page size comes from the diagram's own extent.
                var bounds = ComputeBounds(document);

                writer.WriteStartElement("PageSheet");
                writer.WriteStartElement("PageProps");
                WriteCell(writer, "PageWidth", bounds.PageWidth);
                WriteCell(writer, "PageHeight", bounds.PageHeight);
                WriteCell(writer, "DrawingScale", 1);
                WriteCell(writer, "PageScale", 1);
                writer.WriteEndElement(); // PageProps
                writer.WriteEndElement(); // PageSheet

                var shapeIds = new Dictionary<string, int>(StringComparer.Ordinal);
                var nextId = 1;

                // Visio treats NameU as a shape's unique identifier and two tables can perfectly
                // well display the same name, so the names issued so far travel with the writer.
                var tableNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                writer.WriteStartElement("Shapes");

                // Shapes are drawn in the order they are written, so an annotation sent behind
                // the model goes out before it. Arrows are skipped in both passes for the reason
                // given below.
                foreach (var annotation in AnnotationKinds.PaintOrder(document.Annotations, true))
                {
                    if (AnnotationKinds.IsArrow(annotation)) continue;
                    WriteAnnotationShape(writer, annotation, nextId++, bounds);
                }

                foreach (var table in document.Tables)
                {
                    var id = nextId++;
                    shapeIds[table.Id] = id;
                    WriteTableShape(writer, document, table, id, bounds, tableNames);
                }

                var connects = new List<ConnectRecord>();

                foreach (var relationship in document.Relationships.Where(r => r.Included && !r.Hidden))
                {
                    int fromId, toId;
                    if (!shapeIds.TryGetValue(relationship.FromTableId ?? string.Empty, out fromId)) continue;
                    if (!shapeIds.TryGetValue(relationship.ToTableId ?? string.Empty, out toId)) continue;

                    var from = document.FindTableById(relationship.FromTableId);
                    var to = document.FindTableById(relationship.ToTableId);
                    if (from == null || to == null) continue;

                    var id = nextId++;
                    WriteConnectorShape(writer, document, relationship, id, from, to, bounds);
                    connects.Add(new ConnectRecord { ConnectorId = id, FromShape = fromId, ToShape = toId });
                }

                foreach (var annotation in AnnotationKinds.PaintOrder(document.Annotations, false))
                {
                    // Arrows are not written. Their geometry is a start point and a vector, not a
                    // box, and a free-standing connector between two points with nothing at either
                    // end is not something Visio 2003 XML expresses well. The export preflight
                    // tells the user before they pick a filename.
                    if (AnnotationKinds.IsArrow(annotation)) continue;

                    var id = nextId++;
                    WriteAnnotationShape(writer, annotation, id, bounds);
                }

                if (document.Settings.ShowTitleBlock)
                    WriteTitleShape(writer, document, nextId++, bounds);

                writer.WriteEndElement(); // Shapes

                if (connects.Count > 0)
                {
                    writer.WriteStartElement("Connects");
                    foreach (var connect in connects)
                    {
                        WriteConnect(writer, connect.ConnectorId, "BeginX", 9, connect.FromShape);
                        WriteConnect(writer, connect.ConnectorId, "EndX", 12, connect.ToShape);
                    }
                    writer.WriteEndElement();
                }

                writer.WriteEndElement(); // Page
                writer.WriteEndElement(); // Pages
                writer.WriteEndElement(); // VisioDocument
                writer.WriteEndDocument();
            }

            return new ExportProduct { Text = builder.ToString(), Warnings = warnings };
        }

        // ------------------------------------------------------------------

        private static void WriteDocumentProperties(XmlWriter writer, DiagramDocument document)
        {
            writer.WriteStartElement("DocumentProperties");
            writer.WriteElementString("Title", ExportText.StripInvalidXml(document.Title ?? "Dataverse model"));
            writer.WriteElementString("Creator", "Oliver4 Data Model Designer for XrmToolBox");
            if (!string.IsNullOrWhiteSpace(document.Description))
                writer.WriteElementString("Desc", ExportText.StripInvalidXml(document.Description));
            writer.WriteElementString("TimeCreated", document.CreatedUtc.ToString("s", CultureInfo.InvariantCulture));
            writer.WriteEndElement();
        }

        private static void WriteFaceNames(XmlWriter writer)
        {
            writer.WriteStartElement("FaceNames");
            writer.WriteStartElement("FaceName");
            writer.WriteAttributeString("ID", "1");
            writer.WriteAttributeString("Name", "Segoe UI");
            writer.WriteEndElement();
            writer.WriteStartElement("FaceName");
            writer.WriteAttributeString("ID", "2");
            writer.WriteAttributeString("Name", "Consolas");
            writer.WriteEndElement();
            writer.WriteEndElement();
        }

        /// <summary>
        /// Visio needs a style sheet with ID 0 for shapes that declare LineStyle="0" and friends.
        /// One neutral sheet is enough; every shape carries its own explicit formatting.
        /// </summary>
        private static void WriteStyleSheets(XmlWriter writer)
        {
            writer.WriteStartElement("StyleSheets");
            writer.WriteStartElement("StyleSheet");
            writer.WriteAttributeString("ID", "0");
            writer.WriteAttributeString("NameU", "No Style");
            writer.WriteAttributeString("Name", "No Style");

            writer.WriteStartElement("Line");
            WriteCell(writer, "LineWeight", 0.01);
            writer.WriteStartElement("LineColor");
            writer.WriteString("#000000");
            writer.WriteEndElement();
            WriteCell(writer, "LinePattern", 1);
            writer.WriteEndElement();

            writer.WriteStartElement("Fill");
            writer.WriteStartElement("FillForegnd");
            writer.WriteString("#ffffff");
            writer.WriteEndElement();
            WriteCell(writer, "FillPattern", 1);
            writer.WriteEndElement();

            writer.WriteStartElement("Char");
            WriteCell(writer, "Font", 1);
            WriteCell(writer, "Size", 0.1111);
            writer.WriteStartElement("Color");
            writer.WriteString("#000000");
            writer.WriteEndElement();
            writer.WriteEndElement();

            writer.WriteEndElement(); // StyleSheet
            writer.WriteEndElement(); // StyleSheets
        }

        private static void WriteTableShape(
            XmlWriter writer, DiagramDocument document, DiagramTable table, int id,
            CanvasBounds bounds, HashSet<string> tableNames)
        {
            var rows = ExportRowBuilder.RowsFor(document, table).ToList();
            var widthPx = TableWidthPx(table);
            var heightPx = TableHeightPx(rows.Count);

            var width = widthPx / PixelsPerInch;
            var height = heightPx / PixelsPerInch;
            var pinX = (table.X - bounds.MinX + widthPx / 2) / PixelsPerInch + PageMarginInches;
            var pinY = bounds.PageHeight - ((table.Y - bounds.MinY + heightPx / 2) / PixelsPerInch) - PageMarginInches;

            writer.WriteStartElement("Shape");
            writer.WriteAttributeString("ID", id.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("Type", "Shape");
            writer.WriteAttributeString("LineStyle", "0");
            writer.WriteAttributeString("FillStyle", "0");
            writer.WriteAttributeString("TextStyle", "0");
            writer.WriteAttributeString("NameU", SafeName(table.DisplayName, id, tableNames));

            WriteXForm(writer, pinX, pinY, width, height);

            writer.WriteStartElement("Line");
            WriteCell(writer, "LineWeight", table.Status == ObjectStatus.Existing ? 0.01 : 0.014);
            WriteColourCell(writer, "LineColor", StatusStroke(table.Status));
            WriteCell(writer, "LinePattern", table.Status == ObjectStatus.Existing ? 1 : 2);
            WriteCell(writer, "Rounding", 0.06);
            writer.WriteEndElement();

            writer.WriteStartElement("Fill");
            WriteColourCell(writer, "FillForegnd", StatusFill(table.Status));
            WriteCell(writer, "FillPattern", 1);
            writer.WriteEndElement();

            writer.WriteStartElement("Char");
            WriteCell(writer, "Font", 1);
            WriteCell(writer, "Size", 0.09);
            WriteColourCell(writer, "Color", "#101725");
            writer.WriteEndElement();

            writer.WriteStartElement("Para");
            WriteCell(writer, "HorzAlign", 0);
            writer.WriteEndElement();

            writer.WriteStartElement("TextBlock");
            WriteCell(writer, "LeftMargin", 0.06);
            WriteCell(writer, "RightMargin", 0.06);
            WriteCell(writer, "TopMargin", 0.05);
            WriteCell(writer, "VerticalAlign", 0);
            writer.WriteEndElement();

            WriteRectangleGeometry(writer);

            var text = new StringBuilder();
            text.Append(ExportRowBuilder.TitleFor(document, table));
            foreach (var row in rows)
            {
                text.Append('\n');
                text.Append(row.Text);
            }

            if (!string.IsNullOrWhiteSpace(table.Notes))
            {
                text.Append('\n');
                text.Append('\n');
                text.Append(table.Notes);
            }

            writer.WriteElementString("Text", ExportText.StripInvalidXml(text.ToString()));
            writer.WriteEndElement(); // Shape
        }

        private static void WriteConnectorShape(
            XmlWriter writer, DiagramDocument document, DiagramRelationship relationship,
            int id, DiagramTable from, DiagramTable to, CanvasBounds bounds)
        {
            var beginX = (from.X - bounds.MinX + TableWidthPx(from)) / PixelsPerInch + PageMarginInches;
            var beginY = bounds.PageHeight - ((from.Y - bounds.MinY + 40) / PixelsPerInch) - PageMarginInches;
            var endX = (to.X - bounds.MinX) / PixelsPerInch + PageMarginInches;
            var endY = bounds.PageHeight - ((to.Y - bounds.MinY + 40) / PixelsPerInch) - PageMarginInches;

            writer.WriteStartElement("Shape");
            writer.WriteAttributeString("ID", id.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("Type", "Shape");
            writer.WriteAttributeString("LineStyle", "0");
            writer.WriteAttributeString("FillStyle", "0");
            writer.WriteAttributeString("TextStyle", "0");
            writer.WriteAttributeString("NameU", "Connector." + id.ToString(CultureInfo.InvariantCulture));

            var width = endX - beginX;
            var height = endY - beginY;

            writer.WriteStartElement("XForm");
            WriteCell(writer, "PinX", beginX + width / 2);
            WriteCell(writer, "PinY", beginY + height / 2);
            WriteCell(writer, "Width", Math.Abs(width) < 0.01 ? 0.01 : Math.Abs(width));
            WriteCell(writer, "Height", Math.Abs(height) < 0.01 ? 0.01 : Math.Abs(height));
            WriteCell(writer, "LocPinX", Math.Abs(width) / 2);
            WriteCell(writer, "LocPinY", Math.Abs(height) / 2);
            WriteCell(writer, "Angle", 0);

            // The Geom below is a fixed diagonal from (0,0) to (Width, Height), bound to the
            // absolute Width and Height cells, and Visio's y axis points up - so without a flip the
            // line always runs bottom-left to top-right, and a connector whose target sits below
            // or to the left of its source would join the wrong two corners. This XForm is written
            // inline rather than through WriteXForm, so it writes its own FlipX and FlipY cells.
            // The box and the LocPin are already absolute, so mirroring about the centre is all it
            // takes to pick the other diagonal.
            WriteCell(writer, "FlipX", endX < beginX ? 1 : 0);
            WriteCell(writer, "FlipY", endY < beginY ? 1 : 0);
            writer.WriteEndElement();

            writer.WriteStartElement("XForm1D");
            WriteCell(writer, "BeginX", beginX);
            WriteCell(writer, "BeginY", beginY);
            WriteCell(writer, "EndX", endX);
            WriteCell(writer, "EndY", endY);
            writer.WriteEndElement();

            writer.WriteStartElement("Line");
            WriteCell(writer, "LineWeight", 0.01);
            WriteColourCell(writer, "LineColor", relationship.Status == ObjectStatus.Existing ? "#8ea3c4" : "#c98a12");
            WriteCell(writer, "LinePattern", relationship.Status == ObjectStatus.Existing ? 1 : 2);
            WriteCell(writer, "EndArrow", relationship.Kind == RelationshipKind.ManyToOne ? 0 : 4);
            WriteCell(writer, "BeginArrow", relationship.Kind == RelationshipKind.ManyToOne ? 4 : 0);
            writer.WriteEndElement();

            writer.WriteStartElement("Char");
            WriteCell(writer, "Font", 2);
            WriteCell(writer, "Size", 0.075);
            WriteColourCell(writer, "Color", "#5b6577");
            writer.WriteEndElement();

            writer.WriteStartElement("Geom");
            writer.WriteAttributeString("IX", "0");
            WriteCell(writer, "NoFill", 1);
            WriteCell(writer, "NoLine", 0);
            writer.WriteStartElement("MoveTo");
            writer.WriteAttributeString("IX", "1");
            WriteCell(writer, "X", 0);
            WriteCell(writer, "Y", 0);
            writer.WriteEndElement();
            writer.WriteStartElement("LineTo");
            writer.WriteAttributeString("IX", "2");
            WriteFormulaCell(writer, "X", "Width*1", Math.Abs(width));
            WriteFormulaCell(writer, "Y", "Height*1", Math.Abs(height));
            writer.WriteEndElement();
            writer.WriteEndElement(); // Geom

            var label = new List<string>();
            if (document.Settings.ShowCardinality) label.Add(ExportRowBuilder.CardinalityText(relationship.Kind));
            if (document.Settings.ShowRelationshipName && !string.IsNullOrEmpty(relationship.SchemaName))
                label.Add(relationship.SchemaName);
            if (relationship.Kind == RelationshipKind.ManyToMany && !string.IsNullOrEmpty(relationship.IntersectEntity))
                label.Add("via " + relationship.IntersectEntity);
            if (relationship.Status == ObjectStatus.Proposed) label.Insert(0, "proposed");

            writer.WriteElementString("Text", ExportText.StripInvalidXml(string.Join(" ", label)));
            writer.WriteEndElement(); // Shape
        }

        private static void WriteAnnotationShape(XmlWriter writer, DiagramAnnotation annotation, int id, CanvasBounds bounds)
        {
            // Through AnnotationRect, which applies the canvas's defaults and floors, so a
            // zero-sized or size-less annotation is written at the drawn size.
            var rect = ExportRowBuilder.AnnotationRect(annotation);

            var width = rect.Width / PixelsPerInch;
            var height = rect.Height / PixelsPerInch;
            var pinX = (rect.X - bounds.MinX + rect.Width / 2) / PixelsPerInch + PageMarginInches;
            var pinY = bounds.PageHeight - ((rect.Y - bounds.MinY + rect.Height / 2) / PixelsPerInch) - PageMarginInches;

            writer.WriteStartElement("Shape");
            writer.WriteAttributeString("ID", id.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("Type", "Shape");
            writer.WriteAttributeString("LineStyle", "0");
            writer.WriteAttributeString("FillStyle", "0");
            writer.WriteAttributeString("TextStyle", "0");
            writer.WriteAttributeString("NameU", "Note." + id.ToString(CultureInfo.InvariantCulture));

            WriteXForm(writer, pinX, pinY, width, height);

            // A text box is text and nothing else, so it gets no paper or border. It has to be
            // explicit, because NullValueHandling.Ignore leaves the C# defaults standing when the
            // canvas sends nulls for Background and Border.
            var isText = AnnotationKinds.IsText(annotation);

            writer.WriteStartElement("Line");
            WriteCell(writer, "LineWeight", 0.01);
            WriteCell(writer, "LinePattern", isText ? 0 : 1);
            if (!isText) WriteColourCell(writer, "LineColor", annotation.Border ?? "#e8d9a8");
            WriteCell(writer, "Rounding", 0.03);
            writer.WriteEndElement();

            writer.WriteStartElement("Fill");
            if (!isText) WriteColourCell(writer, "FillForegnd", annotation.Background ?? "#fff8e1");
            WriteCell(writer, "FillPattern", isText ? 0 : 1);
            writer.WriteEndElement();

            writer.WriteStartElement("Char");
            WriteCell(writer, "Font", 1);
            // Same guard the draw.io exporter applies: a font size of zero - or a negative one from
            // a hand-edited file - would otherwise be written straight into the shape.
            WriteCell(writer, "Size", (annotation.FontSize <= 0
                ? ExportRowBuilder.DefaultFontSize : annotation.FontSize) / PixelsPerInch);
            // Bit flags in the Char section: 1 is bold. A new sticky note is bold, so the weight is
            // carried along with the size to match the note on the canvas.
            WriteCell(writer, "Style", annotation.Bold ? 1 : 0);
            WriteColourCell(writer, "Color", isText ? (annotation.Ink ?? "#3d4759") : "#3d4759");
            writer.WriteEndElement();

            WriteRectangleGeometry(writer);
            writer.WriteElementString("Text", ExportText.StripInvalidXml(annotation.Text));
            writer.WriteEndElement();
        }

        private static void WriteTitleShape(XmlWriter writer, DiagramDocument document, int id, CanvasBounds bounds)
        {
            writer.WriteStartElement("Shape");
            writer.WriteAttributeString("ID", id.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("Type", "Shape");
            writer.WriteAttributeString("LineStyle", "0");
            writer.WriteAttributeString("FillStyle", "0");
            writer.WriteAttributeString("TextStyle", "0");
            writer.WriteAttributeString("NameU", "TitleBlock");

            WriteXForm(writer, 3.0, bounds.PageHeight - 0.35, 5.6, 0.5);

            writer.WriteStartElement("Line");
            WriteCell(writer, "NoLine", 1);
            writer.WriteEndElement();

            writer.WriteStartElement("Fill");
            WriteCell(writer, "NoFill", 1);
            writer.WriteEndElement();

            writer.WriteStartElement("Char");
            WriteCell(writer, "Font", 1);
            WriteCell(writer, "Size", 0.14);
            WriteCell(writer, "Style", 1);
            WriteColourCell(writer, "Color", "#101725");
            writer.WriteEndElement();

            writer.WriteStartElement("Para");
            WriteCell(writer, "HorzAlign", 0);
            writer.WriteEndElement();

            WriteRectangleGeometry(writer);

            var subtitle = new List<string>();
            if (!string.IsNullOrWhiteSpace(document.Source?.OrganizationFriendlyName))
                subtitle.Add(document.Source.OrganizationFriendlyName);
            if (document.Source?.LastRefreshUtc != null)
                subtitle.Add("refreshed " + document.Source.LastRefreshUtc.Value.ToLocalTime().ToString("dd/MM/yyyy", CultureInfo.GetCultureInfo("en-GB")));

            var text = document.Title ?? "Dataverse model";
            if (subtitle.Count > 0) text += "\n" + string.Join("  -  ", subtitle);

            writer.WriteElementString("Text", ExportText.StripInvalidXml(text));
            writer.WriteEndElement();
        }

        // ------------------------------------------------------------------

        private static void WriteXForm(XmlWriter writer, double pinX, double pinY, double width, double height)
        {
            writer.WriteStartElement("XForm");
            WriteCell(writer, "PinX", pinX);
            WriteCell(writer, "PinY", pinY);
            WriteCell(writer, "Width", width);
            WriteCell(writer, "Height", height);
            WriteCell(writer, "LocPinX", width / 2);
            WriteCell(writer, "LocPinY", height / 2);
            WriteCell(writer, "Angle", 0);
            WriteCell(writer, "FlipX", 0);
            WriteCell(writer, "FlipY", 0);
            writer.WriteEndElement();
        }

        private static void WriteRectangleGeometry(XmlWriter writer)
        {
            writer.WriteStartElement("Geom");
            writer.WriteAttributeString("IX", "0");
            WriteCell(writer, "NoFill", 0);
            WriteCell(writer, "NoLine", 0);

            writer.WriteStartElement("MoveTo");
            writer.WriteAttributeString("IX", "1");
            WriteCell(writer, "X", 0);
            WriteCell(writer, "Y", 0);
            writer.WriteEndElement();

            WriteLineTo(writer, 2, "Width*1", "0");
            WriteLineTo(writer, 3, "Width*1", "Height*1");
            WriteLineTo(writer, 4, "0", "Height*1");
            WriteLineTo(writer, 5, "0", "0");

            writer.WriteEndElement();
        }

        private static void WriteLineTo(XmlWriter writer, int index, string xFormula, string yFormula)
        {
            writer.WriteStartElement("LineTo");
            writer.WriteAttributeString("IX", index.ToString(CultureInfo.InvariantCulture));
            WriteFormulaCell(writer, "X", xFormula, 0);
            WriteFormulaCell(writer, "Y", yFormula, 0);
            writer.WriteEndElement();
        }

        private static void WriteFormulaCell(XmlWriter writer, string name, string formula, double value)
        {
            writer.WriteStartElement(name);
            writer.WriteAttributeString("F", formula);
            writer.WriteString(Num(value));
            writer.WriteEndElement();
        }

        private static void WriteCell(XmlWriter writer, string name, double value)
        {
            writer.WriteStartElement(name);
            writer.WriteString(Num(value));
            writer.WriteEndElement();
        }

        private static void WriteColourCell(XmlWriter writer, string name, string colour)
        {
            writer.WriteStartElement(name);
            writer.WriteString(colour ?? "#000000");
            writer.WriteEndElement();
        }

        private static void WriteConnect(XmlWriter writer, int connectorId, string fromCell, int fromPart, int toSheet)
        {
            writer.WriteStartElement("Connect");
            writer.WriteAttributeString("FromSheet", connectorId.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("FromCell", fromCell);
            writer.WriteAttributeString("FromPart", fromPart.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("ToSheet", toSheet.ToString(CultureInfo.InvariantCulture));
            writer.WriteAttributeString("ToPart", "3");
            writer.WriteAttributeString("ToCell", "PinX");
            writer.WriteEndElement();
        }

        /// <summary>
        /// The canvas extent the shapes are placed from, and the page size that has to hold it.
        ///
        /// The page grows to the true span, so a diagram wider or taller than the minimum sheet
        /// keeps every shape on the page.
        /// </summary>
        private static CanvasBounds ComputeBounds(DiagramDocument document)
        {
            var bounds = new CanvasBounds { MinX = 0, MinY = 0, MaxX = 0, MaxY = 0 };

            if (document.Tables.Count > 0)
            {
                bounds.MinX = document.Tables.Min(t => t.X);
                bounds.MinY = document.Tables.Min(t => t.Y);
                bounds.MaxX = bounds.MinX;
                bounds.MaxY = bounds.MinY;

                foreach (var table in document.Tables)
                {
                    var rows = ExportRowBuilder.SelectedColumns(document, table).Count();
                    bounds.MaxX = Math.Max(bounds.MaxX, table.X + TableWidthPx(table));
                    bounds.MaxY = Math.Max(bounds.MaxY, table.Y + TableHeightPx(rows));
                }
            }

            // Through AnnotationRect, which normalises an arrow into a box: its head is at X+Dx,
            // Y+Dy and either can be negative, so one drawn up and to the left has its far end
            // outside the box its start point describes.
            foreach (var annotation in document.Annotations)
            {
                var rect = ExportRowBuilder.AnnotationRect(annotation);
                bounds.MinX = Math.Min(bounds.MinX, rect.X);
                bounds.MinY = Math.Min(bounds.MinY, rect.Y);
                bounds.MaxX = Math.Max(bounds.MaxX, rect.X + rect.Width);
                bounds.MaxY = Math.Max(bounds.MaxY, rect.Y + rect.Height);
            }

            // A margin at each edge, matching the 0.5in offset every Pin is placed at.
            bounds.PageWidth = Math.Max(MinPageWidthInches,
                (bounds.MaxX - bounds.MinX) / PixelsPerInch + PageMarginInches * 2);
            bounds.PageHeight = Math.Max(MinPageHeightInches,
                (bounds.MaxY - bounds.MinY) / PixelsPerInch + PageMarginInches * 2);

            return bounds;
        }

        private static double TableWidthPx(DiagramTable table)
        {
            return table.Width ?? DefaultWidthPx;
        }

        private static double TableHeightPx(int rowCount)
        {
            return HeaderHeightPx + rowCount * RowHeightPx + 8;
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

        /// <summary>
        /// A NameU for a table shape, unique within the page.
        ///
        /// Visio treats NameU as a shape's unique identifier, and two tables can display the same
        /// name - an existing and a proposed "Account", say - so a collision is suffixed, the way
        /// MermaidExporter.MermaidName does. Connector and note shapes are
        /// already id-suffixed and cannot collide.
        /// </summary>
        private static string SafeName(string value, int id, HashSet<string> issued)
        {
            var fallback = "Table." + id.ToString(CultureInfo.InvariantCulture);

            var name = fallback;
            if (!string.IsNullOrWhiteSpace(value))
            {
                var cleaned = new string(value.Where(c => char.IsLetterOrDigit(c) || c == ' ' || c == '_').ToArray()).Trim();
                if (cleaned.Length > 0) name = cleaned;
            }

            if (issued == null || issued.Add(name)) return name;

            var suffix = 2;
            while (!issued.Add(name + "." + suffix.ToString(CultureInfo.InvariantCulture))) suffix++;
            return name + "." + suffix.ToString(CultureInfo.InvariantCulture);
        }

        private static string Num(double value)
        {
            return Math.Round(value, 4).ToString(CultureInfo.InvariantCulture);
        }

        private class CanvasBounds
        {
            public double MinX { get; set; }
            public double MinY { get; set; }
            public double MaxX { get; set; }
            public double MaxY { get; set; }

            /// <summary>The page the shapes are laid out on, in inches. Never below the minimums.</summary>
            public double PageWidth { get; set; }
            public double PageHeight { get; set; }
        }

        private class ConnectRecord
        {
            public int ConnectorId { get; set; }
            public int FromShape { get; set; }
            public int ToShape { get; set; }
        }
    }
}
