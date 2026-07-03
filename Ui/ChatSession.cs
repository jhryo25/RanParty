using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Windows.Forms;
using RanParty.Core;
using RanParty.Tools;

namespace RanParty.Ui;

public class ModelOption
{
    public string Profile = "";
    public string Model = "";
    public string BaseUrl = "";
    public string ApiKey = "";
}

// WebBrowser 脚本回调桥（文件卡片点击 → 打开文件）
[ComVisible(true)]
public class TranscriptBridge
{
    public Action<string> OnOpenPath;
    public void openPath(string path) { OnOpenPath?.Invoke(path); }
}

public class ChatSession
{
    public string Id;
    public string Title = "新会话";
    public List<JsonNode> Messages = new();
    public bool L0Loaded;
    public bool Busy;
    public bool TitleGenerated;
    public CancellationTokenSource Cts;
    public DateTime Created = DateTime.Now;
    public DateTime LastActive = DateTime.Now;
    public string Model = "";
    public string ProfileName = "";
    public string DisplayName = "AI";
    public string ApprovalMode = "ask";
    public ApiClient Api;
    public string PendingImage;
    public string Workspace = "";
    public int TokensIn, TokensOut;
    public int LastInputTokens;
    public int ContextThreshold;
    public int ContextWindow;
    public Panel Container;
    public SessionItem Item;
    public WebBrowser Transcript;
    public TextBox Input;
    public Button Send;
    public Label Status;
    public ComboBox ModelBox;
    public ComboBox ApprovalBox;
    public Button WsBtn;
    public Label TokenLbl;
    public Action<string> OnOpenPath;
    TranscriptBridge _bridge;
    Panel _imgChip;
    Label _imgChipName;
    Button _imgChipDel;
    Panel _ctxRing;
    ToolTip _ctxTip = new ToolTip { InitialDelay = 150, ReshowDelay = 100, AutoPopDelay = 8000 };
    int _ctxWindow, _ctxUsed, _ctxPct;
    int _ctxSystemTokens, _ctxToolsTokens, _ctxSkillTokens, _ctxMessagesTokens, _ctxFreeTokens;
    Color _ctxArcColor = Color.FromArgb(80, 170, 90);
    public Action<ChatSession> OnCompactRequest;
    public Action<ChatSession> OnContextDetailsRequest;

    StringBuilder _aiBuf = new();
    StringBuilder _reasonBuf = new();
    List<(string name, string path)> _pendingCards = new();
    bool _aiActive;
    bool _aiCardCreated;
    bool _populating;
    public bool HistoryRendered;
    Action _pendingRender;
    List<ModelOption> _modelOptions = new();

    public ChatSession(string id) { Id = id; }

    public void BuildUi(Action onSend, Action onStop)
    {
        Container = new Panel { Dock = DockStyle.Fill };
        Transcript = new WebBrowser
        {
            Dock = DockStyle.Fill, ScriptErrorsSuppressed = true,
            DocumentText = SkeletonHtml()
        };
        _bridge = new TranscriptBridge { OnOpenPath = p => OnOpenPath?.Invoke(p) };
        Transcript.ObjectForScripting = _bridge;
        Transcript.DocumentCompleted += (s, e) =>
        {
            var a = _pendingRender; _pendingRender = null; a?.Invoke();
        };

        var toolRow = new Panel { Dock = DockStyle.Top, Height = 30 };
        ModelBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Font = new Font("Microsoft YaHei", 9f), Margin = new Padding(2, 3, 2, 3) };
        ApprovalBox = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, Font = new Font("Microsoft YaHei", 9f), Margin = new Padding(2, 3, 2, 3) };
        ApprovalBox.Items.AddRange(new object[] { "每步审核", "自动通过" });
        ApprovalBox.SelectedIndex = 0;
        ApprovalBox.SelectedIndexChanged += (sender, e) =>
        {
            if (_populating) return;
            ApprovalMode = ApprovalBox.SelectedIndex == 1 ? "auto" : "ask";
        };
        WsBtn = new Button { FlatStyle = FlatStyle.Flat, TextAlign = ContentAlignment.MiddleLeft, Font = new Font("Microsoft YaHei", 8.5f), BackColor = Color.FromArgb(245, 245, 248), Text = "📁 工作区", Margin = new Padding(2, 3, 2, 3) };
        WsBtn.FlatAppearance.BorderSize = 0;
        Status = new Label { Text = "就绪", ForeColor = Color.Gray, Font = new Font("Microsoft YaHei", 9f), TextAlign = ContentAlignment.MiddleLeft };
        TokenLbl = new Label { Dock = DockStyle.Fill, ForeColor = Color.Gray, Font = new Font("Consolas", 9f), TextAlign = ContentAlignment.MiddleRight, Text = "" };
        _ctxRing = new Panel { Dock = DockStyle.Left, Width = 22, Margin = new Padding(0, 4, 6, 4), Cursor = Cursors.Hand };
        _ctxRing.Paint += (s, e) => PaintCtxRing(e.Graphics);
        _ctxRing.Click += (s, e) => { if (!Busy) OnContextDetailsRequest?.Invoke(this); };
        var tokenWrap = new Panel { Margin = new Padding(0) };
        tokenWrap.Controls.Add(TokenLbl);
        tokenWrap.Controls.Add(_ctxRing);
        toolRow.Controls.Add(ModelBox);
        toolRow.Controls.Add(ApprovalBox);
        toolRow.Controls.Add(WsBtn);
        toolRow.Controls.Add(Status);
        toolRow.Controls.Add(tokenWrap);
        void LayoutToolRow()
        {
            const int mw = 160, aw = 110, ww = 200, tw = 130;
            int h = toolRow.Height;
            int x = 0;
            ModelBox.SetBounds(x + 2, 2, mw - 4, h - 4); x += mw;
            ApprovalBox.SetBounds(x + 2, 2, aw - 4, h - 4); x += aw;
            WsBtn.SetBounds(x + 2, 2, ww - 4, h - 4); x += ww;
            int tokenX = Math.Max(x, toolRow.Width - tw);
            Status.SetBounds(x + 2, 2, Math.Max(0, tokenX - x - 4), h - 4);
            tokenWrap.SetBounds(tokenX + 2, 2, Math.Max(0, toolRow.Width - tokenX - 4), h - 4);
        }
        LayoutToolRow();
        toolRow.Resize += (s, e) => LayoutToolRow();

        ModelBox.SelectedIndexChanged += (s, e) => OnModelBoxChanged();

        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 162 };
        var inputPanel = new Panel { Dock = DockStyle.Fill };
        Input = new TextBox { Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Vertical };
        Send = new Button { Text = "发送 Enter", Dock = DockStyle.Right, Width = 110 };
        var sendWrap = new Panel { Dock = DockStyle.Right, Width = 110 };
        sendWrap.Controls.Add(Send);
        _imgChip = new Panel { Dock = DockStyle.Top, Height = 30, Visible = false, BackColor = Color.FromArgb(245, 245, 248), Padding = new Padding(8, 2, 4, 2) };
        var ico = new Label { Text = "🖼", Dock = DockStyle.Left, Width = 28, TextAlign = ContentAlignment.MiddleLeft, Font = new Font("Microsoft YaHei", 11f), Margin = new Padding(0) };
        _imgChipName = new Label { Text = "", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true, Font = new Font("Microsoft YaHei", 9f), ForeColor = Color.FromArgb(80, 90, 100), Margin = new Padding(0) };
        _imgChipDel = new Button { Text = "×", Dock = DockStyle.Right, Width = 26, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(225, 95, 95), ForeColor = Color.White, Font = new Font("Segoe UI", 11f, FontStyle.Bold), Cursor = Cursors.Hand, Visible = false, TextAlign = ContentAlignment.MiddleCenter, Margin = new Padding(0) };
        _imgChipDel.FlatAppearance.BorderSize = 0;
        _imgChipDel.Click += (s, e) => ClearPendingImage();
        Action showDel = () => _imgChipDel.Visible = true;
        Action hideDel = () =>
        {
            var p = Control.MousePosition;
            bool over = false;
            foreach (var c in new Control[] { _imgChip, _imgChipName, _imgChipDel })
                try { if (c.RectangleToScreen(c.ClientRectangle).Contains(p)) { over = true; break; } } catch { }
            _imgChipDel.Visible = over;
        };
        _imgChip.MouseEnter += (s, e) => showDel();
        _imgChip.MouseLeave += (s, e) => hideDel();
        _imgChipName.MouseEnter += (s, e) => showDel();
        _imgChipName.MouseLeave += (s, e) => hideDel();
        _imgChipDel.MouseEnter += (s, e) => showDel();
        _imgChipDel.MouseLeave += (s, e) => hideDel();
        _imgChip.Controls.Add(_imgChipName);
        _imgChip.Controls.Add(ico);
        _imgChip.Controls.Add(_imgChipDel);
        inputPanel.Controls.Add(Input);
        inputPanel.Controls.Add(sendWrap);
        bottom.Controls.Add(inputPanel);
        bottom.Controls.Add(_imgChip);
        bottom.Controls.Add(toolRow);

        Container.Controls.Add(Transcript);
        Container.Controls.Add(bottom);

        Send.Click += (s, e) => { if (Busy) onStop?.Invoke(); else onSend?.Invoke(); };
        Input.AllowDrop = true;
        Input.DragEnter += (s, e) =>
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                var files = (string[])e.Data.GetData(DataFormats.FileDrop);
                if (files.Length > 0 && IsImageFile(files[0])) e.Effect = DragDropEffects.Copy;
            }
        };
        Input.DragDrop += (s, e) =>
        {
            var files = (string[])e.Data.GetData(DataFormats.FileDrop);
            if (files.Length > 0) LoadImage(files[0]);
        };
        Input.KeyDown += (s, e) =>
        {
            if (e.Control && e.KeyCode == Keys.V)
            {
                try
                {
                    if (Clipboard.ContainsImage())
                    {
                        e.SuppressKeyPress = true;
                        LoadClipboardImage();
                        return;
                    }
                }
                catch { }
            }
            if (e.KeyCode == Keys.Enter && !e.Shift && !Busy) { e.SuppressKeyPress = true; onSend?.Invoke(); }
            else if (e.KeyCode == Keys.Escape && !string.IsNullOrEmpty(PendingImage)) { ClearPendingImage(); SetStatus("就绪"); }
        };
    }

    static bool IsImageFile(string path)
    {
        string ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
        return ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" || ext == ".bmp";
    }

    void LoadImage(string path)
    {
        try
        {
            byte[] bytes = System.IO.File.ReadAllBytes(path);
            string ext = System.IO.Path.GetExtension(path).TrimStart('.').ToLowerInvariant();
            if (ext == "jpg") ext = "jpeg";
            string mime = "image/" + ext;
            PendingImage = $"data:{mime};base64," + Convert.ToBase64String(bytes);
            ShowChip(System.IO.Path.GetFileName(path));
            SetStatus($"📎 已附加图片 ({System.IO.Path.GetFileName(path)})，发送时上传，hover × 或 Esc 取消");
        }
        catch (Exception ex) { SetStatus("图片加载失败: " + ex.Message); }
    }

    void LoadClipboardImage()
    {
        try
        {
            var img = Clipboard.GetImage();
            if (img == null) return;
            using (var ms = new System.IO.MemoryStream())
            {
                img.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                PendingImage = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
            }
            ShowChip("剪贴板图片.png");
            SetStatus("📎 已附加剪贴板图片，发送时上传，hover × 或 Esc 取消");
        }
        catch (Exception ex) { SetStatus("图片粘贴失败: " + ex.Message); }
    }

    void ShowChip(string name)
    {
        _imgChipName.Text = name ?? "";
        _imgChip.Visible = true;
    }

    public void ClearPendingImage()
    {
        PendingImage = null;
        _imgChip.Visible = false;
        _imgChipDel.Visible = false;
    }

    public void PopulateModels(List<ModelOption> options, string currentProfileName)
    {
        _modelOptions = options ?? new List<ModelOption>();
        _populating = true;
        ModelBox.Items.Clear();
        int sel = -1;
        for (int i = 0; i < _modelOptions.Count; i++)
        {
            var o = _modelOptions[i];
            ModelBox.Items.Add($"{o.Profile} · {o.Model}");
            if (o.Profile == currentProfileName) sel = i;
        }
        if (sel >= 0) ModelBox.SelectedIndex = sel;
        else if (_modelOptions.Count > 0) { ModelBox.SelectedIndex = 0; ApplyOption(_modelOptions[0]); }
        _populating = false;
    }

    public void SyncApproval(string mode)
    {
        _populating = true;
        ApprovalMode = string.IsNullOrEmpty(mode) ? "ask" : mode;
        ApprovalBox.SelectedIndex = (ApprovalMode == "auto") ? 1 : 0;
        _populating = false;
    }

    void OnModelBoxChanged()
    {
        if (_populating) return;
        int idx = ModelBox.SelectedIndex;
        if (idx < 0 || idx >= _modelOptions.Count) return;
        var opt = _modelOptions[idx];
        if (opt.Profile == ProfileName && opt.Model == Model) return;
        string oldModel = Model;
        string oldProfile = ProfileName;
        ApplyOption(opt);
        // codex 风格：追加 model_switch 标记消息，保留上下文
        Messages.Add(new JsonObject
        {
            ["role"] = "system",
            ["content"] = $"[模型切换: {oldProfile}/{oldModel} → {opt.Profile}/{opt.Model}]。保留全部历史上下文，后续按新模型继续。"
        });
        AppendSys($"[模型切换: {oldProfile}/{oldModel} → {opt.Profile}/{opt.Model}]（上下文保留）");
        _log_model_switch?.Invoke(oldProfile, oldModel, opt.Profile, opt.Model);
    }

    public Action<string, string, string, string> _log_model_switch;

    void ApplyOption(ModelOption opt)
    {
        ProfileName = opt.Profile;
        Model = opt.Model;
        Api?.SetKey(opt.ApiKey);
        Api?.SetBase(opt.BaseUrl);
        DisplayName = _resolveName?.Invoke(opt.Profile) ?? "AI";
    }

    public Func<string, string> _resolveName;

    public void SetBusy(bool b)
    {
        Busy = b;
        Send.Text = b ? "⏹ 停止" : "发送 Enter";
        Send.BackColor = b ? Color.FromArgb(207, 34, 46) : SystemColors.Control;
        Send.ForeColor = b ? Color.White : SystemColors.ControlText;
        Send.Font = new Font(Send.Font, b ? FontStyle.Bold : FontStyle.Regular);
    }

    public string GetAssistantText() => _aiBuf.ToString();

    void Js(string fn, params object[] args)
    {
        try { if (Transcript.Document?.Body != null) Transcript.Document.InvokeScript(fn, args); } catch { }
    }

    public void AppendUser(string text) => Js("appendUser", text ?? "");
    public void AppendSys(string text, bool isErr = false) => Js("appendSys", text ?? "", isErr ? "err" : "");
    public void AppendTool(string name, string args, string result, bool isErr)
        => Js("appendTool", name ?? "", args ?? "", result ?? "", isErr);

    public void AppendUsage(int inputTokens, int outputTokens, string model)
        => Js("appendUsage", inputTokens, outputTokens, model ?? "");

    public void AppendFileCard(string name, string path)
    {
        // 延迟到本轮 AI 发言结束后统一在最下方展示
        _pendingCards.Add((name ?? "", path ?? ""));
    }

    public void FlushFileCards()
    {
        foreach (var (name, path) in _pendingCards)
        {
            if (!System.IO.File.Exists(path)) continue;
            Js("appendFileCard", name, path);
        }
        _pendingCards.Clear();
    }

    public void StartAssistant()
    {
        _aiBuf.Clear();
        _reasonBuf.Clear();
        _aiActive = true;
        _aiCardCreated = false;
    }

    void EnsureCard()
    {
        if (_aiCardCreated) return;
        Js("startAssistant", DisplayName ?? "AI");
        _aiCardCreated = true;
    }

    public void AppendAssistantDelta(string delta)
    {
        if (!_aiActive) StartAssistant();
        EnsureCard();
        _aiBuf.Append(delta);
        Js("appendAssistantText", delta);
    }

    public void AppendReasoningDelta(string delta)
    {
        if (!_aiActive) StartAssistant();
        EnsureCard();
        _reasonBuf.Append(delta);
        Js("appendReasoningText", delta);
    }

    public void AppendAssistantFull(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return; // 纯工具调用轮次无文本，不渲染空卡片
        StartAssistant();
        EnsureCard();
        _aiBuf.Append(text);
        Js("setAssistantMd", Md.ToFragment(text));
        FinishAssistant();
    }

    public void FinishAssistant()
    {
        if (!_aiActive) return;
        _aiActive = false;
        if (!_aiCardCreated) return; // 全程无文本/思考 → 未建卡片，跳过
        if (_reasonBuf.Length > 0) Js("setReasoningMd", Md.ToFragment(_reasonBuf.ToString()));
        Js("setAssistantMd", Md.ToFragment(_aiBuf.ToString()));
        Js("finishAssistant");
        _aiCardCreated = false;
    }

    public void ClearChat() { Js("clearAll"); HistoryRendered = false; }

    public void ScrollToBottom() => Js("scrollBottomDelayed");

    public void SetStatus(string s)
    {
        if (Status == null) return;
        if (Status.InvokeRequired) { Status.BeginInvoke(new Action(() => Status.Text = s)); return; }
        Status.Text = s;
    }

    public void SetTitle(string t)
    {
        Title = t;
        Item?.UpdateTitle(t);
    }

    public void FallbackTitle()
    {
        if (TitleGenerated) return;
        string t = "新会话";
        foreach (var m in Messages)
        {
            if (m["role"]?.GetValue<string>() == "user")
            {
                string c = ExtractUserText(m["content"]);
                int nl = c.IndexOf('\n');
                if (nl > 0) c = c.Substring(0, nl);
                c = c.Trim();
                t = c.Length > 18 ? c.Substring(0, 18) + "…" : c;
                if (string.IsNullOrEmpty(t)) t = "新会话";
                break;
            }
        }
        Title = t;
        Item?.UpdateTitle(t);
    }

    public void UpdateContextBar(int contextWindow, int actualUsed = -1, int toolsTokens = 0, int skillTokens = 0)
    {
        _ctxWindow = contextWindow;
        int systemChars = 0, msgChars = 0;
        foreach (var m in Messages)
        {
            string role = m["role"]?.GetValue<string>() ?? "";
            string text = role == "user" ? ExtractUserText(m["content"]) : (m["content"]?.GetValue<string>() ?? "");
            if (role == "system") systemChars += text.Length;
            else msgChars += text.Length;
        }
        int estSystem = Math.Max(1, systemChars / 4);
        int estMessages = Math.Max(1, msgChars / 4);
        int estTotal = estSystem + toolsTokens + skillTokens + estMessages;
        if (actualUsed > 0)
        {
            double scale = (double)actualUsed / estTotal;
            _ctxSystemTokens = (int)(estSystem * scale);
            _ctxToolsTokens = (int)(toolsTokens * scale);
            _ctxSkillTokens = (int)(skillTokens * scale);
            _ctxMessagesTokens = (int)(estMessages * scale);
            _ctxUsed = actualUsed;
        }
        else
        {
            _ctxSystemTokens = estSystem;
            _ctxToolsTokens = toolsTokens;
            _ctxSkillTokens = skillTokens;
            _ctxMessagesTokens = estMessages;
            _ctxUsed = estTotal;
        }
        _ctxFreeTokens = Math.Max(0, _ctxWindow - _ctxUsed);
        RecomputeCtxFill();
    }

    static string FormatTokens(int n) => n >= 1000 ? (n / 1000.0).ToString("0.0") + "k" : n.ToString();

    void RecomputeCtxFill()
    {
        _ctxPct = _ctxWindow > 0 ? Math.Min(100, _ctxUsed * 100 / _ctxWindow) : 0;
        _ctxArcColor = _ctxPct >= 90 ? Color.FromArgb(225, 95, 95)
                     : _ctxPct >= 70 ? Color.FromArgb(230, 170, 60)
                     : Color.FromArgb(80, 170, 90);
        string tip = _ctxWindow > 0
            ? $"上下文: {FormatTokens(_ctxUsed)} / {FormatTokens(_ctxWindow)} ({_ctxPct}%)\n点击打开详情/压缩"
            : $"上下文: {FormatTokens(_ctxUsed)} tokens (未配置上限)\n点击打开详情/压缩";
        _ctxTip.SetToolTip(_ctxRing, tip);
        TokenLbl.Text = _ctxWindow > 0 ? $"{FormatTokens(_ctxUsed)}/{FormatTokens(_ctxWindow)}" : "";
        try { _ctxRing?.Invalidate(); } catch { }
    }

    public (int used, int window, int pct, int system, int tools, int skills, int messages, int free) GetContextBreakdown()
        => (_ctxUsed, _ctxWindow, _ctxPct, _ctxSystemTokens, _ctxToolsTokens, _ctxSkillTokens, _ctxMessagesTokens, _ctxFreeTokens);

    void PaintCtxRing(System.Drawing.Graphics g)
    {
        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
        int sz = Math.Min(_ctxRing.ClientSize.Width, _ctxRing.ClientSize.Height) - 4;
        if (sz < 6) return;
        var r = new Rectangle((_ctxRing.ClientSize.Width - sz) / 2, (_ctxRing.ClientSize.Height - sz) / 2, sz, sz);
        using (var bg = new Pen(Color.FromArgb(225, 226, 230), 3f))
            g.DrawEllipse(bg, r);
        if (_ctxPct > 0)
        {
            using (var fg = new Pen(_ctxArcColor, 3f))
                g.DrawArc(fg, r, -90f, _ctxPct * 3.6f);
        }
    }

    public void UpdateMeta()
    {
        string wsName = string.IsNullOrEmpty(Workspace) ? "(程序目录)" : System.IO.Path.GetFileName(Workspace.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(wsName)) wsName = Workspace;
        WsBtn.Text = "📁 " + wsName;
        Item?.UpdateSubtitle(LastActive.ToString("MM-dd HH:mm"));
    }

    public void RenderHistory()
    {
        if (Transcript.Document?.Body == null) { _pendingRender = RenderHistoryCore; return; }
        RenderHistoryCore();
    }

    void RenderHistoryCore()
    {
        ClearChat();
        foreach (var m in Messages)
        {
            try
            {
                string role = m["role"]?.GetValue<string>() ?? "";
                if (role == "system") continue;
                if (role == "user") AppendUser(ExtractUserText(m["content"]));
                else if (role == "assistant") AppendAssistantFull(m["content"]?.GetValue<string>() ?? "");
                else if (role == "tool") AppendTool("tool_result", m["tool_call_id"]?.GetValue<string>() ?? "", m["content"]?.GetValue<string>() ?? "", false);
            }
            catch { }
        }
        FlushFileCards();
        Js("scrollBottomDelayed");
        HistoryRendered = true;
    }

    public static string ExtractUserText(JsonNode content)
    {
        if (content == null) return "";
        if (content is JsonArray arr)
        {
            var sb = new StringBuilder();
            foreach (var part in arr)
            {
                if (part?["type"]?.GetValue<string>() == "text")
                    sb.Append(part["text"]?.GetValue<string>() ?? "");
            }
            return sb.ToString();
        }
        try { return content.GetValue<string>(); } catch { return ""; }
    }

    static string SkeletonHtml()
    {
        return @"<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta http-equiv='X-UA-Compatible' content='IE=edge'>
<style>
body{font-family:'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.65;color:#24292f;margin:0;padding:10px 12px;}
.user{display:flex;justify-content:flex-end;margin:8px 0 4px;}
.ub{background:#dcf8c6;color:#0a3d0a;padding:7px 12px;border-radius:12px 12px 4px 12px;max-width:80%;white-space:pre-wrap;display:inline-block;}
.ai{margin:8px 0;border:1px solid #d0d7de;border-radius:8px;background:#fff;overflow:hidden;} .ai b{color:#0969da;}
.ai .ai-hd{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f6f8fa;border-bottom:1px solid #eaeef2;}
.ai .ai-av{font-size:14px;line-height:1;} .ai .ai-nm{font-weight:bold;color:#0969da;font-size:14px;}
.ai .ai-bd{padding:8px 12px;min-height:8px;}
.ai p{margin:4px 0;}
.ai h1{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:3px;margin:10px 0 4px;}
.ai h2{font-size:16px;margin:8px 0 3px;} .ai h3{font-size:14px;margin:6px 0 2px;}
.ai code{background:#f0f0f0;padding:1px 5px;border-radius:3px;font-family:Consolas;font-size:13px;}
.ai pre{background:#f6f8fa;padding:10px;border-radius:5px;overflow:auto;font-family:Consolas;font-size:12px;}
.ai ul{margin:4px 0;padding-left:22px;}
.ai blockquote{border-left:3px solid #d0d7de;color:#57606a;margin:6px 0;padding:2px 12px;}
.ai hr{border:none;border-top:1px solid #d0d7de;margin:8px 0;}
.ai table{border-collapse:collapse;margin:8px 0;font-size:13px;} .ai th,.ai td{border:1px solid #d0d7de;padding:5px 9px;text-align:left;vertical-align:top;} .ai th{background:#f6f8fa;font-weight:bold;} .ai tbody tr:nth-child(even){background:#fbfcfd;}
.reasoning{margin:2px 0 6px;}
.rh{cursor:pointer;color:#8b949e;font-style:italic;font-size:12px;padding:2px 0;user-select:none;} .rh:hover{color:#586069;}
.rb{border-left:2px solid #d0d7de;padding:4px 10px;margin:2px 0 6px;font-size:12.5px;color:#8b949e;font-style:italic;display:none;}
.rb p{margin:3px 0;}
.tool{background:#f6f8fa;border-left:3px solid #8957e5;padding:6px 10px;margin:4px 0;font-family:Consolas;font-size:12px;color:#57606a;border-radius:0 4px 4px 0;}
.tool code{background:#eaeef2;padding:1px 4px;border-radius:2px;}
.th{cursor:pointer;font-weight:bold;color:#57606a;user-select:none;} .th:hover{color:#8957e5;}
.tb{margin-top:4px;display:none;} .tbr{margin-top:2px;}
.filecard{display:flex;align-items:center;gap:8px;border:1px solid #d0d7de;border-radius:6px;padding:8px 12px;margin:6px 0;background:#fff;cursor:pointer;}
.filecard:hover{background:#f6f8fa;border-color:#8957e5;}
.filecard .fi{font-size:18px;} .filecard .fn{font-weight:bold;color:#24292f;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;} .filecard .fo{color:#8957e5;font-size:12px;}
.sys{color:#0969da;margin:6px 0;font-size:13px;} .sys.err{color:#cf222e;}
.tool .err{color:#cf222e;font-weight:bold;}
.usage{color:#8b949e;font-size:11px;font-family:Consolas;text-align:right;margin:2px 0 8px;}
</style></head><body>
<div id='t'></div>
<script>
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function mk(tag,cls){var e=document.createElement(tag); if(cls) e.className=cls; return e;}
function addNode(n){var t=document.getElementById('t'); t.appendChild(n); scrollBottomDelayed();}
function scroll(){ var h=document.documentElement.scrollHeight||document.body.scrollHeight; window.scrollTo(0,h); }
var _scrollTimer=null;
function scheduleScroll(){ if(_scrollTimer) return; _scrollTimer=setTimeout(function(){ _scrollTimer=null; scrollBottom(); }, 50); }
var _aiText='', _aiShown=0, _aiTimer=null;
function _aiReset(){ if(_aiTimer){ clearInterval(_aiTimer); _aiTimer=null; } _aiText=''; _aiShown=0; }
function _aiTick(){
  var b=document.getElementById('aibody'); if(!b){ if(_aiTimer){ clearInterval(_aiTimer); _aiTimer=null; } return; }
  var rem=_aiText.length-_aiShown;
  if(rem>0){
    var step=Math.max(2,Math.ceil(rem/8));
    var next=_aiShown+step; if(next>_aiText.length) next=_aiText.length;
    b.appendChild(document.createTextNode(_aiText.substring(_aiShown,next)));
    _aiShown=next;
    scheduleScroll();
  } else if(_aiTimer){ clearInterval(_aiTimer); _aiTimer=null; }
}
function appendUser(t){var d=mk('div','user'); var b=mk('div','ub'); b.textContent=t; d.appendChild(b); addNode(d);}
function appendSys(t,cls){var d=mk('div','sys '+(cls||'')); d.textContent=t; addNode(d);}
function appendTool(name,args,result,isErr){var d=mk('div','tool'); var html='<b>[工具]</b> '+esc(name)+' <code>'+esc(args)+'</code><br>&rarr; '; if(isErr) html+='<span class=err>ERR</span> '; html+=esc(result); d.innerHTML=html; addNode(d);}
function startAssistant(name){ _aiReset(); var d=mk('div','ai'); d.id='aicur';
  var hd=mk('div','ai-hd'); var av=mk('span','ai-av'); av.textContent='\ud83e\udd16'; var nm=mk('span','ai-nm'); nm.textContent=name||'AI'; hd.appendChild(av); hd.appendChild(nm); d.appendChild(hd);
  var body=mk('div','ai-bd'); body.id='aibody'; d.appendChild(body);
  var r=mk('div','reasoning'); r.id='aireason'; r.style.display='none';
  var rh=mk('div','rh'); rh.textContent='\u25b6 思考'; rh.onclick=function(){toggleR(this);};
  var rb=mk('div','rb'); rb.style.display='none';
  r.appendChild(rh); r.appendChild(rb); d.appendChild(r);
  addNode(d);}
function toggleR(h){var rb=h.parentNode.querySelector('.rb'); if(rb){var open=rb.style.display!='none'; rb.style.display=open?'none':'block'; h.textContent=(open?'\u25b6':'\u25bc')+' 思考';} scroll();}
function appendReasoningText(t){var rb=document.querySelector('#aireason .rb'); if(rb){rb.appendChild(document.createTextNode(t)); var r=document.getElementById('aireason'); if(r)r.style.display='block';} scheduleScroll();}
function appendAssistantText(t){ _aiText+=t; if(!_aiTimer){ _aiTimer=setInterval(_aiTick,16); } }
function setReasoningMd(html){var rb=document.querySelector('#aireason .rb'); if(rb)rb.innerHTML=html;}
function setAssistantMd(html){ _aiReset(); var b=document.getElementById('aibody'); if(b)b.innerHTML=html; scheduleScroll();}
function finishAssistant(){ _aiReset(); var b=document.getElementById('aibody'); if(b)b.removeAttribute('id'); var r=document.getElementById('aireason'); if(r)r.removeAttribute('id'); var c=document.getElementById('aicur'); if(c)c.removeAttribute('id'); scrollBottomDelayed();}
function appendUsage(inp,out,model){var c=document.getElementById('aicur'); if(c){var u=mk('div','usage'); u.textContent=(model?model+' · ':'')+'\u2191'+inp+' \u2193'+out; c.appendChild(u);} scroll();}
function appendTool(name,args,result,isErr){var d=mk('div','tool'); var h=mk('div','th'); h.textContent='[工具] '+name+(isErr?' \u2717':' \u2713'); h.onclick=function(){toggleT(this);}; var b=mk('div','tb'); b.style.display='none'; b.innerHTML='<code>'+esc(args)+'</code><div class=tbr>&rarr; '+(isErr?'<span class=err>ERR</span> ':'')+esc(result)+'</div>'; d.appendChild(h); d.appendChild(b); addNode(d);}
function toggleT(h){var b=h.nextSibling; if(b){var open=b.style.display!='none'; b.style.display=open?'none':'block';}}
function appendFileCard(name,path){var d=mk('div','filecard'); d.innerHTML='<span class=fi>\ud83d\udcc4</span><div class=fn>'+esc(name)+'</div><div class=fo>点击打开</div>'; d.onclick=function(){if(window.external)window.external.openPath(path);}; addNode(d);}
function scrollBottom(){ var h=document.documentElement.scrollHeight||document.body.scrollHeight; window.scrollTo(0,h); try{document.documentElement.scrollTop=h;document.body.scrollTop=h;}catch(e){} }
function scrollBottomDelayed(){setTimeout(scrollBottom,60); setTimeout(scrollBottom,250);}
function clearAll(){document.getElementById('t').innerHTML='';}
</script>
</body></html>";
    }
}

public class SessionItem : Panel
{
    public ChatSession Session;
    Label _title;
    Label _sub;
    Button _del;
    Panel _accent;
    bool _selected;
    TextBox _renameBox;
    ToolTip _tip = new ToolTip { InitialDelay = 150, ReshowDelay = 100, AutoPopDelay = 8000 };
    static readonly Color _bg = Color.FromArgb(250, 250, 252);
    static readonly Color _hover = Color.FromArgb(238, 242, 252);
    static readonly Color _sel = Color.FromArgb(220, 233, 255);
    static readonly Color _accentColor = Color.FromArgb(60, 110, 220);

    public Action<SessionItem> OnSelect;
    public Action<SessionItem> OnDelete;

    public SessionItem(ChatSession s)
    {
        Session = s;
        Dock = DockStyle.Top;
        Height = 52;
        Margin = new Padding(0);
        BackColor = _bg;
        Cursor = Cursors.Hand;

        _accent = new Panel { Dock = DockStyle.Left, Width = 4, BackColor = _accentColor, Visible = false };
        _del = new Button
        {
            Text = "×", Dock = DockStyle.Right, Width = 28,
            FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(225, 95, 95), ForeColor = Color.White,
            Font = new Font("Segoe UI", 12f, FontStyle.Bold), Cursor = Cursors.Hand,
            Visible = false, TextAlign = ContentAlignment.MiddleCenter
        };
        _del.FlatAppearance.BorderSize = 0;
        _del.FlatAppearance.MouseOverBackColor = Color.FromArgb(200, 60, 60);
        var content = new Panel { Dock = DockStyle.Fill };
        _title = new Label
        {
            Text = s.Title, Dock = DockStyle.Fill, AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Microsoft YaHei", 10f),
            Padding = new Padding(8, 2, 4, 0), Cursor = Cursors.Hand
        };
        _sub = new Label
        {
            Dock = DockStyle.Bottom, Height = 16, AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Microsoft YaHei", 8f),
            ForeColor = Color.Gray, Padding = new Padding(8, 0, 4, 2), Cursor = Cursors.Hand
        };
        content.Controls.Add(_title);
        content.Controls.Add(_sub);
        Controls.Add(content);
        Controls.Add(_del);
        Controls.Add(_accent);
        _tip.SetToolTip(_title, s.Title ?? "");
        _tip.SetToolTip(_sub, s.Title ?? "");

        void AnyClick(object sender, EventArgs e) { if (_renameBox == null) OnSelect?.Invoke(this); };
        Click += AnyClick;
        _title.Click += AnyClick;
        _sub.Click += AnyClick;
        content.Click += AnyClick;
        _title.DoubleClick += (sender, e) => StartRename();
        _del.Click += (sender, e) => OnDelete?.Invoke(this);
    }

    bool _hovered;
    public bool Hovered
    {
        get => _hovered;
        set
        {
            if (_hovered == value) return;
            _hovered = value;
            UpdateVisual();
        }
    }

    void UpdateVisual()
    {
        if (_renameBox != null) return;
        bool showDel = _hovered && _renameBox == null;
        _del.Visible = showDel;
        var c = _selected ? _sel : (_hovered ? _hover : _bg);
        BackColor = c;
        _title.BackColor = c;
        _sub.BackColor = c;
    }

    public bool Selected
    {
        get => _selected;
        set { _selected = value; _accent.Visible = value; _title.Font = new Font(_title.Font, value ? FontStyle.Bold : FontStyle.Regular); UpdateVisual(); }
    }

    public void UpdateTitle(string t) { _title.Text = t; _tip.SetToolTip(_title, t ?? ""); _tip.SetToolTip(_sub, t ?? ""); }
    public void UpdateSubtitle(string s) { _sub.Text = s; }

    void StartRename()
    {
        if (_renameBox != null) return;
        _del.Visible = false;
        _renameBox = new TextBox
        {
            Text = Session.Title, Dock = DockStyle.Fill,
            Font = _title.Font, BorderStyle = BorderStyle.FixedSingle,
            Margin = new Padding(6, 4, 30, 4)
        };
        Controls.Add(_renameBox);
        _renameBox.BringToFront();
        _renameBox.Focus();
        _renameBox.SelectAll();
        _renameBox.KeyDown += (s, e) =>
        {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; CommitRename(); }
            else if (e.KeyCode == Keys.Escape) CancelRename();
        };
        _renameBox.LostFocus += (s, e) => CommitRename();
    }

    void CommitRename()
    {
        if (_renameBox == null) return;
        string t = _renameBox.Text.Trim();
        Controls.Remove(_renameBox);
        _renameBox = null;
        if (!string.IsNullOrEmpty(t) && t != Session.Title)
        {
            Session.Title = t;
            _title.Text = t;
            _tip.SetToolTip(_title, t);
            _tip.SetToolTip(_sub, t);
        }
        UpdateVisual();
    }

    void CancelRename()
    {
        if (_renameBox == null) return;
        Controls.Remove(_renameBox);
        _renameBox = null;
        UpdateVisual();
    }
}
