using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Tomlyn;
using Tomlyn.Model;

namespace RanParty.Core.Mcp;

public sealed class McpConnectorStore
{
    private readonly string _path;
    private readonly McpSecretStore _secrets;
    private readonly object _sync = new();

    public McpConnectorStore(string configDirectory)
    {
        string root = Path.GetFullPath(configDirectory);
        _path = Path.Combine(root, "connectors.json");
        _secrets = new McpSecretStore(Path.Combine(root, "connector-secrets.json"));
    }

    public IReadOnlyList<McpConnectorConfig> List()
    {
        lock (_sync) return LoadDocument().Connectors.Select(Clone).ToArray();
    }

    public McpConnectorConfig Get(string id) => List().FirstOrDefault(item => item.Id == id)
        ?? throw new InvalidOperationException("连接器不存在");

    public McpConnectorConfig Save(JsonObject input)
    {
        lock (_sync)
        {
            var document = LoadDocument();
            string id = Text(input, "id");
            if (string.IsNullOrWhiteSpace(id)) id = "mcp_" + Guid.NewGuid().ToString("N")[..10];
            var existing = document.Connectors.FirstOrDefault(item => item.Id == id);
            var config = JsonSerializer.Deserialize<McpConnectorConfig>(input.ToJsonString(), McpConnectorJson.Options) ?? new();
            config.Id = id;
            if (existing is not null)
            {
                config.EnvSecretRefs = new Dictionary<string, string>(existing.EnvSecretRefs, StringComparer.OrdinalIgnoreCase);
                config.HeaderSecretRefs = new Dictionary<string, string>(existing.HeaderSecretRefs, StringComparer.OrdinalIgnoreCase);
            }
            Normalize(config);
            CaptureSecrets(config, input, "env", config.EnvSecretRefs);
            CaptureSecrets(config, input, "headers", config.HeaderSecretRefs);
            if (input["bearerToken"]?.GetValue<string>() is string bearer && !string.IsNullOrWhiteSpace(bearer))
                config.HeaderSecretRefs["Authorization"] = _secrets.Put(id, "header", "Authorization", "Bearer " + bearer.Trim());
            config.TrustFingerprint = Fingerprint(config);
            if (existing is null) document.Connectors.Add(config);
            else document.Connectors[document.Connectors.IndexOf(existing)] = config;
            Persist(document);
            return Clone(config);
        }
    }

    public void Delete(string id)
    {
        lock (_sync)
        {
            var document = LoadDocument();
            document.Connectors.RemoveAll(item => item.Id == id);
            Persist(document);
            _secrets.RemoveConnector(id);
        }
    }

    public IReadOnlyDictionary<string, string> ResolveEnvironment(McpConnectorConfig config) =>
        config.EnvSecretRefs.ToDictionary(pair => pair.Key, pair => _secrets.Get(config.Id, pair.Value) ?? "", StringComparer.OrdinalIgnoreCase);

    public IReadOnlyDictionary<string, string> ResolveHeaders(McpConnectorConfig config) =>
        config.HeaderSecretRefs.ToDictionary(pair => pair.Key, pair => _secrets.Get(config.Id, pair.Value) ?? "", StringComparer.OrdinalIgnoreCase);

    public void StoreOAuthTokens(string connectorId, string json) => _secrets.Put(connectorId, "oauth", "tokens", json);
    public string? LoadOAuthTokens(string connectorId) => _secrets.Get(connectorId, $"{connectorId}:oauth:tokens");
    public void ClearOAuthTokens(string connectorId) => _secrets.Remove($"{connectorId}:oauth:tokens");

    public JsonObject ImportPreview(string format, string content)
    {
        var candidates = format.Equals("codex", StringComparison.OrdinalIgnoreCase)
            ? ParseCodex(content)
            : ParseClaude(content);
        var existing = List().Select(item => item.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (JsonObject candidate in candidates.OfType<JsonObject>())
        {
            string baseName = candidate["name"]?.GetValue<string>() ?? "MCP";
            string name = baseName;
            for (int suffix = 2; existing.Contains(name); suffix++) name = $"{baseName} ({suffix})";
            candidate["name"] = name;
            existing.Add(name);
        }
        return new JsonObject { ["format"] = format, ["connectors"] = candidates };
    }

    private JsonArray ParseCodex(string content)
    {
        var result = new JsonArray();
        TomlTable root = TomlSerializer.Deserialize<TomlTable>(content) ?? new TomlTable();
        if (root["mcp_servers"] is not TomlTable servers) return result;
        foreach (var pair in servers)
        {
            if (pair.Value is not TomlTable server) continue;
            var connector = new JsonObject { ["name"] = pair.Key, ["enabled"] = false, ["approvalMode"] = "ask" };
            if (server.TryGetValue("url", out object? url)) { connector["type"] = "streamable_http"; connector["url"] = url?.ToString(); }
            else { connector["type"] = "stdio"; connector["command"] = server.TryGetValue("command", out object? cmd) ? cmd?.ToString() : ""; }
            if (server.TryGetValue("args", out object? args) && args is TomlArray argArray)
                connector["args"] = new JsonArray(argArray.Select(item => (JsonNode?)JsonValue.Create(item?.ToString())).ToArray());
            if (server.TryGetValue("env", out object? env) && env is TomlTable envTable)
                connector["env"] = new JsonObject(envTable.Select(item => KeyValuePair.Create(item.Key, (JsonNode?)JsonValue.Create(item.Value?.ToString()))));
            if (server.TryGetValue("http_headers", out object? headers) && headers is TomlTable headerTable)
                connector["headers"] = new JsonObject(headerTable.Select(item => KeyValuePair.Create(item.Key, (JsonNode?)JsonValue.Create(item.Value?.ToString()))));
            result.Add(connector);
        }
        return result;
    }

    private static JsonArray ParseClaude(string content)
    {
        var result = new JsonArray();
        var servers = JsonNode.Parse(content)?["mcpServers"] as JsonObject ?? new JsonObject();
        foreach (var pair in servers)
        {
            if (pair.Value is not JsonObject server) continue;
            var connector = server.DeepClone().AsObject();
            connector["name"] = pair.Key;
            connector["type"] = server["url"] is null ? "stdio" : "streamable_http";
            connector["enabled"] = false;
            connector["approvalMode"] = "ask";
            result.Add(connector);
        }
        return result;
    }

    private McpConnectorDocument LoadDocument()
    {
        if (!File.Exists(_path)) return new();
        try
        {
            string json = File.ReadAllText(_path);
            JsonNode? root = JsonNode.Parse(json);
            if (root is JsonArray legacy)
            {
                var migrated = new McpConnectorDocument();
                foreach (JsonObject item in legacy.OfType<JsonObject>())
                {
                    item["enabled"] = false;
                    if (item["type"]?.GetValue<string>() == "http") item["type"] = "streamable_http";
                    var config = JsonSerializer.Deserialize<McpConnectorConfig>(item.ToJsonString(), McpConnectorJson.Options) ?? new();
                    Normalize(config);
                    config.TrustFingerprint = Fingerprint(config);
                    migrated.Connectors.Add(config);
                }
                Persist(migrated);
                return migrated;
            }
            return JsonSerializer.Deserialize<McpConnectorDocument>(json, McpConnectorJson.Options) ?? new();
        }
        catch { return new(); }
    }

    private void Persist(McpConnectorDocument document)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        string temporary = _path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(document, McpConnectorJson.Options), new UTF8Encoding(false));
        File.Move(temporary, _path, true);
    }

    private void CaptureSecrets(McpConnectorConfig config, JsonObject input, string property, Dictionary<string, string> references)
    {
        if (input[property] is not JsonObject values) return;
        foreach (string removed in references.Keys.Where(key => !values.ContainsKey(key)).ToArray())
        {
            _secrets.Remove(references[removed]);
            references.Remove(removed);
        }
        foreach (var pair in values)
        {
            string value = pair.Value?.GetValue<string>() ?? "";
            if (string.IsNullOrEmpty(value) || value == "********") continue;
            references[pair.Key] = _secrets.Put(config.Id, property == "env" ? "env" : "header", pair.Key, value);
        }
    }

    private static void Normalize(McpConnectorConfig config)
    {
        config.Name = config.Name.Trim();
        if (string.IsNullOrWhiteSpace(config.Name)) throw new InvalidOperationException("连接器名称不能为空");
        if (config.Type == "http") config.Type = "streamable_http";
        if (config.Type is not ("stdio" or "streamable_http")) throw new InvalidOperationException("连接器类型必须是 stdio 或 streamable_http");
        if (config.Type == "stdio" && string.IsNullOrWhiteSpace(config.Command)) throw new InvalidOperationException("stdio 连接器缺少 command");
        if (config.Type == "streamable_http")
        {
            if (!Uri.TryCreate(config.Url, UriKind.Absolute, out Uri? uri) || uri.Scheme is not ("http" or "https")) throw new InvalidOperationException("HTTP 连接器 URL 无效");
            if (!string.IsNullOrEmpty(uri.UserInfo)) throw new InvalidOperationException("连接器 URL 不允许内嵌凭据");
        }
        config.ApprovalMode = config.ApprovalMode is "auto" or "deny" ? config.ApprovalMode : "ask";
        config.ConnectTimeoutSeconds = Math.Clamp(config.ConnectTimeoutSeconds, 3, 120);
        config.ToolTimeoutSeconds = Math.Clamp(config.ToolTimeoutSeconds, 3, 600);
        config.Sampling.RequestsPerMinute = Math.Clamp(config.Sampling.RequestsPerMinute, 1, 10);
        config.Sampling.MaxTokens = Math.Clamp(config.Sampling.MaxTokens, 1, 4096);
        config.Sampling.TimeoutSeconds = Math.Clamp(config.Sampling.TimeoutSeconds, 1, 30);
        config.Sampling.MaxToolRounds = 0;
    }

    private static string Fingerprint(McpConnectorConfig config)
    {
        string value = string.Join('\n', config.Type, config.Command, string.Join('\0', config.Args), config.Cwd, config.Url,
            string.Join(',', config.EnvSecretRefs.Keys.Order()), string.Join(',', config.HeaderSecretRefs.Keys.Order()), config.Auth);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..16];
    }

    private static McpConnectorConfig Clone(McpConnectorConfig value) =>
        JsonSerializer.Deserialize<McpConnectorConfig>(JsonSerializer.Serialize(value, McpConnectorJson.Options), McpConnectorJson.Options)!;

    private static string Text(JsonObject input, string key) => input[key]?.GetValue<string>()?.Trim() ?? "";
}
