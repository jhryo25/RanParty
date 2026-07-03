using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace RanParty.Ui;

// 角色卡 MD 文档结构：# 标题 + > 描述 + 多个 ## 节
public class CardDoc
{
    public string Title = "";
    public string Description = "";
    public List<(string head, string body)> Sections = new();
    public string Tail = "";

    public static CardDoc Parse(string md)
    {
        var d = new CardDoc();
        if (string.IsNullOrEmpty(md)) return d;
        var lines = md.Replace("\r\n", "\n").Split('\n');
        int i = 0;
        // 兼容旧版 <!-- @name: xxx --> 前置注释：跳过，若标题为空则迁移为标题
        string legacyName = null;
        while (i < lines.Length && string.IsNullOrWhiteSpace(lines[i])) i++;
        if (i < lines.Length)
        {
            string nm = ExtractLegacyName(lines[i]);
            if (nm != null) { legacyName = nm; i++; }
        }
        while (i < lines.Length && string.IsNullOrWhiteSpace(lines[i])) i++;
        if (i < lines.Length && lines[i].StartsWith("# ") && !lines[i].StartsWith("## "))
        {
            d.Title = lines[i].Substring(2).Trim();
            i++;
        }
        else if (!string.IsNullOrWhiteSpace(legacyName)) d.Title = legacyName.Trim();
        var desc = new List<string>();
        while (i < lines.Length && lines[i].StartsWith(">"))
        {
            string l = lines[i];
            if (l.StartsWith("> ")) l = l.Substring(2); else if (l.StartsWith(">")) l = l.Substring(1);
            desc.Add(l);
            i++;
        }
        d.Description = string.Join("\n", desc).Trim();
        while (i < lines.Length && string.IsNullOrWhiteSpace(lines[i])) i++;

        while (i < lines.Length)
        {
            if (lines[i].StartsWith("## "))
            {
                string h = lines[i].Substring(3).Trim();
                i++;
                var body = new List<string>();
                while (i < lines.Length && !lines[i].StartsWith("## "))
                {
                    body.Add(lines[i]);
                    i++;
                }
                while (body.Count > 0 && string.IsNullOrWhiteSpace(body[body.Count - 1])) body.RemoveAt(body.Count - 1);
                d.Sections.Add((h, string.Join("\n", body)));
            }
            else
            {
                var buf = new List<string>();
                while (i < lines.Length && !lines[i].StartsWith("## "))
                {
                    buf.Add(lines[i]);
                    i++;
                }
                if (d.Sections.Count == 0 && string.IsNullOrEmpty(d.Description))
                    d.Description = string.Join("\n", buf).Trim();
                else
                    d.Tail += string.Join("\n", buf) + "\n";
            }
        }
        return d;
    }

    public string Serialize()
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(Title)) sb.Append("# ").Append(Title.Trim()).Append("\n\n");
        if (!string.IsNullOrWhiteSpace(Description))
        {
            foreach (var l in Description.Replace("\r\n", "\n").Split('\n'))
                sb.Append("> ").Append(l).Append("\n");
            sb.Append("\n");
        }
        foreach (var (h, b) in Sections)
        {
            sb.Append("## ").Append(h.Trim()).Append("\n");
            if (!string.IsNullOrEmpty(b)) sb.Append(b.TrimEnd('\n', '\r')).Append("\n");
            sb.Append("\n");
        }
        if (!string.IsNullOrEmpty(Tail)) sb.Append(Tail);
        return sb.ToString();
    }

    static string ExtractLegacyName(string line)
    {
        if (line == null) return null;
        string s = line.Trim();
        if (!s.StartsWith("<!--") || !s.EndsWith("-->")) return null;
        s = s.Substring(4, s.Length - 7).Trim();
        string prefix = "@name:";
        if (s.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            return s.Substring(prefix.Length);
        return null;
    }
}

// 单个 ## 节的编辑器：标题输入 + 正文输入 + 删除节
public class SectionEditor : UserControl
{
    public TextBox Head;
    public TextBox Body;
    Button _del;
    public Action<SectionEditor> OnDelete;
    public Action OnChanged;

    public SectionEditor(string head, string body)
    {
        Height = 140;
        Margin = new Padding(2, 4, 2, 0);
        BackColor = Color.FromArgb(252, 252, 252);

        var headWrap = new Panel { Dock = DockStyle.Top, Height = 30, Padding = new Padding(0, 0, 2, 2) };
        Head = new TextBox { Text = head, Dock = DockStyle.Fill, Font = new Font("Microsoft YaHei", 11f, FontStyle.Bold), BorderStyle = BorderStyle.FixedSingle };
        _del = new Button { Text = "×", Dock = DockStyle.Right, Width = 28, FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(225, 90, 90), ForeColor = Color.White, Font = new Font("Segoe UI", 12f, FontStyle.Bold), Cursor = Cursors.Hand };
        _del.FlatAppearance.BorderSize = 0;
        _del.FlatAppearance.MouseOverBackColor = Color.FromArgb(200, 60, 60);
        headWrap.Controls.Add(Head);
        headWrap.Controls.Add(_del);

        Body = new TextBox { Text = body, Dock = DockStyle.Fill, Multiline = true, ScrollBars = ScrollBars.Vertical, Font = new Font("Consolas", 10f), AcceptsTab = true, BorderStyle = BorderStyle.FixedSingle };

        Controls.Add(Body);
        Controls.Add(headWrap);

        _del.Click += (s, e) => OnDelete?.Invoke(this);
        Head.TextChanged += (s, e) => OnChanged?.Invoke();
        Body.TextChanged += (s, e) => OnChanged?.Invoke();
    }
}
