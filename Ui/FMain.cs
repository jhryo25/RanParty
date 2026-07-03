using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

using RanParty.Core;
using RanParty.Cats;
using RanParty.Debug;
using RanParty.Tools;
namespace RanParty.Ui;

public class FMain : Form
{
    Config _cfg;
    Logger _log;
    CatRegistry _reg;
    SessionStore _session;
    QQBot _qq;
    DebugServer _dbg;
    bool _debug;
    Dictionary<string, List<(bool isPrefix, string pat)>> _shellAllow = new();
    System.Windows.Forms.Timer _hoverTimer;
    List<(Control grp, Button addBtn)> _groupHeaders = new();
    ToolTip _tip = new ToolTip { InitialDelay = 150, ReshowDelay = 100, AutoPopDelay = 8000 };
    SplitContainer _chatSplit;

    // 多会话（最新在前）
    List<ChatSession> _sessions = new();
    ChatSession _current;
    Panel _sessionList;
    Panel _sessionHost;

    // 配置 Tab
    ListBox _profileListBox;
    TextBox _pName, _pBase, _pKey, _pModel, _cRoots, _cSuffix, _cShellMode, _cContextWindow, _cCompactThreshold;
    ComboBox _pCard;

    // 角色卡 Tab
    ListView _cardList;
    Button _cardApply, _cardNew, _cardRename, _cardDelete, _cardSave, _cardClear, _cardRecover, _cardModeToggle, _cardPreviewBtn;
    Label _cardNote;
    System.Windows.Forms.Timer _previewTimer;
    static readonly string _charDir = Path.Combine("RanParty", "Characters");
    static readonly string _soulPath = Path.Combine("RanParty", "SOUL.md");

    // 结构化编辑器
    Panel _cardStructPanel;
    FlowLayoutPanel _sectionsFlow;
    TextBox _cardTitle, _cardDesc, _cardRawEdit;
    CardDoc _cardDoc;
    bool _cardRawMode = false;
    bool _cardSynth = false;

    public FMain(bool debug)
    {
        _debug = debug;
        _cfg = new Config();
        _log = new Logger();
        _dbg = new DebugServer("RanParty-Debug-" + Process.GetCurrentProcess().Id);
        _log.Debug = _dbg;
        _reg = new CatRegistry();
        _reg.Register(new IOCat(_cfg, _reg));
        _reg.Register(new MdCat(_cfg));
        if (_cfg.ShellEnable == 1) _reg.Register(new ShellCat(_cfg));
        _session = new SessionStore();
        _cfg.Changed += () => this.BeginInvoke(new Action(() => { RefreshSessionApis(); LoadConfigToUi(); }));

        Text = "RanParty";
        MinimumSize = new Size(960, 620);
        MaximumSize = new Size(2400, 1800);
        StartPosition = FormStartPosition.Manual;
        Load += (s, e) => RestoreWindowBounds();

        BuildUi();
        LoadConfigToUi();
        PopulateCards();
        RestoreSessions();

        _log.Log($"ApiTool_IO 白名单: {string.Join(" | ", _cfg.Whitelist)}");
        _log.Log($"CatRegistry 注册: SuperCat / IOCat / MdCat{(_cfg.ShellEnable == 1 ? " / ShellCat" : "")}{(_cfg.QqbotEnable == 1 ? " / QQBot" : "")}");
        _log.Log("S_Boot Init 完成，跳转 S_Idle");

        if (_debug) LaunchDebugChild();
        if (_cfg.QqbotEnable == 1) StartQQ();

        FormClosing += (s, e) =>
        {
            try { if (_current != null) _session.Save(_current.Id, _current.Messages, MetaOf(_current)); } catch { }
            try { _cfg.SidebarWidth = _chatSplit.SplitterDistance; } catch { }
            if (WindowState == FormWindowState.Maximized)
            {
                _cfg.WinState = 2;
                _cfg.WinX = RestoreBounds.X; _cfg.WinY = RestoreBounds.Y;
                _cfg.WinW = RestoreBounds.Width; _cfg.WinH = RestoreBounds.Height;
            }
            else
            {
                _cfg.WinState = 0;
                _cfg.WinX = Location.X; _cfg.WinY = Location.Y;
                _cfg.WinW = Width; _cfg.WinH = Height;
            }
            _cfg.Save();
        };
        Shown += (s, e) =>
        {
            RebuildSidebar();
            SyncSidebarWidths();
            if (_current != null) _current.ScrollToBottom();
        };
    }

    void RestoreWindowBounds()
    {
        int w = Math.Max(_cfg.WinW, MinimumSize.Width);
        int h = Math.Max(_cfg.WinH, MinimumSize.Height);
        var bounds = new Rectangle(_cfg.WinX, _cfg.WinY, w, h);
        try
        {
            var sc = Screen.FromPoint(new Point(_cfg.WinX, _cfg.WinY));
            var wa = sc.WorkingArea;
            if (bounds.Width > wa.Width) bounds.Width = wa.Width;
            if (bounds.Height > wa.Height) bounds.Height = wa.Height;
            if (bounds.X < wa.X) bounds.X = wa.X;
            if (bounds.Y < wa.Y) bounds.Y = wa.Y;
            if (bounds.Right > wa.Right) bounds.X = Math.Max(wa.X, wa.Right - bounds.Width);
            if (bounds.Bottom > wa.Bottom) bounds.Y = Math.Max(wa.Y, wa.Bottom - bounds.Height);
        }
        catch { }
        Bounds = bounds;
        if (_cfg.WinState == 2) WindowState = FormWindowState.Maximized;
        try
        {
            int sw = Math.Max(_cfg.SidebarWidth, _chatSplit.Panel1MinSize);
            int maxSw = Math.Max(_chatSplit.Panel1MinSize, _chatSplit.Width - 120);
            if (sw > maxSw) sw = maxSw;
            _chatSplit.SplitterDistance = sw;
        }
        catch { }
    }

    void LaunchDebugChild()
    {
        try
        {
            Process.Start(new ProcessStartInfo(Application.ExecutablePath,
                "--debug-child " + Process.GetCurrentProcess().Id) { UseShellExecute = false });
            _log.Log("已启动 FDebug 子进程");
        }
        catch (Exception ex) { _log.Err("启动 FDebug 失败: " + ex.Message); }
    }

    void StartQQ()
    {
        _qq = new QQBot(_cfg, _log);
        _qq.OnGroupMessage = (gid, content, mid) => this.BeginInvoke(new Action(async () =>
        {
            string reply = await ProcessExternal(content);
            try { await _qq.SendGroup(gid, reply, mid); } catch (Exception ex) { _log.Err("QQ 回复失败: " + ex.Message); }
        }));
        _qq.OnC2CMessage = (uid, content, mid) => this.BeginInvoke(new Action(async () =>
        {
            string reply = await ProcessExternal(content);
            try { await _qq.SendC2C(uid, reply, mid); } catch (Exception ex) { _log.Err("QQ 回复失败: " + ex.Message); }
        }));
        _ = _qq.Start();
    }

    // ---- 会话管理（侧边栏） ----
    void RestoreSessions()
    {
        var loaded = _session.LoadAll();  // 已按最后活动倒序
        if (loaded.Count == 0) { CreateSession(); return; }
        ChatSession latest = null;
        DateTime latestTime = DateTime.MinValue;
        foreach (var (id, msgs, meta, lastWrite) in loaded)
        {
            var s = new ChatSession(id)
            {
                Messages = msgs,
                L0Loaded = msgs.Count > 0 && msgs[0]["role"]?.GetValue<string>() == "system",
                TitleGenerated = msgs.Count > 0,
                LastActive = lastWrite
            };
            AddSession(s, meta);
            s.TokensIn = meta.TokensIn;
            s.TokensOut = meta.TokensOut;
            if (!string.IsNullOrEmpty(meta.Title)) s.SetTitle(meta.Title);
            else { s.TitleGenerated = false; s.FallbackTitle(); s.TitleGenerated = msgs.Count > 0; }
            if (!string.IsNullOrEmpty(meta.ApprovalMode)) s.ApprovalMode = meta.ApprovalMode;
            s.SyncApproval(s.ApprovalMode);
            s.UpdateMeta();
            foreach (var (cname, cpath) in DeriveFileCards(msgs))
                s.AppendFileCard(cname, cpath);
            s.RenderHistory();
            if (msgs.Count > 0)
                s.AppendSys($"[系统] 恢复 {msgs.Count} 条历史");
            if (lastWrite > latestTime) { latestTime = lastWrite; latest = s; }
        }
        RebuildSidebar();
        ActivateSession(latest ?? _sessions[0]);
    }

    string NewSessionId() => "s_" + DateTime.Now.ToString("yyyyMMddHHmmss");

    static SessionMeta MetaOf(ChatSession s) => new()
    {
        Workspace = s.Workspace ?? "",
        Model = s.Model ?? "",
        ProfileName = s.ProfileName ?? "",
        Title = s.Title ?? "",
        ApprovalMode = s.ApprovalMode ?? "",
        TokensIn = s.TokensIn,
        TokensOut = s.TokensOut,
        ContextThreshold = s.ContextThreshold,
        ContextWindow = s.ContextWindow
    };

    int EffectiveContextWindow(ChatSession s) => s.ContextWindow > 1000 ? s.ContextWindow : _cfg.ContextWindow;

    void AddSession(ChatSession s, SessionMeta meta = null)
    {
        s.BuildUi(async () => await Send(s), () => s.Cts?.Cancel());
        s.OnCompactRequest = sess => { if (!sess.Busy) _ = CompactSession(sess); };
        s.OnContextDetailsRequest = ShowContextDetails;
        if (meta != null)
        {
            s.Workspace = string.IsNullOrEmpty(meta.Workspace) ? Environment.CurrentDirectory : meta.Workspace;
            s.ProfileName = string.IsNullOrEmpty(meta.ProfileName) ? _cfg.ActiveProfile.Name : meta.ProfileName;
            s.Model = string.IsNullOrEmpty(meta.Model) ? _cfg.ActiveProfile.Model : meta.Model;
            s.ApprovalMode = string.IsNullOrEmpty(meta.ApprovalMode) ? _cfg.ShellMode : meta.ApprovalMode;
            if (meta.ContextThreshold > 0 && meta.ContextThreshold <= 100) s.ContextThreshold = meta.ContextThreshold;
            if (meta.ContextWindow > 1000) s.ContextWindow = meta.ContextWindow;
        }
        else
        {
            var active = _cfg.ActiveProfile;
            s.Api = new ApiClient(active.ApiKey, active.BaseUrl);
            s.ProfileName = active.Name;
            s.Model = active.Model;
            s.Workspace = Environment.CurrentDirectory;
            s.ApprovalMode = _cfg.ShellMode;
        }
        // 重建 ApiClient（按 profile）+ 设置角色名
        var prof = _cfg.Profiles.Find(x => x.Name == s.ProfileName) ?? _cfg.ActiveProfile;
        if (meta != null) s.Api = new ApiClient(prof.ApiKey, prof.BaseUrl);
        s.DisplayName = ResolveDisplayName(prof);
        if (!string.IsNullOrEmpty(s.Workspace) && !_cfg.Whitelist.Contains(s.Workspace)) _cfg.Whitelist.Add(s.Workspace);
        s._log_model_switch = (op, om, np, nm) => _log.Log($"会话模型切换: {op}/{om} → {np}/{nm}");
        s._resolveName = (profileName) =>
        {
            var p = _cfg.Profiles.Find(x => x.Name == profileName) ?? _cfg.ActiveProfile;
            return ResolveDisplayName(p);
        };
        s.OnOpenPath = path => OpenFileFromCard(path);
        s.PopulateModels(BuildModelOptions(), s.ProfileName);
        s.SyncApproval(s.ApprovalMode);
        s.WsBtn.Click += (sender, e) => PickWorkspace(s);
        s.Item = new SessionItem(s);
        s.Item.OnSelect = it => ActivateSession(it.Session);
        s.Item.OnDelete = it => DeleteSession(it.Session);
        s.UpdateMeta();
        s.UpdateContextBar(EffectiveContextWindow(s), -1, EstimateToolsTokens(), EstimateSkillTokens());
        _sessions.Add(s);
    }

    string ResolveDisplayName(ModelProfile prof)
    {
        if (prof == null) return "AI";
        try
        {
            string p = CardFilePath(prof.CharacterCard);
            if (File.Exists(p)) return ResolveDisplayNameFromPath(p);
        }
        catch { }
        return "AI";
    }

    string ResolveDisplayNameFromPath(string path)
    {
        try
        {
            if (!File.Exists(path)) return "AI";
            var doc = CardDoc.Parse(File.ReadAllText(path));
            if (!string.IsNullOrWhiteSpace(doc.Title)) return CleanCardName(doc.Title);
        }
        catch { }
        return "AI";
    }

    static string CleanCardName(string title)
    {
        var t = (title ?? "").Trim();
        // 去掉常见前缀 "角色卡 · " / "角色卡·" / "角色卡 "
        string[] prefixes = { "角色卡 · ", "角色卡·", "角色卡 ", "角色卡" };
        foreach (var pre in prefixes)
            if (t.StartsWith(pre)) { t = t.Substring(pre.Length).Trim(); break; }
        return string.IsNullOrWhiteSpace(t) ? "AI" : t.Trim('·', ' ', '·');
    }

    static string FitNameToWidth(string name, int maxPx, Font font)
    {
        if (string.IsNullOrEmpty(name)) return name ?? "";
        if (TextRenderer.MeasureText(name, font).Width <= maxPx) return name;
        for (int n = name.Length - 1; n > 0; n--)
        {
            string t = name.Substring(0, n) + "…";
            if (TextRenderer.MeasureText(t, font).Width <= maxPx) return t;
        }
        return "…";
    }

    void RebuildSidebar()
    {
        _sessionList.Controls.Clear();
        _groupHeaders.Clear();
        var groups = _sessions.GroupBy(s => s.Workspace ?? "").ToList();
        var orderedAsc = groups.OrderByDescending(g => g.Max(s => s.LastActive)).Reverse().ToList();
        foreach (var g in orderedAsc)
        {
            string ws = g.Key;
            string wsName = string.IsNullOrEmpty(ws) ? "(默认工作区)" : System.IO.Path.GetFileName(ws.TrimEnd('\\', '/'));
            if (string.IsNullOrEmpty(wsName)) wsName = ws;
            var items = g.OrderBy(x => x.LastActive).ToList();
            int itemsH = items.Count * 52;
            var grp = new TableLayoutPanel { Dock = DockStyle.Top, ColumnCount = 1, RowCount = 2, Height = 28 + itemsH, Margin = new Padding(0) };
            grp.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            grp.RowStyles.Add(new RowStyle(SizeType.Absolute, itemsH));
            var headerFont = new Font("Microsoft YaHei", 9f, FontStyle.Bold);
            var addBtn = new Button
            {
                Text = "＋ 新建", Dock = DockStyle.Right, Width = 70,
                FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(80, 130, 220), ForeColor = Color.White,
                Font = new Font("Microsoft YaHei", 8.5f), Cursor = Cursors.Hand, Visible = false, Margin = new Padding(0)
            };
            addBtn.FlatAppearance.BorderSize = 0;
            addBtn.Click += (sender, e) => CreateSessionInWorkspace(ws);
            int listW = _sessionList.Width > 0 ? _sessionList.Width : 250;
            int nameBudget = Math.Max(40, listW - 70 - 16 - 40 - 8);
            string fitName = FitNameToWidth(wsName, nameBudget, headerFont);
            var headerRow = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(235, 238, 248), Padding = new Padding(0) };
            var header = new Button
            {
                Text = "▼ " + fitName + " (" + items.Count + ")", Dock = DockStyle.Fill,
                FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(235, 238, 248),
                TextAlign = ContentAlignment.MiddleLeft, Font = headerFont,
                Cursor = Cursors.Hand, Padding = new Padding(8, 0, 0, 0), Margin = new Padding(0)
            };
            header.FlatAppearance.BorderSize = 0;
            header.FlatAppearance.MouseOverBackColor = Color.FromArgb(220, 226, 245);
            string wsTip = string.IsNullOrEmpty(ws) ? "(默认工作区)" : ws + "  [" + wsName + "]";
            _tip.SetToolTip(header, wsTip);
            bool tipOn = false;
            header.MouseMove += (sender, e) => { if (!tipOn) { try { _tip.Show(wsTip, header, 0, header.Height, 30000); } catch { } tipOn = true; } };
            header.MouseLeave += (sender, e) => { try { _tip.Hide(header); } catch { } tipOn = false; };
            headerRow.Controls.Add(header);
            headerRow.Controls.Add(addBtn);
            _groupHeaders.Add((grp, addBtn));
            var sp = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(250, 250, 252) };
            foreach (var s in items) sp.Controls.Add(s.Item);
            bool collapsed = false;
            header.Click += (sender, e) =>
            {
                collapsed = !collapsed;
                sp.Visible = !collapsed;
                grp.RowStyles[1].Height = collapsed ? 0 : itemsH;
                grp.Height = collapsed ? 28 : (28 + itemsH);
                header.Text = (collapsed ? "▶ " : "▼ ") + fitName + " (" + items.Count + ")";
            };
            grp.Controls.Add(headerRow, 0, 0);
            grp.Controls.Add(sp, 0, 1);
            _sessionList.Controls.Add(grp);
        }
        if (_current != null && _current.Item != null) _current.Item.Selected = true;
    }

    void SyncSidebarWidths() { }

    ChatSession CreateSession()
    {
        var s = new ChatSession(NewSessionId());
        AddSession(s, null);
        RebuildSidebar();
        ActivateSession(s);
        return s;
    }

    ChatSession CreateSessionInWorkspace(string ws)
    {
        var s = new ChatSession(NewSessionId());
        AddSession(s, null);
        if (!string.IsNullOrEmpty(ws)) s.Workspace = ws;
        try { string full = Path.GetFullPath(s.Workspace); if (!_cfg.Whitelist.Contains(full)) _cfg.Whitelist.Add(full); } catch { }
        s.LastActive = DateTime.Now;
        s.UpdateMeta();
        RebuildSidebar();
        ActivateSession(s);
        s.Input.Focus();
        return s;
    }

    void ActivateSession(ChatSession s)
    {
        if (s == null) return;
        _current = s;
        // 重新解析 AI 显示名（角色卡名称变更后，旧会话也能反映最新名称）
        try { s.DisplayName = ResolveDisplayNameFromPath(SoulPathFor(s)); } catch { }
        _sessionHost.Controls.Clear();
        _sessionHost.Controls.Add(s.Container);
        // 非激活会话的 WebBrowser 首次可见时才加载文档，需补渲染历史
        if (!s.HistoryRendered) s.RenderHistory();
        foreach (var x in _sessions) x.Item.Selected = (x == s);
        s.ScrollToBottom();
        foreach (int ms in new[] { 60, 200, 450, 900 })
        {
            var t = new System.Windows.Forms.Timer { Interval = ms };
            object tag = s;
            t.Tick += (src, ev) => { t.Stop(); t.Dispose(); ((ChatSession)tag).ScrollToBottom(); };
            t.Start();
        }
    }

    void RefreshHover()
    {
        var mp = MousePosition;
        foreach (var s in _sessions)
        {
            var it = s.Item;
            if (it == null) continue;
            try
            {
                var rect = it.RectangleToScreen(it.ClientRectangle);
                bool over = rect.Contains(mp) && it.Visible;
                it.Hovered = over;
            }
            catch { }
        }
        foreach (var (grp, btn) in _groupHeaders)
        {
            try
            {
                var r = grp.RectangleToScreen(grp.ClientRectangle);
                var headerRect = new Rectangle(r.X, r.Y, r.Width, 28);
                btn.Visible = headerRect.Contains(mp);
            }
            catch { }
        }
    }

    void DeleteSession(ChatSession s)
    {
        if (_sessions.Count <= 1) { SysMsg("[系统] 至少保留一个会话\n", isErr: true); return; }
        if (MessageBox.Show(this, $"确认删除会话 [{s.Title}]？\n该会话历史将永久删除。", "删除会话",
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        _session.Delete(s.Id);
        _sessions.Remove(s);
        RebuildSidebar();
        if (_current == s) ActivateSession(_sessions[0]);
        _log.Log($"删除会话: {s.Id}");
    }

    void PickWorkspace(ChatSession s)
    {
        using var dlg = new FolderBrowserDialog { Description = "选择当前会话工作区（shell 默认目录 + 文件白名单）" };
        if (Directory.Exists(s.Workspace)) dlg.SelectedPath = s.Workspace;
        if (dlg.ShowDialog(this) == DialogResult.OK)
        {
            s.Workspace = dlg.SelectedPath;
            try { string full = Path.GetFullPath(s.Workspace); if (!_cfg.Whitelist.Contains(full)) _cfg.Whitelist.Add(full); } catch { }
            s.LastActive = DateTime.Now;
            s.UpdateMeta();
            RebuildSidebar();
            _log.Log($"工作区切换: {s.Workspace}");
        }
    }

    // ---- 对话 ----
    string SoulPathFor(ChatSession s)
    {
        var prof = _cfg.Profiles.Find(x => x.Name == s.ProfileName) ?? _cfg.ActiveProfile;
        if (!string.IsNullOrEmpty(prof.CharacterCard))
        {
            string cardPath = CardFilePath(prof.CharacterCard);
            if (File.Exists(cardPath)) return cardPath;
        }
        return _soulPath;
    }

    void EnsureL0(ChatSession s)
    {
        if (s.L0Loaded) return;
        var sb = new System.Text.StringBuilder();
        // 若 profile 绑定了角色卡，用卡内容替代 SOUL.md
        string soulPath = SoulPathFor(s);
        // 始终从人设卡解析 AI 显示名（Name 优先，回退 Title）
        s.DisplayName = ResolveDisplayNameFromPath(soulPath);
        foreach (var p in new[] { soulPath, Path.Combine("RanParty", "AGENTS.md"), Path.Combine("RanParty", "TOOL.md"), Path.Combine("RanParty", "HUB.md") })
        {
            if (File.Exists(p)) sb.Append(File.ReadAllText(p)).Append("\n\n");
            else _log.Err($"IO.Read 失败 [{p}] 文件不存在");
        }
        if (sb.Length > 0)
        {
            string ws = string.IsNullOrEmpty(s.Workspace) ? "(未设置)" : s.Workspace;
            sb.Append($"\n\n[当前会话工作区]: {ws}\n")
              .Append("生成的文件（html/txt/csv/json 等）请优先写入此工作区目录，使用绝对路径。\n")
              .Append("CatTemp/ 为系统临时目录，仅用于内部中间产物；用户可见产出请放工作区。\n")
              .Append($"需要打开/预览生成的文件时，调用 open_path 工具（path 传工作区内绝对路径），会用默认程序打开（.html → 默认浏览器）。\n");
            s.Messages.Add(new JsonObject { ["role"] = "system", ["content"] = sb.ToString() });
            _log.Log($"L0 注入 {sb.Length} 字符 (人设={Path.GetFileName(soulPath)}, 工作区={ws})");
        }
        s.L0Loaded = true;
        s.UpdateContextBar(EffectiveContextWindow(s), -1, EstimateToolsTokens(), EstimateSkillTokens());
    }

    async Task Send(ChatSession s)
    {
        if (s.Busy) return;
        string text = s.Input.Text.Trim();
        if (string.IsNullOrEmpty(text)) return;
        if (text == "/new")
        {
            s.Messages.Clear();
            s.L0Loaded = false;
            s.TitleGenerated = false;
            _session.Save(s.Id, s.Messages, MetaOf(s));
            s.ClearChat();
            s.SetTitle("新会话");
            s.AppendSys("[系统] 已清空当前会话");
            s.Input.Clear();
            return;
        }
        s.SetBusy(true);
        s.Cts = new CancellationTokenSource();
        var ct = s.Cts.Token;
        s.Input.Clear();
        EnsureL0(s);
        try { s.DisplayName = ResolveDisplayNameFromPath(SoulPathFor(s)); } catch { }
        s.AppendUser(text);
        s.ScrollToBottom();
        string userMsg = text + (string.IsNullOrEmpty(_cfg.UserSuffix) ? "" : "\n" + _cfg.UserSuffix);
        JsonNode content;
        if (!string.IsNullOrEmpty(s.PendingImage))
        {
            content = new JsonArray
            {
                new JsonObject { ["type"] = "text", ["text"] = userMsg },
                new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = s.PendingImage } }
            };
            s.ClearPendingImage();
            s.SetStatus("就绪");
        }
        else
        {
            content = userMsg;
        }
        s.Messages.Add(new JsonObject { ["role"] = "user", ["content"] = content });
        if (!s.TitleGenerated) s.FallbackTitle();
        _session.Save(s.Id, s.Messages, MetaOf(s));
        await MaybeCompact(s);
        try
        {
            await RoundTrip(s, ct);
            s.FlushFileCards();
            s.LastActive = DateTime.Now;
            _session.Save(s.Id, s.Messages, MetaOf(s));
            if (!s.TitleGenerated) _ = GenerateTitle(s);
            s.ScrollToBottom();
        }
        catch (OperationCanceledException)
        {
            s.FinishAssistant();
            string partial = s.GetAssistantText();
            if (!string.IsNullOrEmpty(partial))
                s.Messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = partial });
            s.AppendSys("[已停止]", isErr: false);
            _session.Save(s.Id, s.Messages, MetaOf(s));
            _log.Log("用户停止生成");
            s.ScrollToBottom();
        }
        catch (Exception ex) { s.FinishAssistant(); s.AppendSys("[错误] " + ex.Message, isErr: true); _log.Err("对话异常: " + ex.Message); s.ScrollToBottom(); }
        s.SetBusy(false);
        s.Cts = null;
        s.SetStatus("就绪");
    }

    async Task<string> ProcessExternal(string content)
    {
        var s = _current;
        if (s == null) return "[无可用会话]";
        if (s.Busy) return "[忙碌中，稍后再试]";
        s.SetBusy(true);
        EnsureL0(s);
        s.Messages.Add(new JsonObject { ["role"] = "user", ["content"] = content });
        if (!s.TitleGenerated) s.FallbackTitle();
        _session.Save(s.Id, s.Messages, MetaOf(s));
        string reply = "";
        try
        {
            reply = await RoundTrip(s, default);
            s.FlushFileCards();
            s.LastActive = DateTime.Now;
            _session.Save(s.Id, s.Messages, MetaOf(s));
            if (!s.TitleGenerated) _ = GenerateTitle(s);
        }
        catch (Exception ex) { s.FinishAssistant(); reply = "[错误] " + ex.Message; _log.Err("外部消息异常: " + ex.Message); }
        s.SetBusy(false);
        return reply;
    }

    async Task<string> RoundTrip(ChatSession s, CancellationToken ct)
    {
        s.SetStatus("思考中…");
        s.StartAssistant();
        string useModel = string.IsNullOrEmpty(s.Model) ? _cfg.Model : s.Model;
        var result = await s.Api.Chat(useModel, s.Messages, _reg.SchemasJson(), _log,
            delta => s.AppendAssistantDelta(delta),
            delta => s.AppendReasoningDelta(delta),
            ct);

        s.Model = useModel;
        if (result.UsageIn > 0 || result.UsageOut > 0)
        {
            s.TokensIn += result.UsageIn;
            s.TokensOut += result.UsageOut;
            s.LastInputTokens = result.UsageIn;
            s.UpdateMeta();
            s.UpdateContextBar(EffectiveContextWindow(s), result.UsageIn, EstimateToolsTokens(), EstimateSkillTokens());
        }

        var asst = new JsonObject { ["role"] = "assistant", ["content"] = result.Content ?? "" };
        if (result.ToolCalls != null && result.ToolCalls.Count > 0)
            asst["tool_calls"] = result.ToolCalls.DeepClone();
        s.Messages.Add(asst);

        if (string.IsNullOrEmpty(result.Content) && (result.ToolCalls == null || result.ToolCalls.Count == 0))
        {
            s.FinishAssistant();
            s.AppendSys("(空回复)");
            return "";
        }
        // 每条 AI 回复结尾显示本次 token
        if (result.UsageIn > 0 || result.UsageOut > 0)
            s.AppendUsage(result.UsageIn, result.UsageOut, useModel);
        s.FinishAssistant();

        if (result.ToolCalls != null && result.ToolCalls.Count > 0)
        {
            foreach (var tc in result.ToolCalls)
            {
                string name = tc["function"]?["name"]?.GetValue<string>() ?? "";
                string argsStr = tc["function"]?["arguments"]?.GetValue<string>() ?? "{}";
                s.SetStatus("工具: " + name);
                _log.Log($"工具调用: {name} {argsStr}");
                JsonNode argsNode = null;
                try { argsNode = JsonNode.Parse(argsStr); } catch { }
                var tr = await DispatchWithApproval(s, name, argsNode, result.Content ?? "");
                string preview = tr.Content ?? "";
                if (preview.Length > 200) preview = preview.Substring(0, 200) + "…";
                s.AppendTool(name, argsStr, preview, tr.IsError);
                // 写文件类工具成功后，展示可点击文件卡片
                if (!tr.IsError && IsWriteTool(name))
                {
                    string fpath = ExtractPath(name, argsNode);
                    if (!string.IsNullOrEmpty(fpath) && ShouldShowFileCard(fpath))
                    {
                        string fname = System.IO.Path.GetFileName(fpath);
                        s.AppendFileCard(string.IsNullOrEmpty(fname) ? fpath : fname, fpath);
                    }
                }
                s.Messages.Add(new JsonObject
                {
                    ["role"] = "tool",
                    ["tool_call_id"] = tc["id"]?.GetValue<string>() ?? "",
                    ["content"] = tr.Content ?? ""
                });
                _session.Save(s.Id, s.Messages, MetaOf(s));
            }
            return await RoundTrip(s, ct);
        }
        return result.Content ?? "";
    }

    static bool IsShellTool(string name) => name == "shell_run" || name == "ps_run" || name == "open_url" || name == "open_path";

    static bool IsWriteTool(string name) => name == "file_write" || name == "file_append" || name == "file_replace"
        || name == "file_write_excel" || name == "file_write_docx" || name == "file_move";

    static string ExtractPath(string tool, JsonNode args)
    {
        if (args == null) return "";
        if (tool == "file_move") return args["dst"]?.GetValue<string>() ?? "";
        return args["path"]?.GetValue<string>() ?? "";
    }

    bool ShouldShowFileCard(string fpath)
    {
        // 跳过 CatTemp 临时目录产物（内部中间文件，常被删除）和已不存在的文件
        if (!System.IO.File.Exists(fpath)) return false;
        try
        {
            string full = System.IO.Path.GetFullPath(fpath);
            string catTemp = System.IO.Path.GetFullPath("CatTemp");
            if (full.StartsWith(catTemp, StringComparison.OrdinalIgnoreCase)) return false;
        }
        catch { }
        return true;
    }

    List<(string name, string path)> DeriveFileCards(List<JsonNode> messages)
    {
        var cards = new List<(string, string)>();
        var seen = new HashSet<string>();
        foreach (var m in messages)
        {
            if (m["role"]?.GetValue<string>() != "assistant") continue;
            var tcs = m["tool_calls"] as JsonArray;
            if (tcs == null) continue;
            foreach (var tc in tcs)
            {
                string name = tc["function"]?["name"]?.GetValue<string>() ?? "";
                if (!IsWriteTool(name)) continue;
                string argsStr = tc["function"]?["arguments"]?.GetValue<string>() ?? "{}";
                JsonNode argsNode = null;
                try { argsNode = JsonNode.Parse(argsStr); } catch { }
                string fpath = ExtractPath(name, argsNode);
                if (string.IsNullOrEmpty(fpath) || !ShouldShowFileCard(fpath)) continue;
                if (!seen.Add(fpath)) continue;
                string fname = System.IO.Path.GetFileName(fpath);
                cards.Add((string.IsNullOrEmpty(fname) ? fpath : fname, fpath));
            }
        }
        return cards;
    }

    void OpenFileFromCard(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        if (!_cfg.InWhitelist(path)) { _current?.AppendSys($"[系统] 拒绝打开：路径不在白名单内 {path}", isErr: true); return; }
        if (!System.IO.File.Exists(path) && !System.IO.Directory.Exists(path)) { _current?.AppendSys($"[系统] 文件不存在：{path}", isErr: true); return; }
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path) { UseShellExecute = true }); _log.Log($"卡片打开文件: {path}"); }
        catch (Exception ex) { _current?.AppendSys($"[系统] 打开失败: {ex.Message}", isErr: true); }
    }

    bool ShellAllowed(string sid, string command)
    {
        if (!_shellAllow.TryGetValue(sid, out var list)) return false;
        string c = (command ?? "").Trim();
        foreach (var (isPrefix, pat) in list)
        {
            if (isPrefix) { if (c.StartsWith(pat)) return true; }
            else { if (c == pat) return true; }
        }
        return false;
    }

    async Task<ToolResult> DispatchWithApproval(ChatSession s, string name, JsonNode args, string reason)
    {
        if (!IsShellTool(name)) return await Task.Run(() => _reg.Dispatch(name, args));
        // open_url / open_path 低风险，直接执行（open_path 内部已校验白名单）
        if (name == "open_url" || name == "open_path") return await Task.Run(() => _reg.Dispatch(name, args));
        string mode = string.IsNullOrEmpty(s.ApprovalMode) ? _cfg.ShellMode : s.ApprovalMode;
        if (mode == "auto") return await Task.Run(() => _reg.Dispatch(name, args));
        // 默认工作区注入
        if (!string.IsNullOrEmpty(s.Workspace))
        {
            string wd = args?["workdir"]?.GetValue<string>() ?? "";
            if (string.IsNullOrWhiteSpace(wd)) args["workdir"] = s.Workspace;
        }
        string command = args?["command"]?.GetValue<string>() ?? "";
        if (ShellAllowed(s.Id, command)) return await Task.Run(() => _reg.Dispatch(name, args));

        using var dlg = new FApprove(name, args, reason);
        if (dlg.ShowDialog(this) == DialogResult.OK)
        {
            // 写回可能被编辑的命令
            if (!string.IsNullOrEmpty(dlg.EditedCommand) && dlg.EditedCommand != command)
            {
                args["command"] = dlg.EditedCommand;
                command = dlg.EditedCommand;
            }
            if (dlg.Action == ApproveAction.AllowExact)
            {
                if (!_shellAllow.ContainsKey(s.Id)) _shellAllow[s.Id] = new List<(bool, string)>();
                _shellAllow[s.Id].Add((false, command.Trim()));
                _log.Log($"本会话放行命令: {command.Trim()}");
            }
            else if (dlg.Action == ApproveAction.AllowPrefix)
            {
                string p = FApprove.PrefixOf(command);
                if (!_shellAllow.ContainsKey(s.Id)) _shellAllow[s.Id] = new List<(bool, string)>();
                _shellAllow[s.Id].Add((true, p));
                _log.Log($"本会话放行前缀: {p}");
            }
            return await Task.Run(() => _reg.Dispatch(name, args));
        }
        // 拒绝
        if (dlg.Action == ApproveAction.DeclineFeedback && !string.IsNullOrWhiteSpace(dlg.Feedback))
        {
            _log.Log($"用户拒绝并反馈: {dlg.Feedback}");
            return new ToolResult { Content = $"[用户拒绝执行，反馈: {dlg.Feedback}]" };
        }
        _log.Log($"用户拒绝 shell 命令: {name}");
        return new ToolResult { Content = "[用户拒绝执行该命令]" };
    }

    const string COMPACT_PROMPT = @"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.";

    const string SUMMARY_PREFIX = @"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

    int EstimateToolsTokens() => (_reg?.SchemasJson()?.Length ?? 0) / 4;
    int EstimateSkillTokens()
    {
        if (_reg?.Cats == null) return 0;
        int n = 0;
        foreach (var cat in _reg.Cats)
            foreach (var kv in cat.Schemas)
                n += (kv.Value.desc?.Length ?? 0) + (kv.Value.parms?.Length ?? 0);
        return n / 4;
    }

    async Task MaybeCompact(ChatSession s)
    {
        int window = EffectiveContextWindow(s);
        if (window <= 0) return;
        int threshold = s.ContextThreshold > 0 ? s.ContextThreshold : _cfg.CompactThreshold;
        if (threshold <= 0 || threshold > 100) threshold = 80;
        int limit = (int)(window * (long)threshold / 100);
        if (s.LastInputTokens < limit) return;
        try { await CompactSession(s); }
        catch (Exception ex) { _log.Err("compact 失败: " + ex.Message); s.AppendSys("[系统] 上下文压缩失败: " + ex.Message, isErr: true); }
    }

    async Task CompactSession(ChatSession s)
    {
        s.SetStatus("压缩上下文…");
        // 1. 序列化历史为文本（排除 L0 system）
        var sb = new System.Text.StringBuilder();
        foreach (var m in s.Messages)
        {
            string role = m["role"]?.GetValue<string>() ?? "";
            if (role == "system") continue;
            string c = ChatSession.ExtractUserText(m["content"]);
            if (role == "user" && c.StartsWith(SUMMARY_PREFIX)) c = "[历史摘要]";
            if (!string.IsNullOrEmpty(c)) sb.Append("[").Append(role).Append("] ").Append(c).Append("\n\n");
        }
        // 2. 调模型生成 handoff 摘要
        var sumMessages = new List<JsonNode>
        {
            new JsonObject { ["role"] = "system", ["content"] = COMPACT_PROMPT },
            new JsonObject { ["role"] = "user", ["content"] = "请对以下对话生成 handoff 摘要：\n\n" + sb.ToString() }
        };
        string useModel = string.IsNullOrEmpty(s.Model) ? _cfg.Model : s.Model;
        var result = await s.Api.Chat(useModel, sumMessages, "", _log, null, null, default);
        string summary = (result.Content ?? "").Trim();
        if (string.IsNullOrWhiteSpace(summary)) { s.SetStatus("就绪"); return; }
        // 3. 收集保留的近期用户消息（从最新向前，≤约 20k token≈60000 字符，排除已有摘要）
        var kept = new List<JsonNode>();
        int budget = 60000;
        for (int i = s.Messages.Count - 1; i >= 0; i--)
        {
            var m = s.Messages[i];
            if (m["role"]?.GetValue<string>() != "user") continue;
            string c = ChatSession.ExtractUserText(m["content"]);
            if (c.StartsWith(SUMMARY_PREFIX)) continue;
            if (c.Length > budget && kept.Count > 0) break;
            kept.Insert(0, m);
            budget -= c.Length;
            if (budget <= 0) break;
        }
        // 4. 重建：L0 system + 保留用户消息 + 摘要消息(role=user)
        var newMsgs = new List<JsonNode>();
        foreach (var m in s.Messages)
            if (m["role"]?.GetValue<string>() == "system") { newMsgs.Add(m); break; }
        foreach (var m in kept) newMsgs.Add(m);
        newMsgs.Add(new JsonObject { ["role"] = "user", ["content"] = SUMMARY_PREFIX + "\n" + summary });
        s.Messages.Clear();
        foreach (var m in newMsgs) s.Messages.Add(m);
        s.LastInputTokens = 0;
        s.UpdateContextBar(EffectiveContextWindow(s), -1, EstimateToolsTokens(), EstimateSkillTokens());
        // 5. UI 提示 + 落盘
        s.AppendSys($"[系统] 上下文已压缩（保留 {kept.Count} 条近期用户消息 + 历史摘要），可继续对话");
        _session.Save(s.Id, s.Messages, MetaOf(s));
        s.ScrollToBottom();
        s.SetStatus("就绪");
        _log.Log($"会话 {s.Id} 上下文压缩完成，保留 {kept.Count} 条用户消息");
    }

    void ShowContextDetails(ChatSession s)
    {
        using var dlg = new ContextWindowForm(s, _cfg, () => { if (!s.Busy) _ = CompactSession(s); });
        dlg.ShowDialog(this);
        bool changed = false;
        int oldTh = s.ContextThreshold > 0 ? s.ContextThreshold : _cfg.CompactThreshold;
        if (dlg.NewContextThreshold != oldTh && dlg.NewContextThreshold > 0 && dlg.NewContextThreshold <= 100)
        {
            s.ContextThreshold = dlg.NewContextThreshold == _cfg.CompactThreshold ? 0 : dlg.NewContextThreshold;
            changed = true;
        }
        int oldWindow = s.ContextWindow > 0 ? s.ContextWindow : _cfg.ContextWindow;
        if (dlg.NewContextWindow != oldWindow && dlg.NewContextWindow > 1000)
        {
            s.ContextWindow = dlg.NewContextWindow == _cfg.ContextWindow ? 0 : dlg.NewContextWindow;
            changed = true;
            s.UpdateContextBar(EffectiveContextWindow(s), -1, EstimateToolsTokens(), EstimateSkillTokens());
        }
        if (changed)
            _session.Save(s.Id, s.Messages, MetaOf(s));
    }

    async Task GenerateTitle(ChatSession s)
    {
        string firstUser = null, firstAi = null;
        foreach (var m in s.Messages)
        {
            string role = m["role"]?.GetValue<string>() ?? "";
            if (role == "user" && firstUser == null)
                firstUser = m["content"]?.GetValue<string>();
            else if (role == "assistant" && !string.IsNullOrEmpty(m["content"]?.GetValue<string>()))
            { firstAi = m["content"]?.GetValue<string>(); break; }
        }
        if (firstUser == null) { s.TitleGenerated = true; return; }
        s.TitleGenerated = true;
        try
        {
            var ask = new List<JsonNode>
            {
                new JsonObject { ["role"] = "system", ["content"] = "你是标题生成器。用不超过 12 个中文字概括下面这段对话的主题，只输出标题文本，不要引号、不要书名号、不要句末标点。" },
                new JsonObject { ["role"] = "user", ["content"] = $"用户: {Trunc(firstUser, 300)}\n助手: {Trunc(firstAi, 300)}" }
            };
            string t = await s.Api.Complete(_cfg.Model, ask, _log);
            t = (t ?? "").Trim().Trim('"', '「', '」', '《', '》', '\n', '。', '.', '；', ';').Trim();
            if (!string.IsNullOrEmpty(t) && t.Length <= 24)
            {
                this.BeginInvoke(new Action(() =>
                {
                    s.SetTitle(t);
                    _session.Save(s.Id, s.Messages, MetaOf(s));
                    _log.Log($"AI 生成标题: {t}");
                }));
            }
        }
        catch (Exception ex) { _log.Err("生成标题失败: " + ex.Message); }
    }

    static string Trunc(string s, int n) => string.IsNullOrEmpty(s) ? "" : (s.Length > n ? s.Substring(0, n) + "…" : s);

    void SysMsg(string text, bool isErr = false)
    {
        _current?.AppendSys(text, isErr);
        _log.Log(text.Trim());
    }

    void BuildUi()
    {
        var tabs = new TabControl { Dock = DockStyle.Fill };

        // ---- 对话 Tab（左侧边栏 + 右侧会话区）----
        var chat = new TabPage("对话");
        _chatSplit = new SplitContainer
        {
            Dock = DockStyle.Fill, Orientation = Orientation.Vertical,
            SplitterDistance = 250, FixedPanel = FixedPanel.Panel1, SplitterWidth = 1,
            Panel1MinSize = 250
        };
        // 左侧边栏
        var sidebar = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(250, 250, 252) };
        var newBtn = new Button
        {
            Text = "+  新建会话", Dock = DockStyle.Top, Height = 34,
            FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(235, 238, 248),
            Font = new Font("Microsoft YaHei", 10f), Cursor = Cursors.Hand,
            TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(10, 0, 0, 0)
        };
        newBtn.FlatAppearance.BorderSize = 0;
        newBtn.FlatAppearance.MouseOverBackColor = Color.FromArgb(220, 226, 245);
        _sessionList = new Panel
        {
            Dock = DockStyle.Fill, AutoScroll = true, BackColor = Color.FromArgb(250, 250, 252)
        };
        sidebar.Controls.Add(_sessionList);
        sidebar.Controls.Add(newBtn);
        // 右侧会话区
        _sessionHost = new Panel { Dock = DockStyle.Fill };
        _chatSplit.Panel1.Controls.Add(sidebar);
        _chatSplit.Panel2.Controls.Add(_sessionHost);
        chat.Controls.Add(_chatSplit);
        newBtn.Click += (s, e) => CreateSession();

        // hover 由定时器命中检测驱动，避免事件残留
        _hoverTimer = new System.Windows.Forms.Timer { Interval = 120 };
        _hoverTimer.Tick += (s, e) => RefreshHover();
        _hoverTimer.Start();

        // ---- 设置 Tab ----
        var cfgPage = new TabPage("设置");
        var cfgSplit = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, SplitterDistance = 210, FixedPanel = FixedPanel.Panel1, SplitterWidth = 1 };
        // 左：profile 总览侧栏
        var profSidebar = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(250, 250, 252) };
        var pNewBtn = new Button { Text = "＋  新建 Profile", Dock = DockStyle.Top, Height = 34, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(235, 238, 248), Font = new Font("Microsoft YaHei", 9f), Cursor = Cursors.Hand, TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(10, 0, 0, 0) };
        pNewBtn.FlatAppearance.BorderSize = 0;
        pNewBtn.FlatAppearance.MouseOverBackColor = Color.FromArgb(220, 226, 245);
        _profileListBox = new ListBox { Dock = DockStyle.Fill, Font = new Font("Microsoft YaHei", 10f), BorderStyle = BorderStyle.None, BackColor = Color.FromArgb(250, 250, 252), IntegralHeight = false };
        profSidebar.Controls.Add(_profileListBox);
        profSidebar.Controls.Add(pNewBtn);
        // 右：编辑器 + 其它设置
        var form = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, Padding = new Padding(12),
            FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true
        };
        form.Controls.Add(MkTitle("Profile 详情"));
        _pName = AddRow(form, "Profile 名称:");
        _pBase = AddRow(form, "Base URL:");
        _pKey = AddRow(form, "API Key:");
        _pModel = AddRow(form, "模型 (如 deepseek-chat / deepseek-reasoner):");
        // 角色卡绑定行
        var cardRow = new Panel { Width = 680, Height = 52 };
        cardRow.Controls.Add(new Label { Text = "绑定角色卡 (该 profile 默认人设，空=用 SOUL.md):", Dock = DockStyle.Top, Height = 20 });
        _pCard = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Bottom, Width = 680, Font = new Font("Microsoft YaHei", 9f) };
        cardRow.Controls.Add(_pCard);
        form.Controls.Add(cardRow);
        var pBtnRow = new Panel { Width = 680, Height = 34 };
        var pSave = new Button { Text = "保存此 Profile", AutoSize = true, Left = 0, Top = 4, BackColor = Color.FromArgb(60, 130, 60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        var pActive = new Button { Text = "设为当前", AutoSize = true, Left = 130, Top = 4, FlatStyle = FlatStyle.Flat };
        var pDel = new Button { Text = "删除", AutoSize = true, Left = 210, Top = 4, FlatStyle = FlatStyle.Flat };
        pSave.FlatAppearance.BorderSize = 0; pActive.FlatAppearance.BorderSize = 0; pDel.FlatAppearance.BorderSize = 0;
        pBtnRow.Controls.Add(pDel); pBtnRow.Controls.Add(pActive); pBtnRow.Controls.Add(pSave);
        form.Controls.Add(pBtnRow);
        form.Controls.Add(MkTitle("其它设置"));
        _cRoots = AddRow(form, "IO 白名单 io_roots (| 分隔):");
        _cSuffix = AddRow(form, "指令后缀 user_suffix:");
        _cShellMode = AddRow(form, "Shell 模式 (ask / auto / off):");
        _cContextWindow = AddRow(form, "上下文窗口上限 (tokens, 默认 200000):");
        _cCompactThreshold = AddRow(form, "上下文压缩阈值 (% , 默认 80):");
        var save = new Button { Text = "保存全部配置", AutoSize = true, Margin = new Padding(0, 6, 0, 0), BackColor = Color.FromArgb(60,130,60), ForeColor = Color.White, FlatStyle = FlatStyle.Flat };
        save.FlatAppearance.BorderSize = 0;
        var logBtn = new Button { Text = "打开日志窗口", AutoSize = true, Margin = new Padding(8, 6, 0, 0), FlatStyle = FlatStyle.Flat };
        logBtn.FlatAppearance.BorderSize = 0;
        logBtn.Click += (s, e) => { var f = new FLog(_log); f.Show(this); };
        save.Click += (s, e) => SaveConfigFromUi();
        var btnRow = new Panel { Width = 680, Height = 34 };
        btnRow.Controls.Add(logBtn);
        btnRow.Controls.Add(save);
        form.Controls.Add(btnRow);
        cfgSplit.Panel1.Controls.Add(profSidebar);
        cfgSplit.Panel2.Controls.Add(form);
        cfgPage.Controls.Add(cfgSplit);

        _profileListBox.SelectedIndexChanged += (s, e) => LoadProfileToEditor();
        pNewBtn.Click += (s, e) => NewProfile();
        pSave.Click += (s, e) => SaveProfileFromEditor();
        pDel.Click += (s, e) => DeleteSelectedProfile();
        pActive.Click += (s, e) => SetActiveProfile();

        // ---- 角色卡 Tab ----
        var charPage = new TabPage("角色卡");
        var cardBar = new FlowLayoutPanel
        {
            Dock = DockStyle.Top, Height = 42, FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false, Padding = new Padding(6, 6, 6, 0), AutoScroll = true
        };
        _cardNew = MkBtn("新建模板");
        _cardApply = MkBtn("应用到 SOUL.md");
        _cardRename = MkBtn("重命名");
        _cardDelete = MkBtn("删除模板");
        _cardSave = MkBtn("保存");
        _cardClear = MkBtn("清空内容");
        _cardRecover = MkBtn("恢复");
        _cardModeToggle = MkBtn("源码模式");
        _cardPreviewBtn = MkBtn("预览");
        cardBar.Controls.AddRange(new Control[] { _cardNew, _cardApply, _cardRename, _cardDelete, _cardSave, _cardClear, _cardRecover, _cardModeToggle, _cardPreviewBtn });

        // 主区域：左卡片列表 + 右编辑器
        var mainSplit = new SplitContainer { Dock = DockStyle.Fill, Orientation = Orientation.Vertical, SplitterDistance = 180, FixedPanel = FixedPanel.Panel1 };
        _cardList = new ListView
        {
            Dock = DockStyle.Fill, View = View.Details, FullRowSelect = true, HideSelection = false,
            Font = new Font("Microsoft YaHei", 10f), ShowItemToolTips = true
        };
        _cardList.Columns.Add("角色卡", 160);
        _cardList.SelectedIndexChanged += (s, e) => { if (!_cardBusy) LoadCardToEditor(); };
        mainSplit.Panel1.Controls.Add(_cardList);

        // 右侧：编辑器区 + 底部快捷栏
        var rightPanel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2 };
        rightPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        rightPanel.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));
        var editorHost = new Panel { Dock = DockStyle.Fill };

        // 结构化编辑面板
        _cardStructPanel = new Panel { Dock = DockStyle.Fill };
        var metaWrap = new Panel { Dock = DockStyle.Top, Height = 86, Padding = new Padding(6, 4, 6, 4), BackColor = Color.FromArgb(248, 248, 250) };
        var lT = new Label { Text = "角色名（# 标题，即 AI 聊天显示名）", Dock = DockStyle.Top, Height = 16, ForeColor = Color.Gray, Font = new Font("Microsoft YaHei", 9f) };
        _cardTitle = new TextBox { Dock = DockStyle.Top, Font = new Font("Microsoft YaHei", 11f, FontStyle.Bold) };
        var lD = new Label { Text = "简介（> 描述，可空）", Dock = DockStyle.Top, Height = 16, ForeColor = Color.Gray, Font = new Font("Microsoft YaHei", 9f), Margin = new Padding(0, 4, 0, 0) };
        _cardDesc = new TextBox { Dock = DockStyle.Top, Font = new Font("Microsoft YaHei", 10f) };
        metaWrap.Controls.Add(_cardDesc);
        metaWrap.Controls.Add(lD);
        metaWrap.Controls.Add(_cardTitle);
        metaWrap.Controls.Add(lT);

        var addSecBtn = new Button { Text = "+ 添加节", Dock = DockStyle.Bottom, Height = 30, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(238, 242, 252), Font = new Font("Microsoft YaHei", 9f), Cursor = Cursors.Hand };
        addSecBtn.FlatAppearance.BorderSize = 0;
        _sectionsFlow = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(4, 4, 4, 4), BackColor = Color.White };
        _cardStructPanel.Controls.Add(_sectionsFlow);
        _cardStructPanel.Controls.Add(addSecBtn);
        _cardStructPanel.Controls.Add(metaWrap);
        addSecBtn.Click += (s, e) => AddSection("新节", "");
        _cardTitle.TextChanged += (s, e) => ScheduleSyncFromStruct();
        _cardDesc.TextChanged += (s, e) => ScheduleSyncFromStruct();
        _sectionsFlow.Resize += (s, e) =>
        {
            foreach (SectionEditor se in _sectionsFlow.Controls.OfType<SectionEditor>())
                se.Width = _sectionsFlow.ClientSize.Width - se.Margin.Horizontal - 2;
        };

        // 源码模式文本框
        _cardRawEdit = new TextBox { Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Vertical, Font = new Font("Consolas", 10f), AcceptsTab = true, Visible = false };
        _cardRawEdit.TextChanged += (s, e) => { _previewTimer.Stop(); _previewTimer.Start(); };

        editorHost.Controls.Add(_cardStructPanel);
        editorHost.Controls.Add(_cardRawEdit);

        // 底部快捷插入栏
        var insertBar = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(4, 5, 4, 4), AutoScroll = true };
        var insLabel = new Label { Text = "新增节:", AutoSize = true, Margin = new Padding(2, 7, 8, 0), ForeColor = Color.Gray, Font = new Font("Microsoft YaHei", 9f) };
        var bId = MkBtn("身份锚点");
        var bPer = MkBtn("性格");
        var bTon = MkBtn("语气");
        var bBeh = MkBtn("行为模式");
        var bBnd = MkBtn("边界");
        bId.Click += (s, e) => InsertSectionHeading("身份锚点");
        bPer.Click += (s, e) => InsertSectionHeading("性格");
        bTon.Click += (s, e) => InsertSectionHeading("语气");
        bBeh.Click += (s, e) => InsertSectionHeading("行为模式");
        bBnd.Click += (s, e) => InsertSectionHeading("边界");
        insertBar.Controls.AddRange(new Control[] { insLabel, bId, bPer, bTon, bBeh, bBnd });

        rightPanel.Controls.Add(editorHost, 0, 0);
        rightPanel.Controls.Add(insertBar, 0, 1);
        mainSplit.Panel2.Controls.Add(rightPanel);

        _cardNote = new Label { Dock = DockStyle.Bottom, Height = 22, ForeColor = Color.Gray, Text = "", Font = new Font("Microsoft YaHei", 9f) };
        var noteWrap = new Panel { Dock = DockStyle.Bottom, Height = 24 };
        noteWrap.Controls.Add(_cardNote);

        charPage.Controls.Add(mainSplit);
        charPage.Controls.Add(noteWrap);
        charPage.Controls.Add(cardBar);

        _cardApply.Click += (s, e) => ApplyToSoul();
        _cardSave.Click += (s, e) => SaveCardFromEditor();
        _cardNew.Click += (s, e) => NewCard();
        _cardClear.Click += (s, e) => ClearContent();
        _cardRecover.Click += (s, e) => RecoverCard();
        _cardRename.Click += (s, e) => RenameCard();
        _cardDelete.Click += (s, e) => DeleteCard();
        _cardModeToggle.Click += (s, e) => ToggleCardMode();
        _cardPreviewBtn.Click += (s, e) => ShowPreviewPopup();

        _previewTimer = new System.Windows.Forms.Timer { Interval = 400 };
        _previewTimer.Tick += (s, e) => { _previewTimer.Stop(); if (!_cardRawMode) SyncFromStruct(); };

        tabs.TabPages.Add(chat);
        tabs.TabPages.Add(cfgPage);
        tabs.TabPages.Add(charPage);
        Controls.Add(tabs);
    }

    Button MkBtn(string t) => new() { Text = t, AutoSize = true, Margin = new Padding(0, 4, 6, 4) };

    TextBox AddRow(FlowLayoutPanel p, string label)
    {
        var lp = new Panel { Width = 680, Height = 52 };
        var l = new Label { Text = label, Dock = DockStyle.Top, Height = 20 };
        var t = new TextBox { Dock = DockStyle.Bottom, Width = 680 };
        lp.Controls.Add(t);
        lp.Controls.Add(l);
        p.Controls.Add(lp);
        return t;
    }

    Label MkTitle(string t) => new() { Text = t, AutoSize = true, Font = new Font("Microsoft YaHei", 11f, FontStyle.Bold), ForeColor = Color.FromArgb(60, 110, 220), Margin = new Padding(0, 6, 0, 4) };

    void LoadConfigToUi()
    {
        _profileListBox.Items.Clear();
        for (int i = 0; i < _cfg.Profiles.Count; i++)
        {
            var p = _cfg.Profiles[i];
            _profileListBox.Items.Add((p.Name == _cfg.ActiveProfileName ? "★ " : "   ") + p.Name);
        }
        // 角色卡列表
        _pCard.Items.Clear();
        _pCard.Items.Add("(无)");
        if (Directory.Exists(_charDir))
            foreach (var f in Directory.GetFiles(_charDir, "*.md"))
                _pCard.Items.Add(Path.GetFileNameWithoutExtension(f));
        LoadProfileToEditor();
        _cRoots.Text = _cfg.IoRoots;
        _cSuffix.Text = _cfg.UserSuffix;
        _cShellMode.Text = _cfg.ShellEnable == 1 ? _cfg.ShellMode : "off";
        _cContextWindow.Text = _cfg.ContextWindow.ToString();
        _cCompactThreshold.Text = _cfg.CompactThreshold.ToString();
    }

    void LoadProfileToEditor()
    {
        int idx = _profileListBox.SelectedIndex;
        if (idx < 0 || idx >= _cfg.Profiles.Count) return;
        var p = _cfg.Profiles[idx];
        _pName.Text = p.Name; _pBase.Text = p.BaseUrl; _pKey.Text = p.ApiKey; _pModel.Text = p.Model;
        _pCard.SelectedItem = string.IsNullOrEmpty(p.CharacterCard) ? "(无)" : p.CharacterCard;
        if (_pCard.SelectedIndex < 0) _pCard.SelectedIndex = 0;
    }

    void NewProfile()
    {
        string baseName = "新模型";
        string name = baseName; int n = 2;
        while (_cfg.Profiles.Exists(x => x.Name == name)) { name = baseName + "_" + n; n++; }
        _cfg.Profiles.Add(new ModelProfile { Name = name, BaseUrl = "https://api.deepseek.com", Model = "deepseek-chat" });
        _cfg.Save();
        LoadConfigToUi();
        _profileListBox.SelectedIndex = _cfg.Profiles.Count - 1;
        _pName.Focus(); _pName.SelectAll();
        _log.Log($"新建 Profile: {name}");
    }

    void SaveProfileFromEditor()
    {
        string name = _pName.Text.Trim();
        if (string.IsNullOrEmpty(name)) { SysMsg("[系统] Profile 名称不能为空", isErr: true); return; }
        string card = _pCard.SelectedItem?.ToString() ?? "(无)";
        if (card == "(无)") card = "";
        _cfg.SaveProfile(name, _pBase.Text.Trim(), _pKey.Text.Trim(), _pModel.Text.Trim(), card);
        _cfg.BuildWhitelist();
        _cfg.Save();
        RefreshSessionApis();
        LoadConfigToUi();
        for (int i = 0; i < _cfg.Profiles.Count; i++) if (_cfg.Profiles[i].Name == name) _profileListBox.SelectedIndex = i;
        _log.Log($"保存 Profile: {name} (角色卡={card ?? "无"})");
        _current?.AppendSys($"[系统] Profile [{name}] 已保存");
    }

    void DeleteSelectedProfile()
    {
        int idx = _profileListBox.SelectedIndex;
        if (idx < 0 || idx >= _cfg.Profiles.Count) return;
        if (_cfg.Profiles.Count <= 1) { SysMsg("[系统] 至少保留一个 Profile", isErr: true); return; }
        string name = _cfg.Profiles[idx].Name;
        _cfg.DeleteProfile(name);
        _cfg.Save();
        RefreshSessionApis();
        LoadConfigToUi();
        _log.Log($"删除 Profile: {name}");
    }

    void SetActiveProfile()
    {
        int idx = _profileListBox.SelectedIndex;
        if (idx < 0 || idx >= _cfg.Profiles.Count) return;
        string name = _cfg.Profiles[idx].Name;
        _cfg.SwitchProfile(name);
        _cfg.Save();
        LoadConfigToUi();
        _log.Log($"设为当前 Profile: {name}（新会话默认）");
        _current?.AppendSys($"[系统] 默认 Profile 设为 [{name}]（影响新会话）");
    }

    List<ModelOption> BuildModelOptions()
    {
        var list = new List<ModelOption>();
        foreach (var p in _cfg.Profiles)
            list.Add(new ModelOption { Profile = p.Name, Model = p.Model, BaseUrl = p.BaseUrl, ApiKey = p.ApiKey });
        return list;
    }

    void RefreshSessionApis()
    {
        var options = BuildModelOptions();
        foreach (var s in _sessions)
        {
            var p = _cfg.Profiles.Find(x => x.Name == s.ProfileName);
            if (p != null && s.Api != null) { s.Api.SetKey(p.ApiKey); s.Api.SetBase(p.BaseUrl); s.Model = p.Model; s.DisplayName = ResolveDisplayName(p); }
            s.PopulateModels(options, s.ProfileName);
            s.SyncApproval(s.ApprovalMode);
        }
    }

    void SaveConfigFromUi()
    {
        // 先保存当前编辑的 profile
        if (!string.IsNullOrWhiteSpace(_pName.Text))
        {
            string card = _pCard.SelectedItem?.ToString() ?? "(无)";
            if (card == "(无)") card = "";
            _cfg.SaveProfile(_pName.Text.Trim(), _pBase.Text.Trim(), _pKey.Text.Trim(), _pModel.Text.Trim(), card);
        }
        _cfg.IoRoots = _cRoots.Text;
        _cfg.UserSuffix = _cSuffix.Text;
        string sm = (_cShellMode.Text ?? "").Trim().ToLower();
        if (sm == "off") { _cfg.ShellEnable = 0; _cfg.ShellMode = "ask"; }
        else { _cfg.ShellEnable = 1; _cfg.ShellMode = (sm == "auto") ? "auto" : "ask"; }
        if (int.TryParse(_cContextWindow.Text, out var cw) && cw > 1000) _cfg.ContextWindow = cw;
        if (int.TryParse(_cCompactThreshold.Text, out var ct) && ct > 0 && ct <= 100) _cfg.CompactThreshold = ct;
        _cfg.BuildWhitelist();
        _cfg.Save();
        foreach (var sess in _sessions)
            sess.UpdateContextBar(EffectiveContextWindow(sess), -1, EstimateToolsTokens(), EstimateSkillTokens());
        RefreshSessionApis();
        LoadConfigToUi();
        RefreshSessionApis();
        _log.Log("配置已保存（热更）");
        _current?.AppendSys("[系统] 配置已保存并应用");
    }

    // ---- 角色卡 ----
    bool _cardBusy = false;
    string CardFilePath(string name)
        => name == "SOUL" ? _soulPath : Path.Combine(_charDir, name + ".md");

    void PopulateCards()
    {
        _cardBusy = true;
        _cardList.Items.Clear();
        var soulItem = new ListViewItem("★ SOUL.md (当前)") { Tag = "SOUL", Font = new Font(_cardList.Font, FontStyle.Bold) };
        soulItem.ForeColor = Color.FromArgb(180, 80, 40);
        _cardList.Items.Add(soulItem);
        if (Directory.Exists(_charDir))
            foreach (var f in Directory.GetFiles(_charDir, "*.md"))
            {
                string name = Path.GetFileNameWithoutExtension(f);
                if (name.EndsWith(".bak")) continue;
                _cardList.Items.Add(new ListViewItem(name) { Tag = name });
            }
        if (_cardList.Items.Count > 0) _cardList.Items[0].Selected = true;
        _cardBusy = false;
        LoadCardToEditor();
    }

    void LoadCardToEditor()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        if (name == null) return;
        string p = CardFilePath(name);
        string content = File.Exists(p) ? File.ReadAllText(p) : "";
        _cardDoc = CardDoc.Parse(content);
        _cardRawEdit.Text = content;
        PopulateStructFromDoc();
        bool isSoul = name == "SOUL";
        _cardApply.Enabled = !isSoul;
        _cardRename.Enabled = !isSoul;
        _cardDelete.Enabled = !isSoul;
        _cardNote.Text = isSoul
            ? "SOUL.md = 当前活跃人设（改完点「保存」即生效，新会话自动加载）"
            : $"{name}.md = 模板；点「应用到 SOUL.md」启用为新会话人设";
    }

    void PopulateStructFromDoc()
    {
        _cardSynth = true;
        _cardTitle.Text = _cardDoc.Title;
        _cardDesc.Text = _cardDoc.Description;
        _sectionsFlow.Controls.Clear();
        foreach (var (h, b) in _cardDoc.Sections)
        {
            var se = new SectionEditor(h, b);
            se.OnDelete = RemoveSection;
            se.OnChanged = ScheduleSyncFromStruct;
            se.Width = _sectionsFlow.ClientSize.Width - se.Margin.Horizontal - 2;
            _sectionsFlow.Controls.Add(se);
        }
        _cardSynth = false;
    }

    void AddSection(string head, string body)
    {
        var se = new SectionEditor(head, body);
        se.OnDelete = RemoveSection;
        se.OnChanged = ScheduleSyncFromStruct;
        se.Width = _sectionsFlow.ClientSize.Width - se.Margin.Horizontal - 2;
        _sectionsFlow.Controls.Add(se);
        _sectionsFlow.ScrollControlIntoView(se);
        ScheduleSyncFromStruct();
    }

    void RemoveSection(SectionEditor se)
    {
        _sectionsFlow.Controls.Remove(se);
        ScheduleSyncFromStruct();
    }

    void InsertSectionHeading(string heading)
    {
        if (_cardRawMode)
        {
            int pos = _cardRawEdit.SelectionStart;
            string snip = $"## {heading}\n- \n\n";
            _cardRawEdit.Text = _cardRawEdit.Text.Insert(pos, snip);
            _cardRawEdit.SelectionStart = pos + snip.Length;
            _cardRawEdit.Focus();
        }
        else
        {
            AddSection(heading, "- ");
        }
    }

    void ScheduleSyncFromStruct()
    {
        if (_cardSynth) return;
        _previewTimer.Stop();
        _previewTimer.Start();
    }

    void SyncFromStruct()
    {
        if (_cardDoc == null) _cardDoc = new CardDoc();
        _cardDoc.Title = _cardTitle.Text;
        _cardDoc.Description = _cardDesc.Text;
        _cardDoc.Sections.Clear();
        foreach (SectionEditor se in _sectionsFlow.Controls.OfType<SectionEditor>())
            _cardDoc.Sections.Add((se.Head.Text, se.Body.Text));
        // 同步到 raw 文本框（隐藏时也保持，方便切回）
        if (!_cardRawMode) _cardRawEdit.Text = _cardDoc.Serialize();
    }

    string GetCurrentCardContent()
    {
        if (_cardRawMode) return _cardRawEdit.Text;
        SyncFromStruct();
        return _cardDoc.Serialize();
    }

    void ToggleCardMode()
    {
        if (!_cardRawMode)
        {
            SyncFromStruct();
            _cardRawEdit.Text = _cardDoc.Serialize();
            _cardStructPanel.Visible = false;
            _cardRawEdit.Visible = true;
            _cardModeToggle.Text = "结构模式";
            _cardRawMode = true;
        }
        else
        {
            _cardDoc = CardDoc.Parse(_cardRawEdit.Text);
            PopulateStructFromDoc();
            _cardRawEdit.Visible = false;
            _cardStructPanel.Visible = true;
            _cardModeToggle.Text = "源码模式";
            _cardRawMode = false;
        }
    }

    void ShowPreviewPopup()
    {
        string name = _cardList.SelectedItems.Count > 0 ? (_cardList.SelectedItems[0].Tag as string ?? "") : "";
        var f = new Form { Text = $"预览 · {name}", ClientSize = new Size(560, 640), StartPosition = FormStartPosition.CenterParent, ShowInTaskbar = false };
        var wb = new WebBrowser { Dock = DockStyle.Fill, ScriptErrorsSuppressed = true };
        f.Controls.Add(wb);
        try { wb.DocumentText = Md.ToHtml(GetCurrentCardContent()); } catch { }
        f.Show(this);
    }

    void SelectCard(string name)
    {
        for (int i = 0; i < _cardList.Items.Count; i++)
            if (_cardList.Items[i].Tag as string == name) { _cardList.Items[i].Selected = true; break; }
    }

    void ReloadCurrentCard()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        string p = CardFilePath(name);
        string content = File.Exists(p) ? File.ReadAllText(p) : "";
        _cardDoc = CardDoc.Parse(content);
        _cardRawEdit.Text = content;
        PopulateStructFromDoc();
    }

    string FullTemplate()
        => "# 角色卡 · \n\n> 在此写人设/性格/语气/行为模式。规则由 AGENTS/TOOL/HUB 提供。\n\n## 身份锚点\n- \n\n## 性格\n- \n\n## 语气\n- \n\n## 行为模式\n- \n\n## 边界\n- \n";

    void ApplyToSoul()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        if (name == null) return;
        if (name == "SOUL") { SysMsg("[系统] SOUL.md 已是当前活跃人设\n"); return; }
        string content = GetCurrentCardContent();
        Directory.CreateDirectory(Path.GetDirectoryName(_soulPath)!);
        File.WriteAllText(_soulPath, content);
        if (_current != null)
        {
            _current.Messages.Clear();
            _current.L0Loaded = false;
            _current.TitleGenerated = false;
            _session.Save(_current.Id, _current.Messages, MetaOf(_current));
            _current.ClearChat();
            _current.SetTitle("新会话");
            EnsureL0(_current);
        }
        SysMsg($"[系统] 已将模板 [{name}] 应用到 SOUL.md（当前会话已重置为新上下文）\n");
        _log.Log($"应用模板到 SOUL.md: {name}");
        SelectCard("SOUL");
    }

    void SaveCardFromEditor()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        if (name == null) return;
        string p = CardFilePath(name);
        Directory.CreateDirectory(Path.GetDirectoryName(p)!);
        File.WriteAllText(p, GetCurrentCardContent());
        _log.Log($"保存卡片: {name}");
        SysMsg("[系统] 卡片已保存\n");
        if (name == "SOUL" && _current != null)
        {
            _current.Messages.Clear();
            _current.L0Loaded = false;
            _current.TitleGenerated = false;
            _session.Save(_current.Id, _current.Messages, MetaOf(_current));
            EnsureL0(_current);
            SysMsg("[系统] SOUL.md 已重载（当前会话已重置为新上下文）\n");
        }
    }

    void NewCard()
    {
        string name = Prompt("新建角色模板", "模板名（英文，生成 <名>.md）：");
        if (string.IsNullOrEmpty(name)) return;
        name = Path.GetFileNameWithoutExtension(name);
        if (name == "SOUL") { SysMsg("[系统] 该名保留\n", isErr: true); return; }
        string p = CardFilePath(name);
        if (File.Exists(p)) { SysMsg("[系统] 该名已存在\n", isErr: true); return; }
        Directory.CreateDirectory(_charDir);
        File.WriteAllText(p, FullTemplate());
        _log.Log($"新建模板: {name}");
        PopulateCards();
        SelectCard(name);
    }

    void RenameCard()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string old = _cardList.SelectedItems[0].Tag as string;
        if (old == null || old == "SOUL") return;
        string name = Prompt("重命名模板", "新名（英文，不含 .md）：");
        if (string.IsNullOrEmpty(name)) return;
        name = Path.GetFileNameWithoutExtension(name);
        if (name == "SOUL") { SysMsg("[系统] 该名保留\n", isErr: true); return; }
        string oldP = CardFilePath(old);
        string newP = CardFilePath(name);
        if (File.Exists(newP)) { SysMsg("[系统] 该名已存在\n", isErr: true); return; }
        try { File.Move(oldP, newP); } catch (Exception ex) { SysMsg("[系统] 重命名失败: " + ex.Message + "\n", isErr: true); return; }
        if (File.Exists(oldP + ".bak")) try { File.Move(oldP + ".bak", newP + ".bak"); } catch { }
        _log.Log($"重命名模板: {old} -> {name}");
        PopulateCards();
        SelectCard(name);
    }

    void DeleteCard()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        if (name == null || name == "SOUL") return;
        if (MessageBox.Show(this, $"确认删除模板 [{name}.md]？", "删除", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
        string p = CardFilePath(name);
        try { if (File.Exists(p)) File.Delete(p); } catch { }
        try { if (File.Exists(p + ".bak")) File.Delete(p + ".bak"); } catch { }
        _log.Log($"删除模板: {name}");
        PopulateCards();
    }

    void ClearContent()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        if (name == null) return;
        string p = CardFilePath(name);
        if (!File.Exists(p)) { SysMsg("[系统] 文件不存在\n", isErr: true); return; }
        File.Copy(p, p + ".bak", overwrite: true);
        File.WriteAllText(p, "");
        ReloadCurrentCard();
        SysMsg($"[系统] 已清空 [{name}] 内容（备份存于 .bak，点「恢复」还原）\n");
        _log.Log($"清空卡片内容: {name}");
    }

    void RecoverCard()
    {
        if (_cardList.SelectedItems.Count == 0) return;
        string name = _cardList.SelectedItems[0].Tag as string;
        if (name == null) return;
        string p = CardFilePath(name);
        string bak = p + ".bak";
        if (!File.Exists(bak)) { SysMsg("[系统] 无备份可恢复\n", isErr: true); return; }
        File.Copy(bak, p, overwrite: true);
        ReloadCurrentCard();
        SysMsg($"[系统] 已从备份恢复 [{name}]\n");
        _log.Log($"恢复卡片内容: {name}");
    }

    string Prompt(string title, string label)
    {
        using var f = new Form { Text = title, ClientSize = new Size(320, 110), FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterParent };
        var l = new Label { Text = label, Left = 12, Top = 12, AutoSize = true };
        var t = new TextBox { Left = 12, Top = 34, Width = 290 };
        var ok = new Button { Text = "确定", DialogResult = DialogResult.OK, Left = 215, Top = 72, Width = 85 };
        f.Controls.AddRange(new Control[] { l, t, ok });
        f.AcceptButton = ok;
        return f.ShowDialog() == DialogResult.OK ? t.Text.Trim() : null;
    }
}
