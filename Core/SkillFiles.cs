using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace RanParty.Core;

/// <summary>Bounded Skill file I/O, frontmatter parsing, and path containment checks.</summary>
internal static class SkillFiles
{
    internal static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    internal static StringComparer PathComparer =>
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint pathLength, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    internal static void EnsureSafePath(string root, string path, bool requireFile)
    {
        string normalizedRoot = NormalizeDirectoryPath(root);
        string normalizedPath = Path.GetFullPath(path);
        StringComparison comparison = PathComparison;
        string containmentPrefix = Path.EndsInDirectorySeparator(normalizedRoot)
            ? normalizedRoot
            : normalizedRoot + Path.DirectorySeparatorChar;
        if (!normalizedPath.Equals(normalizedRoot, comparison)
            && !normalizedPath.StartsWith(containmentPrefix, comparison))
            throw new InvalidDataException("Skill 路径越出允许根目录");

        if (!Directory.Exists(normalizedRoot)) throw new DirectoryNotFoundException(normalizedRoot);
        EnsureNoReparseComponents(normalizedRoot, "Skill 根目录不能经过 reparse point");
        string relative = Path.GetRelativePath(normalizedRoot, normalizedPath);
        string current = normalizedRoot;
        foreach (string part in relative.Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == "..") throw new InvalidDataException("Skill 路径包含父目录跳转");
            current = Path.Combine(current, part);
            if (!File.Exists(current) && !Directory.Exists(current))
            {
                if (requireFile) throw new FileNotFoundException("Skill resource 不存在", current);
                continue;
            }
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Skill resource 路径不能经过 reparse point");
        }
        if (requireFile && !File.Exists(normalizedPath)) throw new FileNotFoundException("Skill resource 不存在", normalizedPath);
    }

    internal static string ReadFrontmatterBlock(string path, int maxBytes)
    {
        using var stream = OpenVerifiedRead(path);
        int capacity = (int)Math.Min(stream.Length, maxBytes + 1L);
        byte[] buffer = new byte[capacity];
        int total = 0;
        while (total < buffer.Length)
        {
            int read = stream.Read(buffer, total, buffer.Length - total);
            if (read == 0) break;
            total += read;
        }
        string prefix;
        try { prefix = new UTF8Encoding(false, true).GetString(buffer, 0, total); }
        catch (DecoderFallbackException) { throw new InvalidDataException("Skill frontmatter is not valid UTF-8"); }
        if (TryExtractFrontmatter(prefix, out string block)) return block;
        string trimmed = prefix.TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
        if (trimmed.StartsWith("---", StringComparison.Ordinal) && stream.Length > maxBytes)
            throw new InvalidDataException($"Skill frontmatter 超过 {maxBytes} 字节上限");
        if (trimmed.StartsWith("---", StringComparison.Ordinal))
            throw new InvalidDataException("Skill frontmatter 缺少结束分隔符");
        return "";
    }

    internal static Dictionary<string, string> ParseFrontmatter(string content)
    {
        if (!TryExtractFrontmatter(content, out string block))
            return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        return ParseFrontmatterBlock(block);
    }

    private static bool TryExtractFrontmatter(string content, out string block)
    {
        block = "";
        string normalized = content.Replace("\r\n", "\n").Replace('\r', '\n')
            .TrimStart('\uFEFF', ' ', '\t', '\n');
        string[] lines = normalized.Split('\n');
        if (lines.Length == 0 || lines[0].Trim() != "---") return false;
        for (int index = 1; index < lines.Length; index++)
        {
            if (lines[index].TrimEnd() != "---" || lines[index].Length != lines[index].TrimStart().Length) continue;
            block = string.Join("\n", lines.Skip(1).Take(index - 1));
            return true;
        }
        return false;
    }

    internal static Dictionary<string, string> ParseFrontmatterBlock(string block)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string[] lines = block.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            string line = lines[index];
            if (string.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith('#')) continue;
            int indent = line.TakeWhile(char.IsWhiteSpace).Count();
            if (indent != 0) continue;
            int colon = line.IndexOf(':');
            if (colon <= 0) continue;
            string key = line[..colon].Trim();
            string value = StripInlineComment(line[(colon + 1)..]).Trim();
            if (value is ">" or "|" or ">-" or "|-" or ">+" or "|+")
            {
                bool folded = value[0] == '>';
                var parts = new List<string>();
                while (index + 1 < lines.Length)
                {
                    string continuation = lines[index + 1];
                    int continuationIndent = continuation.TakeWhile(char.IsWhiteSpace).Count();
                    if (!string.IsNullOrWhiteSpace(continuation) && continuationIndent <= indent) break;
                    index++;
                    parts.Add(continuation.Trim());
                }
                value = folded ? string.Join(" ", parts.Where(part => part.Length > 0)) : string.Join("\n", parts);
            }
            else if (value.Length == 0)
            {
                var items = new List<string>();
                while (index + 1 < lines.Length)
                {
                    string continuation = lines[index + 1];
                    int continuationIndent = continuation.TakeWhile(char.IsWhiteSpace).Count();
                    string trimmed = continuation.Trim();
                    if (string.IsNullOrWhiteSpace(continuation)) { index++; continue; }
                    if (continuationIndent <= indent || !trimmed.StartsWith('-')) break;
                    index++;
                    string item = Unquote(StripInlineComment(trimmed[1..]).Trim());
                    if (item.Length > 0) items.Add(item);
                }
                if (items.Count > 0) value = string.Join(',', items);
            }
            if (!result.TryAdd(key, Unquote(value)))
                throw new InvalidDataException($"Skill frontmatter 包含重复字段: {key}");
        }
        return result;
    }

    internal static string[] ParseStringList(string value)
    {
        value = value.Trim();
        if (value.StartsWith('[') && value.EndsWith(']')) value = value[1..^1];
        return value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(Unquote)
            .Where(IsSafeToolName)
            .Distinct(StringComparer.Ordinal)
            .Take(64)
            .ToArray();
    }

    private static bool IsSafeToolName(string value) => value.Length is > 0 and <= 128
        && value.All(character => char.IsLetterOrDigit(character) || character is '_' or '-' or '.' or ':');

    private static string Unquote(string value)
    {
        value = value.Trim();
        if (value.Length >= 2 && ((value[0] == '"' && value[^1] == '"') || (value[0] == '\'' && value[^1] == '\'')))
            value = value[1..^1];
        return value.Trim();
    }

    private static string StripInlineComment(string value)
    {
        bool singleQuoted = false;
        bool doubleQuoted = false;
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character == '\'' && !doubleQuoted) singleQuoted = !singleQuoted;
            else if (character == '"' && !singleQuoted && (index == 0 || value[index - 1] != '\\')) doubleQuoted = !doubleQuoted;
            else if (character == '#' && !singleQuoted && !doubleQuoted
                && (index == 0 || char.IsWhiteSpace(value[index - 1])))
                return value[..index];
        }
        return value;
    }

    internal static bool TryParseBool(string value, out bool parsed) =>
        bool.TryParse(Unquote(StripInlineComment(value)), out parsed);

    internal static bool ParseBool(string value, bool fallback) =>
        TryParseBool(value, out bool parsed) ? parsed : fallback;

    internal static byte[] ReadAllBytesBounded(string path, long maxBytes)
    {
        if (maxBytes is <= 0 or > int.MaxValue) throw new ArgumentOutOfRangeException(nameof(maxBytes));
        using var stream = OpenVerifiedRead(path);
        if (stream.Length > maxBytes) throw new InvalidDataException($"Skill 文件超过 {maxBytes} 字节上限");
        using var output = new MemoryStream((int)Math.Min(stream.Length, maxBytes));
        byte[] buffer = new byte[16 * 1024];
        long total = 0;
        while (true)
        {
            int read = stream.Read(buffer, 0, buffer.Length);
            if (read == 0) break;
            total += read;
            if (total > maxBytes) throw new InvalidDataException($"Skill 文件在读取期间增长并超过 {maxBytes} 字节上限");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    internal static string ReadUtf8TextBounded(string path, long maxBytes)
    {
        byte[] bytes = ReadAllBytesBounded(path, maxBytes);
        try { return new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException) { throw new InvalidDataException("Skill 文件不是有效 UTF-8 文本"); }
    }

    internal static SkillTreeSummary InspectDirectoryTree(
        string root,
        int maxFiles,
        int maxDirectories,
        long maxFileBytes,
        long maxTotalBytes,
        bool rejectNestedSkills)
    {
        if (maxFiles <= 0 || maxDirectories <= 0 || maxFileBytes <= 0 || maxTotalBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxFiles), "Skill package limits must be positive");

        string normalizedRoot = NormalizeDirectoryPath(root);
        EnsureSafePath(normalizedRoot, normalizedRoot, requireFile: false);

        int fileCount = 0;
        int directoryCount = 0;
        long totalBytes = 0;
        var pending = new Stack<string>();
        pending.Push(normalizedRoot);
        while (pending.Count > 0)
        {
            string directory = pending.Pop();
            EnsureSafePath(normalizedRoot, directory, requireFile: false);
            if (++directoryCount > maxDirectories)
                throw new InvalidDataException($"Skill package 目录数量超过 {maxDirectories} 个上限");

            foreach (string entry in Directory.EnumerateFileSystemEntries(directory))
            {
                string fullPath = Path.GetFullPath(entry);
                EnsureSafePath(normalizedRoot, fullPath, requireFile: false);
                FileAttributes attributes = File.GetAttributes(fullPath);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Skill package 不能包含符号链接或 reparse point");
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    pending.Push(fullPath);
                    continue;
                }

                if (++fileCount > maxFiles)
                    throw new InvalidDataException($"Skill package 文件数量超过 {maxFiles} 个上限");
                VerifyRegularFile(fullPath);
                long length = new FileInfo(fullPath).Length;
                if (length > maxFileBytes)
                    throw new InvalidDataException($"Skill package 文件超过 {maxFileBytes} 字节上限: {Path.GetFileName(fullPath)}");
                totalBytes = checked(totalBytes + length);
                if (totalBytes > maxTotalBytes)
                    throw new InvalidDataException($"Skill package 总大小超过 {maxTotalBytes} 字节上限");

                if (rejectNestedSkills
                    && Path.GetFileName(fullPath).Equals("SKILL.md", PathComparison)
                    && !fullPath.Equals(Path.Combine(normalizedRoot, "SKILL.md"), PathComparison))
                    throw new InvalidDataException("单个 Skill package 不能包含嵌套 SKILL.md");
            }
        }
        return new SkillTreeSummary(fileCount, directoryCount, totalBytes);
    }

    internal static string ComputeFileHash(string path, long maxBytes) =>
        Convert.ToHexString(SHA256.HashData(ReadAllBytesBounded(path, maxBytes))).ToLowerInvariant();

    private static void VerifyRegularFile(string path)
    {
        using FileStream _ = OpenVerifiedRead(path);
    }

    private static FileStream OpenVerifiedRead(string path)
    {
        string requested = Path.GetFullPath(path);
        var stream = new FileStream(requested, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (!OperatingSystem.IsWindows()) return stream;
        try
        {
            var finalPath = new StringBuilder(1024);
            uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, finalPath, (uint)finalPath.Capacity, 0);
            if (length == 0 || length >= finalPath.Capacity) throw new IOException("无法验证 Skill 文件最终路径");
            string resolved = NormalizeWindowsHandlePath(finalPath.ToString());
            if (!string.Equals(requested, resolved, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Skill 文件通过 reparse point 指向了不同位置");
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out ByHandleFileInformation information))
                throw new IOException("无法验证 Skill 文件链接信息", Marshal.GetExceptionForHR(Marshal.GetHRForLastWin32Error()));
            if (information.NumberOfLinks > 1)
                throw new InvalidDataException("Skill 文件不能是指向其他位置的硬链接");
            return stream;
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    private static string NormalizeWindowsHandlePath(string value)
    {
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value[8..];
        else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value[4..];
        return Path.GetFullPath(value);
    }

    private static string NormalizeDirectoryPath(string value)
    {
        string fullPath = Path.GetFullPath(value);
        string pathRoot = Path.GetPathRoot(fullPath) ?? "";
        return fullPath.Length > pathRoot.Length
            ? fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            : fullPath;
    }

    private static void EnsureNoReparseComponents(string path, string message)
    {
        string pathRoot = Path.GetPathRoot(path) ?? throw new InvalidDataException("Skill 根目录无效");
        string current = pathRoot;
        string relative = Path.GetRelativePath(pathRoot, path);
        foreach (string part in relative.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries))
        {
            if (part == "..") throw new InvalidDataException("Skill 根目录包含父目录跳转");
            current = Path.Combine(current, part);
            if (!Directory.Exists(current) && !File.Exists(current))
                throw new DirectoryNotFoundException(current);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException(message);
        }
    }

    internal static string NormalizeRelative(string value)
    {
        value = value.Replace('\\', '/');
        while (value.StartsWith("./", StringComparison.Ordinal)) value = value[2..];
        return value;
    }
}

internal sealed record SkillTreeSummary(int FileCount, int DirectoryCount, long TotalBytes);

[StructLayout(LayoutKind.Sequential)]
internal struct ByHandleFileInformation
{
    public FileAttributes FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
}
