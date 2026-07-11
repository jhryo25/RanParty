using System.Text;
using System.Security.Cryptography;
using RanParty.Core;

string sandbox = Path.Combine(Path.GetTempPath(), $"ranparty-skill-registry-{Guid.NewGuid():N}");
string dataRoot = Path.Combine(sandbox, "data");
string userRoot = Path.Combine(sandbox, "user");
string appDataRoot = Path.Combine(sandbox, "appdata");
string repoRoot = Path.Combine(sandbox, "repo");
string workspace = Path.Combine(repoRoot, "src", "service");

try
{
    Directory.CreateDirectory(Path.Combine(repoRoot, ".git"));
    Directory.CreateDirectory(workspace);

    WriteSkill(Path.Combine(dataRoot, "RanParty", "skills", "builtin", "SKILL.md"), """
        ---
        name: builtin-skill
        description: Built in workflow.
        version: 1.0.0
        ---
        # Builtin
        """);

    WriteSkill(Path.Combine(repoRoot, ".agents", "skills", "root-skill", "SKILL.md"), """
        ---
        name: root-skill
        description: Shared repository workflow.
        ---
        # Root
        """);
    WriteSkill(Path.Combine(repoRoot, ".agents", "skills", "root-skill", ".ranparty-market.json"), """
        {"id":"skillhub:market-skill","version":"999.0.0","trust":"Builtin"}
        """);

    string serviceSkillPath = Path.Combine(workspace, ".agents", "skills", "service-skill", "SKILL.md");
    WriteSkill(serviceSkillPath, """
        ---
        name: service-skill
        description: >
          Review this service and
          verify its behavior.
        version: 2.3.4
        allowed-tools:
          - file_read
          - web_search
        allow-implicit-invocation: false # fail closed with YAML comments
        ---
        # Service
        Original body.
        """);
    WriteSkill(Path.Combine(Path.GetDirectoryName(serviceSkillPath)!, "references", "guide.md"), "reference text");

    string installedRoot = Path.Combine(dataRoot, "RanParty", "InstalledSkills", "market-skill");
    string installedSkillPath = Path.Combine(installedRoot, "SKILL.md");
    string installedReferencePath = Path.Combine(installedRoot, "references", "guide.md");
    WriteSkill(installedSkillPath, """
        ---
        name: market-skill
        description: Community workflow.
        allow-implicit-invocation: true
        ---
        # Market
        """);
    WriteSkill(installedReferencePath, "approved market reference");
    string installedSkillHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(installedSkillPath))).ToLowerInvariant();
    string installedTreeHash = ComputeSkillTreeHash(installedRoot);
    WriteSkill(Path.Combine(installedRoot, ".ranparty-market.json"),
        $$"""{"id":"skillhub:market-skill","version":"9.1.0","trust":"Community","skillContentHash":"{{installedSkillHash}}","contentHash":"{{installedTreeHash}}"}""");
    WriteSkill(Path.Combine(dataRoot, "RanParty", "InstalledSkills", ".staging-incomplete", "SKILL.md"), """
        ---
        name: staging-incomplete
        description: Must never leak into the live catalog.
        ---
        # Incomplete
        """);

    WriteSkill(Path.Combine(userRoot, ".agents", "skills", "user-skill", "SKILL.md"), """
        ---
        name: user-skill
        description: User workflow.
        ---
        # User
        """);
    WriteSkill(Path.Combine(userRoot, ".agents", "skills", "user-skill", "agents", "openai.yaml"), """
        policy:
          allow_implicit_invocation: false # safety policy
        """);

    WriteSkill(Path.Combine(repoRoot, ".agents", "skills", "duplicate-repo", "SKILL.md"), """
        ---
        name: duplicate-name
        description: Repository duplicate.
        ---
        # Repo duplicate
        """);
    WriteSkill(Path.Combine(userRoot, ".agents", "skills", "duplicate-user", "SKILL.md"), """
        ---
        name: duplicate-name
        description: User duplicate.
        ---
        # User duplicate
        """);

    string conflictSkillRoot = Path.Combine(workspace, ".agents", "skills", "conflicting-policy");
    WriteSkill(Path.Combine(conflictSkillRoot, "SKILL.md"), """
        ---
        name: conflicting-policy
        description: Conflicting invocation metadata must fail closed.
        allow-implicit-invocation: false
        disable-model-invocation: true
        invocation-policy: implicit
        ---
        # Conflict
        """);
    WriteSkill(Path.Combine(conflictSkillRoot, "agents", "openai.yaml"), """
        policy:
          allow_implicit_invocation: true
        """);

    string oversized = Path.Combine(workspace, ".agents", "skills", "oversized", "SKILL.md");
    WriteSkill(oversized, $"---\nname: oversized\ndescription: {new string('x', 900)}\n---\n# Too large");
    string oversizedPolicy = Path.Combine(workspace, ".agents", "skills", "oversized-policy", "SKILL.md");
    WriteSkill(oversizedPolicy, "---\nname: oversized-policy\ndescription: Policy file is bounded.\n---\n# Policy");
    WriteSkill(Path.Combine(Path.GetDirectoryName(oversizedPolicy)!, "agents", "openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n" + new string('#', 600));

    var registry = new SkillRegistry(new SkillRegistryOptions
    {
        DataRoot = dataRoot,
        UserProfileRoot = userRoot,
        ApplicationDataRoot = appDataRoot,
        MaxFrontmatterBytes = 512,
        MaxSkillBytes = 64 * 1024,
        MaxResourceBytes = 16 * 1024,
        SnapshotRefreshInterval = TimeSpan.FromMilliseconds(75),
    });

    SkillCatalogSnapshot snapshot = registry.Reload(workspace);
    Assert(snapshot.Skills.Any(skill => skill.Name == "root-skill" && skill.Scope == SkillScope.Repo), "repo-root Skill was not discovered");
    SkillDescriptor service = Required(snapshot, "service-skill");
    Assert(service.Scope == SkillScope.Repo && service.Trust == SkillTrust.Workspace, "workspace metadata mismatch");
    Assert(service.Version == "2.3.4", "version metadata missing");
    Assert(service.Description == "Review this service and verify its behavior.", "folded YAML description mismatch");
    Assert(service.AllowedTools.SequenceEqual(["file_read", "web_search"]), "allowed-tools parsing mismatch");
    Assert(service.InvocationPolicy == SkillInvocationPolicy.ExplicitOnly, "explicit invocation policy missing");

    SkillDescriptor market = Required(snapshot, "market-skill");
    Assert(market.Id == "skillhub:market-skill", "market canonical ID did not survive installation");
    Assert(market.Version == "9.1.0", "market marker version missing");
    Assert(market.InvocationPolicy == SkillInvocationPolicy.ExplicitOnly, "community Skill promoted itself to implicit invocation");
    Assert(!snapshot.Skills.Any(skill => skill.Name == "staging-incomplete"), "transaction staging directory leaked into catalog");
    Assert(Required(snapshot, "root-skill").Id != market.Id, "workspace marker hijacked an installed Skill ID");
    SkillDescriptor user = Required(snapshot, "user-skill");
    Assert(user.Trust == SkillTrust.User, "user trust metadata mismatch");
    Assert(user.InvocationPolicy == SkillInvocationPolicy.ExplicitOnly, "agents/openai.yaml invocation policy missing");
    Assert(Required(snapshot, "conflicting-policy").InvocationPolicy == SkillInvocationPolicy.ExplicitOnly,
        "a later implicit policy overrode an earlier invocation deny");

    WriteSkill(Path.Combine(user.RootPath, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: true\n");
    registry.NotifyMutation();
    SkillDescriptor enabledUser = registry.FindDescriptorById(user.Id, workspace)
        ?? throw new InvalidOperationException("mutated user Skill disappeared");
    Assert(enabledUser.InvocationPolicy == SkillInvocationPolicy.AllowImplicit,
        "explicit mutation generation did not refresh policy metadata");
    Assert(registry.GetLevel0Metadata(workspace, 8000).Skills.Any(skill => skill.Id == user.Id
        && skill.InvocationPolicy == SkillInvocationPolicy.AllowImplicit),
        "Level-0 did not refresh after a mutation generation");

    WriteSkill(Path.Combine(user.RootPath, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    await Task.Delay(180);
    Assert(registry.GetLevel0Metadata(workspace, 8000).Skills.First(skill => skill.Id == user.Id).InvocationPolicy
        == SkillInvocationPolicy.ExplicitOnly,
        "Level-0 retained stale implicit policy beyond snapshot TTL");
    var duplicates = snapshot.Skills.Where(skill => skill.Name == "duplicate-name").ToList();
    Assert(duplicates.Count == 2 && duplicates[0].Id != duplicates[1].Id, "same-name Skills were incorrectly merged");
    Assert(snapshot.Errors.Any(error => Path.GetFullPath(error.Path) == Path.GetFullPath(oversized)), "oversized frontmatter was not rejected");
    Assert(snapshot.Errors.Any(error => Path.GetFullPath(error.Path) == Path.GetFullPath(oversizedPolicy)),
        "oversized invocation policy metadata was silently ignored");

    SkillLevel0Catalog level0 = registry.GetLevel0Metadata(workspace, 1200);
    Assert(level0.Skills.Count > 0 && level0.Skills.All(skill => !string.IsNullOrWhiteSpace(skill.Id)
        && !string.IsNullOrWhiteSpace(skill.Name) && !string.IsNullOrWhiteSpace(skill.Description)), "Level-0 metadata missing");
    Assert(level0.Skills.Any(skill => string.IsNullOrWhiteSpace(skill.ContentHash)), "Level-0 unexpectedly hashed full Skill bodies instead of deferring body reads");
    Assert(level0.UsedCharacters <= level0.CharacterBudget, "Level-0 budget exceeded");

    string generatedSkillPath = Path.Combine(workspace, ".agents", "skills", "generation-added", "SKILL.md");
    WriteSkill(generatedSkillPath, "---\nname: generation-added\ndescription: Added after the first snapshot.\n---\n# Added");
    registry.NotifyMutation(workspace);
    Assert(registry.GetSnapshot(workspace).Skills.Any(skill => skill.Name == "generation-added"),
        "workspace mutation generation did not expose a newly added Skill");
    File.Delete(generatedSkillPath);
    registry.NotifyMutation(workspace);
    Assert(registry.GetSnapshot(workspace).Skills.All(skill => skill.Name != "generation-added"),
        "workspace mutation generation did not remove a deleted Skill");

    registry.Reload(workspace);
    string ttlSkillPath = Path.Combine(workspace, ".agents", "skills", "ttl-added", "SKILL.md");
    WriteSkill(ttlSkillPath, "---\nname: ttl-added\ndescription: Discovered by bounded refresh.\n---\n# TTL");
    await Task.Delay(180);
    Assert(registry.GetSnapshot(workspace).Skills.Any(skill => skill.Name == "ttl-added"),
        "new Skill remained permanently hidden behind a negative cache entry");
    File.Delete(ttlSkillPath);
    await Task.Delay(180);
    Assert(registry.GetLevel0Metadata(workspace, 8000).Skills.All(skill => skill.Name != "ttl-added"),
        "deleted Skill remained in Level-0 beyond snapshot TTL");

    SkillDocument body = registry.LoadSkill(service.Id, workspace);
    Assert(body.Content.Contains("Original body."), "on-demand SKILL.md load failed");
    SkillResource resource = registry.LoadResource(service.Id, "references/guide.md", workspace);
    Assert(resource.Content == "reference text" && resource.RelativePath == "references/guide.md", "relative resource load failed");
    AssertThrows<InvalidDataException>(() => registry.LoadResource(service.Id, "../SKILL.md", workspace), "resource traversal was accepted");

    SkillResource marketResource = registry.LoadResource(market.Id, "references/guide.md", workspace);
    Assert(marketResource.Content == "approved market reference", "installed Skill resource load failed before tampering");
    WriteSkill(installedReferencePath, "tampered market reference");
    AssertThrows<InvalidDataException>(() => registry.LoadResource(market.Id, "references/guide.md", workspace),
        "installed Skill loaded a reference after its tree contentHash changed");
    AssertThrows<InvalidDataException>(() => registry.LoadSkill(market.Id, workspace),
        "installed Skill remained loadable after a referenced resource changed");
    WriteSkill(installedReferencePath, "approved market reference");

    string stagedPackage = Path.Combine(sandbox, "staged-package");
    string stagedSkill = Path.Combine(stagedPackage, "SKILL.md");
    WriteSkill(stagedSkill, "---\nname: staged-package\ndescription: Validated before installation.\n---\n# Package");
    string stagedHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(stagedSkill))).ToLowerInvariant();
    string stagedTreeHash = ComputeSkillTreeHash(stagedPackage);
    WriteSkill(Path.Combine(stagedPackage, ".ranparty-market.json"),
        $$"""{"id":"skillhub:staged-package","trust":"community","skillContentHash":"{{stagedHash}}","contentHash":"{{stagedTreeHash}}"}""");
    SkillPackageValidation package = registry.ValidateStagedPackage(stagedPackage);
    Assert(package.Skill.Id == "skillhub:staged-package"
        && package.Skill.Trust == SkillTrust.Community
        && package.Skill.InvocationPolicy == SkillInvocationPolicy.ExplicitOnly,
        "staged package validation did not reuse runtime trust and invocation rules");
    WriteSkill(Path.Combine(stagedPackage, "nested", "SKILL.md"), "---\nname: nested\ndescription: hidden install\n---\n# Nested");
    AssertThrows<InvalidDataException>(() => registry.ValidateStagedPackage(stagedPackage),
        "staged package accepted an undisclosed nested Skill");
    Directory.Delete(Path.Combine(stagedPackage, "nested"), true);
    WriteSkill(stagedSkill, "---\nname: staged-package\ndescription: Tampered after marker.\n---\n# Package");
    AssertThrows<InvalidDataException>(() => registry.ValidateStagedPackage(stagedPackage),
        "staged package accepted a SKILL.md hash mismatch");

    string originalId = service.Id;
    string originalHash = service.ContentHash;
    WriteSkill(serviceSkillPath, File.ReadAllText(serviceSkillPath, Encoding.UTF8).Replace("Original body.", "Updated body."));
    SkillDocument refreshed = registry.LoadSkill(originalId, workspace);
    Assert(refreshed.Skill.Id == originalId, "canonical ID changed after body edit");
    Assert(refreshed.ContentHash != originalHash && refreshed.Content.Contains("Updated body."), "stale Skill body was returned");

    var parsed = SkillRegistry.ParseFrontmatter("""
        ---
        name: parser-check
        description: |
          first line
          second line
        ---
        body
        """);
    Assert(parsed["description"] == "first line\nsecond line", "literal YAML block parsing mismatch");

    SkillCatalogSnapshot[] concurrent = await Task.WhenAll(Enumerable.Range(0, 12)
        .Select(index => Task.Run(() => index % 3 == 0 ? registry.Reload(workspace) : registry.GetSnapshot(workspace))));
    Assert(concurrent.All(item => item.Skills.Count == snapshot.Skills.Count), "concurrent immutable snapshots diverged");

    registry.Reload();
    SkillSpec legacy = registry.FindById("skillhub:market-skill")
        ?? throw new InvalidOperationException("legacy FindById failed");
    SkillInfo legacyInfo = legacy.ToSkillInfo();
    Assert(legacyInfo.Version == "9.1.0" && legacyInfo.Trust == SkillTrust.Community, "legacy compatibility metadata missing");

    TryReparsePointTest(registry, refreshed.Skill, workspace, sandbox);
    Console.WriteLine($"PASS skills={snapshot.Skills.Count} errors={snapshot.Errors.Count} level0={level0.Skills.Count}");
}
finally
{
    try { if (Directory.Exists(sandbox)) Directory.Delete(sandbox, true); } catch { }
}

static SkillDescriptor Required(SkillCatalogSnapshot snapshot, string name) =>
    snapshot.Skills.FirstOrDefault(skill => skill.Name == name)
    ?? throw new InvalidOperationException($"Missing Skill: {name}");

static void WriteSkill(string path, string content)
{
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, content.Replace("\r\n", "\n"), new UTF8Encoding(false));
}

static string ComputeSkillTreeHash(string root)
{
    using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
    foreach (string file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
        .Where(path => !Path.GetFileName(path).Equals(".ranparty-market.json", StringComparison.OrdinalIgnoreCase))
        .OrderBy(path => Path.GetRelativePath(root, path), StringComparer.OrdinalIgnoreCase))
    {
        string relative = Path.GetRelativePath(root, file).Replace('\\', '/');
        hash.AppendData(Encoding.UTF8.GetBytes(relative + "\n"));
        hash.AppendData(File.ReadAllBytes(file));
    }
    return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static void AssertThrows<T>(Action action, string message) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new InvalidOperationException(message);
}

static void TryReparsePointTest(SkillRegistry registry, SkillDescriptor skill, string workspace, string sandbox)
{
    string outside = Path.Combine(sandbox, "outside.md");
    File.WriteAllText(outside, "outside");
    string link = Path.Combine(skill.RootPath, "references", "outside-link.md");
    try
    {
        File.CreateSymbolicLink(link, outside);
        AssertThrows<InvalidDataException>(() => registry.LoadResource(skill.Id, "references/outside-link.md", workspace), "reparse resource was accepted");
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
    {
        // Windows without Developer Mode may not allow creating a test symlink.
    }
}
