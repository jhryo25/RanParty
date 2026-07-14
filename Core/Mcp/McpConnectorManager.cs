using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Net;
using System.Net.Sockets;
using ModelContextProtocol.Authentication;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace RanParty.Core.Mcp;

public sealed class McpConnectorManager : IAsyncDisposable
{
    private sealed class OAuthFlow : IDisposable
    {
        public required Uri RedirectUri { get; init; }
        public TaskCompletionSource<Uri> AuthorizationUrl { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public HttpListener Listener { get; } = new();

        public async Task<string?> RedirectAsync(Uri authorizationUri, Uri redirectUri, CancellationToken cancellationToken)
        {
            Listener.Prefixes.Add(redirectUri.GetLeftPart(UriPartial.Path));
            Listener.Start();
            AuthorizationUrl.TrySetResult(authorizationUri);
            using var registration = cancellationToken.Register(() => { try { Listener.Stop(); } catch { } });
            HttpListenerContext context = await Listener.GetContextAsync().WaitAsync(cancellationToken);
            string? code = context.Request.QueryString["code"];
            string? error = context.Request.QueryString["error"];
            byte[] response = Encoding.UTF8.GetBytes(error is null ? "RanParty OAuth authorization completed. You may close this window." : "RanParty OAuth authorization was declined.");
            context.Response.ContentType = "text/plain; charset=utf-8";
            context.Response.ContentLength64 = response.Length;
            await context.Response.OutputStream.WriteAsync(response, cancellationToken);
            context.Response.Close();
            Listener.Stop();
            if (error is not null) throw new InvalidOperationException("OAuth authorization failed: " + error);
            return code;
        }

        public void Dispose() { try { Listener.Close(); } catch { } }
    }

    private sealed class OAuthTokenCache(McpConnectorStore store, string connectorId) : ITokenCache
    {
        public ValueTask StoreTokensAsync(TokenContainer tokens, CancellationToken cancellationToken)
        {
            store.StoreOAuthTokens(connectorId, JsonSerializer.Serialize(tokens, McpConnectorJson.Options));
            return ValueTask.CompletedTask;
        }

        public ValueTask<TokenContainer?> GetTokensAsync(CancellationToken cancellationToken)
        {
            string? json = store.LoadOAuthTokens(connectorId);
            return ValueTask.FromResult(string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<TokenContainer>(json, McpConnectorJson.Options));
        }
    }

    private sealed class Runtime : IAsyncDisposable
    {
        public required string Key { get; init; }
        public required string Fingerprint { get; init; }
        public required McpClient Client { get; init; }
        public SemaphoreSlim Calls { get; } = new(1, 1);
        public DateTime LastUsedUtc { get; set; } = DateTime.UtcNow;
        public List<McpCatalogEntry> Tools { get; set; } = new();
        public List<McpCatalogEntry> Resources { get; set; } = new();
        public List<McpCatalogEntry> Prompts { get; set; } = new();
        public object ActiveSync { get; } = new();
        public string ActiveSessionId { get; set; } = "";
        public int ActiveCalls { get; set; }

        public async ValueTask DisposeAsync()
        {
            Calls.Dispose();
            await Client.DisposeAsync();
        }
    }

    private readonly McpConnectorStore _store;
    private readonly ConcurrentDictionary<string, Runtime> _runtimes = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _errors = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _statuses = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, OAuthFlow> _oauthFlows = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, bool> _oauthAuthenticated = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PendingElicitation> _elicitations = new(StringComparer.Ordinal);
    private readonly Timer _idleTimer;
    private readonly Action<string, JsonObject>? _emit;
    private readonly object _catalogSync = new();
    private readonly string _catalogPath;
    private readonly Func<McpConnectorConfig, string, CreateMessageRequestParams, CancellationToken, Task<CreateMessageResult>>? _sampling;
    private readonly ConcurrentDictionary<string, Queue<DateTime>> _samplingWindows = new(StringComparer.Ordinal);

    private sealed record PendingElicitation(string Id, JsonObject Payload, TaskCompletionSource<ElicitResult> Completion);

    public McpConnectorManager(string configDirectory, Action<string, JsonObject>? emit = null, Func<McpConnectorConfig, string, CreateMessageRequestParams, CancellationToken, Task<CreateMessageResult>>? sampling = null)
    {
        _store = new McpConnectorStore(configDirectory);
        _emit = emit;
        _sampling = sampling;
        _catalogPath = Path.Combine(Path.GetFullPath(configDirectory), "connector-catalog.json");
        _idleTimer = new Timer(_ => _ = ReapIdleAsync(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public IReadOnlyList<McpConnectorView> List()
    {
        var cache = LoadCatalog();
        return _store.List().Select(config => new McpConnectorView
        {
            Config = PublicConfig(config),
            Status = _statuses.TryGetValue(config.Id, out string? status) ? status : (config.Enabled ? "disconnected" : "disabled"),
            LastError = _errors.TryGetValue(config.Id, out string? error) ? Redact(error) : "",
            ToolCount = cache.Count(item => item.ConnectorId == config.Id && item.Entry.Kind == "tool"),
            ResourceCount = cache.Count(item => item.ConnectorId == config.Id && item.Entry.Kind == "resource"),
            PromptCount = cache.Count(item => item.ConnectorId == config.Id && item.Entry.Kind == "prompt"),
            OAuthAuthenticated = _oauthAuthenticated.ContainsKey(config.Id) || _store.LoadOAuthTokens(config.Id) is not null
        }).ToArray();
    }

    public JsonArray ListJson()
    {
        var values = new JsonArray();
        foreach (McpConnectorView view in List())
        {
            JsonObject item = JsonSerializer.SerializeToNode(view.Config, McpConnectorJson.Options)?.AsObject() ?? new JsonObject();
            item["status"] = view.Status;
            item["lastError"] = view.LastError;
            item["toolCount"] = view.ToolCount;
            item["resourceCount"] = view.ResourceCount;
            item["promptCount"] = view.PromptCount;
            item["oauthAuthenticated"] = view.OAuthAuthenticated;
            values.Add(item);
        }
        return values;
    }

    public async Task<McpConnectorConfig> SaveAsync(JsonObject connector, CancellationToken cancellationToken = default)
    {
        var saved = _store.Save(connector);
        await CloseConnectorAsync(saved.Id);
        _statuses[saved.Id] = saved.Enabled ? "disconnected" : "disabled";
        EmitStatus(saved.Id);
        return PublicConfig(saved);
    }

    public async Task DeleteAsync(string id)
    {
        await CloseConnectorAsync(id);
        _store.Delete(id);
        _statuses.TryRemove(id, out _);
        _errors.TryRemove(id, out _);
        SaveCatalog(LoadCatalog().Where(item => item.ConnectorId != id).ToList());
        _emit?.Invoke("connector.catalogChanged", new JsonObject { ["connectorId"] = id, ["deleted"] = true });
    }

    public JsonObject ImportPreview(string format, string content) => _store.ImportPreview(format, content);

    public async Task<JsonObject> ImportApplyAsync(JsonArray connectors, CancellationToken cancellationToken = default)
    {
        var saved = new JsonArray();
        foreach (JsonObject connector in connectors.OfType<JsonObject>())
        {
            connector["enabled"] = false;
            var config = await SaveAsync(connector, cancellationToken);
            saved.Add(JsonSerializer.SerializeToNode(config, McpConnectorJson.Options));
        }
        return new JsonObject { ["connectors"] = saved };
    }

    public async Task<JsonObject> TestAsync(string id, string workspace, CancellationToken cancellationToken = default)
    {
        try
        {
            Runtime runtime = await GetRuntimeAsync(_store.Get(id), workspace, forceReconnect: true, cancellationToken);
            await RefreshCatalogAsync(_store.Get(id), runtime, cancellationToken);
            return new JsonObject
            {
                ["ok"] = true,
                ["status"] = "connected",
                ["message"] = "MCP 握手和能力发现成功",
                ["tools"] = CatalogJson(runtime.Tools),
                ["resources"] = CatalogJson(runtime.Resources),
                ["prompts"] = CatalogJson(runtime.Prompts)
            };
        }
        catch (Exception ex)
        {
            SetError(id, ex);
            return new JsonObject { ["ok"] = false, ["status"] = "error", ["message"] = Redact(ex.Message) };
        }
    }

    public async Task<JsonObject> ToolsAsync(string id, string workspace, bool refresh, CancellationToken cancellationToken = default)
    {
        McpConnectorConfig config = _store.Get(id);
        Runtime runtime = await GetRuntimeAsync(config, workspace, refresh, cancellationToken);
        if (refresh || runtime.Tools.Count == 0) await RefreshCatalogAsync(config, runtime, cancellationToken);
        return new JsonObject { ["connectorId"] = id, ["tools"] = CatalogJson(runtime.Tools) };
    }

    public IReadOnlyList<JsonObject> ToolSchemas(IEnumerable<string>? activatedNames = null)
    {
        var activated = activatedNames?.ToHashSet(StringComparer.Ordinal) ?? new HashSet<string>(StringComparer.Ordinal);
        var configs = _store.List().Where(item => item.Enabled).ToDictionary(item => item.Id, StringComparer.Ordinal);
        var output = new List<JsonObject>();
        foreach (var cached in LoadCatalog().Where(item => item.Entry.Kind == "tool" && configs.ContainsKey(item.ConnectorId)))
        {
            McpConnectorConfig config = configs[cached.ConnectorId];
            var entry = cached.Entry;
            if (!config.EnabledTools.Contains(entry.Name, StringComparer.Ordinal)) continue;
            if (!config.PinnedTools.Contains(entry.Name, StringComparer.Ordinal) && !activated.Contains(entry.ExposedName)) continue;
            output.Add(new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = entry.ExposedName,
                    ["description"] = entry.Description,
                    ["parameters"] = entry.Schema?.DeepClone() ?? new JsonObject { ["type"] = "object" }
                }
            });
        }
        return output;
    }

    public IReadOnlyList<McpCatalogEntry> SearchTools(string query)
    {
        string[] terms = query.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var enabled = _store.List().Where(item => item.Enabled).ToDictionary(item => item.Id, StringComparer.Ordinal);
        return LoadCatalog()
            .Where(item => item.Entry.Kind == "tool" && enabled.TryGetValue(item.ConnectorId, out var config) && config.EnabledTools.Contains(item.Entry.Name, StringComparer.Ordinal))
            .Select(item => item.Entry)
            .Where(entry => terms.Length == 0 || terms.All(term => (entry.Name + " " + entry.Description).Contains(term, StringComparison.OrdinalIgnoreCase)))
            .Take(20).ToArray();
    }

    public bool IsMcpTool(string name) => name.StartsWith("mcp__", StringComparison.Ordinal) &&
        LoadCatalog().Any(item => item.Entry.Kind == "tool" && item.Entry.ExposedName == name);

    public bool IsParallelSafe(string name)
    {
        var cached = LoadCatalog().FirstOrDefault(item => item.Entry.ExposedName == name && item.Entry.Kind == "tool");
        return cached is not null && _store.Get(cached.ConnectorId).SupportsParallelToolCalls;
    }

    public string PolicyFor(string exposedName)
    {
        var cached = LoadCatalog().FirstOrDefault(item => item.Entry.ExposedName == exposedName && item.Entry.Kind == "tool");
        if (cached is null) return "deny";
        var config = _store.Get(cached.ConnectorId);
        return config.ToolPolicies.TryGetValue(cached.Entry.Name, out string? policy) ? policy : config.ApprovalMode;
    }

    public async Task<string> CallToolAsync(string exposedName, JsonNode arguments, string workspace, string sessionId, IProgress<double>? progress, CancellationToken cancellationToken)
    {
        var cached = LoadCatalog().FirstOrDefault(item => item.Entry.ExposedName == exposedName && item.Entry.Kind == "tool")
            ?? throw new InvalidOperationException("MCP 工具不存在或目录已失效");
        McpConnectorConfig config = _store.Get(cached.ConnectorId);
        if (!config.Enabled || !config.EnabledTools.Contains(cached.Entry.Name, StringComparer.Ordinal)) throw new UnauthorizedAccessException("MCP 工具未开放");
        Runtime runtime = await GetRuntimeAsync(config, workspace, false, cancellationToken);
        bool locked = false;
        if (!config.SupportsParallelToolCalls) { await runtime.Calls.WaitAsync(cancellationToken); locked = true; }
        try
        {
            lock (runtime.ActiveSync)
            {
                runtime.ActiveCalls++;
                runtime.ActiveSessionId = runtime.ActiveCalls == 1 ? sessionId : "";
            }
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(config.ToolTimeoutSeconds));
            var values = JsonSerializer.Deserialize<Dictionary<string, object?>>(arguments.ToJsonString()) ?? new();
            var result = await runtime.Client.CallToolAsync(cached.Entry.Name, values, cancellationToken: timeout.Token);
            runtime.LastUsedUtc = DateTime.UtcNow;
            string json = JsonSerializer.Serialize(result, McpConnectorJson.Options);
            return json.Length <= 512 * 1024 ? json : json[..(512 * 1024)] + "\n[结果已截断]";
        }
        finally
        {
            lock (runtime.ActiveSync)
            {
                runtime.ActiveCalls--;
                if (runtime.ActiveCalls == 0) runtime.ActiveSessionId = "";
            }
            if (locked) runtime.Calls.Release();
        }
    }

    public async Task<JsonObject> ResourcesAsync(string id, string workspace, CancellationToken cancellationToken)
    {
        McpConnectorConfig config = _store.Get(id);
        Runtime runtime = await GetRuntimeAsync(config, workspace, false, cancellationToken);
        if (runtime.Resources.Count == 0) await RefreshCatalogAsync(config, runtime, cancellationToken);
        return new JsonObject { ["connectorId"] = id, ["resources"] = CatalogJson(runtime.Resources) };
    }

    public async Task<JsonNode?> ReadResourceAsync(string id, string uri, string workspace, CancellationToken cancellationToken)
    {
        Runtime runtime = await GetRuntimeAsync(_store.Get(id), workspace, false, cancellationToken);
        var result = await runtime.Client.ReadResourceAsync(uri, cancellationToken: cancellationToken);
        string json = JsonSerializer.Serialize(result, McpConnectorJson.Options);
        if (Encoding.UTF8.GetByteCount(json) > 2 * 1024 * 1024) throw new InvalidOperationException("MCP 资源超过 2 MiB 限制");
        return JsonNode.Parse(json);
    }

    public async Task<JsonObject> PromptsAsync(string id, string workspace, CancellationToken cancellationToken)
    {
        McpConnectorConfig config = _store.Get(id);
        Runtime runtime = await GetRuntimeAsync(config, workspace, false, cancellationToken);
        if (runtime.Prompts.Count == 0) await RefreshCatalogAsync(config, runtime, cancellationToken);
        return new JsonObject { ["connectorId"] = id, ["prompts"] = CatalogJson(runtime.Prompts) };
    }

    public async Task<JsonNode?> GetPromptAsync(string id, string name, JsonObject arguments, string workspace, CancellationToken cancellationToken)
    {
        Runtime runtime = await GetRuntimeAsync(_store.Get(id), workspace, false, cancellationToken);
        var values = JsonSerializer.Deserialize<Dictionary<string, object?>>(arguments.ToJsonString()) ?? new();
        var result = await runtime.Client.GetPromptAsync(name, values, cancellationToken: cancellationToken);
        string json = JsonSerializer.Serialize(result, McpConnectorJson.Options);
        if (Encoding.UTF8.GetByteCount(json) > 512 * 1024) throw new InvalidOperationException("MCP 提示词超过 512 KiB 限制");
        return JsonNode.Parse(json);
    }

    public async Task ReconnectAsync(string id, string workspace, CancellationToken cancellationToken)
    {
        await CloseConnectorAsync(id);
        await GetRuntimeAsync(_store.Get(id), workspace, true, cancellationToken);
    }

    public async Task<JsonObject> StartOAuthAsync(string id, string workspace, CancellationToken cancellationToken)
    {
        McpConnectorConfig config = _store.Get(id);
        if (config.Type != "streamable_http" || config.Auth != "oauth") throw new InvalidOperationException("该连接器未配置 OAuth");
        await CloseConnectorAsync(id);
        int port = ReserveLoopbackPort();
        var flow = new OAuthFlow { RedirectUri = new Uri($"http://127.0.0.1:{port}/oauth/callback/") };
        if (_oauthFlows.TryRemove(id, out OAuthFlow? previous)) previous.Dispose();
        _oauthFlows[id] = flow;
        _statuses[id] = "connecting";
        EmitStatus(id);
        _ = Task.Run(async () =>
        {
            try
            {
                Runtime runtime = await GetRuntimeAsync(config, workspace, true, cancellationToken);
                await RefreshCatalogAsync(config, runtime, cancellationToken);
                _oauthAuthenticated[id] = true;
                _statuses[id] = "connected";
                EmitStatus(id);
            }
            catch (Exception ex) { SetError(id, ex); }
            finally { if (_oauthFlows.TryRemove(id, out OAuthFlow? completed)) completed.Dispose(); }
        }, CancellationToken.None);
        Uri authorizationUrl = await flow.AuthorizationUrl.Task.WaitAsync(TimeSpan.FromSeconds(config.ConnectTimeoutSeconds), cancellationToken);
        return new JsonObject { ["authorizationUrl"] = authorizationUrl.ToString(), ["status"] = "authorization_required" };
    }

    public async Task LogoutOAuthAsync(string id)
    {
        await CloseConnectorAsync(id);
        _oauthAuthenticated.TryRemove(id, out _);
        _store.ClearOAuthTokens(id);
        if (_oauthFlows.TryRemove(id, out OAuthFlow? flow)) flow.Dispose();
        _statuses[id] = "disconnected";
        EmitStatus(id);
    }

    public JsonObject OAuthStatus(string id) => new()
    {
        ["authenticated"] = _oauthAuthenticated.ContainsKey(id) || _store.LoadOAuthTokens(id) is not null,
        ["status"] = _oauthAuthenticated.ContainsKey(id) || _store.LoadOAuthTokens(id) is not null ? "authenticated" : (_oauthFlows.ContainsKey(id) ? "pending" : "signed_out")
    };

    private async Task<Runtime> GetRuntimeAsync(McpConnectorConfig config, string workspace, bool forceReconnect, CancellationToken cancellationToken)
    {
        string normalizedWorkspace = NormalizeWorkspace(workspace);
        string key = config.Id + "|" + normalizedWorkspace;
        if (forceReconnect && _runtimes.TryRemove(key, out Runtime? old)) await old.DisposeAsync();
        if (_runtimes.TryGetValue(key, out Runtime? existing) && existing.Fingerprint == config.TrustFingerprint)
        {
            existing.LastUsedUtc = DateTime.UtcNow;
            return existing;
        }
        _statuses[config.Id] = "connecting";
        EmitStatus(config.Id);
        try
        {
            IClientTransport transport = CreateTransport(config);
            Runtime? runtimeReference = null;
            var notifications = new Dictionary<string, Func<JsonRpcNotification, CancellationToken, ValueTask>>
            {
                ["notifications/tools/list_changed"] = (_, token) => QueueCatalogRefreshAsync(config, runtimeReference, token),
                ["notifications/resources/list_changed"] = (_, token) => QueueCatalogRefreshAsync(config, runtimeReference, token),
                ["notifications/prompts/list_changed"] = (_, token) => QueueCatalogRefreshAsync(config, runtimeReference, token),
                ["notifications/message"] = (notification, _) =>
                {
                    _emit?.Invoke("connector.log", new JsonObject { ["connectorId"] = config.Id, ["level"] = "server", ["message"] = Redact(notification.ToString() ?? "") });
                    return ValueTask.CompletedTask;
                }
            };
            var handlers = new McpClientHandlers
            {
                NotificationHandlers = notifications,
                RootsHandler = (_, _) => ValueTask.FromResult(new ListRootsResult
                {
                    Roots = string.IsNullOrWhiteSpace(normalizedWorkspace) || runtimeReference?.ActiveCalls != 1
                        ? new List<Root>()
                        : new List<Root> { new() { Uri = new Uri(normalizedWorkspace).AbsoluteUri, Name = Path.GetFileName(normalizedWorkspace) } }
                }),
                ElicitationHandler = (request, token) => request is null
                    ? ValueTask.FromException<ElicitResult>(new InvalidOperationException("Elicitation 请求为空"))
                    : HandleElicitationAsync(config, runtimeReference, request, token)
            };
            if (config.Sampling.Enabled && _sampling is not null)
                handlers.SamplingHandler = (request, _, token) => request is null
                    ? ValueTask.FromException<CreateMessageResult>(new InvalidOperationException("Sampling 请求为空"))
                    : HandleSamplingAsync(config, runtimeReference, request, token);
            var options = new McpClientOptions { InitializationTimeout = TimeSpan.FromSeconds(config.ConnectTimeoutSeconds), Handlers = handlers };
            McpClient client = await McpClient.CreateAsync(transport, options, cancellationToken: cancellationToken);
            var runtime = new Runtime { Key = key, Fingerprint = config.TrustFingerprint, Client = client };
            runtimeReference = runtime;
            if (!_runtimes.TryAdd(key, runtime))
            {
                await runtime.DisposeAsync();
                return _runtimes[key];
            }
            _errors.TryRemove(config.Id, out _);
            _statuses[config.Id] = "connected";
            EmitStatus(config.Id);
            return runtime;
        }
        catch (Exception ex) { SetError(config.Id, ex); throw; }
    }

    private IClientTransport CreateTransport(McpConnectorConfig config)
    {
        if (config.Type == "stdio")
        {
            var environment = StdioClientTransportOptions.GetDefaultEnvironmentVariables();
            foreach (var pair in _store.ResolveEnvironment(config)) environment[pair.Key] = pair.Value;
            var launcher = ManagedStdioLauncher.CreateCommand(config.Command, config.Args);
            return new StdioClientTransport(new StdioClientTransportOptions
            {
                Name = config.Name,
                Command = launcher.Command,
                Arguments = launcher.Arguments,
                WorkingDirectory = string.IsNullOrWhiteSpace(config.Cwd) ? null : config.Cwd,
                InheritEnvironmentVariables = false,
                EnvironmentVariables = environment,
                ShutdownTimeout = TimeSpan.FromSeconds(3),
                StandardErrorLines = line => CaptureStderr(config.Id, line)
            });
        }

        var handler = new HttpClientHandler { AllowAutoRedirect = false, AutomaticDecompression = System.Net.DecompressionMethods.All };
        var http = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan, MaxResponseContentBufferSize = 4 * 1024 * 1024 };
        var headers = _store.ResolveHeaders(config).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
        var transportOptions = new HttpClientTransportOptions
        {
            Name = config.Name,
            Endpoint = new Uri(config.Url),
            TransportMode = HttpTransportMode.StreamableHttp,
            ConnectionTimeout = TimeSpan.FromSeconds(config.ConnectTimeoutSeconds),
            AdditionalHeaders = headers
        };
        if (config.Auth == "oauth")
        {
            _oauthFlows.TryGetValue(config.Id, out OAuthFlow? flow);
            if (flow is null && _store.LoadOAuthTokens(config.Id) is null) throw new InvalidOperationException("OAuth 需要从连接器设置中发起登录");
            transportOptions.OAuth = new ClientOAuthOptions
            {
                RedirectUri = flow?.RedirectUri ?? new Uri("http://127.0.0.1:1/oauth/callback/"),
                Scopes = config.Scopes,
                AuthorizationRedirectDelegate = flow is not null ? flow.RedirectAsync : (_, _, _) => throw new InvalidOperationException("OAuth 会话已过期，请重新登录"),
                TokenCache = new OAuthTokenCache(_store, config.Id)
            };
        }
        return new HttpClientTransport(transportOptions, http, ownsHttpClient: true);
    }

    private async Task RefreshCatalogAsync(McpConnectorConfig config, Runtime runtime, CancellationToken cancellationToken)
    {
        var tools = await runtime.Client.ListToolsAsync(cancellationToken: cancellationToken);
        runtime.Tools = tools.Select(tool => new McpCatalogEntry
        {
            Kind = "tool",
            Name = tool.Name,
            ExposedName = ExposedName(config, tool.Name, false),
            Title = tool.Title ?? "",
            Description = tool.Description ?? "",
            Schema = JsonNode.Parse(tool.JsonSchema.GetRawText()),
            Annotations = JsonSerializer.SerializeToNode(tool.ProtocolTool.Annotations, McpConnectorJson.Options),
            Enabled = config.EnabledTools.Contains(tool.Name, StringComparer.Ordinal),
            Pinned = config.PinnedTools.Contains(tool.Name, StringComparer.Ordinal)
        }).ToList();
        try
        {
            var resources = await runtime.Client.ListResourcesAsync(cancellationToken: cancellationToken);
            runtime.Resources = resources.Select(resource => FromSerialized("resource", resource)).ToList();
        }
        catch { runtime.Resources = new(); }
        try
        {
            var prompts = await runtime.Client.ListPromptsAsync(cancellationToken: cancellationToken);
            runtime.Prompts = prompts.Select(prompt => FromSerialized("prompt", prompt)).ToList();
        }
        catch { runtime.Prompts = new(); }
        var catalog = LoadCatalog().Where(item => item.ConnectorId != config.Id).ToList();
        catalog.AddRange(runtime.Tools.Concat(runtime.Resources).Concat(runtime.Prompts).Select(entry => new CachedEntry(config.Id, entry)));
        ResolveToolNameCollisions(catalog);
        runtime.Tools = catalog.Where(item => item.ConnectorId == config.Id && item.Entry.Kind == "tool").Select(item => item.Entry).ToList();
        SaveCatalog(catalog);
        _emit?.Invoke("connector.catalogChanged", new JsonObject { ["connectorId"] = config.Id });
    }

    private ValueTask QueueCatalogRefreshAsync(McpConnectorConfig config, Runtime? runtime, CancellationToken cancellationToken)
    {
        if (runtime is null) return ValueTask.CompletedTask;
        _ = Task.Run(async () =>
        {
            try { await RefreshCatalogAsync(config, runtime, cancellationToken); }
            catch (Exception ex) { SetError(config.Id, ex); }
        }, CancellationToken.None);
        return ValueTask.CompletedTask;
    }

    private async ValueTask<ElicitResult> HandleElicitationAsync(McpConnectorConfig config, Runtime? runtime, ElicitRequestParams request, CancellationToken cancellationToken)
    {
        string sessionId;
        lock (runtime?.ActiveSync ?? new object())
        {
            if (runtime is null || runtime.ActiveCalls != 1 || string.IsNullOrWhiteSpace(runtime.ActiveSessionId))
                throw new InvalidOperationException("无法确定 Elicitation 所属的唯一活动调用");
            sessionId = runtime.ActiveSessionId;
        }
        string id = string.IsNullOrWhiteSpace(request.ElicitationId) ? Guid.NewGuid().ToString("N") : request.ElicitationId;
        var payload = new JsonObject
        {
            ["elicitationId"] = id,
            ["connectorId"] = config.Id,
            ["sessionId"] = sessionId,
            ["mode"] = request.Mode,
            ["message"] = request.Message,
            ["url"] = request.Url,
            ["requestedSchema"] = JsonSerializer.SerializeToNode(request.RequestedSchema, McpConnectorJson.Options)
        };
        var pending = new PendingElicitation(id, payload, new TaskCompletionSource<ElicitResult>(TaskCreationOptions.RunContinuationsAsynchronously));
        if (!_elicitations.TryAdd(id, pending)) throw new InvalidOperationException("重复的 Elicitation ID");
        _emit?.Invoke("elicitation.requested", payload.DeepClone().AsObject());
        using var registration = cancellationToken.Register(() => pending.Completion.TrySetCanceled(cancellationToken));
        try { return await pending.Completion.Task; }
        finally { _elicitations.TryRemove(id, out _); }
    }

    private async ValueTask<CreateMessageResult> HandleSamplingAsync(McpConnectorConfig config, Runtime? runtime, CreateMessageRequestParams request, CancellationToken cancellationToken)
    {
        string sessionId;
        lock (runtime?.ActiveSync ?? new object())
        {
            if (runtime is null || runtime.ActiveCalls != 1 || string.IsNullOrWhiteSpace(runtime.ActiveSessionId))
                throw new InvalidOperationException("无法确定 Sampling 所属的唯一活动调用");
            sessionId = runtime.ActiveSessionId;
        }
        if (!config.Sampling.Enabled || _sampling is null) throw new InvalidOperationException("该连接器未启用 Sampling");
        if (request.MaxTokens > config.Sampling.MaxTokens) request.MaxTokens = config.Sampling.MaxTokens;
        if (request.Tools is { Count: > 0 }) throw new InvalidOperationException("RanParty MCP Sampling 不允许工具轮次");
        var window = _samplingWindows.GetOrAdd(config.Id, _ => new Queue<DateTime>());
        lock (window)
        {
            DateTime cutoff = DateTime.UtcNow.AddMinutes(-1);
            while (window.Count > 0 && window.Peek() < cutoff) window.Dequeue();
            if (window.Count >= config.Sampling.RequestsPerMinute) throw new InvalidOperationException("MCP Sampling 已达到每分钟限额");
            window.Enqueue(DateTime.UtcNow);
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(config.Sampling.TimeoutSeconds));
        _emit?.Invoke("connector.sampling", new JsonObject { ["connectorId"] = config.Id, ["sessionId"] = sessionId, ["maxTokens"] = request.MaxTokens });
        return await _sampling(config, sessionId, request, timeout.Token);
    }

    public JsonArray PendingElicitations() => new(_elicitations.Values.Select(item => (JsonNode?)item.Payload.DeepClone()).ToArray());

    public JsonObject RespondElicitation(string id, string action, JsonObject? content)
    {
        if (!_elicitations.TryGetValue(id, out PendingElicitation? pending)) throw new InvalidOperationException("Elicitation 已结束或不存在");
        action = action is "accept" or "decline" ? action : "cancel";
        var values = content is null ? null : JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(content.ToJsonString());
        pending.Completion.TrySetResult(new ElicitResult { Action = action, Content = values });
        return new JsonObject { ["accepted"] = true };
    }

    private static McpCatalogEntry FromSerialized(string kind, object value)
    {
        JsonObject node = JsonSerializer.SerializeToNode(value, McpConnectorJson.Options)?.AsObject() ?? new JsonObject();
        string name = node["name"]?.GetValue<string>() ?? node["uri"]?.GetValue<string>() ?? "";
        return new McpCatalogEntry { Kind = kind, Name = name, Title = node["title"]?.GetValue<string>() ?? "", Description = node["description"]?.GetValue<string>() ?? "", Schema = node };
    }

    private string ExposedName(McpConnectorConfig config, string tool, bool forceHash)
    {
        string connector = Clean(config.Name);
        string cleanedTool = Clean(tool);
        string name = $"mcp__{connector}__{cleanedTool}";
        if (!forceHash && name.Length <= 64) return name;
        string hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(config.Id + "\n" + tool))).ToLowerInvariant()[..8];
        return name[..Math.Min(55, name.Length)] + "_" + hash;
    }

    private void ResolveToolNameCollisions(List<CachedEntry> catalog)
    {
        foreach (var group in catalog.Where(item => item.Entry.Kind == "tool").GroupBy(item => item.Entry.ExposedName, StringComparer.Ordinal).Where(group => group.Count() > 1))
        {
            foreach (CachedEntry item in group)
            {
                McpConnectorConfig config = _store.Get(item.ConnectorId);
                item.Entry.ExposedName = ExposedName(config, item.Entry.Name, true);
            }
        }
    }

    private static string Clean(string value)
    {
        string clean = Regex.Replace(value.Trim().ToLowerInvariant(), "[^a-z0-9_]+", "_").Trim('_');
        return string.IsNullOrEmpty(clean) ? "connector" : clean;
    }

    private static JsonArray CatalogJson(IEnumerable<McpCatalogEntry> entries) => new(entries.Select(entry => JsonSerializer.SerializeToNode(entry, McpConnectorJson.Options)).ToArray());

    private sealed record CachedEntry(string ConnectorId, McpCatalogEntry Entry);

    private List<CachedEntry> LoadCatalog()
    {
        lock (_catalogSync)
        {
            try
            {
                if (!File.Exists(_catalogPath) || new FileInfo(_catalogPath).Length > 4 * 1024 * 1024) return new();
                return JsonSerializer.Deserialize<List<CachedEntry>>(File.ReadAllText(_catalogPath), McpConnectorJson.Options) ?? new();
            }
            catch { return new(); }
        }
    }

    private void SaveCatalog(List<CachedEntry> catalog)
    {
        lock (_catalogSync)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_catalogPath)!);
            string temporary = _catalogPath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(catalog.Take(2048), McpConnectorJson.Options), new UTF8Encoding(false));
            File.Move(temporary, _catalogPath, true);
        }
    }

    private static McpConnectorConfig PublicConfig(McpConnectorConfig source)
    {
        var clone = JsonSerializer.Deserialize<McpConnectorConfig>(JsonSerializer.Serialize(source, McpConnectorJson.Options), McpConnectorJson.Options)!;
        clone.EnvSecretRefs = clone.EnvSecretRefs.Keys.ToDictionary(key => key, _ => "********", StringComparer.OrdinalIgnoreCase);
        clone.HeaderSecretRefs = clone.HeaderSecretRefs.Keys.ToDictionary(key => key, _ => "********", StringComparer.OrdinalIgnoreCase);
        return clone;
    }

    private async Task CloseConnectorAsync(string id)
    {
        foreach (var pair in _runtimes.Where(pair => pair.Key.StartsWith(id + "|", StringComparison.Ordinal)).ToArray())
            if (_runtimes.TryRemove(pair.Key, out Runtime? runtime)) await runtime.DisposeAsync();
    }

    private async Task ReapIdleAsync()
    {
        DateTime cutoff = DateTime.UtcNow.AddMinutes(-10);
        foreach (var pair in _runtimes.Where(pair => pair.Value.LastUsedUtc < cutoff).ToArray())
            if (_runtimes.TryRemove(pair.Key, out Runtime? runtime)) await runtime.DisposeAsync();
    }

    private void CaptureStderr(string id, string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        _emit?.Invoke("connector.log", new JsonObject { ["connectorId"] = id, ["level"] = "stderr", ["message"] = Redact(line.Length > 2048 ? line[..2048] : line) });
    }

    private void SetError(string id, Exception exception)
    {
        _statuses[id] = "error";
        _errors[id] = Redact(exception.Message);
        EmitStatus(id);
    }

    private void EmitStatus(string id) => _emit?.Invoke("connector.statusChanged", new JsonObject
    {
        ["connectorId"] = id,
        ["status"] = _statuses.TryGetValue(id, out string? status) ? status : "disconnected",
        ["lastError"] = _errors.TryGetValue(id, out string? error) ? Redact(error) : ""
    });

    private static string NormalizeWorkspace(string workspace)
    {
        if (string.IsNullOrWhiteSpace(workspace)) return "";
        try { return Path.GetFullPath(workspace).TrimEnd(Path.DirectorySeparatorChar).ToUpperInvariant(); }
        catch { return ""; }
    }

    private static int ReserveLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string Redact(string value) => Regex.Replace(value ?? "", "(?i)(bearer|token|secret|password|authorization)([=: ]+)[^\\s,;]+", "$1$2[REDACTED]");

    public async ValueTask DisposeAsync()
    {
        await _idleTimer.DisposeAsync();
        foreach (var runtime in _runtimes.Values) await runtime.DisposeAsync();
        foreach (OAuthFlow flow in _oauthFlows.Values) flow.Dispose();
        _runtimes.Clear();
    }
}
