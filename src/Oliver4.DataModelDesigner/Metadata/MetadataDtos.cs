using System.Collections.Generic;
using Newtonsoft.Json;
using Oliver4.DataModelDesigner.Model;

namespace Oliver4.DataModelDesigner.Metadata
{
    /// <summary>A solution as shown in the source picker.</summary>
    public class SolutionInfo
    {
        [JsonProperty("id")] public string Id { get; set; }
        [JsonProperty("uniqueName")] public string UniqueName { get; set; }
        [JsonProperty("friendlyName")] public string FriendlyName { get; set; }
        [JsonProperty("version")] public string Version { get; set; }
        [JsonProperty("isManaged")] public bool IsManaged { get; set; }
        [JsonProperty("publisher")] public string Publisher { get; set; }
        [JsonProperty("tableCount")] public int TableCount { get; set; }
    }

    /// <summary>
    /// Lightweight table entry for the catalogue and picker lists. Deliberately excludes columns
    /// and relationships so the whole environment can be listed without a heavy retrieve.
    /// </summary>
    public class TableSummary
    {
        [JsonProperty("logicalName")] public string LogicalName { get; set; }
        [JsonProperty("schemaName")] public string SchemaName { get; set; }
        [JsonProperty("displayName")] public string DisplayName { get; set; }
        [JsonProperty("metadataId")] public string MetadataId { get; set; }
        [JsonProperty("objectTypeCode")] public int ObjectTypeCode { get; set; }
        [JsonProperty("isCustom")] public bool IsCustom { get; set; }
        [JsonProperty("isManaged")] public bool IsManaged { get; set; }
        [JsonProperty("isActivity")] public bool IsActivity { get; set; }
        [JsonProperty("isIntersect")] public bool IsIntersect { get; set; }

        /// <summary>
        /// One of "UserOwned", "OrganizationOwned", "BusinessOwned", "BusinessParented" or "None"
        /// - what decides who can see a record. Ownership drives the whole security model and is
        /// invisible on an ERD unless it is drawn, which is why the canvas can mark it.
        ///
        /// Note that "TeamOwned" is not among them: Dataverse reports a user-owned table with the
        /// TeamOwned flag set as well, because "user or team owned" is one setting in the maker
        /// portal, and MetadataService collapses the pair to "UserOwned".
        /// </summary>
        [JsonProperty("ownershipType")] public string OwnershipType { get; set; }
        [JsonProperty("primaryIdAttribute")] public string PrimaryIdAttribute { get; set; }
        [JsonProperty("primaryNameAttribute")] public string PrimaryNameAttribute { get; set; }
        [JsonProperty("description")] public string Description { get; set; }

        /// <summary>Relationship count, populated only once full metadata has been retrieved.</summary>
        [JsonProperty("relationshipCount")] public int? RelationshipCount { get; set; }
    }

    /// <summary>Full metadata for one table, as handed to the canvas.</summary>
    public class TableMetadataDto
    {
        [JsonProperty("logicalName")] public string LogicalName { get; set; }
        [JsonProperty("schemaName")] public string SchemaName { get; set; }
        [JsonProperty("displayName")] public string DisplayName { get; set; }
        [JsonProperty("metadataId")] public string MetadataId { get; set; }
        [JsonProperty("objectTypeCode")] public int ObjectTypeCode { get; set; }
        [JsonProperty("isCustom")] public bool IsCustom { get; set; }
        [JsonProperty("isManaged")] public bool IsManaged { get; set; }
        [JsonProperty("isActivity")] public bool IsActivity { get; set; }
        [JsonProperty("isIntersect")] public bool IsIntersect { get; set; }

        /// <summary>
        /// One of "UserOwned", "OrganizationOwned", "BusinessOwned", "BusinessParented" or "None"
        /// - what decides who can see a record. Ownership drives the whole security model and is
        /// invisible on an ERD unless it is drawn, which is why the canvas can mark it.
        ///
        /// Note that "TeamOwned" is not among them: Dataverse reports a user-owned table with the
        /// TeamOwned flag set as well, because "user or team owned" is one setting in the maker
        /// portal, and MetadataService collapses the pair to "UserOwned".
        /// </summary>
        [JsonProperty("ownershipType")] public string OwnershipType { get; set; }
        [JsonProperty("primaryIdAttribute")] public string PrimaryIdAttribute { get; set; }
        [JsonProperty("primaryNameAttribute")] public string PrimaryNameAttribute { get; set; }
        [JsonProperty("description")] public string Description { get; set; }
        [JsonProperty("columns")] public List<DiagramColumn> Columns { get; set; } = new List<DiagramColumn>();
        [JsonProperty("alternateKeys")] public List<AlternateKeyInfo> AlternateKeys { get; set; } = new List<AlternateKeyInfo>();
        [JsonProperty("relationships")] public List<RelationshipDto> Relationships { get; set; } = new List<RelationshipDto>();
    }

    /// <summary>
    /// One relationship, flattened. The same shape covers 1:N, N:1 and N:N; the canvas decides
    /// how to draw it from <see cref="Kind"/>.
    /// </summary>
    public class RelationshipDto
    {
        [JsonProperty("schemaName")] public string SchemaName { get; set; }
        [JsonProperty("displayName")] public string DisplayName { get; set; }
        [JsonProperty("metadataId")] public string MetadataId { get; set; }

        [JsonProperty("kind")]
        [JsonConverter(typeof(Newtonsoft.Json.Converters.StringEnumConverter))]
        public RelationshipKind Kind { get; set; }

        [JsonProperty("referencedEntity")] public string ReferencedEntity { get; set; }
        [JsonProperty("referencingEntity")] public string ReferencingEntity { get; set; }
        [JsonProperty("referencedAttribute")] public string ReferencedAttribute { get; set; }
        [JsonProperty("referencingAttribute")] public string ReferencingAttribute { get; set; }
        [JsonProperty("intersectEntity")] public string IntersectEntity { get; set; }
        [JsonProperty("entity1IntersectAttribute")] public string Entity1IntersectAttribute { get; set; }
        [JsonProperty("entity2IntersectAttribute")] public string Entity2IntersectAttribute { get; set; }
        [JsonProperty("isCustom")] public bool IsCustom { get; set; }
        [JsonProperty("isManaged")] public bool IsManaged { get; set; }
        [JsonProperty("isHierarchical")] public bool IsHierarchical { get; set; }
        [JsonProperty("isPolymorphic")] public bool IsPolymorphic { get; set; }
        [JsonProperty("lookupTargets")] public List<string> LookupTargets { get; set; } = new List<string>();
        [JsonProperty("cascade")] public CascadeConfiguration Cascade { get; set; }

        /// <summary>Convenience for the picker: the two tables involved, regardless of direction.</summary>
        public string OtherEnd(string logicalName)
        {
            if (Kind == RelationshipKind.ManyToMany)
            {
                return string.Equals(ReferencedEntity, logicalName, System.StringComparison.OrdinalIgnoreCase)
                    ? ReferencingEntity
                    : ReferencedEntity;
            }

            return string.Equals(ReferencedEntity, logicalName, System.StringComparison.OrdinalIgnoreCase)
                ? ReferencingEntity
                : ReferencedEntity;
        }
    }

    /// <summary>Identity of the connected environment, shown in the command bar.</summary>
    public class ConnectionInfo
    {
        [JsonProperty("connected")] public bool Connected { get; set; }
        [JsonProperty("organizationFriendlyName")] public string OrganizationFriendlyName { get; set; }
        [JsonProperty("organizationId")] public string OrganizationId { get; set; }
        [JsonProperty("environmentUrl")] public string EnvironmentUrl { get; set; }
        [JsonProperty("host")] public string Host { get; set; }
        [JsonProperty("userName")] public string UserName { get; set; }
        [JsonProperty("organizationVersion")] public string OrganizationVersion { get; set; }
    }
}
