using System.IO;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace RanParty.Tools;

public static class Docx
{
    const string NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

    public static string Read(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        var entry = zip.GetEntry("word/document.xml");
        if (entry == null) return "";
        using var sr = new StreamReader(entry.Open());
        var doc = XDocument.Load(sr);
        var sb = new StringBuilder();
        foreach (var p in doc.Descendants(XName.Get("p", NS)))
        {
            foreach (var t in p.Descendants(XName.Get("t", NS)))
                sb.Append(t.Value);
            sb.Append("\n");
        }
        return sb.ToString();
    }

    public static void Write(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path)) File.Delete(path);
        using var zip = ZipFile.Open(path, ZipArchiveMode.Create);
        WriteEntry(zip, "[Content_Types].xml",
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
            "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>" +
            "</Types>");
        WriteEntry(zip, "_rels/.rels",
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
            "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>" +
            "</Relationships>");
        var sb = new StringBuilder();
        sb.Append("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>");
        sb.Append("<w:document xmlns:w=\"").Append(NS).Append("\"><w:body>");
        foreach (var line in text.Replace("\r\n", "\n").Split('\n'))
        {
            sb.Append("<w:p><w:r><w:t xml:space=\"preserve\">");
            sb.Append(Escape(line));
            sb.Append("</w:t></w:r></w:p>");
        }
        sb.Append("</w:body></w:document>");
        WriteEntry(zip, "word/document.xml", sb.ToString());
    }

    static void WriteEntry(ZipArchive zip, string name, string content)
    {
        var e = zip.CreateEntry(name);
        using var sw = new StreamWriter(e.Open(), new UTF8Encoding(false));
        sw.Write(content);
    }

    static string Escape(string s)
        => s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
}
