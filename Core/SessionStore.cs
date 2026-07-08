using System;
using System.Collections.Generic;
using System.IO;
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
    public int TokensIn;
    public int TokensOut;
    public int ContextTokens;
    public int ContextThreshold;
    public int ContextWindow;
    public DateTime LastActive;
}

public class SessionStore
{
    string _dir;
    string _legacyPath;

    public SessionStore()
    {
        _dir = Path.GetFullPath("Config/Sessions");
        _legacyPath = Path.GetFullPath("Config/session_active.txt"); // 兼容旧名 SuperCat_active.txt
    }

    public void EnsureDir() { try { Directory.CreateDirectory(_dir); } catch { } }

    public List<(string id, List<JsonNode> msgs, SessionMeta meta, DateTime lastWrite)> LoadAll()
    {
        EnsureDir();
        // 迁移旧的单会话文件
        var legacyPaths = new[] { _legacyPath, Path.GetFullPath("Config/SuperCat_active.txt") };
        foreach (var lp in legacyPaths)
        {
            if (!File.Exists(lp)) continue;
            try
            {
                var msgs = new List<JsonNode>();
                foreach (var line in File.ReadAllLines(lp))
                    if (!string.IsNullOrWhiteSpace(line) && !line.StartsWith("@"))
                        try { msgs.Add(JsonNode.Parse(line)); } catch { }
                if (msgs.Count > 0)
                {
                    string id = "s_" + DateTime.Now.ToString("yyyyMMddHHmmss");
                    Save(id, msgs, new SessionMeta());
                }
                File.Delete(lp);
            }
            catch { }
        }
        var result = new List<(string, List<JsonNode>, SessionMeta, DateTime)>();
        foreach (var f in Directory.GetFiles(_dir, "*.txt"))
        {
            string id = Path.GetFileNameWithoutExtension(f);
            DateTime lastWrite = File.GetLastWriteTime(f);
            var meta = new SessionMeta();
            var msgs = new List<JsonNode>();
            foreach (var line in File.ReadAllLines(f))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                if (line.StartsWith("@workspace=")) { meta.Workspace = line.Substring("@workspace=".Length); continue; }
                if (line.StartsWith("@model=")) { meta.Model = line.Substring("@model=".Length); continue; }
                if (line.StartsWith("@profile=")) { meta.ProfileName = line.Substring("@profile=".Length); continue; }
                if (line.StartsWith("@title=")) { meta.Title = line.Substring("@title=".Length); continue; }
                if (line.StartsWith("@approval=")) { meta.ApprovalMode = line.Substring("@approval=".Length); continue; }
                if (line.StartsWith("@mode=")) { meta.Mode = line.Substring("@mode=".Length); continue; }
                if (line.StartsWith("@goal_text=")) { meta.GoalText = line.Substring("@goal_text=".Length); continue; }
                if (line.StartsWith("@goal_status=")) { meta.GoalStatus = line.Substring("@goal_status=".Length); continue; }
                if (line.StartsWith("@last_active=")) { DateTime.TryParse(line.Substring("@last_active=".Length), null, System.Globalization.DateTimeStyles.RoundtripKind, out meta.LastActive); continue; }
                if (line.StartsWith("@ctx_threshold=")) { int.TryParse(line.Substring("@ctx_threshold=".Length), out meta.ContextThreshold); continue; }
                if (line.StartsWith("@ctx_window=")) { int.TryParse(line.Substring("@ctx_window=".Length), out meta.ContextWindow); continue; }
                if (line.StartsWith("@tokens="))
                {
                    var tp = line.Substring("@tokens=".Length).Split(',');
                    if (tp.Length >= 2) { int.TryParse(tp[0], out meta.TokensIn); int.TryParse(tp[1], out meta.TokensOut); }
                    continue;
                }
                if (line.StartsWith("@context_tokens=")) { int.TryParse(line.Substring("@context_tokens=".Length), out meta.ContextTokens); continue; }
                try { msgs.Add(JsonNode.Parse(line)); } catch { }
            }
            result.Add((id, msgs, meta, meta.LastActive == default ? lastWrite : meta.LastActive));
        }
        // 按最后活动时间倒序（最新活动在前）
        result.Sort((a, b) => b.Item4.CompareTo(a.Item4));
        return result;
    }

    public void Save(string id, List<JsonNode> messages, SessionMeta meta)
    {
        try
        {
            EnsureDir();
            var sb = new System.Text.StringBuilder();
            if (meta != null)
            {
                sb.Append("@workspace=").Append(meta.Workspace ?? "").Append("\n");
                sb.Append("@model=").Append(meta.Model ?? "").Append("\n");
                sb.Append("@profile=").Append(meta.ProfileName ?? "").Append("\n");
                sb.Append("@title=").Append(meta.Title ?? "").Append("\n");
                sb.Append("@approval=").Append(meta.ApprovalMode ?? "").Append("\n");
                sb.Append("@mode=").Append(string.IsNullOrWhiteSpace(meta.Mode) ? "default" : meta.Mode).Append("\n");
                sb.Append("@goal_text=").Append((meta.GoalText ?? "").Replace("\r", " ").Replace("\n", " ")).Append("\n");
                sb.Append("@goal_status=").Append(string.IsNullOrWhiteSpace(meta.GoalStatus) ? "active" : meta.GoalStatus).Append("\n");
                sb.Append("@last_active=").Append(meta.LastActive.ToString("O")).Append("\n");
                sb.Append("@ctx_threshold=").Append(meta.ContextThreshold).Append("\n");
                sb.Append("@ctx_window=").Append(meta.ContextWindow).Append("\n");
                sb.Append("@tokens=").Append(meta.TokensIn).Append(",").Append(meta.TokensOut).Append("\n");
                sb.Append("@context_tokens=").Append(meta.ContextTokens).Append("\n");
            }
            foreach (var m in messages)
                sb.Append(m.ToJsonString()).Append("\n");

            string path = Path.Combine(_dir, id + ".txt");
            string tmpPath = path + ".tmp";
            File.WriteAllText(tmpPath, sb.ToString());
            // 原子覆盖：Move 在 Windows NTFS 上是原子的，目标存在时覆盖
            File.Move(tmpPath, path, true);
        }
        catch { }
    }

    public void Delete(string id)
    {
        try { File.Delete(Path.Combine(_dir, id + ".txt")); } catch { }
    }
}
