using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using RanParty.Core;
using RanParty.Core.Pets;
using UglyToad.PdfPig.Fonts.Standard14Fonts;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.Writer;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static byte[] OfficeArchive(params (string Path, string Content)[] entries)
{
    using var buffer = new MemoryStream();
    using (var archive = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
    {
        foreach (var item in entries)
        {
            var entry = archive.CreateEntry(item.Path);
            using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false));
            writer.Write(item.Content);
        }
    }
    return buffer.ToArray();
}

static byte[] TinyAtlasPng()
{
    byte[] png = new byte[24];
    new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }.CopyTo(png, 0);
    png[11] = 13;
    Encoding.ASCII.GetBytes("IHDR").CopyTo(png, 12);
    System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(png.AsSpan(16, 4), 1536);
    System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(png.AsSpan(20, 4), 2288);
    return png;
}

Require(DocumentExtractor.IsSupported("notes.md"), "Markdown was not accepted.");
Require(DocumentExtractor.IsSupported("deck.pptx"), "PPTX was not accepted.");
Require(DocumentExtractor.Extract("notes.md", Encoding.UTF8.GetBytes("hello 世界"), "text/markdown") == "hello 世界", "UTF-8 extraction failed.");
bool binaryRejected = false;
try { _ = DocumentExtractor.Extract("notes.txt", new byte[] { 1, 0, 2 }, "text/plain"); }
catch (InvalidDataException) { binaryRejected = true; }
Require(binaryRejected, "Binary text masquerading was accepted.");

byte[] docx = OfficeArchive(("word/document.xml", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>DOCX text</w:t></w:r></w:p></w:body></w:document>"));
Require(DocumentExtractor.Extract("sample.docx", docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document").Contains("DOCX text"), "DOCX extraction failed.");

byte[] pptx = OfficeArchive(("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"urn:p\" xmlns:a=\"urn:a\"><a:t>Slide title</a:t><a:t>Slide body</a:t></p:sld>"));
string slideText = DocumentExtractor.Extract("sample.pptx", pptx, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
Require(slideText.Contains("Slide title") && slideText.Contains("Slide body"), "PPTX extraction failed.");

byte[] xlsx = OfficeArchive(
    ("xl/workbook.xml", "<workbook xmlns=\"urn:x\"><sheets><sheet name=\"Data\"/></sheets></workbook>"),
    ("xl/sharedStrings.xml", "<sst xmlns=\"urn:x\"><si><t>Shared value</t></si></sst>"),
    ("xl/worksheets/sheet1.xml", "<worksheet xmlns=\"urn:x\"><sheetData><row><c t=\"s\"><v>0</v></c><c><v>42</v></c></row></sheetData></worksheet>"));
string sheetText = DocumentExtractor.Extract("sample.xlsx", xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
Require(sheetText.Contains("Shared value") && sheetText.Contains("42"), "XLSX extraction failed.");

var pdf = new PdfDocumentBuilder();
var page = pdf.AddPage(PageSize.A4);
var font = pdf.AddStandard14Font(Standard14Font.Helvetica);
page.AddText("PDF smoke text", 12, new UglyToad.PdfPig.Core.PdfPoint(30, 700), font);
Require(DocumentExtractor.Extract("sample.pdf", pdf.Build(), "application/pdf").Contains("PDF smoke text"), "PDF extraction failed.");

string root = Path.Combine(Path.GetTempPath(), "ranparty-attachment-pet-" + Guid.NewGuid().ToString("N"));
string source = Path.Combine(root, "source");
Directory.CreateDirectory(source);
File.WriteAllBytes(Path.Combine(source, "spritesheet.png"), TinyAtlasPng());
File.WriteAllText(Path.Combine(source, "pet.json"), """
{
  "id": "smoke-pet",
  "displayName": "Smoke Pet",
  "description": "Package validation fixture.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.png"
}
""", new UTF8Encoding(false));
var events = new List<string>();
var repository = new PetRepository(root, (name, _) => events.Add(name));
JsonObject installed = repository.Install(Path.Combine(source, "pet.json"));
Require(installed["settings"]?["activePetId"]?.GetValue<string>() == "smoke-pet", "First pet was not activated.");
Require(installed["settings"]?["enabled"]?.GetValue<bool>() == true, "First pet was not enabled.");
Require(repository.AssetJson("smoke-pet")["dataUrl"]?.GetValue<string>().StartsWith("data:image/png;base64,", StringComparison.Ordinal) == true, "Pet asset was not returned.");
repository.Configure("smoke-pet", true, 0.8);
Require(events.Count >= 2 && events.All(name => name == "pet.changed"), "Pet change events were not emitted.");
string secondSource = Path.Combine(root, "second-source");
Directory.CreateDirectory(secondSource);
File.WriteAllBytes(Path.Combine(secondSource, "spritesheet.png"), TinyAtlasPng());
File.WriteAllText(Path.Combine(secondSource, "pet.json"), """
{
  "id": "second-pet",
  "displayName": "Second Pet",
  "description": "Fallback selection fixture.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.png"
}
""", new UTF8Encoding(false));
repository.Install(Path.Combine(secondSource, "pet.json"));
repository.Delete("smoke-pet");
JsonObject fallbackState = repository.ListJson();
Require(fallbackState["settings"]?["activePetId"]?.GetValue<string>() == "second-pet", "Deleting the active pet did not select the remaining package.");
Require(fallbackState["settings"]?["enabled"]?.GetValue<bool>() == true, "Pet display was disabled while a fallback package remained.");
repository.Delete("second-pet");
Require(repository.ListJson()["pets"]?.AsArray().Count == 0, "Pet deletion failed.");
Directory.Delete(root, recursive: true);

Console.WriteLine("Attachment and pet smoke passed.");
