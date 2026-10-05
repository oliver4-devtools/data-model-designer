using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Newtonsoft.Json;
using Oliver4.DataModelDesigner.Metadata;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Services
{
    /// <summary>
    /// "If I delete this record, what else goes with it?"
    ///
    /// The cascade configuration is already on every relationship and the inspector shows it one
    /// connector at a time. What nobody can see from that is the *chain*: Account cascades to
    /// Contact, Contact cascades to something else, and three hops later a table nobody put on the
    /// diagram is being deleted too. Misjudging that is a production-incident class of mistake, and
    /// it is entirely predictable from metadata that is already loaded.
    ///
    /// Direction is the thing to get right. Cascading behaviour flows from the "one" end of a 1:N
    /// to the "many" end - from the referenced table to the referencing table - because it is the
    /// referencing records that carry the lookup. It never flows the other way: deleting a Contact
    /// does not delete its Account. N:N relationships carry no cascade configuration at all; the
    /// intersect rows go and neither table is otherwise affected.
    /// </summary>
    public class CascadeService
    {
        private readonly MetadataService _metadata;
        private readonly Action<string, int> _progress;

        public CascadeService(MetadataService metadata, Action<string, int> progress = null)
        {
            _metadata = metadata ?? throw new ArgumentNullException(nameof(metadata));
            _progress = progress;
        }

        /// <summary>
        /// Expansion ceiling. Every table expanded is one live metadata call, and a cascade chain
        /// that reaches two hundred tables is telling the user something has gone wrong with the
        /// model rather than something they need the rest of.
        /// </summary>
        private const int MaxTables = 200;

        public CascadeResult Analyse(CascadeOptions options, CancellationToken cancellation = default(CancellationToken))
        {
            if (options == null) throw new ArgumentNullException(nameof(options));

            var behaviour = Normalise(options.Behaviour);

            var result = new CascadeResult
            {
                StartTable = options.StartTable,
                Behaviour = behaviour
            };

            if (string.IsNullOrWhiteSpace(options.StartTable))
            {
                result.Message = "Choose a table to start from.";
                return result;
            }

            Report("Reading the table catalogue...", 3);

            var catalogue = _metadata.GetCatalogue()
                .GroupBy(t => t.LogicalName, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            TableSummary startSummary;
            if (!catalogue.TryGetValue(options.StartTable, out startSummary))
            {
                result.Message = "That table was not found in this environment. It may have been " +
                                 "renamed or removed, or you may be connected somewhere else.";
                return result;
            }

            result.StartDisplayName = startSummary.DisplayName ?? startSummary.LogicalName;

            var maxDepth = options.MaxDepth <= 0 ? 6 : Math.Min(options.MaxDepth, 10);

            // Tables the operation propagates *into*, with the hop at which each was first reached.
            var affected = new Dictionary<string, CascadeStep>(StringComparer.OrdinalIgnoreCase);
            var expanded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var frontier = new List<string> { options.StartTable };
            var hop = 0;
            var exhausted = false;

            while (frontier.Count > 0 && hop < maxDepth)
            {
                cancellation.ThrowIfCancellationRequested();
                hop++;

                var next = new List<string>();
                var position = 0;

                foreach (var current in frontier)
                {
                    cancellation.ThrowIfCancellationRequested();
                    position++;

                    if (!expanded.Add(current)) continue;

                    TableSummary currentSummary;
                    var label = catalogue.TryGetValue(current, out currentSummary)
                        ? (currentSummary.DisplayName ?? current)
                        : current;

                    Report(
                        "Hop " + hop + ": reading " + label + " (" + position + " of " + frontier.Count + ")",
                        Math.Min(95, (int)(5 + 90.0 * (hop - 1) / maxDepth)));

                    var table = _metadata.GetTable(current);
                    if (table == null)
                    {
                        result.Unreadable.Add(current);
                        continue;
                    }

                    foreach (var relationship in table.Relationships)
                    {
                        // Only 1:N, and only from the "one" end. A relationship where `current` is
                        // the referencing table describes what happens when the *other* table's
                        // record is deleted, which is a different question from the one being asked.
                        if (relationship.Kind == RelationshipKind.ManyToMany) continue;
                        if (!string.Equals(relationship.ReferencedEntity, current, StringComparison.OrdinalIgnoreCase)) continue;

                        // A self-referencing 1:N - a parent-child hierarchy on one table - appears
                        // twice in table.Relationships, once as each of the two views metadata
                        // reports it under, and both pass the test above because both ends are this
                        // table. Blockers and Detached are plain lists, so the ManyToOne view is
                        // skipped to avoid listing the same row twice.
                        if (relationship.Kind == RelationshipKind.ManyToOne &&
                            string.Equals(relationship.ReferencingEntity, relationship.ReferencedEntity, StringComparison.OrdinalIgnoreCase))
                            continue;

                        var child = relationship.ReferencingEntity;
                        if (string.IsNullOrEmpty(child)) continue;

                        var action = BehaviourOf(relationship.Cascade, behaviour);

                        TableSummary childSummary;
                        catalogue.TryGetValue(child, out childSummary);

                        var step = new CascadeStep
                        {
                            FromTable = current,
                            FromDisplayName = label,
                            ToTable = child,
                            ToDisplayName = childSummary != null ? (childSummary.DisplayName ?? child) : child,
                            RelationshipSchemaName = relationship.SchemaName,
                            LookupColumn = relationship.ReferencingAttribute,
                            Action = action ?? "NoCascade",
                            Hops = hop
                        };

                        switch (Classify(action))
                        {
                            case CascadeOutcome.Propagates:
                                // The start table is never listed as a casualty of its own delete.
                                // A self-referential hierarchy - account parenting account, which
                                // most models have - and any cycle back to the start would
                                // otherwise put "Account" in the list of what deleting an Account
                                // takes with it, directly under a heading saying it started there.
                                if (string.Equals(child, options.StartTable, StringComparison.OrdinalIgnoreCase))
                                {
                                    result.SelfReferencing = true;
                                    break;
                                }

                                // Recorded at the shallowest hop it is reached by, so the chain
                                // reads as a distance from the record the user asked about.
                                if (!affected.ContainsKey(child))
                                {
                                    if (affected.Count >= MaxTables)
                                    {
                                        result.Truncated = true;
                                        break;
                                    }

                                    affected[child] = step;
                                    next.Add(child);
                                }

                                break;

                            case CascadeOutcome.Blocks:
                                // Restrict does not propagate; it stops the operation dead. Worth
                                // more to the user than most of what does propagate.
                                result.Blockers.Add(step);
                                break;

                            case CascadeOutcome.Detaches:
                                // The child survives and loses its reference. Collected at every
                                // hop, not just the first: a table only reaches the frontier
                                // because the operation propagates into it, so a RemoveLink off a
                                // hop-2 table describes records that genuinely do lose their
                                // lookup. Restrict is collected at every hop for the same reason.
                                result.Detached.Add(step);
                                break;
                        }
                    }
                }

                frontier = next;
                if (frontier.Count == 0) exhausted = true;
            }

            result.Affected = affected.Values
                .OrderBy(s => s.Hops)
                .ThenBy(s => s.ToDisplayName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            result.Blockers = result.Blockers
                .OrderBy(s => s.ToDisplayName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            result.Detached = result.Detached
                .OrderBy(s => s.ToDisplayName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            result.ReachedDepth = affected.Count == 0 ? 0 : affected.Values.Max(s => s.Hops);
            result.Message = Describe(result, behaviour, maxDepth, exhausted);

            return result;
        }

        // ------------------------------------------------------------------

        /// <summary>
        /// What a cascade value means for the walk.
        ///
        /// The vocabulary differs per behaviour, which is why this is one place rather than
        /// scattered comparisons. "Active" and "UserOwned" are Assign and Share values that
        /// propagate to a subset of the child records - which records is a runtime question, but
        /// the table is reachable either way, so the walk treats them as propagating and the
        /// UI prints the exact value so the user can see the qualification.
        /// </summary>
        private static CascadeOutcome Classify(string action)
        {
            switch (action)
            {
                case "Cascade":
                case "Active":
                case "UserOwned":
                    return CascadeOutcome.Propagates;

                case "Restrict":
                    return CascadeOutcome.Blocks;

                case "RemoveLink":
                    return CascadeOutcome.Detaches;

                default:
                    return CascadeOutcome.None;
            }
        }

        private static string BehaviourOf(CascadeConfiguration cascade, string behaviour)
        {
            if (cascade == null) return null;

            switch (behaviour)
            {
                case "Delete": return cascade.Delete;
                case "Assign": return cascade.Assign;
                case "Share": return cascade.Share;
                case "Unshare": return cascade.Unshare;
                case "Reparent": return cascade.Reparent;
                case "Merge": return cascade.Merge;
                default: return cascade.Delete;
            }
        }

        private static string Normalise(string behaviour)
        {
            switch ((behaviour ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "assign": return "Assign";
                case "share": return "Share";
                case "unshare": return "Unshare";
                case "reparent": return "Reparent";
                case "merge": return "Merge";
                default: return "Delete";
            }
        }

        /// <summary>The verb in the tense the summary needs, so the UI does not assemble sentences.</summary>
        public static string VerbFor(string behaviour)
        {
            switch (behaviour)
            {
                case "Assign": return "reassigned";
                case "Share": return "shared";
                case "Unshare": return "unshared";
                case "Reparent": return "reparented";
                case "Merge": return "merged";
                default: return "deleted";
            }
        }

        private static string Describe(CascadeResult result, string behaviour, int maxDepth, bool exhausted)
        {
            var verb = VerbFor(behaviour);
            var notes = new List<string>();

            // Detached counts as something happening. Saying "affects no other table" while the
            // panel prints its own "keep their records, lose the link" list directly underneath
            // contradicts the screen the sentence is on.
            if (result.Affected.Count == 0 && result.Blockers.Count == 0 && result.Detached.Count == 0)
            {
                notes.Add(behaviour == "Delete"
                    ? "Deleting one of these records affects no other table. Nothing cascades from it."
                    : "This behaviour does not cascade from this table to any other.");
            }

            if (result.Detached.Count > 0)
            {
                notes.Add(result.Detached.Count == 1
                    ? "One related table keeps its records and loses the link to this one."
                    : result.Detached.Count + " related tables keep their records and lose the link to this one.");
            }

            if (result.Truncated)
            {
                notes.Add("Stopped at " + MaxTables + " tables, so there is more to find. A chain " +
                          "this wide usually means a cascade is set wider than it needs to be.");
            }
            else if (!exhausted && result.ReachedDepth >= maxDepth)
            {
                // Only when the walk was actually cut off, not when a chain simply finished on
                // its deepest hop.
                notes.Add("The chain was still going at " + maxDepth + " hops and was stopped there. " +
                          "Raise the hop limit to see the rest.");
            }

            if (result.SelfReferencing)
            {
                notes.Add("This table also cascades to itself, so a parent record takes its " +
                          "children in the same table with it.");
            }

            if (result.Unreadable.Count > 0)
            {
                notes.Add(result.Unreadable.Count + " " +
                          (result.Unreadable.Count == 1 ? "table" : "tables") +
                          " could not be read (" + string.Join(", ", result.Unreadable.Take(3)) +
                          (result.Unreadable.Count > 3 ? ", ..." : "") +
                          "), so anything reachable only through " +
                          (result.Unreadable.Count == 1 ? "it" : "them") + " is missing from this answer.");
            }

            return notes.Count == 0 ? null : string.Join(" ", notes);
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

        private enum CascadeOutcome
        {
            /// <summary>Nothing happens to the child records.</summary>
            None,

            /// <summary>The operation reaches the child records, so the walk continues through them.</summary>
            Propagates,

            /// <summary>Restrict: the operation is refused while child records exist.</summary>
            Blocks,

            /// <summary>RemoveLink: the child survives and its lookup is cleared.</summary>
            Detaches
        }
    }

    public class CascadeOptions
    {
        [JsonProperty("startTable")] public string StartTable { get; set; }

        /// <summary>"Delete", "Assign", "Share", "Unshare", "Reparent" or "Merge".</summary>
        [JsonProperty("behaviour")] public string Behaviour { get; set; } = "Delete";

        [JsonProperty("maxDepth")] public int MaxDepth { get; set; } = 6;
    }

    public class CascadeResult
    {
        [JsonProperty("startTable")] public string StartTable { get; set; }
        [JsonProperty("startDisplayName")] public string StartDisplayName { get; set; }
        [JsonProperty("behaviour")] public string Behaviour { get; set; }

        /// <summary>Tables the operation reaches, in hop order.</summary>
        [JsonProperty("affected")] public List<CascadeStep> Affected { get; set; } = new List<CascadeStep>();

        /// <summary>Relationships configured Restrict, which refuse the operation rather than passing it on.</summary>
        [JsonProperty("blockers")] public List<CascadeStep> Blockers { get; set; } = new List<CascadeStep>();

        /// <summary>Relationships configured RemoveLink: the child record survives, its lookup is cleared.</summary>
        [JsonProperty("detached")] public List<CascadeStep> Detached { get; set; } = new List<CascadeStep>();

        /// <summary>
        /// True when the behaviour cascades from the table back to itself - a parent-child
        /// hierarchy on one table. Reported in words rather than by listing the start table as a
        /// casualty of its own delete.
        /// </summary>
        [JsonProperty("selfReferencing")] public bool SelfReferencing { get; set; }

        [JsonProperty("reachedDepth")] public int ReachedDepth { get; set; }
        [JsonProperty("truncated")] public bool Truncated { get; set; }
        [JsonProperty("unreadable")] public List<string> Unreadable { get; set; } = new List<string>();
        [JsonProperty("message")] public string Message { get; set; }
    }

    /// <summary>One relationship on the chain, and what the behaviour does across it.</summary>
    public class CascadeStep
    {
        [JsonProperty("fromTable")] public string FromTable { get; set; }
        [JsonProperty("fromDisplayName")] public string FromDisplayName { get; set; }
        [JsonProperty("toTable")] public string ToTable { get; set; }
        [JsonProperty("toDisplayName")] public string ToDisplayName { get; set; }
        [JsonProperty("relationshipSchemaName")] public string RelationshipSchemaName { get; set; }
        [JsonProperty("lookupColumn")] public string LookupColumn { get; set; }

        /// <summary>The raw cascade value - Cascade, RemoveLink, Restrict, Active, UserOwned, NoCascade.</summary>
        [JsonProperty("action")] public string Action { get; set; }

        [JsonProperty("hops")] public int Hops { get; set; }
    }
}
