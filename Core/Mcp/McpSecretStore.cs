using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RanParty.Core.Mcp;

internal sealed class McpSecretStore
{
    private readonly string _path;
    private readonly object _sync = new();

    public McpSecretStore(string path) => _path = Path.GetFullPath(path);

    public string Put(string connectorId, string category, string name, string value)
    {
        string key = $"{connectorId}:{category}:{name}";
        lock (_sync)
        {
            var values = Load();
            values[key] = Protect(connectorId, value);
            Save(values);
        }
        return key;
    }

    public string? Get(string connectorId, string reference)
    {
        lock (_sync)
        {
            var values = Load();
            return values.TryGetValue(reference, out string? protectedValue)
                ? Unprotect(connectorId, protectedValue)
                : null;
        }
    }

    public void RemoveConnector(string connectorId)
    {
        lock (_sync)
        {
            var values = Load();
            foreach (string key in values.Keys.Where(key => key.StartsWith(connectorId + ":", StringComparison.Ordinal)).ToArray())
                values.Remove(key);
            Save(values);
        }
    }

    public void Remove(string reference)
    {
        lock (_sync)
        {
            var values = Load();
            if (values.Remove(reference)) Save(values);
        }
    }

    private Dictionary<string, string> Load()
    {
        try
        {
            return File.Exists(_path)
                ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(_path), McpConnectorJson.Options) ?? new()
                : new();
        }
        catch { return new(); }
    }

    private void Save(Dictionary<string, string> values)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        string temporary = _path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(values, McpConnectorJson.Options), new UTF8Encoding(false));
        File.Move(temporary, _path, true);
    }

    private static string Protect(string connectorId, string value)
    {
        byte[] clear = Encoding.UTF8.GetBytes(value);
        byte[] entropy = SHA256.HashData(Encoding.UTF8.GetBytes("RanParty.MCP." + connectorId));
        byte[] encrypted = OperatingSystem.IsWindows()
            ? ProtectedData.Protect(clear, entropy, DataProtectionScope.CurrentUser)
            : clear;
        return Convert.ToBase64String(encrypted);
    }

    private static string Unprotect(string connectorId, string value)
    {
        byte[] encrypted = Convert.FromBase64String(value);
        byte[] entropy = SHA256.HashData(Encoding.UTF8.GetBytes("RanParty.MCP." + connectorId));
        byte[] clear = OperatingSystem.IsWindows()
            ? ProtectedData.Unprotect(encrypted, entropy, DataProtectionScope.CurrentUser)
            : encrypted;
        return Encoding.UTF8.GetString(clear);
    }
}
