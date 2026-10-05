// Compile-verification stub for Newtonsoft.Json.
//
// This is a working implementation rather than an empty shim: it maps [JsonProperty] names and
// [JsonConverter(typeof(StringEnumConverter))] onto System.Text.Json so the round-trip tests
// actually exercise the real serialised shape, including the property names the JavaScript
// canvas depends on. Never shipped.
#pragma warning disable CS0067, CS0169, CS0649

using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Newtonsoft.Json
{
    public enum Formatting { None, Indented }
    public enum NullValueHandling { Include, Ignore }
    public enum DateTimeZoneHandling { Local, Utc, Unspecified, RoundtripKind }
    public enum DateFormatHandling { IsoDateFormat, MicrosoftDateFormat }

    // System.Text.Json never auto-detects a date inside an untyped token, so DateParseHandling is
    // inert here - the enum and the property exist so the real source compiles. The harness
    // cannot check DateParseHandling.None by round-tripping, so ExportChecks checks the source.
    public enum DateParseHandling { None, DateTime, DateTimeOffset }

    public class JsonException : Exception
    {
        public JsonException() { }
        public JsonException(string message) : base(message) { }
        public JsonException(string message, Exception inner) : base(message, inner) { }
    }

    public class JsonSerializerSettings
    {
        public Formatting Formatting { get; set; }
        public NullValueHandling NullValueHandling { get; set; }
        public DateTimeZoneHandling DateTimeZoneHandling { get; set; }
        public DateFormatHandling DateFormatHandling { get; set; }
        public DateParseHandling DateParseHandling { get; set; }
    }

    /// <summary>Enough JsonTextReader for JObject.Load(reader) to compile and read.</summary>
    public class JsonTextReader : IDisposable
    {
        private readonly System.IO.TextReader _reader;

        public JsonTextReader(System.IO.TextReader reader) { _reader = reader; }

        public DateParseHandling DateParseHandling { get; set; }

        internal string ReadAll() { return _reader == null ? string.Empty : _reader.ReadToEnd(); }

        public void Dispose() { if (_reader != null) _reader.Dispose(); }
    }

    public class JsonSerializer
    {
        internal JsonSerializerSettings Settings { get; set; }
        public static JsonSerializer Create(JsonSerializerSettings settings)
        {
            return new JsonSerializer { Settings = settings };
        }
    }

    internal static class OptionsFactory
    {
        public static JsonSerializerOptions Build(JsonSerializerSettings settings)
        {
            var options = new JsonSerializerOptions
            {
                WriteIndented = settings != null && settings.Formatting == Formatting.Indented,
                DefaultIgnoreCondition = settings != null && settings.NullValueHandling == NullValueHandling.Ignore
                    ? JsonIgnoreCondition.WhenWritingNull
                    : JsonIgnoreCondition.Never,
                PropertyNameCaseInsensitive = true,
                NumberHandling = JsonNumberHandling.AllowReadingFromString
            };

            options.Converters.Add(new JsonStringEnumConverter());

            var resolver = new DefaultJsonTypeInfoResolver();
            resolver.Modifiers.Add(ApplyNewtonsoftAttributes);
            options.TypeInfoResolver = resolver;

            return options;
        }

        private static void ApplyNewtonsoftAttributes(JsonTypeInfo typeInfo)
        {
            if (typeInfo.Kind != JsonTypeInfoKind.Object) return;

            var toRemove = new List<JsonPropertyInfo>();

            foreach (var property in typeInfo.Properties)
            {
                var member = FindMember(typeInfo.Type, property);
                if (member == null) continue;

                if (member.GetCustomAttribute<JsonIgnoreAttribute>() != null)
                {
                    toRemove.Add(property);
                    continue;
                }

                var jsonProperty = member.GetCustomAttribute<JsonPropertyAttribute>();
                if (jsonProperty != null && !string.IsNullOrEmpty(jsonProperty.PropertyName))
                    property.Name = jsonProperty.PropertyName;
            }

            foreach (var property in toRemove) typeInfo.Properties.Remove(property);
        }

        private static MemberInfo FindMember(Type type, JsonPropertyInfo property)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

            foreach (var candidate in type.GetProperties(flags))
            {
                if (string.Equals(candidate.Name, property.Name, StringComparison.OrdinalIgnoreCase)) return candidate;

                var attribute = candidate.GetCustomAttribute<JsonPropertyAttribute>();
                if (attribute != null && string.Equals(attribute.PropertyName, property.Name, StringComparison.Ordinal))
                    return candidate;
            }

            return null;
        }
    }

    public static class JsonConvert
    {
        public static string SerializeObject(object value)
        {
            return System.Text.Json.JsonSerializer.Serialize(value, OptionsFactory.Build(null));
        }

        public static string SerializeObject(object value, Formatting formatting)
        {
            return System.Text.Json.JsonSerializer.Serialize(value,
                OptionsFactory.Build(new JsonSerializerSettings { Formatting = formatting }));
        }

        public static string SerializeObject(object value, JsonSerializerSettings settings)
        {
            return System.Text.Json.JsonSerializer.Serialize(value, OptionsFactory.Build(settings));
        }

        public static T DeserializeObject<T>(string value)
        {
            return DeserializeObject<T>(value, null);
        }

        public static T DeserializeObject<T>(string value, JsonSerializerSettings settings)
        {
            try
            {
                return System.Text.Json.JsonSerializer.Deserialize<T>(value, OptionsFactory.Build(settings));
            }
            catch (System.Text.Json.JsonException ex)
            {
                throw new JsonException(ex.Message, ex);
            }
        }
    }

    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
    public class JsonPropertyAttribute : Attribute
    {
        public JsonPropertyAttribute() { }
        public JsonPropertyAttribute(string propertyName) { PropertyName = propertyName; }
        public string PropertyName { get; set; }
    }

    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
    public class JsonIgnoreAttribute : Attribute { }

    [AttributeUsage(AttributeTargets.Property | AttributeTargets.Field | AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Enum | AttributeTargets.Parameter)]
    public class JsonConverterAttribute : Attribute
    {
        public JsonConverterAttribute(Type converterType) { ConverterType = converterType; }
        public Type ConverterType { get; private set; }
    }

    public abstract class JsonConverter { }
}

namespace Newtonsoft.Json.Converters
{
    public class StringEnumConverter : Newtonsoft.Json.JsonConverter { }
}

namespace Newtonsoft.Json.Linq
{
    public enum JTokenType { None, Object, Array, Integer, Float, String, Boolean, Null, Date, Undefined }

    public class JToken
    {
        internal JsonNode Node;

        internal JToken(JsonNode node) { Node = node; }

        /// <summary>
        /// Enough of the real Type to tell "absent or null" from "present" - which is what
        /// DiagramFile needs to distinguish a file with no formatVersion from one recording 1.
        /// </summary>
        public JTokenType Type
        {
            get
            {
                if (Node == null) return JTokenType.Null;
                switch (Node.GetValueKind())
                {
                    case JsonValueKind.Object: return JTokenType.Object;
                    case JsonValueKind.Array: return JTokenType.Array;
                    case JsonValueKind.String: return JTokenType.String;
                    case JsonValueKind.Number: return JTokenType.Integer;
                    case JsonValueKind.True:
                    case JsonValueKind.False: return JTokenType.Boolean;
                    case JsonValueKind.Null: return JTokenType.Null;
                    default: return JTokenType.Undefined;
                }
            }
        }

        public virtual JToken this[string key]
        {
            get
            {
                var obj = Node as JsonObject;
                if (obj == null) return null;

                JsonNode child;
                if (!obj.TryGetPropertyValue(key, out child) || child == null) return null;

                // Typed on the way out, so `root["annotations"] as JArray` behaves the way the real
                // library does. A bare JToken would make every such cast produce null.
                if (child is JsonArray) return new JArray(child);
                if (child is JsonObject) return new JObject(child);
                return new JToken(child);
            }
            set
            {
                var obj = Node as JsonObject;
                if (obj == null) return;
                obj[key] = value == null || value.Node == null ? null : value.Node.DeepClone();
            }
        }

        public static implicit operator JToken(int value)
        {
            return new JToken(JsonValue.Create(value));
        }

        public static implicit operator JToken(string value)
        {
            return value == null ? null : new JToken(JsonValue.Create(value));
        }

        public T ToObject<T>()
        {
            return Node == null
                ? default(T)
                : System.Text.Json.JsonSerializer.Deserialize<T>(Node.ToJsonString(), Newtonsoft.Json.OptionsFactory.Build(null));
        }

        public T ToObject<T>(Newtonsoft.Json.JsonSerializer serializer)
        {
            return Node == null
                ? default(T)
                : System.Text.Json.JsonSerializer.Deserialize<T>(Node.ToJsonString(),
                    Newtonsoft.Json.OptionsFactory.Build(serializer == null ? null : serializer.Settings));
        }

        public static explicit operator string(JToken token)
        {
            if (token == null || token.Node == null) return null;
            var value = token.Node.AsValue();
            string result;
            return value.TryGetValue(out result) ? result : token.Node.ToString();
        }

        public static explicit operator bool?(JToken token)
        {
            if (token == null || token.Node == null) return null;
            bool result;
            return token.Node.AsValue().TryGetValue(out result) ? result : (bool?)null;
        }

        public static explicit operator int?(JToken token)
        {
            if (token == null || token.Node == null) return null;
            int result;
            return token.Node.AsValue().TryGetValue(out result) ? result : (int?)null;
        }
    }

    public class JObject : JToken
    {
        public JObject() : base(new JsonObject()) { }
        internal JObject(JsonNode node) : base(node) { }

        public static JObject Parse(string json) { return new JObject(JsonNode.Parse(json)); }

        public static JObject Load(Newtonsoft.Json.JsonTextReader reader)
        {
            return new JObject(JsonNode.Parse(reader.ReadAll()));
        }

        public bool Remove(string key)
        {
            var obj = Node as JsonObject;
            return obj != null && obj.Remove(key);
        }
    }

    /// <summary>Enough JArray for the migration code to walk an annotations list.</summary>
    public class JArray : JToken, IEnumerable<JToken>
    {
        public JArray() : base(new JsonArray()) { }
        internal JArray(JsonNode node) : base(node) { }

        public IEnumerator<JToken> GetEnumerator()
        {
            var array = Node as JsonArray;
            if (array == null) yield break;

            foreach (var item in array)
            {
                if (item == null) continue;
                yield return item is JsonObject ? new JObject(item) : new JToken(item);
            }
        }

        IEnumerator IEnumerable.GetEnumerator() { return GetEnumerator(); }
    }
}
