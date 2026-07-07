using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace RanParty.Core;

public sealed class SearchCache
{
    private readonly string _path;
    private readonly ConcurrentDictionary<string, (string resultJson, DateTime expires)> _hot = new();
    private readonly SemaphoreSlim _dbLock = new(1, 1);
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromHours(24);

    public SearchCache()
    {
        Directory.CreateDirectory(Path.GetFullPath("CatTemp"));
        _path = Path.GetFullPath(Path.Combine("CatTemp", "search_results.db"));
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "CREATE TABLE IF NOT EXISTS results (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, provider TEXT NOT NULL, created_at INTEGER NOT NULL)";
        cmd.ExecuteNonQuery();
    }

    public bool TryGet(string query, out string resultJson, TimeSpan? ttl = null)
    {
        var effectiveTtl = ttl ?? DefaultTtl;
        var key = Hash(query);
        if (_hot.TryGetValue(key, out var hot) && DateTime.UtcNow < hot.expires)
        {
            resultJson = hot.resultJson;
            return true;
        }

        resultJson = "";
        try
        {
            _dbLock.Wait();
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT result_json, created_at FROM results WHERE key = @key";
            cmd.Parameters.AddWithValue("@key", key);
            using var reader = cmd.ExecuteReader();
            if (reader.Read())
            {
                long timestamp = reader.GetInt64(1);
                var createdAt = DateTimeOffset.FromUnixTimeSeconds(timestamp).UtcDateTime;
                if (DateTime.UtcNow - createdAt < effectiveTtl)
                {
                    resultJson = reader.GetString(0);
                    _hot[key] = (resultJson, DateTime.UtcNow.Add(effectiveTtl));
                    return true;
                }
            }
        }
        finally { _dbLock.Release(); }
        return false;
    }

    public void Put(string query, string resultJson, string provider)
    {
        var key = Hash(query);
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        try
        {
            _dbLock.Wait();
            using var conn = Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "INSERT OR REPLACE INTO results (key, result_json, provider, created_at) VALUES (@key, @json, @provider, @ts)";
            cmd.Parameters.AddWithValue("@key", key);
            cmd.Parameters.AddWithValue("@json", resultJson);
            cmd.Parameters.AddWithValue("@provider", provider);
            cmd.Parameters.AddWithValue("@ts", now);
            cmd.ExecuteNonQuery();
        }
        finally { _dbLock.Release(); }
        _hot[key] = (resultJson, DateTime.UtcNow.Add(DefaultTtl));
    }

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection($"Data Source={_path}");
        conn.Open();
        using var pragmaCmd = conn.CreateCommand();
        pragmaCmd.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL";
        pragmaCmd.ExecuteNonQuery();
        return conn;
    }

    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text ?? ""))).ToLowerInvariant();
}
