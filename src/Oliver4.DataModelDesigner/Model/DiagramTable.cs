using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace Oliver4.DataModelDesigner.Model
{
    /// <summary>
    /// A table card on the canvas. Backed by Dataverse metadata when
    /// <see cref="Status"/> is Existing or Deprecated, entered by hand otherwise.
    /// </summary>
    public class DiagramTable
    {
        /// <summary>Stable diagram-local identifier. Survives refresh and rename.</summary>
        [JsonProperty("id")]
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        /// <summary>Dataverse logical name. Null for proposed and external objects.</summary>
        [JsonProperty("logicalName")]
        public string LogicalName { get; set; }

        [JsonProperty("schemaName")]
        public string SchemaName { get; set; }

        [JsonProperty("displayName")]
        public string DisplayName { get; set; }

        [JsonProperty("status")]
        [JsonConverter(typeof(StringEnumConverter))]
        public ObjectStatus Status { get; set; } = ObjectStatus.Existing;

        // --- metadata facts (existing tables only) -------------------------

        [JsonProperty("metadataId")]
        public string MetadataId { get; set; }

        [JsonProperty("objectTypeCode")]
        public int? ObjectTypeCode { get; set; }

        [JsonProperty("primaryIdAttribute")]
        public string PrimaryIdAttribute { get; set; }

        [JsonProperty("primaryNameAttribute")]
        public string PrimaryNameAttribute { get; set; }

        [JsonProperty("isCustom")]
        public bool IsCustom { get; set; }

        [JsonProperty("isManaged")]
        public bool IsManaged { get; set; }

        [JsonProperty("isActivity")]
        public bool IsActivity { get; set; }

        [JsonProperty("isIntersect")]
        public bool IsIntersect { get; set; }

        /// <summary>
        /// "UserOwned", "OrganizationOwned", "BusinessOwned" or "None", as reported by the
        /// environment. Ownership decides who can see a record, so it is part of the design even
        /// though an ERD traditionally says nothing about it.
        ///
        /// Not part of the format version stamp: it is an additive property, so a version 2 file
        /// without it still opens, and a build that does not know it simply ignores it.
        /// </summary>
        [JsonProperty("ownershipType")]
        public string OwnershipType { get; set; }

        [JsonProperty("description")]
        public string Description { get; set; }

        // --- layout and presentation --------------------------------------

        [JsonProperty("x")]
        public double X { get; set; }

        [JsonProperty("y")]
        public double Y { get; set; }

        /// <summary>Optional manual width. Null lets the renderer size the card to its content.</summary>
        [JsonProperty("width")]
        public double? Width { get; set; }

        [JsonProperty("collapsed")]
        public bool Collapsed { get; set; }

        /// <summary>Per-table detail override. Null means follow the diagram setting.</summary>
        [JsonProperty("detailOverride")]
        [JsonConverter(typeof(StringEnumConverter))]
        public FieldDetailMode? DetailOverride { get; set; }

        /// <summary>Manual emphasis colour as a CSS colour string, or null for the default style.</summary>
        [JsonProperty("highlight")]
        public string Highlight { get; set; }

        [JsonProperty("notes")]
        public string Notes { get; set; }

        /// <summary>Free-text owner or workstream, used on future-state diagrams.</summary>
        [JsonProperty("owner")]
        public string Owner { get; set; }

        // --- content -------------------------------------------------------

        [JsonProperty("columns")]
        public List<DiagramColumn> Columns { get; set; } = new List<DiagramColumn>();

        [JsonProperty("alternateKeys")]
        public List<AlternateKeyInfo> AlternateKeys { get; set; } = new List<AlternateKeyInfo>();

        /// <summary>
        /// The order the user dragged this card's rows into, as lower-case logical names. Empty
        /// means the ordinary rules - the column-order setting, with the keys floated to the top.
        ///
        /// Written against the logical name rather than the column id so that a column replaced by
        /// one of the same name - a proposed column settling against the real one on a refresh -
        /// keeps its place. A column the list has never heard of is drawn after the ones it has.
        ///
        /// Additive, so the file format version does not change.
        /// </summary>
        [JsonProperty("columnOrder")]
        public List<string> ColumnOrder { get; set; } = new List<string>();

        /// <summary>
        /// Set by <see cref="Services.RefreshService"/> when the table could not be found in the
        /// connected environment on the most recent refresh. Purely informational.
        /// </summary>
        [JsonProperty("missingSinceRefresh")]
        public bool MissingSinceRefresh { get; set; }
    }

    /// <summary>A column row inside a table card.</summary>
    public class DiagramColumn
    {
        [JsonProperty("id")]
        public string Id { get; set; } = Guid.NewGuid().ToString("N");

        [JsonProperty("logicalName")]
        public string LogicalName { get; set; }

        [JsonProperty("schemaName")]
        public string SchemaName { get; set; }

        [JsonProperty("displayName")]
        public string DisplayName { get; set; }

        /// <summary>Human readable type, for example "Text (100)" or "Lookup -> Account".</summary>
        [JsonProperty("typeName")]
        public string TypeName { get; set; }

        /// <summary>Raw AttributeTypeName from metadata, kept for exports that want a real type.</summary>
        [JsonProperty("attributeType")]
        public string AttributeType { get; set; }

        [JsonProperty("isPrimaryId")]
        public bool IsPrimaryId { get; set; }

        [JsonProperty("isPrimaryName")]
        public bool IsPrimaryName { get; set; }

        [JsonProperty("isLookup")]
        public bool IsLookup { get; set; }

        /// <summary>Lookup targets. More than one entry means a polymorphic lookup such as Customer.</summary>
        [JsonProperty("targets")]
        public List<string> Targets { get; set; } = new List<string>();

        [JsonProperty("isRequired")]
        public bool IsRequired { get; set; }

        [JsonProperty("isCustom")]
        public bool IsCustom { get; set; }

        [JsonProperty("isAlternateKey")]
        public bool IsAlternateKey { get; set; }

        [JsonProperty("status")]
        [JsonConverter(typeof(StringEnumConverter))]
        public ObjectStatus Status { get; set; } = ObjectStatus.Existing;

        /// <summary>Whether the user has selected this column for display in all-fields mode.</summary>
        [JsonProperty("selected")]
        public bool Selected { get; set; } = true;

        [JsonProperty("notes")]
        public string Notes { get; set; }

        /// <summary>
        /// Set when this column was created by a proposed relationship, and holds that
        /// relationship's diagram id.
        ///
        /// A relationship in Dataverse is a lookup column plus its cascade rules, so proposing one
        /// creates the column too. The column is the relationship's: it is renamed when the lookup name changes, it
        /// moves when the many end changes, and it is removed when the relationship is. Null for
        /// every column the user or Dataverse owns.
        ///
        /// Additive, like <see cref="DiagramTable.OwnershipType"/>, so the file format stays at
        /// version 2 - a build that does not know the property sees an ordinary proposed lookup
        /// column.
        /// </summary>
        [JsonProperty("fromRelationshipId")]
        public string FromRelationshipId { get; set; }
    }

    /// <summary>An alternate key defined on a Dataverse table.</summary>
    public class AlternateKeyInfo
    {
        [JsonProperty("schemaName")]
        public string SchemaName { get; set; }

        [JsonProperty("displayName")]
        public string DisplayName { get; set; }

        [JsonProperty("columns")]
        public List<string> Columns { get; set; } = new List<string>();

        [JsonProperty("state")]
        public string State { get; set; }
    }
}
