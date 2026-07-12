using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RanParty.Core;

public class SessionMeta
{
    public string Workspace = "";
    public string Model = "";
    public string ProfileName = "";
    public string Title = "";
    public string ApprovalMode = "";
    public string Mode = "default";
    public string GoalText = "";
    public string GoalStatus = "active";
    public JsonObject? PendingConfig;
    public List<string> ReferencedSessions = new();
    public int TokensIn;
    public int TokensOut;
    public int ContextTokens;
    public int ContextThreshold;
    public int ContextWindow;
    public DateTime LastActive;
}

/// <summary>Versioned, atomic JSON session persistence with one-way legacy text migration.</summary>
public sealed class SessionStore
{
    private const int FormatVersion = 2;
    private const long MaxSessionFileBytes = 64L * 1024 * 1024;
    private const int MaxSessionFiles = 10_000;
    private readonly string _dir;
    private readonly string _legacyPath;

    public SessionStore()
    {
        _dir = Path.GetFullPath("Config/Sessions");
        _legacyPath = Path.GetFullPath("Config/session_active.txt");
    }

    public void EnsureDir() => Directory.CreateDirectory(_dir);

    public List<(string id, List<JsonNode> msgs, SessionMeta meta, DateTime lastWrite)> LoadAll()
    {
        EnsureDir();
        MigrateSingleSessionFiles();
        var result = new List<(string, List<JsonNode>, SessionMeta, DateTime)>();
        var loaded = new HashSet<string>(StringComparer.Ordinal);

        foreach (string path in Directory.EnumerateFiles(_dir, "*.json").Take(MaxSessionFiles))
        {
            string id = Path.GetFileNameWithoutExtension(path);
            if (!IsSafeId(id)) continue;
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.SequentialScan);
                if (stream.Length > MaxSessionFileBytes) throw new InvalidDataException("Session file exceeds 64MB");
                var root = JsonNode.Parse(stream) as JsonObject ?? throw new InvalidDataException("Session document is not an object");
                int version = root["version"]?.GetValue<int>() ?? 0;
                if (version != FormatVersion) throw new InvalidDataException($"Unsupported session format: {version}");
                var meta = MetaFromJson(root["meta"] as JsonObject ?? new JsonObject());
                var messages = (root["messages"] as JsonArray ?? new JsonArray())
                    .Where(node => node is not null).Select(node => node!.DeepClone()).ToList();
                DateTime lastWrite = meta.LastActive == default ? File.GetLastWriteTime(path) : meta.LastActive;
                result.Add((id, messages, meta, lastWrite));
                loaded.Add(id);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidDataException
                or InvalidOperationException or FormatException or OverflowException)
            {
                System.Diagnostics.Debug.WriteLine($"SessionStore.Load skipped {path}: {ex.Message}");
            }
        }

        // Old per-session line files remain readable until the first successful save.
        foreach (string path in Directory.EnumerateFiles(_dir, "*.txt").Take(MaxSessionFiles))
        {
            string id = Path.GetFileNameWithoutExtension(path);
            if (loaded.Contains(id) || !IsSafeId(id)) continue;
            try
            {
                var (messages, meta) = ReadLegacySession(path);
                DateTime lastWrite = meta.LastActive == default ? File.GetLastWriteTime(path) : meta.LastActive;
                result.Add((id, messages, meta, lastWrite));
            }
            catch (Exception ex) when (IsLegacyIsolationFailure(ex))
            {
                System.Diagnostics.Debug.WriteLine($"SessionStore legacy load skipped {path}: {ex.Message}");
            }
        }
        result.Sort((left, right) => right.Item4.CompareTo(left.Item4));
        return result;
    }

    public bool Save(string id, List<JsonNode> messages, SessionMeta meta)
    {
        if (!IsSafeId(id)) throw new InvalidDataException("Invalid session id");
        EnsureDir();
        var root = new JsonObject
        {
            ["version"] = FormatVersion,
            ["id"] = id,
            ["meta"] = MetaToJson(meta ?? new SessionMeta()),
            ["messages"] = new JsonArray(messages.Select(message => (JsonNode?)message.DeepClone()).ToArray())
        };
        string path = Path.Combine(_dir, id + ".json");
        string temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            string json = root.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
            if (Encoding.UTF8.GetByteCount(json) > MaxSessionFileBytes) throw new InvalidDataException("Session file exceeds 64MB");
            File.WriteAllText(temporary, json, new UTF8Encoding(false));
            File.Move(temporary, path, true);
            string legacy = Path.Combine(_dir, id + ".txt");
            if (File.Exists(legacy)) File.Delete(legacy);
            return true;
        }
        catch
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            throw;
        }
    }

    public void Delete(string id)
    {
        if (!IsSafeId(id)) throw new InvalidDataException("Invalid session id");
        foreach (string extension in new[] { ".json", ".txt" })
        {
            string path = Path.Combine(_dir, id + extension);
            if (File.Exists(path)) File.Delete(path);
        }
    }

    private void MigrateSingleSessionFiles()
    {
        foreach (string path in new[] { _legacyPath, Path.GetFullPath("Config/SuperCat_active.txt") })
        {
            if (!File.Exists(path)) continue;
            try
            {
                var (messages, meta) = ReadLegacySession(path);
                if (messages.Count > 0)
                {
                    string id = "s_" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
                    Save(id, messages, meta);
                }
                File.Delete(path);
            }
            catch (Exception ex) when (IsLegacyIsolationFailure(ex))
            {
                System.Diagnostics.Debug.WriteLine($"SessionStore migration failed {path}: {ex.Message}");
            }
        }
    }

    private static (List<JsonNode> messages, SessionMeta meta) ReadLegacySession(string path)
    {
        if (new FileInfo(path).Length > MaxSessionFileBytes) throw new InvalidDataException("Legacy session file exceeds 64MB");
        var meta = new SessionMeta();
        var messages = new List<JsonNode>();
        int lineNumber = 0;
        foreach (string line in File.ReadLines(path))
        {
            lineNumber++;
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (line.StartsWith("@workspace=")) { meta.Workspace = LegacyValue(line, "@workspace="); continue; }
            if (line.StartsWith("@model=")) { meta.Model = LegacyValue(line, "@model="); continue; }
            if (line.StartsWith("@profile=")) { meta.ProfileName = LegacyValue(line, "@profile="); continue; }
            if (line.StartsWith("@title=")) { meta.Title = LegacyValue(line, "@title="); continue; }
            if (line.StartsWith("@approval=")) { meta.ApprovalMode = LegacyValue(line, "@approval="); continue; }
            if (line.StartsWith("@mode=")) { meta.Mode = LegacyValue(line, "@mode="); continue; }
            if (line.StartsWith("@goal_text=")) { meta.GoalText = LegacyValue(line, "@goal_text="); continue; }
            if (line.StartsWith("@goal_status=")) { meta.GoalStatus = LegacyValue(line, "@goal_status="); continue; }
            if (line.StartsWith("@references=")) { meta.ReferencedSessions = LegacyValue(line, "@references=").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(IsSafeId).Distinct(StringComparer.Ordinal).Take(8).ToList(); continue; }
            if (line.StartsWith("@last_active=")) { DateTime.TryParse(LegacyValue(line, "@last_active="), null, System.Globalization.DateTimeStyles.RoundtripKind, out meta.LastActive); continue; }
            if (line.StartsWith("@ctx_threshold=")) { int.TryParse(LegacyValue(line, "@ctx_threshold="), out meta.ContextThreshold); continue; }
            if (line.StartsWith("@ctx_window=")) { int.TryParse(LegacyValue(line, "@ctx_window="), out meta.ContextWindow); continue; }
            if (line.StartsWith("@context_tokens=")) { int.TryParse(LegacyValue(line, "@context_tokens="), out meta.ContextTokens); continue; }
            if (line.StartsWith("@tokens="))
            {
                string[] values = LegacyValue(line, "@tokens=").Split(',');
                if (values.Length >= 2) { int.TryParse(values[0], out meta.TokensIn); int.TryParse(values[1], out meta.TokensOut); }
                continue;
            }
            try
            {
                JsonNode message = JsonNode.Parse(line)
                    ?? throw new JsonException("Legacy session message cannot be null");
                messages.Add(message);
            }
            catch (JsonException ex)
            {
                throw new InvalidDataException($"Legacy session contains invalid JSON at line {lineNumber}", ex);
            }
        }
        return (messages, meta);
    }

    private static bool IsLegacyIsolationFailure(Exception ex) => ex is
        IOException or UnauthorizedAccessException or InvalidDataException or JsonException
        or InvalidOperationException or FormatException or OverflowException;

    private static string LegacyValue(string line, string prefix) =>
        line[prefix.Length..].Replace("\r", " ").Replace("\n", " ");

    private static JsonObject MetaToJson(SessionMeta meta) => new()
    {
        ["workspace"] = meta.Workspace ?? "",
        ["model"] = meta.Model ?? "",
        ["profileName"] = meta.ProfileName ?? "",
        ["title"] = meta.Title ?? "",
        ["approvalMode"] = meta.ApprovalMode ?? "",
        ["mode"] = string.IsNullOrWhiteSpace(meta.Mode) ? "default" : meta.Mode,
        ["goalText"] = meta.GoalText ?? "",
        ["goalStatus"] = string.IsNullOrWhiteSpace(meta.GoalStatus) ? "active" : meta.GoalStatus,
        ["pendingConfig"] = meta.PendingConfig?.DeepClone(),
        ["referencedSessions"] = new JsonArray((meta.ReferencedSessions ?? new()).Where(IsSafeId).Distinct(StringComparer.Ordinal).Take(8).Select(id => (JsonNode?)id).ToArray()),
        ["tokensIn"] = meta.TokensIn,
        ["tokensOut"] = meta.TokensOut,
        ["contextTokens"] = meta.ContextTokens,
        ["contextThreshold"] = meta.ContextThreshold,
        ["contextWindow"] = meta.ContextWindow,
        ["lastActive"] = meta.LastActive.ToString("O")
    };

    private static SessionMeta MetaFromJson(JsonObject value) => new()
    {
        Workspace = value["workspace"]?.GetValue<string>() ?? "",
        Model = value["model"]?.GetValue<string>() ?? "",
        ProfileName = value["profileName"]?.GetValue<string>() ?? "",
        Title = value["title"]?.GetValue<string>() ?? "",
        ApprovalMode = value["approvalMode"]?.GetValue<string>() ?? "",
        Mode = value["mode"]?.GetValue<string>() ?? "default",
        GoalText = value["goalText"]?.GetValue<string>() ?? "",
        GoalStatus = value["goalStatus"]?.GetValue<string>() ?? "active",
        PendingConfig = value["pendingConfig"] as JsonObject is { } pending ? pending.DeepClone().AsObject() : null,
        ReferencedSessions = (value["referencedSessions"] as JsonArray ?? new()).Select(node => node?.GetValue<string>() ?? "").Where(IsSafeId).Distinct(StringComparer.Ordinal).Take(8).ToList(),
        TokensIn = value["tokensIn"]?.GetValue<int>() ?? 0,
        TokensOut = value["tokensOut"]?.GetValue<int>() ?? 0,
        ContextTokens = value["contextTokens"]?.GetValue<int>() ?? 0,
        ContextThreshold = value["contextThreshold"]?.GetValue<int>() ?? 0,
        ContextWindow = value["contextWindow"]?.GetValue<int>() ?? 0,
        LastActive = DateTime.TryParse(value["lastActive"]?.GetValue<string>(), null, System.Globalization.DateTimeStyles.RoundtripKind, out DateTime lastActive) ? lastActive : default
    };

    private static bool IsSafeId(string value) => value.Length is > 0 and <= 160
        && value.All(character => char.IsLetterOrDigit(character) || character is '_' or '-');
}
