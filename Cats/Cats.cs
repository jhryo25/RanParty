using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Enumeration;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

using RanParty.Core;
using RanParty.Tools;
namespace RanParty.Cats;


public enum ToolExposure { Direct, Deferred, Hidden }
public enum ErrorKind { None, NotFound, PermissionDenied, Timeout, InvalidArgument, Fatal, Unknown }

public class ToolResult
{
    public string Content = "";
    public bool IsError => Error != ErrorKind.None;
    public ErrorKind Error;
}

public abstract class Cat
{
    public string Name = "";
    public List<string> Tools = new();
    public Dictionary<string, (string desc, string parms)> Schemas = new();
    public HashSet<string> ParallelSafeTools = new(StringComparer.Ordinal);
    public HashSet<string> DeferredTools = new(StringComparer.Ordinal);
    public ToolExposure GetExposure(string tool) => DeferredTools.Contains(tool) ? ToolExposure.Deferred : ToolExposure.Direct;
    protected void Add(string t, string desc, string parms) { Tools.Add(t); Schemas[t] = (desc, parms); }
    protected void AddParallel(string t) => ParallelSafeTools.Add(t);
    protected void AddDeferred(string t) => DeferredTools.Add(t);

    /// <summary>Basic JSON Schema validation: checks required fields and types before dispatch</summary>
    public ToolResult? ValidateArgs(string tool, JsonNode? args)
    {
        if (!Schemas.TryGetValue(tool, out var schema)) return null;
        if (string.IsNullOrWhiteSpace(schema.parms)) return null;
        JsonNode? schemaNode;
        try { schemaNode = JsonNode.Parse(schema.parms); } catch { return null; }
        var obj = args as JsonObject ?? new JsonObject();
        var required = schemaNode?["required"] as JsonArray;
        if (required != null)
        {
            foreach (var req in required)
            {
                string key = req?.GetValue<string>() ?? "";
                if (obj[key] is null)
                    return new ToolResult { Content = "Validation failed: missing required param '" + key + "' (tool: " + tool + ")", Error = ErrorKind.InvalidArgument };
            }
        }
        var props = schemaNode?["properties"] as JsonObject;
        if (props != null)
        {
            foreach (var kv in obj)
            {
                if (kv.Value is null) continue;
                var propSchema = props[kv.Key];
                if (propSchema is null) continue;
                string expectedType = propSchema["type"]?.GetValue<string>() ?? "";
                string actualType = kv.Value switch
                {
                    JsonObject => "object",
                    JsonArray => "array",
                    JsonValue jv when jv.TryGetValue<string>(out _) => "string",
                    JsonValue jv when jv.TryGetValue<int>(out _) => "integer",
                    JsonValue jv when jv.TryGetValue<bool>(out _) => "boolean",
                    _ => "unknown"
                };
                if (!string.IsNullOrEmpty(expectedType) && expectedType != actualType)
                    return new ToolResult { Content = "Validation failed: param '" + kv.Key + "' expected " + expectedType + " but got " + actualType + " (tool: " + tool + ")", Error = ErrorKind.InvalidArgument };
            }
        }
        return null;
    }

    public abstract ToolResult Execute(string tool, JsonNode args);

    /// <summary>
    /// Cancellation-aware execution path. Synchronous tools inherit this adapter;
    /// long-running tools should override it and observe the supplied token.
    /// </summary>
    public virtual Task<ToolResult> ExecuteAsync(string tool, JsonNode args, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(Execute(tool, args));
    }
}

public class IOCat : Cat
{
    private const int MaxFileReadCharacters = 256 * 1024;
    private const long MaxMarkerReadBytes = 4L * 1024 * 1024;
    internal const int MaxDirectoryResultEntries = 1000;
    internal const int MaxDirectoryTraversalEntries = 20_000;
    internal const int MaxDirectoryOutputCharacters = 64 * 1024;
    internal const int MaxFileTreeDepth = 16;
    const string DirectoryTruncationNotice = "[output truncated: directory traversal/result limit reached]";
    static readonly EnumerationOptions SafeDirectoryEnumeration = new()
    {
        // Count every entry toward the traversal budget, then discard reparse
        // points in TryClassifyEntry so a directory full of links is still bounded.
        AttributesToSkip = 0,
        IgnoreInaccessible = true,
        RecurseSubdirectories = false,
        ReturnSpecialDirectories = false
    };
    Config _cfg;
    CatRegistry _reg;

    public IOCat(Config cfg, CatRegistry reg)
    {
        _cfg = cfg; _reg = reg; Name = "IOCat";
        Add("file_read", "Read entire file contents", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
        Add("file_read_between", "Read content between two markers", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"str1\":{\"type\":\"string\"},\"str2\":{\"type\":\"string\"}},\"required\":[\"path\",\"str1\",\"str2\"]}");
        Add("file_write", "Overwrite file contents", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},\"required\":[\"path\",\"content\"]}");
        Add("file_append", "Append to end of file", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},\"required\":[\"path\",\"content\"]}");
        Add("file_replace", "Replace old->new in file", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"old\":{\"type\":\"string\"},\"new\":{\"type\":\"string\"}},\"required\":[\"path\",\"old\",\"new\"]}");
        Add("file_list", "List immediate children of directory", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
        Add("file_find", "Search files by glob pattern (recursive)", "{\"type\":\"object\",\"properties\":{\"dir\":{\"type\":\"string\"},\"pattern\":{\"type\":\"string\"}},\"required\":[\"dir\",\"pattern\"]}");
        Add("file_tree", "Recursive directory tree", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"depth\":{\"type\":\"integer\"}},\"required\":[\"path\"]}");
        Add("file_move", "Move/rename file or directory", "{\"type\":\"object\",\"properties\":{\"src\":{\"type\":\"string\"},\"dst\":{\"type\":\"string\"}},\"required\":[\"src\",\"dst\"]}");
        Add("file_delete", "Delete file or empty directory", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
        Add("file_read_excel", "Read .xlsx as TSV", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
        Add("file_write_excel", "Write TSV to .xlsx", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"tsv\":{\"type\":\"string\"}},\"required\":[\"path\",\"tsv\"]}");
        Add("file_read_docx", "Read .docx as plain text", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
        Add("file_write_docx", "Write plain text to .docx", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"text\":{\"type\":\"string\"}},\"required\":[\"path\",\"text\"]}");
        Add("file_batch", "Batch write operations", "{\"type\":\"object\",\"properties\":{\"ops\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"tool\":{\"type\":\"string\"},\"args\":{\"type\":\"object\"}},\"required\":[\"tool\",\"args\"]}}},\"required\":[\"ops\"]}");
        Add("now_time", "Current datetime yyyy-MM-dd HH:mm:ss", "{\"type\":\"object\",\"properties\":{}}");
        Add("random_int", "Random int [min, max)", "{\"type\":\"object\",\"properties\":{\"min\":{\"type\":\"integer\"},\"max\":{\"type\":\"integer\"}},\"required\":[\"min\",\"max\"]}");

        // Evolution tools
        Add("archive_search", "BM25 search cold archive by query. Returns top matching knowledge fragments.",
            "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"},\"max_results\":{\"type\":\"integer\"}},\"required\":[\"query\"]}");
        Add("memory_add", "Add entry to MEMORY.md (current user profile). Auto-dedup; prompts removal if over capacity.",
            "{\"type\":\"object\",\"properties\":{\"content\":{\"type\":\"string\"},\"category\":{\"type\":\"string\"}},\"required\":[\"content\"]}");
        Add("memory_remove", "Remove entry from MEMORY.md by matching text.",
            "{\"type\":\"object\",\"properties\":{\"old_text\":{\"type\":\"string\"}},\"required\":[\"old_text\"]}");
        Add("lesson_capture", "Capture a lesson to cold archive with BM25 dedup. Auto-updates timestamp + hits if duplicate, prompts upgrade to LESSONS.md if hits>3.",
            "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"},\"source\":{\"type\":\"string\"}},\"required\":[\"title\",\"content\"]}");
        Add("knowledge_read", "Read knowledge files (MEMORY.md, LESSONS.md, archives). For frontend management.",
            "{\"type\":\"object\",\"properties\":{\"file\":{\"type\":\"string\"},\"query\":{\"type\":\"string\"}},\"required\":[\"file\"]}");
        Add("tool_search", "Search for available tools by keyword. Use when you need a tool but do not see it in the tool list.",
            "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]}");
        // Hidden tools: only exposed via tool_search, not shown by default
        AddDeferred("archive_search"); AddDeferred("memory_add"); AddDeferred("memory_remove");
        AddDeferred("lesson_capture"); AddDeferred("knowledge_read");

        // Read-only tools are safe for parallel execution
        AddParallel("file_read"); AddParallel("file_read_between"); AddParallel("file_list");
        AddParallel("file_find"); AddParallel("file_tree"); AddParallel("file_read_excel");
        AddParallel("file_read_docx"); AddParallel("now_time"); AddParallel("random_int");
        // Deferred tools (not shown by default, discoverable via tool_search)
        AddDeferred("file_read_excel"); AddDeferred("file_write_excel");
        AddDeferred("file_read_docx"); AddDeferred("file_write_docx");
    }

    public override ToolResult Execute(string tool, JsonNode args)
    {
        string S(string k) => args?[k]?.GetValue<string>() ?? "";
        int I(string k) => args?[k]?.GetValue<int>() ?? 0;
        try
        {
            return tool switch
            {
                "file_read" => FileRead(S("path")),
                "file_read_between" => FileReadBetween(S("path"), S("str1"), S("str2")),
                "file_write" => FileWrite(S("path"), S("content")),
                "file_append" => FileAppend(S("path"), S("content")),
                "file_replace" => FileReplace(S("path"), S("old"), S("new")),
                "file_list" => FileList(S("path")),
                "file_find" => FileFind(S("dir"), S("pattern")),
                "file_tree" => FileTree(S("path"), I("depth") == 0 ? 3 : I("depth")),
                "file_move" => FileMove(S("src"), S("dst")),
                "file_delete" => FileDelete(S("path")),
                "file_read_excel" => GuardOk(S("path"), p => Excel.Read(p)),
                "file_write_excel" => GuardWrite(S("path"), () => Excel.Write(S("path"), S("tsv"))),
                "file_read_docx" => GuardOk(S("path"), p => Docx.Read(p)),
                "file_write_docx" => GuardWrite(S("path"), () => Docx.Write(S("path"), S("text"))),
                "file_batch" => Err("file_batch must be expanded by the host policy dispatcher", ErrorKind.PermissionDenied),
                "now_time" => Ok(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")),
                "random_int" => Ok(new Random().Next(I("min"), I("max")).ToString()),
                "archive_search" => ArchiveSearch(S("query"), I("max_results") == 0 ? 3 : I("max_results")),
                "memory_add" => MemoryAdd(S("content"), S("category")),
                "memory_remove" => MemoryRemove(S("old_text")),
                "lesson_capture" => LessonCapture(S("title"), S("content"), S("source")),
                "knowledge_read" => KnowledgeRead(S("file"), S("query")),
                "tool_search" => ToolSearch(S("query")),
                _ => Err("IOCat unknown tool: " + tool, ErrorKind.InvalidArgument)
            };
        }
        catch (Exception ex) { return Err("ERR " + ex.Message); }
    }

    ToolResult GuardOk(string path, Func<string, string> fn)
    {
        var g = Guard(path); if (g != null) return g;
        if (!File.Exists(path)) return Err("ERR file not found: " + path, ErrorKind.NotFound);
        try { return Ok(fn(path)); } catch (Exception ex) { return Err("ERR " + ex.Message); }
    }
    ToolResult GuardWrite(string path, Action fn)
    {
        var g = Guard(path); if (g != null) return g;
        try { fn(); return Ok("OK"); } catch (Exception ex) { return Err("ERR " + ex.Message); }
    }

    ToolResult Ok(string s) => new() { Content = s };
    ToolResult Err(string s, ErrorKind kind = ErrorKind.Unknown) => new() { Content = s, Error = kind };
    ToolResult? Guard(string path) => !_cfg.InWhitelist(path) ? Err("ERR path not in whitelist: " + path, ErrorKind.PermissionDenied) : null;

    ToolResult FileRead(string path)
    {
        var guard = Guard(path); if (guard != null) return guard;
        if (!File.Exists(path)) return Err("ERR file not found: " + path, ErrorKind.NotFound);
        using var reader = new StreamReader(path, Encoding.UTF8, true);
        var buffer = new char[MaxFileReadCharacters + 1];
        int total = 0;
        while (total < buffer.Length)
        {
            int read = reader.Read(buffer, total, buffer.Length - total);
            if (read == 0) break;
            total += read;
        }
        if (total <= MaxFileReadCharacters) return Ok(new string(buffer, 0, total));
        return Ok(new string(buffer, 0, MaxFileReadCharacters)
            + $"\n\n[文件读取已限制为 {MaxFileReadCharacters} 字符；请使用 file_read_between 或更精确的搜索工具读取其余内容]");
    }
    ToolResult FileReadBetween(string path, string s1, string s2)
    {
        var g = Guard(path); if (g != null) return g;
        if (!File.Exists(path)) return Err("ERR file not found: " + path, ErrorKind.NotFound);
        if (new FileInfo(path).Length > MaxMarkerReadBytes)
            return Err($"ERR file is larger than {MaxMarkerReadBytes} bytes; use a narrower search/read operation", ErrorKind.InvalidArgument);
        var c = File.ReadAllText(path);
        int i = c.IndexOf(s1); if (i < 0) return Err("ERR str1 not found");
        int j = c.IndexOf(s2, i + s1.Length); if (j < 0) return Err("ERR str2 not found");
        return Ok(c.Substring(i + s1.Length, j - i - s1.Length));
    }
    ToolResult FileWrite(string path, string content) => GuardWrite(path, () => { Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, content); });
    ToolResult FileAppend(string path, string content) => GuardWrite(path, () => { Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.AppendAllText(path, content); });
    ToolResult FileReplace(string path, string old, string @new)
    {
        var g = Guard(path); if (g != null) return g;
        if (!File.Exists(path)) return Err("ERR file not found: " + path, ErrorKind.NotFound);
        var c = File.ReadAllText(path);
        if (!c.Contains(old)) return Err("ERR old not found");
        File.WriteAllText(path, c.Replace(old, @new)); return Ok("OK");
    }
    ToolResult FileList(string path)
    {
        var g = Guard(path); if (g != null) return g;
        if (!Directory.Exists(path)) return Err("ERR directory not found: " + path, ErrorKind.NotFound);
        var sb = new StringBuilder();
        int traversed = 0, returned = 0;
        bool truncated = false;
        EnumerateDirectorySafely(path, entry =>
        {
            if (traversed >= MaxDirectoryTraversalEntries || returned >= MaxDirectoryResultEntries)
            {
                truncated = true;
                return false;
            }
            traversed++;
            if (!TryClassifyEntry(entry, out _)) return true;
            if (!TryAppendDirectoryLine(sb, Path.GetFileName(entry)))
            {
                truncated = true;
                return false;
            }
            returned++;
            return true;
        });
        if (truncated) AppendDirectoryTruncationNotice(sb);
        return Ok(sb.ToString());
    }
    ToolResult FileFind(string dir, string pattern)
    {
        var g = Guard(dir); if (g != null) return g;
        if (!Directory.Exists(dir)) return Err("ERR directory not found: " + dir, ErrorKind.NotFound);
        if (string.IsNullOrWhiteSpace(pattern)) return Err("ERR pattern is required", ErrorKind.InvalidArgument);
        var sb = new StringBuilder();
        var pending = new Stack<string>();
        pending.Push(dir);
        int traversed = 0, returned = 0;
        bool truncated = false;
        while (pending.Count > 0 && !truncated)
        {
            string current = pending.Pop();
            EnumerateDirectorySafely(current, entry =>
            {
                if (traversed >= MaxDirectoryTraversalEntries)
                {
                    truncated = true;
                    return false;
                }
                traversed++;
                if (!TryClassifyEntry(entry, out bool isDirectory)) return true;
                if (isDirectory)
                {
                    pending.Push(entry);
                    return true;
                }
                if (!MatchesFilePattern(dir, entry, pattern))
                    return true;
                if (returned >= MaxDirectoryResultEntries || !TryAppendDirectoryLine(sb, entry))
                {
                    truncated = true;
                    return false;
                }
                returned++;
                return true;
            });
        }
        if (truncated) AppendDirectoryTruncationNotice(sb);
        return Ok(sb.ToString());
    }
    ToolResult FileTree(string path, int depth)
    {
        var g = Guard(path); if (g != null) return g;
        if (!Directory.Exists(path)) return Err("ERR directory not found: " + path, ErrorKind.NotFound);
        depth = Math.Clamp(depth, 1, MaxFileTreeDepth);
        var sb = new StringBuilder();
        int traversed = 0, returned = 0;
        bool truncated = false;
        void Walk(string p, int d)
        {
            if (d > depth || truncated) return;
            EnumerateDirectorySafely(p, entry =>
            {
                if (traversed >= MaxDirectoryTraversalEntries || returned >= MaxDirectoryResultEntries)
                {
                    truncated = true;
                    return false;
                }
                traversed++;
                if (!TryClassifyEntry(entry, out bool isDirectory)) return true;
                string line = new string(' ', (d - 1) * 2) + Path.GetFileName(entry) + (isDirectory ? "/" : "");
                if (!TryAppendDirectoryLine(sb, line))
                {
                    truncated = true;
                    return false;
                }
                returned++;
                if (isDirectory) Walk(entry, d + 1);
                return !truncated;
            });
        }
        Walk(path, 1);
        if (truncated) AppendDirectoryTruncationNotice(sb);
        return Ok(sb.ToString());
    }

    static void EnumerateDirectorySafely(string path, Func<string, bool> visitor)
    {
        try
        {
            foreach (string entry in Directory.EnumerateFileSystemEntries(path, "*", SafeDirectoryEnumeration))
                if (!visitor(entry)) break;
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }
        catch (System.Security.SecurityException) { }
    }

    static bool TryClassifyEntry(string path, out bool isDirectory)
    {
        isDirectory = false;
        try
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return false;
            isDirectory = (attributes & FileAttributes.Directory) != 0;
            return true;
        }
        catch (UnauthorizedAccessException) { return false; }
        catch (IOException) { return false; }
        catch (System.Security.SecurityException) { return false; }
    }

    static bool MatchesFilePattern(string root, string path, string pattern)
    {
        string normalizedPattern = pattern.Replace('\\', '/');
        string candidate = normalizedPattern.Contains('/')
            ? Path.GetRelativePath(root, path).Replace('\\', '/')
            : Path.GetFileName(path);
        bool ignoreCase = OperatingSystem.IsWindows();
        if (FileSystemName.MatchesSimpleExpression(normalizedPattern, candidate, ignoreCase)) return true;
        return normalizedPattern.StartsWith("**/", StringComparison.Ordinal)
            && FileSystemName.MatchesSimpleExpression(normalizedPattern.AsSpan(3), candidate.AsSpan(), ignoreCase);
    }

    static bool TryAppendDirectoryLine(StringBuilder output, string value)
    {
        int reserved = DirectoryTruncationNotice.Length + Environment.NewLine.Length;
        int lineLength = value.Length + Environment.NewLine.Length;
        if (lineLength > MaxDirectoryOutputCharacters - reserved - output.Length) return false;
        output.AppendLine(value);
        return true;
    }

    static void AppendDirectoryTruncationNotice(StringBuilder output)
    {
        if (output.Length + DirectoryTruncationNotice.Length + Environment.NewLine.Length <= MaxDirectoryOutputCharacters)
            output.AppendLine(DirectoryTruncationNotice);
    }
    ToolResult FileMove(string src, string dst)
    {
        var g1 = Guard(src); if (g1 != null) return g1;
        var g2 = Guard(dst); if (g2 != null) return g2;
        Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
        if (File.Exists(src)) File.Move(src, dst);
        else if (Directory.Exists(src)) Directory.Move(src, dst);
        else return Err("ERR source not found", ErrorKind.NotFound);
        return Ok("OK");
    }
    ToolResult FileDelete(string path)
    {
        var g = Guard(path); if (g != null) return g;
        if (File.Exists(path)) File.Delete(path);
        else if (Directory.Exists(path)) Directory.Delete(path);
        else return Err("ERR not found", ErrorKind.NotFound);
        return Ok("OK");
    }

    // ── Evolution tools ──

    ToolResult ArchiveSearch(string query, int maxResults)
    {
        if (string.IsNullOrWhiteSpace(query)) return Err("query is required", ErrorKind.InvalidArgument);
        maxResults = Math.Clamp(maxResults, 1, 5);
        var files = new[] { "MEMORY_archive.md", "LESSONS_archive.md" };
        var results = new List<(string file, string snippet, double score)>();
        foreach (var f in files)
        {
            string path = Path.Combine("RanParty", f);
            if (!File.Exists(path)) continue;
            var sections = File.ReadAllText(path).Split("---", StringSplitOptions.RemoveEmptyEntries);
            var docs = sections.Select(s => s.Trim()).Where(s => s.Length > 10).ToList();
            if (docs.Count == 0) continue;
            var ranked = Bm25.Search(query, docs, maxResults);
            foreach (var (idx, score) in ranked)
                results.Add((f, docs[idx].Length > 300 ? docs[idx][..300] + "..." : docs[idx], score));
        }
        results = results.OrderByDescending(r => r.score).Take(maxResults).ToList();
        if (results.Count == 0) return Ok("No matching knowledge found in cold archives.");
        var sb = new StringBuilder();
        foreach (var r in results)
            sb.AppendLine($"[{r.file}] (relevance:{r.score:F1})\n{r.snippet}\n");
        return Ok(sb.ToString());
    }

    ToolResult MemoryAdd(string content, string category)
    {
        if (string.IsNullOrWhiteSpace(content)) return Err("content is required", ErrorKind.InvalidArgument);
        string path = Path.Combine("RanParty", "MEMORY.md");
        string entry = content.Contains(DateTime.Now.ToString("yyyy-MM")) ? content : $"{content} · {DateTime.Now:yyyy-MM-dd}";
        // Dedup: use BM25 keyword overlap
        if (File.Exists(path))
        {
            var existing = File.ReadAllText(path);
            if (Bm25.KeywordOverlap(content, existing) > 0.6)
                return Ok("Similar memory already exists (" + (Bm25.KeywordOverlap(content, existing)*100).ToString("F0") + "% overlap). Use memory_remove first to replace.");
            if (existing.Length + entry.Length > 2500)
                return Ok("MEMORY.md approaching capacity (" + existing.Length + " chars). Remove old entries first.");
        }
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(path, (File.Exists(path) ? "\n" : "") + "§ " + entry + "\n");
        // Category "preference" or "tone" needs user review
        string note = (category == "preference" || category == "tone")
            ? " [注意: 偏好类记忆已写入，可在知识管理界面复核]"
            : "";
        return Ok("Memory added: " + entry[..Math.Min(60, entry.Length)] + note);
    }

    ToolResult MemoryRemove(string oldText)
    {
        if (string.IsNullOrWhiteSpace(oldText)) return Err("old_text is required", ErrorKind.InvalidArgument);
        string path = Path.Combine("RanParty", "MEMORY.md");
        if (!File.Exists(path)) return Ok("MEMORY.md is empty.");
        var content = File.ReadAllText(path);
        if (!content.Contains(oldText)) return Err("Text not found in MEMORY.md");
        // Remove the matching line
        var lines = content.Split('\n').Where(l => !l.Contains(oldText)).ToList();
        File.WriteAllText(path, string.Join("\n", lines));
        return Ok("Memory removed.");
    }

    ToolResult LessonCapture(string title, string content, string source)
    {
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(content))
            return Err("title and content are required", ErrorKind.InvalidArgument);
        string path = Path.Combine("RanParty", "LESSONS_archive.md");
        string timestamp = DateTime.Now.ToString("yyyy-MM-dd");
        source = string.IsNullOrWhiteSpace(source) ? "manual" : source;

        // BM25 dedup against existing archive
        if (File.Exists(path))
        {
            var sections = File.ReadAllText(path).Split("---", StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim()).Where(s => s.Length > 10).ToList();
            if (sections.Count > 0)
            {
                var ranked = Bm25.Search(title + " " + content, sections, 1);
                if (ranked.Count > 0 && ranked[0].score > 2.5)
                {
                    double overlap = Bm25.KeywordOverlap(title + " " + content, sections[ranked[0].index]);
                    if (overlap > 0.5)
                    {
                        // Update existing entry
                        var old = sections[ranked[0].index];
                        var match = System.Text.RegularExpressions.Regex.Match(old, @"hits:\s*(\d+)");
                        int hits = match.Success ? int.Parse(match.Groups[1].Value) + 1 : 2;
                        var re = new System.Text.RegularExpressions.Regex(@"hits:\s*\d+");
                        string updated = re.Replace(old, "hits: " + hits);
                        string oldDate = old.Split('\n')[0].Trim('[', ']').Split('|')[0];
                        updated = System.Text.RegularExpressions.Regex.Replace(updated, @"^\[[^\]]+\]", "[" + oldDate + "|" + timestamp + "]");
                        if (hits > 3)
                            updated += "\n  → also: " + timestamp + " 再次遇到, hits=" + hits + " · 建议升级到 LESSONS.md";
                        var all = File.ReadAllText(path);
                        File.WriteAllText(path, all.Replace(old, updated));
                        return Ok("Updated existing lesson (hits=" + hits + ")." + (hits > 3 ? " Consider upgrading to LESSONS.md!" : ""));
                    }
                }
            }
        }
        // New entry
        var entry = $"[{timestamp}] {title}\n  → category: {source}\n  → hits: 1 | resolved: false\n  → {content}\n---\n";
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.AppendAllText(path, entry);
        return Ok("New lesson captured: " + title);
    }

    ToolResult KnowledgeRead(string file, string query)
    {
        var allowed = new[] { "MEMORY.md", "LESSONS.md", "LESSONS_archive.md", "MEMORY_archive.md", "_search_index.md" };
        if (!allowed.Contains(file, StringComparer.OrdinalIgnoreCase)) return Err("Invalid file. Allowed: " + string.Join(", ", allowed), ErrorKind.InvalidArgument);
        string path = Path.Combine("RanParty", file);
        if (!File.Exists(path)) return Ok("");
        using var reader = new StreamReader(path, Encoding.UTF8, true);
        var buffer = new char[MaxFileReadCharacters];
        int read = reader.ReadBlock(buffer, 0, buffer.Length);
        string text = new(buffer, 0, read);
        if (!string.IsNullOrWhiteSpace(query))
        {
            var sections = text.Split("---", StringSplitOptions.RemoveEmptyEntries).Where(s => s.Contains(query, StringComparison.OrdinalIgnoreCase)).Take(5);
            return Ok(string.Join("\n---\n", sections));
        }
        return Ok(text);
    }

    ToolResult ToolSearch(string query)
    {
        if (string.IsNullOrWhiteSpace(query)) return Err("query required", ErrorKind.InvalidArgument);
        var results = new StringBuilder();
        foreach (var tool in _reg.SearchDeferredTools(query))
            results.AppendLine($"- {tool.Name} [{tool.Exposure.ToString().ToLowerInvariant()}]: {tool.Description}");
        if (results.Length == 0) return Ok("No matching tools found for: " + query);
        return Ok(results.ToString());
    }
}

public class MdCat : Cat
{
    Config _cfg;
    public MdCat(Config cfg)
    {
        _cfg = cfg;
        Name = "MdCat";
        Add("reformat_md", "Plain text to canonical Markdown", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
        AddDeferred("reformat_md");
    }

    public override ToolResult Execute(string tool, JsonNode args)
    {
        if (tool != "reformat_md") return new ToolResult { Content = "MdCat unknown tool: " + tool, Error = ErrorKind.InvalidArgument };
        string path = args?["path"]?.GetValue<string>() ?? "";
        if (!_cfg.InWhitelist(path)) return new ToolResult { Content = "ERR path not in whitelist: " + path, Error = ErrorKind.PermissionDenied };
        if (!File.Exists(path)) return new ToolResult { Content = "ERR file not found: " + path, Error = ErrorKind.NotFound };
        var lines = File.ReadAllLines(path);
        var sb = new StringBuilder();
        foreach (var ln in lines) sb.AppendLine(ln.TrimStart());
        File.WriteAllText(path, sb.ToString());
        return new ToolResult { Content = "OK" };
    }
}

public sealed record ToolDescriptor(string Name, string Description, ToolExposure Exposure);

public class CatRegistry
{
    Dictionary<string, Cat> _map = new();
    public List<Cat> Cats = new();

    public void Register(Cat cat)
    {
        Cats.Add(cat);
        foreach (var t in cat.Tools) _map[t] = cat;
    }

    public ToolHooks Hooks = new();

    public ToolResult Dispatch(string tool, JsonNode? args) =>
        DispatchAsync(tool, args, CancellationToken.None).GetAwaiter().GetResult();

    public async Task<ToolResult> DispatchAsync(string tool, JsonNode? args, CancellationToken ct)
    {
        args ??= new JsonObject();
        if (_map.TryGetValue(tool, out var cat))
        {
            // Pre hooks
            var (modifiedArgs, blocked) = Hooks.RunPre(tool, args);
            if (blocked != null) return blocked;
            args = modifiedArgs ?? args;
            // Validation
            var validation = cat.ValidateArgs(tool, args);
            if (validation != null) return validation;
            // Execute
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var result = await cat.ExecuteAsync(tool, args, ct).ConfigureAwait(false);
            sw.Stop();
            TrackUsage(tool, sw.ElapsedMilliseconds, result.IsError);
            // Post hooks
            return Hooks.RunPost(tool, args, result);
        }
        return new ToolResult { Content = "ERR unknown tool: " + tool, Error = ErrorKind.InvalidArgument };
    }

    private void TrackUsage(string tool, long durationMs, bool isError)
    {
        try
        {
            string tracePath = Path.Combine("RanParty", ".tool_trace.jsonl");
            var entry = new JsonObject
            {
                ["ts"] = DateTime.Now.ToString("O"),
                ["tool"] = tool,
                ["durationMs"] = durationMs,
                ["error"] = isError
            };
            File.AppendAllText(tracePath, entry.ToJsonString() + "\n");
            // Rotate if > 10000 lines
            if (new FileInfo(tracePath).Length > 2 * 1024 * 1024)
            {
                string archive = Path.Combine("RanParty", ".tool_trace_archive.jsonl");
                File.AppendAllText(archive, File.ReadAllText(tracePath));
                File.WriteAllText(tracePath, "");
            }
        }
        catch { }
    }

    public bool IsParallelSafe(string tool) =>
        _map.TryGetValue(tool, out var cat) && cat.ParallelSafeTools.Contains(tool);

    public IReadOnlyList<ToolDescriptor> SearchDeferredTools(string query)
    {
        query = query?.Trim() ?? "";
        if (query.Length == 0) return Array.Empty<ToolDescriptor>();
        return Cats
            .SelectMany(cat => cat.Schemas.Select(schema => new ToolDescriptor(schema.Key, schema.Value.desc, cat.GetExposure(schema.Key))))
            .Where(tool => tool.Exposure != ToolExposure.Direct
                && (tool.Name.Contains(query, StringComparison.OrdinalIgnoreCase)
                    || tool.Description.Contains(query, StringComparison.OrdinalIgnoreCase)))
            .GroupBy(tool => tool.Name, StringComparer.Ordinal)
            .Select(group => group.First())
            .OrderBy(tool => tool.Name, StringComparer.Ordinal)
            .ToArray();
    }

    public string SchemasJson(ToolExposure maxExposure = ToolExposure.Direct) =>
        SchemasJsonForTurn(Array.Empty<string>(), maxExposure);

    /// <summary>
    /// Builds the schema set for one model turn. Direct tools form the baseline;
    /// deferred/hidden tools are included only when explicitly activated for that
    /// turn (for example, from a preceding tool_search result).
    /// </summary>
    public string SchemasJsonForTurn(IEnumerable<string>? activatedTools, ToolExposure baselineExposure = ToolExposure.Direct)
    {
        var activated = new HashSet<string>(activatedTools ?? Array.Empty<string>(), StringComparer.Ordinal);
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var cat in Cats)
            foreach (var kv in cat.Schemas)
            {
                if (cat.GetExposure(kv.Key) > baselineExposure && !activated.Contains(kv.Key)) continue;
                if (!first) sb.Append(','); first = false;
                sb.Append("{\"type\":\"function\",\"function\":{\"name\":\"").Append(kv.Key)
                  .Append("\",\"description\":\"").Append(kv.Value.desc)
                  .Append("\",\"parameters\":").Append(kv.Value.parms).Append("}}");
            }
        sb.Append(']');
        return sb.ToString();
    }
}
