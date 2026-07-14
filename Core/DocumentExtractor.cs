using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;

namespace RanParty.Core;

/// <summary>Bounded text extraction for user-supplied context attachments.</summary>
public static class DocumentExtractor
{
    private static readonly HashSet<string> TextExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".html", ".htm", ".css", ".log",
        ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env", ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cs",
        ".go", ".rs", ".c", ".cpp", ".cc", ".h", ".hpp", ".sh", ".ps1", ".sql", ".rb", ".php", ".swift",
        ".kt", ".scala", ".r", ".lua", ".vue", ".svelte"
    };

    public static bool IsSupported(string fileName) => Path.GetExtension(fileName).ToLowerInvariant() is ".pdf" or ".docx" or ".xlsx" or ".pptx"
        || TextExtensions.Contains(Path.GetExtension(fileName));

    public static string Extract(string fileName, byte[] bytes, string mimeType)
    {
        if (bytes.Length == 0) throw new InvalidDataException("附件为空");
        string extension = Path.GetExtension(fileName).ToLowerInvariant();
        return extension switch
        {
            ".pdf" => ExtractPdf(bytes),
            ".docx" => ExtractDocx(bytes),
            ".xlsx" => ExtractXlsx(bytes),
            ".pptx" => ExtractPptx(bytes),
            _ when TextExtensions.Contains(extension) => DecodeText(bytes),
            _ => throw new NotSupportedException($"不支持的文件格式：{extension}")
        };
    }

    private static string ExtractPdf(byte[] bytes)
    {
        using var document = PdfDocument.Open(bytes);
        var output = new StringBuilder();
        int pages = Math.Min(document.NumberOfPages, 200);
        for (int pageNumber = 1; pageNumber <= pages; pageNumber++)
        {
            if (pageNumber > 1) output.AppendLine().AppendLine($"--- 第 {pageNumber} 页 ---");
            output.Append(ContentOrderTextExtractor.GetText(document.GetPage(pageNumber)).Trim());
        }
        if (document.NumberOfPages > pages) output.AppendLine().AppendLine($"[PDF 共 {document.NumberOfPages} 页，仅提取前 {pages} 页]");
        return output.Length == 0 ? "（PDF 未包含可提取文本，可能是扫描件）" : output.ToString();
    }

    private static string ExtractDocx(byte[] bytes)
    {
        using var archive = OpenOfficeArchive(bytes);
        var entry = archive.GetEntry("word/document.xml") ?? throw new InvalidDataException("无效的 DOCX：缺少 word/document.xml");
        XmlDocument document = LoadXml(entry);
        var output = new StringBuilder();
        XmlNodeList? paragraphs = document.SelectNodes("//*[local-name()='p']");
        if (paragraphs is null) return "（空文档）";
        foreach (XmlNode paragraph in paragraphs)
        {
            string text = string.Concat(paragraph.SelectNodes(".//*[local-name()='t']")?.Cast<XmlNode>().Select(node => node.InnerText) ?? []);
            if (!string.IsNullOrWhiteSpace(text)) output.AppendLine(text);
        }
        return output.Length == 0 ? "（空文档）" : output.ToString().TrimEnd();
    }

    private static string ExtractPptx(byte[] bytes)
    {
        using var archive = OpenOfficeArchive(bytes);
        var slides = archive.Entries
            .Where(entry => Regex.IsMatch(entry.FullName, @"^ppt/slides/slide\d+\.xml$", RegexOptions.IgnoreCase))
            .OrderBy(entry => NumericSuffix(entry.Name))
            .Take(200)
            .ToList();
        if (slides.Count == 0) throw new InvalidDataException("无效的 PPTX：未找到幻灯片");
        var output = new StringBuilder();
        for (int index = 0; index < slides.Count; index++)
        {
            XmlDocument slide = LoadXml(slides[index]);
            string[] lines = (slide.SelectNodes("//*[local-name()='t']")?.Cast<XmlNode>() ?? [])
                .Select(node => node.InnerText.Trim()).Where(text => text.Length > 0).ToArray();
            output.AppendLine($"--- 幻灯片 {index + 1} ---");
            output.AppendLine(string.Join(Environment.NewLine, lines));
        }
        return output.ToString().TrimEnd();
    }

    private static string ExtractXlsx(byte[] bytes)
    {
        using var archive = OpenOfficeArchive(bytes);
        var sharedStrings = new List<string>();
        var sharedEntry = archive.GetEntry("xl/sharedStrings.xml");
        if (sharedEntry is not null)
        {
            XmlDocument shared = LoadXml(sharedEntry);
            foreach (XmlNode item in Nodes(shared.SelectNodes("//*[local-name()='si']")))
                sharedStrings.Add(string.Concat(item.SelectNodes(".//*[local-name()='t']")?.Cast<XmlNode>().Select(node => node.InnerText) ?? []));
        }

        var sheetNames = new List<string>();
        var workbookEntry = archive.GetEntry("xl/workbook.xml");
        if (workbookEntry is not null)
        {
            XmlDocument workbook = LoadXml(workbookEntry);
            foreach (XmlNode sheet in Nodes(workbook.SelectNodes("//*[local-name()='sheet']")))
                sheetNames.Add(sheet.Attributes?["name"]?.Value ?? $"Sheet{sheetNames.Count + 1}");
        }

        var sheets = archive.Entries
            .Where(entry => Regex.IsMatch(entry.FullName, @"^xl/worksheets/sheet\d+\.xml$", RegexOptions.IgnoreCase))
            .OrderBy(entry => NumericSuffix(entry.Name))
            .Take(20)
            .ToList();
        var output = new StringBuilder();
        for (int sheetIndex = 0; sheetIndex < sheets.Count; sheetIndex++)
        {
            XmlDocument sheet = LoadXml(sheets[sheetIndex]);
            string name = sheetIndex < sheetNames.Count ? sheetNames[sheetIndex] : $"Sheet{sheetIndex + 1}";
            output.AppendLine($"--- {name} ---");
            int rowCount = 0;
            foreach (XmlNode row in Nodes(sheet.SelectNodes("//*[local-name()='row']")))
            {
                if (rowCount++ >= 5_000) { output.AppendLine("[工作表超过 5000 行，后续内容已截断]"); break; }
                var values = new List<string>();
                foreach (XmlNode cell in Nodes(row.SelectNodes("./*[local-name()='c']")))
                {
                    string cellType = cell.Attributes?["t"]?.Value ?? "";
                    string value = cell.SelectSingleNode("./*[local-name()='v']")?.InnerText
                        ?? string.Concat(cell.SelectNodes(".//*[local-name()='t']")?.Cast<XmlNode>().Select(node => node.InnerText) ?? []);
                    if (cellType == "s" && int.TryParse(value, out int sharedIndex) && sharedIndex >= 0 && sharedIndex < sharedStrings.Count)
                        value = sharedStrings[sharedIndex];
                    values.Add(value.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '));
                }
                output.AppendLine(string.Join('\t', values));
            }
        }
        return output.Length == 0 ? "（空表格）" : output.ToString().TrimEnd();
    }

    private static string DecodeText(byte[] bytes)
    {
        if (bytes.AsSpan().IndexOf((byte)0) >= 0 && !HasUtf16Bom(bytes))
            throw new InvalidDataException("检测到二进制内容，不能作为文本注入上下文");
        if (bytes.AsSpan().StartsWith(new byte[] { 0xFF, 0xFE })) return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.AsSpan().StartsWith(new byte[] { 0xFE, 0xFF })) return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
        int offset = bytes.AsSpan().StartsWith(new byte[] { 0xEF, 0xBB, 0xBF }) ? 3 : 0;
        try { return new UTF8Encoding(false, true).GetString(bytes, offset, bytes.Length - offset); }
        catch (DecoderFallbackException) { throw new InvalidDataException("文本文件不是有效的 UTF-8/UTF-16 编码"); }
    }

    private static bool HasUtf16Bom(byte[] bytes) => bytes.Length >= 2
        && ((bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes[0] == 0xFE && bytes[1] == 0xFF));

    private static ZipArchive OpenOfficeArchive(byte[] bytes)
    {
        if (bytes.Length < 4 || bytes[0] != (byte)'P' || bytes[1] != (byte)'K') throw new InvalidDataException("Office 文件不是有效的 ZIP 容器");
        return new ZipArchive(new MemoryStream(bytes, writable: false), ZipArchiveMode.Read);
    }

    private static XmlDocument LoadXml(ZipArchiveEntry entry)
    {
        if (entry.Length > 64L * 1024 * 1024) throw new InvalidDataException("Office XML 部件超过 64MB 安全上限");
        using Stream stream = entry.Open();
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 64L * 1024 * 1024 };
        using XmlReader reader = XmlReader.Create(stream, settings);
        var document = new XmlDocument { XmlResolver = null };
        document.Load(reader);
        return document;
    }

    private static int NumericSuffix(string name) => int.TryParse(Regex.Match(name, @"\d+").Value, out int value) ? value : int.MaxValue;
    private static IEnumerable<XmlNode> Nodes(XmlNodeList? nodes) => nodes?.Cast<XmlNode>() ?? Enumerable.Empty<XmlNode>();
}
