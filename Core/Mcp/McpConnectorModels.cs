using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace RanParty.Core.Mcp;

public sealed class McpConnectorDocument
{
    public int SchemaVersion { get; set; } = 2;
    public List<McpConnectorConfig> Connectors { get; set; } = new();
}

public sealed class McpConnectorConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public bool Enabled { get; set; }
    public bool Required { get; set; }
    public string Type { get; set; } = "stdio";
    public string Command { get; set; } = "";
    public List<string> Args { get; set; } = new();
    public string Cwd { get; set; } = "";
    public string Url { get; set; } = "";
    public Dictionary<string, string> EnvSecretRefs { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> HeaderSecretRefs { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public string Auth { get; set; } = "none";
    public List<string> Scopes { get; set; } = new();
    public List<string> EnabledTools { get; set; } = new();
    public List<string> PinnedTools { get; set; } = new();
    public Dictionary<string, string> ToolPolicies { get; set; } = new(StringComparer.Ordinal);
    public string ApprovalMode { get; set; } = "ask";
    public int ConnectTimeoutSeconds { get; set; } = 15;
    public int ToolTimeoutSeconds { get; set; } = 60;
    public bool SupportsParallelToolCalls { get; set; }
    public McpSamplingConfig Sampling { get; set; } = new();
    public string TrustFingerprint { get; set; } = "";
}

public sealed class McpSamplingConfig
{
    public bool Enabled { get; set; }
    public int RequestsPerMinute { get; set; } = 10;
    public int MaxTokens { get; set; } = 4096;
    public int TimeoutSeconds { get; set; } = 30;
    public int MaxToolRounds { get; set; }
}

public sealed class McpCatalogEntry
{
    public string Kind { get; set; } = "tool";
    public string Name { get; set; } = "";
    public string ExposedName { get; set; } = "";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public JsonNode? Schema { get; set; }
    public JsonNode? Annotations { get; set; }
    public bool Enabled { get; set; }
    public bool Pinned { get; set; }
}

public sealed class McpConnectorView
{
    public required McpConnectorConfig Config { get; init; }
    public string Status { get; init; } = "disconnected";
    public string LastError { get; init; } = "";
    public int ToolCount { get; init; }
    public int ResourceCount { get; init; }
    public int PromptCount { get; init; }
    public bool OAuthAuthenticated { get; init; }
}

public static class McpConnectorJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}
