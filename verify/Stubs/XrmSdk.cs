// Compile-verification stubs for the Dataverse SDK surface this tool uses.
// Signatures follow the documented public API. Not shipped.
#pragma warning disable CS0067, CS0169, CS0649

using System;
using System.Collections;
using System.Collections.Generic;

namespace Microsoft.Xrm.Sdk
{
    public class Entity
    {
        public Guid Id { get; set; }
        public string LogicalName { get; set; }
        public T GetAttributeValue<T>(string attributeLogicalName) => default(T);
    }

    public class EntityCollection
    {
        public List<Entity> Entities { get; } = new List<Entity>();
        public bool MoreRecords { get; set; }
        public string PagingCookie { get; set; }
    }

    public class OptionSetValue
    {
        public int Value { get; set; }
    }

    public class AliasedValue
    {
        public object Value { get; set; }
    }

    public class LocalizedLabel
    {
        public string Label { get; set; }
        public int LanguageCode { get; set; }
    }

    public class LocalizedLabelCollection : List<LocalizedLabel> { }

    public class Label
    {
        public LocalizedLabel UserLocalizedLabel { get; set; }
        public LocalizedLabelCollection LocalizedLabels { get; set; }
    }

    public abstract class OrganizationRequest { }
    public abstract class OrganizationResponse { }

    public interface IOrganizationService
    {
        OrganizationResponse Execute(OrganizationRequest request);
        EntityCollection RetrieveMultiple(Microsoft.Xrm.Sdk.Query.QueryBase query);
    }

    public class BooleanManagedProperty
    {
        public bool Value { get; set; }
    }
}

namespace Microsoft.Xrm.Sdk.Query
{
    public abstract class QueryBase { }

    public class ColumnSet
    {
        public ColumnSet(params string[] columns) { }
        public ColumnSet(bool allColumns) { }
    }

    public enum ConditionOperator { Equal, NotEqual, In, Like, BeginsWith }
    public enum OrderType { Ascending, Descending }
    public enum JoinOperator { Inner, LeftOuter, Natural }
    public enum LogicalOperator { And, Or }

    public class ConditionExpression
    {
        public ConditionExpression() { }
        public ConditionExpression(string attributeName, ConditionOperator conditionOperator, object value) { }
        public ConditionExpression(string attributeName, ConditionOperator conditionOperator, object[] values) { }
    }

    public class FilterExpression
    {
        public LogicalOperator FilterOperator { get; set; }
        public DataCollection<ConditionExpression> Conditions { get; } = new DataCollection<ConditionExpression>();
        public DataCollection<FilterExpression> Filters { get; } = new DataCollection<FilterExpression>();
    }

    public class OrderExpression
    {
        public OrderExpression() { }
        public OrderExpression(string attributeName, OrderType orderType) { }
    }

    public class PagingInfo
    {
        public int Count { get; set; }
        public int PageNumber { get; set; }
        public string PagingCookie { get; set; }
    }

    public class LinkEntity
    {
        public string EntityAlias { get; set; }
        public ColumnSet Columns { get; set; }
        public FilterExpression LinkCriteria { get; set; } = new FilterExpression();
    }

    public class QueryExpression : QueryBase
    {
        public QueryExpression() { }
        public QueryExpression(string entityName) { EntityName = entityName; }

        public string EntityName { get; set; }
        public ColumnSet ColumnSet { get; set; }
        public FilterExpression Criteria { get; set; } = new FilterExpression();
        public DataCollection<OrderExpression> Orders { get; } = new DataCollection<OrderExpression>();
        public PagingInfo PageInfo { get; set; } = new PagingInfo();
        public DataCollection<LinkEntity> LinkEntities { get; } = new DataCollection<LinkEntity>();

        public LinkEntity AddLink(string linkToEntityName, string linkFromAttributeName, string linkToAttributeName)
            => new LinkEntity();

        public LinkEntity AddLink(string linkToEntityName, string linkFromAttributeName, string linkToAttributeName, JoinOperator joinOperator)
            => new LinkEntity();
    }

    public class DataCollection<T> : List<T> { }
}

namespace Microsoft.Xrm.Sdk.Metadata
{
    [Flags]
    public enum EntityFilters
    {
        Default = 1,
        Entity = 1,
        Attributes = 2,
        Privileges = 4,
        Relationships = 8,
        All = 15
    }

    public enum AttributeTypeCode
    {
        Boolean, Customer, DateTime, Decimal, Double, Integer, Lookup, Memo, Money, Owner,
        PartyList, Picklist, State, Status, String, Uniqueidentifier, CalendarRules, Virtual,
        BigInt, ManagedProperty, EntityName
    }

    public enum AttributeRequiredLevel { None, SystemRequired, ApplicationRequired, Recommended }

    public class AttributeRequiredLevelManagedProperty
    {
        public AttributeRequiredLevel Value { get; set; }
    }

    public class AttributeTypeDisplayName
    {
        public string Value { get; set; }
    }

    public enum CascadeType { Active, UserOwned, RemoveLink, Restrict, NoCascade, Cascade }

    public class CascadeConfiguration
    {
        public CascadeType? Assign { get; set; }
        public CascadeType? Delete { get; set; }
        public CascadeType? Merge { get; set; }
        public CascadeType? Reparent { get; set; }
        public CascadeType? Share { get; set; }
        public CascadeType? Unshare { get; set; }
        public CascadeType? RollupView { get; set; }
    }

    public class AssociatedMenuConfiguration
    {
        public Microsoft.Xrm.Sdk.Label Label { get; set; }
    }

    public enum EntityKeyIndexStatus { Pending, InProgress, Active, Failed }

    public abstract class MetadataBase
    {
        public Guid? MetadataId { get; set; }
    }

    public class AttributeMetadata : MetadataBase
    {
        public string LogicalName { get; set; }
        public string SchemaName { get; set; }
        public string EntityLogicalName { get; set; }
        public Microsoft.Xrm.Sdk.Label DisplayName { get; set; }
        public Microsoft.Xrm.Sdk.Label Description { get; set; }
        public AttributeTypeCode? AttributeType { get; set; }
        public AttributeTypeDisplayName AttributeTypeName { get; set; }
        public AttributeRequiredLevelManagedProperty RequiredLevel { get; set; }
        public bool? IsCustomAttribute { get; set; }
        public bool? IsPrimaryId { get; set; }
        public bool? IsPrimaryName { get; set; }
        public bool? IsLogical { get; set; }
        public bool? IsValidForRead { get; set; }
        public string AttributeOf { get; set; }
    }

    public class StringAttributeMetadata : AttributeMetadata { public int? MaxLength { get; set; } }
    public class MemoAttributeMetadata : AttributeMetadata { public int? MaxLength { get; set; } }
    public class DecimalAttributeMetadata : AttributeMetadata { public int? Precision { get; set; } }
    public class MoneyAttributeMetadata : AttributeMetadata { public int? Precision { get; set; } }
    public class DoubleAttributeMetadata : AttributeMetadata { public int? Precision { get; set; } }
    public class LookupAttributeMetadata : AttributeMetadata { public string[] Targets { get; set; } }

    public class RelationshipMetadataBase : MetadataBase
    {
        public string SchemaName { get; set; }
        public bool? IsCustomRelationship { get; set; }
        public bool? IsManaged { get; set; }
    }

    public class OneToManyRelationshipMetadata : RelationshipMetadataBase
    {
        public string ReferencedEntity { get; set; }
        public string ReferencingEntity { get; set; }
        public string ReferencedAttribute { get; set; }
        public string ReferencingAttribute { get; set; }
        public bool? IsHierarchical { get; set; }
        public CascadeConfiguration CascadeConfiguration { get; set; }
        public AssociatedMenuConfiguration AssociatedMenuConfiguration { get; set; }
    }

    public class ManyToManyRelationshipMetadata : RelationshipMetadataBase
    {
        public string Entity1LogicalName { get; set; }
        public string Entity2LogicalName { get; set; }
        public string IntersectEntityName { get; set; }
        public string Entity1IntersectAttribute { get; set; }
        public string Entity2IntersectAttribute { get; set; }
        public AssociatedMenuConfiguration Entity1AssociatedMenuConfiguration { get; set; }
        public AssociatedMenuConfiguration Entity2AssociatedMenuConfiguration { get; set; }
    }

    public class EntityKeyMetadata : MetadataBase
    {
        public string SchemaName { get; set; }
        public Microsoft.Xrm.Sdk.Label DisplayName { get; set; }
        public string[] KeyAttributes { get; set; }
        public EntityKeyIndexStatus EntityKeyIndexStatus { get; set; }
    }

    /// <summary>
    /// Flags, as in the real SDK: a table reported as UserOwned commonly also carries TeamOwned,
    /// because "user or team owned" is one setting in the maker portal.
    /// </summary>
    [System.Flags]
    public enum OwnershipTypes
    {
        None = 0,
        UserOwned = 1,
        TeamOwned = 2,
        BusinessOwned = 4,
        OrganizationOwned = 8,
        BusinessParented = 16
    }

    public class EntityMetadata : MetadataBase
    {
        public string LogicalName { get; set; }
        public string SchemaName { get; set; }
        public Microsoft.Xrm.Sdk.Label DisplayName { get; set; }
        public Microsoft.Xrm.Sdk.Label Description { get; set; }
        public int? ObjectTypeCode { get; set; }
        public bool? IsCustomEntity { get; set; }
        public bool? IsManaged { get; set; }
        public bool? IsActivity { get; set; }
        public bool? IsIntersect { get; set; }
        public OwnershipTypes? OwnershipType { get; set; }
        public string PrimaryIdAttribute { get; set; }
        public string PrimaryNameAttribute { get; set; }
        public AttributeMetadata[] Attributes { get; set; }
        public OneToManyRelationshipMetadata[] OneToManyRelationships { get; set; }
        public OneToManyRelationshipMetadata[] ManyToOneRelationships { get; set; }
        public ManyToManyRelationshipMetadata[] ManyToManyRelationships { get; set; }
        public EntityKeyMetadata[] Keys { get; set; }
    }
}

namespace Microsoft.Xrm.Sdk.Messages
{
    using Microsoft.Xrm.Sdk;
    using Microsoft.Xrm.Sdk.Metadata;

    public class RetrieveAllEntitiesRequest : OrganizationRequest
    {
        public EntityFilters EntityFilters { get; set; }
        public bool RetrieveAsIfPublished { get; set; }
    }

    public class RetrieveAllEntitiesResponse : OrganizationResponse
    {
        public EntityMetadata[] EntityMetadata { get; set; }
    }

    public class RetrieveEntityRequest : OrganizationRequest
    {
        public string LogicalName { get; set; }
        public Guid MetadataId { get; set; }
        public EntityFilters EntityFilters { get; set; }
        public bool RetrieveAsIfPublished { get; set; }
    }

    public class RetrieveEntityResponse : OrganizationResponse
    {
        public EntityMetadata EntityMetadata { get; set; }
    }
}
