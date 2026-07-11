using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RanParty.Core;

public sealed class SkillRegistryOptions
{
    public string DataRoot { get; init; } = Environment.CurrentDirectory;
    public string UserProfileRoot { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    public string ApplicationDataRoot { get; init; } = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
    public int MaxFrontmatterBytes { get; init; } = 64 * 1024;
    public int MaxMarkerBytes { get; init; } = 64 * 1024;
    public long MaxSkillBytes { get; init; } = 2 * 1024 * 1024;
    public long MaxResourceBytes { get; init; } = 1024 * 1024;
    public long MaxCatalogBytesPerSnapshot { get; init; } = 64 * 1024 * 1024;
    public int MaxSkillsPerSnapshot { get; init; } = 4096;
    public int MaxDirectoriesPerSnapshot { get; init; } = 16_384;
    public TimeSpan SnapshotRefreshInterval { get; init; } = TimeSpan.FromSeconds(2);
    public int MaxPackageFiles { get; init; } = 512;
    public int MaxPackageDirectories { get; init; } = 2048;
    public long MaxPackageFileBytes { get; init; } = 8 * 1024 * 1024;
    public long MaxPackageBytes { get; init; } = 50 * 1024 * 1024;
}

public sealed class SkillCatalogSnapshot
{
    private readonly ReadOnlyDictionary<string, SkillDescriptor> _byId;

    public string Workspace { get; }
    public DateTimeOffset CreatedAt { get; }
    public long GlobalGeneration { get; }
    public long WorkspaceGeneration { get; }
    public IReadOnlyList<SkillDescriptor> Skills { get; }
    public IReadOnlyList<SkillError> Errors { get; }

    internal SkillCatalogSnapshot(
        string workspace,
        IEnumerable<SkillDescriptor> skills,
        IEnumerable<SkillError> errors,
        long globalGeneration,
        long workspaceGeneration)
    {
        Workspace = workspace;
        CreatedAt = DateTimeOffset.UtcNow;
        GlobalGeneration = globalGeneration;
        WorkspaceGeneration = workspaceGeneration;
        var skillList = skills.ToList();
        Skills = new ReadOnlyCollection<SkillDescriptor>(skillList);
        Errors = new ReadOnlyCollection<SkillError>(errors.ToList());
        _byId = new ReadOnlyDictionary<string, SkillDescriptor>(skillList.ToDictionary(skill => skill.Id, StringComparer.Ordinal));
    }

    public SkillDescriptor? FindById(string id) => _byId.GetValueOrDefault(id);

    public SkillLevel0Catalog BuildLevel0Catalog(int maxCharacters = 8000)
    {
        maxCharacters = Math.Clamp(maxCharacters, 256, 64_000);
        var included = new List<SkillLevel0Info>();
        var enabled = Skills.Where(skill => !skill.Disabled)
            .OrderBy(skill => skill.InvocationPolicy == SkillInvocationPolicy.AllowImplicit ? 0 : 1)
            .ThenBy(skill => skill.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        int used = 2; // JSON array brackets
        foreach (SkillDescriptor skill in enabled)
        {
            string description = skill.Description.Length <= 320 ? skill.Description : skill.Description[..319] + "…";
            var item = new SkillLevel0Info(skill.Id, skill.CanonicalId, skill.Name, description, skill.Source,
                skill.Scope, skill.PathLabel, skill.Version, skill.ContentHash, skill.Trust,
                skill.InvocationPolicy, skill.AllowedTools);
            int serializedLength = JsonSerializer.Serialize(item).Length + (included.Count > 0 ? 1 : 0);
            if (used + serializedLength > maxCharacters) continue;
            included.Add(item);
            used += serializedLength;
        }
        return new SkillLevel0Catalog(new ReadOnlyCollection<SkillLevel0Info>(included), enabled.Count - included.Count, used, maxCharacters);
    }
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SkillScope { Builtin, User, Repo }
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SkillTrust { Builtin, User, Workspace, Community }
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SkillInvocationPolicy { AllowImplicit, ExplicitOnly }

public sealed record SkillRoot(
    string Path,
    string Source,
    SkillScope Scope,
    string Key = "",
    SkillTrust Trust = SkillTrust.User);

public sealed record SkillDescriptor(
    string Id,
    string CanonicalId,
    string Name,
    string Description,
    string Version,
    string ContentHash,
    string CatalogFingerprint,
    string Source,
    SkillScope Scope,
    SkillTrust Trust,
    SkillInvocationPolicy InvocationPolicy,
    string FullPath,
    string RootPath,
    string PathLabel,
    IReadOnlyList<string> AllowedTools,
    bool Disabled,
    DateTime LastWriteUtc);

public sealed record SkillLevel0Info(
    string Id,
    string CanonicalId,
    string Name,
    string Description,
    string Source,
    SkillScope Scope,
    string PathLabel,
    string Version,
    string ContentHash,
    SkillTrust Trust,
    SkillInvocationPolicy InvocationPolicy,
    IReadOnlyList<string> AllowedTools);

public sealed record SkillLevel0Catalog(
    IReadOnlyList<SkillLevel0Info> Skills,
    int OmittedCount,
    int UsedCharacters,
    int CharacterBudget);

public sealed record SkillDocument(SkillDescriptor Skill, string Content, string ContentHash);
public sealed record SkillResource(SkillDescriptor Skill, string RelativePath, string Content, string ContentHash);
public sealed record SkillPackageValidation(
    SkillDescriptor Skill,
    int FileCount,
    int DirectoryCount,
    long TotalBytes);

/// <summary>Mutable compatibility DTO retained for the existing BackendHost API.</summary>
public class SkillSpec
{
    public string Id = "";
    public string CanonicalId = "";
    public string Name = "";
    public string Description = "";
    public string Version = "";
    public string ContentHash = "";
    public string Source = "";
    public SkillScope Scope;
    public SkillTrust Trust;
    public SkillInvocationPolicy InvocationPolicy;
    public string FullPath = "";
    public string RootPath = "";
    public string PathLabel = "";
    public string[] AllowedTools = Array.Empty<string>();
    public bool Disabled;

    public SkillInfo ToSkillInfo() => new(Id, Name, Description, Source, FullPath, PathLabel,
        Version, ContentHash, CanonicalId, RootPath, Trust, InvocationPolicy, AllowedTools);
}

public record SkillError
{
    public string Path { get; init; } = "";
    public string Message { get; init; } = "";
    public string Code { get; init; } = "";
}

public sealed record SkillInfo(
    string Id,
    string Name,
    string Description,
    string Source,
    string FullPath,
    string PathLabel,
    string Version = "",
    string ContentHash = "",
    string CanonicalId = "",
    string RootPath = "",
    SkillTrust Trust = SkillTrust.User,
    SkillInvocationPolicy InvocationPolicy = SkillInvocationPolicy.AllowImplicit,
    IReadOnlyList<string>? AllowedTools = null);

internal sealed record MarketplaceSkillInfo(
    string Id,
    string Name,
    string Description,
    string PluginName,
    string Marketplace,
    string Publisher,
    string Category,
    string Version,
    string SkillPath);
