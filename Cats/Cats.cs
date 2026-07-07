using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;

using RanParty.Core;
using RanParty.Tools;
namespace RanParty.Cats;

public enum ErrorKind { None, NotFound, PermissionDenied, Timeout, InvalidArgument, Fatal, Unknown }

public class ToolResult
{
    public string Content = "";
    public bool IsError => Error != ErrorKind.None;
    public ErrorKind Error;
}

public abstract class Cat
{
    public string Name;
    public List<string> Tools = new();
    public Dictionary<string, (string desc, string parms)> Schemas = new();
    public HashSet<string> ParallelSafeTools = new(StringComparer.Ordinal);
    protected void Add(string t, string desc, string parms) { Tools.Add(t); Schemas[t] = (desc, parms); }
    protected void AddParallel(string t) => ParallelSafeTools.Add(t);

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
}

public class IOCat : Cat
{
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

        // Read-only tools are safe for parallel execution
        AddParallel("file_read"); AddParallel("file_read_between"); AddParallel("file_list");
        AddParallel("file_find"); AddParallel("file_tree"); AddParallel("file_read_excel");
        AddParallel("file_read_docx"); AddParallel("now_time"); AddParallel("random_int");
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
                "file_batch" => FileBatch(args?["ops"]?.AsArray()),
                "now_time" => Ok(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")),
                "random_int" => Ok(new Random().Next(I("min"), I("max")).ToString()),
                _ => Err("IOCat unknown tool: " + tool, ErrorKind.InvalidArgument)
            };
        }
        catch (Exception ex) { return Err("ERR " + ex.Message); }
    }

    ToolResult FileBatch(JsonArray ops)
    {
        if (ops == null) return Err("ERR ops is empty");
        var sb = new StringBuilder();
        int i = 0;
        foreach (var op in ops)
        {
            i++;
            string t = op?["tool"]?.GetValue<string>() ?? "";
            var a = op?["args"];
            var r = _reg.Dispatch(t, a);
            sb.AppendLine($"[{i}] {t}: {(r.IsError ? "ERR " : "")}{(r.Content.Length > 100 ? r.Content[..100] + "..." : r.Content)}");
        }
        return Ok(sb.ToString());
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
    ToolResult Guard(string path) => !_cfg.InWhitelist(path) ? Err("ERR path not in whitelist: " + path, ErrorKind.PermissionDenied) : null;

    ToolResult FileRead(string path) => GuardOk(path, p => File.ReadAllText(p));
    ToolResult FileReadBetween(string path, string s1, string s2)
    {
        var g = Guard(path); if (g != null) return g;
        if (!File.Exists(path)) return Err("ERR file not found: " + path, ErrorKind.NotFound);
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
        foreach (var e in Directory.EnumerateFileSystemEntries(path)) sb.AppendLine(Path.GetFileName(e));
        return Ok(sb.ToString());
    }
    ToolResult FileFind(string dir, string pattern)
    {
        var g = Guard(dir); if (g != null) return g;
        if (!Directory.Exists(dir)) return Err("ERR directory not found: " + dir, ErrorKind.NotFound);
        var sb = new StringBuilder();
        foreach (var f in Directory.EnumerateFiles(dir, pattern, SearchOption.AllDirectories)) sb.AppendLine(f);
        return Ok(sb.ToString());
    }
    ToolResult FileTree(string path, int depth)
    {
        var g = Guard(path); if (g != null) return g;
        if (!Directory.Exists(path)) return Err("ERR directory not found: " + path, ErrorKind.NotFound);
        var sb = new StringBuilder();
        void Walk(string p, int d)
        {
            if (d > depth) return;
            foreach (var e in Directory.EnumerateFileSystemEntries(p))
            {
                sb.Append(new string(' ', (d - 1) * 2)).AppendLine(Path.GetFileName(e) + (Directory.Exists(e) ? "/" : ""));
                if (Directory.Exists(e)) Walk(e, d + 1);
            }
        }
        Walk(path, 1); return Ok(sb.ToString());
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
}

public class MdCat : Cat
{
    Config _cfg;
    public MdCat(Config cfg) { _cfg = cfg; Name = "MdCat"; Add("reformat_md", "Plain text to canonical Markdown", "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}"); }

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

public class CatRegistry
{
    Dictionary<string, Cat> _map = new();
    public List<Cat> Cats = new();

    public void Register(Cat cat)
    {
        Cats.Add(cat);
        foreach (var t in cat.Tools) _map[t] = cat;
    }

    public ToolResult Dispatch(string tool, JsonNode args)
    {
        if (_map.TryGetValue(tool, out var cat))
        {
            var validation = cat.ValidateArgs(tool, args);
            if (validation != null) return validation;
            return cat.Execute(tool, args);
        }
        return new ToolResult { Content = "ERR unknown tool: " + tool, Error = ErrorKind.InvalidArgument };
    }

    public bool IsParallelSafe(string tool) =>
        _map.TryGetValue(tool, out var cat) && cat.ParallelSafeTools.Contains(tool);

    public string SchemasJson()
    {
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var cat in Cats)
            foreach (var kv in cat.Schemas)
            {
                if (!first) sb.Append(','); first = false;
                sb.Append("{\"type\":\"function\",\"function\":{\"name\":\"").Append(kv.Key)
                  .Append("\",\"description\":\"").Append(kv.Value.desc)
                  .Append("\",\"parameters\":").Append(kv.Value.parms).Append("}}");
            }
        sb.Append(']');
        return sb.ToString();
    }
}
