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
    /// Reconciles a saved diagram with the connected environment.
    ///
    /// Two rules govern everything here:
    /// nothing the user entered by hand is discarded silently, and a proposed object is never
    /// promoted to Existing automatically - a match is only ever offered for confirmation. That
    /// applies to tables, relationships and columns alike.
    /// </summary>
    public class RefreshService
    {
        private readonly MetadataService _metadata;
        private readonly Action<string, int> _progress;

        public RefreshService(MetadataService metadata, Action<string, int> progress = null)
        {
            _metadata = metadata ?? throw new ArgumentNullException(nameof(metadata));
            _progress = progress;
        }

        public RefreshOutcome Refresh(DiagramDocument document, CancellationToken cancellation = default(CancellationToken))
        {
            if (document == null) throw new ArgumentNullException(nameof(document));

            var report = new RefreshReport();

            Report("Re-reading the table catalogue...", 3);
            var catalogue = _metadata.GetCatalogue(forceRefresh: true);

            // Grouped rather than ToDictionary: a duplicate logical name should never happen, but
            // if metadata ever returns one, throwing here would fail the whole refresh over
            // something the user can neither see nor fix.
            var byLogicalName = catalogue
                .GroupBy(t => t.LogicalName, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            var tables = document.Tables.ToList();
            var index = 0;

            // Tables this refresh has already re-read from the environment. GetTable's cache lives
            // for the whole session, so without forcing it the comparison runs against whatever the
            // environment looked like the first time each table was loaded - and if the diagram was
            // built in this session, that includes the very first refresh. Forced once per table
            // and remembered here, because the relationship pass reads the same tables again and a
            // forced read has already replaced the cache entry.
            var reread = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var table in tables)
            {
                cancellation.ThrowIfCancellationRequested();
                index++;

                Report(
                    "Checking " + (table.DisplayName ?? table.LogicalName ?? "table") +
                    " (" + index + " of " + tables.Count + ")",
                    (int)(5 + 80.0 * index / Math.Max(1, tables.Count)));

                if (table.Status == ObjectStatus.Proposed)
                {
                    var candidate = FindPromotionCandidate(table, catalogue);
                    if (candidate != null)
                    {
                        report.PromotionCandidates.Add(new PromotionCandidate
                        {
                            DiagramObjectId = table.Id,
                            ObjectKind = "table",
                            ProposedName = table.DisplayName,
                            MatchedLogicalName = candidate.Match.LogicalName,
                            MatchedDisplayName = candidate.Match.DisplayName,
                            MatchReason = candidate.Reason,
                            Confidence = candidate.Confidence
                        });
                    }

                    continue;
                }

                if (table.Status == ObjectStatus.External) continue;

                if (string.IsNullOrEmpty(table.LogicalName)) continue;

                if (!byLogicalName.ContainsKey(table.LogicalName))
                {
                    table.MissingSinceRefresh = true;
                    report.Missing.Add(new RefreshChange
                    {
                        DiagramObjectId = table.Id,
                        ObjectKind = "table",
                        Name = table.DisplayName,
                        Detail = table.LogicalName + " was not found in this environment."
                    });
                    continue;
                }

                var fresh = ReadForRefresh(table.LogicalName, reread);
                if (fresh == null)
                {
                    table.MissingSinceRefresh = true;
                    report.Missing.Add(new RefreshChange
                    {
                        DiagramObjectId = table.Id,
                        ObjectKind = "table",
                        Name = table.DisplayName,
                        Detail = "Metadata for " + table.LogicalName + " could not be retrieved."
                    });
                    continue;
                }

                table.MissingSinceRefresh = false;
                var changes = MergeTable(table, fresh, report.PromotionCandidates);

                if (changes.Count > 0)
                {
                    report.Changed.Add(new RefreshChange
                    {
                        DiagramObjectId = table.Id,
                        ObjectKind = "table",
                        Name = table.DisplayName,
                        Detail = string.Join("; ", changes)
                    });
                }
                else
                {
                    report.Found.Add(new RefreshChange
                    {
                        DiagramObjectId = table.Id,
                        ObjectKind = "table",
                        Name = table.DisplayName,
                        Detail = "Unchanged."
                    });
                }
            }

            Report("Checking relationships...", 88);
            RefreshRelationships(document, report, reread, cancellation);

            document.Source.LastRefreshUtc = DateTime.UtcNow;

            Report("Comparing results...", 99);
            return new RefreshOutcome { Report = report, Document = document };
        }

        /// <summary>
        /// Table metadata for a refresh: read live the first time each table is asked for during
        /// one refresh pass, and from the cache the forced read just replaced after that.
        /// </summary>
        private TableMetadataDto ReadForRefresh(string logicalName, HashSet<string> reread)
        {
            if (string.IsNullOrEmpty(logicalName)) return null;

            // Add returns true only for the first time this pass has seen the name, which is
            // exactly when the environment has to be asked again.
            return _metadata.GetTable(logicalName, reread.Add(logicalName));
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

        private void RefreshRelationships(
            DiagramDocument document,
            RefreshReport report,
            HashSet<string> reread,
            CancellationToken cancellation)
        {
            // Index every relationship currently visible in the environment for the tables that
            // are on the diagram, so both existing-relationship checks and proposed-relationship
            // matching can use one lookup.
            var live = new Dictionary<string, RelationshipDto>(StringComparer.OrdinalIgnoreCase);

            foreach (var table in document.Tables.Where(t => t.Status != ObjectStatus.Proposed &&
                                                             t.Status != ObjectStatus.External &&
                                                             !string.IsNullOrEmpty(t.LogicalName)))
            {
                cancellation.ThrowIfCancellationRequested();

                var fresh = ReadForRefresh(table.LogicalName, reread);
                if (fresh == null) continue;

                // Merged rather than assigned. Metadata reports each 1:N from both of its ends, so
                // the same schema name arrives twice; merging keeps Kind normalised to OneToMany
                // so the ManyToOne view is never read as a cardinality change. See RelationshipViews.
                foreach (var relationship in fresh.Relationships)
                {
                    RelationshipDto merged;
                    live.TryGetValue(relationship.SchemaName, out merged);
                    live[relationship.SchemaName] = RelationshipViews.Merge(merged, relationship);
                }
            }

            foreach (var relationship in document.Relationships)
            {
                cancellation.ThrowIfCancellationRequested();

                if (relationship.Status == ObjectStatus.Proposed)
                {
                    RelationshipDto match;
                    if (!string.IsNullOrWhiteSpace(relationship.SchemaName) &&
                        live.TryGetValue(relationship.SchemaName, out match))
                    {
                        report.PromotionCandidates.Add(new PromotionCandidate
                        {
                            DiagramObjectId = relationship.Id,
                            ObjectKind = "relationship",
                            ProposedName = relationship.SchemaName,
                            MatchedLogicalName = match.SchemaName,
                            MatchedDisplayName = match.DisplayName,
                            MatchReason = "A relationship with this schema name now exists.",
                            Confidence = "high"
                        });
                    }

                    continue;
                }

                if (relationship.Status == ObjectStatus.External) continue;
                if (string.IsNullOrWhiteSpace(relationship.SchemaName)) continue;

                RelationshipDto current;
                if (!live.TryGetValue(relationship.SchemaName, out current))
                {
                    relationship.MissingSinceRefresh = true;
                    report.Missing.Add(new RefreshChange
                    {
                        DiagramObjectId = relationship.Id,
                        ObjectKind = "relationship",
                        Name = relationship.SchemaName,
                        Detail = "This relationship was not found in the environment."
                    });
                    continue;
                }

                relationship.MissingSinceRefresh = false;
                var changes = new List<string>();

                if (!string.Equals(relationship.ReferencingAttribute, current.ReferencingAttribute, StringComparison.OrdinalIgnoreCase))
                {
                    changes.Add("lookup column changed from " +
                                (relationship.ReferencingAttribute ?? "(none)") + " to " +
                                (current.ReferencingAttribute ?? "(none)"));
                    relationship.ReferencingAttribute = current.ReferencingAttribute;
                }

                if (relationship.Kind != current.Kind)
                {
                    changes.Add("cardinality changed from " + relationship.Kind + " to " + current.Kind);
                    relationship.Kind = current.Kind;
                }

                // The null case is handled rather than guarded away. A relationship that had a
                // cascade configuration and no longer reports one - an N:N, or one whose config
                // was dropped - is reported, and the stale configuration is cleared from the card.
                if (current.Cascade == null)
                {
                    if (relationship.Cascade != null)
                    {
                        changes.Add("no longer reports a cascade configuration");
                        relationship.Cascade = null;
                    }
                }
                else if (!current.Cascade.ValueEquals(relationship.Cascade))
                {
                    changes.Add(DescribeCascadeChange(relationship.Cascade, current.Cascade));
                    relationship.Cascade = current.Cascade;
                }

                // Anything a user would recognise on the diagram is reported when it changes, so
                // a relationship renamed or reclassified in the environment shows in the summary.
                if (!string.Equals(relationship.DisplayName, current.DisplayName, StringComparison.Ordinal))
                {
                    changes.Add("name changed from '" + (relationship.DisplayName ?? "(none)") +
                                "' to '" + (current.DisplayName ?? "(none)") + "'");
                }

                if (relationship.IsCustom != current.IsCustom)
                {
                    changes.Add(current.IsCustom
                        ? "is now a custom relationship"
                        : "is now a system relationship");
                }

                if (relationship.IsHierarchical != current.IsHierarchical)
                {
                    changes.Add(current.IsHierarchical
                        ? "is now marked hierarchical"
                        : "is no longer marked hierarchical");
                }

                if (relationship.IsPolymorphic != current.IsPolymorphic)
                {
                    changes.Add(current.IsPolymorphic
                        ? "the lookup behind it now has more than one target table"
                        : "the lookup behind it now has a single target table");
                }

                if (!string.Equals(relationship.IntersectEntity, current.IntersectEntity, StringComparison.OrdinalIgnoreCase))
                {
                    changes.Add("intersect table changed from " +
                                (relationship.IntersectEntity ?? "(none)") + " to " +
                                (current.IntersectEntity ?? "(none)"));
                }

                relationship.DisplayName = current.DisplayName;
                relationship.IsCustom = current.IsCustom;
                relationship.IsManaged = current.IsManaged;
                relationship.IsHierarchical = current.IsHierarchical;
                relationship.IsPolymorphic = current.IsPolymorphic;
                relationship.LookupTargets = current.LookupTargets;
                relationship.IntersectEntity = current.IntersectEntity;
                relationship.MetadataId = current.MetadataId;

                if (changes.Count > 0)
                {
                    report.Changed.Add(new RefreshChange
                    {
                        DiagramObjectId = relationship.Id,
                        ObjectKind = "relationship",
                        Name = relationship.SchemaName,
                        Detail = string.Join("; ", changes)
                    });
                }
            }

            ReportNewRelationships(document, report, live, cancellation);
        }

        /// <summary>
        /// Relationships that exist in the environment between two tables that are both already on
        /// the diagram, and that the diagram does not have.
        ///
        /// Reported and nothing else. Nothing is ever added to a diagram without the user saying
        /// so, and that applies to relationships exactly as it does to tables, so the report line
        /// is the whole output. The user draws it if they want it.
        ///
        /// The wording says "exists" rather than "is new": a connector the user removed from the
        /// diagram looks exactly the same from here.
        /// </summary>
        private static void ReportNewRelationships(
            DiagramDocument document,
            RefreshReport report,
            Dictionary<string, RelationshipDto> live,
            CancellationToken cancellation)
        {
            var alreadyDrawn = new HashSet<string>(
                document.Relationships
                    .Where(r => !string.IsNullOrWhiteSpace(r.SchemaName))
                    .Select(r => r.SchemaName),
                StringComparer.OrdinalIgnoreCase);

            var onDiagram = new HashSet<string>(
                document.Tables
                    .Where(t => t.Status != ObjectStatus.Proposed &&
                                t.Status != ObjectStatus.External &&
                                !string.IsNullOrEmpty(t.LogicalName))
                    .Select(t => t.LogicalName),
                StringComparer.OrdinalIgnoreCase);

            foreach (var candidate in live.Values.OrderBy(r => r.SchemaName, StringComparer.OrdinalIgnoreCase))
            {
                cancellation.ThrowIfCancellationRequested();

                if (string.IsNullOrWhiteSpace(candidate.SchemaName)) continue;
                if (alreadyDrawn.Contains(candidate.SchemaName)) continue;

                // Both ends have to be cards the user is already looking at. A relationship to a
                // table that is not on the diagram is not news about this diagram.
                if (!onDiagram.Contains(candidate.ReferencedEntity ?? string.Empty)) continue;
                if (!onDiagram.Contains(candidate.ReferencingEntity ?? string.Empty)) continue;

                report.Changed.Add(new RefreshChange
                {
                    ObjectKind = "relationship",
                    Name = candidate.SchemaName,
                    Detail = "This relationship exists in the environment, between " +
                             candidate.ReferencedEntity + " and " + candidate.ReferencingEntity +
                             ", and is not on the diagram. Add it if you want it drawn."
                });
            }
        }

        private static string DescribeCascadeChange(CascadeConfiguration before, CascadeConfiguration after)
        {
            if (before == null) return "cascade configuration is now available";

            var parts = new List<string>();
            Compare(parts, "Assign", before.Assign, after.Assign);
            Compare(parts, "Delete", before.Delete, after.Delete);
            Compare(parts, "Merge", before.Merge, after.Merge);
            Compare(parts, "Reparent", before.Reparent, after.Reparent);
            Compare(parts, "Share", before.Share, after.Share);
            Compare(parts, "Unshare", before.Unshare, after.Unshare);

            return parts.Count == 0
                ? "cascade configuration changed"
                : "cascade " + string.Join(", ", parts);
        }

        private static void Compare(List<string> parts, string label, string before, string after)
        {
            if (string.Equals(before, after, StringComparison.Ordinal)) return;
            parts.Add(label + ": " + (before ?? "(none)") + " -> " + (after ?? "(none)"));
        }

        /// <summary>
        /// Applies fresh metadata to an existing table while keeping everything the user chose:
        /// position, highlight, notes, detail override, column selection, and any proposed columns
        /// they added to a real table.
        ///
        /// Pass <paramref name="candidates"/> during a refresh so proposed columns that now exist
        /// for real are offered for confirmation; pass null when replaying the merge after a
        /// promotion, where the question has already been answered.
        /// </summary>
        private static List<string> MergeTable(
            DiagramTable table, TableMetadataDto fresh, List<PromotionCandidate> candidates = null)
        {
            var changes = new List<string>();

            // Non-null candidates means "this is a live refresh". When the merge is replayed after
            // a promotion the same comparisons would fire a second time and report changes the
            // user has already seen, so the reporting-only branches are skipped.
            var isRefresh = candidates != null;
            var added = new List<string>();

            if (!string.Equals(table.DisplayName, fresh.DisplayName, StringComparison.Ordinal))
            {
                changes.Add("display name changed from '" + table.DisplayName + "' to '" + fresh.DisplayName + "'");
                table.DisplayName = fresh.DisplayName;
            }

            if (!string.Equals(table.SchemaName, fresh.SchemaName, StringComparison.Ordinal) &&
                !string.IsNullOrEmpty(table.SchemaName))
            {
                changes.Add("schema name changed from " + table.SchemaName + " to " + fresh.SchemaName);
            }

            if (table.IsCustom != fresh.IsCustom)
            {
                changes.Add(fresh.IsCustom ? "is now a custom table" : "is now a system table");
            }

            // Ownership is a security decision, so a change to it is one of the more consequential
            // things a refresh can find - it moves who can see the records, not just how the table
            // is drawn.
            //
            // Reported only when both sides have a value. A diagram saved before ownership was
            // read has none, and reporting "changed from unknown to user or team owned" for every
            // table on its first refresh would bury the changes that matter; the reverse, where
            // the environment stops reporting one, is a metadata-read artefact rather than
            // anything a user did.
            if (!string.Equals(table.OwnershipType, fresh.OwnershipType, StringComparison.Ordinal) &&
                !string.IsNullOrEmpty(table.OwnershipType) &&
                !string.IsNullOrEmpty(fresh.OwnershipType))
            {
                changes.Add("ownership changed from " + DescribeOwnership(table.OwnershipType) +
                            " to " + DescribeOwnership(fresh.OwnershipType));
            }

            var keysBefore = DescribeKeys(table.AlternateKeys);
            var keysAfter = DescribeKeys(fresh.AlternateKeys);
            if (!string.Equals(keysBefore, keysAfter, StringComparison.OrdinalIgnoreCase))
            {
                changes.Add("alternate keys changed from " +
                            (keysBefore.Length == 0 ? "(none)" : keysBefore) + " to " +
                            (keysAfter.Length == 0 ? "(none)" : keysAfter));
            }

            table.SchemaName = fresh.SchemaName;
            table.MetadataId = fresh.MetadataId;
            table.ObjectTypeCode = fresh.ObjectTypeCode;
            table.PrimaryIdAttribute = fresh.PrimaryIdAttribute;
            table.PrimaryNameAttribute = fresh.PrimaryNameAttribute;
            table.IsCustom = fresh.IsCustom;
            table.IsManaged = fresh.IsManaged;
            table.IsActivity = fresh.IsActivity;
            table.IsIntersect = fresh.IsIntersect;
            table.OwnershipType = fresh.OwnershipType;
            table.Description = fresh.Description;
            table.AlternateKeys = fresh.AlternateKeys;

            // Grouped rather than ToDictionary, for the same reason as the catalogue lookups: a
            // hand-edited .dvmd with two columns of the same logical name - or two differing only
            // in case, which this comparer treats as one - would otherwise throw and fail the
            // entire refresh over something the user can neither see nor fix.
            var existingByName = table.Columns
                .Where(c => c.Status != ObjectStatus.Proposed && !string.IsNullOrEmpty(c.LogicalName))
                .GroupBy(c => c.LogicalName, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            var proposedColumns = table.Columns.Where(c => c.Status == ObjectStatus.Proposed).ToList();

            // Proposed columns whose intended schema name now exists for real. Like a proposed
            // table, nothing is promoted here - a candidate is offered and the user confirms it.
            //
            // Built on every pass, not only when candidates are being collected. What this decides
            // is that the *real* column is held off the card while a proposal of the same name is
            // still standing, and that is true whether or not anything is being offered. Promoting
            // a proposed table re-runs this with candidates == null, and the hold-back stops each
            // proposed column landing on the card twice - once as fresh metadata and once from the
            // AddRange at the end of this method.
            var awaitingConfirmation = proposedColumns
                .Where(c => !string.IsNullOrWhiteSpace(c.LogicalName))
                .GroupBy(c => c.LogicalName, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

            var merged = new List<DiagramColumn>();
            foreach (var freshColumn in fresh.Columns)
            {
                DiagramColumn proposal;
                if (awaitingConfirmation.TryGetValue(freshColumn.LogicalName ?? string.Empty, out proposal))
                {
                    // A lookup column that belongs to a proposed relationship is not a proposal in
                    // its own right - it *is* that relationship, which is offered separately in
                    // RefreshRelationships. Offering the column separately would allow confirming
                    // a lookup without its relationship - a state Dataverse cannot be in.
                    if (candidates != null && string.IsNullOrEmpty(proposal.FromRelationshipId))
                    {
                        candidates.Add(new PromotionCandidate
                        {
                            DiagramObjectId = proposal.Id,
                            ParentTableId = table.Id,
                            ObjectKind = "column",
                            ProposedName = (table.DisplayName ?? table.LogicalName) + "." +
                                           (proposal.DisplayName ?? proposal.LogicalName),
                            MatchedLogicalName = freshColumn.LogicalName,
                            MatchedDisplayName = freshColumn.DisplayName,
                            MatchReason = "The column '" + freshColumn.LogicalName + "' now exists on " +
                                          (table.DisplayName ?? table.LogicalName) + ".",
                            Confidence = "high"
                        });
                    }

                    awaitingConfirmation.Remove(freshColumn.LogicalName);

                    // The real column of the same name is accounted for here rather than left in
                    // existingByName, whose leftovers are reported as "no longer exists" at the end
                    // of the merge. A proposal can shadow a real column easily - the proposed-column
                    // editor derives the logical name from the display name with no duplicate check,
                    // so proposing "Name" on Account collides at once - and the real column must not
                    // then be reported as gone.
                    existingByName.Remove(freshColumn.LogicalName);

                    // The real column is deliberately left off the card while the match is
                    // unconfirmed. Adding it would put two identically named rows on the same
                    // table - the proposed one and its real twin - which reads as a bug. If the
                    // user declines, the match is simply offered again on the next refresh, the
                    // same as a declined proposed table.
                    continue;
                }

                DiagramColumn previous;
                if (existingByName.TryGetValue(freshColumn.LogicalName ?? string.Empty, out previous))
                {
                    // Carry the user's choices forward onto the refreshed metadata.
                    freshColumn.Selected = previous.Selected;
                    freshColumn.Notes = previous.Notes;
                    freshColumn.Status = previous.Status == ObjectStatus.Deprecated
                        ? ObjectStatus.Deprecated
                        : ObjectStatus.Existing;

                    if (!string.Equals(previous.TypeName, freshColumn.TypeName, StringComparison.Ordinal))
                        changes.Add("column " + freshColumn.LogicalName + " type changed from " + previous.TypeName + " to " + freshColumn.TypeName);

                    if (!string.Equals(previous.DisplayName, freshColumn.DisplayName, StringComparison.Ordinal))
                    {
                        changes.Add("column " + freshColumn.LogicalName + " renamed from '" +
                                    (previous.DisplayName ?? "(none)") + "' to '" +
                                    (freshColumn.DisplayName ?? "(none)") + "'");
                    }

                    if (previous.IsRequired != freshColumn.IsRequired)
                    {
                        changes.Add("column " + freshColumn.LogicalName +
                                    (freshColumn.IsRequired ? " is now required" : " is no longer required"));
                    }

                    existingByName.Remove(freshColumn.LogicalName);
                }
                else if (isRefresh)
                {
                    // A column added in the environment since the diagram was last refreshed.
                    // Whether it is drawn depends on the detail mode; the change is reported either
                    // way, because "this table now has a column you have not seen" is the point.
                    added.Add(freshColumn.LogicalName ?? freshColumn.DisplayName);
                }

                merged.Add(freshColumn);
            }

            if (added.Count > 0)
            {
                changes.Add(added.Count == 1
                    ? "new column " + added[0]
                    : added.Count + " new columns: " + Summarise(added));
            }

            foreach (var removed in existingByName.Values)
            {
                changes.Add("column " + removed.LogicalName + " no longer exists");
            }

            merged.AddRange(proposedColumns);
            table.Columns = merged;

            return changes;
        }

        /// <summary>Ownership in words, for a change summary a non-developer has to read.</summary>
        internal static string DescribeOwnership(string ownershipType)
        {
            switch (ownershipType)
            {
                case "UserOwned": return "user or team owned";
                case "TeamOwned": return "team owned";
                case "OrganizationOwned": return "organisation owned";
                case "BusinessOwned": return "business unit owned";
                case "BusinessParented": return "business unit parented";
                case "None": return "not owned";
                case null:
                case "": return "unknown";
                default: return ownershipType;
            }
        }

        /// <summary>Comma list, capped so a table that gained forty columns still reads as one line.</summary>
        private static string Summarise(List<string> names)
        {
            const int shown = 6;
            if (names.Count <= shown) return string.Join(", ", names);
            return string.Join(", ", names.Take(shown)) + " and " + (names.Count - shown) + " more";
        }

        private static string DescribeKeys(List<AlternateKeyInfo> keys)
        {
            if (keys == null || keys.Count == 0) return string.Empty;

            return string.Join(", ", keys
                .Select(k => k.SchemaName ?? k.DisplayName)
                .Where(name => !string.IsNullOrEmpty(name))
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase));
        }

        /// <summary>
        /// Looks for a real table that appears to be the thing a proposed table described.
        /// Matching is deliberately conservative: schema name is treated as a strong signal,
        /// display name as a weak one, and nothing is applied without the user saying so.
        /// </summary>
        private static PromotionMatch FindPromotionCandidate(DiagramTable proposed, List<TableSummary> catalogue)
        {
            if (!string.IsNullOrWhiteSpace(proposed.SchemaName))
            {
                var bySchema = catalogue.FirstOrDefault(t =>
                    string.Equals(t.SchemaName, proposed.SchemaName, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(t.LogicalName, proposed.SchemaName, StringComparison.OrdinalIgnoreCase));

                if (bySchema != null)
                {
                    return new PromotionMatch
                    {
                        Match = bySchema,
                        Reason = "Schema name '" + proposed.SchemaName + "' now exists.",
                        Confidence = "high"
                    };
                }
            }

            if (!string.IsNullOrWhiteSpace(proposed.DisplayName))
            {
                var byDisplayName = catalogue.Where(t =>
                    string.Equals(t.DisplayName, proposed.DisplayName, StringComparison.CurrentCultureIgnoreCase)).ToList();

                if (byDisplayName.Count == 1)
                {
                    return new PromotionMatch
                    {
                        Match = byDisplayName[0],
                        Reason = "A table with the display name '" + proposed.DisplayName + "' exists (" +
                                 byDisplayName[0].LogicalName + "). Confirm this is the same table.",
                        Confidence = "low"
                    };
                }

                if (byDisplayName.Count > 1)
                {
                    return new PromotionMatch
                    {
                        Match = byDisplayName[0],
                        Reason = byDisplayName.Count + " tables share the display name '" + proposed.DisplayName +
                                 "'. Check which one you meant before promoting.",
                        Confidence = "ambiguous"
                    };
                }
            }

            return null;
        }

        /// <summary>
        /// Turns confirmed proposed objects into existing ones, pulling in real metadata.
        /// Position, notes, highlight and annotations are all preserved.
        /// </summary>
        public DiagramDocument Promote(DiagramDocument document, IEnumerable<PromotionInstruction> instructions)
        {
            foreach (var instruction in instructions ?? Enumerable.Empty<PromotionInstruction>())
            {
                if (string.Equals(instruction.ObjectKind, "table", StringComparison.OrdinalIgnoreCase))
                {
                    var table = document.FindTableById(instruction.DiagramObjectId);
                    if (table == null) continue;

                    var fresh = _metadata.GetTable(instruction.MatchedLogicalName);
                    if (fresh == null) continue;

                    table.Status = ObjectStatus.Existing;
                    table.LogicalName = fresh.LogicalName;
                    MergeTable(table, fresh);
                }
                else if (string.Equals(instruction.ObjectKind, "column", StringComparison.OrdinalIgnoreCase))
                {
                    PromoteColumn(document, instruction);
                }
                else
                {
                    PromoteRelationship(document, instruction);
                }
            }

            return document;
        }

        /// <summary>
        /// Turns a confirmed proposed relationship into an existing one, taking the metadata it
        /// was matched against and bringing its lookup column with it.
        ///
        /// A proposed relationship owns a lookup *column* whose name the tool invented, so
        /// promoting the relationship replaces that column with the one Dataverse actually has,
        /// rather than settling the invented one as though it were real.
        /// </summary>
        private void PromoteRelationship(DiagramDocument document, PromotionInstruction instruction)
        {
            var relationship = document.Relationships
                .FirstOrDefault(r => string.Equals(r.Id, instruction.DiagramObjectId, StringComparison.Ordinal));
            if (relationship == null) return;

            relationship.Status = ObjectStatus.Existing;

            var match = FindLiveRelationship(document, instruction.MatchedLogicalName ?? relationship.SchemaName);
            if (match == null) return;

            // The two ends, resolved from the environment's own view of the relationship rather
            // than left as the user drew them. The proposal was matched on schema name alone, so
            // its ends may well be the other way round from the environment's - a developer
            // drawing a lookup naturally puts it on the table they are thinking about, which is as
            // often the "one" end as the "many" end. SettleOwnedLookup decides which card owns the
            // lookup column from ToTableId, so the ends must match the environment for the
            // column to be settled on the correct card.
            var referenced = document.FindExistingTable(match.ReferencedEntity);
            var referencing = document.FindExistingTable(match.ReferencingEntity);

            relationship.SchemaName = match.SchemaName;
            relationship.DisplayName = match.DisplayName;
            relationship.MetadataId = match.MetadataId;

            // Safe to take directly: FindLiveRelationship returns the merged form, so this is
            // OneToMany or ManyToMany and never the ManyToOne view of a 1:N.
            relationship.Kind = match.Kind;
            relationship.ReferencedEntity = match.ReferencedEntity;
            relationship.ReferencingEntity = match.ReferencingEntity;
            relationship.ReferencedAttribute = match.ReferencedAttribute;
            relationship.IntersectEntity = match.IntersectEntity;
            relationship.Entity1IntersectAttribute = match.Entity1IntersectAttribute;
            relationship.Entity2IntersectAttribute = match.Entity2IntersectAttribute;
            relationship.IsCustom = match.IsCustom;
            relationship.IsManaged = match.IsManaged;
            relationship.IsHierarchical = match.IsHierarchical;
            relationship.IsPolymorphic = match.IsPolymorphic;
            relationship.LookupTargets = match.LookupTargets;
            relationship.Cascade = match.Cascade;

            if (referenced == null || referencing == null)
            {
                // One end of the real relationship is not a table on this diagram, so there is no
                // card to move the lookup onto. Guessing would settle a column onto a table that
                // does not have it - a fabricated column presented as real - so the proposal's own
                // ends are left exactly as the user drew them and nothing is settled.
                relationship.ReferencingAttribute = match.ReferencingAttribute;
                return;
            }

            // The corners a user placed by hand were placed around the shape the connector had
            // while it ran the other way. Visited in the order they are held in, a reversed route
            // draws back over itself, so the routing goes with the ends; the automatic route is the
            // only honest drawing of a connector whose two ends have just changed places.
            var repointed = !string.Equals(relationship.FromTableId, referenced.Id, StringComparison.Ordinal)
                || !string.Equals(relationship.ToTableId, referencing.Id, StringComparison.Ordinal);

            relationship.FromTableId = referenced.Id;
            relationship.ToTableId = referencing.Id;

            if (repointed)
            {
                relationship.Waypoints = new List<PointD>();
                relationship.RouteOffset = 0;
                relationship.RouteOffsetCross = 0;
            }

            SettleOwnedLookup(document, relationship, match.ReferencingAttribute);
            relationship.ReferencingAttribute = match.ReferencingAttribute;
        }

        /// <summary>
        /// The live relationship with the given schema name, found by asking the tables on the
        /// diagram. Metadata is cached per connection, so this costs nothing after a refresh.
        ///
        /// What comes back is the merged form, not the first DTO view this scan happens to reach.
        /// Metadata reports each 1:N from both ends, and only the merged form has Kind normalised
        /// to OneToMany and the lookup targets of a polymorphic lookup.
        /// </summary>
        private RelationshipDto FindLiveRelationship(DiagramDocument document, string schemaName)
        {
            if (string.IsNullOrWhiteSpace(schemaName)) return null;

            foreach (var table in document.Tables.Where(t => t.Status != ObjectStatus.Proposed &&
                                                             t.Status != ObjectStatus.External &&
                                                             !string.IsNullOrEmpty(t.LogicalName)))
            {
                var fresh = _metadata.GetTable(table.LogicalName);
                if (fresh == null) continue;

                // Both views at once when this is a self-referencing relationship, which is the
                // one case where a single table's metadata carries the pair.
                RelationshipDto merged = null;
                foreach (var view in fresh.Relationships.Where(r =>
                    string.Equals(r.SchemaName, schemaName, StringComparison.OrdinalIgnoreCase)))
                {
                    merged = RelationshipViews.Merge(merged, view);
                }

                if (merged == null) continue;

                // The referencing table holds the lookup column, so its view is the only one that
                // can report a polymorphic lookup. One extra cached read, and only when the
                // relationship was found from the other end.
                if (merged.Kind != RelationshipKind.ManyToMany &&
                    !string.Equals(merged.ReferencingEntity, table.LogicalName, StringComparison.OrdinalIgnoreCase))
                {
                    var many = document.FindExistingTable(merged.ReferencingEntity);
                    var manySide = many == null ? null : _metadata.GetTable(many.LogicalName);

                    if (manySide != null)
                    {
                        foreach (var view in manySide.Relationships.Where(r =>
                            string.Equals(r.SchemaName, schemaName, StringComparison.OrdinalIgnoreCase)))
                        {
                            merged = RelationshipViews.Merge(merged, view);
                        }
                    }
                }

                return merged;
            }

            return null;
        }

        /// <summary>
        /// Replaces the lookup column a promoted relationship owns with the real one.
        ///
        /// The owned column carries a name the tool derived, which is very often not the name the
        /// developer used. Once the relationship is real, so is its column, and the user confirmed
        /// both with one tick - a relationship and its lookup are one object in Dataverse.
        /// </summary>
        private void SettleOwnedLookup(DiagramDocument document, DiagramRelationship relationship, string realName)
        {
            if (string.IsNullOrWhiteSpace(realName)) return;

            var many = document.FindTableById(relationship.ToTableId);
            if (many == null) return;

            var owned = many.Columns.FirstOrDefault(c =>
                string.Equals(c.FromRelationshipId, relationship.Id, StringComparison.Ordinal));
            if (owned == null) return;

            // The name, but never the table's own primary key, which can share the name and is
            // not the relationship's lookup. Requiring IsLookup instead would be too strict: a real
            // lookup read back from a table that this refresh cannot re-read carries no flag.
            var already = many.Columns.FirstOrDefault(c =>
                c != owned && !c.IsPrimaryId &&
                string.Equals(c.LogicalName, realName, StringComparison.OrdinalIgnoreCase));

            // The real column is already on the card - the developer used the name the tool
            // guessed, or a previous refresh brought it in. The invented row is the duplicate.
            if (already != null)
            {
                many.Columns.Remove(owned);
                already.Status = ObjectStatus.Existing;
                already.FromRelationshipId = null;
                return;
            }

            var index = many.Columns.IndexOf(owned);
            var fresh = string.IsNullOrEmpty(many.LogicalName) ? null : _metadata.GetTable(many.LogicalName);

            var freshColumn = fresh == null ? null : fresh.Columns.FirstOrDefault(c =>
                string.Equals(c.LogicalName, realName, StringComparison.OrdinalIgnoreCase));

            if (freshColumn == null)
            {
                // The table is not one this refresh can read - an external or proposed one at the
                // many end. Renaming is still right: the connector anchors to the row by name.
                owned.LogicalName = realName;
                owned.Status = ObjectStatus.Existing;
                owned.FromRelationshipId = null;
                return;
            }

            freshColumn.Selected = owned.Selected;
            freshColumn.Notes = owned.Notes;
            freshColumn.Status = ObjectStatus.Existing;

            many.Columns[index] = freshColumn;
        }

        /// <summary>
        /// Replaces a confirmed proposed column with the real metadata, in place so the column
        /// keeps its position on the card. The user's visibility choice and note survive.
        /// </summary>
        private void PromoteColumn(DiagramDocument document, PromotionInstruction instruction)
        {
            var table = document.FindTableById(instruction.ParentTableId);
            if (table == null || string.IsNullOrEmpty(table.LogicalName)) return;

            var index = table.Columns.FindIndex(c =>
                string.Equals(c.Id, instruction.DiagramObjectId, StringComparison.Ordinal));
            if (index < 0) return;

            var proposal = table.Columns[index];
            if (proposal.Status != ObjectStatus.Proposed) return;

            var fresh = _metadata.GetTable(table.LogicalName);
            if (fresh == null) return;

            var freshColumn = fresh.Columns.FirstOrDefault(c =>
                string.Equals(c.LogicalName, instruction.MatchedLogicalName, StringComparison.OrdinalIgnoreCase));
            if (freshColumn == null) return;

            // The proposed column is the only copy on the card - MergeTable left the real one off
            // while the match was unconfirmed - so this is a straight replacement, not a merge.
            freshColumn.Selected = proposal.Selected;
            freshColumn.Notes = proposal.Notes;
            freshColumn.Status = ObjectStatus.Existing;

            table.Columns[index] = freshColumn;

            if (freshColumn.IsPrimaryId) table.PrimaryIdAttribute = freshColumn.LogicalName;
        }

        private class PromotionMatch
        {
            public TableSummary Match { get; set; }
            public string Reason { get; set; }
            public string Confidence { get; set; }
        }
    }

    public class RefreshOutcome
    {
        [JsonProperty("report")] public RefreshReport Report { get; set; }
        [JsonProperty("document")] public DiagramDocument Document { get; set; }
    }

    public class RefreshReport
    {
        [JsonProperty("found")] public List<RefreshChange> Found { get; set; } = new List<RefreshChange>();
        [JsonProperty("changed")] public List<RefreshChange> Changed { get; set; } = new List<RefreshChange>();
        [JsonProperty("missing")] public List<RefreshChange> Missing { get; set; } = new List<RefreshChange>();
        [JsonProperty("promotionCandidates")] public List<PromotionCandidate> PromotionCandidates { get; set; } = new List<PromotionCandidate>();
    }

    public class RefreshChange
    {
        [JsonProperty("diagramObjectId")] public string DiagramObjectId { get; set; }
        [JsonProperty("objectKind")] public string ObjectKind { get; set; }
        [JsonProperty("name")] public string Name { get; set; }
        [JsonProperty("detail")] public string Detail { get; set; }
    }

    public class PromotionCandidate
    {
        [JsonProperty("diagramObjectId")] public string DiagramObjectId { get; set; }

        /// <summary>Set for columns, whose id is only unique within their table.</summary>
        [JsonProperty("parentTableId")] public string ParentTableId { get; set; }

        /// <summary>table, relationship or column.</summary>
        [JsonProperty("objectKind")] public string ObjectKind { get; set; }
        [JsonProperty("proposedName")] public string ProposedName { get; set; }
        [JsonProperty("matchedLogicalName")] public string MatchedLogicalName { get; set; }
        [JsonProperty("matchedDisplayName")] public string MatchedDisplayName { get; set; }
        [JsonProperty("matchReason")] public string MatchReason { get; set; }

        /// <summary>high, low or ambiguous. Only "high" is pre-ticked in the review dialog.</summary>
        [JsonProperty("confidence")] public string Confidence { get; set; }
    }

    public class PromotionInstruction
    {
        [JsonProperty("diagramObjectId")] public string DiagramObjectId { get; set; }

        /// <summary>Required for columns; ignored for tables and relationships.</summary>
        [JsonProperty("parentTableId")] public string ParentTableId { get; set; }

        [JsonProperty("objectKind")] public string ObjectKind { get; set; }
        [JsonProperty("matchedLogicalName")] public string MatchedLogicalName { get; set; }
    }
}
