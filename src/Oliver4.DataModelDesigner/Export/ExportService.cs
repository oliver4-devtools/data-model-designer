using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Export
{
    /// <summary>Text or binary payload produced by an exporter, plus anything the format loses.</summary>
    public class ExportProduct
    {
        public string Text { get; set; }
        public byte[] Bytes { get; set; }
        public List<string> Warnings { get; set; } = new List<string>();
    }

    /// <summary>What the canvas sends when the user asks to export.</summary>
    public class ExportRequest
    {
        [JsonProperty("format")]
        [JsonConverter(typeof(Newtonsoft.Json.Converters.StringEnumConverter))]
        public ExportFormat Format { get; set; }

        [JsonProperty("document")] public DiagramDocument Document { get; set; }

        /// <summary>Serialised SVG of the current canvas, produced by the renderer.</summary>
        [JsonProperty("svg")] public string Svg { get; set; }

        /// <summary>data: URL of the rasterised canvas, for PNG export.</summary>
        [JsonProperty("pngDataUrl")] public string PngDataUrl { get; set; }

        [JsonProperty("path")] public string Path { get; set; }
    }

    public class ExportResponse
    {
        [JsonProperty("path")] public string Path { get; set; }
        [JsonProperty("warnings")] public List<string> Warnings { get; set; } = new List<string>();
        [JsonProperty("cancelled")] public bool Cancelled { get; set; }
    }

    /// <summary>
    /// Turns a diagram into a file. Raster and vector output come from the canvas renderer, which
    /// already knows exactly what is on screen; the structured formats are generated here from the
    /// document model.
    /// </summary>
    public static class ExportService
    {
        public static string FileFilter(ExportFormat format)
        {
            switch (format)
            {
                case ExportFormat.Png: return "PNG image (*.png)|*.png";
                case ExportFormat.Svg: return "SVG image (*.svg)|*.svg";
                case ExportFormat.DrawIo: return "draw.io diagram (*.drawio)|*.drawio|XML file (*.xml)|*.xml";
                case ExportFormat.Visio: return "Visio 2003 XML drawing (*.vdx)|*.vdx";
                case ExportFormat.Mermaid: return "Mermaid diagram (*.mmd)|*.mmd";
                case ExportFormat.DocumentationMarkdown: return "Markdown document (*.md)|*.md";
                case ExportFormat.DocumentationHtml: return "HTML document (*.html)|*.html|Web page (*.htm)|*.htm";
                default: return "All files (*.*)|*.*";
            }
        }

        public static string DefaultExtension(ExportFormat format)
        {
            switch (format)
            {
                case ExportFormat.Png: return ".png";
                case ExportFormat.Svg: return ".svg";
                case ExportFormat.DrawIo: return ".drawio";
                case ExportFormat.Visio: return ".vdx";
                case ExportFormat.Mermaid: return ".mmd";
                case ExportFormat.DocumentationMarkdown: return ".md";
                case ExportFormat.DocumentationHtml: return ".html";
                default: return ".txt";
            }
        }

        /// <summary>
        /// The one sentence about a format that is true whatever the diagram contains, attached to
        /// the exported product so it reaches the user in the completion toast.
        ///
        /// The warnings that depend on what is actually on the canvas - "highlight colours on 3
        /// objects", "5 canvas notes" - are produced in Web/js/exporter.js and shown *before* the
        /// user picks a filename, which is the only point at which backing out is still cheap.
        /// This list does not duplicate those.
        /// </summary>
        public static List<string> FormatWarnings(ExportFormat format, DiagramDocument document)
        {
            var warnings = new List<string>();
            if (document == null) return warnings;

            switch (format)
            {
                case ExportFormat.Png:
                    warnings.Add("PNG is a flat image. It cannot be edited and does not carry table or relationship metadata.");
                    break;

                case ExportFormat.Svg:
                    warnings.Add("SVG keeps the visual layout and text but is not an editable data model.");
                    break;

                case ExportFormat.DrawIo:
                    // Per-table detail overrides *are* carried over - the exporter goes through
                    // ExportRowBuilder.SelectedColumns, which honours DetailOverride and exports a
                    // collapsed card header-only, exactly as the canvas draws it. Cascade
                    // configuration is the part draw.io has no place for.
                    warnings.Add("draw.io keeps layout, tables, columns and relationships as editable shapes, including per-table detail overrides. Cascade configuration is not carried over, and a collapsed card exports with no columns.");
                    break;

                case ExportFormat.Visio:
                    warnings.Add("Visio export is experimental and is written as Visio 2003 XML (.vdx). Check the result opens as expected before relying on it.");
                    break;

                case ExportFormat.Mermaid:
                    warnings.Add("This format describes structure only. Manual layout, highlights and notes are lost.");
                    break;

                case ExportFormat.DocumentationMarkdown:
                case ExportFormat.DocumentationHtml:
                    warnings.Add("The document describes the model rather than the picture: the table catalogue, the relationships and their cascade behaviour, and a register of everything the diagram proposes. Manual layout and emphasis colours are not represented.");
                    break;
            }

            return warnings;
        }

        public static ExportProduct Build(ExportRequest request)
        {
            if (request == null) throw new ArgumentNullException(nameof(request));

            if (request.Document == null)
                throw new InvalidOperationException("There is no diagram to export.");

            if (request.Format != ExportFormat.Png && request.Format != ExportFormat.Svg &&
                request.Document.Tables.Count == 0)
            {
                throw new InvalidOperationException(
                    "This diagram has no tables on it, so there is nothing for " + request.Format +
                    " to describe. Add some tables first.");
            }

            switch (request.Format)
            {
                case ExportFormat.Png:
                    return new ExportProduct
                    {
                        Bytes = DecodeDataUrl(request.PngDataUrl),
                        Warnings = FormatWarnings(ExportFormat.Png, request.Document)
                    };

                case ExportFormat.Svg:
                    if (string.IsNullOrWhiteSpace(request.Svg))
                    {
                        throw new InvalidOperationException(
                            "The canvas did not produce any SVG to export. Try again, and if it keeps " +
                            "happening close and reopen the tool.");
                    }

                    return new ExportProduct
                    {
                        Text = request.Svg,
                        Warnings = FormatWarnings(ExportFormat.Svg, request.Document)
                    };

                case ExportFormat.DrawIo:
                    return DrawIoExporter.Export(request.Document);

                case ExportFormat.Visio:
                    return VisioExporter.Export(request.Document);

                case ExportFormat.Mermaid:
                    return MermaidExporter.Export(request.Document);

                case ExportFormat.DocumentationMarkdown:
                    return DocumentationExporter.ExportMarkdown(request.Document);

                case ExportFormat.DocumentationHtml:
                    return DocumentationExporter.ExportHtml(request.Document);

                default:
                    throw new NotSupportedException("Unknown export format: " + request.Format);
            }
        }

        public static void Write(ExportProduct product, string path)
        {
            try
            {
                if (product.Bytes != null)
                {
                    File.WriteAllBytes(path, product.Bytes);
                    return;
                }

                File.WriteAllText(path, product.Text ?? string.Empty, new UTF8Encoding(false));
            }
            catch (UnauthorizedAccessException ex)
            {
                throw new IOException(
                    "Cannot write to " + path + ". The file or folder is read-only, or your account " +
                    "does not have permission to write there. Try exporting somewhere else.", ex);
            }
            catch (DirectoryNotFoundException ex)
            {
                throw new IOException(
                    "The folder for " + path + " no longer exists. Choose a folder that does.", ex);
            }
            catch (IOException ex)
            {
                throw new IOException(
                    "Could not write " + path + ". The file may be open in another program, or the " +
                    "drive may be full or disconnected. (" + ex.Message + ")", ex);
            }
        }

        private static byte[] DecodeDataUrl(string dataUrl)
        {
            if (string.IsNullOrWhiteSpace(dataUrl))
                throw new InvalidOperationException("The canvas did not return an image to export.");

            var marker = dataUrl.IndexOf("base64,", StringComparison.OrdinalIgnoreCase);
            var payload = marker >= 0 ? dataUrl.Substring(marker + 7) : dataUrl;

            try
            {
                return Convert.FromBase64String(payload);
            }
            catch (FormatException ex)
            {
                throw new InvalidOperationException("The image returned by the canvas could not be decoded.", ex);
            }
        }
    }
}
