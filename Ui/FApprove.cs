using System;
using System.Drawing;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace RanParty.Ui;

public enum ApproveAction { Execute, AllowExact, AllowPrefix, Decline, DeclineFeedback }

// codex 风格命令审批：意图 + 可编辑命令 + 执行/放行此命令/放行前缀/拒绝(+反馈)
public class FApprove : Form
{
    public ApproveAction Action;
    public string EditedCommand = "";
    public string Feedback = "";

    TextBox _cmd;
    TextBox _feedback;
    Button _btnPrefix;

    public FApprove(string tool, JsonNode args, string reason)
    {
        Text = "命令审批 · " + tool;
        ClientSize = new Size(600, 360);
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(252, 252, 252);

        var warn = new Label
        {
            Text = "⚠ AI 请求执行以下命令。可先编辑再批准，或拒绝并反馈。",
            Dock = DockStyle.Top, Height = 26, ForeColor = Color.FromArgb(180, 80, 20),
            Font = new Font("Microsoft YaHei", 9f, FontStyle.Bold), Padding = new Padding(10, 8, 10, 0)
        };

        var reasonBox = new Panel { Dock = DockStyle.Top, Height = 44, Padding = new Padding(10, 4, 10, 4), Visible = !string.IsNullOrWhiteSpace(reason) };
        var reasonLbl = new Label
        {
            Text = "意图: " + (reason ?? ""),
            Dock = DockStyle.Fill, AutoEllipsis = false,
            ForeColor = Color.FromArgb(90, 90, 120), Font = new Font("Microsoft YaHei", 9f, FontStyle.Italic)
        };
        reasonBox.Controls.Add(reasonLbl);

        var workdir = args?["workdir"]?.GetValue<string>() ?? "";
        var wdLbl = new Label
        {
            Text = "工作目录: " + (string.IsNullOrEmpty(workdir) ? "(程序目录)" : workdir),
            Dock = DockStyle.Top, Height = 20, ForeColor = Color.Gray,
            Font = new Font("Consolas", 9f), Padding = new Padding(10, 0, 10, 0)
        };

        _cmd = new TextBox
        {
            Dock = DockStyle.Top, Multiline = true, ScrollBars = ScrollBars.Vertical, Height = 140,
            Font = new Font("Consolas", 10f), BackColor = Color.FromArgb(30, 30, 30), ForeColor = Color.FromArgb(230, 230, 230),
            BorderStyle = BorderStyle.FixedSingle, AcceptsTab = true
        };
        _cmd.Text = BuildCommand(tool, args);
        _cmd.TextChanged += (s, e) => UpdatePrefixLabel();

        var fbLbl = new Label { Text = "反馈（可选，填了则回灌给 AI 让它换方式）", Dock = DockStyle.Top, Height = 18, ForeColor = Color.Gray, Font = new Font("Microsoft YaHei", 8.5f), Padding = new Padding(10, 4, 10, 0) };
        _feedback = new TextBox { Dock = DockStyle.Top, Height = 26, Font = new Font("Microsoft YaHei", 9f), Padding = new Padding(10, 0, 10, 0) };

        var btnRow = new Panel { Dock = DockStyle.Top, Height = 46, Padding = new Padding(10, 8, 10, 8) };
        var deny = MkBtn("拒绝", 80, Color.FromArgb(235, 235, 235), Color.FromArgb(60, 60, 60));
        _btnPrefix = MkBtn("放行前缀", 110, Color.FromArgb(80, 110, 200), Color.White);
        var allowExact = MkBtn("放行此命令", 120, Color.FromArgb(80, 110, 200), Color.White);
        var ok = MkBtn("执行", 80, Color.FromArgb(60, 130, 60), Color.White, bold: true);
        deny.Left = 10; _btnPrefix.Left = 100; allowExact.Left = 220; ok.Left = 510;
        deny.Click += (s, e) => { Action = string.IsNullOrWhiteSpace(_feedback.Text) ? ApproveAction.Decline : ApproveAction.DeclineFeedback; Feedback = _feedback.Text.Trim(); DialogResult = DialogResult.Cancel; Close(); };
        _btnPrefix.Click += (s, e) => { Action = ApproveAction.AllowPrefix; EditedCommand = _cmd.Text; DialogResult = DialogResult.OK; Close(); };
        allowExact.Click += (s, e) => { Action = ApproveAction.AllowExact; EditedCommand = _cmd.Text; DialogResult = DialogResult.OK; Close(); };
        ok.Click += (s, e) => { Action = ApproveAction.Execute; EditedCommand = _cmd.Text; DialogResult = DialogResult.OK; Close(); };
        btnRow.Controls.Add(ok);
        btnRow.Controls.Add(allowExact);
        btnRow.Controls.Add(_btnPrefix);
        btnRow.Controls.Add(deny);

        Controls.Add(btnRow);
        Controls.Add(_feedback);
        Controls.Add(fbLbl);
        Controls.Add(_cmd);
        Controls.Add(wdLbl);
        Controls.Add(reasonBox);
        Controls.Add(warn);

        AcceptButton = ok;
        CancelButton = deny;
        UpdatePrefixLabel();
    }

    Button MkBtn(string t, int w, Color bg, Color fg, bool bold = false)
    {
        var b = new Button { Text = t, Top = 8, Width = w, Height = 30, FlatStyle = FlatStyle.Flat, BackColor = bg, ForeColor = fg, Font = new Font("Microsoft YaHei", 9f, bold ? FontStyle.Bold : FontStyle.Regular) };
        b.FlatAppearance.BorderSize = 0;
        return b;
    }

    void UpdatePrefixLabel()
    {
        string prefix = PrefixOf(_cmd.Text);
        _btnPrefix.Text = string.IsNullOrEmpty(prefix) ? "放行前缀" : $"放行 `{prefix}` 前缀";
    }

    public static string PrefixOf(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return "";
        var trimmed = command.TrimStart();
        int sp = trimmed.IndexOfAny(new[] { ' ', '\t', '|', '&', ';', '>' });
        string p = sp < 0 ? trimmed : trimmed.Substring(0, sp);
        return p.Length > 24 ? p.Substring(0, 24) : p;
    }

    string BuildCommand(string tool, JsonNode args)
    {
        string S(string k) => args?[k]?.GetValue<string>() ?? "";
        if (tool == "open_url") return S("url");
        return S("command");
    }
}
