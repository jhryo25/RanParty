using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

using RanParty.Debug;
namespace RanParty.Core;

public class Logger
{
    public string SessionDir;
    string _sessionFile;
    int _callN = 0;
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

    public Logger()
    {
        string name = "RanParty " + DateTime.Now.ToString("yyyy-MM-dd HH-mm-ss");
        SessionDir = Path.Combine(Path.GetFullPath("Log"), name);
        Directory.CreateDirectory(SessionDir);
        _sessionFile = Path.Combine(SessionDir, "session.jsonl");
        Log("session_started", new JsonObject { ["version"] = "1.0" });
    }

    public DebugServer Debug;
    public event Action<string> OnLog;

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
        try { File.AppendAllText(_sessionFile, line + "\n"); } catch { }
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
            _callN++;
            // 摘要模式：只记请求大小、消息数，不记完整内容
            int reqLen = request?.Length ?? 0;
            int respLen = response?.Length ?? 0;
            string summaryPath = Path.Combine(SessionDir, $"CALL-{_callN:D3}-summary.json");
            var summary = new JsonObject
            {
                ["callIndex"] = _callN,
                ["requestBytes"] = reqLen,
                ["responseBytes"] = respLen,
                ["requestPreview"] = (request?.Length > 500 ? request[..500] + "…" : request) ?? "",
                ["responsePreview"] = (response?.Length > 500 ? response[..500] + "…" : response) ?? ""
            };
            File.WriteAllText(summaryPath, summary.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            // 完整日志写入独立文件（仅在需要调试时查看）
            string fullPath = Path.Combine(SessionDir, $"CALL-{_callN:D3}-full.txt");
            File.WriteAllText(fullPath, $"=== REQUEST ({reqLen} bytes) ===\r\n{request}\r\n\r\n=== RESPONSE ({respLen} bytes) ===\r\n{response}\r\n");
        }
        catch { }
    }
}
