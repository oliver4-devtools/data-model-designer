using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Newtonsoft.Json;
using Oliver4.DataModelDesigner.Metadata;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Services
{
    /// <summary>Options for a relationship-depth traversal.</summary>
    public class DiscoveryOptions
    {
        [JsonProperty("startTables")] public List<string> StartTables { get; set; } = new List<string>();

        /// <summary>Number of relationship hops. Use 0 or less for unrestricted, bounded by MaxTables.</summary>
        [JsonProperty("depth")] public int Depth { get; set; } = 1;

        [JsonProperty("includeOneToMany")] public bool IncludeOneToMany { get; set; } = true;
        [JsonProperty("includeManyToOne")] public bool IncludeManyToOne { get; set; } = true;
        [JsonProperty("includeManyToMany")] public bool IncludeManyToMany { get; set; } = true;

        /// <summary>
        /// Microsoft-supplied tables such as Contact, Incident and Product. On by default: a walk
        /// out of Account that hid Contact would be answering a different question from the one
        /// the user asked. Platform plumbing is filtered separately - see HidePlatformTables.
        /// </summary>
        [JsonProperty("includeSystemTables")] public bool IncludeSystemTables { get; set; } = true;

        [JsonProperty("includeActivityTables")] public bool IncludeActivityTables { get; set; }
        [JsonProperty("includeIntersectTables")] public bool IncludeIntersectTables { get; set; }

        /// <summary>
        /// Hides the platform tables every record is related to - async operations, audit, sync
        /// errors, sharing, duplicate detection and so on. Metadata has no flag for these, so the
        /// list is by name (see DiscoveryService.PlatformTables). Without it, hop 1 from any table
        /// is thirty rows of plumbing and the tables that matter are lost in it.
        /// </summary>
        [JsonProperty("hidePlatformTables")] public bool HidePlatformTables { get; set; } = true;

        /// <summary>
        /// Hard ceiling on the number of tables returned. Without this, depth 3 from Account in a
        /// real environment walks most of the schema and produces an unusable result.
        /// </summary>
        [JsonProperty("maxTables")] public int MaxTables { get; set; } = 150;

        /// <summary>Logical names never to traverse into, on top of the category filters.</summary>
        [JsonProperty("excludedTables")] public List<string> ExcludedTables { get; set; } = new List<string>();
    }

    /// <summary>Result of a traversal, presented for review before anything is added to a diagram.</summary>
    public class DiscoveryResult
    {
        [JsonProperty("tables")] public List<DiscoveredTable> Tables { get; set; } = new List<DiscoveredTable>();
        [JsonProperty("relationships")] public List<RelationshipDto> Relationships { get; set; } = new List<RelationshipDto>();

        /// <summary>True when the table ceiling stopped the walk before it ran out of graph.</summary>
        [JsonProperty("truncated")] public bool Truncated { get; set; }

        [JsonProperty("message")] public string Message { get; set; }

        /// <summary>How deep the walk actually got, which is less than the requested depth when the graph ran out.</summary>
        [JsonProperty("reachedDepth")] public int ReachedDepth { get; set; }

        /// <summary>Tables filtered out by the category rules, so the dialog can say what is being hidden.</summary>
        [JsonProperty("filteredOut")] public int FilteredOut { get; set; }

        /// <summary>Tables the walk could not read metadata for. Named so a failure is visible rather than silent.</summary>
        [JsonProperty("unreadable")] public List<string> Unreadable { get; set; } = new List<string>();
    }

    public class DiscoveredTable
    {
        [JsonProperty("summary")] public TableSummary Summary { get; set; }

        /// <summary>Hops from the nearest start table. 0 means it is a start table.</summary>
        [JsonProperty("hops")] public int Hops { get; set; }

        /// <summary>Pre-ticked in the review list. Start tables are always selected.</summary>
        [JsonProperty("selected")] public bool Selected { get; set; } = true;

        /// <summary>
        /// How many relationships join this table to the rest of the result. Shown in the review
        /// list so a user can tell a hub from a leaf before deciding to add it.
        /// </summary>
        [JsonProperty("degree")] public int Degree { get; set; }

        /// <summary>Display names of the tables this one is directly joined to, for the review list.</summary>
        [JsonProperty("via")] public List<string> Via { get; set; } = new List<string>();
    }

    /// <summary>
    /// Breadth-first traversal of the Dataverse relationship graph, and a bounded path finder
    /// between two tables. Both walk live metadata rather than the current diagram, so a user can
    /// discover tables they have not added yet.
    /// </summary>
    public class DiscoveryService
    {
        private readonly MetadataService _metadata;
        private readonly Action<string, int> _progress;

        /// <summary>
        /// Pass a progress callback so a walk that costs one live metadata call per table can say
        /// what it is doing. Depth 2 out of a hub table is a minute of waiting otherwise, with
        /// nothing on screen to say the tool has not hung.
        /// </summary>
        public DiscoveryService(MetadataService metadata, Action<string, int> progress = null)
        {
            _metadata = metadata ?? throw new ArgumentNullException(nameof(metadata));
            _progress = progress;
        }

        /// <summary>
        /// Tables that exist to make the platform work rather than to model a business. Every
        /// record in Dataverse is related to most of these, so a depth-1 walk from any table
        /// returns them all and buries the handful of tables the user actually wanted.
        ///
        /// This is a judgement call rather than something metadata tells us, which is why it is a
        /// visible, single list and why the filter that uses it can be switched off in the dialog.
        /// </summary>
        private static readonly HashSet<string> PlatformTables = new HashSet<string>(
            StringComparer.OrdinalIgnoreCase)
        {
            "asyncoperation", "bulkdeletefailure", "bulkdeleteoperation", "processsession",
            "workflow", "workflowlog", "expiredprocess", "translationprocess",
            "duplicaterecord", "duplicaterule", "duplicaterulecondition",
            "syncerror", "importdata", "importfile", "importlog", "import", "importmap",
            "principalobjectattributeaccess", "principalobjectaccess",
            "userentityinstancedata", "userentityuisettings",
            "mailboxtrackingfolder", "processstage", "slakpiinstance",
            "annotation", "audit", "callbackregistration", "connection", "connectionreference",
            "teammembership", "subscription", "sharepointdocumentlocation", "sharepointsite",
            "fileattachment", "attachment", "activitymimeattachment",
            "flowsession", "msdyn_aibdataset", "msdyn_federatedarticle",
            "solutioncomponentattributeconfiguration", "exportsolutionupload",
            "plugintraceLog", "plugintracelog", "recordfilter", "featurecontrolsetting"
        };

        public DiscoveryResult Discover(DiscoveryOptions options, CancellationToken cancellation = default(CancellationToken))
        {
            if (options == null) throw new ArgumentNullException(nameof(options));

            Report("Reading the table catalogue...", 2);

            var catalogue = _metadata.GetCatalogue()
                .GroupBy(t => t.LogicalName, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            var excluded = new HashSet<string>(
                options.ExcludedTables ?? new List<string>(), StringComparer.OrdinalIgnoreCase);

            var result = new DiscoveryResult();
            var visited = new Dictionary<string, DiscoveredTable>(StringComparer.OrdinalIgnoreCase);
            var relationshipsBySchema = new Dictionary<string, RelationshipDto>(StringComparer.OrdinalIgnoreCase);
            var filteredOut = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var frontier = new List<string>();
            foreach (var start in options.StartTables ?? new List<string>())
            {
                TableSummary summary;
                if (!catalogue.TryGetValue(start, out summary)) continue;
                if (visited.ContainsKey(start)) continue;

                // A start table is never filtered out by the category rules. The user named it.
                visited[start] = new DiscoveredTable { Summary = summary, Hops = 0, Selected = true };
                frontier.Add(start);
            }

            if (frontier.Count == 0)
            {
                result.Message = (options.StartTables == null || options.StartTables.Count == 0)
                    ? "Choose a table to start from."
                    : "The starting table was not found in this environment. It may have been renamed " +
                      "or removed, or you may be connected somewhere else.";
                return result;
            }

            var maxDepth = options.Depth <= 0 ? int.MaxValue : options.Depth;
            var hop = 0;

            // Progress is reported against the tables expanded so far rather than a known total,
            // because the total is not knowable until the walk finishes. The bar therefore fills
            // per hop, which is honest about what is happening.
            var expanded = 0;

            // Not also guarded on !result.Truncated. Once the ceiling is reached no new table can
            // be added, so the next hop terminates by itself when its frontier comes back empty -
            // but the hop that is already queued still expands, and that is what finds the
            // relationships *between* the tables in the result, which the review dialog needs to
            // show their connectivity.
            while (frontier.Count > 0 && hop < maxDepth)
            {
                cancellation.ThrowIfCancellationRequested();
                hop++;

                var nextFrontier = new List<string>();
                var positionInHop = 0;

                foreach (var current in frontier)
                {
                    cancellation.ThrowIfCancellationRequested();
                    positionInHop++;
                    expanded++;

                    TableSummary currentSummary;
                    var currentLabel = catalogue.TryGetValue(current, out currentSummary)
                        ? (currentSummary.DisplayName ?? current)
                        : current;

                    Report(
                        "Hop " + hop + " of " + (options.Depth <= 0 ? "all" : options.Depth.ToString()) +
                        ": reading " + currentLabel + " (" + positionInHop + " of " + frontier.Count + ")",
                        PercentFor(hop, maxDepth, positionInHop, frontier.Count));

                    var table = _metadata.GetTable(current);
                    if (table == null)
                    {
                        // GetTable swallows the failure and returns null so one bad table cannot
                        // lose the whole walk. Recording it means the dialog can say so rather than
                        // quietly returning a smaller answer than the user asked for.
                        result.Unreadable.Add(current);
                        continue;
                    }

                    foreach (var relationship in table.Relationships)
                    {
                        if (!IsKindIncluded(relationship.Kind, options)) continue;

                        var other = relationship.OtherEnd(current);
                        if (string.IsNullOrEmpty(other)) continue;
                        if (excluded.Contains(other)) continue;

                        TableSummary otherSummary;
                        if (!catalogue.TryGetValue(other, out otherSummary)) continue;

                        if (!PassesCategoryFilters(otherSummary, options))
                        {
                            filteredOut.Add(other);
                            continue;
                        }

                        if (!visited.ContainsKey(other))
                        {
                            if (visited.Count >= options.MaxTables)
                            {
                                result.Truncated = true;
                                continue;
                            }

                            visited[other] = new DiscoveredTable
                            {
                                Summary = otherSummary,
                                Hops = hop,
                                Selected = true
                            };

                            nextFrontier.Add(other);
                        }

                        // Only keep a relationship when both ends survived the filters, otherwise
                        // the review list shows connectors to tables that are not in the result.
                        //
                        // Merged rather than assigned: the same 1:N arrives twice, once from each
                        // end, and the two views disagree about cardinality and about whether the
                        // lookup is polymorphic. See RelationshipViews.
                        if (visited.ContainsKey(relationship.ReferencedEntity) &&
                            visited.ContainsKey(relationship.ReferencingEntity))
                        {
                            RelationshipDto merged;
                            relationshipsBySchema.TryGetValue(relationship.SchemaName, out merged);
                            relationshipsBySchema[relationship.SchemaName] =
                                RelationshipViews.Merge(merged, relationship);
                        }
                    }
                }

                frontier = nextFrontier;
            }

            // How far the walk actually got, which is the deepest table it found - not the loop
            // counter. Those differ whenever the graph runs out early: a depth-3 walk on a graph
            // that ends at 2 hops still runs a third iteration that adds nothing, and the
            // "everything reachable was found at N hops" note depends on reporting 2.
            result.ReachedDepth = visited.Count == 0 ? 0 : visited.Values.Max(t => t.Hops);

            // A relationship between two tables both already visited may have been skipped above if
            // the second end was added after the first was walked. Sweep once more to catch those.
            // Cached tables only: re-reading here would double the cost of the whole walk, and any
            // relationship between two outermost tables is picked up when the selection is
            // committed, because that runs GetRelationshipsWithin over the final set.
            foreach (var name in visited.Keys.ToList())
            {
                cancellation.ThrowIfCancellationRequested();

                if (!_metadata.IsCached(name)) continue;
                var table = _metadata.GetTable(name);
                if (table == null) continue;

                foreach (var relationship in table.Relationships)
                {
                    if (!IsKindIncluded(relationship.Kind, options)) continue;
                    if (!visited.ContainsKey(relationship.ReferencedEntity)) continue;
                    if (!visited.ContainsKey(relationship.ReferencingEntity)) continue;

                    // Merged for the same reason as the main walk above.
                    RelationshipDto merged;
                    relationshipsBySchema.TryGetValue(relationship.SchemaName, out merged);
                    relationshipsBySchema[relationship.SchemaName] =
                        RelationshipViews.Merge(merged, relationship);
                }
            }

            result.Relationships = relationshipsBySchema.Values
                .OrderBy(r => r.ReferencedEntity, StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => r.SchemaName, StringComparer.OrdinalIgnoreCase)
                .ToList();

            AnnotateConnectivity(visited, result.Relationships, catalogue);

            result.Tables = visited.Values
                .OrderBy(t => t.Hops)
                .ThenByDescending(t => t.Degree)
                .ThenBy(t => t.Summary.DisplayName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            result.FilteredOut = filteredOut.Count;

            var notes = new List<string>();

            if (result.Truncated)
            {
                notes.Add("Stopped at the " + options.MaxTables + "-table limit, so there is more to find. " +
                          "Reduce the depth, or narrow the relationship types, to see it.");
            }
            else if (options.Depth > 0 && result.ReachedDepth < options.Depth)
            {
                notes.Add("Everything reachable was found at " + result.ReachedDepth + " " +
                          (result.ReachedDepth == 1 ? "hop" : "hops") + ", so a greater depth adds nothing.");
            }

            if (result.Unreadable.Count > 0)
            {
                notes.Add(result.Unreadable.Count + " " +
                          (result.Unreadable.Count == 1 ? "table" : "tables") +
                          " could not be read (" + string.Join(", ", result.Unreadable.Take(3)) +
                          (result.Unreadable.Count > 3 ? ", ..." : "") +
                          "), so anything only reachable through " +
                          (result.Unreadable.Count == 1 ? "it" : "them") + " is missing.");
            }

            result.Message = notes.Count == 0 ? null : string.Join(" ", notes);
            return result;
        }

        /// <summary>
        /// Fills in each discovered table's degree and immediate neighbours, so the review list can
        /// show a hub as a hub instead of one more row.
        /// </summary>
        private static void AnnotateConnectivity(
            Dictionary<string, DiscoveredTable> visited,
            List<RelationshipDto> relationships,
            Dictionary<string, TableSummary> catalogue)
        {
            var neighbours = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            var degrees = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            foreach (var relationship in relationships)
            {
                Touch(degrees, neighbours, relationship.ReferencedEntity, relationship.ReferencingEntity);

                // A self-referencing relationship - a parent-child hierarchy on one table - has
                // both ends on the same table, so it is counted once rather than from each end;
                // otherwise a hierarchical table would read as more connected than it is.
                if (!string.Equals(relationship.ReferencedEntity, relationship.ReferencingEntity,
                        StringComparison.OrdinalIgnoreCase))
                {
                    Touch(degrees, neighbours, relationship.ReferencingEntity, relationship.ReferencedEntity);
                }
            }

            foreach (var entry in visited)
            {
                int degree;
                entry.Value.Degree = degrees.TryGetValue(entry.Key, out degree) ? degree : 0;

                HashSet<string> others;
                if (!neighbours.TryGetValue(entry.Key, out others)) continue;

                entry.Value.Via = others
                    .Select(name =>
                    {
                        TableSummary summary;
                        return catalogue.TryGetValue(name, out summary) ? (summary.DisplayName ?? name) : name;
                    })
                    .OrderBy(name => name, StringComparer.CurrentCultureIgnoreCase)
                    .Take(6)
                    .ToList();
            }
        }

        private static void Touch(
            Dictionary<string, int> degrees,
            Dictionary<string, HashSet<string>> neighbours,
            string from,
            string to)
        {
            if (string.IsNullOrEmpty(from)) return;

            int current;
            degrees[from] = degrees.TryGetValue(from, out current) ? current + 1 : 1;

            if (string.IsNullOrEmpty(to) || string.Equals(from, to, StringComparison.OrdinalIgnoreCase)) return;

            HashSet<string> set;
            if (!neighbours.TryGetValue(from, out set))
            {
                set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                neighbours[from] = set;
            }

            set.Add(to);
        }

        private static int PercentFor(int hop, int maxDepth, int position, int total)
        {
            // An unrestricted walk has no denominator, so it paces on the current hop alone rather
            // than pretending to know how far through it is.
            var hopShare = maxDepth == int.MaxValue ? 25.0 : 100.0 / Math.Max(1, maxDepth);
            var withinHop = total <= 0 ? 0.0 : (double)position / total;
            return (int)Math.Min(99, hopShare * ((hop - 1) + withinHop));
        }

        private void Report(string message, int percent)
        {
            if (_progress == null) return;
            try { _progress(message, percent); }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    "Oliver4 Data Model Designer: progress callback failed: " + ex.Message);
            }
        }

        // ------------------------------------------------------------------
        // Relationship path finding
        // ------------------------------------------------------------------

        public PathSearchResult FindPaths(
            string fromTable,
            string toTable,
            int maxDepth,
            int maxPaths,
            CancellationToken cancellation = default(CancellationToken))
        {
            var result = new PathSearchResult();

            if (string.IsNullOrWhiteSpace(fromTable) || string.IsNullOrWhiteSpace(toTable))
            {
                result.Message = "Choose two tables to search between.";
                return result;
            }

            if (string.Equals(fromTable, toTable, StringComparison.OrdinalIgnoreCase))
            {
                result.Message = "Both ends are the same table.";
                return result;
            }

            if (maxDepth <= 0) maxDepth = 4;
            if (maxPaths <= 0) maxPaths = 10;

            // Budget on nodes expanded, so a search across a large schema cannot hang the UI.
            // Every expansion is potentially one RetrieveEntityRequest, which is why the same
            // table is never expanded twice (see expandedAt below).
            const int expansionBudget = 400;
            var expanded = 0;

            var queue = new Queue<List<PathStep>>();
            queue.Enqueue(new List<PathStep>
            {
                new PathStep { Table = fromTable, RelationshipSchemaName = null }
            });

            // Shallowest depth each table has already been expanded from. Every table is expanded
            // once and once only, at the first depth it is reached.
            var expandedAt = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            // Set when that guard turned away an arrival at the *same* depth by a different route,
            // which is an equal-length alternative path being dropped rather than a longer one. The
            // result is then genuinely incomplete and has to say so.
            var alternativesDropped = false;

            var shortestFound = -1;

            while (queue.Count > 0 && result.Paths.Count < maxPaths)
            {
                cancellation.ThrowIfCancellationRequested();

                var path = queue.Dequeue();
                var last = path[path.Count - 1].Table;
                var depth = path.Count - 1;

                if (depth >= maxDepth) continue;

                // Once a path is found, do not keep exploring much longer ones. Guarded on
                // "something was found" rather than a sentinel, because int.MaxValue + 1 overflows
                // to int.MinValue.
                if (shortestFound >= 0 && depth > shortestFound + 1) continue;

                int previousDepth;
                if (expandedAt.TryGetValue(last, out previousDepth) && previousDepth <= depth)
                {
                    // <= rather than <. A later arrival at a *greater* depth can only
                    // produce longer versions of paths already queued, so dropping it costs
                    // nothing. A later arrival at the *same* depth is an equal-length alternative
                    // and it is dropped too - not because it is worthless but because exploring it
                    // costs one live RetrieveEntityRequest per arrival, and on a hub-shaped schema
                    // a single table is reached at the same depth by dozens of routes. That is a
                    // real answer being withheld, so it is recorded and the result says there may
                    // be others.
                    if (previousDepth == depth) alternativesDropped = true;
                    continue;
                }

                expandedAt[last] = depth;

                if (expanded++ >= expansionBudget)
                {
                    result.Truncated = true;
                    break;
                }

                var table = _metadata.GetTable(last);
                if (table == null) continue;

                foreach (var relationship in table.Relationships)
                {
                    var other = relationship.OtherEnd(last);
                    if (string.IsNullOrEmpty(other)) continue;

                    // No revisiting a table within the same path.
                    if (path.Any(step => string.Equals(step.Table, other, StringComparison.OrdinalIgnoreCase)))
                        continue;

                    var extended = new List<PathStep>(path)
                    {
                        new PathStep
                        {
                            Table = other,
                            RelationshipSchemaName = relationship.SchemaName,
                            Relationship = relationship
                        }
                    };

                    if (string.Equals(other, toTable, StringComparison.OrdinalIgnoreCase))
                    {
                        var hops = extended.Count - 1;
                        if (shortestFound < 0 || hops < shortestFound) shortestFound = hops;

                        result.Paths.Add(new RelationshipPath { Steps = extended });

                        if (result.Paths.Count >= maxPaths)
                        {
                            result.Truncated = true;
                            break;
                        }

                        continue;
                    }

                    queue.Enqueue(extended);
                }
            }

            if (result.Paths.Count == 0)
            {
                result.Message = "No path found within " + maxDepth + " " + (maxDepth == 1 ? "hop" : "hops") + "." +
                                 (result.Truncated
                                     ? " The search stopped at its " + expansionBudget +
                                       " table budget, so a longer path may exist."
                                     : string.Empty);
            }
            else if (result.Truncated || alternativesDropped)
            {
                // alternativesDropped can only have cost equal-length *alternatives*: a table that
                // was expanded had all of its neighbours queued, so a path that exists at all is
                // still found. That is why this only qualifies a result that has paths in it.
                result.Message = "Showing the first " + result.Paths.Count +
                                 " paths found. There may be others.";
            }

            result.Paths = result.Paths.OrderBy(p => p.Steps.Count).ToList();
            return result;
        }

        private static bool IsKindIncluded(RelationshipKind kind, DiscoveryOptions options)
        {
            switch (kind)
            {
                case RelationshipKind.OneToMany: return options.IncludeOneToMany;
                case RelationshipKind.ManyToOne: return options.IncludeManyToOne;
                case RelationshipKind.ManyToMany: return options.IncludeManyToMany;
                default: return true;
            }
        }

        private static bool PassesCategoryFilters(TableSummary summary, DiscoveryOptions options)
        {
            if (summary.IsIntersect && !options.IncludeIntersectTables) return false;
            if (summary.IsActivity && !options.IncludeActivityTables) return false;

            // "System" here means a table shipped by Microsoft rather than created in this
            // environment. IsCustomEntity is the only signal metadata gives for that.
            if (!summary.IsCustom && !options.IncludeSystemTables) return false;

            if (options.HidePlatformTables && IsPlatformTable(summary.LogicalName)) return false;

            return true;
        }

        /// <summary>
        /// True for the platform plumbing listed in <see cref="PlatformTables"/>, and for the
        /// prefixed families that are always noise on a data model - Power Automate flow rows,
        /// solution-history rows and the msdyn_ telemetry tables.
        /// </summary>
        public static bool IsPlatformTable(string logicalName)
        {
            if (string.IsNullOrEmpty(logicalName)) return false;
            if (PlatformTables.Contains(logicalName)) return true;

            return logicalName.StartsWith("msdyn_analytics", StringComparison.OrdinalIgnoreCase)
                || logicalName.StartsWith("msdyn_wallsavedquery", StringComparison.OrdinalIgnoreCase)
                || logicalName.StartsWith("flow", StringComparison.OrdinalIgnoreCase)
                || logicalName.StartsWith("solutionhistory", StringComparison.OrdinalIgnoreCase);
        }
    }

    public class PathSearchResult
    {
        [JsonProperty("paths")] public List<RelationshipPath> Paths { get; set; } = new List<RelationshipPath>();
        [JsonProperty("truncated")] public bool Truncated { get; set; }
        [JsonProperty("message")] public string Message { get; set; }
    }

    public class RelationshipPath
    {
        [JsonProperty("steps")] public List<PathStep> Steps { get; set; } = new List<PathStep>();
    }

    public class PathStep
    {
        [JsonProperty("table")] public string Table { get; set; }
        [JsonProperty("relationshipSchemaName")] public string RelationshipSchemaName { get; set; }
        [JsonProperty("relationship")] public RelationshipDto Relationship { get; set; }
    }
}
