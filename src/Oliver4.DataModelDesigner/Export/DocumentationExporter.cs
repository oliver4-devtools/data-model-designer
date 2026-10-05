using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using Oliver4.DataModelDesigner.Model;
using Oliver4.DataModelDesigner.Services;

namespace Oliver4.DataModelDesigner.Export
{
    /// <summary>
    /// Turns a diagram into the data-model section of a design document.
    ///
    /// This is the one export that is not a picture: it writes the table catalogue, the
    /// relationship list with its cascade behaviour, and a record of what is being proposed and
    /// why, all taken from the diagram.
    ///
    /// Two shapes of the same content: Markdown for an Azure DevOps wiki, and a self-contained HTML
    /// page that prints. Not .docx - a real Word file needs the Open XML SDK, and a second
    /// assembly would break the single-DLL deployment. Word opens the HTML, and the Markdown pastes.
    ///
    /// Columns follow the diagram's own detail rules through ExportRowBuilder, so the document says
    /// what the diagram says. Anything the user unticked is out of both.
    /// </summary>
    public static class DocumentationExporter
    {
        public static ExportProduct ExportMarkdown(DiagramDocument document)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));

            var model = Build(document);
            var builder = new StringBuilder();

            builder.AppendLine("# " + Clean(document.Title));
            builder.AppendLine();

            if (!string.IsNullOrWhiteSpace(document.Description))
            {
                builder.AppendLine(Clean(document.Description));
                builder.AppendLine();
            }

            AppendMarkdownProvenance(builder, document, model);

            builder.AppendLine("## Contents");
            builder.AppendLine();
            builder.AppendLine("- [Summary](#summary)");
            builder.AppendLine("- [Diagram](#diagram)");
            builder.AppendLine("- [Tables](#tables)");
            builder.AppendLine("- [Relationships](#relationships)");
            if (model.HasDesign) builder.AppendLine("- [Proposed and deprecated objects](#proposed-and-deprecated-objects)");
            if (model.Notes.Count > 0 || model.Arrows > 0)
                builder.AppendLine("- [Notes and labels](#notes-and-labels)");
            builder.AppendLine();

            // -------------------------------------------------------------- summary --
            builder.AppendLine("## Summary");
            builder.AppendLine();
            builder.AppendLine("| | Count |");
            builder.AppendLine("|---|---:|");
            builder.AppendLine("| Tables | " + model.Tables.Count + " |");

            foreach (var entry in model.StatusCounts)
                builder.AppendLine("| - " + StatusWord(entry.Key) + " | " + entry.Value + " |");

            builder.AppendLine("| Relationships drawn | " + model.Relationships.Count + " |");
            if (model.RelationshipsNotDrawn > 0)
                builder.AppendLine("| Relationships recorded but not drawn | " + model.RelationshipsNotDrawn + " |");
            builder.AppendLine();

            // -------------------------------------------------------------- diagram --
            builder.AppendLine("## Diagram");
            builder.AppendLine();
            // A diagram title or a proposed relationship name containing a backtick run could
            // otherwise close the fence early and spill the rest of the Mermaid source into the
            // document as prose. A longer fence costs nothing and cannot be closed from inside.
            var mermaid = MermaidExporter.Export(document).Text.TrimEnd();
            var fence = mermaid.Contains("```") ? "`````" : "```";

            builder.AppendLine(fence + "mermaid");
            builder.AppendLine(mermaid);
            builder.AppendLine(fence);
            builder.AppendLine();
            builder.AppendLine("> The diagram above is generated from the model and does not carry the " +
                               "manual layout, emphasis colours or notes from the designer. Export to PNG " +
                               "or SVG for the arranged version.");
            builder.AppendLine();

            // --------------------------------------------------------------- tables --
            builder.AppendLine("## Tables");
            builder.AppendLine();

            foreach (var table in model.Tables)
            {
                builder.AppendLine("### " + Clean(table.DisplayName ?? table.LogicalName));
                builder.AppendLine();

                builder.AppendLine("| | |");
                builder.AppendLine("|---|---|");
                builder.AppendLine("| Schema name | " + Code(table.LogicalName ?? table.SchemaName) + " |");
                builder.AppendLine("| Status | " + StatusWord(table.Status) + " |");

                if (table.Status == ObjectStatus.Existing || table.Status == ObjectStatus.Deprecated)
                {
                    builder.AppendLine("| Type | " + (table.IsCustom ? "Custom" : "System") +
                                       (table.IsActivity ? ", activity" : string.Empty) +
                                       (table.IsIntersect ? ", intersect" : string.Empty) + " |");
                    builder.AppendLine("| Ownership | " + OwnershipWord(table.OwnershipType) + " |");
                    builder.AppendLine("| Primary key | " + Code(table.PrimaryIdAttribute) + " |");
                }

                if (!string.IsNullOrWhiteSpace(table.Owner))
                    builder.AppendLine("| Owner or workstream | " + Clean(table.Owner) + " |");

                builder.AppendLine();

                if (!string.IsNullOrWhiteSpace(table.Description))
                {
                    builder.AppendLine(Clean(table.Description));
                    builder.AppendLine();
                }

                var rows = ExportRowBuilder.RowsFor(document, table).ToList();
                if (rows.Count > 0)
                {
                    builder.AppendLine("| Column | Type | Key | Status |");
                    builder.AppendLine("|---|---|---|---|");

                    foreach (var row in rows)
                    {
                        builder.AppendLine("| " + Code(row.Name) + " | " +
                                           Clean(Dash(row.TypeName)) + " | " +
                                           Clean(Dash(row.KeyMarker)) + " | " +
                                           StatusWord(row.Status) + " |");
                    }

                    builder.AppendLine();
                }
                else
                {
                    builder.AppendLine("_No columns are shown for this table at the diagram's current detail level._");
                    builder.AppendLine();
                }

                foreach (var key in table.AlternateKeys ?? new List<AlternateKeyInfo>())
                {
                    builder.AppendLine("**Alternate key** " + Code(key.SchemaName ?? key.DisplayName) + ": " +
                                       string.Join(", ", (key.Columns ?? new List<string>()).Select(Code)) +
                                       (string.IsNullOrEmpty(key.State) || key.State == "Active"
                                           ? string.Empty
                                           : " (index state: " + Clean(key.State) + ")"));
                    builder.AppendLine();
                }

                if (!string.IsNullOrWhiteSpace(table.Notes))
                {
                    builder.AppendLine("> **Note.** " + Clean(table.Notes));
                    builder.AppendLine();
                }
            }

            // -------------------------------------------------------- relationships --
            builder.AppendLine("## Relationships");
            builder.AppendLine();

            if (model.Relationships.Count == 0)
            {
                builder.AppendLine("_No relationships are drawn on this diagram._");
                builder.AppendLine();
            }
            else
            {
                builder.AppendLine("| From (one) | To (many) | Type | Lookup column | Schema name | Status |");
                builder.AppendLine("|---|---|---|---|---|---|");

                foreach (var entry in model.Relationships)
                {
                    builder.AppendLine("| " + Clean(entry.FromName) + " | " + Clean(entry.ToName) + " | " +
                                       (entry.Relationship.Kind == RelationshipKind.ManyToMany ? "N:N" : "1:N") + " | " +
                                       Code(entry.Relationship.Kind == RelationshipKind.ManyToMany
                                           ? entry.Relationship.IntersectEntity
                                           : entry.Relationship.ReferencingAttribute) + " | " +
                                       Code(entry.Relationship.SchemaName) + " | " +
                                       StatusWord(entry.Relationship.Status) + " |");
                }

                builder.AppendLine();

                var cascading = model.Relationships
                    .Where(e => e.Relationship.Cascade != null)
                    .ToList();

                if (cascading.Count > 0)
                {
                    builder.AppendLine("### Cascade behaviour");
                    builder.AppendLine();
                    builder.AppendLine("What happens to the records on the \"many\" side when the record on the " +
                                       "\"one\" side is changed.");
                    builder.AppendLine();
                    builder.AppendLine("| Relationship | Assign | Delete | Merge | Reparent | Share | Unshare |");
                    builder.AppendLine("|---|---|---|---|---|---|---|");

                    foreach (var entry in cascading)
                    {
                        var cascade = entry.Relationship.Cascade;
                        builder.AppendLine("| " + Code(entry.Relationship.SchemaName) + " | " +
                                           Clean(Dash(cascade.Assign)) + " | " + Clean(Dash(cascade.Delete)) + " | " +
                                           Clean(Dash(cascade.Merge)) + " | " + Clean(Dash(cascade.Reparent)) + " | " +
                                           Clean(Dash(cascade.Share)) + " | " + Clean(Dash(cascade.Unshare)) + " |");
                    }

                    builder.AppendLine();

                    var deletes = cascading
                        .Where(e => string.Equals(e.Relationship.Cascade.Delete, "Cascade", StringComparison.Ordinal))
                        .ToList();

                    if (deletes.Count > 0)
                    {
                        builder.AppendLine("> **Cascading deletes.** Deleting a " +
                                           string.Join(", ", deletes.Select(e => Clean(e.FromName)).Distinct()) +
                                           " record also deletes its related " +
                                           string.Join(", ", deletes.Select(e => Clean(e.ToName)).Distinct()) +
                                           " records.");
                        builder.AppendLine();
                    }
                }
            }

            // ------------------------------------------------------ design register --
            if (model.HasDesign)
            {
                builder.AppendLine("## Proposed and deprecated objects");
                builder.AppendLine();
                builder.AppendLine("Everything on this diagram that does not match the environment as it stands. " +
                                   "None of it has been created or changed in Dataverse.");
                builder.AppendLine();
                builder.AppendLine("| Object | Kind | Status | Note |");
                builder.AppendLine("|---|---|---|---|");

                foreach (var entry in model.DesignRegister)
                {
                    builder.AppendLine("| " + Clean(entry.Name) + " | " + entry.Kind + " | " +
                                       StatusWord(entry.Status) + " | " +
                                       (string.IsNullOrWhiteSpace(entry.Note) ? "-" : Clean(entry.Note)) + " |");
                }

                builder.AppendLine();
            }

            // ---------------------------------------------------------------- notes --
            if (model.Notes.Count > 0 || model.Arrows > 0)
            {
                builder.AppendLine("## Notes and labels");
                builder.AppendLine();

                foreach (var note in model.Notes)
                {
                    builder.AppendLine("- **" + Clean(note.Kind) + ".** " + Clean(note.Text) +
                                       (string.IsNullOrEmpty(note.Attached) ? string.Empty : "  _(on " + Clean(note.Attached) + ")_"));
                }

                if (model.Arrows > 0)
                {
                    builder.AppendLine("- " + model.Arrows + (model.Arrows == 1 ? " arrow is" : " arrows are") +
                                       " drawn on the canvas. They carry no text, so they are not reproduced here.");
                }

                builder.AppendLine();
            }

            return new ExportProduct
            {
                Text = builder.ToString(),
                Warnings = new List<string>
                {
                    "The document describes the model, not the picture. Manual layout, emphasis colours and " +
                    "note placement are not represented; the embedded Mermaid diagram is generated fresh."
                }
            };
        }

        public static ExportProduct ExportHtml(DiagramDocument document)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));

            var model = Build(document);
            var builder = new StringBuilder();

            builder.AppendLine("<!DOCTYPE html>");
            builder.AppendLine("<html lang=\"en-GB\"><head><meta charset=\"utf-8\">");
            builder.AppendLine("<title>" + Escape(document.Title) + "</title>");
            builder.AppendLine("<style>" + Stylesheet() + "</style>");
            builder.AppendLine("</head><body>");

            builder.AppendLine("<h1>" + Escape(document.Title) + "</h1>");

            if (!string.IsNullOrWhiteSpace(document.Description))
                builder.AppendLine("<p class=\"lead\">" + Escape(document.Description) + "</p>");

            AppendHtmlProvenance(builder, document, model);

            builder.AppendLine("<h2>Summary</h2>");
            builder.AppendLine("<table><tbody>");
            builder.AppendLine("<tr><th>Tables</th><td>" + model.Tables.Count + "</td></tr>");

            foreach (var entry in model.StatusCounts)
                builder.AppendLine("<tr><th>&mdash; " + StatusWord(entry.Key) + "</th><td>" + entry.Value + "</td></tr>");

            builder.AppendLine("<tr><th>Relationships drawn</th><td>" + model.Relationships.Count + "</td></tr>");
            if (model.RelationshipsNotDrawn > 0)
            {
                builder.AppendLine("<tr><th>Relationships recorded but not drawn</th><td>" +
                                   model.RelationshipsNotDrawn + "</td></tr>");
            }

            builder.AppendLine("</tbody></table>");

            builder.AppendLine("<h2>Tables</h2>");

            foreach (var table in model.Tables)
            {
                builder.AppendLine("<section class=\"table-entry status-" + table.Status.ToString().ToLowerInvariant() + "\">");
                builder.AppendLine("<h3>" + Escape(table.DisplayName ?? table.LogicalName) +
                                   " <span class=\"badge\">" + StatusWord(table.Status) + "</span></h3>");

                builder.AppendLine("<dl>");
                builder.AppendLine("<dt>Schema name</dt><dd><code>" + Escape(table.LogicalName ?? table.SchemaName ?? "-") + "</code></dd>");

                if (table.Status == ObjectStatus.Existing || table.Status == ObjectStatus.Deprecated)
                {
                    builder.AppendLine("<dt>Type</dt><dd>" + (table.IsCustom ? "Custom" : "System") +
                                       (table.IsActivity ? ", activity" : string.Empty) +
                                       (table.IsIntersect ? ", intersect" : string.Empty) + "</dd>");
                    builder.AppendLine("<dt>Ownership</dt><dd>" + OwnershipWord(table.OwnershipType) + "</dd>");
                    builder.AppendLine("<dt>Primary key</dt><dd><code>" + Escape(table.PrimaryIdAttribute ?? "-") + "</code></dd>");
                }

                if (!string.IsNullOrWhiteSpace(table.Owner))
                    builder.AppendLine("<dt>Owner or workstream</dt><dd>" + Escape(table.Owner) + "</dd>");

                builder.AppendLine("</dl>");

                if (!string.IsNullOrWhiteSpace(table.Description))
                    builder.AppendLine("<p>" + Escape(table.Description) + "</p>");

                var rows = ExportRowBuilder.RowsFor(document, table).ToList();
                if (rows.Count > 0)
                {
                    builder.AppendLine("<table><thead><tr><th>Column</th><th>Type</th><th>Key</th><th>Status</th></tr></thead><tbody>");

                    foreach (var row in rows)
                    {
                        builder.AppendLine("<tr class=\"status-" + row.Status.ToString().ToLowerInvariant() + "\">" +
                                           "<td><code>" + Escape(row.Name) + "</code></td>" +
                                           "<td>" + Escape(row.TypeName ?? "-") + "</td>" +
                                           "<td>" + Escape(string.IsNullOrEmpty(row.KeyMarker) ? "-" : row.KeyMarker) + "</td>" +
                                           "<td>" + StatusWord(row.Status) + "</td></tr>");
                    }

                    builder.AppendLine("</tbody></table>");
                }
                else
                {
                    // The Markdown branch says this too; the two documents are two shapes of the
                    // same content, so a Tables-only export states that columns are not shown.
                    builder.AppendLine("<p><em>No columns are shown for this table at the diagram's " +
                                       "current detail level.</em></p>");
                }

                foreach (var key in table.AlternateKeys ?? new List<AlternateKeyInfo>())
                {
                    builder.AppendLine("<p class=\"key\"><strong>Alternate key</strong> <code>" +
                                       Escape(key.SchemaName ?? key.DisplayName) + "</code>: " +
                                       Escape(string.Join(", ", key.Columns ?? new List<string>())) + "</p>");
                }

                if (!string.IsNullOrWhiteSpace(table.Notes))
                    builder.AppendLine("<blockquote>" + Escape(table.Notes) + "</blockquote>");

                builder.AppendLine("</section>");
            }

            builder.AppendLine("<h2>Relationships</h2>");

            if (model.Relationships.Count == 0)
            {
                builder.AppendLine("<p><em>No relationships are drawn on this diagram.</em></p>");
            }
            else
            {
                builder.AppendLine("<table><thead><tr><th>From (one)</th><th>To (many)</th><th>Type</th>" +
                                   "<th>Lookup column</th><th>Schema name</th><th>Delete</th><th>Assign</th>" +
                                   "<th>Status</th></tr></thead><tbody>");

                foreach (var entry in model.Relationships)
                {
                    var cascade = entry.Relationship.Cascade;

                    builder.AppendLine("<tr class=\"status-" + entry.Relationship.Status.ToString().ToLowerInvariant() + "\">" +
                                       "<td>" + Escape(entry.FromName) + "</td>" +
                                       "<td>" + Escape(entry.ToName) + "</td>" +
                                       "<td>" + (entry.Relationship.Kind == RelationshipKind.ManyToMany ? "N:N" : "1:N") + "</td>" +
                                       "<td><code>" + Escape(entry.Relationship.Kind == RelationshipKind.ManyToMany
                                           ? (entry.Relationship.IntersectEntity ?? "-")
                                           : (entry.Relationship.ReferencingAttribute ?? "-")) + "</code></td>" +
                                       "<td><code>" + Escape(entry.Relationship.SchemaName ?? "-") + "</code></td>" +
                                       "<td>" + Escape(Dash(cascade?.Delete)) + "</td>" +
                                       "<td>" + Escape(Dash(cascade?.Assign)) + "</td>" +
                                       "<td>" + StatusWord(entry.Relationship.Status) + "</td></tr>");
                }

                builder.AppendLine("</tbody></table>");
            }

            if (model.HasDesign)
            {
                builder.AppendLine("<h2>Proposed and deprecated objects</h2>");
                builder.AppendLine("<p>Everything on this diagram that does not match the environment as it " +
                                   "stands. None of it has been created or changed in Dataverse.</p>");
                builder.AppendLine("<table><thead><tr><th>Object</th><th>Kind</th><th>Status</th><th>Note</th>" +
                                   "</tr></thead><tbody>");

                foreach (var entry in model.DesignRegister)
                {
                    builder.AppendLine("<tr class=\"status-" + entry.Status.ToString().ToLowerInvariant() + "\">" +
                                       "<td>" + Escape(entry.Name) + "</td>" +
                                       "<td>" + entry.Kind + "</td>" +
                                       "<td>" + StatusWord(entry.Status) + "</td>" +
                                       "<td>" + Escape(string.IsNullOrWhiteSpace(entry.Note) ? "-" : entry.Note) + "</td></tr>");
                }

                builder.AppendLine("</tbody></table>");
            }

            if (model.Notes.Count > 0 || model.Arrows > 0)
            {
                builder.AppendLine("<h2>Notes and labels</h2><ul>");

                foreach (var note in model.Notes)
                {
                    builder.AppendLine("<li><strong>" + Escape(note.Kind) + ".</strong> " + Escape(note.Text) +
                                       (string.IsNullOrEmpty(note.Attached)
                                           ? string.Empty
                                           : " <span class=\"muted\">(on " + Escape(note.Attached) + ")</span>") + "</li>");
                }

                if (model.Arrows > 0)
                {
                    builder.AppendLine("<li class=\"muted\">" + model.Arrows +
                                       (model.Arrows == 1 ? " arrow is" : " arrows are") +
                                       " drawn on the canvas. They carry no text, so they are not reproduced here.</li>");
                }

                builder.AppendLine("</ul>");
            }

            builder.AppendLine("</body></html>");

            return new ExportProduct
            {
                Text = builder.ToString(),
                Warnings = new List<string>
                {
                    "The document describes the model, not the picture. Manual layout, emphasis colours and " +
                    "note placement are not represented. The page is self-contained and prints; Word opens it."
                }
            };
        }

        // ------------------------------------------------------------------
        // Shared model
        // ------------------------------------------------------------------

        private static DocumentationModel Build(DiagramDocument document)
        {
            var model = new DocumentationModel();

            model.Tables = document.Tables
                .OrderBy(t => t.Status == ObjectStatus.Existing ? 0 : 1)
                .ThenBy(t => t.DisplayName ?? t.LogicalName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            foreach (var group in document.Tables.GroupBy(t => t.Status).OrderBy(g => g.Key))
                model.StatusCounts[group.Key] = group.Count();

            var byId = document.Tables
                .Where(t => !string.IsNullOrEmpty(t.Id))
                .GroupBy(t => t.Id, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

            foreach (var relationship in document.Relationships)
            {
                DiagramTable from, to;

                // Counted, not silently dropped: a relationship whose ends are no longer both on
                // the diagram is included in the count so the totals add up.
                if (!byId.TryGetValue(relationship.FromTableId ?? string.Empty, out from) ||
                    !byId.TryGetValue(relationship.ToTableId ?? string.Empty, out to))
                {
                    model.RelationshipsNotDrawn++;
                    continue;
                }

                // Both reasons feed the one count, because the line it prints is about what the
                // reader cannot see rather than about which control put it out of sight. Hide is
                // the only one of the two in the UI, but the legacy excluded flag is still tested:
                // a document can arrive here straight from the canvas without passing through
                // DiagramFile.Normalise, which is what folds the legacy flag into Hidden.
                if (!relationship.Included || relationship.Hidden)
                {
                    model.RelationshipsNotDrawn++;
                    continue;
                }

                model.Relationships.Add(new RelationshipEntry
                {
                    Relationship = relationship,
                    FromName = from.DisplayName ?? from.LogicalName,
                    ToName = to.DisplayName ?? to.LogicalName
                });
            }

            model.Relationships = model.Relationships
                .OrderBy(e => e.FromName, StringComparer.CurrentCultureIgnoreCase)
                .ThenBy(e => e.ToName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            // The design register: everything that is not simply "as Dataverse has it". This is the
            // part of the document that records the design intent held in the diagram.
            foreach (var table in model.Tables.Where(t => t.Status != ObjectStatus.Existing))
            {
                model.DesignRegister.Add(new RegisterEntry
                {
                    Name = table.DisplayName ?? table.LogicalName,
                    Kind = "Table",
                    Status = table.Status,
                    Note = table.Notes
                });
            }

            // The relationships that will actually produce a register row below. The column loop
            // needs this before it runs: it may only defer to a relationship that is really there.
            var registeredRelationshipIds = new HashSet<string>(
                model.Relationships
                    .Where(e => e.Relationship.Status != ObjectStatus.Existing)
                    .Select(e => e.Relationship.Id ?? string.Empty),
                StringComparer.Ordinal);

            foreach (var table in document.Tables)
            {
                foreach (var column in (table.Columns ?? new List<DiagramColumn>())
                             .Where(c => c.Status != ObjectStatus.Existing))
                {
                    // A lookup column that a proposed relationship created is not a separate thing
                    // to approve - it *is* that relationship, which gets its own row below, and the
                    // reasoning lives on the relationship.
                    //
                    // Only when the relationship really does reach the register, though. A hidden
                    // proposed relationship is dropped from model.Relationships, and its column then
                    // keeps its own row so the register still matches the Tables section.
                    if (!string.IsNullOrEmpty(column.FromRelationshipId) &&
                        registeredRelationshipIds.Contains(column.FromRelationshipId))
                    {
                        continue;
                    }

                    model.DesignRegister.Add(new RegisterEntry
                    {
                        Name = (table.DisplayName ?? table.LogicalName) + "." +
                               (column.DisplayName ?? column.LogicalName),
                        Kind = "Column",
                        Status = column.Status,
                        Note = column.Notes
                    });
                }
            }

            foreach (var entry in model.Relationships.Where(e => e.Relationship.Status != ObjectStatus.Existing))
            {
                var note = entry.Relationship.Notes;
                if (string.IsNullOrWhiteSpace(note)) note = entry.Relationship.CascadeNotes;

                // The column has no row of its own, so the relationship's row says that it brings
                // one: whoever builds it creates a single object, and this sentence says what it
                // includes.
                var lookup = OwnedLookupName(document, entry.Relationship);
                if (!string.IsNullOrEmpty(lookup))
                {
                    var brings = "Creates the lookup column " + lookup + " on " + entry.ToName + ".";
                    note = string.IsNullOrWhiteSpace(note) ? brings : note.TrimEnd() + " " + brings;
                }

                model.DesignRegister.Add(new RegisterEntry
                {
                    Name = entry.FromName + " → " + entry.ToName +
                           (string.IsNullOrEmpty(entry.Relationship.SchemaName)
                               ? string.Empty
                               : " (" + entry.Relationship.SchemaName + ")"),
                    Kind = "Relationship",
                    Status = entry.Relationship.Status,
                    Note = note
                });
            }

            model.DesignRegister = model.DesignRegister
                .OrderBy(e => e.Status)
                .ThenBy(e => e.Kind, StringComparer.Ordinal)
                .ThenBy(e => e.Name, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            foreach (var annotation in document.Annotations ?? new List<DiagramAnnotation>())
            {
                // An arrow has no text, so it is counted here before the guard below, and a
                // diagram whose annotations are all arrows still says that something was left out.
                if (AnnotationKinds.IsArrow(annotation)) { model.Arrows++; continue; }

                if (string.IsNullOrWhiteSpace(annotation.Text)) continue;

                string attached = null;
                DiagramTable table;

                if (!string.IsNullOrEmpty(annotation.AttachedToId) &&
                    byId.TryGetValue(annotation.AttachedToId, out table))
                {
                    attached = table.DisplayName ?? table.LogicalName;
                }
                else if (!string.IsNullOrEmpty(annotation.AttachedToId))
                {
                    var relationship = document.Relationships
                        .FirstOrDefault(r => string.Equals(r.Id, annotation.AttachedToId, StringComparison.Ordinal));

                    if (relationship != null) attached = relationship.SchemaName;
                }

                // A text box is a label over a region of the canvas, not an observation about the
                // design, so it is not listed as a bullet under "Notes" with the same weight as a
                // reasoned note - the canvas does not give it that weight either.
                model.Notes.Add(new NoteEntry
                {
                    Text = annotation.Text,
                    Attached = attached,
                    Kind = AnnotationKinds.IsText(annotation) ? "Text box" : "Sticky note"
                });
            }

            return model;
        }

        private static void AppendMarkdownProvenance(StringBuilder builder, DiagramDocument document, DocumentationModel model)
        {
            var source = document.Source;

            builder.AppendLine("| | |");
            builder.AppendLine("|---|---|");

            if (!string.IsNullOrWhiteSpace(source?.OrganizationFriendlyName))
                builder.AppendLine("| Source environment | " + Clean(source.OrganizationFriendlyName) + " |");

            if (!string.IsNullOrWhiteSpace(source?.EnvironmentUrl))
                builder.AppendLine("| Environment URL | " + Code(source.EnvironmentUrl) + " |");

            if (!string.IsNullOrWhiteSpace(source?.SolutionUniqueName))
                builder.AppendLine("| Solution | " + Code(source.SolutionUniqueName) + " |");

            if (source?.LastRefreshUtc != null)
                builder.AppendLine("| Metadata last refreshed | " + Stamp(source.LastRefreshUtc.Value) + " |");

            builder.AppendLine("| Document generated | " + Stamp(DateTime.UtcNow) + " |");

            if (!string.IsNullOrWhiteSpace(document.ToolVersion))
                builder.AppendLine("| Generated by | Oliver4 Data Model Designer " + Clean(document.ToolVersion) + " |");

            builder.AppendLine();

            // Stated once, plainly, near the top of the document.
            builder.AppendLine("> This document was generated from a saved diagram. It reports the environment " +
                               "as it was when the metadata was last refreshed, together with any changes the " +
                               "diagram proposes. Nothing in it has been applied to Dataverse.");
            builder.AppendLine();
        }

        private static void AppendHtmlProvenance(StringBuilder builder, DiagramDocument document, DocumentationModel model)
        {
            var source = document.Source;

            builder.AppendLine("<table class=\"provenance\"><tbody>");

            if (!string.IsNullOrWhiteSpace(source?.OrganizationFriendlyName))
                builder.AppendLine("<tr><th>Source environment</th><td>" + Escape(source.OrganizationFriendlyName) + "</td></tr>");

            if (!string.IsNullOrWhiteSpace(source?.EnvironmentUrl))
                builder.AppendLine("<tr><th>Environment URL</th><td><code>" + Escape(source.EnvironmentUrl) + "</code></td></tr>");

            if (!string.IsNullOrWhiteSpace(source?.SolutionUniqueName))
                builder.AppendLine("<tr><th>Solution</th><td><code>" + Escape(source.SolutionUniqueName) + "</code></td></tr>");

            if (source?.LastRefreshUtc != null)
                builder.AppendLine("<tr><th>Metadata last refreshed</th><td>" + Stamp(source.LastRefreshUtc.Value) + "</td></tr>");

            builder.AppendLine("<tr><th>Document generated</th><td>" + Stamp(DateTime.UtcNow) + "</td></tr>");

            if (!string.IsNullOrWhiteSpace(document.ToolVersion))
                builder.AppendLine("<tr><th>Generated by</th><td>Oliver4 Data Model Designer " + Escape(document.ToolVersion) + "</td></tr>");

            builder.AppendLine("</tbody></table>");

            builder.AppendLine("<blockquote class=\"provenance-note\">This document was generated from a saved " +
                               "diagram. It reports the environment as it was when the metadata was last " +
                               "refreshed, together with any changes the diagram proposes. Nothing in it has " +
                               "been applied to Dataverse.</blockquote>");
        }

        // ------------------------------------------------------------------

        private static string Stamp(DateTime value)
        {
            // UK format, and explicit about the zone, so a date such as 03/04 is unambiguous.
            return value.ToUniversalTime().ToString("dd MMMM yyyy 'at' HH:mm 'UTC'", CultureInfo.GetCultureInfo("en-GB"));
        }

        private static string StatusWord(ObjectStatus status)
        {
            switch (status)
            {
                case ObjectStatus.Proposed: return "Proposed";
                case ObjectStatus.External: return "External";
                case ObjectStatus.Deprecated: return "Deprecated";
                default: return "Existing";
            }
        }

        private static string OwnershipWord(string ownershipType)
        {
            // Same vocabulary as RefreshService.DescribeOwnership and the canvas inspector.
            switch (ownershipType)
            {
                case "UserOwned": return "User or team owned";
                case "TeamOwned": return "Team owned";
                case "OrganizationOwned": return "Organisation owned";
                case "BusinessOwned": return "Business unit owned";
                case "BusinessParented": return "Business unit parented";
                case "None": return "Not owned";
                default: return "Not recorded";
            }
        }

        private static string Dash(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? "-" : value;
        }

        /// <summary>
        /// A schema name, column name or URL as a Markdown code span, escaped for a table cell.
        ///
        /// GitHub Flavored Markdown resolves \| inside a table row before it parses inline spans,
        /// so an escaped pipe inside backticks is both necessary and correct here - which is not
        /// true of a code span outside a table. Azure DevOps wiki follows the same rule.
        /// </summary>
        private static string Code(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "-";

            // A backtick in the content would close the span. Doubling the fence is the standard
            // way out, and a schema name containing one is malformed anyway.
            var cleaned = Clean(value);
            return cleaned.IndexOf('`') >= 0 ? "`` " + cleaned + " ``" : "`" + cleaned + "`";
        }

        /// <summary>
        /// Markdown table cells cannot contain a raw pipe or a newline: either ends the cell early
        /// and the rest of the row lands in the wrong column. A user's note is free text, so both
        /// are entirely likely.
        /// </summary>
        private static string Clean(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;

            // A control character such as U+000B reaches here from a display name pasted out of
            // another tool. It is no more valid in a document than it is in the XML formats, and
            // dropping it here keeps all four exports saying the same thing about the same name.
            return ExportText.StripInvalidXml(value)
                .Replace("|", "\\|")
                .Replace("\r\n", " ")
                .Replace("\n", " ")
                .Replace("\r", " ")
                .Trim();
        }

        private static string Escape(string value)
        {
            if (string.IsNullOrEmpty(value)) return string.Empty;

            // Stripped for the same reason as in Clean: HTML has no more use for a stray control
            // character than XML does, and the page is meant to be a valid document.
            return ExportText.StripInvalidXml(value)
                .Replace("&", "&amp;")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;")
                .Replace("\"", "&quot;");
        }

        private static string Stylesheet()
        {
            return
                "body{font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.55;color:#1d2433;" +
                "max-width:60rem;margin:2.5rem auto;padding:0 1.5rem}" +
                "h1{font-size:1.9rem;margin-bottom:.3rem}" +
                "h2{font-size:1.35rem;margin-top:2.2rem;padding-bottom:.3rem;border-bottom:2px solid #e4e9f2}" +
                "h3{font-size:1.08rem;margin-top:1.6rem}" +
                ".lead{font-size:1.05rem;color:#4a5568}" +
                "table{border-collapse:collapse;width:100%;margin:.8rem 0;font-size:13px}" +
                "th,td{border:1px solid #e4e9f2;padding:.4rem .6rem;text-align:left;vertical-align:top}" +
                "thead th{background:#f7f9fc;font-weight:600}" +
                "table.provenance{max-width:34rem;font-size:12.5px}" +
                "table.provenance th{width:14rem;background:#f7f9fc}" +
                "code{font-family:Consolas,ui-monospace,monospace;font-size:.92em;background:#f4f6fa;" +
                "padding:.08rem .3rem;border-radius:3px}" +
                "blockquote{margin:.8rem 0;padding:.6rem .9rem;background:#f7f9fc;border-left:3px solid #c3cad6;color:#4a5568}" +
                "blockquote.provenance-note{border-left-color:#1f5fe0;background:#f3f7ff}" +
                ".badge{font-size:.62em;font-weight:600;letter-spacing:.06em;text-transform:uppercase;" +
                "vertical-align:middle;border:1px solid #d5dceb;border-radius:3px;padding:.1rem .35rem;color:#5b6577}" +
                ".table-entry{margin-bottom:1.6rem}" +
                ".status-proposed>h3 .badge{border-color:#f0dfae;background:#fff8e6;color:#a4700f}" +
                ".status-external>h3 .badge{border-color:#ddd0f5;background:#f6f1ff;color:#7a4fd1}" +
                ".status-deprecated>h3 .badge{border-color:#f3cdc7;background:#fdf0ee;color:#9b2c22}" +
                "tr.status-proposed{background:#fffdf6}tr.status-deprecated{background:#fdf7f6}" +
                "tr.status-deprecated td:first-child{text-decoration:line-through}" +
                "dl{display:grid;grid-template-columns:11rem 1fr;gap:.15rem .8rem;margin:.6rem 0;font-size:13px}" +
                "dt{color:#5b6577}dd{margin:0}" +
                ".muted{color:#7a869b}.key{font-size:12.5px;color:#4a5568}" +
                "@media print{body{margin:0;max-width:none}h2{break-after:avoid}" +
                ".table-entry{break-inside:avoid}}";
        }

        // ------------------------------------------------------------------

        private class DocumentationModel
        {
            public List<DiagramTable> Tables = new List<DiagramTable>();
            public Dictionary<ObjectStatus, int> StatusCounts = new Dictionary<ObjectStatus, int>();
            public List<RelationshipEntry> Relationships = new List<RelationshipEntry>();

            /// <summary>
            /// Relationships in the file that the document does not show: hidden, carrying the
            /// legacy excluded flag, or with an end that is no longer on the diagram. Named for
            /// what it counts rather than for one of the reasons, which is also what the summary
            /// line says.
            /// </summary>
            public int RelationshipsNotDrawn;
            public List<RegisterEntry> DesignRegister = new List<RegisterEntry>();
            public List<NoteEntry> Notes = new List<NoteEntry>();

            /// <summary>Arrows drawn on the canvas. They have no text, so they are counted, not listed.</summary>
            public int Arrows;

            public bool HasDesign { get { return DesignRegister.Count > 0; } }
        }

        private class RelationshipEntry
        {
            public DiagramRelationship Relationship;
            public string FromName;
            public string ToName;
        }

        private class RegisterEntry
        {
            public string Name;
            public string Kind;
            public ObjectStatus Status;
            public string Note;
        }

        /// <summary>
        /// The lookup column a proposed relationship created, if it still has one.
        ///
        /// Used by the design register, where the relationship's row has to say what building it
        /// involves, since the column does not get a row of its own.
        /// </summary>
        private static string OwnedLookupName(DiagramDocument document, DiagramRelationship relationship)
        {
            if (relationship == null || string.IsNullOrEmpty(relationship.Id)) return null;

            foreach (var table in document.Tables)
            {
                var owned = (table.Columns ?? new List<DiagramColumn>()).FirstOrDefault(c =>
                    string.Equals(c.FromRelationshipId, relationship.Id, StringComparison.Ordinal));

                if (owned != null) return owned.LogicalName ?? owned.DisplayName;
            }

            return null;
        }

        private class NoteEntry
        {
            public string Text;
            public string Attached;

            /// <summary>"Sticky note" or "Text box". Arrows carry no text and are counted instead.</summary>
            public string Kind;
        }
    }
}
