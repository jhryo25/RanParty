using System.Text.RegularExpressions;

namespace RanParty.Core;

/// <summary>
/// Codex-style Skill registry. It scans standard SKILL.md roots, parses simple
/// YAML frontmatter, merges duplicates by absolute file path, and exposes a
/// stable ID that the renderer can pass back without arbitrary file paths.
/// </summary>
public partial class SkillRegistry
{
    public List<SkillSpec> AllSkills { get; } = new();
    public List<SkillError> Errors { get; } = new();
    public HashSet<string> DisabledPaths { get; } = new(StringComparer.OrdinalIgnoreCase);

    static readonly SkillRoot[] DefaultRoots =
    {
        new(Path.Combine("RanParty", "skills"), "内置", SkillScope.Builtin),
        new(Path.Combine("RanParty", "InstalledSkills"), "Skill 市场", SkillScope.User),
        new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agents", "skills"), "用户", SkillScope.User),
        new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "LobsterAI", "SKILLs"), "SkillHub CLI", SkillScope.User),
    };

    public void Reload()
    {
        AllSkills.Clear();
        Errors.Clear();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var root in DefaultRoots)
        {
            if (!Directory.Exists(root.Path)) continue;
            foreach (var skillPath in Directory.GetFiles(root.Path, "SKILL.md", SearchOption.AllDirectories))
            {
                string fullPath = Path.GetFullPath(skillPath);
                if (fullPath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(part => part.Equals("node_modules", StringComparison.OrdinalIgnoreCase))) continue;
                if (!seen.Add(fullPath)) continue;

                try
                {
                    string content = File.ReadAllText(fullPath);
                    var meta = ParseFrontmatter(content);

                    AllSkills.Add(new SkillSpec
                    {
                        Id = Sha256Hex(fullPath.ToUpperInvariant())[..20].ToLowerInvariant(),
                        Name = meta.GetValueOrDefault("name", DefaultSkillName(fullPath)),
                        Description = meta.GetValueOrDefault("description", "暂无说明"),
                        Source = root.Source,
                        Scope = root.Scope,
                        FullPath = fullPath,
                        PathLabel = Path.Combine(Path.GetFileName(Path.GetDirectoryName(fullPath)) ?? "", Path.GetFileName(fullPath)),
                        AllowedTools = meta.TryGetValue("allowed-tools", out var tools)
                            ? tools.Split(',', StringSplitOptions.TrimEntries).Select(t => t.Trim()).Where(t => t.Length > 0).ToArray()
                            : Array.Empty<string>(),
                        Disabled = DisabledPaths.Contains(fullPath),
                    });
                }
                catch (Exception ex)
                {
                    Errors.Add(new SkillError { Path = fullPath, Message = ex.Message });
                }
            }
        }

        AllSkills.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase));
    }

    public void SetEnabled(string fullPath, bool enabled)
    {
        fullPath = Path.GetFullPath(fullPath);
        if (enabled) DisabledPaths.Remove(fullPath);
        else DisabledPaths.Add(fullPath);

        var skill = AllSkills.FirstOrDefault(s => string.Equals(s.FullPath, fullPath, StringComparison.OrdinalIgnoreCase));
        if (skill != null) skill.Disabled = !enabled;
    }

    public List<SkillSpec> GetEnabled() => AllSkills.Where(s => !s.Disabled).ToList();

    public SkillSpec? FindById(string id) => AllSkills.FirstOrDefault(s => s.Id == id);

    static string DefaultSkillName(string path) =>
        Path.GetFileName(Path.GetDirectoryName(path)) is { Length: > 0 } name ? name : "skill";

    static string Sha256Hex(string input) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(input)));

    public static Dictionary<string, string> ParseFrontmatter(string content)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!content.TrimStart().StartsWith("---")) return result;

        var match = FrontmatterRegex().Match(content);
        if (!match.Success) return result;

        foreach (var line in match.Groups[1].Value.Split('\n'))
        {
            int colon = line.IndexOf(':');
            if (colon < 0) continue;
            string key = line[..colon].Trim();
            string value = line[(colon + 1)..].Trim().Trim('"', '\'');
            if (!string.IsNullOrEmpty(key)) result[key] = value;
        }
        return result;
    }

    [GeneratedRegex(@"^---\s*\n(.*?)\n---", RegexOptions.Singleline)]
    private static partial Regex FrontmatterRegex();
}

public enum SkillScope { Builtin, User, Repo }

public record SkillRoot(string Path, string Source, SkillScope Scope);

public class SkillSpec
{
    public string Id = "";
    public string Name = "";
    public string Description = "";
    public string Source = "";
    public SkillScope Scope;
    public string FullPath = "";
    public string PathLabel = "";
    public string[] AllowedTools = Array.Empty<string>();
    public bool Disabled;

    public SkillInfo ToSkillInfo() => new(Id, Name, Description, Source, FullPath, PathLabel);
}

public record SkillError
{
    public string Path = "";
    public string Message = "";
}

public sealed record SkillInfo(string Id, string Name, string Description, string Source, string FullPath, string PathLabel);
internal sealed record MarketplaceSkillInfo(string Id, string Name, string Description, string PluginName, string Marketplace, string Publisher, string Category, string Version, string SkillPath);
