using System.Text.RegularExpressions;

namespace RanParty.Core;

/// <summary>
/// Codex 式 Skill 统一注册表 —— 扫描多个目录树 → 解析 SKILL.md YAML frontmatter → merge 去重。
/// 替代旧的分散式 DiscoverSkills()。
/// </summary>
public partial class SkillRegistry
{
    /// <summary>所有已加载的 skill（含被禁用的）</summary>
    public List<SkillSpec> AllSkills { get; } = new();
    /// <summary>加载中的错误（如 YAML 格式错误）</summary>
    public List<SkillError> Errors { get; } = new();
    /// <summary>显式禁用的 skill 路径集合</summary>
    public HashSet<string> DisabledPaths { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>skill root 定义 —— 统一管理入口，Codex 风格扫描</summary>
    static readonly SkillRoot[] DefaultRoots =
    {
        // 统一 skill 目录（内置 + 已安装）
        new("RanParty/skills",               "内置/已安装", SkillScope.Builtin),
        // 用户全局（Codex 标准目录，跨项目共享）
        new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agents", "skills"), "用户", SkillScope.User),
    };

    /// <summary>重新扫描所有 root，合并去重</summary>
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
                if (!seen.Add(fullPath)) continue; // 去重：同名文件只在第一个 root 生效

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
                        AllowedTools = meta.TryGetValue("allowed-tools", out var tools) ? tools.Split(',', StringSplitOptions.TrimEntries).Select(t => t.Trim()).Where(t => t.Length > 0).ToArray() : Array.Empty<string>(),
                        Disabled = DisabledPaths.Contains(fullPath),
                    });
                }
                catch (Exception ex)
                {
                    Errors.Add(new SkillError { Path = fullPath, Message = ex.Message });
                }
            }
        }

        // 按名称排序
        AllSkills.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
    }

    /// <summary>启用/禁用一个 skill</summary>
    public void SetEnabled(string fullPath, bool enabled)
    {
        fullPath = Path.GetFullPath(fullPath);
        if (enabled) DisabledPaths.Remove(fullPath);
        else DisabledPaths.Add(fullPath);

        var skill = AllSkills.FirstOrDefault(s => string.Equals(s.FullPath, fullPath, StringComparison.OrdinalIgnoreCase));
        if (skill != null) skill.Disabled = !enabled;
    }

    /// <summary>查询启用的 skills</summary>
    public List<SkillSpec> GetEnabled() => AllSkills.Where(s => !s.Disabled).ToList();

    /// <summary>按 ID 查找</summary>
    public SkillSpec? FindById(string id) => AllSkills.FirstOrDefault(s => s.Id == id);

    // ---- 工具函数 ----

    static string DefaultSkillName(string path) =>
        Path.GetFileName(Path.GetDirectoryName(path)) is { Length: > 0 } name ? name : "skill";

    static string Sha256Hex(string input) =>
        Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(input)));

    /// <summary>
    /// 解析 SKILL.md 的 YAML frontmatter（--- 块）。
    /// 只支持简单 key: value 格式，无需引入 YAML 库。
    /// </summary>
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

// ---- 类型 ----

/// <summary>Skill 来源范围</summary>
public enum SkillScope { Builtin, User, Repo }

/// <summary>一个 skill root 定义</summary>
public record SkillRoot(string Path, string Source, SkillScope Scope);

/// <summary>解析后的 skill 规格</summary>
public class SkillSpec
{
    public string Id = "";
    public string Name = "";
    public string Description = "";
    public string Source = "";
    public SkillScope Scope;
    public string FullPath = "";
    public string PathLabel = "";
    /// <summary>skill 声明需要的工具权限</summary>
    public string[] AllowedTools = Array.Empty<string>();
    public bool Disabled;
    // 向后兼容旧的 SkillInfo 记录
    public SkillInfo ToSkillInfo() => new(Id, Name, Description, Source, FullPath, PathLabel);
}

/// <summary>加载错误</summary>
public record SkillError
{
    public string Path = "";
    public string Message = "";
}

// ---- 保持向后兼容的记录类型 ----
public sealed record SkillInfo(string Id, string Name, string Description, string Source, string FullPath, string PathLabel);
internal sealed record MarketplaceSkillInfo(string Id, string Name, string Description, string PluginName, string Marketplace, string Publisher, string Category, string Version, string SkillPath);
