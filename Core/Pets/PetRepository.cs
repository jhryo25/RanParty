using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace RanParty.Core.Pets;

public sealed class PetRepository
{
    private const int MaxManifestBytes = 64 * 1024;
    private const int MaxSpritesheetBytes = 20 * 1024 * 1024;
    private const int ExpectedWidth = 1536;
    private const int ExpectedHeight = 2288;
    private static readonly Regex SafeId = new("^[a-z0-9][a-z0-9_-]{0,63}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private readonly string _root;
    private readonly string _configPath;
    private readonly object _sync = new();
    private readonly Action<string, JsonObject> _emit;
    private PetPreferences _preferences;

    public PetRepository(string dataRoot, Action<string, JsonObject> emit)
    {
        _root = Path.GetFullPath(Path.Combine(dataRoot, "RanParty", "Pets"));
        _configPath = Path.GetFullPath(Path.Combine(dataRoot, "Config", "pets.json"));
        _emit = emit;
        Directory.CreateDirectory(_root);
        Directory.CreateDirectory(Path.GetDirectoryName(_configPath) ?? throw new InvalidOperationException("宠物配置目录无效"));
        _preferences = LoadPreferences();
    }

    public string VisionProfileName
    {
        get
        {
            lock (_sync) return _preferences.VisionProfileName;
        }
    }

    public JsonObject ListJson()
    {
        lock (_sync)
        {
            List<PetPackage> packages = DiscoverPackages();
            if (_preferences.ActivePetId.Length > 0 && packages.All(item => item.Id != _preferences.ActivePetId))
            {
                _preferences = _preferences with { ActivePetId = "", Enabled = false };
                SavePreferences();
            }
            return StateJson(packages);
        }
    }

    public JsonObject AssetJson(string id)
    {
        lock (_sync)
        {
            PetPackage package = LoadInstalled(id);
            byte[] bytes = ReadBounded(package.SpritesheetPath, MaxSpritesheetBytes);
            string mime = Path.GetExtension(package.SpritesheetPath).Equals(".png", StringComparison.OrdinalIgnoreCase) ? "image/png" : "image/webp";
            return new JsonObject
            {
                ["id"] = package.Id,
                ["dataUrl"] = $"data:{mime};base64,{Convert.ToBase64String(bytes)}"
            };
        }
    }

    public JsonObject Install(string manifestPath)
    {
        lock (_sync)
        {
            string normalizedManifest = Path.GetFullPath(manifestPath);
            if (!File.Exists(normalizedManifest) || !Path.GetFileName(normalizedManifest).Equals("pet.json", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("请选择 Codex v2 宠物包中的 pet.json");
            string sourceRoot = Path.GetDirectoryName(normalizedManifest) ?? throw new InvalidDataException("宠物包目录无效");
            EnsureOrdinaryDirectory(sourceRoot);
            PetPackage source = LoadPackage(normalizedManifest, sourceRoot);
            string targetRoot = ContainedPetDirectory(source.Id);
            if (Path.GetFullPath(sourceRoot).Equals(targetRoot, PathComparison())) return ListJson();

            string staging = Path.Combine(_root, $".install-{Guid.NewGuid():N}");
            string backup = Path.Combine(_root, $".backup-{Guid.NewGuid():N}");
            bool committed = false;
            Directory.CreateDirectory(staging);
            try
            {
                string assetName = Path.GetExtension(source.SpritesheetPath).Equals(".png", StringComparison.OrdinalIgnoreCase) ? "spritesheet.png" : "spritesheet.webp";
                File.Copy(source.SpritesheetPath, Path.Combine(staging, assetName), overwrite: false);
                var normalized = new JsonObject
                {
                    ["id"] = source.Id,
                    ["displayName"] = source.DisplayName,
                    ["description"] = source.Description,
                    ["spriteVersionNumber"] = 2,
                    ["spritesheetPath"] = assetName
                };
                File.WriteAllText(Path.Combine(staging, "pet.json"), normalized.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
                _ = LoadPackage(Path.Combine(staging, "pet.json"), staging);

                bool hadTarget = Directory.Exists(targetRoot);
                if (hadTarget) Directory.Move(targetRoot, backup);
                try { Directory.Move(staging, targetRoot); committed = true; }
                catch
                {
                    if (hadTarget && Directory.Exists(backup) && !Directory.Exists(targetRoot)) Directory.Move(backup, targetRoot);
                    throw;
                }
                if (Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
                if (_preferences.ActivePetId.Length == 0)
                {
                    _preferences = _preferences with { ActivePetId = source.Id, Enabled = true };
                    SavePreferences();
                }
                JsonObject state = StateJson(DiscoverPackages());
                _emit("pet.changed", state.DeepClone().AsObject());
                return state;
            }
            finally
            {
                if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
                if (committed && Directory.Exists(targetRoot) && Directory.Exists(backup)) Directory.Delete(backup, recursive: true);
            }
        }
    }

    public JsonObject Configure(string? activePetId, bool? enabled, double? scale, string? visionProfileName = null)
    {
        lock (_sync)
        {
            List<PetPackage> packages = DiscoverPackages();
            string selected = activePetId is null ? _preferences.ActivePetId : NormalizeId(activePetId, allowEmpty: true);
            if (selected.Length > 0 && packages.All(item => item.Id != selected)) throw new InvalidOperationException("选择的宠物不存在");
            _preferences = new PetPreferences(
                enabled ?? _preferences.Enabled,
                selected,
                Math.Clamp(scale ?? _preferences.Scale, 0.4, 1.25),
                visionProfileName ?? _preferences.VisionProfileName);
            if (_preferences.ActivePetId.Length == 0) _preferences = _preferences with { Enabled = false };
            SavePreferences();
            JsonObject state = StateJson(packages);
            _emit("pet.changed", state.DeepClone().AsObject());
            return state;
        }
    }

    public JsonObject Delete(string id)
    {
        lock (_sync)
        {
            string normalized = NormalizeId(id);
            string target = ContainedPetDirectory(normalized);
            if (!Directory.Exists(target)) throw new DirectoryNotFoundException("宠物不存在");
            EnsureOrdinaryDirectory(target);
            Directory.Delete(target, recursive: true);
            if (_preferences.ActivePetId == normalized)
            {
                string next = DiscoverPackages().FirstOrDefault()?.Id ?? "";
                _preferences = _preferences with { ActivePetId = next, Enabled = next.Length > 0 && _preferences.Enabled };
            }
            SavePreferences();
            JsonObject state = StateJson(DiscoverPackages());
            _emit("pet.changed", state.DeepClone().AsObject());
            return state;
        }
    }

    private JsonObject StateJson(IReadOnlyList<PetPackage> packages) => new()
    {
        ["settings"] = new JsonObject
        {
            ["enabled"] = _preferences.Enabled,
            ["activePetId"] = _preferences.ActivePetId,
            ["scale"] = _preferences.Scale,
            ["visionProfileName"] = _preferences.VisionProfileName
        },
        ["pets"] = new JsonArray(packages.Select(package => (JsonNode?)new JsonObject
        {
            ["id"] = package.Id,
            ["displayName"] = package.DisplayName,
            ["description"] = package.Description,
            ["spriteVersionNumber"] = 2,
            ["assetFormat"] = Path.GetExtension(package.SpritesheetPath).TrimStart('.').ToLowerInvariant()
        }).ToArray())
    };

    private List<PetPackage> DiscoverPackages()
    {
        var packages = new List<PetPackage>();
        foreach (string directory in Directory.EnumerateDirectories(_root).OrderBy(value => value, PathComparer()).Take(128))
        {
            if (Path.GetFileName(directory).StartsWith(".", StringComparison.Ordinal)) continue;
            try
            {
                EnsureOrdinaryDirectory(directory);
                packages.Add(LoadPackage(Path.Combine(directory, "pet.json"), directory));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidDataException or InvalidOperationException or FormatException)
            {
                // Invalid packages remain isolated on disk and are omitted from the live catalog.
            }
        }
        return packages.OrderBy(item => item.DisplayName, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private PetPackage LoadInstalled(string id)
    {
        string normalized = NormalizeId(id);
        string directory = ContainedPetDirectory(normalized);
        EnsureOrdinaryDirectory(directory);
        PetPackage package = LoadPackage(Path.Combine(directory, "pet.json"), directory);
        if (package.Id != normalized) throw new InvalidDataException("宠物清单 ID 与目录不一致");
        return package;
    }

    private static PetPackage LoadPackage(string manifestPath, string packageRoot)
    {
        byte[] manifestBytes = ReadBounded(manifestPath, MaxManifestBytes);
        string json;
        try { json = new UTF8Encoding(false, true).GetString(manifestBytes); }
        catch (DecoderFallbackException) { throw new InvalidDataException("pet.json 必须是 UTF-8 编码"); }
        JsonObject manifest = JsonNode.Parse(json)?.AsObject() ?? throw new InvalidDataException("pet.json 不是 JSON 对象");
        string id = NormalizeId(manifest["id"]?.GetValue<string>() ?? "");
        string displayName = BoundText(manifest["displayName"]?.GetValue<string>() ?? "", 80, "displayName");
        string description = BoundText(manifest["description"]?.GetValue<string>() ?? "", 300, "description", allowEmpty: true);
        if (manifest["spriteVersionNumber"]?.GetValue<int>() != 2) throw new InvalidDataException("仅支持 spriteVersionNumber: 2");
        string relativeAsset = manifest["spritesheetPath"]?.GetValue<string>() ?? "";
        if (relativeAsset.Length == 0 || Path.GetFileName(relativeAsset) != relativeAsset) throw new InvalidDataException("spritesheetPath 必须是包内文件名");
        string extension = Path.GetExtension(relativeAsset).ToLowerInvariant();
        if (extension is not ".png" and not ".webp") throw new InvalidDataException("宠物图集只支持 PNG 或 WebP");
        string asset = Path.GetFullPath(Path.Combine(packageRoot, relativeAsset));
        string containment = Path.GetFullPath(packageRoot) + Path.DirectorySeparatorChar;
        if (!asset.StartsWith(containment, PathComparison())) throw new InvalidDataException("宠物图集路径越界");
        if (!File.Exists(asset) || (File.GetAttributes(asset) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("宠物图集不存在或使用了链接");
        byte[] header = ReadBounded(asset, MaxSpritesheetBytes);
        (int width, int height) = ImageDimensions(header, extension);
        if (width != ExpectedWidth || height != ExpectedHeight)
            throw new InvalidDataException($"Codex v2 图集必须是 {ExpectedWidth}x{ExpectedHeight}，当前为 {width}x{height}");
        return new PetPackage(id, displayName, description, asset);
    }

    private PetPreferences LoadPreferences()
    {
        try
        {
            if (!File.Exists(_configPath)) return PetPreferences.Default;
            JsonObject value = JsonNode.Parse(File.ReadAllText(_configPath, Encoding.UTF8))?.AsObject() ?? new JsonObject();
            return new PetPreferences(
                value["enabled"]?.GetValue<bool>() ?? false,
                NormalizeId(value["activePetId"]?.GetValue<string>() ?? "", allowEmpty: true),
                Math.Clamp(value["scale"]?.GetValue<double>() ?? 0.62, 0.4, 1.25),
                value["visionProfileName"]?.GetValue<string>() ?? "");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidDataException or InvalidOperationException or FormatException)
        {
            return PetPreferences.Default;
        }
    }

    private void SavePreferences()
    {
        var value = new JsonObject
        {
            ["schemaVersion"] = 1,
            ["enabled"] = _preferences.Enabled,
            ["activePetId"] = _preferences.ActivePetId,
            ["scale"] = _preferences.Scale,
            ["visionProfileName"] = _preferences.VisionProfileName
        };
        string temp = _configPath + $".{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temp, value.ToJsonString(new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        File.Move(temp, _configPath, overwrite: true);
    }

    private string ContainedPetDirectory(string id)
    {
        string target = Path.GetFullPath(Path.Combine(_root, NormalizeId(id)));
        string prefix = _root + Path.DirectorySeparatorChar;
        if (!target.StartsWith(prefix, PathComparison())) throw new InvalidDataException("宠物目录越界");
        return target;
    }

    private static void EnsureOrdinaryDirectory(string path)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException(path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("宠物包目录不能是链接或 reparse point");
    }

    private static byte[] ReadBounded(string path, int maxBytes)
    {
        var info = new FileInfo(path);
        if (!info.Exists || info.Length <= 0 || info.Length > maxBytes) throw new InvalidDataException($"文件为空或超过 {maxBytes / 1024 / 1024}MB 上限");
        return File.ReadAllBytes(path);
    }

    private static (int Width, int Height) ImageDimensions(byte[] bytes, string extension)
    {
        if (extension == ".png")
        {
            if (bytes.Length < 24 || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
                throw new InvalidDataException("PNG 文件头无效");
            return (BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(16, 4)), BinaryPrimitives.ReadInt32BigEndian(bytes.AsSpan(20, 4)));
        }
        if (bytes.Length < 30 || Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF" || Encoding.ASCII.GetString(bytes, 8, 4) != "WEBP")
            throw new InvalidDataException("WebP 文件头无效");
        int offset = 12;
        while (offset + 8 <= bytes.Length)
        {
            string chunk = Encoding.ASCII.GetString(bytes, offset, 4);
            int length = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset + 4, 4));
            int data = offset + 8;
            if (length < 0 || data + length > bytes.Length) throw new InvalidDataException("WebP 数据块长度无效");
            if (chunk == "VP8X" && length >= 10)
                return (1 + UInt24(bytes, data + 4), 1 + UInt24(bytes, data + 7));
            if (chunk == "VP8 " && length >= 10 && bytes[data + 3] == 0x9d && bytes[data + 4] == 0x01 && bytes[data + 5] == 0x2a)
                return ((bytes[data + 6] | bytes[data + 7] << 8) & 0x3fff, (bytes[data + 8] | bytes[data + 9] << 8) & 0x3fff);
            if (chunk == "VP8L" && length >= 5 && bytes[data] == 0x2f)
                return (1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8), 1 + ((bytes[data + 2] & 0xc0) >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10));
            offset = data + length + (length & 1);
        }
        throw new InvalidDataException("无法读取 WebP 画布尺寸");
    }

    private static int UInt24(byte[] bytes, int offset) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    private static string NormalizeId(string value, bool allowEmpty = false)
    {
        value = value.Trim().ToLowerInvariant();
        if (allowEmpty && value.Length == 0) return "";
        if (!SafeId.IsMatch(value)) throw new InvalidDataException("宠物 ID 只能包含小写字母、数字、连字符和下划线，最长 64 字符");
        return value;
    }

    private static string BoundText(string value, int maxLength, string field, bool allowEmpty = false)
    {
        value = value.Trim();
        if ((!allowEmpty && value.Length == 0) || value.Length > maxLength || value.Any(char.IsControl))
            throw new InvalidDataException($"pet.json 的 {field} 无效");
        return value;
    }

    private static StringComparison PathComparison() => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    private static StringComparer PathComparer() => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private sealed record PetPackage(string Id, string DisplayName, string Description, string SpritesheetPath);
    private sealed record PetPreferences(bool Enabled, string ActivePetId, double Scale, string VisionProfileName)
    {
        internal static PetPreferences Default { get; } = new(false, "", 0.62, "");
    }
}
