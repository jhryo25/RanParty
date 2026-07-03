using System;
using System.Drawing;
using System.Windows.Forms;
using RanParty.Core;

namespace RanParty.Ui;

public class ContextWindowForm : Form
{
    public int NewContextThreshold;
    public int NewContextWindow;
    public bool CompactRequested;

    ChatSession _s;
    Config _cfg;
    TextBox _thresholdBox;
    TextBox _windowBox;

    public ContextWindowForm(ChatSession s, Config cfg, Action onCompact)
    {
        _s = s;
        _cfg = cfg;
        NewContextThreshold = s.ContextThreshold;
        NewContextWindow = s.ContextWindow > 0 ? s.ContextWindow : cfg.ContextWindow;

        Text = "上下文窗口";
        ClientSize = new Size(520, 520);
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(250, 250, 252);
        Padding = new Padding(16);

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var (used, window, pct, system, tools, skills, messages, free) = s.GetContextBreakdown();
        int threshold = s.ContextThreshold > 0 ? s.ContextThreshold : cfg.CompactThreshold;
        int effectiveWindow = s.ContextWindow > 0 ? s.ContextWindow : cfg.ContextWindow;

        // header
        var header = new Panel { Dock = DockStyle.Top, Height = 70 };
        var pctLbl = new Label
        {
            Text = $"{pct}%",
            Font = new Font("Microsoft YaHei", 28f, FontStyle.Bold),
            ForeColor = pct >= 90 ? Color.FromArgb(225, 95, 95) : pct >= 70 ? Color.FromArgb(230, 170, 60) : Color.FromArgb(80, 170, 90),
            AutoSize = true,
            Location = new Point(0, 0)
        };
        var sub = new Label
        {
            Text = $"{FormatTokens(used)} / {FormatTokens(window)}  使用/上限\n已用上下文 · 达到 {threshold}% 自动触发总结",
            Font = new Font("Microsoft YaHei", 9f),
            ForeColor = Color.FromArgb(110, 110, 120),
            AutoSize = true,
            Location = new Point(110, 12)
        };
        header.Controls.Add(pctLbl);
        header.Controls.Add(sub);
        root.Controls.Add(header, 0, 0);

        // category list
        var list = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        int y = 0;
        void AddRow(string name, int value, int total, Color color)
        {
            int p = total > 0 ? (int)((long)value * 100 / total) : 0;
            var row = new Panel { Width = 470, Height = 40, Location = new Point(0, y) };
            var dot = new Panel { Width = 10, Height = 10, Location = new Point(0, 8), BackColor = color };
            var nameLbl = new Label { Text = name, Location = new Point(18, 6), Width = 120, Font = new Font("Microsoft YaHei", 9f), ForeColor = Color.FromArgb(60, 60, 70) };
            var valLbl = new Label { Text = $"{FormatTokens(value)} ({p}%)", Location = new Point(145, 6), Width = 120, Font = new Font("Consolas", 9f), ForeColor = Color.FromArgb(90, 90, 100) };
            var bar = new Panel { Width = 190, Height = 6, Location = new Point(280, 12), BackColor = Color.FromArgb(230, 230, 234) };
            var fill = new Panel { Width = Math.Max(0, Math.Min(190, 190 * p / 100)), Height = 6, Location = new Point(0, 0), BackColor = color };
            bar.Controls.Add(fill);
            row.Controls.Add(dot);
            row.Controls.Add(nameLbl);
            row.Controls.Add(valLbl);
            row.Controls.Add(bar);
            list.Controls.Add(row);
            y += 42;
        }
        int denom = Math.Max(1, window);
        AddRow("System prompt", system, denom, Color.FromArgb(170, 150, 220));
        AddRow("System tools", tools, denom, Color.FromArgb(90, 140, 240));
        AddRow("Skill tokens", skills, denom, Color.FromArgb(240, 150, 50));
        AddRow("Messages", messages, denom, Color.FromArgb(60, 180, 130));
        AddRow("Free space", free, denom, Color.FromArgb(180, 180, 190));
        root.Controls.Add(list, 0, 1);

        // editors
        var editPanel = new Panel { Dock = DockStyle.Top, Height = 72 };
        var windowRow = new Panel { Width = 488, Height = 34, Location = new Point(0, 0) };
        windowRow.Controls.Add(new Label { Text = "上下文窗口上限 (tokens):", Width = 150, Location = new Point(0, 6), Font = new Font("Microsoft YaHei", 9f) });
        _windowBox = new TextBox { Text = effectiveWindow.ToString(), Width = 90, Location = new Point(160, 3), Font = new Font("Consolas", 9f) };
        var useGlobalWindow = new Button { Text = "使用全局", Width = 80, Location = new Point(260, 2), FlatStyle = FlatStyle.Flat, Font = new Font("Microsoft YaHei", 8.5f) };
        useGlobalWindow.FlatAppearance.BorderSize = 0;
        useGlobalWindow.Click += (a, b) => _windowBox.Text = cfg.ContextWindow.ToString();
        windowRow.Controls.Add(_windowBox);
        windowRow.Controls.Add(useGlobalWindow);
        editPanel.Controls.Add(windowRow);

        var thRow = new Panel { Width = 488, Height = 34, Location = new Point(0, 36) };
        thRow.Controls.Add(new Label { Text = "该会话触发阈值 (%):", Width = 150, Location = new Point(0, 6), Font = new Font("Microsoft YaHei", 9f) });
        _thresholdBox = new TextBox { Text = threshold.ToString(), Width = 90, Location = new Point(160, 3), Font = new Font("Consolas", 9f) };
        var useGlobalTh = new Button { Text = "使用全局", Width = 80, Location = new Point(260, 2), FlatStyle = FlatStyle.Flat, Font = new Font("Microsoft YaHei", 8.5f) };
        useGlobalTh.FlatAppearance.BorderSize = 0;
        useGlobalTh.Click += (a, b) => _thresholdBox.Text = cfg.CompactThreshold.ToString();
        thRow.Controls.Add(_thresholdBox);
        thRow.Controls.Add(useGlobalTh);
        editPanel.Controls.Add(thRow);
        root.Controls.Add(editPanel, 0, 2);

        // buttons
        var btnRow = new Panel { Dock = DockStyle.Top, Height = 42 };
        var compactBtn = new Button
        {
            Text = "压缩当前会话",
            Width = 120,
            Height = 32,
            Location = new Point(0, 5),
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(60, 130, 60),
            ForeColor = Color.White,
            Font = new Font("Microsoft YaHei", 9f),
            Enabled = !s.Busy
        };
        compactBtn.FlatAppearance.BorderSize = 0;
        compactBtn.Click += (a, b) =>
        {
            ReadValues();
            CompactRequested = true;
            onCompact?.Invoke();
            DialogResult = DialogResult.OK;
            Close();
        };
        var closeBtn = new Button { Text = "关闭", Width = 80, Height = 32, Location = new Point(130, 5), FlatStyle = FlatStyle.Flat, Font = new Font("Microsoft YaHei", 9f) };
        closeBtn.FlatAppearance.BorderSize = 0;
        closeBtn.Click += (a, b) =>
        {
            ReadValues();
            DialogResult = DialogResult.Cancel;
            Close();
        };
        btnRow.Controls.Add(compactBtn);
        btnRow.Controls.Add(closeBtn);
        root.Controls.Add(btnRow, 0, 3);

        Controls.Add(root);
    }

    void ReadValues()
    {
        if (int.TryParse(_thresholdBox.Text, out var t) && t > 0 && t <= 100) NewContextThreshold = t;
        if (int.TryParse(_windowBox.Text, out var w) && w > 1000) NewContextWindow = w;
    }

    static string FormatTokens(int n) => n >= 1000 ? (n / 1000.0).ToString("0.0") + "k" : n.ToString();
}
