using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RanParty.Core;

/// <summary>
/// Workspace-aware Skill catalog with immutable snapshots and bounded metadata reads.
/// The legacy Reload/GetEnabled/FindById surface is retained for existing callers.
/// </summary>
public sealed class SkillRegistry
{
    private readonly SkillRegistryOptions _options;
    private readonly ConcurrentDictionary<string, SkillCatalogSnapshot> _snapshots =
        new(SkillFiles.PathComparer);
    private readonly ConcurrentDictionary<string, long> _workspaceGenerations =
        new(SkillFiles.PathComparer);
    private readonly object _disabledLock = new();
    private readonly object _reloadLock = new();
    private long _globalGeneration;

    public IReadOnlyList<SkillSpec> AllSkills { get; private set; } = Array.Empty<SkillSpec>();
    public IReadOnlyList<SkillError> Errors { get; private set; } = Array.Empty<SkillError>();
    private HashSet<string> DisabledPaths { get; } = new(SkillFiles.PathComparer);

    public SkillRegistry(SkillRegistryOptions? options = null)
    {
        _options = NormalizeOptions(options ?? new SkillRegistryOptions());
    }

    /// <summary>Current process-local generation for mutations that affect every workspace.</summary>
    public long MutationGeneration => Volatile.Read(ref _globalGeneration);

    /// <summary>Reloads the compatibility/default catalog rooted at the process data directory.</summary>
    public SkillCatalogSnapshot Reload() => Reload(null);

    /// <summary>Builds and atomically publishes a fresh immutable snapshot for a workspace.</summary>
    public SkillCatalogSnapshot Reload(string? workspace)
    {
        string normalizedWorkspace = NormalizeWorkspace(workspace);
        lock (_reloadLock)
        {
            var snapshot = BuildSnapshot(
                normalizedWorkspace,
                Volatile.Read(ref _globalGeneration),
                GetWorkspaceGeneration(normalizedWorkspace));
            _snapshots[normalizedWorkspace] = snapshot;
            if (IsDefaultWorkspace(normalizedWorkspace)) PublishLegacy(snapshot);
            return snapshot;
        }
    }

    /// <summary>Gets the cached immutable snapshot, building it once when absent.</summary>
    public SkillCatalogSnapshot GetSnapshot(string? workspace = null)
    {
        string normalizedWorkspace = NormalizeWorkspace(workspace);
        if (_snapshots.TryGetValue(normalizedWorkspace, out var cached)
            && IsSnapshotCurrent(cached, normalizedWorkspace)) return cached;
        lock (_reloadLock)
        {
            if (_snapshots.TryGetValue(normalizedWorkspace, out cached)
                && IsSnapshotCurrent(cached, normalizedWorkspace)) return cached;
            var snapshot = BuildSnapshot(
                normalizedWorkspace,
                Volatile.Read(ref _globalGeneration),
                GetWorkspaceGeneration(normalizedWorkspace));
            _snapshots[normalizedWorkspace] = snapshot;
            if (IsDefaultWorkspace(normalizedWorkspace)) PublishLegacy(snapshot);
            return snapshot;
        }
    }

    public void Invalidate(string? workspace = null)
    {
        lock (_reloadLock)
        {
            if (workspace is null)
            {
                Interlocked.Increment(ref _globalGeneration);
                _snapshots.Clear();
                AllSkills = Array.Empty<SkillSpec>();
                Errors = Array.Empty<SkillError>();
                return;
            }
            string normalized = NormalizeWorkspace(workspace);
            _workspaceGenerations.AddOrUpdate(normalized, 1, static (_, current) => checked(current + 1));
            _snapshots.TryRemove(normalized, out _);
            if (IsDefaultWorkspace(normalized))
            {
                AllSkills = Array.Empty<SkillSpec>();
                Errors = Array.Empty<SkillError>();
            }
        }
    }

    /// <summary>
    /// Publishes a mutation generation without forcing an eager rescan. Callers that install,
    /// remove, or rewrite Skills can use this to make the next catalog access refresh immediately.
    /// Pass null when a user/global root changed; pass a workspace for a repository-local change.
    /// </summary>
    public long NotifyMutation(string? workspace = null)
    {
        lock (_reloadLock)
        {
            if (workspace is null)
            {
                long globalGeneration = Interlocked.Increment(ref _globalGeneration);
                AllSkills = Array.Empty<SkillSpec>();
                Errors = Array.Empty<SkillError>();
                return globalGeneration;
            }
            string normalized = NormalizeWorkspace(workspace);
            long workspaceGeneration = _workspaceGenerations.AddOrUpdate(normalized, 1, static (_, current) => checked(current + 1));
            if (IsDefaultWorkspace(normalized))
            {
                AllSkills = Array.Empty<SkillSpec>();
                Errors = Array.Empty<SkillError>();
            }
            return workspaceGeneration;
        }
    }

    public void SetEnabled(string fullPath, bool enabled)
    {
        string normalized = Path.GetFullPath(fullPath);
        lock (_disabledLock)
        {
            if (enabled) DisabledPaths.Remove(normalized);
            else DisabledPaths.Add(normalized);
        }
        Invalidate();
        Reload();
    }

    public List<SkillSpec> GetEnabled() => GetEnabled(null);

    public List<SkillSpec> GetEnabled(string? workspace) => GetSnapshot(workspace).Skills
        .Where(skill => !skill.Disabled)
        .Select(ToCompatibilitySpec)
        .ToList();

    public SkillSpec? FindById(string id) => FindById(id, null);

    public SkillSpec? FindById(string id, string? workspace) =>
        GetFreshDescriptor(id, workspace) is { Disabled: false } skill ? ToCompatibilitySpec(skill) : null;

    public SkillDescriptor? FindDescriptorById(string id, string? workspace = null) =>
        GetFreshDescriptor(id, workspace);

    /// <summary>
    /// Returns bounded Level-0 metadata suitable for an initial model catalog. No Skill body is returned.
    /// </summary>
    public SkillLevel0Catalog GetLevel0Metadata(string? workspace = null, int maxCharacters = 8000) =>
        GetSnapshot(workspace).BuildLevel0Catalog(maxCharacters);

    /// <summary>Loads the selected SKILL.md on demand and refreshes stale metadata automatically.</summary>
    public SkillDocument LoadSkill(string id, string? workspace = null)
    {
        string normalizedWorkspace = NormalizeWorkspace(workspace);
        var descriptor = GetFreshDescriptor(id, normalizedWorkspace)
            ?? throw new KeyNotFoundException($"Skill 不存在: {id}");
        if (descriptor.Disabled) throw new InvalidOperationException($"Skill 已被禁用: {id}");
        var loaded = ReadResource(descriptor, "SKILL.md", _options.MaxSkillBytes);
        if (!string.IsNullOrWhiteSpace(descriptor.ContentHash)
            && !string.Equals(loaded.ContentHash, descriptor.ContentHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"已安装 Skill 内容哈希校验失败: {id}");
        VerifyInstalledTreeIntegrity(descriptor);
        return new SkillDocument(descriptor, loaded.Content, loaded.ContentHash);
    }

    /// <summary>Loads a UTF-8 reference relative to the selected Skill root.</summary>
    public SkillResource LoadResource(string id, string relativePath, string? workspace = null, long? maxBytes = null)
    {
        var descriptor = GetFreshDescriptor(id, workspace)
            ?? throw new KeyNotFoundException($"Skill 不存在: {id}");
        if (descriptor.Disabled) throw new InvalidOperationException($"Skill 已被禁用: {id}");
        long boundedMax = Math.Min(maxBytes ?? _options.MaxResourceBytes, _options.MaxResourceBytes);
        SkillResource resource = ReadResource(descriptor, relativePath, boundedMax);
        VerifyInstalledTreeIntegrity(descriptor);
        return resource;
    }

    /// <summary>
    /// Validates an extracted, single-Skill marketplace package with the same metadata,
    /// marker, hash, UTF-8, path, and size rules used by runtime loading. The directory
    /// is never added to a live catalog.
    /// </summary>
    public SkillPackageValidation ValidateStagedPackage(
        string skillRoot,
        bool requireMarketplaceMarker = true)
    {
        string normalizedRoot = Path.GetFullPath(skillRoot);
        SkillTreeSummary tree = SkillFiles.InspectDirectoryTree(
            normalizedRoot,
            _options.MaxPackageFiles,
            _options.MaxPackageDirectories,
            _options.MaxPackageFileBytes,
            _options.MaxPackageBytes,
            rejectNestedSkills: true);

        string skillPath = Path.Combine(normalizedRoot, "SKILL.md");
        SkillFiles.EnsureSafePath(normalizedRoot, skillPath, requireFile: true);
        string markerPath = Path.Combine(normalizedRoot, ".ranparty-market.json");
        if (requireMarketplaceMarker && !File.Exists(markerPath))
            throw new InvalidDataException("Skill package 缺少 .ranparty-market.json");
        MarkerMetadata marker = MarkerMetadata.Empty;
        if (requireMarketplaceMarker)
        {
            marker = ReadMarker(normalizedRoot);
            if (string.IsNullOrWhiteSpace(marker.Id))
                throw new InvalidDataException("Skill package marker 缺少稳定 id");
            if (string.IsNullOrWhiteSpace(marker.SkillContentHash))
                throw new InvalidDataException("Skill package marker 缺少 SKILL.md 哈希");
            if (string.IsNullOrWhiteSpace(marker.TreeContentHash))
                throw new InvalidDataException("Skill package marker 缺少整树 contentHash");
        }

        var packageRoot = new SkillRoot(
            normalizedRoot,
            "Skill package validation",
            SkillScope.User,
            "installed",
            SkillTrust.Community);
        SkillDescriptor descriptor = ReadDescriptor(packageRoot, skillPath);
        SkillResource document = ReadResource(descriptor, "SKILL.md", _options.MaxSkillBytes);
        if (!string.IsNullOrWhiteSpace(descriptor.ContentHash)
            && !string.Equals(descriptor.ContentHash, document.ContentHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Skill package 的 SKILL.md 哈希与 marker 不一致");
        if (requireMarketplaceMarker)
            VerifyTreeContentHash(normalizedRoot, marker.TreeContentHash, "Skill package 整树 contentHash 与 marker 不一致");

        return new SkillPackageValidation(descriptor, tree.FileCount, tree.DirectoryCount, tree.TotalBytes);
    }

    private SkillCatalogSnapshot BuildSnapshot(
        string normalizedWorkspace,
        long globalGeneration,
        long workspaceGeneration)
    {
        var descriptors = new List<SkillDescriptor>();
        var errors = new List<SkillError>();
        var seenPaths = new HashSet<string>(SkillFiles.PathComparer);
        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        int remainingSkills = _options.MaxSkillsPerSnapshot;
        int remainingDirectories = _options.MaxDirectoriesPerSnapshot;
        long remainingCatalogBytes = _options.MaxCatalogBytesPerSnapshot;

        foreach (var root in BuildRoots(normalizedWorkspace))
        {
            if (!Directory.Exists(root.Path)) continue;
            if (remainingSkills == 0 || remainingDirectories == 0)
            {
                errors.Add(Error(root.Path, "snapshot_limit", "Skill catalog scan budget exhausted"));
                break;
            }
            foreach (string skillPath in EnumerateSkillFiles(root, errors, remainingSkills, ref remainingDirectories))
            {
                string fullPath;
                try { fullPath = Path.GetFullPath(skillPath); }
                catch (Exception ex) { errors.Add(Error(skillPath, "invalid_path", ex.Message)); continue; }
                if (!seenPaths.Add(fullPath)) continue;
                remainingSkills--;
                try
                {
                    SkillFiles.EnsureSafePath(root.Path, fullPath, requireFile: true);
                    long fileLength = new FileInfo(fullPath).Length;
                    if (fileLength > remainingCatalogBytes)
                    {
                        errors.Add(Error(fullPath, "catalog_byte_limit", "Skill catalog byte budget exhausted"));
                        remainingSkills = 0;
                        break;
                    }
                    remainingCatalogBytes -= fileLength;
                    SkillDescriptor descriptor = ReadDescriptor(root, fullPath);
                    if (!seenIds.Add(descriptor.Id))
                    {
                        errors.Add(Error(fullPath, "duplicate_id", $"重复 Skill ID 已被更高优先级来源遮蔽: {descriptor.Id}"));
                        continue;
                    }
                    descriptors.Add(descriptor);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException
                    or JsonException or ArgumentException or NotSupportedException)
                {
                    errors.Add(Error(fullPath, "invalid_skill", ex.Message));
                }
            }
        }

        descriptors.Sort((left, right) =>
        {
            int byName = string.Compare(left.Name, right.Name, StringComparison.OrdinalIgnoreCase);
            if (byName != 0) return byName;
            int byScope = left.Scope.CompareTo(right.Scope);
            return byScope != 0 ? byScope : string.Compare(left.FullPath, right.FullPath, SkillFiles.PathComparison);
        });
        return new SkillCatalogSnapshot(normalizedWorkspace, descriptors, errors, globalGeneration, workspaceGeneration);
    }

    private IReadOnlyList<SkillRoot> BuildRoots(string workspace)
    {
        string configuredBuiltinRoot = Environment.GetEnvironmentVariable("RANPARTY_BUILTIN_SKILLS_ROOT") ?? "";
        string builtinRoot = !string.IsNullOrWhiteSpace(configuredBuiltinRoot) && Directory.Exists(configuredBuiltinRoot)
            ? configuredBuiltinRoot
            : Path.Combine(_options.DataRoot, "RanParty", "skills");
        // Trusted immutable roots win only if a malicious marker deliberately reuses an ID.
        // Same-name Skills are still kept because their canonical IDs differ.
        var roots = new List<SkillRoot>
        {
            new(builtinRoot, "内置", SkillScope.Builtin, "builtin", SkillTrust.Builtin),
        };
        foreach (string directory in WorkspaceDirectories(workspace))
        {
            string rootPath = Path.Combine(directory, ".agents", "skills");
            string repoAnchor = FindRepositoryRoot(directory) ?? directory;
            string relativeAnchor = SkillFiles.NormalizeRelative(Path.GetRelativePath(repoAnchor, directory));
            string key = $"repo:{relativeAnchor}";
            roots.Add(new SkillRoot(rootPath, "工作区", SkillScope.Repo, key, SkillTrust.Workspace));
        }

        roots.Add(new SkillRoot(Path.Combine(_options.UserProfileRoot, ".agents", "skills"), "用户", SkillScope.User, "user", SkillTrust.User));
        roots.Add(new SkillRoot(Path.Combine(_options.DataRoot, "RanParty", "InstalledSkills"), "Skill 市场", SkillScope.User, "installed", SkillTrust.Community));
        roots.Add(new SkillRoot(Path.Combine(_options.ApplicationDataRoot, "LobsterAI", "SKILLs"), "SkillHub CLI", SkillScope.User, "skillhub-cli", SkillTrust.Community));

        return roots.Select(root => root with { Path = Path.GetFullPath(root.Path) })
            .GroupBy(root => root.Path, SkillFiles.PathComparer)
            .Select(group => group.First())
            .ToList();
    }

    private IEnumerable<string> WorkspaceDirectories(string workspace)
    {
        if (!Directory.Exists(workspace)) yield break;
        string? repositoryRoot = FindRepositoryRoot(workspace);
        if (repositoryRoot is null)
        {
            yield return Path.GetFullPath(workspace);
            yield break;
        }

        var current = new DirectoryInfo(workspace);
        while (current is not null)
        {
            yield return current.FullName;
            if (string.Equals(current.FullName, repositoryRoot, SkillFiles.PathComparison)) break;
            current = current.Parent;
        }
    }

    private static string? FindRepositoryRoot(string directory)
    {
        var current = new DirectoryInfo(directory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, ".git")) || Directory.Exists(Path.Combine(current.FullName, ".git")))
                return current.FullName;
            current = current.Parent;
        }
        return null;
    }

    private IReadOnlyList<string> EnumerateSkillFiles(
        SkillRoot root,
        List<SkillError> errors,
        int maxSkills,
        ref int remainingDirectories)
    {
        var found = new List<string>();
        var pending = new Stack<string>();
        pending.Push(root.Path);
        while (pending.Count > 0 && found.Count < maxSkills && remainingDirectories > 0)
        {
            string directory = pending.Pop();
            remainingDirectories--;
            try
            {
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                {
                    errors.Add(Error(directory, "reparse_root", "Skill 扫描根目录不能是 reparse point"));
                    continue;
                }
                string skill = Path.Combine(directory, "SKILL.md");
                if (File.Exists(skill) && (File.GetAttributes(skill) & FileAttributes.ReparsePoint) == 0) found.Add(skill);
                var children = new List<string>();
                foreach (string child in Directory.EnumerateDirectories(directory))
                {
                    string name = Path.GetFileName(child);
                    if (IsIgnoredSkillDirectory(name)) continue;
                    if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) continue;
                    if (children.Count >= remainingDirectories) break;
                    children.Add(child);
                }
                children.Sort(SkillFiles.PathComparer);
                foreach (string child in children)
                {
                    pending.Push(child);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                errors.Add(Error(directory, "scan_failed", ex.Message));
            }
        }
        if (pending.Count > 0)
        {
            string code = remainingDirectories == 0 ? "directory_limit" : "skill_limit";
            errors.Add(Error(root.Path, code, "Skill catalog scan budget exhausted"));
        }
        return found;
    }

    private SkillDescriptor ReadDescriptor(SkillRoot root, string fullPath)
    {
        var file = new FileInfo(fullPath);
        if (file.Length > _options.MaxSkillBytes)
            throw new InvalidDataException($"SKILL.md 超过 {_options.MaxSkillBytes} 字节上限");

        string frontmatter = SkillFiles.ReadFrontmatterBlock(fullPath, _options.MaxFrontmatterBytes);
        var metadata = SkillFiles.ParseFrontmatterBlock(frontmatter);
        bool markerControlsIdentity = root.Key == "installed";
        MarkerMetadata marker = markerControlsIdentity
            ? ReadMarker(Path.GetDirectoryName(fullPath)!)
            : MarkerMetadata.Empty;

        string name = metadata.GetValueOrDefault("name", DefaultSkillName(fullPath)).Trim();
        string description = metadata.GetValueOrDefault("description", "暂无说明").Trim();
        if (string.IsNullOrWhiteSpace(name)) name = DefaultSkillName(fullPath);
        if (string.IsNullOrWhiteSpace(description)) description = "暂无说明";
        if (name.Length > 160) throw new InvalidDataException("Skill name 超过 160 字符上限");
        if (description.Length > 4000) throw new InvalidDataException("Skill description 超过 4000 字符上限");

        string version = metadata.GetValueOrDefault("version", marker.Version).Trim();
        if (version.Length > 128) throw new InvalidDataException("Skill version 超过 128 字符上限");
        string relative = SkillFiles.NormalizeRelative(Path.GetRelativePath(root.Path, fullPath));
        string canonicalId = string.IsNullOrWhiteSpace(marker.Id)
            ? $"{root.Key}:{relative.ToLowerInvariant()}"
            : marker.Id;
        string id = string.IsNullOrWhiteSpace(marker.Id)
            ? Sha256Hex(canonicalId)[..20].ToLowerInvariant()
            : marker.Id;
        string contentHash = marker.SkillContentHash;
        string skillRoot = Path.GetDirectoryName(fullPath)!;
        string catalogFingerprint = ComputeCatalogFingerprint(skillRoot, SkillMetadataStamp(file, frontmatter), markerControlsIdentity);
        SkillTrust trust = EffectiveTrust(root.Trust, marker.Trust);
        SkillInvocationPolicy invocationPolicy = ResolveInvocationPolicy(metadata, skillRoot, trust);
        string[] allowedTools = SkillFiles.ParseStringList(metadata.GetValueOrDefault("allowed-tools",
            metadata.GetValueOrDefault("allowed_tools", "")));
        bool disabled;
        lock (_disabledLock) disabled = DisabledPaths.Contains(fullPath);

        return new SkillDescriptor(
            id,
            canonicalId,
            name,
            description,
            version,
            contentHash,
            catalogFingerprint,
            root.Source,
            root.Scope,
            trust,
            invocationPolicy,
            fullPath,
            skillRoot,
            relative,
            Array.AsReadOnly(allowedTools),
            disabled,
            file.LastWriteTimeUtc);
    }

    private MarkerMetadata ReadMarker(string skillRoot)
    {
        string path = Path.Combine(skillRoot, ".ranparty-market.json");
        if (!File.Exists(path)) return MarkerMetadata.Empty;
        SkillFiles.EnsureSafePath(skillRoot, path, requireFile: true);
        var file = new FileInfo(path);
        if (file.Length > _options.MaxMarkerBytes) throw new InvalidDataException("Skill marker 过大");
        byte[] markerBytes = SkillFiles.ReadAllBytesBounded(path, _options.MaxMarkerBytes);
        int markerOffset = markerBytes.Length >= 3 && markerBytes[0] == 0xEF && markerBytes[1] == 0xBB && markerBytes[2] == 0xBF ? 3 : 0;
        using JsonDocument document = JsonDocument.Parse(
            markerBytes.AsMemory(markerOffset),
            new JsonDocumentOptions { MaxDepth = 16, CommentHandling = JsonCommentHandling.Disallow });
        JsonElement root = document.RootElement;
        string id = JsonString(root, "id").Trim();
        string version = JsonString(root, "version").Trim();
        string skillContentHash = JsonString(root, "skillContentHash").Trim().ToLowerInvariant();
        string treeContentHash = JsonString(root, "contentHash").Trim().ToLowerInvariant();
        SkillTrust? trust = Enum.TryParse<SkillTrust>(JsonString(root, "trust").Trim(), true, out var parsedTrust) ? parsedTrust : null;
        if (id.Length > 256 || id.Any(character => char.IsControl(character) || char.IsWhiteSpace(character)))
            throw new InvalidDataException("Skill marker id 无效");
        if (skillContentHash.Length > 0 && (skillContentHash.Length != 64 || skillContentHash.Any(character => !Uri.IsHexDigit(character))))
            throw new InvalidDataException("Skill marker content hash 无效");
        if (treeContentHash.Length > 0 && (treeContentHash.Length != 64 || treeContentHash.Any(character => !Uri.IsHexDigit(character))))
            throw new InvalidDataException("Skill marker tree contentHash 无效");
        return new MarkerMetadata(id, version, trust, skillContentHash, treeContentHash);
    }

    private void VerifyInstalledTreeIntegrity(SkillDescriptor descriptor)
    {
        if (!IsInsideInstalledRoot(descriptor.FullPath)) return;
        MarkerMetadata marker = ReadMarker(descriptor.RootPath);
        if (string.IsNullOrWhiteSpace(marker.TreeContentHash))
            throw new InvalidDataException($"已安装 Skill 缺少整树 contentHash，请重新安装: {descriptor.Id}");
        VerifyTreeContentHash(descriptor.RootPath, marker.TreeContentHash,
            $"已安装 Skill 整树完整性校验失败: {descriptor.Id}");
    }

    private void VerifyTreeContentHash(string skillRoot, string expectedHash, string failureMessage)
    {
        string actualHash = ComputeTreeContentHash(skillRoot);
        if (!string.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException(failureMessage);
    }

    private string ComputeTreeContentHash(string skillRoot)
    {
        string normalizedRoot = Path.GetFullPath(skillRoot);
        _ = SkillFiles.InspectDirectoryTree(
            normalizedRoot,
            _options.MaxPackageFiles,
            _options.MaxPackageDirectories,
            _options.MaxPackageFileBytes,
            _options.MaxPackageBytes,
            rejectNestedSkills: true);

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        int fileCount = 0;
        long totalBytes = 0;
        foreach (string file in Directory.EnumerateFiles(normalizedRoot, "*", SearchOption.AllDirectories)
            .Where(path => !Path.GetFileName(path).Equals(".ranparty-market.json", StringComparison.OrdinalIgnoreCase))
            .OrderBy(path => Path.GetRelativePath(normalizedRoot, path), StringComparer.OrdinalIgnoreCase))
        {
            if (++fileCount > _options.MaxPackageFiles)
                throw new InvalidDataException($"Skill package 文件数量超过 {_options.MaxPackageFiles} 个上限");
            SkillFiles.EnsureSafePath(normalizedRoot, file, requireFile: true);
            byte[] bytes = SkillFiles.ReadAllBytesBounded(file, _options.MaxPackageFileBytes);
            totalBytes = checked(totalBytes + bytes.Length);
            if (totalBytes > _options.MaxPackageBytes)
                throw new InvalidDataException($"Skill package 总大小超过 {_options.MaxPackageBytes} 字节上限");
            string relative = Path.GetRelativePath(normalizedRoot, file).Replace('\\', '/');
            hash.AppendData(Encoding.UTF8.GetBytes(relative + "\n"));
            hash.AppendData(bytes);
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private SkillInvocationPolicy ResolveInvocationPolicy(
        Dictionary<string, string> metadata,
        string skillRoot,
        SkillTrust trust)
    {
        bool denied = trust == SkillTrust.Community
            || !metadata.TryGetValue("description", out string? declaredDescription)
            || string.IsNullOrWhiteSpace(declaredDescription);

        if (metadata.TryGetValue("allow-implicit-invocation", out string? kebab)
            || metadata.TryGetValue("allow_implicit_invocation", out kebab))
            denied |= !SkillFiles.TryParseBool(kebab, out bool parsedImplicit) || !parsedImplicit;

        if (metadata.TryGetValue("disable-model-invocation", out string? disabled)
            || metadata.TryGetValue("disable_model_invocation", out disabled))
            denied |= !SkillFiles.TryParseBool(disabled, out bool parsedDisabled) || parsedDisabled;

        if (metadata.TryGetValue("invocation-policy", out string? policy)
            || metadata.TryGetValue("invocation_policy", out policy))
        {
            string normalizedPolicy = policy.Trim();
            bool allowsImplicit = normalizedPolicy.Equals("implicit", StringComparison.OrdinalIgnoreCase)
                || normalizedPolicy.Equals("allow-implicit", StringComparison.OrdinalIgnoreCase)
                || normalizedPolicy.Equals("allow_implicit", StringComparison.OrdinalIgnoreCase);
            // Unknown policy values are denied rather than silently widening invocation.
            denied |= !allowsImplicit;
        }

        string openAiMetadata = Path.Combine(skillRoot, "agents", "openai.yaml");
        if (File.Exists(openAiMetadata))
        {
            SkillFiles.EnsureSafePath(skillRoot, openAiMetadata, requireFile: true);
            var file = new FileInfo(openAiMetadata);
            if (file.Length > _options.MaxFrontmatterBytes)
                throw new InvalidDataException($"agents/openai.yaml 超过 {_options.MaxFrontmatterBytes} 字节上限");

            string openAiText = SkillFiles.ReadUtf8TextBounded(openAiMetadata, _options.MaxFrontmatterBytes);
            foreach (string line in openAiText.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
            {
                string trimmed = line.Trim();
                if (!trimmed.StartsWith("allow_implicit_invocation:", StringComparison.OrdinalIgnoreCase)) continue;
                string value = trimmed[(trimmed.IndexOf(':') + 1)..].Trim();
                denied |= !SkillFiles.TryParseBool(value, out bool parsed) || !parsed;
            }
        }

        // Denials are monotonic: later metadata can never re-enable an earlier explicit deny.
        return denied ? SkillInvocationPolicy.ExplicitOnly : SkillInvocationPolicy.AllowImplicit;
    }

    private SkillResource ReadResource(SkillDescriptor descriptor, string relativePath, long maxBytes)
    {
        if (string.IsNullOrWhiteSpace(relativePath)) throw new InvalidDataException("Skill resource path 不能为空");
        if (Path.IsPathRooted(relativePath) || relativePath.IndexOf('\0') >= 0
            || (OperatingSystem.IsWindows() && relativePath.Contains(':')))
            throw new InvalidDataException("Skill resource 必须是安全相对路径");
        string target = Path.GetFullPath(Path.Combine(descriptor.RootPath, relativePath));
        SkillFiles.EnsureSafePath(descriptor.RootPath, target, requireFile: true);
        var file = new FileInfo(target);
        if (file.Length > maxBytes) throw new InvalidDataException($"Skill resource 超过 {maxBytes} 字节上限");
        byte[] bytes = SkillFiles.ReadAllBytesBounded(target, maxBytes);
        string content;
        try { content = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException) { throw new InvalidDataException("Skill resource 不是有效 UTF-8 文本"); }
        if (content.IndexOf('\0') >= 0) throw new InvalidDataException("Skill resource 看起来是二进制文件");
        string hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        return new SkillResource(descriptor, SkillFiles.NormalizeRelative(Path.GetRelativePath(descriptor.RootPath, target)), content, hash);
    }

    public static Dictionary<string, string> ParseFrontmatter(string content) => SkillFiles.ParseFrontmatter(content);

    private static string JsonString(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static SkillTrust EffectiveTrust(SkillTrust rootTrust, SkillTrust? markerTrust)
    {
        if (rootTrust is SkillTrust.Builtin or SkillTrust.Community) return rootTrust;
        // A marker may downgrade a local/workspace Skill, but never promote it.
        return markerTrust == SkillTrust.Community ? SkillTrust.Community : rootTrust;
    }

    private SkillDescriptor? GetFreshDescriptor(string id, string? workspace)
    {
        string normalizedWorkspace = NormalizeWorkspace(workspace);
        SkillDescriptor? descriptor = GetSnapshot(normalizedWorkspace).FindById(id);
        if (descriptor is null || IsDescriptorCurrent(descriptor)) return descriptor;
        return Reload(normalizedWorkspace).FindById(id);
    }

    private bool IsDescriptorCurrent(SkillDescriptor descriptor)
    {
        try
        {
            SkillFiles.EnsureSafePath(descriptor.RootPath, descriptor.FullPath, requireFile: true);
            var file = new FileInfo(descriptor.FullPath);
            string frontmatter = SkillFiles.ReadFrontmatterBlock(descriptor.FullPath, _options.MaxFrontmatterBytes);
            bool includeMarker = IsInsideInstalledRoot(descriptor.FullPath);
            string fingerprint = ComputeCatalogFingerprint(descriptor.RootPath, SkillMetadataStamp(file, frontmatter), includeMarker);
            return string.Equals(fingerprint, descriptor.CatalogFingerprint, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException
            or ArgumentException or NotSupportedException)
        {
            return false;
        }
    }

    private string ComputeCatalogFingerprint(string skillRoot, string skillMetadataStamp, bool includeMarker)
    {
        var value = new StringBuilder("skill:").Append(skillMetadataStamp);
        AppendOptionalFingerprint(value, skillRoot, Path.Combine(skillRoot, "agents", "openai.yaml"),
            "openai", _options.MaxFrontmatterBytes);
        if (includeMarker)
            AppendOptionalFingerprint(value, skillRoot, Path.Combine(skillRoot, ".ranparty-market.json"),
                "marker", _options.MaxMarkerBytes);
        return Sha256Hex(value.ToString()).ToLowerInvariant();
    }

    private static string SkillMetadataStamp(FileInfo file, string frontmatter) =>
        $"{file.Length}:{file.LastWriteTimeUtc.Ticks}:{Sha256Hex(frontmatter)}";

    private static void AppendOptionalFingerprint(
        StringBuilder value,
        string skillRoot,
        string path,
        string label,
        long maxBytes)
    {
        value.Append('\n').Append(label).Append(':');
        if (!File.Exists(path))
        {
            value.Append("missing");
            return;
        }
        SkillFiles.EnsureSafePath(skillRoot, path, requireFile: true);
        value.Append(SkillFiles.ComputeFileHash(path, maxBytes));
    }

    private bool IsInsideInstalledRoot(string path)
    {
        string root = Path.GetFullPath(Path.Combine(_options.DataRoot, "RanParty", "InstalledSkills"))
            .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string candidate = Path.GetFullPath(path);
        return candidate.StartsWith(root + Path.DirectorySeparatorChar, SkillFiles.PathComparison);
    }

    private bool IsSnapshotCurrent(SkillCatalogSnapshot snapshot, string workspace)
    {
        if (snapshot.GlobalGeneration != Volatile.Read(ref _globalGeneration)
            || snapshot.WorkspaceGeneration != GetWorkspaceGeneration(workspace)) return false;
        TimeSpan age = DateTimeOffset.UtcNow - snapshot.CreatedAt;
        return age >= TimeSpan.Zero && age < _options.SnapshotRefreshInterval;
    }

    private long GetWorkspaceGeneration(string workspace) =>
        _workspaceGenerations.TryGetValue(workspace, out long generation) ? generation : 0;

    private static bool IsIgnoredSkillDirectory(string name) =>
        name.Equals("node_modules", StringComparison.OrdinalIgnoreCase)
        || name.Equals(".git", StringComparison.OrdinalIgnoreCase)
        || name.Equals(".archive", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith(".staging-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith(".backup-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith(".trash-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith(".txn-", StringComparison.OrdinalIgnoreCase);

    private static SkillRegistryOptions NormalizeOptions(SkillRegistryOptions options)
    {
        if (string.IsNullOrWhiteSpace(options.DataRoot)
            || string.IsNullOrWhiteSpace(options.UserProfileRoot)
            || string.IsNullOrWhiteSpace(options.ApplicationDataRoot))
            throw new ArgumentException("Skill roots cannot be empty", nameof(options));
        if (options.MaxFrontmatterBytes is <= 0 or >= int.MaxValue
            || options.MaxMarkerBytes is <= 0 or >= int.MaxValue
            || options.MaxSkillBytes is <= 0 or > int.MaxValue
            || options.MaxResourceBytes is <= 0 or > int.MaxValue
            || options.MaxCatalogBytesPerSnapshot <= 0
            || options.MaxSkillsPerSnapshot is <= 0 or > 100_000
            || options.MaxDirectoriesPerSnapshot is <= 0 or > 1_000_000
            || options.SnapshotRefreshInterval <= TimeSpan.Zero
            || options.SnapshotRefreshInterval > TimeSpan.FromMinutes(10)
            || options.MaxPackageFiles is <= 0 or > 100_000
            || options.MaxPackageDirectories is <= 0 or > 1_000_000
            || options.MaxPackageFileBytes is <= 0 or > int.MaxValue
            || options.MaxPackageBytes <= 0
            || options.MaxPackageBytes < options.MaxPackageFileBytes)
            throw new ArgumentOutOfRangeException(nameof(options), "Skill catalog limits must be positive and bounded");

        return new SkillRegistryOptions
        {
            DataRoot = Path.GetFullPath(options.DataRoot),
            UserProfileRoot = Path.GetFullPath(options.UserProfileRoot),
            ApplicationDataRoot = Path.GetFullPath(options.ApplicationDataRoot),
            MaxFrontmatterBytes = options.MaxFrontmatterBytes,
            MaxMarkerBytes = options.MaxMarkerBytes,
            MaxSkillBytes = options.MaxSkillBytes,
            MaxResourceBytes = options.MaxResourceBytes,
            MaxCatalogBytesPerSnapshot = options.MaxCatalogBytesPerSnapshot,
            MaxSkillsPerSnapshot = options.MaxSkillsPerSnapshot,
            MaxDirectoriesPerSnapshot = options.MaxDirectoriesPerSnapshot,
            SnapshotRefreshInterval = options.SnapshotRefreshInterval,
            MaxPackageFiles = options.MaxPackageFiles,
            MaxPackageDirectories = options.MaxPackageDirectories,
            MaxPackageFileBytes = options.MaxPackageFileBytes,
            MaxPackageBytes = options.MaxPackageBytes,
        };
    }

    private string NormalizeWorkspace(string? workspace)
    {
        string candidate = string.IsNullOrWhiteSpace(workspace) ? _options.DataRoot : workspace;
        if (File.Exists(candidate)) candidate = Path.GetDirectoryName(Path.GetFullPath(candidate))!;
        return Path.GetFullPath(candidate);
    }

    private bool IsDefaultWorkspace(string workspace) =>
        string.Equals(workspace, Path.GetFullPath(_options.DataRoot), SkillFiles.PathComparison);

    private void PublishLegacy(SkillCatalogSnapshot snapshot)
    {
        AllSkills = snapshot.Skills.Select(ToCompatibilitySpec).ToArray();
        Errors = snapshot.Errors.Select(error => new SkillError { Path = error.Path, Message = error.Message, Code = error.Code }).ToArray();
    }

    private static SkillSpec ToCompatibilitySpec(SkillDescriptor descriptor) => new()
    {
        Id = descriptor.Id,
        CanonicalId = descriptor.CanonicalId,
        Name = descriptor.Name,
        Description = descriptor.Description,
        Version = descriptor.Version,
        ContentHash = descriptor.ContentHash,
        Source = descriptor.Source,
        Scope = descriptor.Scope,
        Trust = descriptor.Trust,
        InvocationPolicy = descriptor.InvocationPolicy,
        FullPath = descriptor.FullPath,
        RootPath = descriptor.RootPath,
        PathLabel = descriptor.PathLabel,
        AllowedTools = descriptor.AllowedTools.ToArray(),
        Disabled = descriptor.Disabled,
    };

    private static string DefaultSkillName(string path) =>
        Path.GetFileName(Path.GetDirectoryName(path)) is { Length: > 0 } name ? name : "skill";

    private static string Sha256Hex(string input) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input)));

    private static SkillError Error(string path, string code, string message) => new() { Path = path, Code = code, Message = message };

    private sealed record MarkerMetadata(
        string Id,
        string Version,
        SkillTrust? Trust,
        string SkillContentHash,
        string TreeContentHash)
    {
        public static MarkerMetadata Empty { get; } = new("", "", null, "", "");
    }
}
