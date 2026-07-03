using System;
using System.IO;

using RanParty.Debug;
namespace RanParty.Core;

public class Logger
{
    public string SessionDir;
    string _sessionFile;
    int _callN = 0;

    public Logger()
    {
        string name = "RanParty " + DateTime.Now.ToString("yyyy-MM-dd HH-mm-ss");
        SessionDir = Path.Combine(Path.GetFullPath("Log"), name);
        Directory.CreateDirectory(SessionDir);
        _sessionFile = Path.Combine(SessionDir, "session.txt");
        Log($"=== RanParty Session {DateTime.Now:yyyy-MM-dd HH:mm:ss} ===");
    }

    public DebugServer Debug;
    public event Action<string> OnLog;

    public void Log(string msg)
    {
        string l = $"[LOG] {msg}";
        try { File.AppendAllText(_sessionFile, l + "\r\n"); } catch { }
        Debug?.Broadcast(l);
        OnLog?.Invoke(l);
    }

    public void Err(string msg)
    {
        string l = $"[ERR] {msg}";
        try { File.AppendAllText(_sessionFile, l + "\r\n"); } catch { }
        Debug?.Broadcast(l);
        OnLog?.Invoke(l);
    }

    public void WriteCall(string request, string response)
    {
        try
        {
            _callN++;
            string p = Path.Combine(SessionDir, $"CALL-{_callN:D3}.txt");
            File.WriteAllText(p, $"=== REQUEST ===\r\n{request}\r\n\r\n=== RESPONSE ===\r\n{response}\r\n");
        }
        catch { }
    }
}
