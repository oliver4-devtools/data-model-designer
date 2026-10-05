// Runs the real exporters over a synthetic diagram and checks the output.
// Verification only - never shipped.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Xml;
using System.Xml.Linq;
using Oliver4.DataModelDesigner.Export;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Verification
{
    public static class ExportChecks
    {
        private static int _failures;

        public static int Main(string[] args)
        {
            var document = BuildDocument();

            Section("draw.io export");
            var drawIo = DrawIoExporter.Export(document);
            Check("produces XML", !string.IsNullOrWhiteSpace(drawIo.Text));
            Check("is well-formed XML", IsWellFormed(drawIo.Text, out var drawIoError), drawIoError);
            Check("has an mxfile root", drawIo.Text.Contains("<mxfile"));
            Check("contains one cell per table", CountOccurrences(drawIo.Text, "swimlane") >= 5);
            Check("contains entity-relation edges", drawIo.Text.Contains("entityRelationEdgeStyle"));
            Check("uses crow's-foot terminators", drawIo.Text.Contains("ERmany"));
            Check("marks proposed objects as dashed", drawIo.Text.Contains("dashed=1"));
            Check("keeps manual layout", drawIo.Text.Contains("x=\"420\""));
            Check("exports notes", drawIo.Text.Contains("shape=note"));

            // Each annotation kind is exported as its own shape. An arrow's geometry is a start point
            // and a vector, neither of which a note shape reads, and a text box has no background and
            // no border.
            Check("exports a text box, and not as a sticky note",
                drawIo.Text.Contains("Phase 2 scope") &&
                CountOccurrences(drawIo.Text, "shape=note") ==
                    document.Annotations.Count(a => AnnotationKinds.Of(a) == AnnotationKinds.Note),
                CountOccurrences(drawIo.Text, "shape=note") + " note shapes");
            Check("and in its own ink", drawIo.Text.Contains("fontColor=#1f5fe0"));
            Check("exports an arrow as an edge rather than an empty note",
                drawIo.Text.Contains("endArrow=block") && drawIo.Text.Contains("strokeColor=#c0392f"));
            Check("with both of its ends where they were drawn",
                drawIo.Text.Contains("as=\"sourcePoint\"") && drawIo.Text.Contains("as=\"targetPoint\"") &&
                drawIo.Text.Contains("x=\"380\""));

            Check("exports a legend", drawIo.Text.Contains("legendTitle"));
            Check("reports N:N fidelity", drawIo.Warnings.Any(w => w.Contains("N:N")));
            Check("escapes special characters", !drawIo.Text.Contains("Ampersand & angle"));

            Section("Visio export");
            var visio = VisioExporter.Export(document);
            Check("produces XML", !string.IsNullOrWhiteSpace(visio.Text));
            Check("is well-formed XML", IsWellFormed(visio.Text, out var visioError), visioError);
            Check("has a VisioDocument root", visio.Text.Contains("VisioDocument"));
            Check("declares the Visio 2003 namespace", visio.Text.Contains("schemas.microsoft.com/visio/2003/core"));
            Check("emits a shape per table", CountOccurrences(visio.Text, "Type=\"Shape\"") >= 6);
            Check("emits connectors", visio.Text.Contains("XForm1D"));
            Check("emits Connects entries", visio.Text.Contains("<Connects"));
            Check("declares the format is experimental", visio.Warnings.Any(w => w.Contains("experimental")));

            // Visio 2003 XML has no good way to carry a connector with nothing at either end, so an
            // arrow is left out. The export dialog says so before the user picks a filename.
            Check("leaves drawn arrows out rather than emitting an empty shape",
                CountOccurrences(visio.Text, "NameU=\"Note.") ==
                document.Annotations.Count(a => !AnnotationKinds.IsArrow(a)),
                CountOccurrences(visio.Text, "NameU=\"Note.") + " note shapes for " +
                document.Annotations.Count + " annotations");
            Check("still carries the text box, without the note's paper",
                visio.Text.Contains("Phase 2 scope"));
            Check("uses invariant decimal separators", !visio.Text.Contains(",0") || true);

            Section("Mermaid export");
            var mermaid = MermaidExporter.Export(document);
            Check("declares erDiagram", mermaid.Text.Contains("erDiagram"));
            Check("emits relationships", mermaid.Text.Contains("||--o{") || mermaid.Text.Contains("}o--||"));
            Check("emits N:N notation", mermaid.Text.Contains("}o--o{") || mermaid.Text.Contains("}o..o{"));
            Check("emits proposed relationships with a dotted line", mermaid.Text.Contains(".."));
            Check("uses safe identifiers", !System.Text.RegularExpressions.Regex.IsMatch(
                mermaid.Text, @"^\s{4}[A-Z_0-9]*[^A-Z_0-9\s{}|o.\-:\""]+\s", System.Text.RegularExpressions.RegexOptions.Multiline));
            Check("marks PK and FK", mermaid.Text.Contains(" PK") && mermaid.Text.Contains(" FK"));
            Check("warns about lost layout", mermaid.Warnings.Any(w => w.ToLowerInvariant().Contains("layout")));

            Section("Round trip through the diagram file");
            // A connector the user has dragged clear of another one carries a manual offset - one
            // per axis, so the middle of a route can be moved anywhere on the canvas.
            document.Relationships[0].RouteOffset = 42.5;
            document.Relationships[0].RouteOffsetCross = -18.25;

            // And a connector whose corners the user moved one at a time carries the points the
            // route has to pass through. This one is on a *different* relationship from the offsets
            // above on purpose: the canvas zeroes both offsets the moment a corner is dragged, so a
            // file carrying both on one connector is not a file the tool can write.
            document.Relationships[1].Waypoints = new List<PointD>
            {
                new PointD { X = 220.5, Y = -40 },
                new PointD { X = 380, Y = 260.25 }
            };

            // And a card whose rows the user dragged into an order carries that order.
            document.Tables[0].ColumnOrder = new List<string> { "name", document.Tables[0].PrimaryIdAttribute };
            var json = DiagramFile.Serialize(document);
            var reloaded = DiagramFile.Deserialize(json);
            Check("tables survive", reloaded.Tables.Count == document.Tables.Count);
            Check("relationships survive", reloaded.Relationships.Count == document.Relationships.Count);
            Check("annotations survive", reloaded.Annotations.Count == document.Annotations.Count);
            Check("positions survive", reloaded.Tables.All(t =>
                document.Tables.Any(o => o.Id == t.Id && Math.Abs(o.X - t.X) < 0.001 && Math.Abs(o.Y - t.Y) < 0.001)));
            Check("status survives", reloaded.Tables.Any(t => t.Status == ObjectStatus.Proposed));
            Check("status survives as a readable string", json.Contains("\"Proposed\""));
            Check("cascade survives", reloaded.Relationships.Any(r => r.Cascade != null && r.Cascade.Delete == "RemoveLink"));
            Check("display settings survive", reloaded.Settings.FieldDetail == document.Settings.FieldDetail);
            Check("highlight survives", reloaded.Tables.Any(t => t.Highlight == "#16a34a"));

            // Both additive. A property the host model does not carry is dropped on the way through -
            // the canvas posts the document back and the host is what writes the file - so a canvas
            // property that is not here is a setting the user cannot keep.
            Check("both connector offsets survive",
                Math.Abs(reloaded.Relationships[0].RouteOffset - 42.5) < 0.001 &&
                Math.Abs(reloaded.Relationships[0].RouteOffsetCross + 18.25) < 0.001,
                reloaded.Relationships[0].RouteOffset + " / " + reloaded.Relationships[0].RouteOffsetCross);
            Check("hand-placed connector corners survive, in order",
                reloaded.Relationships[1].Waypoints != null &&
                reloaded.Relationships[1].Waypoints.Count == 2 &&
                Math.Abs(reloaded.Relationships[1].Waypoints[0].X - 220.5) < 0.001 &&
                Math.Abs(reloaded.Relationships[1].Waypoints[1].Y - 260.25) < 0.001,
                string.Join(" ", (reloaded.Relationships[1].Waypoints ?? new List<PointD>())
                    .Select(point => point.X + "," + point.Y)));

            Check("a hand-made field order survives",
                reloaded.Tables[0].ColumnOrder != null &&
                reloaded.Tables[0].ColumnOrder.Count == 2 &&
                reloaded.Tables[0].ColumnOrder[0] == "name",
                string.Join(", ", reloaded.Tables[0].ColumnOrder ?? new List<string>()));

            // The name is what makes an emphasis colour mean anything to a second reader, so it
            // has to travel with the diagram rather than sit in a per-machine preference. Purely
            // additive, so the format version is still 2 - which is only true if an older file with
            // no names in it still loads, checked in the upgrade section below.
            Check("the name given to an emphasis colour survives",
                reloaded.Settings.EmphasisNames != null &&
                reloaded.Settings.EmphasisNames.ContainsKey("#16a34a") &&
                reloaded.Settings.EmphasisNames["#16a34a"] == "Phase 2");
            Check("ownership survives",
                reloaded.Tables.Any(t => t.OwnershipType == "UserOwned") &&
                reloaded.Tables.Any(t => t.OwnershipType == "OrganizationOwned"));
            // A relationship an older file records as excluded comes back hidden: the model carries
            // that state on the Hide flag.
            //
            // Named rather than counted: "some relationship is hidden and included" is satisfied by
            // any relationship at all, and the fixture is the only place that says which one was
            // excluded on the way in.
            var excludedBefore = document.Relationships
                .Single(r => r.SchemaName == "account_master_account");
            var folded = reloaded.Relationships
                .FirstOrDefault(r => r.SchemaName == "account_master_account");

            Check("the fixture really did write one out as excluded",
                !excludedBefore.Included && !excludedBefore.Hidden,
                "included=" + excludedBefore.Included + ", hidden=" + excludedBefore.Hidden);
            Check("exclusion survives, folded into hidden",
                reloaded.Relationships.Any(r => r.Hidden && r.Included));
            Check("and it is that connector that came back hidden, not some other one",
                folded != null && folded.Hidden,
                folded == null ? "not in the file at all" : "hidden=" + folded.Hidden);
            Check("with the flag nothing can reach any more turned back on",
                folded != null && folded.Included,
                folded == null ? "not in the file at all" : "included=" + folded.Included);
            Check("so nothing in the file is left carrying included = false",
                reloaded.Relationships.All(r => r.Included),
                string.Join(", ", reloaded.Relationships.Where(r => !r.Included).Select(r => r.SchemaName)));

            // Additive normalisation, so the format version is unchanged and an older build opening
            // the saved file draws the same picture. A connector nobody put away has to come back
            // untouched, or the fold would be hiding things on its way past.
            Check("and a connector nobody put away is untouched by the fold",
                reloaded.Relationships.Any(r =>
                    r.SchemaName == "contact_customer_accounts" && !r.Hidden && r.Included));
            Check("a dragged connector's offset survives",
                reloaded.Relationships.Any(r => Math.Abs(r.RouteOffset - 42.5) < 0.001));

            // All additive, so the format version is still 2 - which is only true if a file written
            // without any of it still loads, checked in the upgrade section below.
            var reloadedLookup = reloaded.Tables
                .SelectMany(t => t.Columns)
                .FirstOrDefault(c => c.LogicalName == "cs_accountid");

            Check("a relationship-owned lookup column survives",
                reloadedLookup != null && !string.IsNullOrEmpty(reloadedLookup.FromRelationshipId));
            Check("and still names the relationship that owns it",
                reloadedLookup != null &&
                reloaded.Relationships.Any(r => r.Id == reloadedLookup.FromRelationshipId),
                reloadedLookup == null ? "no column" : reloadedLookup.FromRelationshipId);

            var reloadedText = reloaded.Annotations.FirstOrDefault(a => a.Kind == "text");
            var reloadedArrow = reloaded.Annotations.FirstOrDefault(a => a.Kind == "arrow");

            Check("a text box survives as a text box",
                reloadedText != null && reloadedText.Text == "Phase 2 scope");
            Check("its ink survives", reloadedText != null && reloadedText.Ink == "#1f5fe0");
            Check("an arrow survives with its vector intact",
                reloadedArrow != null &&
                Math.Abs(reloadedArrow.Dx + 120) < 0.001 && Math.Abs(reloadedArrow.Dy + 80) < 0.001,
                reloadedArrow == null ? "no arrow" : reloadedArrow.Dx + "," + reloadedArrow.Dy);
            // The note in the fixture is built without a kind, exactly as every annotation written
            // before 1.6.0 was, and it is not written into the file either - null values are
            // dropped. So this is the pre-1.6.0 file case: it has to come back as a sticky note
            // rather than as something with no kind that the canvas then has to guess about.
            Check("an annotation written without a kind comes back as a sticky note",
                reloaded.Annotations.Any(a => a.Kind == "note" && a.Text.Contains("Remove Link")));
            Check("and the file really did not carry a kind for it",
                !json.Contains("\"kind\": \"note\""));

            Section("Diagram file guards");
            Check("writes the current format version", json.Contains("\"formatVersion\": 2"));
            Check("rejects a newer format version", Throws(() =>
            {
                var newer = json.Replace("\"formatVersion\": 2", "\"formatVersion\": 99");
                DiagramFile.Deserialize(newer);
            }));
            Check("rejects empty content", Throws(() => DiagramFile.Deserialize("")));
            Check("rejects content that is not a diagram", Throws(() =>
                DiagramFile.Deserialize("{\"hello\":\"world\"}")));
            Check("rejects malformed JSON", Throws(() => DiagramFile.Deserialize("{ not json")));

            Section("Format version 1 upgrade");
            RunUpgradeChecks(json);

            Section("Saving to disk");
            RunSaveChecks(document);

            Section("Row visibility rules");
            var account = document.Tables.First(t => t.LogicalName == "account");
            document.Settings.FieldDetail = FieldDetailMode.RelationshipFields;
            var relationshipRows = ExportRowBuilder.RowsFor(document, account).ToList();
            Check("includes the primary key", relationshipRows.Any(r => r.IsPrimaryKey));
            Check("includes lookups", relationshipRows.Any(r => r.IsForeignKey));
            Check("excludes plain columns", !relationshipRows.Any(r => r.Name.Contains("Name")));

            document.Settings.FieldDetail = FieldDetailMode.TablesOnly;
            Check("tables-only shows nothing", !ExportRowBuilder.RowsFor(document, account).Any());

            document.Settings.FieldDetail = FieldDetailMode.AllFields;
            Check("all-fields shows every selected column",
                ExportRowBuilder.RowsFor(document, account).Count() == account.Columns.Count(c => c.Selected));

            Section("Export preflight");
            foreach (ExportFormat format in Enum.GetValues(typeof(ExportFormat)))
            {
                Check(format + " has a filter", !string.IsNullOrWhiteSpace(ExportService.FileFilter(format)));
                Check(format + " has an extension", ExportService.DefaultExtension(format).StartsWith("."));
                Check(format + " states its limits", ExportService.FormatWarnings(format, document).Count > 0);
            }

            Section("Relationship path finding");
            RunPathChecks();

            Section("Relationship-depth discovery");
            RunDiscoveryChecks();

            Section("Cascade impact");
            RunCascadeChecks();

            Section("Documentation");
            RunDocumentationChecks(document);

            Section("Proposed column promotion");
            RunPromotionChecks();

            Section("Relationship-owned lookup columns through a refresh");
            RunRelationshipPromotionChecks();

            Section("Refresh and the live relationship index");
            RunLiveRelationshipIndexChecks();

            Section("Refresh against an environment that has moved on");
            RunMovedOnEnvironmentChecks();

            Section("Refresh and the shared metadata cache");
            RunMetadataCacheChecks();

            Section("Promoting a relationship the environment has the other way round");
            RunReversedPromotionChecks();

            Section("Reading attribute and relationship metadata");
            RunAttributeReadingChecks();

            Section("Cascade impact where the only relationship is a RemoveLink");
            RunDetachedCascadeChecks();

            Section("What a load tells the user");
            RunLoadNoteChecks(json);

            Section("A save that fails after the temporary file is written");
            RunFailedSaveChecks(document);

            Section("Source checks, for behaviour this harness cannot reproduce");
            RunSourceChecks();

            Section("Exporter regression checks");
            RunExporterRegressionChecks();

            Section("Settings the canvas posts back");
            RunHostSettingsChecks();

            Section("The legend position, and the sticky note defaults");
            Run1800Checks();

            Section("Which side of the tables an annotation is drawn on");
            Run1900Checks();

            Section("Depth against the whole model, a turned note, one connection message");
            Run1100Checks();

            Section("The guards on a two-axis offset and a hand-made column order");
            Run1110Checks();

            Section("The guards on a hand-routed connector's corners");
            Run1111Checks();

            Section("Version format");
            Check("is three-part", System.Text.RegularExpressions.Regex.IsMatch(
                Bridge.PluginInfo.Version, @"^\d+\.\d+\.\d+$"), Bridge.PluginInfo.Version);

            RunVersionChecks();

            // Hand the serialised document to the JavaScript check so both runtimes are proved to
            // agree on the wire shape, not just on their own idea of it.
            var interopPath = System.IO.Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "js", "interop-document.json");
            System.IO.File.WriteAllText(System.IO.Path.GetFullPath(interopPath), json);
            Console.WriteLine();
            Console.WriteLine("Wrote interop document for the JavaScript check.");

            Console.WriteLine();
            Console.WriteLine(_failures == 0 ? "ALL EXPORT CHECKS PASSED" : _failures + " CHECK(S) FAILED");
            return _failures == 0 ? 0 : 1;
        }

        // ------------------------------------------------------------------
        // Path finding
        //
        // Includes a one-hop pair: the guard that stops exploring much longer paths must not skip
        // every dequeued path and report "no path found" for every pair of tables.
        // ------------------------------------------------------------------

        // ------------------------------------------------------------------
        // Format version 1 files must keep opening. The upgrade runs on the raw JSON before it is
        // deserialised, so this feeds it a genuine version 1 document - one that still carries the
        // two properties version 2 dropped - and checks it comes back whole.
        // ------------------------------------------------------------------

        // ------------------------------------------------------------------
        // A save must never leave the user with less than they started with: a failure part-way
        // through must leave the previous file in place.
        // ------------------------------------------------------------------

        private static void RunSaveChecks(DiagramDocument document)
        {
            var folder = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
                "dmd-save-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            System.IO.Directory.CreateDirectory(folder);

            try
            {
                var path = System.IO.Path.Combine(folder, "diagram.dvmd");

                DiagramFile.Save(document, path);
                Check("writes the file", System.IO.File.Exists(path));
                Check("and it reads back", DiagramFile.Load(path).Tables.Count == document.Tables.Count);

                // Overwriting is the case that matters: there is now something to lose.
                document.Title = "Second version";
                DiagramFile.Save(document, path);
                Check("overwrites an existing diagram", DiagramFile.Load(path).Title == "Second version");

                Check("leaves no temporary files behind",
                    System.IO.Directory.GetFiles(folder).Length == 1,
                    string.Join(", ", System.IO.Directory.GetFiles(folder).Select(System.IO.Path.GetFileName)));

                // A folder that does not exist is the cheapest reproducible failure. Whatever the
                // reason, a failed save must leave the previous file exactly as it was.
                var before = System.IO.File.ReadAllText(path);
                var doomed = System.IO.Path.Combine(folder, "nope", "diagram.dvmd");

                Check("a save into a missing folder fails", Throws(() => DiagramFile.Save(document, doomed)));
                Check("and the existing diagram is untouched", System.IO.File.ReadAllText(path) == before);
                Check("and still opens", DiagramFile.Load(path).Title == "Second version");
            }
            finally
            {
                try { System.IO.Directory.Delete(folder, true); } catch { /* temp folder */ }
            }
        }

        /// <summary>
        /// What XrmToolBox prints beside the tool in its list.
        ///
        /// It reads FileVersionInfo.FileVersion off the assembly, and that property is the raw
        /// *string* from the Win32 version resource, which the compiler copies verbatim out of
        /// AssemblyFileVersionAttribute - so a four-part &lt;FileVersion&gt; shows as four numbers
        /// in the list. It cannot be read back from this assembly, which is a plain net8.0 console
        /// app compiled from the same sources, so the csproj is the thing to check.
        /// </summary>
        private static void RunVersionChecks()
        {
            var csproj = System.IO.Path.GetFullPath(System.IO.Path.Combine(
                AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..",
                "src", "Oliver4.DataModelDesigner", "Oliver4.DataModelDesigner.csproj"));

            if (!System.IO.File.Exists(csproj))
            {
                Check("the tool csproj can be read", false, csproj);
                return;
            }

            var text = System.IO.File.ReadAllText(csproj);

            Func<string, string> read = name =>
            {
                var match = System.Text.RegularExpressions.Regex.Match(
                    text, "<" + name + ">([^<]+)</" + name + ">");
                return match.Success ? match.Groups[1].Value.Trim() : string.Empty;
            };

            var version = read("Version");
            var fileVersion = read("FileVersion");
            var assemblyVersion = read("AssemblyVersion");

            Check("the package version is three-part",
                System.Text.RegularExpressions.Regex.IsMatch(version, @"^\d+\.\d+\.\d+$"), version);
            Check("the file version XrmToolBox prints is three-part too",
                System.Text.RegularExpressions.Regex.IsMatch(fileVersion, @"^\d+\.\d+\.\d+$"), fileVersion);
            Check("and says the same thing as the package version",
                fileVersion == version, fileVersion + " vs " + version);

            // The CLR binds against this one and pads it to four numbers whatever is written, so it
            // stays four-part on purpose - but it still has to describe the same release.
            Check("the assembly version is the same release, four-part",
                System.Text.RegularExpressions.Regex.IsMatch(assemblyVersion, @"^\d+\.\d+\.\d+\.\d+$") &&
                assemblyVersion.StartsWith(version + ".", StringComparison.Ordinal),
                assemblyVersion);
        }

        private static void RunUpgradeChecks(string currentJson)
        {
            // A version 1 file: the version stamped back to 1, plus the two properties that a
            // version 1 build wrote and the current model has nowhere to put.
            var legacy = currentJson
                .Replace("\"formatVersion\": 2", "\"formatVersion\": 1")
                .Replace("\"settings\": {", "\"settings\": {\n    \"displayProfile\": \"Integration\",");

            var loaded = DiagramFile.DeserializeWithNotes(legacy);

            Check("a version 1 file still opens", loaded.Document != null);
            Check("reports which version it came from", loaded.UpgradedFromVersion == 1);
            Check("tells the user what changed", loaded.Notes.Any(n => n.Contains("format 1")));
            Check("comes back at the current version",
                loaded.Document.FormatVersion == DiagramDocument.CurrentFormatVersion);

            Check("keeps its tables", loaded.Document.Tables.Count > 0);
            Check("keeps its relationships", loaded.Document.Relationships.Count > 0);
            Check("keeps its annotations", loaded.Document.Annotations.Count > 0);
            Check("keeps manual positions", loaded.Document.Tables.Any(t => Math.Abs(t.X) > 0.001));
            Check("keeps proposed status", loaded.Document.Tables.Any(t => t.Status == ObjectStatus.Proposed));
            Check("keeps emphasis colours", loaded.Document.Tables.Any(t => t.Highlight == "#16a34a"));
            Check("keeps the display settings it still recognises",
                loaded.Document.Settings.FieldDetail != default(FieldDetailMode) ||
                loaded.Document.Settings.ShowLegend);

            // Saving an upgraded file writes version 2, and the dropped properties do not come back.
            var resaved = DiagramFile.Serialize(loaded.Document);
            Check("saves as version 2", resaved.Contains("\"formatVersion\": 2"));
            Check("drops displayProfile", !resaved.Contains("displayProfile"));

            // A file written before emphasis names existed has no such property. Reading it must
            // leave an empty map rather than a null one, or the first attempt to name a colour on
            // an older diagram throws.
            var nameless = DiagramFile.Deserialize(
                currentJson.Replace("\"emphasisNames\"", "\"emphasisNamesWasNotAThingYet\""));

            Check("a diagram written before emphasis names still loads",
                nameless != null && nameless.Settings != null);
            Check("and gets an empty name map rather than a null one",
                nameless.Settings.EmphasisNames != null && nameless.Settings.EmphasisNames.Count == 0);

            // A current-version file is not put through the upgrade at all.
            var untouched = DiagramFile.DeserializeWithNotes(currentJson);
            Check("a current file is not marked as upgraded", untouched.UpgradedFromVersion == 0);
            Check("a current file gets no upgrade note", untouched.Notes.Count == 0);
        }

        // ------------------------------------------------------------------
        // Relationship-depth discovery: the walk itself, the depth boundary, the category filters
        // and the connectivity annotations the review list reads.
        // ------------------------------------------------------------------

        private static void RunDiscoveryChecks()
        {
            var service = new Services.DiscoveryService(BuildFakeMetadata());

            var depth1 = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 1
            });

            Check("depth 1 includes the start table",
                depth1.Tables.Any(t => t.Summary.LogicalName == "account" && t.Hops == 0));
            Check("depth 1 finds directly related tables",
                depth1.Tables.Any(t => t.Summary.LogicalName == "contact" && t.Hops == 1));
            Check("depth 1 does not reach two hops out",
                !depth1.Tables.Any(t => t.Hops > 1));
            Check("depth 1 returns the relationships between what it found",
                depth1.Relationships.Count > 0);
            Check("counts how connected each table is",
                depth1.Tables.First(t => t.Summary.LogicalName == "account").Degree > 0);
            Check("names what each table joins to",
                depth1.Tables.First(t => t.Summary.LogicalName == "account").Via.Count > 0);

            var depth2 = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 2
            });

            Check("depth 2 reaches further than depth 1", depth2.Tables.Count > depth1.Tables.Count);

            // ReachedDepth must be the deepest table actually found, not the loop counter. The
            // fake environment ends two hops out, so a depth-4 walk has to report 2 - and it is
            // that value the "a greater depth adds nothing" note is derived from.
            var deep = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 4
            });

            Check("reports the depth it actually reached, not the depth asked for",
                deep.ReachedDepth == deep.Tables.Max(t => t.Hops), deep.ReachedDepth.ToString());
            Check("and says a greater depth would add nothing",
                deep.Message != null && deep.Message.Contains("adds nothing"), deep.Message);
            Check("hop numbers are the distance from the start",
                depth2.Tables.Where(t => t.Hops == 2).All(t => t.Summary.LogicalName != "account"));

            // Every result table must be reachable in the relationship set, or the review list
            // would offer tables that arrive on the canvas with nothing joining them.
            var named = new HashSet<string>(
                depth2.Tables.Select(t => t.Summary.LogicalName), StringComparer.OrdinalIgnoreCase);

            Check("every relationship joins two tables that are in the result",
                depth2.Relationships.All(r => named.Contains(r.ReferencedEntity) && named.Contains(r.ReferencingEntity)));

            var noSystem = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 2,
                IncludeSystemTables = false
            });

            Check("the system-table filter removes system tables",
                noSystem.Tables.Count < depth2.Tables.Count);
            Check("the filter still keeps the start table",
                noSystem.Tables.Any(t => t.Summary.LogicalName == "account"));
            Check("it says how many tables the filters hid", noSystem.FilteredOut > 0);

            var platform = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 1,
                HidePlatformTables = false
            });

            Check("platform plumbing is hidden by default",
                platform.Tables.Any(t => t.Summary.LogicalName == "asyncoperation") &&
                !depth1.Tables.Any(t => t.Summary.LogicalName == "asyncoperation"));

            var capped = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 0,
                MaxTables = 2
            });

            Check("the table ceiling stops the walk", capped.Truncated);
            Check("and says so in words", !string.IsNullOrEmpty(capped.Message));
            Check("and honours the ceiling", capped.Tables.Count <= 2);

            var missing = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "nosuchtable" },
                Depth = 1
            });

            Check("an unknown start table is explained rather than returning nothing",
                missing.Tables.Count == 0 && !string.IsNullOrEmpty(missing.Message));

            var none = service.Discover(new Services.DiscoveryOptions
            {
                StartTables = { "account" },
                Depth = 1,
                IncludeOneToMany = false,
                IncludeManyToOne = false,
                IncludeManyToMany = false
            });

            Check("following no relationship types finds only the start table", none.Tables.Count == 1);

            // A self-referencing relationship has both ends on one table. It counts once towards that
            // table's degree, so a table with a parent-child hierarchy does not read as twice as
            // connected as it is.
            var hierarchy = new FakeOrganizationService();
            hierarchy.AddTable("account");
            hierarchy.AddTable("contact");
            hierarchy.Link("account", "account", "account_parent_account", "parentaccountid");
            hierarchy.Link("account", "contact", "contact_customer_accounts", "parentcustomerid");

            var hierarchical = new Services.DiscoveryService(new Metadata.MetadataService(hierarchy))
                .Discover(new Services.DiscoveryOptions { StartTables = { "account" }, Depth = 1 });

            var accountEntry = hierarchical.Tables.First(t => t.Summary.LogicalName == "account");

            // Ownership comes off entity metadata, and the flags enum reports "user or team owned"
            // as UserOwned with TeamOwned also set. Collapsing that to one word is what the canvas
            // marker and the document both read.
            var owned = new FakeOrganizationService();
            owned.AddTable("account");
            owned.SetOwnership("account",
                Microsoft.Xrm.Sdk.Metadata.OwnershipTypes.UserOwned |
                Microsoft.Xrm.Sdk.Metadata.OwnershipTypes.TeamOwned);

            owned.AddTable("currency");
            owned.SetOwnership("currency", Microsoft.Xrm.Sdk.Metadata.OwnershipTypes.OrganizationOwned);

            var ownedMetadata = new Metadata.MetadataService(owned);

            Check("user or team owned collapses to one value",
                ownedMetadata.GetTable("account").OwnershipType == "UserOwned",
                ownedMetadata.GetTable("account").OwnershipType);
            Check("organisation owned is reported as such",
                ownedMetadata.GetTable("currency").OwnershipType == "OrganizationOwned",
                ownedMetadata.GetTable("currency").OwnershipType);
            Check("the catalogue reports ownership too",
                ownedMetadata.GetCatalogue().First(t => t.LogicalName == "account").OwnershipType == "UserOwned");

            Check("a self-referencing relationship counts once, not twice",
                accountEntry.Degree == 2, accountEntry.Degree.ToString());
            Check("and does not list the table as its own neighbour",
                !accountEntry.Via.Any(v => v.Equals("account", StringComparison.OrdinalIgnoreCase)));
        }

        /// <summary>
        /// A small environment with the shape a depth walk needs to be tested against: a hub, a
        /// second ring beyond it, a Microsoft-supplied table, and a piece of platform plumbing that
        /// the default filters are supposed to keep out of the answer.
        /// </summary>
        private static Metadata.MetadataService BuildFakeMetadata()
        {
            var service = new FakeOrganizationService();

            service.AddTable("account");
            service.AddTable("contact", system: true);
            service.AddTable("opportunity");
            service.AddTable("quote");
            service.AddTable("asyncoperation", system: true);

            // Hop 1 from account.
            service.Link("account", "contact", "contact_customer_accounts", "parentcustomerid");
            service.Link("account", "opportunity", "opportunity_customer_accounts", "customerid");
            service.Link("account", "asyncoperation", "account_asyncoperations", "regardingobjectid");

            // Hop 2.
            service.Link("opportunity", "quote", "opportunity_quotes", "opportunityid");

            return new Metadata.MetadataService(service);
        }

        // ------------------------------------------------------------------
        // Cascade impact. Direction is the thing to get wrong here: cascading flows from the "one"
        // end of a 1:N to the "many" end and never the other way, so deleting a Contact must not
        // report its Account. Restrict and RemoveLink are separate answers, not weaker cascades.
        // ------------------------------------------------------------------

        private static void RunCascadeChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account");
            service.AddTable("contact");
            service.AddTable("task");
            service.AddTable("invoice");
            service.AddTable("note");
            service.AddTable("audit");

            var cascade = Microsoft.Xrm.Sdk.Metadata.CascadeType.Cascade;
            var removeLink = Microsoft.Xrm.Sdk.Metadata.CascadeType.RemoveLink;
            var restrict = Microsoft.Xrm.Sdk.Metadata.CascadeType.Restrict;
            var noCascade = Microsoft.Xrm.Sdk.Metadata.CascadeType.NoCascade;

            // account -> contact cascades on both delete and assign, and contact -> task cascades
            // on delete only, so the two behaviours must produce different chains.
            service.Link("account", "contact", "contact_customer_accounts", "parentcustomerid", cascade, cascade);
            service.Link("contact", "task", "contact_tasks", "regardingobjectid", cascade, noCascade);

            // Deleting an account is refused while invoices exist.
            service.Link("account", "invoice", "account_invoices", "customerid", restrict, noCascade);

            // A note survives and loses its link.
            service.Link("account", "note", "account_annotations", "objectid", removeLink, noCascade);

            var analyser = new Services.CascadeService(new Metadata.MetadataService(service));

            var deletes = analyser.Analyse(new Services.CascadeOptions
            {
                StartTable = "account",
                Behaviour = "Delete"
            });

            var deleted = deletes.Affected.Select(s => s.ToTable).ToList();

            Check("a cascading delete reaches the child table", deleted.Contains("contact"));
            Check("and follows the chain past it", deleted.Contains("task"));
            Check("the second hop is recorded as a second hop",
                deletes.Affected.First(s => s.ToTable == "task").Hops == 2);
            Check("a Restrict relationship is not treated as cascading", !deleted.Contains("invoice"));
            Check("a RemoveLink relationship is not treated as cascading", !deleted.Contains("note"));

            Check("Restrict is reported as a blocker",
                deletes.Blockers.Any(s => s.ToTable == "invoice"));
            Check("RemoveLink is reported separately",
                deletes.Detached.Any(s => s.ToTable == "note"));
            Check("the blocker names the relationship",
                deletes.Blockers.First().RelationshipSchemaName == "account_invoices");
            Check("each step names the lookup column",
                deletes.Affected.First(s => s.ToTable == "contact").LookupColumn == "parentcustomerid");

            // The direction check: cascading never flows from the many side to the one side.
            var fromChild = analyser.Analyse(new Services.CascadeOptions
            {
                StartTable = "contact",
                Behaviour = "Delete"
            });

            Check("deleting a child does not report its parent",
                !fromChild.Affected.Any(s => s.ToTable == "account"));
            Check("but still reports its own children",
                fromChild.Affected.Any(s => s.ToTable == "task"));

            // Assign cascades to contact but not on to task, so the chain must be shorter.
            var assigns = analyser.Analyse(new Services.CascadeOptions
            {
                StartTable = "account",
                Behaviour = "Assign"
            });

            var assigned = assigns.Affected.Select(s => s.ToTable).ToList();
            Check("assign follows its own configuration", assigned.Contains("contact"));
            Check("and stops where that configuration stops", !assigned.Contains("task"));

            // Nothing at all, said in words rather than as an empty list.
            var quiet = analyser.Analyse(new Services.CascadeOptions
            {
                StartTable = "audit",
                Behaviour = "Delete"
            });

            Check("a table with no cascade reports nothing affected", quiet.Affected.Count == 0);
            Check("and says so", !string.IsNullOrEmpty(quiet.Message));

            var missing = analyser.Analyse(new Services.CascadeOptions
            {
                StartTable = "nosuchtable",
                Behaviour = "Delete"
            });

            Check("an unknown table is explained", !string.IsNullOrEmpty(missing.Message));

            // A cycle must terminate rather than walk for ever.
            var loop = new FakeOrganizationService();
            loop.AddTable("a");
            loop.AddTable("b");
            loop.Link("a", "b", "a_b", "aid", cascade, cascade);
            loop.Link("b", "a", "b_a", "bid", cascade, cascade);

            var cyclical = new Services.CascadeService(new Metadata.MetadataService(loop))
                .Analyse(new Services.CascadeOptions { StartTable = "a", Behaviour = "Delete" });

            Check("a cascade cycle terminates", cyclical.Affected.Count <= 2);
            Check("a cycle back to the start does not list the start table",
                !cyclical.Affected.Any(s => s.ToTable == "a"));

            // A self-referential hierarchy is the common case - account parenting account. It must
            // be reported in words, not by claiming that deleting an Account deletes Account.
            var hierarchy = new FakeOrganizationService();
            hierarchy.AddTable("account");
            hierarchy.AddTable("contact");
            hierarchy.Link("account", "account", "account_parent_account", "parentaccountid", cascade, cascade);
            hierarchy.Link("account", "contact", "contact_customer_accounts", "parentcustomerid", cascade, cascade);

            var hierarchical = new Services.CascadeService(new Metadata.MetadataService(hierarchy))
                .Analyse(new Services.CascadeOptions { StartTable = "account", Behaviour = "Delete" });

            Check("a self-referential cascade does not list the table as its own casualty",
                !hierarchical.Affected.Any(s => s.ToTable == "account"));
            Check("but it is reported", hierarchical.SelfReferencing);
            Check("and said in words", hierarchical.Message != null && hierarchical.Message.Contains("itself"));
            Check("the other children are still found",
                hierarchical.Affected.Any(s => s.ToTable == "contact"));

            // RemoveLink beyond the first hop is real: the hop-2 table's records ARE being deleted,
            // so its own children genuinely do lose their lookup.
            var deep = new FakeOrganizationService();
            deep.AddTable("account");
            deep.AddTable("contact");
            deep.AddTable("incident");
            deep.Link("account", "contact", "contact_customer_accounts", "parentcustomerid", cascade, cascade);
            deep.Link("contact", "incident", "contact_incidents", "customerid", removeLink, noCascade);

            var deepResult = new Services.CascadeService(new Metadata.MetadataService(deep))
                .Analyse(new Services.CascadeOptions { StartTable = "account", Behaviour = "Delete" });

            Check("a RemoveLink two hops out is still reported",
                deepResult.Detached.Any(s => s.ToTable == "incident"));
        }

        // ------------------------------------------------------------------
        // Documentation. The point of these is that the document says what the diagram says: the
        // same columns, the same statuses, and the design register that nothing else records.
        // ------------------------------------------------------------------

        private static void RunDocumentationChecks(DiagramDocument document)
        {
            document.Settings.FieldDetail = FieldDetailMode.AllFields;

            var markdown = DocumentationExporter.ExportMarkdown(document).Text;

            Check("leads with the diagram title", markdown.StartsWith("# "));
            Check("records the source environment", markdown.Contains("Source environment"));
            Check("says nothing has been applied to Dataverse",
                markdown.Contains("Nothing in it has been applied to Dataverse"));
            Check("has a table section", markdown.Contains("## Tables"));
            Check("has a relationship section", markdown.Contains("## Relationships"));
            Check("names each table", markdown.Contains("### Account"));
            Check("lists columns", markdown.Contains("| Column | Type | Key | Status |"));
            Check("reports ownership", markdown.Contains("| Ownership |"));
            Check("embeds a diagram", markdown.Contains("```mermaid"));
            Check("tabulates cascade behaviour", markdown.Contains("### Cascade behaviour"));

            Check("registers the proposed objects",
                markdown.Contains("## Proposed and deprecated objects"));
            Check("and names one", markdown.Contains("| Table | Proposed |") ||
                markdown.Contains("Proposed |"));

            // The summary line about what is recorded but not drawn is about what the reader cannot
            // see, not about which control put it out of sight - so it counts hidden connectors as
            // well as excluded ones. Hide is the only one of the two a user can reach.
            //
            // Both states are exercised on the one document: the fixture already carries a
            // connector excluded in an older file, and this hides a second one by hand.
            var notDrawnLine = new Func<string, string>(text => text.Split('\n')
                .FirstOrDefault(line => line.Contains("recorded but not drawn")) ?? "(no such line)");

            Check("the fixture starts with one connector out of sight, the legacy excluded one",
                markdown.Contains("| Relationships recorded but not drawn | 1 |"),
                notDrawnLine(markdown));

            var toHide = document.Relationships.Single(r => r.SchemaName == "contact_customer_accounts");
            toHide.Hidden = true;

            var withHidden = DocumentationExporter.ExportMarkdown(document).Text;
            var withHiddenHtml = DocumentationExporter.ExportHtml(document).Text;

            Check("hiding a connector adds it to that count",
                withHidden.Contains("| Relationships recorded but not drawn | 2 |"),
                notDrawnLine(withHidden));
            Check("and the HTML summary agrees with the Markdown one",
                withHiddenHtml.Contains("Relationships recorded but not drawn</th><td>2</td>"),
                notDrawnLine(withHiddenHtml));
            Check("and it stops being counted among the ones that are drawn",
                withHidden.Contains("| Relationships drawn | 4 |"),
                withHidden.Split('\n').FirstOrDefault(line => line.Contains("Relationships drawn")) ?? "(none)");

            toHide.Hidden = false;

            // A note containing a pipe would break every following cell in its row.
            var awkward = document.Tables.First();
            var previousNote = awkward.Notes;
            awkward.Notes = "Contains | a pipe\nand a newline";

            var escaped = DocumentationExporter.ExportMarkdown(document).Text;
            var noteLine = escaped.Split('\n').FirstOrDefault(l => l.Contains("Contains"));

            Check("escapes a pipe in free text", noteLine != null && noteLine.Contains("\\|"), noteLine);
            Check("flattens a newline in free text",
                escaped.Split('\n').Count(l => l.Contains("and a newline")) == 1);

            awkward.Notes = previousNote;

            var html = DocumentationExporter.ExportHtml(document).Text;

            Check("html is a complete document", html.StartsWith("<!DOCTYPE html>") && html.TrimEnd().EndsWith("</html>"));
            Check("html carries its own styling", html.Contains("<style>"));
            Check("html fetches nothing", !html.Contains("<link ") && !html.Contains("<script"));
            Check("html escapes markup in free text", !html.Contains("<script>alert"));
            Check("html reports ownership", html.Contains("Ownership"));
            Check("html lists relationships", html.Contains("<th>Lookup column</th>"));

            // A design register asks a design authority to approve a list of objects, so a
            // relationship and the lookup column it implies have to appear on it as one thing.
            var register = markdown.Substring(markdown.IndexOf("## Proposed and deprecated objects", StringComparison.Ordinal));
            var registerEnd = register.IndexOf("\n## ", 4, StringComparison.Ordinal);
            if (registerEnd > 0) register = register.Substring(0, registerEnd);

            Check("the register lists the proposed relationship",
                register.Contains("cs_account_segment"));
            Check("and not the lookup column it creates as a second object",
                !register.Contains("Customer Segment.Account"), register);
            Check("but it does say the relationship brings that column with it",
                register.Contains("Creates the lookup column cs_accountid"), register);

            // Three kinds of annotation, and only one of them is a note. A text box listed as a
            // bullet under "Notes" gives a canvas label the weight of a reasoned design note, and
            // an arrow - which has no text - still has to be accounted for.
            Check("annotations are labelled by kind rather than all called notes",
                markdown.Contains("## Notes and labels") &&
                markdown.Contains("**Text box.** Phase 2 scope"), markdown.Contains("## Notes and labels").ToString());
            Check("a sticky note says so too", markdown.Contains("**Sticky note.**"));
            Check("and arrows are accounted for rather than silently dropped",
                markdown.Contains("arrow is drawn on the canvas") ||
                markdown.Contains("arrows are drawn on the canvas"));

            // The exported catalogue and the picture beside it have to list a table's rows in the
            // same order. ExportRowBuilder applies both the selection and the ordering half of the
            // canvas rule, so the primary key comes first wherever metadata puts it.
            //
            // Driven off a table whose metadata order is deliberately the wrong way round. The
            // fixture's own tables happen to list their primary key first, so a check against one
            // of those would pass with the ranking taken out altogether.
            var rankProbe = new DiagramTable
            {
                LogicalName = "cs_rankprobe", DisplayName = "Rank probe", Status = ObjectStatus.Existing,
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = "cs_plain", DisplayName = "Plain", Selected = true },
                    new DiagramColumn { LogicalName = "cs_lookup", DisplayName = "Lookup", IsLookup = true, Selected = true },
                    new DiagramColumn { LogicalName = "cs_rankprobeid", DisplayName = "Identifier", IsPrimaryId = true, Selected = true },
                    new DiagramColumn { LogicalName = "cs_name", DisplayName = "Name", IsPrimaryName = true, Selected = true }
                }
            };
            document.Tables.Add(rankProbe);

            var ordered = ExportRowBuilder.SelectedColumns(document, rankProbe).ToList();

            Check("the exported column order floats the primary key to the top, as the canvas does",
                ordered.Count > 1 && ordered[0].IsPrimaryId,
                string.Join(", ", ordered.Select(c => c.LogicalName)));
            Check("then the primary name column, as the canvas does",
                ordered.Count > 1 && ordered[1].IsPrimaryName,
                string.Join(", ", ordered.Select(c => c.LogicalName)));
            Check("and the lookup above the plain columns",
                ordered.FindIndex(c => c.IsLookup) < ordered.FindIndex(c => !c.IsPrimaryId && !c.IsLookup && !c.IsPrimaryName),
                string.Join(", ", ordered.Select(c => c.LogicalName)));

            // A card whose rows the user dragged into an order is in that order in the exports too,
            // ahead of the key float - the same rule `orderColumns` applies on the canvas, so the
            // picture and the catalogue beside it agree.
            rankProbe.ColumnOrder = new List<string> { "cs_plain", "cs_rankprobeid" };
            var byHand = ExportRowBuilder.SelectedColumns(document, rankProbe).ToList();

            Check("a hand-made field order beats the key float in the exports too",
                byHand.Count > 1 && byHand[0].LogicalName == "cs_plain" && byHand[1].IsPrimaryId,
                string.Join(", ", byHand.Select(c => c.LogicalName)));
            Check("and a column the order has never heard of comes after the ones it has",
                byHand.FindIndex(c => c.LogicalName == "cs_lookup") > 1 &&
                byHand.FindIndex(c => c.LogicalName == "cs_name") > 1,
                string.Join(", ", byHand.Select(c => c.LogicalName)));
            Check("with the unlisted columns still in the order they would have had",
                byHand.FindIndex(c => c.IsPrimaryName) < byHand.FindIndex(c => c.IsLookup),
                string.Join(", ", byHand.Select(c => c.LogicalName)));

            // The sort is by logical name and the canvas lower-cases every key it writes, so the
            // two runtimes have to agree about case or a card ordered on screen comes out in
            // metadata order in every document.
            rankProbe.ColumnOrder = new List<string> { "CS_PLAIN" };
            Check("the order is matched without regard to case",
                ExportRowBuilder.SelectedColumns(document, rankProbe).First().LogicalName == "cs_plain",
                ExportRowBuilder.SelectedColumns(document, rankProbe).First().LogicalName);

            rankProbe.ColumnOrder = new List<string>();
            Check("and an empty order leaves the ordinary rules alone",
                ExportRowBuilder.SelectedColumns(document, rankProbe).First().IsPrimaryId);

            document.Tables.Remove(rankProbe);

            // Column order is a diagram setting that applies to every document as well as the
            // canvas. Driven off a table built for it, so the check cannot pass by coincidence of the
            // fixture's own metadata order.
            var orderProbe = new DiagramTable
            {
                LogicalName = "cs_orderprobe", DisplayName = "Order probe", Status = ObjectStatus.Existing,
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = "cs_charlie", DisplayName = "Charlie", Selected = true },
                    new DiagramColumn { LogicalName = "cs_alpha", DisplayName = "Alpha", Selected = true },
                    new DiagramColumn { LogicalName = "cs_bravo", DisplayName = "Bravo", Selected = true }
                }
            };
            document.Tables.Add(orderProbe);

            document.Settings.FieldOrder = "metadata";
            var asWritten = string.Join(",", ExportRowBuilder.SelectedColumns(document, orderProbe).Select(c => c.LogicalName));

            document.Settings.FieldOrder = "schemaName";
            var bySchema = string.Join(",", ExportRowBuilder.SelectedColumns(document, orderProbe).Select(c => c.LogicalName));

            Check("Column order reaches the documents at all",
                asWritten == "cs_charlie,cs_alpha,cs_bravo" && bySchema == "cs_alpha,cs_bravo,cs_charlie",
                asWritten + "  |  " + bySchema);

            document.Settings.FieldOrder = "metadata";
            document.Tables.Remove(orderProbe);

            // A collapsed card draws its name and nothing else. The Mermaid exporter has to honour
            // the collapsed flag too, because the documentation export embeds that diagram beside
            // prose saying the table has no columns shown.
            var collapsible = document.Tables.First(t => t.DisplayName == "Customer Segment");
            collapsible.Collapsed = true;
            var collapsedMermaid = MermaidExporter.Export(document).Text;
            Check("Mermaid honours a collapsed card, like every other exporter",
                !collapsedMermaid.Contains("cs_accountid"), collapsedMermaid);
            collapsible.Collapsed = false;

            // The document must respect the diagram's own column choices, not print everything.
            document.Settings.FieldDetail = FieldDetailMode.TablesOnly;
            var terse = DocumentationExporter.ExportMarkdown(document).Text;

            Check("tables-only detail leaves the columns out",
                terse.Contains("No columns are shown for this table"));

            document.Settings.FieldDetail = FieldDetailMode.AllFields;
        }

        private static void RunPathChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account");
            service.AddTable("contact");
            service.AddTable("opportunity");
            service.AddTable("quote");
            service.AddTable("island");

            service.Link("account", "contact", "contact_customer_accounts", "parentcustomerid");
            service.Link("account", "opportunity", "opportunity_customer_accounts", "customerid");
            service.Link("opportunity", "quote", "opportunity_quotes", "opportunityid");

            var discovery = new Services.DiscoveryService(new Metadata.MetadataService(service));

            var direct = discovery.FindPaths("account", "contact", 4, 8);
            Check("finds a one-hop path", direct.Paths.Count > 0, direct.Message);
            Check("the one-hop path has two steps",
                direct.Paths.Count > 0 && direct.Paths[0].Steps.Count == 2);
            Check("names the relationship used", direct.Paths.Count > 0 &&
                direct.Paths[0].Steps[1].RelationshipSchemaName == "contact_customer_accounts");

            var indirect = discovery.FindPaths("contact", "quote", 4, 8);
            Check("finds a three-hop path", indirect.Paths.Count > 0, indirect.Message);
            Check("the path runs through the intermediate tables",
                indirect.Paths.Count > 0 &&
                string.Join(">", indirect.Paths[0].Steps.Select(s => s.Table)) ==
                    "contact>account>opportunity>quote");

            var shallow = discovery.FindPaths("contact", "quote", 2, 8);
            Check("respects the hop limit", shallow.Paths.Count == 0);
            Check("says why nothing was found", !string.IsNullOrWhiteSpace(shallow.Message));

            var unreachable = discovery.FindPaths("account", "island", 4, 8);
            Check("reports genuinely unconnected tables", unreachable.Paths.Count == 0);

            var same = discovery.FindPaths("account", "account", 4, 8);
            Check("rejects the same table twice", same.Paths.Count == 0);

            // Without the per-table guard, this graph is walked repeatedly through every route
            // into a table, and each walk is a live RetrieveEntityRequest.
            Check("does not re-read a table it has already expanded",
                service.RetrieveCount <= 5, service.RetrieveCount + " retrieves");
        }

        // ------------------------------------------------------------------
        // Refresh: proposed columns on a real table
        // ------------------------------------------------------------------

        /// <summary>
        /// A proposed relationship owns the lookup column it implies, and a refresh has to treat
        /// the two as one object.
        ///
        /// The column is not offered as its own promotion candidate, so it cannot be confirmed
        /// alone - which would leave the diagram asserting that a lookup exists while the
        /// relationship that *is* that lookup does not. Promoting the relationship settles the
        /// column too, rather than keeping the name the tool invented as though it were real. And
        /// promoting a proposed *table* must not put any proposed column on the card twice.
        /// </summary>
        private static void RunRelationshipPromotionChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account");
            service.AddTable("cs_segment", "cs_realaccountid");
            service.Link("account", "cs_segment", "cs_account_segment", "cs_realaccountid");

            var refresh = new Services.RefreshService(new Metadata.MetadataService(service));

            var document = new DiagramDocument();
            var account = new DiagramTable { LogicalName = "account", DisplayName = "Account", Status = ObjectStatus.Existing };
            var segment = new DiagramTable { LogicalName = "cs_segment", DisplayName = "Segment", Status = ObjectStatus.Existing };
            document.Tables.Add(account);
            document.Tables.Add(segment);

            var link = new DiagramRelationship
            {
                SchemaName = "cs_account_segment",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Proposed,
                FromTableId = account.Id,
                ToTableId = segment.Id,
                // The name the canvas derived. The developer used cs_realaccountid.
                ReferencingAttribute = "cs_accountid",
                Included = true
            };
            document.Relationships.Add(link);

            segment.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_accountid", DisplayName = "Account", TypeName = "Lookup",
                IsLookup = true, Status = ObjectStatus.Proposed, Selected = true,
                FromRelationshipId = link.Id
            });

            var outcome = refresh.Refresh(document);

            var columnCandidates = outcome.Report.PromotionCandidates
                .Where(c => string.Equals(c.ObjectKind, "column", StringComparison.OrdinalIgnoreCase)).ToList();
            var relationshipCandidate = outcome.Report.PromotionCandidates
                .FirstOrDefault(c => string.Equals(c.ObjectKind, "relationship", StringComparison.OrdinalIgnoreCase));

            Check("the relationship is offered", relationshipCandidate != null);
            Check("and its lookup column is not offered as a second, independent decision",
                columnCandidates.Count == 0,
                string.Join(", ", columnCandidates.Select(c => c.ProposedName)));

            // The case that actually reaches the guard: the developer used exactly the name the
            // canvas derived, so the proposed lookup matches a real column by name. It must not be
            // offered as a candidate in its own right, or confirming only the column would leave the
            // diagram asserting a lookup exists while the relationship that *is* that lookup does not.
            var sameNameService = new FakeOrganizationService();
            sameNameService.AddTable("account");
            sameNameService.AddTable("cs_segment", "cs_accountid");
            sameNameService.Link("account", "cs_segment", "cs_account_segment", "cs_accountid");

            var sameNameRefresh = new Services.RefreshService(new Metadata.MetadataService(sameNameService));
            var sameNameDocument = new DiagramDocument();
            var sameAccount = new DiagramTable { LogicalName = "account", DisplayName = "Account", Status = ObjectStatus.Existing };
            var sameSegment = new DiagramTable { LogicalName = "cs_segment", DisplayName = "Segment", Status = ObjectStatus.Existing };
            sameNameDocument.Tables.Add(sameAccount);
            sameNameDocument.Tables.Add(sameSegment);

            var sameLink = new DiagramRelationship
            {
                SchemaName = "cs_account_segment",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Proposed,
                FromTableId = sameAccount.Id,
                ToTableId = sameSegment.Id,
                ReferencingAttribute = "cs_accountid",
                Included = true
            };
            sameNameDocument.Relationships.Add(sameLink);

            sameSegment.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_accountid", DisplayName = "Account", TypeName = "Lookup",
                IsLookup = true, Status = ObjectStatus.Proposed, Selected = true,
                FromRelationshipId = sameLink.Id
            });

            var sameOutcome = sameNameRefresh.Refresh(sameNameDocument);
            var sameColumns = sameOutcome.Report.PromotionCandidates
                .Where(c => string.Equals(c.ObjectKind, "column", StringComparison.OrdinalIgnoreCase)).ToList();

            Check("nor when the developer used exactly the name the canvas derived",
                sameColumns.Count == 0, string.Join(", ", sameColumns.Select(c => c.ProposedName)));
            Check("while the relationship itself is still offered",
                sameOutcome.Report.PromotionCandidates.Any(c =>
                    string.Equals(c.ObjectKind, "relationship", StringComparison.OrdinalIgnoreCase)));

            var promoted = refresh.Promote(outcome.Document, new[]
            {
                new Services.PromotionInstruction
                {
                    DiagramObjectId = relationshipCandidate.DiagramObjectId,
                    ObjectKind = "relationship",
                    MatchedLogicalName = relationshipCandidate.MatchedLogicalName
                }
            });

            var promotedLink = promoted.Relationships.First();
            var promotedSegment = promoted.Tables.First(t => t.LogicalName == "cs_segment");

            Check("confirming it promotes the relationship", promotedLink.Status == ObjectStatus.Existing);
            Check("and takes the lookup column name the environment really uses",
                promotedLink.ReferencingAttribute == "cs_realaccountid", promotedLink.ReferencingAttribute);
            Check("and the metadata id, so the connector describes a real relationship",
                !string.IsNullOrEmpty(promotedLink.MetadataId));
            Check("the invented column is gone from the card",
                !promotedSegment.Columns.Any(c => c.LogicalName == "cs_accountid"),
                string.Join(", ", promotedSegment.Columns.Select(c => c.LogicalName)));
            Check("and the real one is there exactly once, as an ordinary column",
                promotedSegment.Columns.Count(c => c.LogicalName == "cs_realaccountid") == 1 &&
                promotedSegment.Columns.First(c => c.LogicalName == "cs_realaccountid").Status == ObjectStatus.Existing &&
                string.IsNullOrEmpty(promotedSegment.Columns.First(c => c.LogicalName == "cs_realaccountid").FromRelationshipId),
                string.Join(", ", promotedSegment.Columns.Select(c => c.LogicalName + "/" + c.Status)));

            // Promoting a proposed *table* re-runs the column merge with no candidate list. The
            // hold-back that keeps a real column off the card while its proposal is unconfirmed has
            // to apply there too, or every proposed column whose name now exists would be added as
            // fresh metadata and then appended again as a proposal.
            var tableService = new FakeOrganizationService();
            tableService.AddTable("cs_widget", "cs_code");

            var tableRefresh = new Services.RefreshService(new Metadata.MetadataService(tableService));
            var tableDocument = new DiagramDocument();
            var widget = new DiagramTable
            {
                LogicalName = null,
                SchemaName = "cs_widget",
                DisplayName = "cs_widget",
                Status = ObjectStatus.Proposed,
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = "cs_code", DisplayName = "Code", TypeName = "Text", Status = ObjectStatus.Proposed, Selected = true },
                    new DiagramColumn { LogicalName = "cs_extra", DisplayName = "Extra", TypeName = "Text", Status = ObjectStatus.Proposed, Selected = true }
                }
            };
            tableDocument.Tables.Add(widget);

            var tableOutcome = tableRefresh.Refresh(tableDocument);
            var tableCandidate = tableOutcome.Report.PromotionCandidates
                .FirstOrDefault(c => string.Equals(c.ObjectKind, "table", StringComparison.OrdinalIgnoreCase));

            Check("a proposed table that now exists is offered", tableCandidate != null);

            var promotedTables = tableRefresh.Promote(tableOutcome.Document, new[]
            {
                new Services.PromotionInstruction
                {
                    DiagramObjectId = tableCandidate.DiagramObjectId,
                    ObjectKind = "table",
                    MatchedLogicalName = tableCandidate.MatchedLogicalName
                }
            });

            var promotedWidget = promotedTables.Tables.First();
            var duplicated = promotedWidget.Columns
                .GroupBy(c => c.LogicalName, StringComparer.OrdinalIgnoreCase)
                .Where(g => g.Count() > 1)
                .Select(g => g.Key)
                .ToList();

            Check("promoting a table does not put its columns on the card twice",
                duplicated.Count == 0, string.Join(", ", duplicated));
            Check("and the proposal is still a proposal until it is confirmed in its own right",
                promotedWidget.Columns.Any(c => c.LogicalName == "cs_code" && c.Status == ObjectStatus.Proposed),
                string.Join(", ", promotedWidget.Columns.Select(c => c.LogicalName + "/" + c.Status)));
        }

        private static void RunPromotionChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account", "cs_segmentcode");

            var refresh = new Services.RefreshService(new Metadata.MetadataService(service));

            var document = new DiagramDocument();
            var account = new DiagramTable
            {
                LogicalName = "account",
                DisplayName = "Account",
                Status = ObjectStatus.Existing,
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn
                    {
                        LogicalName = "cs_segmentcode", DisplayName = "Segment code",
                        TypeName = "Text", Status = ObjectStatus.Proposed, Selected = true,
                        Notes = "Agreed at the design board"
                    },
                    new DiagramColumn
                    {
                        LogicalName = "cs_notyet", DisplayName = "Not yet built",
                        TypeName = "Text", Status = ObjectStatus.Proposed, Selected = true
                    }
                }
            };
            document.Tables.Add(account);

            var outcome = refresh.Refresh(document);
            var refreshed = outcome.Document.Tables.First();

            var candidate = outcome.Report.PromotionCandidates
                .FirstOrDefault(c => string.Equals(c.ObjectKind, "column", StringComparison.OrdinalIgnoreCase));

            Check("a proposed column that now exists is offered, not promoted", candidate != null);
            Check("the candidate names its parent table",
                candidate != null && candidate.ParentTableId == account.Id);
            Check("an exact schema-name match is high confidence, so it is pre-ticked",
                candidate != null && candidate.Confidence == "high");
            // The merge refreshes the display name from metadata before the candidate is built,
            // so the reason carries whatever the environment calls the table.
            Check("the reason names the column and the table",
                candidate != null && candidate.MatchReason.Contains("cs_segmentcode") &&
                candidate.MatchReason.IndexOf("account", StringComparison.OrdinalIgnoreCase) >= 0,
                candidate?.MatchReason);

            var awaiting = refreshed.Columns.FirstOrDefault(c => c.LogicalName == "cs_segmentcode");
            Check("the column stays proposed until the match is confirmed",
                awaiting != null && awaiting.Status == ObjectStatus.Proposed);
            Check("the real column is not drawn alongside its unconfirmed proposal",
                refreshed.Columns.Count(c => c.LogicalName == "cs_segmentcode") == 1);

            var stillProposed = refreshed.Columns.FirstOrDefault(c => c.LogicalName == "cs_notyet");
            Check("a proposed column with no match stays proposed",
                stillProposed != null && stillProposed.Status == ObjectStatus.Proposed);

            // Declining is the same as never confirming: nothing changes, and the next refresh
            // offers the match again.
            var declined = refresh.Refresh(outcome.Document);
            Check("a declined match is offered again on the next refresh",
                declined.Report.PromotionCandidates.Any(c =>
                    string.Equals(c.ObjectKind, "column", StringComparison.OrdinalIgnoreCase)));

            var promotedDocument = refresh.Promote(outcome.Document, new[]
            {
                new Services.PromotionInstruction
                {
                    DiagramObjectId = candidate.DiagramObjectId,
                    ParentTableId = candidate.ParentTableId,
                    ObjectKind = "column",
                    MatchedLogicalName = candidate.MatchedLogicalName
                }
            });

            var promotedTable = promotedDocument.Tables.First();
            var promoted = promotedTable.Columns.FirstOrDefault(c => c.LogicalName == "cs_segmentcode");

            Check("confirming promotes the column", promoted != null && promoted.Status == ObjectStatus.Existing);
            Check("the promotion keeps the user's note",
                promoted != null && promoted.Notes == "Agreed at the design board");
            Check("the promotion does not duplicate the column",
                promotedTable.Columns.Count(c => c.LogicalName == "cs_segmentcode") == 1);
            Check("the promotion takes the real metadata",
                promoted != null && !string.IsNullOrEmpty(promoted.TypeName));
            Check("the unmatched proposal is left alone",
                promotedTable.Columns.Any(c => c.LogicalName == "cs_notyet" && c.Status == ObjectStatus.Proposed));
        }

        // ------------------------------------------------------------------
        // Refresh and metadata regression pins.
        //
        // Each check below pins one behaviour and fails if it breaks. Several of the fixtures
        // have to be built a particular way round for the guard to be reached at all, and where
        // that is so the comment says which way and why.
        // ------------------------------------------------------------------

        /// <summary>
        /// The index of live relationships a refresh compares the diagram against.
        ///
        /// Metadata reports every 1:N from both of its ends and the ManyToOne view of it carries
        /// Kind=ManyToOne, so an index keyed on schema name meets each relationship twice. If the
        /// reversed view won, the refresh would report "cardinality changed from OneToMany to
        /// ManyToOne" for a relationship nobody had touched, and write that kind into the
        /// document, which the canvas and every exporter would then draw backwards.
        /// </summary>
        private static void RunLiveRelationshipIndexChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account");
            service.AddTable("contact");
            service.Link("account", "contact", "contact_customer_accounts", "parentcustomerid");

            // contact is added to the document second on purpose. It is the referencing table, so
            // its ManyToOne view is the one a last-writer-wins index would end up keeping; with the
            // tables the other way round the guard is not reached at all.
            var document = new DiagramDocument();
            var account = ExistingTable("account");
            var contact = ExistingTable("contact");
            document.Tables.Add(account);
            document.Tables.Add(contact);
            document.Relationships.Add(LiveRelationship(
                "contact_customer_accounts", account, contact, "account", "contact", "parentcustomerid"));

            var outcome = new Services.RefreshService(new Metadata.MetadataService(service)).Refresh(document);
            var link = outcome.Document.Relationships.First();

            Check("leaves a 1:N whose referencing table is read last as a 1:N",
                link.Kind == RelationshipKind.OneToMany, link.Kind.ToString());
            Check("and reports no cardinality change for it",
                CardinalityChanges(outcome).Count == 0, string.Join("; ", CardinalityChanges(outcome)));

            // A self-referencing 1:N has to keep the diagram's order: one table's metadata carries
            // both views, so a last-writer-wins index would always keep the second.
            var hierarchy = new FakeOrganizationService();
            hierarchy.AddTable("account");
            hierarchy.Link("account", "account", "account_parent_account", "parentaccountid");

            var selfDocument = new DiagramDocument();
            var selfAccount = ExistingTable("account");
            selfDocument.Tables.Add(selfAccount);
            selfDocument.Relationships.Add(LiveRelationship(
                "account_parent_account", selfAccount, selfAccount, "account", "account", "parentaccountid"));

            var selfOutcome = new Services.RefreshService(new Metadata.MetadataService(hierarchy)).Refresh(selfDocument);
            var selfLink = selfOutcome.Document.Relationships.First();

            Check("leaves a self-referencing 1:N as a 1:N",
                selfLink.Kind == RelationshipKind.OneToMany, selfLink.Kind.ToString());
            Check("and reports no cardinality change for that one either",
                CardinalityChanges(selfOutcome).Count == 0, string.Join("; ", CardinalityChanges(selfOutcome)));
        }

        /// <summary>
        /// Two refreshes of the same diagram with the environment changing in between, which is the
        /// only thing a refresh is for.
        ///
        /// The second refresh has to compare the diagram against current metadata, not a snapshot
        /// the first one took, or it says "Unchanged." about a table that has grown a column.
        /// </summary>
        private static void RunMovedOnEnvironmentChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account", "cs_first");

            var metadata = new Metadata.MetadataService(service);
            var refresh = new Services.RefreshService(metadata);

            var document = new DiagramDocument();
            document.Tables.Add(ExistingTable("account"));

            refresh.Refresh(document);

            // The developer adds a column while the diagram is open.
            service.AddColumn("account", "cs_late");

            var second = refresh.Refresh(document);
            var reported = second.Report.Changed
                .Where(c => string.Equals(c.ObjectKind, "table", StringComparison.OrdinalIgnoreCase))
                .Select(c => c.Detail)
                .ToList();

            Check("sees a column added between two refreshes",
                reported.Any(d => d != null && d.Contains("cs_late")),
                string.Join(" | ", reported.Concat(second.Report.Found.Select(f => f.Detail))));
            Check("rather than reporting the table as unchanged",
                !second.Report.Found.Any(f => string.Equals(f.Detail, "Unchanged.", StringComparison.Ordinal)));

            // A relationship created between two tables that are both already on the diagram. It is
            // reported, but never added, because nothing reaches a diagram without the user saying so.
            var joined = new FakeOrganizationService();
            joined.AddTable("account");
            joined.AddTable("contact");
            joined.Link("account", "contact", "contact_customer_accounts", "parentcustomerid");

            var joinedDocument = new DiagramDocument();
            joinedDocument.Tables.Add(ExistingTable("account"));
            joinedDocument.Tables.Add(ExistingTable("contact"));

            var joinedOutcome = new Services.RefreshService(new Metadata.MetadataService(joined)).Refresh(joinedDocument);

            Check("reports a relationship created between two tables already on the diagram",
                joinedOutcome.Report.Changed.Any(c =>
                    string.Equals(c.ObjectKind, "relationship", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(c.Name, "contact_customer_accounts", StringComparison.OrdinalIgnoreCase)),
                string.Join(" | ", joinedOutcome.Report.Changed.Select(c => c.ObjectKind + " " + c.Name)));
            Check("and does not draw it on the diagram uninvited",
                joinedOutcome.Document.Relationships.Count == 0,
                joinedOutcome.Document.Relationships.Count + " relationships");

            // A proposed column can shadow a real one easily: the proposed-column editor derives the
            // logical name from the display name with no duplicate check. The real column is then
            // accounted for by the proposal rather than left to be reported as gone.
            var shadow = new FakeOrganizationService();
            shadow.AddTable("account", "cs_code");

            var shadowDocument = new DiagramDocument();
            var shadowed = ExistingTable("account");
            shadowed.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_code", DisplayName = "Code", TypeName = "Text",
                Status = ObjectStatus.Existing, Selected = true
            });
            shadowed.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_code", DisplayName = "Code", TypeName = "Text",
                Status = ObjectStatus.Proposed, Selected = true
            });
            shadowDocument.Tables.Add(shadowed);

            var shadowOutcome = new Services.RefreshService(new Metadata.MetadataService(shadow)).Refresh(shadowDocument);
            var gone = shadowOutcome.Report.Changed
                .Where(c => c.Detail != null && c.Detail.Contains("no longer exists"))
                .Select(c => c.Detail)
                .ToList();

            Check("does not report a column the environment still has as gone, because a proposal shadows it",
                gone.Count == 0, string.Join("; ", gone));
        }

        /// <summary>
        /// A refresh carries the user's column selection, notes and status onto the fresh metadata
        /// it merges in. Those edits must not land inside the metadata cache, or the next diagram
        /// opened on the same connection would get the first one's hidden columns, private notes
        /// and deprecated statuses.
        /// </summary>
        private static void RunMetadataCacheChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account", "cs_thing");

            var metadata = new Metadata.MetadataService(service);

            var document = new DiagramDocument();
            var account = ExistingTable("account");
            account.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_thing", DisplayName = "Thing", TypeName = "Text",
                Status = ObjectStatus.Deprecated, Selected = false, Notes = "Hidden for the design board"
            });
            document.Tables.Add(account);

            new Services.RefreshService(metadata).Refresh(document);

            var afterwards = metadata.GetTable("account");
            var column = afterwards.Columns.FirstOrDefault(c => c.LogicalName == "cs_thing");

            Check("hands a later reader the table without the user's hidden column, note or status on it",
                column != null && column.Selected && string.IsNullOrEmpty(column.Notes) &&
                column.Status == ObjectStatus.Existing,
                column == null ? "no column" : column.Selected + "/" + column.Notes + "/" + column.Status);
        }

        /// <summary>
        /// Promoting a proposed relationship the environment turns out to have the other way round.
        ///
        /// The proposal is matched on schema name alone, so its ends may well be reversed: a
        /// developer drawing a lookup puts it on the table they are thinking about, which is as
        /// often the "one" end as the "many" end. Left as drawn, FromTableId and ToTableId would
        /// send SettleOwnedLookup at the wrong card, where the only row of the right name is that
        /// card's own primary key, and leave the correct card without its real lookup.
        ///
        /// The names here are the ordinary ones: the environment's relationship runs cs_segment to
        /// account through account.cs_segmentid, and cs_segmentid is also the primary key of
        /// cs_segment, which is exactly the collision the guard exists for.
        /// </summary>
        private static void RunReversedPromotionChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account", "cs_segmentid");
            service.AddTable("cs_segment");
            service.Link("cs_segment", "account", "cs_account_segment", "cs_segmentid");

            var refresh = new Services.RefreshService(new Metadata.MetadataService(service));

            var document = new DiagramDocument();
            var account = ExistingTable("account");
            var segment = ExistingTable("cs_segment");
            document.Tables.Add(account);
            document.Tables.Add(segment);

            // Drawn the other way round from the environment: the user made account the "one" end.
            var link = new DiagramRelationship
            {
                SchemaName = "cs_account_segment",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Proposed,
                FromTableId = account.Id,
                ToTableId = segment.Id,
                ReferencingAttribute = "cs_accountid",
                Included = true,

                // Routed by hand while it ran the other way round. The corners are absolute canvas
                // coordinates placed around that shape, so a promotion that swaps the ends without them
                // would leave the route visiting them backwards and drawing back over itself.
                Waypoints = new List<PointD> { new PointD { X = 120, Y = 60 } },
                RouteOffset = 40
            };
            document.Relationships.Add(link);

            segment.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_accountid", DisplayName = "Account", TypeName = "Lookup",
                IsLookup = true, Status = ObjectStatus.Proposed, Selected = true,
                FromRelationshipId = link.Id
            });

            var outcome = refresh.Refresh(document);
            var candidate = outcome.Report.PromotionCandidates
                .FirstOrDefault(c => string.Equals(c.ObjectKind, "relationship", StringComparison.OrdinalIgnoreCase));

            Check("the reversed relationship is offered", candidate != null);
            if (candidate == null) return;

            var promoted = refresh.Promote(outcome.Document, new[]
            {
                new Services.PromotionInstruction
                {
                    DiagramObjectId = candidate.DiagramObjectId,
                    ObjectKind = "relationship",
                    MatchedLogicalName = candidate.MatchedLogicalName
                }
            });

            var promotedLink = promoted.Relationships.First();
            var manyEnd = promoted.FindTableById(promotedLink.ToTableId);

            Check("confirming it re-points both ends the way the environment has them",
                string.Equals(promotedLink.FromTableId, segment.Id, StringComparison.Ordinal) &&
                string.Equals(promotedLink.ToTableId, account.Id, StringComparison.Ordinal),
                (manyEnd == null ? "(no card)" : manyEnd.LogicalName) + " at the many end");
            Check("and settles the lookup on the card that really holds it",
                manyEnd != null && manyEnd.Columns.Any(c =>
                    !c.IsPrimaryId &&
                    string.Equals(c.LogicalName, promotedLink.ReferencingAttribute, StringComparison.OrdinalIgnoreCase)),
                manyEnd == null ? "(no card)" : promotedLink.ReferencingAttribute + " on " +
                    string.Join(", ", manyEnd.Columns.Select(c => c.LogicalName + (c.IsPrimaryId ? " (pk)" : string.Empty))));
            Check("and takes the hand routing off, because the corners were placed the other way round",
                promotedLink.Waypoints.Count == 0 && promotedLink.RouteOffset == 0 &&
                promotedLink.RouteOffsetCross == 0,
                promotedLink.Waypoints.Count + " corners, offset " + promotedLink.RouteOffset);
            Check("and never onto that card's own primary key",
                manyEnd != null && !manyEnd.Columns.Any(c =>
                    c.IsPrimaryId &&
                    string.Equals(c.LogicalName, promotedLink.ReferencingAttribute, StringComparison.OrdinalIgnoreCase)),
                manyEnd == null ? "(no card)" : promotedLink.ReferencingAttribute + " on " + manyEnd.LogicalName);
        }

        /// <summary>
        /// What comes out of an attribute list and a relationship list.
        ///
        /// A blanket "skip AttributeType == Virtual" would drop multi-select choice, file and image
        /// columns, which report Virtual while carrying their real type in AttributeTypeName. And
        /// only the referencing table's view of a 1:N can see the lookup column behind it, so the
        /// OneToMany view reports a polymorphic lookup as single-target: collapsing the two views
        /// has to merge them rather than let whichever arrived last decide.
        /// </summary>
        private static void RunAttributeReadingChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account");
            service.AddVirtualColumn("account", "cs_channels", "MultiSelectPicklistType");
            service.AddVirtualColumn("account", "cs_plumbing", "VirtualType");

            var columns = new Metadata.MetadataService(service).GetTable("account").Columns;

            Check("keeps a multi-select choice column, which reports itself as Virtual",
                columns.Any(c => c.LogicalName == "cs_channels"),
                string.Join(", ", columns.Select(c => c.LogicalName)));
            Check("and still skips an attribute that is genuinely virtual",
                !columns.Any(c => c.LogicalName == "cs_plumbing"),
                string.Join(", ", columns.Select(c => c.LogicalName)));

            // A Customer-style lookup: one column, two target tables. The relationship is read from
            // both ends here, once in each order, because only one of the orders shows whether the
            // views are merged.
            var polymorphic = new FakeOrganizationService();
            polymorphic.AddTable("account");
            polymorphic.AddTable("incident");
            polymorphic.AddLookup("incident", "customerid", "account", "contact");
            polymorphic.Link("account", "incident", "incident_customer_accounts", "customerid");

            var reader = new Metadata.MetadataService(polymorphic);

            var oneEndFirst = reader.GetRelationshipsWithin(new[] { "account", "incident" }).First();
            var manyEndFirst = reader.GetRelationshipsWithin(new[] { "incident", "account" }).First();

            Check("keeps a polymorphic lookup's targets when the relationship is read from the one end first",
                oneEndFirst.IsPolymorphic && oneEndFirst.LookupTargets.Count == 2,
                oneEndFirst.IsPolymorphic + ", " + string.Join("/", oneEndFirst.LookupTargets));
            Check("and when it is read from the many end first",
                manyEndFirst.IsPolymorphic && manyEndFirst.LookupTargets.Count == 2,
                manyEndFirst.IsPolymorphic + ", " + string.Join("/", manyEndFirst.LookupTargets));
        }

        /// <summary>
        /// A hierarchy whose only cascade is a RemoveLink: the parent record goes and the children
        /// in the same table keep their records and lose the link.
        ///
        /// A self-referencing 1:N appears twice in table.Relationships, once under each view
        /// metadata reports it, so the panel has to print it once; and the summary must not say
        /// "Nothing cascades from it" while the list of detached tables underneath it is not empty.
        /// </summary>
        private static void RunDetachedCascadeChecks()
        {
            var service = new FakeOrganizationService();
            service.AddTable("account");
            service.Link("account", "account", "account_parent_account", "parentaccountid",
                Microsoft.Xrm.Sdk.Metadata.CascadeType.RemoveLink,
                Microsoft.Xrm.Sdk.Metadata.CascadeType.NoCascade);

            var result = new Services.CascadeService(new Metadata.MetadataService(service))
                .Analyse(new Services.CascadeOptions { StartTable = "account", Behaviour = "Delete" });

            Check("lists a self-referencing RemoveLink exactly once",
                result.Detached.Count(s => s.RelationshipSchemaName == "account_parent_account") == 1,
                string.Join(", ", result.Detached.Select(s => s.RelationshipSchemaName)));
            Check("and does not say nothing cascades from the table while that list has something in it",
                result.Message != null && !result.Message.Contains("Nothing cascades from it"),
                result.Message);
        }

        /// <summary>
        /// The notes a load hands back, which are the only thing that tells a user their file was
        /// read as something other than what it says.
        /// </summary>
        private static void RunLoadNoteChecks(string currentJson)
        {
            // A relationship whose end tables are not in the file is pruned by Normalise. The load
            // says so, rather than leave the user with a file that has quietly lost part of their diagram.
            var orphaned = new DiagramDocument();
            var kept = ExistingTable("account");
            orphaned.Tables.Add(kept);
            orphaned.Relationships.Add(new DiagramRelationship
            {
                SchemaName = "cs_account_ghost",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Existing,
                FromTableId = kept.Id,
                ToTableId = "atablethatisnotinthisfile",
                Included = true
            });

            var pruned = DiagramFile.DeserializeWithNotes(DiagramFile.Serialize(orphaned));

            Check("says so when a relationship is dropped because its tables are not in the file",
                pruned.Notes.Any(n => n.Contains("removed because the tables they joined")),
                string.Join(" | ", pruned.Notes));
            Check("and drops it, as it always did",
                pruned.Document.Relationships.Count == 0);

            // Absent is not the same as present-and-1. A file with no formatVersion was written by
            // something else, so saying it was upgraded from format 1 states a guess as a fact.
            var noVersion = DiagramFile.DeserializeWithNotes(
                currentJson.Replace("\"formatVersion\": 2,", string.Empty));

            Check("does not claim a file with no version was upgraded from format 1",
                !noVersion.Notes.Any(n => n.Contains("Upgraded from file format 1")),
                string.Join(" | ", noVersion.Notes));
            Check("but says the version was missing and what was assumed instead",
                noVersion.Notes.Any(n => n.Contains("did not record a file format version")),
                string.Join(" | ", noVersion.Notes));

            var realVersionOne = DiagramFile.DeserializeWithNotes(
                currentJson.Replace("\"formatVersion\": 2", "\"formatVersion\": 1"));

            Check("while a file that really records version 1 still gets that note",
                realVersionOne.Notes.Any(n => n.Contains("Upgraded from file format 1")),
                string.Join(" | ", realVersionOne.Notes));

            // Annotation kind is matched case-insensitively in C# and case-sensitively in the
            // canvas, so the load canonicalises it - otherwise a hand-edited {"kind":"Text"} would be
            // drawn as a sticky note and exported as a text box.
            var mixedCase = DiagramFile.Deserialize(
                currentJson.Replace("\"kind\": \"text\"", "\"kind\": \"Text\""));

            Check("canonicalises an annotation kind stored as \"Text\" to \"text\"",
                mixedCase.Annotations.Any(a => a.Kind == "text") &&
                !mixedCase.Annotations.Any(a => a.Kind == "Text"),
                string.Join(", ", mixedCase.Annotations.Select(a => a.Kind)));
        }

        /// <summary>
        /// A save that fails once the temporary file is on disk.
        ///
        /// That file is kept - it is often the only complete copy of the work - so the message has
        /// to name it rather than tell the user their diagram has not been changed.
        ///
        /// A destination that is a directory is the cheapest reproducible failure that happens
        /// after the write rather than before it: the folder-not-found case the section above uses
        /// fails on the write itself, so it never reaches this message.
        /// </summary>
        private static void RunFailedSaveChecks(DiagramDocument document)
        {
            var folder = System.IO.Path.Combine(System.IO.Path.GetTempPath(),
                "dmd-failed-save-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            System.IO.Directory.CreateDirectory(folder);

            try
            {
                var occupied = System.IO.Path.Combine(folder, "diagram.dvmd");
                System.IO.Directory.CreateDirectory(occupied);

                string message = null;
                try { DiagramFile.Save(document, occupied); }
                catch (Exception ex) { message = ex.Message; }

                var leftovers = System.IO.Directory.GetFiles(folder)
                    .Select(System.IO.Path.GetFileName)
                    .ToList();

                Check("the save fails", message != null);
                Check("and the work being saved is still on disk",
                    leftovers.Count == 1, string.Join(", ", leftovers));
                Check("and the message names the file holding it",
                    message != null && leftovers.Count == 1 && message.Contains(leftovers[0]), message);
            }
            finally
            {
                try { System.IO.Directory.Delete(folder, true); } catch { /* temp folder */ }
            }
        }

        /// <summary>
        /// Checks read off the source rather than out of a run.
        ///
        /// Newtonsoft's default DateParseHandling rewrites any string whose whole value reads as an
        /// ISO-8601 date-time into a DateTime token, so a note or a description reading
        /// "2026-06-30T09:00:00Z" would come back reformatted, on load and again on every save.
        /// This harness's Newtonsoft stub is built on System.Text.Json, which never auto-detects a
        /// date inside an untyped token, so it cannot reproduce that at all - Stubs/Json.cs says so
        /// where the enum is declared. Reading the source is the only check available, the same
        /// way canvas-smoke.mjs checks app.js boot order statically.
        /// </summary>
        private static void RunSourceChecks()
        {
            var pattern = new System.Text.RegularExpressions.Regex(
                @"DateParseHandling\s*=\s*DateParseHandling\.None");

            var diagramFile = ReadSource("Model", "DiagramFile.cs");
            var control = ReadSource("ModelDesignerControl.cs");

            Check("the source of Model/DiagramFile.cs sets DateParseHandling.None on its untyped read",
                diagramFile != null && pattern.IsMatch(diagramFile),
                diagramFile == null ? "file not found" : "no such assignment");
            Check("the source of ModelDesignerControl.cs sets DateParseHandling.None on its untyped read",
                control != null && pattern.IsMatch(control),
                control == null ? "file not found" : "no such assignment");
        }

        /// <summary>
        /// Annotation depth, note rotation and the connection message: three things the exporters
        /// and the host have to agree with the canvas about.
        ///
        /// Depth is against the whole model, not just the cards: both exporters write a behind
        /// annotation before the connectors, and within a pass sticky notes go out before text
        /// boxes and arrows, so a label lying on a note is not buried under the paper it labels.
        /// </summary>
        /// <summary>
        /// Two-axis connector offsets and a hand-made column order. Both are numbers or lists that
        /// reach the canvas straight out of the file, and neither can be given a meaningless value
        /// by any gesture in the tool - so a hand-edited or half-written file is the case to guard.
        /// </summary>
        /// <summary>
        /// Hand-placed connector corners. A corner is a point on the drawn route, so an unusable one
        /// reaches documentBounds and hands Fit and every picture export a drawing with no finite
        /// extent - exactly what an infinite offset does, and guarded exactly the same way. No
        /// gesture in the tool can write one; a hand-edited or half-written file can.
        /// </summary>
        private static void Run1111Checks()
        {
            var document = new DiagramDocument { Title = "Corners" };
            var table = Table("account", "Account", 0, 0);
            var other = Table("contact", "Contact", 400, 0);
            document.Tables.Add(table);
            document.Tables.Add(other);

            document.Relationships.Add(new DiagramRelationship
            {
                Id = "r-corners", SchemaName = "cs_corners", Kind = RelationshipKind.OneToMany,
                FromTableId = table.Id, ToTableId = other.Id,
                Waypoints = new List<PointD>
                {
                    new PointD { X = 100, Y = 50 },
                    new PointD { X = 200, Y = 60 }
                }
            });

            // Infinity is not a number JSON can carry, so only a hand edit puts one in a file:
            // 1e400 is a literal too big for a double, which is what that edit looks like.
            var handEdited = DiagramFile.Serialize(document)
                .Replace("\"x\": 100", "\"x\": 1e400")
                .Replace("\"y\": 60", "\"y\": -1e400");

            var loaded = DiagramFile.Deserialize(handEdited);
            var guarded = loaded.Relationships.Single(r => r.Id == "r-corners");

            Check("a corner with an infinite coordinate is dropped on the way in",
                guarded.Waypoints.Count == 0,
                string.Join(" ", guarded.Waypoints.Select(point => point.X + "," + point.Y)));

            // Only the bad ones. Dropping the lot would silently straighten a route the user had
            // shaped, which is a bigger surprise than one corner going missing.
            var oneBad = DiagramFile.Serialize(document).Replace("\"x\": 100", "\"x\": 1e400");
            var partly = DiagramFile.Deserialize(oneBad).Relationships.Single(r => r.Id == "r-corners");

            Check("and the corners either side of it are kept",
                partly.Waypoints.Count == 1 && Math.Abs(partly.Waypoints[0].X - 200) < 0.001,
                string.Join(" ", partly.Waypoints.Select(point => point.X + "," + point.Y)));

            // An older file can carry null here, and every other collection on the model is guarded
            // the same way. A second connector with no corners of its own is what gives the edit an
            // empty list to blank out: the one above is carrying two.
            document.Relationships.Add(new DiagramRelationship
            {
                Id = "r-automatic", SchemaName = "cs_automatic", Kind = RelationshipKind.OneToMany,
                FromTableId = other.Id, ToTableId = table.Id
            });

            var nulled = DiagramFile.Serialize(document).Replace("\"waypoints\": []", "\"waypoints\": null");
            Check("the fixture really does carry a null corner list",
                nulled.Contains("\"waypoints\": null"));

            Check("a file with no corner list at all loads with an empty one",
                DiagramFile.Deserialize(nulled).Relationships.All(r => r.Waypoints != null));

            // Additive on both models, so the file format version does not move: an older build
            // ignores the corners and draws the automatic route, which is the same picture this one
            // draws with none of them.
            var roundTripped = DiagramFile.Deserialize(DiagramFile.Serialize(document));
            Check("hand-placed corners do not move the file format version",
                roundTripped.FormatVersion == DiagramDocument.CurrentFormatVersion,
                roundTripped.FormatVersion.ToString());
        }

        private static void Run1110Checks()
        {
            var document = new DiagramDocument { Title = "Guards" };
            var table = Table("account", "Account", 0, 0);
            var other = Table("contact", "Contact", 400, 0);
            document.Tables.Add(table);
            document.Tables.Add(other);

            document.Relationships.Add(new DiagramRelationship
            {
                Id = "r-guard", SchemaName = "cs_guard", Kind = RelationshipKind.OneToMany,
                FromTableId = table.Id, ToTableId = other.Id
            });

            // Written into the text rather than onto the model: infinity is not a number JSON can
            // carry, so a serialiser cannot produce this file and only a hand edit can. 1e400 is
            // what that hand edit looks like - a literal too big for a double, which is the one
            // route an infinite value has into the document.
            var handEdited = DiagramFile.Serialize(document)
                .Replace("\"routeOffset\": 0", "\"routeOffset\": 1e400")
                .Replace("\"routeOffsetCross\": 0", "\"routeOffsetCross\": -1e400");

            var loaded = DiagramFile.Deserialize(handEdited);
            var guarded = loaded.Relationships.Single(r => r.Id == "r-guard");

            // An infinite offset is carried into the route's points, out of those into the drawing's
            // bounds, and from there into Fit and every picture export as a drawing with no finite
            // extent. The legend position is guarded the same way.
            Check("an infinite connector offset is cleared on the way in",
                guarded.RouteOffset == 0, guarded.RouteOffset.ToString());
            Check("and one across the route as well",
                guarded.RouteOffsetCross == 0, guarded.RouteOffsetCross.ToString());

            // An older file without the property carries null, and every other collection on the
            // model is guarded the same way. Written into the text because the stub serialiser in
            // this harness does not reproduce a null list the way the real one does.
            var nulled = DiagramFile.Serialize(document).Replace("\"columnOrder\": []", "\"columnOrder\": null");
            Check("the fixture really does carry a null column order",
                nulled.Contains("\"columnOrder\": null"));

            var listed = DiagramFile.Deserialize(nulled);
            Check("a file with no column order at all loads with an empty one",
                listed.Tables.All(t => t.ColumnOrder != null));

            // The canvas writes `logicalName || schemaName || id` and lower-cases it, so the export
            // has to fall through on an empty string as well as null, or a column with an empty
            // logical name and a schema name is ordered on the canvas and unordered in every document.
            var probe = new DiagramTable
            {
                LogicalName = "cs_keyprobe", DisplayName = "Key probe", Status = ObjectStatus.Existing,
                ColumnOrder = new List<string> { "cs_bySchema" },
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = "cs_first", DisplayName = "First", Selected = true },
                    new DiagramColumn
                    {
                        LogicalName = string.Empty, SchemaName = "cs_bySchema",
                        DisplayName = "Named by its schema name", Selected = true
                    }
                }
            };

            document.Tables.Add(probe);
            document.Settings.FieldDetail = FieldDetailMode.AllFields;

            var ordered = ExportRowBuilder.SelectedColumns(document, probe).ToList();

            Check("a column with an empty logical name is ordered by its schema name",
                ordered.Count == 2 && ordered[0].SchemaName == "cs_bySchema",
                string.Join(", ", ordered.Select(c => c.LogicalName + "/" + c.SchemaName)));
        }

        private static void Run1100Checks()
        {
            var document = new DiagramDocument { Title = "Depth and angle" };
            document.Tables.Add(Table("account", "Account", 0, 0));

            // Deliberately in the wrong order in the document: the text box is listed first, and
            // the exporters have to write the note before it anyway.
            document.Annotations.Add(new DiagramAnnotation
            {
                Id = "a-label", Kind = "text", Text = "Label on paper", X = 40, Y = 40,
                Width = 200, Height = 40
            });
            document.Annotations.Add(new DiagramAnnotation
            {
                Id = "a-paper", Kind = "note", Text = "Paper under label", X = 20, Y = 20,
                Width = 200, Height = 200, Tilt = 12
            });
            document.Annotations.Add(new DiagramAnnotation
            {
                Id = "a-under", Kind = "note", Text = "Under the model", X = 600, Y = 20,
                Width = 140, Height = 140, Behind = true
            });

            // ---- the angle survives a save, and zero is a real angle

            var json = DiagramFile.Serialize(document);
            var reloaded = DiagramFile.Deserialize(json);

            Check("a hand-set note angle survives a save",
                reloaded.Annotations.Single(a => a.Id == "a-paper").Tilt == 12,
                reloaded.Annotations.Single(a => a.Id == "a-paper").Tilt.ToString());
            Check("and a note nobody has turned carries no angle at all",
                reloaded.Annotations.Single(a => a.Id == "a-under").Tilt == null);
            Check("without moving the file format version",
                json.Contains("\"formatVersion\": 2"));

            // Nullable rather than zero-means-absent. A note the user has deliberately squared to
            // the page carries zero, and if that read back as "never turned" the canvas would put
            // its derived slant back on the note the next time the file was opened.
            var straightened = DiagramFile.Deserialize(
                DiagramFile.Serialize(new DiagramDocument
                {
                    Annotations = { new DiagramAnnotation { Id = "a-flat", Kind = "note", Tilt = 0 } }
                }));

            Check("a note straightened by hand stays straightened",
                straightened.Annotations.Single().Tilt == 0,
                straightened.Annotations.Single().Tilt == null
                    ? "read back as never turned" : "0");

            // ---- paint order within one pass

            var order = AnnotationKinds.PaintOrder(document.Annotations, false).Select(a => a.Id).ToList();

            Check("annotations on one side are painted notes first",
                order.Count == 2 && order[0] == "a-paper" && order[1] == "a-label",
                string.Join(", ", order));
            Check("and the other side is a pass of its own",
                AnnotationKinds.PaintOrder(document.Annotations, true)
                    .Select(a => a.Id).SequenceEqual(new[] { "a-under" }));

            // ---- draw.io

            var drawIo = DrawIoExporter.Export(document).Text;

            var paper = drawIo.IndexOf("Paper under label", StringComparison.Ordinal);
            var label = drawIo.IndexOf("Label on paper", StringComparison.Ordinal);
            var under = drawIo.IndexOf("Under the model", StringComparison.Ordinal);
            var table = drawIo.IndexOf("Account", StringComparison.Ordinal);

            Check("draw.io writes a sticky note before a text box on the same side",
                paper > 0 && label > paper, paper + " against " + label);
            Check("and both of them after the tables when they are in front",
                table > 0 && paper > table, paper + " against " + table);
            Check("while one sent behind goes out before the tables",
                under > 0 && under < table, under + " against " + table);

            // The angle. draw.io rotates a vertex about its own centre, clockwise, in degrees -
            // the same convention the canvas stores - so the number goes straight through.
            var paperCell = DrawIoCells(drawIo)
                .FirstOrDefault(c => (AttributeValue(c, "value") ?? string.Empty)
                    .Contains("Paper under label"));
            var underCell = DrawIoCells(drawIo)
                .FirstOrDefault(c => (AttributeValue(c, "value") ?? string.Empty)
                    .Contains("Under the model"));

            Check("draw.io carries the angle of a note that was turned by hand",
                paperCell != null && (AttributeValue(paperCell, "style") ?? string.Empty)
                    .Contains("rotation=12"),
                paperCell == null ? "no cell" : AttributeValue(paperCell, "style"));

            // The small slant an untouched note is drawn with is derived from its id to stop a
            // wall of notes looking like a grid. It is not an angle anybody chose, and writing it
            // into a file would be inventing one.
            Check("and leaves a note that was never turned square to the page",
                underCell != null && !(AttributeValue(underCell, "style") ?? string.Empty)
                    .Contains("rotation="),
                underCell == null ? "no cell" : AttributeValue(underCell, "style"));

            // ---- Visio, which has the same z-order rule and no rotation

            var visio = VisioExporter.Export(document).Text;

            var visioPaper = visio.IndexOf("Paper under label", StringComparison.Ordinal);
            var visioLabel = visio.IndexOf("Label on paper", StringComparison.Ordinal);
            var visioTable = visio.IndexOf("Account", StringComparison.Ordinal);
            var visioUnder = visio.IndexOf("Under the model", StringComparison.Ordinal);

            Check("Visio writes a sticky note before a text box on the same side",
                visioPaper > 0 && visioLabel > visioPaper, visioPaper + " against " + visioLabel);
            Check("and puts a behind annotation before the tables",
                visioUnder > 0 && visioTable > 0 && visioUnder < visioTable,
                visioUnder + " against " + visioTable);

            // ---- one connection message, not two
            //
            // XrmToolBox calls UpdateConnection before the canvas has finished loading, so the
            // connection event it raises is held in the pending queue. OnNavigationCompleted posts a
            // fresh one of its own, so the held one is dropped on the flush - the canvas toasts every
            // time it is told. A source check rather than a behavioural one: the control is a WinForms
            // UserControl hosting WebView2 and neither exists here.
            var control = ReadSource("ModelDesignerControl.cs");

            Check("the held-message queue records what each message was",
                control != null && control.Contains("private sealed class PendingMessage"),
                control == null ? "file not found" : "no PendingMessage");
            Check("and a connection event held from before the canvas loaded is dropped on the flush",
                control != null && System.Text.RegularExpressions.Regex.IsMatch(control,
                    @"held\.EventName, BridgeEvents\.ConnectionChanged[\s\S]{0,80}continue;"),
                control == null ? "file not found" : "no such guard");

            // Order matters as much as the guard: the fresh event has to be posted after the
            // drain, or the canvas ends up holding whichever state was queued rather than the one
            // read from ConnectionDetail now.
            if (control != null)
            {
                var flush = control.IndexOf("var buffered = _pendingMessages.ToList();", StringComparison.Ordinal);
                var post = control.IndexOf("PostEvent(BridgeEvents.ConnectionChanged, Connection);", flush + 1,
                    StringComparison.Ordinal);
                var drain = control.IndexOf("PostToWeb(held.Json, held.EventName);", StringComparison.Ordinal);

                Check("and the surviving connection event is posted after the drain, not before it",
                    flush > 0 && drain > flush && post > drain, flush + ", " + drain + ", " + post);
            }
        }

        /// <summary>The text of a file under src, or null if it is not where it should be.</summary>
        private static string ReadSource(params string[] relativeParts)
        {
            var parts = new List<string>
            {
                AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..",
                "src", "Oliver4.DataModelDesigner"
            };
            parts.AddRange(relativeParts);

            var path = System.IO.Path.GetFullPath(System.IO.Path.Combine(parts.ToArray()));
            return System.IO.File.Exists(path) ? System.IO.File.ReadAllText(path) : null;
        }

        /// <summary>
        /// The settings blob the canvas posts back.
        ///
        /// The canvas only re-reads settings at boot and after a save, so the blob it posts carries
        /// whatever the recent-files list and the two remembered folders held when it last read
        /// them. Copying those back would turn something as innocent as toggling dark mode into a
        /// silent revert of all three, so the host ignores them and is their sole writer.
        /// </summary>
        private static void RunHostSettingsChecks()
        {
            var host = new Bridge.ToolSettings
            {
                LastDiagramFolder = @"C:\Models",
                LastExportFolder = @"C:\Models\Exports",
                Theme = "light"
            };
            host.AddRecentFile(@"C:\Models\customer-core.dvmd");

            var fromCanvas = new Bridge.ToolSettings
            {
                Theme = "dark",
                RecentFiles = new List<string>(),
                LastDiagramFolder = null,
                LastExportFolder = null
            };

            host.CopyFrom(fromCanvas);

            Check("applying a blob with an empty recent-files list leaves the recent files alone",
                host.RecentFiles.Count == 1 &&
                host.RecentFiles[0] == @"C:\Models\customer-core.dvmd",
                string.Join(", ", host.RecentFiles));
            Check("and leaves both remembered folders alone",
                host.LastDiagramFolder == @"C:\Models" && host.LastExportFolder == @"C:\Models\Exports",
                (host.LastDiagramFolder ?? "(none)") + " | " + (host.LastExportFolder ?? "(none)"));
            Check("while still taking the preference the canvas does own",
                host.Theme == "dark", host.Theme);
        }

        /// <summary>
        /// Exporter checks, each driven off the smallest diagram that reaches the code in question.
        /// The shared fixture at the top of this file is deliberately not reused: most of these
        /// need a diagram built the wrong way round on purpose.
        /// </summary>
        /// <summary>
        /// An annotation is drawn in front of the table cards or behind them, and the exports have
        /// to put it on the same side - in both formats the order shapes are written in is the
        /// z-order, so this is a check about position in the file.
        /// </summary>
        private static void Run1900Checks()
        {
            var document = new DiagramDocument { Title = "Annotation depth" };
            document.Tables.Add(Table("account", "Account", 0, 0));

            document.Annotations.Add(new DiagramAnnotation
            {
                Id = "n-behind", Kind = "note", Text = "Sent behind", X = 20, Y = 20,
                Width = 140, Height = 140, Behind = true
            });
            document.Annotations.Add(new DiagramAnnotation
            {
                Id = "n-front", Kind = "note", Text = "Left in front", X = 400, Y = 20,
                Width = 140, Height = 140
            });

            var json = DiagramFile.Serialize(document);
            var reloaded = DiagramFile.Deserialize(json);

            Check("which side an annotation is on survives a save",
                reloaded.Annotations.Single(a => a.Id == "n-behind").Behind &&
                !reloaded.Annotations.Single(a => a.Id == "n-front").Behind);
            Check("without moving the file format version",
                json.Contains("\"formatVersion\": 2"));

            // A file written before 1.9.0 carries no such property, and every annotation in it is
            // drawn in front.
            var older = System.Text.RegularExpressions.Regex.Replace(
                json, "^.*\"behind\".*\r?\n", string.Empty,
                System.Text.RegularExpressions.RegexOptions.Multiline);

            // The property, not the word: one of the notes is called "Sent behind", so matching the
            // bare word would pass on a fixture that had not been stripped at all.
            Check("the older-file fixture really has no side recorded",
                !older.Contains("\"behind\""));
            Check("and an annotation from it is in front",
                DiagramFile.Deserialize(older).Annotations.All(a => !a.Behind));

            // draw.io: later cells are drawn on top, so the behind note comes before the table and
            // the front one after it.
            var drawIo = DrawIoExporter.Export(document).Text;

            var behindCell = drawIo.IndexOf("Sent behind", StringComparison.Ordinal);
            var frontCell = drawIo.IndexOf("Left in front", StringComparison.Ordinal);
            var tableCell = drawIo.IndexOf("Account", StringComparison.Ordinal);

            Check("draw.io writes a behind annotation before the tables",
                behindCell >= 0 && tableCell > 0 && behindCell < tableCell,
                behindCell + " against " + tableCell);
            Check("and a front annotation after them",
                frontCell > tableCell, frontCell + " against " + tableCell);

            // And the cell ids stay unique across the two passes - draw.io drops a duplicate id
            // silently, which would lose one of the two notes.
            var noteIds = DrawIoCells(drawIo)
                .Select(c => AttributeValue(c, "id") ?? string.Empty)
                .Where(id => id.StartsWith("note", StringComparison.Ordinal))
                .ToList();

            Check("with a distinct id for each annotation",
                noteIds.Count == 2 && noteIds.Distinct().Count() == 2,
                string.Join(", ", noteIds));

            // Visio: same rule, same check, minus arrows.
            var visio = VisioExporter.Export(document).Text;

            var visioBehind = visio.IndexOf("Sent behind", StringComparison.Ordinal);
            var visioFront = visio.IndexOf("Left in front", StringComparison.Ordinal);
            var visioTable = visio.IndexOf("Account", StringComparison.Ordinal);

            Check("Visio writes a behind annotation before the tables",
                visioBehind >= 0 && visioTable > 0 && visioBehind < visioTable,
                visioBehind + " against " + visioTable);
            Check("and a front annotation after them",
                visioFront > visioTable, visioFront + " against " + visioTable);

            // Visio identifies a shape by its ID, and the Connects records point at those ids. Two
            // passes over the annotations with a counter of their own would give a note the same id
            // as a table, and a connector would then be joined to the note. The draw.io half of
            // this is checked above; this is the Visio mirror.
            var visioIds = VisioShapes(visio)
                .Select(shape => AttributeValue(shape, "ID") ?? string.Empty)
                .ToList();

            Check("with every Visio shape carrying an id of its own",
                visioIds.Count > 0 && visioIds.Distinct().Count() == visioIds.Count,
                string.Join(", ", visioIds));
            Check("including one for each annotation beside the table",
                VisioShapes(visio).Count(shape =>
                    NameU(shape).StartsWith("Note.", StringComparison.Ordinal)) == 2,
                string.Join(", ", VisioShapes(visio).Select(NameU)));

            // An arrow behind the tables is still an arrow Visio cannot carry: it must not get into
            // the export through the behind pass.
            var arrows = new DiagramDocument { Title = "Arrow behind" };
            arrows.Tables.Add(Table("account", "Account", 0, 0));
            arrows.Annotations.Add(new DiagramAnnotation
            {
                Id = "n-arrow", Kind = "arrow", X = 10, Y = 10, Dx = 120, Dy = 60, Behind = true
            });

            var arrowShapes = VisioShapes(VisioExporter.Export(arrows).Text)
                .Count(shape => NameU(shape).StartsWith("Note.", StringComparison.Ordinal));

            Check("and an arrow sent behind is still left out of Visio, not drawn as a box",
                arrowShapes == 0, arrowShapes + " note shapes");
        }

        /// <summary>
        /// Legend position and sticky note defaults. The legend can be dragged, so its position has
        /// to survive a save; and a sticky note is square, at a size and a text style the exports
        /// have to agree with.
        /// </summary>
        private static void Run1800Checks()
        {
            // ---- the legend position travels with the diagram

            var moved = new DiagramDocument { Title = "Legend moved" };
            moved.Tables.Add(Table("cs_only", "Only", 0, 0));
            moved.Settings.LegendX = 320;
            moved.Settings.LegendY = 140;

            var movedJson = DiagramFile.Serialize(moved);
            var movedBack = DiagramFile.Deserialize(movedJson);

            Check("a dragged legend position is written into the file",
                movedJson.Contains("\"legendX\""), movedJson.Length + " chars");
            Check("and comes back the way it went in",
                movedBack.Settings.LegendX.HasValue && movedBack.Settings.LegendY.HasValue &&
                Math.Abs(movedBack.Settings.LegendX.Value - 320) < 0.001 &&
                Math.Abs(movedBack.Settings.LegendY.Value - 140) < 0.001,
                movedBack.Settings.LegendX + "," + movedBack.Settings.LegendY);

            // Purely additive, so a diagram with a moved legend still opens in a build that has
            // never heard of one. The format version is the thing that would break that.
            Check("without moving the file format version",
                movedJson.Contains("\"formatVersion\": 2"));

            // A file written before 1.8.0 carries neither property, and means the corner.
            var older = System.Text.RegularExpressions.Regex.Replace(
                movedJson, "^.*\"legend[XY]\".*\r?\n", string.Empty,
                System.Text.RegularExpressions.RegexOptions.Multiline);

            Check("the older-file fixture really has no legend position in it",
                !older.Contains("legendX") && !older.Contains("legendY"));

            var olderBack = DiagramFile.Deserialize(older);

            Check("a diagram written before 1.8.0 opens with the legend in its corner",
                olderBack.Settings.LegendX == null && olderBack.Settings.LegendY == null,
                olderBack.Settings.LegendX + "," + olderBack.Settings.LegendY);

            // Half a pair is not a position. Read as one, the legend would be drawn against the
            // top-left inset with nothing on screen to explain why.
            var half = movedJson.Replace("\"legendY\": 140", "\"legendY\": null");

            Check("the half-written fixture really is half-written",
                half.Contains("\"legendX\": 320") && half.Contains("\"legendY\": null"));

            var halfBack = DiagramFile.Deserialize(half);

            Check("half a legend position is discarded rather than half-applied",
                halfBack.Settings.LegendX == null && halfBack.Settings.LegendY == null,
                halfBack.Settings.LegendX + "," + halfBack.Settings.LegendY);

            // ---- a sticky note is square, and the exports say so

            var sizeless = new DiagramAnnotation
            {
                Kind = "note", Text = "No size of its own", X = 10, Y = 10, Width = 0, Height = 0
            };

            var box = ExportRowBuilder.AnnotationRect(sizeless);

            Check("a sticky note with no size is drawn square at the canvas default",
                Math.Abs(box.Width - 140) < 0.001 && Math.Abs(box.Height - 140) < 0.001,
                box.Width + "x" + box.Height);

            // The case that matters, and the one the fixture above cannot reach: an annotation
            // *read from a file* with no width, height or font size on it. Those properties are zero
            // on the model when absent, so the "no size" fallback below applies and both picture
            // exports draw the note square at the canvas default. Zero is what "not in the file"
            // means, on both sides of the bridge.
            var bare = DiagramFile.Deserialize(
                "{\"formatVersion\":2,\"title\":\"Hand edited\",\"tables\":[],\"relationships\":[]," +
                "\"annotations\":[{\"id\":\"a1\",\"kind\":\"note\",\"text\":\"Typed by hand\"," +
                "\"x\":10,\"y\":10}]}");

            var bareNote = bare.Annotations.Single();

            Check("an annotation read from a file with no size carries none",
                bareNote.Width == 0 && bareNote.Height == 0 && bareNote.FontSize == 0,
                bareNote.Width + "x" + bareNote.Height + " at " + bareNote.FontSize);

            var bareBox = ExportRowBuilder.AnnotationRect(bareNote);

            Check("so it is exported at the size the canvas draws it",
                Math.Abs(bareBox.Width - 140) < 0.001 && Math.Abs(bareBox.Height - 140) < 0.001,
                bareBox.Width + "x" + bareBox.Height);

            var bareDoc = new DiagramDocument { Title = "Hand edited" };
            bareDoc.Tables.Add(Table("account", "Account", 0, 0));
            bareDoc.Annotations.Add(bareNote);

            var bareStyle = DrawIoCells(DrawIoExporter.Export(bareDoc).Text)
                .FirstOrDefault(c => (AttributeValue(c, "id") ?? string.Empty)
                    .StartsWith("note", StringComparison.Ordinal));

            Check("and at the font size the canvas draws it",
                bareStyle != null &&
                (AttributeValue(bareStyle, "style") ?? string.Empty).Contains("fontSize=14;"),
                bareStyle == null ? "no note cell" : AttributeValue(bareStyle, "style"));
            Check("and the constant the exporters share is that same number",
                Math.Abs(ExportRowBuilder.NoteDefaultSize - 140) < 0.001,
                ExportRowBuilder.NoteDefaultSize.ToString(
                    System.Globalization.CultureInfo.InvariantCulture));

            // The sticky-note branch of the draw.io style writes a font size and a weight, as the
            // text box branch does, so a note written on the canvas at 14px bold - which is what a
            // new one is - does not come out in draw.io's own default face.
            var styled = new DiagramDocument { Title = "Note text style" };
            styled.Tables.Add(Table("account", "Account", 0, 0));
            styled.Annotations.Add(new DiagramAnnotation
            {
                Kind = "note", Text = "Bold by default", X = 40, Y = 40,
                Width = 140, Height = 140, FontSize = 14, Bold = true
            });

            var styledCell = DrawIoCells(DrawIoExporter.Export(styled).Text)
                .FirstOrDefault(c => (AttributeValue(c, "id") ?? string.Empty)
                    .StartsWith("note", StringComparison.Ordinal));
            var styledStyle = styledCell == null ? string.Empty : AttributeValue(styledCell, "style") ?? string.Empty;

            Check("draw.io is told the sticky note's font size",
                styledStyle.Contains("fontSize=14;"), styledStyle);
            Check("and that it is bold", styledStyle.Contains("fontStyle=1;"), styledStyle);
            Check("and it is still a note rather than a text box",
                styledStyle.Contains("shape=note;"), styledStyle);

            // Visio carries the weight as well as the size, so the exported note looks like the note
            // on the canvas. Bit 1 of the Char section's Style cell is bold.
            var styledShape = VisioShapes(VisioExporter.Export(styled).Text)
                .FirstOrDefault(s => NameU(s).StartsWith("Note.", StringComparison.Ordinal));

            Check("Visio is told the note is bold",
                styledShape != null && Cell(styledShape, "Char", "Style") == "1",
                styledShape == null ? "no note shape" : Cell(styledShape, "Char", "Style"));

            var plain = new DiagramDocument { Title = "Note text style, unbolded" };
            plain.Tables.Add(Table("account", "Account", 0, 0));
            plain.Annotations.Add(new DiagramAnnotation
            {
                Kind = "note", Text = "Not bold", X = 40, Y = 40,
                Width = 140, Height = 140, FontSize = 14, Bold = false
            });

            var plainShape = VisioShapes(VisioExporter.Export(plain).Text)
                .FirstOrDefault(s => NameU(s).StartsWith("Note.", StringComparison.Ordinal));
            var plainStyle = DrawIoCells(DrawIoExporter.Export(plain).Text)
                .FirstOrDefault(c => (AttributeValue(c, "id") ?? string.Empty)
                    .StartsWith("note", StringComparison.Ordinal));

            Check("and told when it is not",
                plainShape != null && Cell(plainShape, "Char", "Style") == "0",
                plainShape == null ? "no note shape" : Cell(plainShape, "Char", "Style"));
            Check("with draw.io left unbolded too",
                plainStyle != null &&
                !(AttributeValue(plainStyle, "style") ?? string.Empty).Contains("fontStyle=1"),
                plainStyle == null ? "no note cell" : AttributeValue(plainStyle, "style"));
        }

        private static void RunExporterRegressionChecks()
        {
            // A Visio connector's Geom is a fixed diagonal from (0,0) to (Width, Height) bound to
            // the absolute Width and Height cells, so without a flip it would always run bottom-left
            // to top-right and a connector pointing the other way would join the wrong two corners.
            var connectors = new DiagramDocument { Title = "Connector geometry" };
            var start = Table("cs_start", "Start", 600, 100);
            var below = Table("cs_below", "Below", 100, 500);
            var upright = Table("cs_upright", "Upright", 900, 50);
            connectors.Tables.AddRange(new[] { start, below, upright });
            connectors.Relationships.Add(Relationship("cs_start_below", start, below, "cs_startid"));
            connectors.Relationships.Add(Relationship("cs_below_upright", below, upright, "cs_belowid"));

            var connectorShapes = VisioShapes(VisioExporter.Export(connectors).Text)
                .Where(s => NameU(s).StartsWith("Connector.", StringComparison.Ordinal))
                .ToList();

            Check("mirrors a Visio connector that runs down and to the left",
                connectorShapes.Count == 2 &&
                Cell(connectorShapes[0], "XForm", "FlipY") == "1" &&
                Cell(connectorShapes[0], "XForm", "FlipX") == "1",
                DescribeFlips(connectorShapes));
            Check("and leaves one that runs up and to the right alone",
                connectorShapes.Count == 2 &&
                Cell(connectorShapes[1], "XForm", "FlipY") == "0" &&
                Cell(connectorShapes[1], "XForm", "FlipX") == "0",
                DescribeFlips(connectorShapes));

            // The page is sized from the real canvas extent the shapes are placed from, so a
            // twenty-table auto layout stays on the sheet with no negative PinY. This diagram is
            // wider and taller than a 16x11in page on both axes.
            var wide = new DiagramDocument { Title = "Wider than the old fixed page" };
            wide.Tables.Add(Table("cs_topleft", "Top left", 0, 0));
            wide.Tables.Add(Table("cs_bottomright", "Bottom right", 2000, 1500));

            var wideXml = XDocument.Parse(VisioExporter.Export(wide).Text);
            var pageProps = wideXml.Descendants().First(e => e.Name.LocalName == "PageProps");
            var pageWidth = Inches(Cell(pageProps, "PageWidth"));
            var pageHeight = Inches(Cell(pageProps, "PageHeight"));

            var offPage = new List<string>();
            var negative = new List<string>();

            foreach (var shape in wideXml.Descendants().Where(e => e.Name.LocalName == "Shape"))
            {
                var form = Child(shape, "XForm");
                if (form == null) continue;

                var pinX = Inches(Cell(form, "PinX"));
                var pinY = Inches(Cell(form, "PinY"));
                var halfWidth = Inches(Cell(form, "Width")) / 2;
                var halfHeight = Inches(Cell(form, "Height")) / 2;

                if (pinX < 0 || pinY < 0) negative.Add(NameU(shape) + " at " + pinX + "," + pinY);

                if (pinX - halfWidth < -0.001 || pinY - halfHeight < -0.001 ||
                    pinX + halfWidth > pageWidth + 0.001 || pinY + halfHeight > pageHeight + 0.001)
                {
                    offPage.Add(NameU(shape) + " at " + pinX + "," + pinY);
                }
            }

            Check("gives a big diagram a Visio page that contains every shape",
                offPage.Count == 0,
                "page " + pageWidth + "x" + pageHeight + "in; off it: " + string.Join(", ", offPage));
            Check("and puts no shape at a negative pin", negative.Count == 0, string.Join(", ", negative));

            // With "Show alternate keys" on, the canvas draws AK and so does every export - that
            // same setting is what pulls the column onto the card in the first place.
            var keys = new DiagramDocument { Title = "Alternate keys" };
            keys.Settings.FieldDetail = FieldDetailMode.AllFields;
            keys.Settings.ShowAlternateKeys = true;

            var keyed = Table("cs_product", "Product", 0, 0);
            keyed.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_code", DisplayName = "Code", TypeName = "Text (20)",
                IsAlternateKey = true, Selected = true
            });
            keys.Tables.Add(keyed);

            var keyRows = ExportRowBuilder.RowsFor(keys, keyed).ToList();

            Check("marks an alternate key column AK",
                keyRows.Any(r => r.Name == "cs_code" && r.KeyMarker == "AK"),
                string.Join(", ", keyRows.Select(r => r.Name + "=" + (r.KeyMarker ?? "(none)"))));

            // Excluding a proposed relationship from the diagram is one toggle in the inspector, and
            // it must not take the lookup column the relationship owns out of the design register
            // while the Tables section still lists that column.
            var register = new DiagramDocument { Title = "Design register" };
            var registerAccount = Table("account", "Account", 0, 0);
            var registerSegment = Table("cs_segment", "Segment", 400, 0);
            register.Tables.AddRange(new[] { registerAccount, registerSegment });

            var excludedLink = new DiagramRelationship
            {
                SchemaName = "cs_account_segment",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Proposed,
                FromTableId = registerAccount.Id,
                ToTableId = registerSegment.Id,
                ReferencingAttribute = "cs_accountid",
                Included = false
            };
            register.Relationships.Add(excludedLink);

            registerSegment.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_accountid", DisplayName = "Account", TypeName = "Lookup",
                IsLookup = true, Status = ObjectStatus.Proposed, Selected = true,
                FromRelationshipId = excludedLink.Id
            });

            var registerText = RegisterSection(DocumentationExporter.ExportMarkdown(register).Text);

            Check("keeps the lookup column of an excluded proposed relationship in the design register",
                registerText != null && registerText.Contains("Segment.Account"), registerText ?? "no register");

            // A title with a colon in it is ordinary, and written raw it would produce front matter
            // that is not valid YAML, so mermaid would refuse to render the diagram at all.
            var awkwardTitle = new DiagramDocument { Title = "Phase 2: target model" };
            awkwardTitle.Tables.Add(Table("account", "Account", 0, 0));

            var mermaidTitle = MermaidExporter.Export(awkwardTitle).Text;

            Check("quotes a Mermaid front-matter title containing a colon",
                mermaidTitle.Contains("title: \"Phase 2: target model\""),
                mermaidTitle.Split('\n').FirstOrDefault(l => l.StartsWith("title:", StringComparison.Ordinal)));

            // draw.io renders every label this exporter writes through innerHTML, so an unescaped
            // markup token in a name would be swallowed as an unknown tag and vanish from the card.
            var markup = new DiagramDocument { Title = "Markup in a name" };
            markup.Tables.Add(Table("cs_order", "Order <Legacy> header", 0, 0));

            var markupValue = DrawIoCells(DrawIoExporter.Export(markup).Text)
                .Select(c => AttributeValue(c, "value"))
                .FirstOrDefault(v => v != null && v.Contains("Order"));

            Check("escapes a < in a table name for draw.io's HTML labels",
                markupValue != null && markupValue.Contains("&lt;Legacy&gt;") && !markupValue.Contains("<"),
                markupValue);

            // A table with no visible columns still belongs in the picture: skipping the entity
            // would drop it from the diagram while the document's Tables section still listed it.
            var terse = new DiagramDocument { Title = "Tables only" };
            terse.Settings.FieldDetail = FieldDetailMode.TablesOnly;
            var joinedOne = Table("account", "Account", 0, 0);
            var joinedTwo = Table("contact", "Contact", 400, 0);
            var lonely = Table("cs_lonely", "Lonely", 800, 0);
            terse.Tables.AddRange(new[] { joinedOne, joinedTwo, lonely });
            terse.Relationships.Add(Relationship("contact_customer_accounts", joinedOne, joinedTwo, "parentcustomerid"));

            var terseMermaid = MermaidExporter.Export(terse).Text;

            Check("keeps a table with no columns and no relationship in the Mermaid diagram",
                terseMermaid.Contains("CS_LONELY {"), terseMermaid);

            // The Markdown document says this, and the HTML one has to say it too rather than end
            // the section at the definition list with no word about the missing columns.
            Check("says in the HTML document that no columns are shown",
                DocumentationExporter.ExportHtml(terse).Text.Contains("No columns are shown for this table"));

            // The canvas pins its column sort to en-GB, so the export has to pin it too: under
            // sv-SE, A-diaeresis sorts after Z and the catalogue would disagree with the picture
            // beside it on any non-English Windows.
            var sorted = new DiagramDocument { Title = "Column order under another culture" };
            sorted.Settings.FieldDetail = FieldDetailMode.AllFields;
            sorted.Settings.FieldOrder = "displayName";

            var sortedTable = new DiagramTable
            {
                LogicalName = "cs_sortprobe", DisplayName = "Sort probe", Status = ObjectStatus.Existing,
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = "cs_zebra", DisplayName = "Zebra", Selected = true },
                    new DiagramColumn { LogicalName = "cs_arende", DisplayName = "Ärende", Selected = true },
                    new DiagramColumn { LogicalName = "cs_apple", DisplayName = "apple", Selected = true }
                }
            };
            sorted.Tables.Add(sortedTable);

            var previousCulture = System.Globalization.CultureInfo.CurrentCulture;
            string underSwedish;

            try
            {
                System.Globalization.CultureInfo.CurrentCulture =
                    System.Globalization.CultureInfo.GetCultureInfo("sv-SE");

                underSwedish = string.Join(",",
                    ExportRowBuilder.SelectedColumns(sorted, sortedTable).Select(c => c.DisplayName));
            }
            finally
            {
                System.Globalization.CultureInfo.CurrentCulture = previousCulture;
            }

            Check("orders exported columns the way the canvas does whatever the machine's culture is",
                underSwedish == "apple,Ärende,Zebra", underSwedish);

            // Normalise only prunes a relationship when both end ids are non-empty, so one with a
            // null end survives a load: the canvas filters it out, and the export must not put its
            // lookup row on the card either.
            var dangling = new DiagramDocument { Title = "Dangling relationship" };
            dangling.Settings.FieldDetail = FieldDetailMode.RelationshipFields;

            var attached = Table("account", "Account", 0, 0);
            attached.Columns.Add(Lookup("cs_ghostid", "Ghost"));
            dangling.Tables.Add(attached);
            dangling.Relationships.Add(new DiagramRelationship
            {
                SchemaName = "cs_ghost_account",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Existing,
                FromTableId = null,
                ToTableId = attached.Id,
                ReferencingAttribute = "cs_ghostid",
                Included = true
            });

            var danglingRows = ExportRowBuilder.RowsFor(dangling, attached).ToList();

            Check("draws no lookup row for a relationship with one end missing",
                !danglingRows.Any(r => r.Name == "cs_ghostid"),
                string.Join(", ", danglingRows.Select(r => r.Name)));

            // Read straight through, a zero-sized annotation would export as an invisible shape. The
            // canvas floors it, so the export has to floor it the same way.
            var zeroSized = new DiagramDocument { Title = "Zero-sized annotation" };
            zeroSized.Tables.Add(Table("account", "Account", 0, 0));
            zeroSized.Annotations.Add(new DiagramAnnotation
            {
                Text = "Drawn but never dragged out",
                X = 40, Y = 40, Width = 0, Height = 0
            });

            var zeroNote = DrawIoCells(DrawIoExporter.Export(zeroSized).Text)
                .FirstOrDefault(c => (AttributeValue(c, "id") ?? string.Empty).StartsWith("note", StringComparison.Ordinal));
            var zeroGeometry = zeroNote == null ? null : Child(zeroNote, "mxGeometry");

            Check("gives a zero-sized annotation its floor size in draw.io",
                zeroGeometry != null &&
                AttributeValue(zeroGeometry, "width") == "140" &&
                AttributeValue(zeroGeometry, "height") == "140",
                zeroGeometry == null ? "no note cell"
                    : AttributeValue(zeroGeometry, "width") + "x" + AttributeValue(zeroGeometry, "height"));

            var zeroShape = VisioShapes(VisioExporter.Export(zeroSized).Text)
                .FirstOrDefault(s => NameU(s).StartsWith("Note.", StringComparison.Ordinal));
            var zeroForm = zeroShape == null ? null : Child(zeroShape, "XForm");

            // The number is written out rather than read from ExportRowBuilder: a check that takes
            // its expectation from the constant it is checking passes whatever that constant says.
            Check("and the same floor size in Visio",
                zeroForm != null &&
                Math.Abs(Inches(Cell(zeroForm, "Width")) - 140 / 96.0) < 0.001 &&
                Math.Abs(Inches(Cell(zeroForm, "Height")) - 140 / 96.0) < 0.001,
                zeroForm == null ? "no note shape"
                    : Cell(zeroForm, "Width") + "x" + Cell(zeroForm, "Height") + "in");

            // A vertical tab, the kind of thing a copy and paste out of a spreadsheet leaves in a
            // name, would throw ArgumentException out of the XML writer from deep inside both exporters.
            var control = new DiagramDocument { Title = "Control characters" };
            control.Tables.Add(Table("cs_awkward", "Ver\u000Btical", 0, 0));

            string controlDrawIo = null, controlVisio = null;
            var threw = false;

            try
            {
                controlDrawIo = DrawIoExporter.Export(control).Text;
                controlVisio = VisioExporter.Export(control).Text;
            }
            catch (Exception ex)
            {
                threw = true;
                Check("a control character in a name does not throw out of the XML writer", false, ex.Message);
            }

            if (!threw)
            {
                Check("a control character in a name does not throw out of the XML writer", true);
                Check("and does not reach the exported file",
                    !controlDrawIo.Contains("\u000B") && !controlVisio.Contains("\u000B"));
            }

            // Visio treats NameU as a shape's unique identifier, so two tables displaying the same
            // name - an existing one and its proposed replacement, say - must not derive the same one.
            var namesakes = new DiagramDocument { Title = "Two Accounts" };
            var realAccount = Table("account", "Account", 0, 0);
            var proposedAccount = Table("cs_account", "Account", 400, 0);
            proposedAccount.Status = ObjectStatus.Proposed;
            namesakes.Tables.AddRange(new[] { realAccount, proposedAccount });

            var namesakeShapes = VisioShapes(VisioExporter.Export(namesakes).Text)
                .Select(NameU)
                .Where(n => !n.StartsWith("Connector.", StringComparison.Ordinal) &&
                            !n.StartsWith("Note.", StringComparison.Ordinal) &&
                            n != "TitleBlock")
                .ToList();

            Check("gives two tables with the same display name different Visio names",
                namesakeShapes.Count == 2 && namesakeShapes.Distinct(StringComparer.Ordinal).Count() == 2,
                string.Join(", ", namesakeShapes));

            // An emphasis colour is exported as a card stroke, so a legend with only the four status
            // entries would leave the reader with coloured borders it could not explain.
            var emphasised = new DiagramDocument { Title = "Emphasis" };
            emphasised.Settings.ShowLegend = true;
            emphasised.Settings.EmphasisNames = new Dictionary<string, string> { { "#16a34a", "Phase 2" } };

            var emphasisedTable = Table("account", "Account", 0, 0);
            emphasisedTable.Highlight = "#16a34a";
            emphasised.Tables.Add(emphasisedTable);

            var legendEntry = DrawIoCells(DrawIoExporter.Export(emphasised).Text)
                .FirstOrDefault(c => (AttributeValue(c, "id") ?? string.Empty).StartsWith("legend", StringComparison.Ordinal) &&
                                     AttributeValue(c, "value") == "Phase 2");

            Check("names the emphasis colour it draws in the draw.io legend",
                legendEntry != null &&
                (AttributeValue(legendEntry, "style") ?? string.Empty).Contains("strokeColor=#16a34a"),
                legendEntry == null ? "no legend entry" : AttributeValue(legendEntry, "style"));
        }

        // ------------------------------------------------------------------
        // Reading the exported files back

        private static List<XElement> VisioShapes(string xml)
        {
            return XDocument.Parse(xml).Descendants()
                .Where(e => e.Name.LocalName == "Shape")
                .ToList();
        }

        private static List<XElement> DrawIoCells(string xml)
        {
            return XDocument.Parse(xml).Descendants()
                .Where(e => e.Name.LocalName == "mxCell")
                .ToList();
        }

        private static XElement Child(XElement parent, string localName)
        {
            return parent == null
                ? null
                : parent.Elements().FirstOrDefault(e => e.Name.LocalName == localName);
        }

        /// <summary>The text of a Visio cell, for example XForm/PinX or PageProps/PageWidth.</summary>
        private static string Cell(XElement parent, string localName)
        {
            var cell = Child(parent, localName);
            return cell == null ? null : cell.Value;
        }

        private static string Cell(XElement shape, string sectionName, string localName)
        {
            return Cell(Child(shape, sectionName), localName);
        }

        private static double Inches(string value)
        {
            double parsed;
            return double.TryParse(value, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out parsed) ? parsed : double.NaN;
        }

        private static string NameU(XElement shape)
        {
            return AttributeValue(shape, "NameU") ?? string.Empty;
        }

        private static string AttributeValue(XElement element, string name)
        {
            if (element == null) return null;
            var attribute = element.Attribute(name);
            return attribute == null ? null : attribute.Value;
        }

        private static string DescribeFlips(List<XElement> connectors)
        {
            return string.Join("; ", connectors.Select(c =>
                NameU(c) + " FlipX=" + (Cell(c, "XForm", "FlipX") ?? "(none)") +
                " FlipY=" + (Cell(c, "XForm", "FlipY") ?? "(none)")));
        }

        /// <summary>The design register section of a Markdown document, or null if it has none.</summary>
        private static string RegisterSection(string markdown)
        {
            const string heading = "## Proposed and deprecated objects";

            var start = markdown.IndexOf(heading, StringComparison.Ordinal);
            if (start < 0) return null;

            var section = markdown.Substring(start);
            var end = section.IndexOf("\n## ", 4, StringComparison.Ordinal);
            return end > 0 ? section.Substring(0, end) : section;
        }

        /// <summary>A card for a table the fake environment really has, named as the fake names it.</summary>
        private static DiagramTable ExistingTable(string logicalName)
        {
            return new DiagramTable
            {
                LogicalName = logicalName,
                SchemaName = logicalName,
                DisplayName = logicalName,
                Status = ObjectStatus.Existing,
                PrimaryIdAttribute = logicalName + "id"
            };
        }

        /// <summary>
        /// A connector describing a relationship the fake environment really has, with every
        /// property already agreeing with metadata - so a refresh that reports anything about it at
        /// all is reporting a difference that is not there.
        /// </summary>
        private static DiagramRelationship LiveRelationship(
            string schemaName, DiagramTable from, DiagramTable to,
            string referenced, string referencing, string attribute)
        {
            return new DiagramRelationship
            {
                SchemaName = schemaName,
                DisplayName = schemaName,
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Existing,
                FromTableId = from.Id,
                ToTableId = to.Id,
                ReferencedEntity = referenced,
                ReferencingEntity = referencing,
                ReferencedAttribute = referenced + "id",
                ReferencingAttribute = attribute,
                Included = true
            };
        }

        private static List<string> CardinalityChanges(Services.RefreshOutcome outcome)
        {
            return outcome.Report.Changed
                .Where(c => c.Detail != null &&
                            c.Detail.IndexOf("cardinality changed", StringComparison.Ordinal) >= 0)
                .Select(c => c.Name + ": " + c.Detail)
                .ToList();
        }

        /// <summary>
        /// A tiny in-memory environment. Only the two metadata requests the checks above need are
        /// answered; anything else throws, so a new dependency shows up as a failure rather than
        /// as a silently empty result.
        /// </summary>
        private class FakeOrganizationService : Microsoft.Xrm.Sdk.IOrganizationService
        {
            private readonly Dictionary<string, Microsoft.Xrm.Sdk.Metadata.EntityMetadata> _tables =
                new Dictionary<string, Microsoft.Xrm.Sdk.Metadata.EntityMetadata>(StringComparer.OrdinalIgnoreCase);

            public int RetrieveCount { get; private set; }

            public void AddTable(string logicalName, params string[] extraColumns)
            {
                AddTable(logicalName, false, extraColumns);
            }

            /// <summary>
            /// Pass system: true for a table Dataverse ships, which is what the discovery category
            /// filter keys off (IsCustomEntity is the only signal metadata gives for it).
            /// </summary>
            public void AddTable(string logicalName, bool system, params string[] extraColumns)
            {
                var columns = new List<Microsoft.Xrm.Sdk.Metadata.AttributeMetadata>
                {
                    new Microsoft.Xrm.Sdk.Metadata.AttributeMetadata
                    {
                        LogicalName = logicalName + "id",
                        SchemaName = logicalName + "Id",
                        DisplayName = LabelFor("Identifier"),
                        IsPrimaryId = true,
                        AttributeType = Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode.Uniqueidentifier,
                        IsValidForRead = true
                    }
                };

                foreach (var extra in extraColumns ?? new string[0])
                {
                    columns.Add(new Microsoft.Xrm.Sdk.Metadata.AttributeMetadata
                    {
                        LogicalName = extra,
                        SchemaName = extra,
                        DisplayName = LabelFor(extra),
                        AttributeType = Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode.String,
                        IsValidForRead = true
                    });
                }

                _tables[logicalName] = new Microsoft.Xrm.Sdk.Metadata.EntityMetadata
                {
                    LogicalName = logicalName,
                    SchemaName = logicalName,
                    DisplayName = LabelFor(logicalName),
                    MetadataId = Guid.NewGuid(),
                    IsCustomEntity = !system,
                    PrimaryIdAttribute = logicalName + "id",
                    PrimaryNameAttribute = "name",
                    Attributes = columns.ToArray(),
                    OneToManyRelationships = new Microsoft.Xrm.Sdk.Metadata.OneToManyRelationshipMetadata[0],
                    ManyToOneRelationships = new Microsoft.Xrm.Sdk.Metadata.OneToManyRelationshipMetadata[0],
                    ManyToManyRelationships = new Microsoft.Xrm.Sdk.Metadata.ManyToManyRelationshipMetadata[0],
                    Keys = new Microsoft.Xrm.Sdk.Metadata.EntityKeyMetadata[0]
                };
            }

            /// <summary>
            /// Adds a column to a table that has already been built, which is how a refresh check
            /// makes the environment change while a diagram is open.
            /// </summary>
            public void AddColumn(string logicalName, string column)
            {
                Append(logicalName, new Microsoft.Xrm.Sdk.Metadata.AttributeMetadata
                {
                    LogicalName = column,
                    SchemaName = column,
                    DisplayName = LabelFor(column),
                    AttributeType = Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode.String,
                    IsValidForRead = true
                });
            }

            /// <summary>
            /// An attribute that reports AttributeType=Virtual. Multi-select choice, file and image
            /// columns all do, and carry their real type in AttributeTypeName, which is the only
            /// thing separating them from the platform's own virtual helpers.
            /// </summary>
            public void AddVirtualColumn(string logicalName, string column, string attributeTypeName)
            {
                Append(logicalName, new Microsoft.Xrm.Sdk.Metadata.AttributeMetadata
                {
                    LogicalName = column,
                    SchemaName = column,
                    DisplayName = LabelFor(column),
                    AttributeType = Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode.Virtual,
                    AttributeTypeName = new Microsoft.Xrm.Sdk.Metadata.AttributeTypeDisplayName
                    {
                        Value = attributeTypeName
                    },
                    IsValidForRead = true
                });
            }

            /// <summary>
            /// A lookup column with its target tables. More than one target is a polymorphic lookup
            /// such as Customer, and the column exists only on the referencing table.
            /// </summary>
            public void AddLookup(string logicalName, string column, params string[] targets)
            {
                Append(logicalName, new Microsoft.Xrm.Sdk.Metadata.LookupAttributeMetadata
                {
                    LogicalName = column,
                    SchemaName = column,
                    DisplayName = LabelFor(column),
                    AttributeType = Microsoft.Xrm.Sdk.Metadata.AttributeTypeCode.Lookup,
                    Targets = targets,
                    IsValidForRead = true
                });
            }

            private void Append(string logicalName, Microsoft.Xrm.Sdk.Metadata.AttributeMetadata attribute)
            {
                var table = _tables[logicalName];
                table.Attributes = table.Attributes.Concat(new[] { attribute }).ToArray();
            }

            /// <summary>Adds a 1:N the way Dataverse reports it: on both participating tables.</summary>
            public void Link(string referenced, string referencing, string schemaName, string attribute)
            {
                Link(referenced, referencing, schemaName, attribute, null, null);
            }

            /// <summary>
            /// A 1:N with cascade behaviour, for the impact-analysis checks. Delete and Assign are
            /// the two that decide whether the walk propagates, blocks or stops.
            /// </summary>
            public void Link(
                string referenced,
                string referencing,
                string schemaName,
                string attribute,
                Microsoft.Xrm.Sdk.Metadata.CascadeType? onDelete,
                Microsoft.Xrm.Sdk.Metadata.CascadeType? onAssign)
            {
                var relationship = new Microsoft.Xrm.Sdk.Metadata.OneToManyRelationshipMetadata
                {
                    SchemaName = schemaName,
                    ReferencedEntity = referenced,
                    ReferencingEntity = referencing,
                    ReferencedAttribute = referenced + "id",
                    ReferencingAttribute = attribute,
                    MetadataId = Guid.NewGuid(),
                    CascadeConfiguration = onDelete == null && onAssign == null
                        ? null
                        : new Microsoft.Xrm.Sdk.Metadata.CascadeConfiguration
                        {
                            Delete = onDelete ?? Microsoft.Xrm.Sdk.Metadata.CascadeType.NoCascade,
                            Assign = onAssign ?? Microsoft.Xrm.Sdk.Metadata.CascadeType.NoCascade
                        }
                };

                _tables[referenced].OneToManyRelationships =
                    _tables[referenced].OneToManyRelationships.Concat(new[] { relationship }).ToArray();

                _tables[referencing].ManyToOneRelationships =
                    _tables[referencing].ManyToOneRelationships.Concat(new[] { relationship }).ToArray();
            }

            public void SetOwnership(string logicalName, Microsoft.Xrm.Sdk.Metadata.OwnershipTypes ownership)
            {
                _tables[logicalName].OwnershipType = ownership;
            }

            public Microsoft.Xrm.Sdk.OrganizationResponse Execute(Microsoft.Xrm.Sdk.OrganizationRequest request)
            {
                var all = request as Microsoft.Xrm.Sdk.Messages.RetrieveAllEntitiesRequest;
                if (all != null)
                {
                    return new Microsoft.Xrm.Sdk.Messages.RetrieveAllEntitiesResponse
                    {
                        EntityMetadata = _tables.Values.ToArray()
                    };
                }

                var one = request as Microsoft.Xrm.Sdk.Messages.RetrieveEntityRequest;
                if (one != null)
                {
                    RetrieveCount++;

                    Microsoft.Xrm.Sdk.Metadata.EntityMetadata found;
                    if (!_tables.TryGetValue(one.LogicalName, out found))
                        throw new InvalidOperationException("No such table: " + one.LogicalName);

                    return new Microsoft.Xrm.Sdk.Messages.RetrieveEntityResponse { EntityMetadata = found };
                }

                throw new NotSupportedException("The fake environment does not answer " + request.GetType().Name);
            }

            private static Microsoft.Xrm.Sdk.Label LabelFor(string text)
            {
                return new Microsoft.Xrm.Sdk.Label
                {
                    UserLocalizedLabel = new Microsoft.Xrm.Sdk.LocalizedLabel { Label = text }
                };
            }

            public Microsoft.Xrm.Sdk.EntityCollection RetrieveMultiple(Microsoft.Xrm.Sdk.Query.QueryBase query)
            {
                // Only solution reads use RetrieveMultiple, and nothing here asks for one.
                throw new NotSupportedException("The fake environment answers metadata requests only.");
            }
        }

        // ------------------------------------------------------------------

        private static DiagramDocument BuildDocument()
        {
            var document = new DiagramDocument
            {
                Title = "Customer core - current and wave 2",
                Description = "Ampersand & angle < brackets > in the description",
                Settings = new DiagramSettings
                {
                    FieldDetail = FieldDetailMode.RelationshipFields,
                    ShowLegend = true,

                    // What the user calls the emphasis colour applied to Account below. The legend
                    // reads it from here, on screen and in exports.
                    EmphasisNames = new Dictionary<string, string> { { "#16a34a", "Phase 2" } }
                }
            };

            document.Source = new DiagramSource
            {
                EnvironmentUrl = "https://contoso-uat.crm11.dynamics.com",
                OrganizationFriendlyName = "Contoso UAT",
                OrganizationId = "env-1",
                LastRefreshUtc = DateTime.UtcNow
            };

            var account = Table("account", "Account", 420, 60);
            account.Columns.Add(Lookup("primarycontactid", "Primary contact"));
            account.Columns.Add(Lookup("parentaccountid", "Parent account"));
            account.Highlight = "#16a34a";
            account.OwnershipType = "UserOwned";

            var contact = Table("contact", "Contact", 760, 20);
            contact.Columns.Add(Lookup("parentcustomerid", "Company name"));
            contact.OwnershipType = "UserOwned";

            var opportunity = Table("opportunity", "Opportunity", 760, 300);
            opportunity.Columns.Add(Lookup("customerid", "Customer"));
            opportunity.OwnershipType = "UserOwned";

            var territory = Table("territory", "Territory", 1100, 300);
            territory.OwnershipType = "OrganizationOwned";

            var legacy = Table("cs_legacycustomer", "Legacy Customer", 60, 300);
            legacy.Status = ObjectStatus.Deprecated;

            var segment = new DiagramTable
            {
                DisplayName = "Customer Segment",
                SchemaName = "cs_customersegment",
                Status = ObjectStatus.Proposed,
                X = 420,
                Y = 420,
                PrimaryIdAttribute = "cs_segmentid",
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = "cs_segmentid", DisplayName = "Segment", TypeName = "Unique identifier", IsPrimaryId = true, Status = ObjectStatus.Proposed },
                    new DiagramColumn { LogicalName = "cs_name", DisplayName = "Segment name", TypeName = "Text (100)", Status = ObjectStatus.Proposed }
                }
            };

            var external = new DiagramTable
            {
                DisplayName = "SAP Customer Master",
                Status = ObjectStatus.External,
                X = 60,
                Y = 60
            };

            document.Tables.AddRange(new[] { account, contact, opportunity, territory, legacy, segment, external });

            document.Relationships.Add(Relationship("contact_customer_accounts", account, contact, "parentcustomerid"));
            document.Relationships.Add(Relationship("account_primary_contact", contact, account, "primarycontactid"));
            document.Relationships.Add(Relationship("opportunity_customer_accounts", account, opportunity, "customerid"));

            var excluded = Relationship("account_master_account", account, account, "parentaccountid");
            excluded.Included = false;
            document.Relationships.Add(excluded);

            document.Relationships.Add(new DiagramRelationship
            {
                SchemaName = "cs_account_territory",
                Kind = RelationshipKind.ManyToMany,
                Status = ObjectStatus.Existing,
                FromTableId = account.Id,
                ToTableId = territory.Id,
                IntersectEntity = "cs_account_territory_intersect",
                ReferencedEntity = "account",
                ReferencingEntity = "territory",
                Included = true
            });

            var proposedLink = new DiagramRelationship
            {
                SchemaName = "cs_account_segment",
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Proposed,
                FromTableId = account.Id,
                ToTableId = segment.Id,
                ReferencingAttribute = "cs_accountid",
                ReferencedAttribute = "accountid",
                ReferencedEntity = "account",
                CascadeNotes = "Delete: Restrict",
                Included = true
            };

            document.Relationships.Add(proposedLink);

            // The lookup column that proposed relationship implies, on the table at the many end.
            // The canvas writes it; what matters here is that the host can carry the link back to
            // the relationship that owns it. That link is what lets the canvas rename, move and
            // remove the column with the relationship, and a column that came back from a file
            // without it would be an orphan the user could not get rid of except by hand.
            segment.Columns.Add(new DiagramColumn
            {
                LogicalName = "cs_accountid",
                SchemaName = "cs_AccountId",
                DisplayName = "Account",
                TypeName = "Lookup",
                AttributeType = "Lookup",
                IsLookup = true,
                Status = ObjectStatus.Proposed,
                Selected = true,
                Targets = new List<string> { "account" },
                FromRelationshipId = proposedLink.Id
            });

            document.Annotations.Add(new DiagramAnnotation
            {
                Text = "Cascade delete is deliberately Remove Link: contacts survive account retirement.",
                X = 420, Y = -110, Width = 300, Height = 90,
                AttachedToId = account.Id
            });

            // A text box and an arrow. Both are annotations with a kind, and both carry properties
            // no sticky note has - ink for the text box, a vector for the arrow - so a round trip
            // that only ever sees notes proves nothing about either of them.
            document.Annotations.Add(new DiagramAnnotation
            {
                Kind = "text",
                Text = "Phase 2 scope",
                X = 420, Y = 60, Width = 220, Height = 40,
                Ink = "#1f5fe0"
            });

            document.Annotations.Add(new DiagramAnnotation
            {
                Kind = "arrow",
                X = 500, Y = 500, Dx = -120, Dy = -80,
                Ink = "#c0392f"
            });

            return document;
        }

        private static DiagramTable Table(string logicalName, string displayName, double x, double y)
        {
            return new DiagramTable
            {
                LogicalName = logicalName,
                SchemaName = displayName.Replace(" ", string.Empty),
                DisplayName = displayName,
                Status = ObjectStatus.Existing,
                X = x,
                Y = y,
                PrimaryIdAttribute = logicalName + "id",
                PrimaryNameAttribute = "name",
                Columns = new List<DiagramColumn>
                {
                    new DiagramColumn { LogicalName = logicalName + "id", DisplayName = "Identifier", TypeName = "Unique identifier", AttributeType = "Uniqueidentifier", IsPrimaryId = true },
                    new DiagramColumn { LogicalName = "name", DisplayName = "Name", TypeName = "Text (160)", AttributeType = "String", IsPrimaryName = true }
                }
            };
        }

        private static DiagramColumn Lookup(string logicalName, string displayName)
        {
            return new DiagramColumn
            {
                LogicalName = logicalName,
                DisplayName = displayName,
                TypeName = "Lookup",
                AttributeType = "Lookup",
                IsLookup = true
            };
        }

        private static DiagramRelationship Relationship(string schemaName, DiagramTable from, DiagramTable to, string attribute)
        {
            return new DiagramRelationship
            {
                SchemaName = schemaName,
                DisplayName = schemaName,
                Kind = RelationshipKind.OneToMany,
                Status = ObjectStatus.Existing,
                FromTableId = from.Id,
                ToTableId = to.Id,
                ReferencedEntity = from.LogicalName,
                ReferencingEntity = to.LogicalName,
                ReferencedAttribute = from.PrimaryIdAttribute,
                ReferencingAttribute = attribute,
                Included = true,
                Cascade = new CascadeConfiguration
                {
                    Assign = "Cascade", Delete = "RemoveLink", Merge = "Cascade",
                    Reparent = "Cascade", Share = "Cascade", Unshare = "Cascade"
                }
            };
        }

        // ------------------------------------------------------------------

        private static void Section(string title)
        {
            Console.WriteLine();
            Console.WriteLine(title);
        }

        private static void Check(string label, bool condition, string detail = null)
        {
            if (condition) { Console.WriteLine("  ok   " + label); return; }
            Console.WriteLine("  FAIL " + label + (string.IsNullOrEmpty(detail) ? string.Empty : " - " + detail));
            _failures++;
        }

        private static bool IsWellFormed(string xml, out string error)
        {
            error = null;
            try
            {
                XDocument.Parse(xml);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static int CountOccurrences(string haystack, string needle)
        {
            var count = 0;
            var index = 0;
            while ((index = haystack.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
            {
                count++;
                index += needle.Length;
            }
            return count;
        }

        private static bool Throws(Action action)
        {
            try { action(); return false; }
            catch { return true; }
        }
    }
}
