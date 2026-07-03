using System.Text;
using System.Text.RegularExpressions;

namespace RanParty.Tools;

public static class Md
{
    public static string ToHtml(string md)
    {
        var sb = new StringBuilder();
        sb.Append("<html><head><meta charset='utf-8'><meta http-equiv='X-UA-Compatible' content='IE=edge'><style>");
        sb.Append(Style());
        sb.Append("</style></head><body>");
        sb.Append(ToFragment(md));
        sb.Append("</body></html>");
        return sb.ToString();
    }

    public static string ToFragment(string md)
    {
        var s = (md ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        var sb = new StringBuilder();
        var lines = s.Replace("\r\n", "\n").Split('\n');
        bool inUl = false, inPre = false;
        for (int i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (line.StartsWith("```")) { inPre = !inPre; sb.Append(inPre ? "<pre>" : "</pre>"); continue; }
            if (inPre) { sb.Append(line).Append("\n"); continue; }
            // GFM 表格：当前行含 | 且下一行为分隔符 |---|
            if (line.Contains("|") && i + 1 < lines.Length && IsSeparator(lines[i + 1]))
            {
                CloseUl();
                var aligns = SplitRow(lines[i + 1]).ConvertAll(Align);
                sb.Append("<table><thead><tr>");
                var hdr = SplitRow(line);
                for (int c = 0; c < hdr.Count; c++)
                    sb.Append("<th").Append(AlignStyle(aligns, c)).Append(">").Append(Inline(hdr[c])).Append("</th>");
                sb.Append("</tr></thead><tbody>");
                i += 2;
                while (i < lines.Length && lines[i].Contains("|") && lines[i].Trim() != "")
                {
                    var row = SplitRow(lines[i]);
                    sb.Append("<tr>");
                    for (int c = 0; c < row.Count; c++)
                        sb.Append("<td").Append(AlignStyle(aligns, c)).Append(">").Append(Inline(row[c])).Append("</td>");
                    sb.Append("</tr>");
                    i++;
                }
                i--;
                sb.Append("</tbody></table>");
                continue;
            }
            if (line.StartsWith("# ")) { CloseUl(); sb.Append("<h1>").Append(Inline(line[2..])).Append("</h1>"); continue; }
            if (line.StartsWith("## ")) { CloseUl(); sb.Append("<h2>").Append(Inline(line[3..])).Append("</h2>"); continue; }
            if (line.StartsWith("### ")) { CloseUl(); sb.Append("<h3>").Append(Inline(line[4..])).Append("</h3>"); continue; }
            if (line.StartsWith("- ") || line.StartsWith("* ")) { if (!inUl) { sb.Append("<ul>"); inUl = true; } sb.Append("<li>").Append(Inline(line[2..])).Append("</li>"); continue; }
            if (line.StartsWith("> ")) { CloseUl(); sb.Append("<blockquote>").Append(Inline(line[2..])).Append("</blockquote>"); continue; }
            if (line.Trim() == "---") { CloseUl(); sb.Append("<hr>"); continue; }
            if (line.Trim() == "") { CloseUl(); sb.Append("<br>"); continue; }
            CloseUl();
            sb.Append("<p>").Append(Inline(line)).Append("</p>");
        }
        CloseUl();
        if (inPre) sb.Append("</pre>");
        return sb.ToString();

        void CloseUl() { if (inUl) { sb.Append("</ul>"); inUl = false; } }
    }

    static List<string> SplitRow(string line)
    {
        line = line.Trim();
        if (line.StartsWith("|")) line = line[1..];
        if (line.EndsWith("|")) line = line[..^1];
        var cells = new List<string>();
        foreach (var c in line.Split('|')) cells.Add(c.Trim());
        return cells;
    }

    static bool IsSeparator(string line)
    {
        var t = line.Trim();
        if (!t.Contains("|") || !t.Contains("-")) return false;
        return t.Replace("|", "").Replace(":", "").Replace("-", "").Replace(" ", "") == "";
    }

    static string Align(string sepCell)
    {
        bool left = sepCell.StartsWith(":");
        bool right = sepCell.EndsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
    }

    static string AlignStyle(List<string> aligns, int c)
    {
        if (c < aligns.Count && aligns[c] != "left") return " style='text-align:" + aligns[c] + "'";
        return "";
    }

    static string Style() =>
        "body{font-family:'Microsoft YaHei',sans-serif;padding:14px;font-size:14px;line-height:1.7;color:#222}" +
        "h1{font-size:21px;border-bottom:2px solid #ddd;padding-bottom:4px} h2{font-size:18px} h3{font-size:15px}" +
        "code{background:#eee;padding:1px 5px;border-radius:3px;font-family:Consolas}" +
        "blockquote{border-left:3px solid #888;color:#555;margin:8px 0;padding:2px 12px}" +
        "pre{background:#f5f5f5;padding:10px;border-radius:5px;overflow:auto}" +
        "ul{margin:4px 0} li{margin:2px 0} hr{border:none;border-top:1px solid #ddd}" +
        "table{border-collapse:collapse;margin:8px 0;font-size:13px} th,td{border:1px solid #d0d7de;padding:5px 9px;text-align:left;vertical-align:top}" +
        "th{background:#f6f8fa;font-weight:bold} tbody tr:nth-child(even){background:#fbfcfd}";

    static string Inline(string x)
    {
        x = Regex.Replace(x, @"\*\*(.+?)\*\*", "<b>$1</b>");
        x = Regex.Replace(x, @"`(.+?)`", "<code>$1</code>");
        return x;
    }
}
