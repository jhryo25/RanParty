using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Xml;

namespace RanParty.Core;

/// <summary>Zero-dependency document text extraction for DOCX, XLSX, TXT, CSV, MD.</summary>
public static class DocumentExtractor
{
    public static string Extract(string fileName, byte[] bytes, string mimeType)
    {
        string ext = Path.GetExtension(fileName).ToLowerInvariant();
        try
        {
            return ext switch
            {
                ".docx" => ExtractDocx(bytes),
                ".xlsx" => ExtractXlsx(bytes),
                ".csv" or ".tsv" => Encoding.UTF8.GetString(bytes),
                ".txt" or ".md" or ".json" or ".xml" or ".html" or ".log"
                    or ".yaml" or ".yml" or ".toml" or ".ini" or ".cfg"
                    or ".js" or ".ts" or ".py" or ".java" or ".cs" or ".go" or ".rs"
                    or ".c" or ".cpp" or ".h" => Encoding.UTF8.GetString(bytes),
                _ => throw new NotSupportedException($"不支持的文件格式：{ext}")
            };
        }
        catch (NotSupportedException) { throw; }
        catch (Exception ex)
        {
            return $"[提取失败: {ex.Message}]";
        }
    }

    private static string ExtractDocx(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        var docEntry = archive.GetEntry("word/document.xml")
            ?? throw new InvalidDataException("无效的 DOCX：缺少 word/document.xml");
        using var docStream = docEntry.Open();
        var doc = new XmlDocument();
        doc.Load(docStream);
        var ns = new XmlNamespaceManager(doc.NameTable);
        ns.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");
        var paragraphs = doc.SelectNodes("//w:t", ns);
        if (paragraphs is null || paragraphs.Count == 0) return "(空文档)";
        var sb = new StringBuilder();
        foreach (XmlNode node in paragraphs)
            sb.Append(node.InnerText);
        return sb.ToString();
    }

    private static string ExtractXlsx(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);

        // Read shared strings
        var sharedStrings = new System.Collections.Generic.List<string>();
        var ssEntry = archive.GetEntry("xl/sharedStrings.xml");
        if (ssEntry is not null)
        {
            using var ssStream = ssEntry.Open();
            var ssDoc = new XmlDocument();
            ssDoc.Load(ssStream);
            var siNodes = ssDoc.SelectNodes("//si");
            if (siNodes is not null)
                foreach (XmlNode si in siNodes)
                    sharedStrings.Add(si.InnerText);
        }

        var sb = new StringBuilder();
        // Read workbook for sheet names
        var wbEntry = archive.GetEntry("xl/workbook.xml");
        var sheetNames = new System.Collections.Generic.List<string>();
        if (wbEntry is not null)
        {
            using var wbStream = wbEntry.Open();
            var wbDoc = new XmlDocument();
            wbDoc.Load(wbStream);
            var sheetNodes = wbDoc.SelectNodes("//sheet");
            if (sheetNodes is not null)
                foreach (XmlNode sheet in sheetNodes)
                    sheetNames.Add(sheet.Attributes?["name"]?.Value ?? "");
        }

        int maxSheets = Math.Min(sheetNames.Count > 0 ? sheetNames.Count : 10, 10);
        int sheetIdx = 0;
        foreach (var entry in archive.Entries)
        {
            if (!entry.FullName.StartsWith("xl/worksheets/sheet") || !entry.FullName.EndsWith(".xml"))
                continue;
            if (sheetIdx >= maxSheets) break;

            using var sheetStream = entry.Open();
            var sheetDoc = new XmlDocument();
            sheetDoc.Load(sheetStream);
            var rows = sheetDoc.SelectNodes("//row");
            if (rows is null || rows.Count == 0) { sheetIdx++; continue; }

            string name = sheetIdx < sheetNames.Count ? sheetNames[sheetIdx] : $"Sheet{sheetIdx + 1}";
            sb.AppendLine($"--- {name} ---");
            int rowCount = 0;
            foreach (XmlNode row in rows)
            {
                if (rowCount++ > 5000) { sb.AppendLine($"... (截断，共 {rows.Count} 行)"); break; }
                var cells = row.ChildNodes;
                var rowValues = new System.Collections.Generic.List<string>();
                foreach (XmlNode cell in cells)
                {
                    string cellType = cell.Attributes?["t"]?.Value ?? "";
                    string value = cell.InnerText;
                    if (cellType == "s" && int.TryParse(value, out int si) && si >= 0 && si < sharedStrings.Count)
                        value = sharedStrings[si];
                    rowValues.Add(value);
                }
                sb.AppendLine(string.Join("\t", rowValues));
            }
            sheetIdx++;
        }
        return sb.Length > 0 ? sb.ToString() : "(空表格)";
    }
}
