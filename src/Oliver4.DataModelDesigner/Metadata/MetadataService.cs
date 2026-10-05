using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Messages;
using Microsoft.Xrm.Sdk.Metadata;
using Microsoft.Xrm.Sdk.Query;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Metadata
{
    /// <summary>
    /// All Dataverse metadata access lives here. Nothing in this class writes to the environment:
    /// every request is a retrieve. Results are cached per instance, and the instance is thrown
    /// away when the XrmToolBox connection changes.
    /// </summary>
    public class MetadataService
    {
        private readonly IOrganizationService _service;
        private readonly object _sync = new object();

        private List<TableSummary> _catalogue;
        private readonly Dictionary<string, TableMetadataDto> _tableCache =
            new Dictionary<string, TableMetadataDto>(StringComparer.OrdinalIgnoreCase);

        public MetadataService(IOrganizationService service)
        {
            _service = service ?? throw new ArgumentNullException(nameof(service));
        }

        /// <summary>Raised so the UI can show what a long retrieve is doing.</summary>
        public event EventHandler<MetadataProgressEventArgs> Progress;

        private void ReportProgress(string message, int percent)
        {
            Progress?.Invoke(this, new MetadataProgressEventArgs(message, percent));
        }

        public void ClearCache()
        {
            lock (_sync)
            {
                _catalogue = null;
                _tableCache.Clear();
            }
        }

        // ------------------------------------------------------------------
        // Failure translation
        // ------------------------------------------------------------------

        /// <summary>
        /// Turns an SDK failure into something a user can act on. The raw exceptions here are
        /// WCF and platform faults whose text ("The caller was not authenticated by the service")
        /// tells an architect nothing about what to do next.
        /// </summary>
        private static Exception Translate(Exception ex, string what)
        {
            if (ex is OperationCanceledException) return ex;

            var message = ex.Message ?? string.Empty;

            // Privileges first. A privilege fault is a specific, actionable problem with its own
            // fix, and its message text can look like an auth failure - Dataverse writes
            // "SecLib::CheckPrivilege failed. user: <guid>", and the guid may contain "401".
            if (IsPrivilegeFailure(message))
            {
                return new InvalidOperationException(
                    "Your account does not have permission to read metadata in this environment. " +
                    "Reading table and relationship metadata needs at least the System Customizer " +
                    "role, or an equivalent set of privileges. (" + message + ")", ex);
            }

            if (IsAuthFailure(ex, message))
            {
                return new InvalidOperationException(
                    "Dataverse rejected the sign-in while " + what + ". The connection has probably " +
                    "timed out. Reconnect using the XrmToolBox connection bar and try again.", ex);
            }

            if (IsNetworkFailure(ex, message))
            {
                return new InvalidOperationException(
                    "Could not reach the environment while " + what + ". Check your network " +
                    "connection and that the environment is still available, then try again.", ex);
            }

            return new InvalidOperationException(
                "Dataverse returned an error while " + what + ": " + message, ex);
        }

        private static bool IsPrivilegeFailure(string message)
        {
            return message.IndexOf("privilege", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("PrincipalPrivilegeDenied", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("CheckPrivilege", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// True for failures that mean the connection itself is unusable, as opposed to one table
        /// being unreadable. These must never be swallowed: doing so turns "your session expired"
        /// into "this environment appears to have no relationships", which is much worse.
        /// </summary>
        private static bool IsConnectionLevel(Exception ex)
        {
            var message = ex.Message ?? string.Empty;

            // A privilege fault is about one object, not about the connection, so it must not
            // abort a walk. Checked first for the same reason it is checked first in Translate.
            if (IsPrivilegeFailure(message)) return false;

            return IsAuthFailure(ex, message) || IsNetworkFailure(ex, message);
        }

        /// <summary>
        /// Phrases are matched whole and specifically.
        ///
        /// This decides whether a failure aborts an entire relationship walk or is recorded against
        /// one table, so bare substrings are not safe: Dataverse fault text routinely carries record
        /// guids, which can contain "401", and "expired" appears in the name of a real platform
        /// table, expiredprocess.
        /// </summary>
        private static bool IsAuthFailure(Exception ex, string message)
        {
            return IsWcfType(ex, "MessageSecurityException", "SecurityAccessDeniedException")
                || message.IndexOf("not authenticated", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("token expired", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("token has expired", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("authentication failed", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("(401)", StringComparison.Ordinal) >= 0
                || message.IndexOf("401 Unauthorized", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("Unauthorized", StringComparison.Ordinal) >= 0;
        }

        private static bool IsNetworkFailure(Exception ex, string message)
        {
            return ex is TimeoutException
                || IsWcfType(ex, "EndpointNotFoundException", "CommunicationException", "WebException")
                || message.IndexOf("remote name could not be resolved", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("unable to connect", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("connection was closed", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// Matched by name up the exception chain rather than by type.
        ///
        /// The WCF and System.Net exception types these describe come from the Dataverse SDK's
        /// dependencies, which the compile-verification build does not have. Matching on the name
        /// keeps one implementation working in both builds, and it walks the inner-exception chain
        /// because the SDK routinely wraps the real cause two or three deep.
        /// </summary>
        private static bool IsWcfType(Exception ex, params string[] names)
        {
            for (var current = ex; current != null; current = current.InnerException)
            {
                var typeName = current.GetType().Name;
                foreach (var name in names)
                {
                    if (string.Equals(typeName, name, StringComparison.Ordinal)) return true;
                }
            }

            return false;
        }

        // ------------------------------------------------------------------
        // Solutions
        // ------------------------------------------------------------------

        /// <summary>
        /// Unmanaged and managed solutions that are visible in the maker portal. The Default
        /// Solution and Active/Basic solutions are filtered out by the isvisible flag.
        /// </summary>
        public List<SolutionInfo> GetSolutions()
        {
            ReportProgress("Retrieving solutions...", 10);

            var query = new QueryExpression("solution")
            {
                ColumnSet = new ColumnSet("solutionid", "uniquename", "friendlyname", "version", "ismanaged"),
                Criteria = new FilterExpression
                {
                    Conditions =
                    {
                        new ConditionExpression("isvisible", ConditionOperator.Equal, true)
                    }
                },
                Orders = { new OrderExpression("friendlyname", OrderType.Ascending) },
                PageInfo = new PagingInfo { Count = 500, PageNumber = 1 }
            };

            var publisherLink = query.AddLink("publisher", "publisherid", "publisherid", JoinOperator.LeftOuter);
            publisherLink.EntityAlias = "pub";
            publisherLink.Columns = new ColumnSet("friendlyname");

            var results = new List<SolutionInfo>();
            EntityCollection page;
            do
            {
                try
                {
                    page = _service.RetrieveMultiple(query);
                }
                catch (Exception ex)
                {
                    throw Translate(ex, "reading the solution list");
                }

                foreach (var entity in page.Entities)
                {
                    results.Add(new SolutionInfo
                    {
                        Id = entity.Id.ToString(),
                        UniqueName = entity.GetAttributeValue<string>("uniquename"),
                        FriendlyName = entity.GetAttributeValue<string>("friendlyname"),
                        Version = entity.GetAttributeValue<string>("version"),
                        IsManaged = entity.GetAttributeValue<bool>("ismanaged"),
                        Publisher = GetAliasedString(entity, "pub.friendlyname")
                    });
                }

                query.PageInfo.PageNumber++;
                query.PageInfo.PagingCookie = page.PagingCookie;
            }
            while (page.MoreRecords);

            ReportProgress("Retrieved " + results.Count + " solutions.", 100);
            return results;
        }

        /// <summary>
        /// Metadata ids of the tables that are components of a solution. Returns metadata ids
        /// rather than logical names because that is what solutioncomponent stores.
        /// </summary>
        public HashSet<Guid> GetSolutionTableIds(Guid solutionId)
        {
            var query = new QueryExpression("solutioncomponent")
            {
                ColumnSet = new ColumnSet("objectid", "componenttype"),
                Criteria = new FilterExpression
                {
                    Conditions =
                    {
                        new ConditionExpression("solutionid", ConditionOperator.Equal, solutionId),

                        // 1 = Entity, 2 = Attribute. Other component types (forms, views and so
                        // on) are ignored. Type 1 is the table itself being in the solution; type 2
                        // rows are read so that a solution which contains only a *column* of a
                        // table can still offer that table - but see below for how far that
                        // actually goes, because mapping a column back to its table needs
                        // attribute-level metadata.
                        new ConditionExpression("componenttype", ConditionOperator.In, new object[] { 1, 2 })
                    }
                },
                PageInfo = new PagingInfo { Count = 5000, PageNumber = 1 }
            };

            var entityIds = new HashSet<Guid>();
            var attributeIds = new HashSet<Guid>();

            EntityCollection page;
            do
            {
                try
                {
                    page = _service.RetrieveMultiple(query);
                }
                catch (Exception ex)
                {
                    throw Translate(ex, "reading the contents of that solution");
                }

                foreach (var component in page.Entities)
                {
                    var objectId = component.GetAttributeValue<Guid>("objectid");
                    if (objectId == Guid.Empty) continue;

                    var componentType = component.GetAttributeValue<OptionSetValue>("componenttype");
                    if (componentType == null) continue;

                    if (componentType.Value == 1) entityIds.Add(objectId);
                    else attributeIds.Add(objectId);
                }

                query.PageInfo.PageNumber++;
                query.PageInfo.PagingCookie = page.PagingCookie;
            }
            while (page.MoreRecords);

            if (attributeIds.Count > 0)
            {
                // Map column metadata ids back to their table, for the tables whose full metadata
                // this session has already loaded. A table that is not in the cache is not looked
                // up, so column-only membership is found for those tables and missed for the rest.
                //
                // This runs from the source picker, usually before any table has been loaded, so
                // the cache is normally empty and this loop normally finds nothing. A full mapping
                // would need one RetrieveEntityRequest per table in the environment; a table
                // reachable only this way is still reachable through the other source options.
                //
                // Snapshotted under the lock. Dictionary is not safe for a concurrent
                // read-during-write, and GetTable writes to this cache from whatever thread the
                // bridge happens to be running a request on.
                List<KeyValuePair<string, TableMetadataDto>> cached;
                lock (_sync)
                {
                    cached = _tableCache.ToList();
                }

                var byName = cached.ToDictionary(
                    entry => entry.Key, entry => entry.Value, StringComparer.OrdinalIgnoreCase);

                foreach (var table in GetCatalogue())
                {
                    if (entityIds.Contains(ParseGuid(table.MetadataId))) continue;

                    TableMetadataDto full;
                    if (!byName.TryGetValue(table.LogicalName, out full)) continue;

                    if (full.Columns.Any(c => attributeIds.Contains(ParseGuid(c.Id))))
                        entityIds.Add(ParseGuid(table.MetadataId));
                }
            }

            return entityIds;
        }

        // ------------------------------------------------------------------
        // Table catalogue
        // ------------------------------------------------------------------

        /// <summary>
        /// Every table in the environment, entity-level detail only. This is the expensive call in
        /// a large environment, so it is cached for the life of the connection.
        /// </summary>
        public List<TableSummary> GetCatalogue(bool forceRefresh = false)
        {
            lock (_sync)
            {
                if (_catalogue != null && !forceRefresh) return _catalogue;
            }

            ReportProgress("Retrieving table catalogue from the environment...", 5);

            var request = new RetrieveAllEntitiesRequest
            {
                EntityFilters = EntityFilters.Entity,
                RetrieveAsIfPublished = false
            };

            RetrieveAllEntitiesResponse response;
            try
            {
                response = (RetrieveAllEntitiesResponse)_service.Execute(request);
            }
            catch (Exception ex)
            {
                throw Translate(ex, "reading the table catalogue");
            }

            var list = response.EntityMetadata
                .Where(e => e != null && !string.IsNullOrEmpty(e.LogicalName))
                .Select(ToSummary)
                .OrderBy(t => t.DisplayName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();

            lock (_sync)
            {
                _catalogue = list;
            }

            ReportProgress("Retrieved " + list.Count + " tables.", 100);
            return list;
        }

        /// <summary>
        /// Full metadata for a set of tables. Retrieved one table at a time so progress can be
        /// reported and a single failure does not lose the whole batch.
        /// </summary>
        public List<TableMetadataDto> GetTables(IEnumerable<string> logicalNames, CancellationToken cancellation = default(CancellationToken))
        {
            List<string> ignored;
            return GetTables(logicalNames, out ignored, cancellation);
        }

        /// <summary>
        /// As <see cref="GetTables(IEnumerable{string}, CancellationToken)"/>, but also reports the
        /// tables that could not be read. Callers that put results in front of a user should use
        /// this overload: silently returning four tables when five were asked for is the kind of
        /// gap nobody notices until the diagram is wrong.
        /// </summary>
        public List<TableMetadataDto> GetTables(
            IEnumerable<string> logicalNames,
            out List<string> unreadable,
            CancellationToken cancellation = default(CancellationToken))
        {
            var names = (logicalNames ?? Enumerable.Empty<string>())
                .Where(n => !string.IsNullOrWhiteSpace(n))
                .Select(n => n.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var result = new List<TableMetadataDto>();
            unreadable = new List<string>();
            var index = 0;

            foreach (var name in names)
            {
                cancellation.ThrowIfCancellationRequested();
                index++;

                ReportProgress(
                    "Retrieving metadata for " + name + " (" + index + " of " + names.Count + ")...",
                    names.Count == 0 ? 100 : (int)(100.0 * index / names.Count));

                var dto = GetTable(name);
                if (dto != null) result.Add(dto);
                else unreadable.Add(name);
            }

            return result;
        }

        /// <summary>
        /// Full metadata for one table, cached.
        ///
        /// Pass <paramref name="forceRefresh"/> to re-read the table from the environment and
        /// replace the cached copy. The cache lives for the whole session, so a refresh must force a
        /// re-read; otherwise it would compare the diagram against the environment as it was when
        /// the table was first loaded.
        /// </summary>
        public TableMetadataDto GetTable(string logicalName, bool forceRefresh = false)
        {
            if (string.IsNullOrWhiteSpace(logicalName)) return null;

            if (!forceRefresh)
            {
                lock (_sync)
                {
                    TableMetadataDto cached;
                    if (_tableCache.TryGetValue(logicalName, out cached)) return Clone(cached);
                }
            }

            EntityMetadata metadata;
            try
            {
                var request = new RetrieveEntityRequest
                {
                    LogicalName = logicalName,
                    EntityFilters = EntityFilters.Attributes | EntityFilters.Relationships,
                    RetrieveAsIfPublished = false
                };

                metadata = ((RetrieveEntityResponse)_service.Execute(request)).EntityMetadata;
            }
            catch (Exception ex) when (!IsConnectionLevel(ex))
            {
                // A table can disappear between the catalogue read and this call, or the caller
                // may be opening a saved diagram against a different environment. Neither is fatal,
                // and callers treat null as "this one table could not be read".
                //
                // Connection-level failures are deliberately excluded from this catch. Swallowing
                // an expired session here would turn it into a walk that quietly finds nothing,
                // which reads as an empty environment rather than as a problem to fix.
                System.Diagnostics.Trace.WriteLine(
                    "Oliver4 Data Model Designer: could not retrieve " + logicalName + ": " + ex.Message);
                return null;
            }
            catch (Exception ex)
            {
                throw Translate(ex, "reading metadata for " + logicalName);
            }

            var dto = ToDto(metadata);

            lock (_sync)
            {
                _tableCache[logicalName] = dto;
            }

            // Cloned here as well as on the cache-hit path, so that the cached instance is never
            // handed out.
            return Clone(dto);
        }

        /// <summary>
        /// A private copy of a cached table.
        ///
        /// Callers mutate what they get back: a refresh carries the user's column selection, notes
        /// and status onto the fresh metadata, and a promotion moves a column object onto a card.
        /// A copy keeps those edits out of the cache, so one diagram's column selection, statuses
        /// and notes never appear on another diagram opened on the same connection.
        ///
        /// Deep through the collections that get mutated or reassigned - columns, relationships and
        /// alternate keys - and through the lists and cascade block inside them.
        /// </summary>
        private static TableMetadataDto Clone(TableMetadataDto source)
        {
            if (source == null) return null;

            var copy = new TableMetadataDto
            {
                LogicalName = source.LogicalName,
                SchemaName = source.SchemaName,
                DisplayName = source.DisplayName,
                MetadataId = source.MetadataId,
                ObjectTypeCode = source.ObjectTypeCode,
                IsCustom = source.IsCustom,
                IsManaged = source.IsManaged,
                IsActivity = source.IsActivity,
                IsIntersect = source.IsIntersect,
                OwnershipType = source.OwnershipType,
                PrimaryIdAttribute = source.PrimaryIdAttribute,
                PrimaryNameAttribute = source.PrimaryNameAttribute,
                Description = source.Description
            };

            if (source.Columns != null)
            {
                foreach (var column in source.Columns) copy.Columns.Add(CloneColumn(column));
            }

            if (source.AlternateKeys != null)
            {
                foreach (var key in source.AlternateKeys) copy.AlternateKeys.Add(CloneKey(key));
            }

            if (source.Relationships != null)
            {
                foreach (var relationship in source.Relationships)
                    copy.Relationships.Add(CloneRelationship(relationship));
            }

            return copy;
        }

        private static DiagramColumn CloneColumn(DiagramColumn source)
        {
            return new DiagramColumn
            {
                Id = source.Id,
                LogicalName = source.LogicalName,
                SchemaName = source.SchemaName,
                DisplayName = source.DisplayName,
                TypeName = source.TypeName,
                AttributeType = source.AttributeType,
                IsPrimaryId = source.IsPrimaryId,
                IsPrimaryName = source.IsPrimaryName,
                IsLookup = source.IsLookup,
                Targets = source.Targets == null ? new List<string>() : source.Targets.ToList(),
                IsRequired = source.IsRequired,
                IsCustom = source.IsCustom,
                IsAlternateKey = source.IsAlternateKey,
                Status = source.Status,
                Selected = source.Selected,
                Notes = source.Notes,
                FromRelationshipId = source.FromRelationshipId
            };
        }

        private static AlternateKeyInfo CloneKey(AlternateKeyInfo source)
        {
            return new AlternateKeyInfo
            {
                SchemaName = source.SchemaName,
                DisplayName = source.DisplayName,
                Columns = source.Columns == null ? new List<string>() : source.Columns.ToList(),
                State = source.State
            };
        }

        private static RelationshipDto CloneRelationship(RelationshipDto source)
        {
            return new RelationshipDto
            {
                SchemaName = source.SchemaName,
                DisplayName = source.DisplayName,
                MetadataId = source.MetadataId,
                Kind = source.Kind,
                ReferencedEntity = source.ReferencedEntity,
                ReferencingEntity = source.ReferencingEntity,
                ReferencedAttribute = source.ReferencedAttribute,
                ReferencingAttribute = source.ReferencingAttribute,
                IntersectEntity = source.IntersectEntity,
                Entity1IntersectAttribute = source.Entity1IntersectAttribute,
                Entity2IntersectAttribute = source.Entity2IntersectAttribute,
                IsCustom = source.IsCustom,
                IsManaged = source.IsManaged,
                IsHierarchical = source.IsHierarchical,
                IsPolymorphic = source.IsPolymorphic,
                LookupTargets = source.LookupTargets == null ? new List<string>() : source.LookupTargets.ToList(),
                Cascade = CloneCascade(source.Cascade)
            };
        }

        private static Model.CascadeConfiguration CloneCascade(Model.CascadeConfiguration source)
        {
            if (source == null) return null;

            return new Model.CascadeConfiguration
            {
                Assign = source.Assign,
                Delete = source.Delete,
                Merge = source.Merge,
                Reparent = source.Reparent,
                Share = source.Share,
                Unshare = source.Unshare,
                RollupView = source.RollupView
            };
        }

        /// <summary>
        /// True when the table's full metadata is already cached, so callers can avoid a round trip.
        /// </summary>
        public bool IsCached(string logicalName)
        {
            lock (_sync)
            {
                return !string.IsNullOrEmpty(logicalName) && _tableCache.ContainsKey(logicalName);
            }
        }

        // ------------------------------------------------------------------
        // Relationship discovery
        // ------------------------------------------------------------------

        /// <summary>
        /// Every relationship where both ends are inside <paramref name="logicalNames"/>.
        /// Relationships are collapsed by schema name because the same relationship appears on
        /// both participating tables' metadata.
        /// </summary>
        public List<RelationshipDto> GetRelationshipsWithin(
            IEnumerable<string> logicalNames,
            CancellationToken cancellation = default(CancellationToken))
        {
            var names = new HashSet<string>(
                (logicalNames ?? Enumerable.Empty<string>()).Where(n => !string.IsNullOrWhiteSpace(n)),
                StringComparer.OrdinalIgnoreCase);

            var tables = GetTables(names, cancellation);

            // Merged rather than first-view-wins. Both of a relationship's tables report it, and
            // only the referencing table's view can tell that the lookup behind it is polymorphic,
            // so the views are combined. See RelationshipViews.
            var seen = new Dictionary<string, RelationshipDto>(StringComparer.OrdinalIgnoreCase);

            foreach (var table in tables)
            {
                foreach (var relationship in table.Relationships)
                {
                    if (!names.Contains(relationship.ReferencedEntity)) continue;
                    if (!names.Contains(relationship.ReferencingEntity)) continue;

                    RelationshipDto merged;
                    seen.TryGetValue(relationship.SchemaName, out merged);
                    seen[relationship.SchemaName] = RelationshipViews.Merge(merged, relationship);
                }
            }

            return seen.Values
                .OrderBy(r => r.ReferencedEntity, StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => r.ReferencingEntity, StringComparer.OrdinalIgnoreCase)
                .ThenBy(r => r.SchemaName, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        // ------------------------------------------------------------------
        // Mapping
        // ------------------------------------------------------------------

        private static TableSummary ToSummary(EntityMetadata metadata)
        {
            return new TableSummary
            {
                LogicalName = metadata.LogicalName,
                SchemaName = metadata.SchemaName,
                DisplayName = LabelOf(metadata.DisplayName, metadata.SchemaName ?? metadata.LogicalName),
                MetadataId = metadata.MetadataId?.ToString(),
                ObjectTypeCode = metadata.ObjectTypeCode ?? 0,
                IsCustom = metadata.IsCustomEntity ?? false,
                IsManaged = metadata.IsManaged ?? false,
                IsActivity = metadata.IsActivity ?? false,
                IsIntersect = metadata.IsIntersect ?? false,
                OwnershipType = DescribeOwnership(metadata.OwnershipType),
                PrimaryIdAttribute = metadata.PrimaryIdAttribute,
                PrimaryNameAttribute = metadata.PrimaryNameAttribute,
                Description = LabelOf(metadata.Description, null)
            };
        }

        private static TableMetadataDto ToDto(EntityMetadata metadata)
        {
            var dto = new TableMetadataDto
            {
                LogicalName = metadata.LogicalName,
                SchemaName = metadata.SchemaName,
                DisplayName = LabelOf(metadata.DisplayName, metadata.SchemaName ?? metadata.LogicalName),
                MetadataId = metadata.MetadataId?.ToString(),
                ObjectTypeCode = metadata.ObjectTypeCode ?? 0,
                IsCustom = metadata.IsCustomEntity ?? false,
                IsManaged = metadata.IsManaged ?? false,
                IsActivity = metadata.IsActivity ?? false,
                IsIntersect = metadata.IsIntersect ?? false,
                OwnershipType = DescribeOwnership(metadata.OwnershipType),
                PrimaryIdAttribute = metadata.PrimaryIdAttribute,
                PrimaryNameAttribute = metadata.PrimaryNameAttribute,
                Description = LabelOf(metadata.Description, null)
            };

            var alternateKeyColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (metadata.Keys != null)
            {
                foreach (var key in metadata.Keys)
                {
                    dto.AlternateKeys.Add(new AlternateKeyInfo
                    {
                        SchemaName = key.SchemaName,
                        DisplayName = LabelOf(key.DisplayName, key.SchemaName),
                        Columns = (key.KeyAttributes ?? new string[0]).ToList(),
                        State = key.EntityKeyIndexStatus.ToString()
                    });

                    foreach (var column in key.KeyAttributes ?? new string[0])
                        alternateKeyColumns.Add(column);
                }
            }

            if (metadata.Attributes != null)
            {
                foreach (var attribute in metadata.Attributes)
                {
                    // Logical attributes and the "…name"/"…yominame" shadow columns behind lookups
                    // add noise without adding meaning to a data model diagram.
                    if (attribute.IsLogical == true) continue;
                    if (!string.IsNullOrEmpty(attribute.AttributeOf)) continue;

                    // Virtual attributes are skipped, with a narrow exception: multi-select
                    // choice, file and image columns are reported as Virtual too, but are real,
                    // modelled columns. See IsVirtualColumnWorthShowing.
                    if (attribute.AttributeType == AttributeTypeCode.Virtual &&
                        !IsVirtualColumnWorthShowing(attribute)) continue;

                    dto.Columns.Add(ToColumn(attribute, alternateKeyColumns));
                }

                dto.Columns = OrderColumns(dto.Columns);
            }

            if (metadata.OneToManyRelationships != null)
            {
                foreach (var relationship in metadata.OneToManyRelationships)
                    dto.Relationships.Add(ToRelationship(relationship, RelationshipKind.OneToMany, dto));
            }

            if (metadata.ManyToOneRelationships != null)
            {
                foreach (var relationship in metadata.ManyToOneRelationships)
                    dto.Relationships.Add(ToRelationship(relationship, RelationshipKind.ManyToOne, dto));
            }

            if (metadata.ManyToManyRelationships != null)
            {
                foreach (var relationship in metadata.ManyToManyRelationships)
                    dto.Relationships.Add(ToManyToMany(relationship));
            }

            return dto;
        }

        /// <summary>
        /// The attribute types that report AttributeType=Virtual but are real columns a modeller
        /// has to see: multi-select choices, and file and image columns. Everything else that is
        /// Virtual - the calculated shadows and the platform's internal helpers - stays hidden.
        ///
        /// An allow-list: MultiSelectPicklistAttributeMetadata, FileAttributeMetadata and
        /// ImageAttributeMetadata report AttributeType=Virtual while carrying their real type in
        /// AttributeTypeName, which DescribeType renders. This is taken from the SDK contract and
        /// has not been verified against a real organisation; an attribute whose AttributeTypeName
        /// is none of these three is skipped.
        /// </summary>
        private static bool IsVirtualColumnWorthShowing(AttributeMetadata attribute)
        {
            var typeName = attribute.AttributeTypeName == null ? null : attribute.AttributeTypeName.Value;
            if (string.IsNullOrEmpty(typeName)) return false;

            return string.Equals(typeName, "MultiSelectPicklistType", StringComparison.OrdinalIgnoreCase)
                || string.Equals(typeName, "FileType", StringComparison.OrdinalIgnoreCase)
                || string.Equals(typeName, "ImageType", StringComparison.OrdinalIgnoreCase);
        }

        private static DiagramColumn ToColumn(AttributeMetadata attribute, HashSet<string> alternateKeyColumns)
        {
            var lookup = attribute as LookupAttributeMetadata;
            var targets = lookup?.Targets ?? new string[0];

            return new DiagramColumn
            {
                Id = attribute.MetadataId?.ToString("N") ?? Guid.NewGuid().ToString("N"),
                LogicalName = attribute.LogicalName,
                SchemaName = attribute.SchemaName,
                DisplayName = LabelOf(attribute.DisplayName, attribute.SchemaName ?? attribute.LogicalName),
                TypeName = DescribeType(attribute),
                AttributeType = attribute.AttributeType?.ToString(),
                IsPrimaryId = attribute.IsPrimaryId ?? false,
                IsPrimaryName = attribute.IsPrimaryName ?? false,
                IsLookup = lookup != null,
                Targets = targets.ToList(),
                IsRequired = attribute.RequiredLevel != null &&
                             (attribute.RequiredLevel.Value == AttributeRequiredLevel.ApplicationRequired ||
                              attribute.RequiredLevel.Value == AttributeRequiredLevel.SystemRequired),
                IsCustom = attribute.IsCustomAttribute ?? false,
                IsAlternateKey = alternateKeyColumns.Contains(attribute.LogicalName ?? string.Empty),
                Status = ObjectStatus.Existing,
                Selected = true
            };
        }

        /// <summary>Primary key first, then primary name, then lookups, then the rest by name.</summary>
        private static List<DiagramColumn> OrderColumns(List<DiagramColumn> columns)
        {
            return columns
                .OrderByDescending(c => c.IsPrimaryId)
                .ThenByDescending(c => c.IsPrimaryName)
                .ThenByDescending(c => c.IsLookup)
                .ThenBy(c => c.DisplayName, StringComparer.CurrentCultureIgnoreCase)
                .ToList();
        }

        private static RelationshipDto ToRelationship(
            OneToManyRelationshipMetadata relationship,
            RelationshipKind kind,
            TableMetadataDto owner)
        {
            var dto = new RelationshipDto
            {
                SchemaName = relationship.SchemaName,
                DisplayName = LabelOf(relationship.AssociatedMenuConfiguration?.Label, relationship.SchemaName),
                MetadataId = relationship.MetadataId?.ToString(),
                Kind = kind,
                ReferencedEntity = relationship.ReferencedEntity,
                ReferencingEntity = relationship.ReferencingEntity,
                ReferencedAttribute = relationship.ReferencedAttribute,
                ReferencingAttribute = relationship.ReferencingAttribute,
                IsCustom = relationship.IsCustomRelationship ?? false,
                IsManaged = relationship.IsManaged ?? false,
                IsHierarchical = relationship.IsHierarchical ?? false,
                Cascade = ToCascade(relationship.CascadeConfiguration)
            };

            // A polymorphic lookup (Customer, Owner, Regarding) produces one relationship per
            // target. Recording the full target list lets the inspector explain why.
            //
            // The lookup column only exists on the *referencing* table, so this can only ever fill
            // in on the ManyToOne view; the OneToMany view of the same relationship comes back
            // IsPolymorphic=false with an empty target list, and nothing here can change that
            // without a second retrieve. Anything that collapses the two views into one entry must
            // therefore merge them rather than overwrite - see RelationshipViews.Merge.
            var lookupColumn = owner.Columns.FirstOrDefault(c =>
                c.IsLookup && string.Equals(c.LogicalName, relationship.ReferencingAttribute, StringComparison.OrdinalIgnoreCase));

            if (lookupColumn != null && lookupColumn.Targets.Count > 1)
            {
                dto.IsPolymorphic = true;
                dto.LookupTargets = lookupColumn.Targets.ToList();
            }

            return dto;
        }

        private static RelationshipDto ToManyToMany(ManyToManyRelationshipMetadata relationship)
        {
            return new RelationshipDto
            {
                SchemaName = relationship.SchemaName,
                DisplayName = LabelOf(relationship.Entity1AssociatedMenuConfiguration?.Label, relationship.SchemaName),
                MetadataId = relationship.MetadataId?.ToString(),
                Kind = RelationshipKind.ManyToMany,

                // For N:N there is no referenced/referencing direction. Entity1 is treated as the
                // "from" end purely so the canvas has a stable orientation to draw.
                ReferencedEntity = relationship.Entity1LogicalName,
                ReferencingEntity = relationship.Entity2LogicalName,
                IntersectEntity = relationship.IntersectEntityName,
                Entity1IntersectAttribute = relationship.Entity1IntersectAttribute,
                Entity2IntersectAttribute = relationship.Entity2IntersectAttribute,
                IsCustom = relationship.IsCustomRelationship ?? false,
                IsManaged = relationship.IsManaged ?? false
            };
        }

        private static Model.CascadeConfiguration ToCascade(Microsoft.Xrm.Sdk.Metadata.CascadeConfiguration cascade)
        {
            if (cascade == null) return null;

            return new Model.CascadeConfiguration
            {
                Assign = cascade.Assign?.ToString(),
                Delete = cascade.Delete?.ToString(),
                Merge = cascade.Merge?.ToString(),
                Reparent = cascade.Reparent?.ToString(),
                Share = cascade.Share?.ToString(),
                Unshare = cascade.Unshare?.ToString(),
                RollupView = cascade.RollupView?.ToString()
            };
        }

        /// <summary>Readable type label, for example "Text (100)" or "Lookup -> Account, Contact".</summary>
        private static string DescribeType(AttributeMetadata attribute)
        {
            var typeName = attribute.AttributeTypeName?.Value;
            var baseName = !string.IsNullOrEmpty(typeName)
                ? Humanise(typeName)
                : (attribute.AttributeType?.ToString() ?? "Unknown");

            var stringAttribute = attribute as StringAttributeMetadata;
            if (stringAttribute?.MaxLength != null)
                return baseName + " (" + stringAttribute.MaxLength.Value + ")";

            var memoAttribute = attribute as MemoAttributeMetadata;
            if (memoAttribute?.MaxLength != null)
                return baseName + " (" + memoAttribute.MaxLength.Value + ")";

            var lookupAttribute = attribute as LookupAttributeMetadata;
            if (lookupAttribute?.Targets != null && lookupAttribute.Targets.Length > 0)
            {
                var targets = string.Join(", ", lookupAttribute.Targets.Take(3));
                if (lookupAttribute.Targets.Length > 3)
                    targets += ", +" + (lookupAttribute.Targets.Length - 3);
                return baseName + " -> " + targets;
            }

            var decimalAttribute = attribute as DecimalAttributeMetadata;
            if (decimalAttribute?.Precision != null)
                return baseName + " (" + decimalAttribute.Precision.Value + ")";

            var moneyAttribute = attribute as MoneyAttributeMetadata;
            if (moneyAttribute?.Precision != null)
                return baseName + " (" + moneyAttribute.Precision.Value + ")";

            return baseName;
        }

        /// <summary>"MemoType" becomes "Memo", "DateTimeType" becomes "Date time".</summary>
        private static string Humanise(string attributeTypeName)
        {
            var name = attributeTypeName;
            if (name.EndsWith("Type", StringComparison.Ordinal) && name.Length > 4)
                name = name.Substring(0, name.Length - 4);

            var builder = new System.Text.StringBuilder(name.Length + 4);
            for (var i = 0; i < name.Length; i++)
            {
                if (i > 0 && char.IsUpper(name[i]) && !char.IsUpper(name[i - 1]))
                {
                    builder.Append(' ');
                    builder.Append(char.ToLowerInvariant(name[i]));
                }
                else
                {
                    builder.Append(name[i]);
                }
            }

            return builder.ToString();
        }

        /// <summary>
        /// Ownership as a single word.
        ///
        /// OwnershipTypes is a flags enum, and a table is commonly reported as UserOwned even when
        /// records can be assigned to a team - "user or team owned" is one setting in the maker
        /// portal. The flags are therefore collapsed to the four values that mean something on a
        /// data model: user or team owned, organisation owned, business owned, or none.
        /// </summary>
        private static string DescribeOwnership(OwnershipTypes? ownership)
        {
            if (ownership == null) return null;

            var value = ownership.Value;

            if (value.HasFlag(OwnershipTypes.UserOwned) || value.HasFlag(OwnershipTypes.TeamOwned))
                return "UserOwned";

            if (value.HasFlag(OwnershipTypes.OrganizationOwned)) return "OrganizationOwned";
            if (value.HasFlag(OwnershipTypes.BusinessOwned)) return "BusinessOwned";
            if (value.HasFlag(OwnershipTypes.BusinessParented)) return "BusinessParented";

            // Anything else, including None, is "no ownership-based security applies". Falling
            // through to value.ToString() here would put an unrecognised enum name into a 34px
            // pill on the canvas and into a design document, which is worse than saying None.
            return "None";
        }

        private static string LabelOf(Label label, string fallback)
        {
            var value = label?.UserLocalizedLabel?.Label;
            if (!string.IsNullOrWhiteSpace(value)) return value;

            if (label?.LocalizedLabels != null && label.LocalizedLabels.Count > 0)
            {
                value = label.LocalizedLabels[0].Label;
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }

            return fallback;
        }

        private static string GetAliasedString(Entity entity, string attributeName)
        {
            var aliased = entity.GetAttributeValue<AliasedValue>(attributeName);
            return aliased?.Value as string;
        }

        private static Guid ParseGuid(string value)
        {
            Guid parsed;
            return Guid.TryParse(value, out parsed) ? parsed : Guid.Empty;
        }
    }

    /// <summary>
    /// Collapsing the two DTO views of one relationship into the single entry a diagram holds.
    ///
    /// <see cref="MetadataService"/> emits every 1:N twice - once from OneToManyRelationships and
    /// once from ManyToOneRelationships - so any index keyed on schema name meets each relationship
    /// twice, and the two views disagree about two things, so neither can simply overwrite the
    /// other:
    ///
    /// - the ManyToOne view carries Kind=ManyToOne, and adopting that breaks the document
    ///   invariant that a connector runs from the referenced table to the referencing one with
    ///   Kind normalised to OneToMany. The canvas then draws the crow's foot at the wrong end, the
    ///   exports follow it, and the connector disappears from the relationships panel, which only
    ///   offers OneToMany and ManyToMany;
    /// - only the ManyToOne view can see that the lookup behind the relationship has several
    ///   targets, because only the referencing table's metadata contains that lookup column, so the
    ///   OneToMany view would report a polymorphic Customer lookup as single-target.
    ///
    /// Merging takes the right answer from each. The two views are otherwise the same relationship
    /// metadata read from opposite ends, so nothing else has to be reconciled.
    /// </summary>
    internal static class RelationshipViews
    {
        /// <summary>
        /// Merges one view into the entry already indexed under its schema name and returns the
        /// entry to keep. Pass null for <paramref name="existing"/> when this is the first view.
        ///
        /// The entry is modified in place, which is safe because GetTable hands out a private copy
        /// of the cached metadata: normalising Kind here cannot reach the cache.
        /// </summary>
        public static RelationshipDto Merge(RelationshipDto existing, RelationshipDto view)
        {
            if (view == null) return existing;

            // N:N is left exactly as it is - it has no referenced/referencing direction to
            // normalise, and it appears only once per table pair.
            if (view.Kind == RelationshipKind.ManyToOne) view.Kind = RelationshipKind.OneToMany;

            if (existing == null) return view;

            // Taken from whichever view actually carries it.
            if (!existing.IsPolymorphic && view.IsPolymorphic)
            {
                existing.IsPolymorphic = true;
                existing.LookupTargets = view.LookupTargets;
            }

            return existing;
        }
    }

    public class MetadataProgressEventArgs : EventArgs
    {
        public MetadataProgressEventArgs(string message, int percent)
        {
            Message = message;
            Percent = percent;
        }

        public string Message { get; }
        public int Percent { get; }
    }
}
