using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace RanParty.Core;

public class ModelProfile
{
    public string Name = "";
    public string BaseUrl = "https://api.deepseek.com";
    public string ApiKey = "";
    public string Model = "deepseek-chat";
    public string CharacterCard = "";
    public string Provider = "openai";
    public string WireProtocol = "chat_completions";
    public bool SupportsTools = true;
    public bool SupportsImages = true;
    public bool SupportsReasoning = true;
    public int ContextWindow = 200000;
    public int MaxOutputTokens = 8192;
}

public class Config
{
    public string ApiKey = "";
    public string BaseUrl = "https://api.deepseek.com";
    public string Model = "deepseek-chat";
    public List<ModelProfile> Profiles = new();
    public string ActiveProfileName = "";
    public string IoRoots = "";
    public string FontSize = "medium";
    public int CmdSuffixEnable = 0;
    public string UserSuffix = "";
    public int QqbotEnable = 0;
    public string QqAppid = "";
    public string QqSecret = "";
    public int QqSandbox = 1;
    public int ShellEnable = 1;
    public string ShellMode = "ask";
    public int WinX = 565, WinY = 20, WinW = 1000, WinH = 700;
    public int WinState = 0;
    public int SidebarWidth = 250;
    public int ContextWindow = 200000;
    public int CompactThreshold = 80;

    public string CfgPath;
    public List<string> Whitelist = new();
    public event Action Changed;

    static readonly char Sep = (char)0x24D0; // ⓐ
    const string FrameworkDir = "RanParty";

    public Config()
    {
        CfgPath = Path.GetFullPath("Config/config.cfg");
        Load();
        BuildWhitelist();
        Watch();
    }

    public ModelProfile ActiveProfile
    {
        get
        {
            foreach (var p in Profiles)
                if (p.Name == ActiveProfileName) return p;
            if (Profiles.Count > 0) return Profiles[0];
            var def = new ModelProfile { Name = "default", BaseUrl = BaseUrl, ApiKey = ApiKey, Model = Model };
            Profiles.Add(def);
            ActiveProfileName = "default";
            return def;
        }
    }

    public void SyncActive()
    {
        var p = ActiveProfile;
        ApiKey = p.ApiKey;
        BaseUrl = p.BaseUrl;
        Model = p.Model;
    }

    public void SwitchProfile(string name)
    {
        ActiveProfileName = name;
        SyncActive();
        BuildWhitelist();
    }

    public void SaveProfile(string name, string baseUrl, string apiKey, string model, string characterCard = "")
    {
        ModelProfile p = null;
        foreach (var x in Profiles) if (x.Name == name) { p = x; break; }
        if (p == null) { p = new ModelProfile { Name = name }; Profiles.Add(p); }
        p.BaseUrl = baseUrl; p.ApiKey = apiKey; p.Model = model; p.CharacterCard = characterCard ?? "";
        ActiveProfileName = name;
        SyncActive();
    }

    public void DeleteProfile(string name)
    {
        if (Profiles.Count <= 1) return;
        Profiles.RemoveAll(p => p.Name == name);
        if (ActiveProfileName == name) ActiveProfileName = Profiles[0].Name;
        SyncActive();
    }

    public void Load()
    {
        if (!File.Exists(CfgPath)) { EnsureDefaultProfile(); Save(); return; }
        Profiles.Clear();
        foreach (var line in File.ReadAllLines(CfgPath))
        {
            int idx = line.IndexOf(Sep);
            if (idx < 0) continue;
            string k = line.Substring(0, idx);
            string v = line.Substring(idx + 1);
            switch (k)
            {
                case "api_key": ApiKey = Unprotect(v); break;
                case "base_url": BaseUrl = string.IsNullOrEmpty(v) ? BaseUrl : v; break;
                case "model": Model = string.IsNullOrEmpty(v) ? Model : v; break;
                case "io_roots": IoRoots = v; break;
                case "font_size": FontSize = v; break;
                case "cmd_suffix_enable": if (int.TryParse(v, out var c)) CmdSuffixEnable = c; break;
                case "user_suffix": UserSuffix = v; break;
                case "qqbot_enable": if (int.TryParse(v, out var q)) QqbotEnable = q; break;
                case "qq_appid": QqAppid = v; break;
                case "qq_secret": QqSecret = Unprotect(v); break;
                case "qq_sandbox": if (int.TryParse(v, out var s)) QqSandbox = s; break;
                case "shell_enable": if (int.TryParse(v, out var se)) ShellEnable = se; break;
                case "shell_mode": ShellMode = string.IsNullOrEmpty(v) ? ShellMode : v; break;
                case "win_x": if (int.TryParse(v, out var wx)) WinX = wx; break;
                case "win_y": if (int.TryParse(v, out var wy)) WinY = wy; break;
                case "win_w": if (int.TryParse(v, out var ww)) WinW = ww; break;
                case "win_h": if (int.TryParse(v, out var wh)) WinH = wh; break;
                case "win_state": if (int.TryParse(v, out var ws)) WinState = ws; break;
                case "sidebar_width": if (int.TryParse(v, out var sw)) SidebarWidth = sw; break;
                case "context_window": if (int.TryParse(v, out var cw)) ContextWindow = cw; break;
                case "compact_threshold": if (int.TryParse(v, out var ct) && ct > 0 && ct <= 100) CompactThreshold = ct; break;
                case "active_profile": ActiveProfileName = v; break;
                case "profile":
                    {
                        var parts = v.Split('|');
                        if (parts.Length >= 4)
                            Profiles.Add(new ModelProfile
                            {
                                Name = parts[0], BaseUrl = parts[1], ApiKey = Unprotect(parts[2]), Model = parts[3], CharacterCard = parts.Length > 4 ? parts[4] : "",
                                Provider = parts.Length > 5 && parts[5] == "anthropic" ? "anthropic" : "openai",
                                WireProtocol = parts.Length > 6 && parts[6] is "responses" or "anthropic_messages" ? parts[6] : "chat_completions",
                                SupportsTools = parts.Length <= 7 || ParseBool(parts[7], true),
                                SupportsImages = parts.Length <= 8 || ParseBool(parts[8], true),
                                SupportsReasoning = parts.Length <= 9 || ParseBool(parts[9], true),
                                ContextWindow = parts.Length > 10 && int.TryParse(parts[10], out var pcw) && (pcw == 0 || pcw >= 1000) ? pcw : 200000,
                                MaxOutputTokens = parts.Length > 11 && int.TryParse(parts[11], out var pmo) && pmo >= 0 ? pmo : 8192
                            });
                        break;
                    }
            }
        }
        EnsureDefaultProfile();
        SyncActive();
    }

    void EnsureDefaultProfile()
    {
        if (Profiles.Count == 0)
        {
            Profiles.Add(new ModelProfile { Name = "deepseek", BaseUrl = BaseUrl, ApiKey = ApiKey, Model = Model });
            ActiveProfileName = "deepseek";
        }
        if (string.IsNullOrEmpty(ActiveProfileName)) ActiveProfileName = Profiles[0].Name;
    }

    private static byte[] EntropyBytes = new byte[] { 0x52, 0x61, 0x6E, 0x50, 0x61, 0x72, 0x74, 0x79 }; // "RanParty" entropy
    private static string Protect(string plain) => string.IsNullOrWhiteSpace(plain) ? "" : Convert.ToBase64String(ProtectedData.Protect(System.Text.Encoding.UTF8.GetBytes(plain), EntropyBytes, DataProtectionScope.CurrentUser));
    private static string Unprotect(string encoded) {
        if (string.IsNullOrWhiteSpace(encoded)) return "";
        try { return System.Text.Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(encoded), EntropyBytes, DataProtectionScope.CurrentUser)); }
        catch { return encoded; } // 兼容旧版明文密钥
    }

    public void Save()
    {
        if (_watcher != null) _watcher.EnableRaisingEvents = false;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(CfgPath)!);
            var sb = new System.Text.StringBuilder();
            void L(string k, string v) => sb.Append(k).Append(Sep).Append(v).Append("\r\n");
            L("api_key", Protect(ApiKey));
            L("base_url", BaseUrl);
            L("model", Model);
            L("active_profile", ActiveProfileName);
            foreach (var p in Profiles)
                L("profile", $"{p.Name}|{p.BaseUrl}|{Protect(p.ApiKey)}|{p.Model}|{p.CharacterCard}|{p.Provider}|{p.WireProtocol}|{p.SupportsTools}|{p.SupportsImages}|{p.SupportsReasoning}|{p.ContextWindow}|{p.MaxOutputTokens}");
            L("io_roots", IoRoots);
            L("font_size", FontSize);
            L("cmd_suffix_enable", CmdSuffixEnable.ToString());
            L("user_suffix", UserSuffix);
            L("qqbot_enable", QqbotEnable.ToString());
            L("qq_appid", QqAppid);
            L("qq_secret", Protect(QqSecret));
            L("qq_sandbox", QqSandbox.ToString());
            L("shell_enable", ShellEnable.ToString());
            L("shell_mode", ShellMode);
            L("win_x", WinX.ToString());
            L("win_y", WinY.ToString());
            L("win_w", WinW.ToString());
            L("win_h", WinH.ToString());
            L("win_state", WinState.ToString());
            L("sidebar_width", SidebarWidth.ToString());
            L("context_window", ContextWindow.ToString());
            L("compact_threshold", CompactThreshold.ToString());
            File.WriteAllText(CfgPath, sb.ToString(), new System.Text.UTF8Encoding(true));
        }
        finally
        {
            new System.Threading.Timer(_ =>
            {
                try { if (_watcher != null) _watcher.EnableRaisingEvents = true; }
                catch { /* Concurrent saves can race while re-enabling FileSystemWatcher. */ }
            }, null, 300, System.Threading.Timeout.Infinite);
        }
    }

    static bool ParseBool(string value, bool fallback) => bool.TryParse(value, out var parsed) ? parsed : fallback;

    public void BuildWhitelist()
    {
        Whitelist.Clear();
        Whitelist.Add(Path.GetFullPath("CatTemp"));
        Whitelist.Add(Path.GetFullPath(FrameworkDir));
        Whitelist.Add(Path.GetFullPath("QQBot"));
        if (!string.IsNullOrWhiteSpace(IoRoots))
            foreach (var r in IoRoots.Split('|', StringSplitOptions.RemoveEmptyEntries))
                Whitelist.Add(Path.GetFullPath(r.Trim().TrimEnd('/', '\\')));
    }

    public bool InWhitelist(string path)
    {
        try
        {
            string full = Path.GetFullPath(path);

            // 检测并拒绝含 junction/symlink 的路径，防止白名单绕过
            string? root = Path.GetPathRoot(full);
            if (!string.IsNullOrEmpty(root))
            {
                var remaining = full[root.Length..].TrimStart(Path.DirectorySeparatorChar);
                var parts = remaining.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
                var current = root.TrimEnd(Path.DirectorySeparatorChar);
                foreach (var part in parts)
                {
                    current = Path.Combine(current, part);
                    if (Directory.Exists(current) || File.Exists(current))
                    {
                        var attrs = File.GetAttributes(current);
                        if ((attrs & FileAttributes.ReparsePoint) != 0)
                            return false; // 拒绝 junction/symlink 路径
                    }
                }
            }

            foreach (var w in Whitelist)
                if (full.Equals(w, StringComparison.OrdinalIgnoreCase) ||
                    full.StartsWith(w + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    return true;
        }
        catch { }
        return false;
    }

    FileSystemWatcher _watcher;
    void Watch()
    {
        try
        {
            _watcher = new FileSystemWatcher(Path.GetDirectoryName(CfgPath)!, Path.GetFileName(CfgPath));
            _watcher.Changed += (s, e) =>
            {
                System.Threading.Thread.Sleep(150);
                try { Load(); BuildWhitelist(); } catch { }
                Changed?.Invoke();
            };
            _watcher.EnableRaisingEvents = true;
        }
        catch { }
    }
}
