using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;

using RanParty.Debug;
namespace RanParty.Core;

public class Logger
{
    public string SessionDir;
    string _sessionFile;
    int _callN = 0;
    private readonly bool _logFullPayloads;
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

    public Logger(bool? logFullPayloads = null)
    {
        _logFullPayloads = logFullPayloads ?? FullPayloadLoggingRequested();
        string name = "RanParty " + DateTime.Now.ToString("yyyy-MM-dd HH-mm-ss");
        SessionDir = Path.Combine(Path.GetFullPath("Log"), name);
        Directory.CreateDirectory(SessionDir);
        _sessionFile = Path.Combine(SessionDir, "session.jsonl");
        Log("session_started", new JsonObject { ["version"] = "1.0", ["fullPayloadLogging"] = _logFullPayloads });
    }

    public bool FullPayloadLoggingEnabled => _logFullPayloads;

    public DebugServer? Debug;
    public event Action<string>? OnLog;

    private readonly object _fileLock = new();

    private void WriteLine(string level, string eventName, JsonNode? data = null)
    {
        var entry = new JsonObject
        {
            ["ts"] = DateTime.Now.ToString("O"),
            ["level"] = level,
            ["event"] = eventName
        };
        if (data != null) entry["data"] = data;
        string line = entry.ToJsonString(JsonOpts);
        lock (_fileLock)
        {
            try { File.AppendAllText(_sessionFile, line + "\n"); } catch { }
        }
        Debug?.Broadcast(line);
        OnLog?.Invoke(line);
    }

    public void Log(string msg)
    {
        var data = new JsonObject { ["message"] = msg };
        WriteLine("INFO", "log", data);
    }

    public void Log(string eventName, JsonNode? data = null)
    {
        WriteLine("INFO", eventName, data);
    }

    public void Err(string msg)
    {
        var data = new JsonObject { ["message"] = msg };
        WriteLine("ERROR", "error", data);
    }

    public void WriteCall(string request, string response)
    {
        try
        {
            int callNum = Interlocked.Increment(ref _callN);
            // Default logs contain metadata only. Full model payloads can include
            // user messages, system prompts, memory, and repository contents, so
            // they require an explicit constructor option or environment opt-in.
            int reqLen = request?.Length ?? 0;
            int respLen = response?.Length ?? 0;
            string summaryPath = Path.Combine(SessionDir, $"CALL-{callNum:D3}-summary.json");
            var summary = new JsonObject
            {
                ["callIndex"] = callNum,
                ["requestBytes"] = reqLen,
                ["responseBytes"] = respLen,
                ["requestMessages"] = CountRequestMessages(request),
                ["responseEvents"] = CountResponseEvents(response),
                ["fullPayloadLogged"] = _logFullPayloads
            };
            File.WriteAllText(summaryPath, summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            if (_logFullPayloads)
            {
                string fullPath = Path.Combine(SessionDir, $"CALL-{callNum:D3}-full.txt");
                File.WriteAllText(fullPath, $"=== REQUEST ({reqLen} bytes) ===\r\n{request}\r\n\r\n=== RESPONSE ({respLen} bytes) ===\r\n{response}\r\n");
            }
        }
        catch { }
    }

    private static bool FullPayloadLoggingRequested()
    {
        string value = Environment.GetEnvironmentVariable("RANPARTY_LOG_FULL_PAYLOADS") ?? "";
        return value.Equals("1", StringComparison.OrdinalIgnoreCase)
            || value.Equals("true", StringComparison.OrdinalIgnoreCase)
            || value.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    private static int CountRequestMessages(string? request)
    {
        if (string.IsNullOrWhiteSpace(request)) return 0;
        try
        {
            var root = JsonNode.Parse(request);
            return root?["messages"] is JsonArray messages ? messages.Count
                : root?["input"] is JsonArray input ? input.Count
                : 0;
        }
        catch { return 0; }
    }

    private static int CountResponseEvents(string? response)
    {
        if (string.IsNullOrWhiteSpace(response)) return 0;
        return response.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
