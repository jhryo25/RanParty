using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using RanParty.Cats;
using RanParty.Core;
using RanParty.Debug;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static HashSet<string> SchemaNames(string schema)
{
    return new HashSet<string>(
        (JsonNode.Parse(schema)?.AsArray() ?? new JsonArray())
            .Select(item => item?["function"]?["name"]?.GetValue<string>() ?? "")
            .Where(name => name.Length > 0),
        StringComparer.Ordinal);
}

static async Task AssertApiCancellationAsync(Logger logger)
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    int port = ((IPEndPoint)listener.LocalEndpoint).Port;
    using var serverCts = new CancellationTokenSource();
    var serverTask = Task.Run(async () =>
    {
        using var client = await listener.AcceptTcpClientAsync(serverCts.Token);
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, leaveOpen: true);
        while (!string.IsNullOrEmpty(await reader.ReadLineAsync(serverCts.Token))) { }
        byte[] response = Encoding.UTF8.GetBytes(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" +
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
        await stream.WriteAsync(response, serverCts.Token);
        await stream.FlushAsync(serverCts.Token);
        await Task.Delay(TimeSpan.FromSeconds(30), serverCts.Token);
    }, serverCts.Token);

    try
    {
        var profile = new ModelProfile
        {
            Name = "cancel-smoke",
            BaseUrl = $"http://127.0.0.1:{port}/v1",
            ApiKey = "test",
            Model = "cancel-smoke"
        };
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(350));
        bool cancelled = false;
        try
        {
            await new ApiClient(profile).Chat(profile.Model,
                new List<JsonNode> { new JsonObject { ["role"] = "user", ["content"] = "cancel" } },
                "", logger, null, null, cts.Token);
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
            cancelled = true;
        }
        Require(cancelled, "ApiClient converted cancellation into a successful partial response.");
    }
    finally
    {
        serverCts.Cancel();
        listener.Stop();
        try { await serverTask; } catch (OperationCanceledException) { } catch (SocketException) { } catch (IOException) { }
    }
}

static async Task<ChatResult> RunSingleSseResponseAsync(Logger logger, ModelProfile profile, params string[] dataEvents)
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    int port = ((IPEndPoint)listener.LocalEndpoint).Port;
    using var serverCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
    var serverTask = Task.Run(async () =>
    {
        using var client = await listener.AcceptTcpClientAsync(serverCts.Token);
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, leaveOpen: true);
        while (!string.IsNullOrEmpty(await reader.ReadLineAsync(serverCts.Token))) { }
        string body = string.Join("", dataEvents.Select(data => "data: " + data + "\n\n"));
        byte[] response = Encoding.UTF8.GetBytes(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n" + body);
        await stream.WriteAsync(response, serverCts.Token);
        await stream.FlushAsync(serverCts.Token);
        // Disposing the connection produces an ordinary, clean EOF. The client
        // must still reject it unless one of the supplied events was terminal.
    }, serverCts.Token);

    profile.BaseUrl = $"http://127.0.0.1:{port}/v1";
    try
    {
        return await new ApiClient(profile).Chat(profile.Model,
            new List<JsonNode> { new JsonObject { ["role"] = "user", ["content"] = "stream contract" } },
            "", logger, null, null, serverCts.Token);
    }
    finally
    {
        listener.Stop();
        try { await serverTask; } catch (OperationCanceledException) { } catch (SocketException) { } catch (IOException) { }
    }
}

static async Task AssertSseTerminalContractsAsync(Logger logger)
{
    var incompleteToolCall = new JsonObject
    {
        ["choices"] = new JsonArray(new JsonObject
        {
            ["delta"] = new JsonObject
            {
                ["tool_calls"] = new JsonArray(new JsonObject
                {
                    ["index"] = 0,
                    ["id"] = "incomplete-tool-call",
                    ["function"] = new JsonObject
                    {
                        ["name"] = "ps_run",
                        ["arguments"] = "{\"command\":\"Write-Output must-not-run\"}"
                    }
                })
            },
            ["finish_reason"] = null
        })
    }.ToJsonString();

    var incompleteCases = new[]
    {
        (Name: "OpenAI Chat Completions", Profile: new ModelProfile { Name = "chat-eof", Model = "chat-eof" }, Event: incompleteToolCall),
        (Name: "OpenAI Responses", Profile: new ModelProfile { Name = "responses-eof", Model = "responses-eof", WireProtocol = "responses" }, Event: "{\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}"),
        (Name: "Anthropic Messages", Profile: new ModelProfile { Name = "anthropic-eof", Model = "anthropic-eof", Provider = "anthropic", WireProtocol = "anthropic_messages" }, Event: "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}")
    };

    foreach (var test in incompleteCases)
    {
        bool rejected = false;
        try { await RunSingleSseResponseAsync(logger, test.Profile, test.Event); }
        catch (EndOfStreamException) { rejected = true; }
        Require(rejected, test.Name + " accepted a clean EOF without a terminal event/marker.");
    }

    var chatComplete = await RunSingleSseResponseAsync(logger,
        new ModelProfile { Name = "chat-terminal", Model = "chat-terminal" },
        "{\"choices\":[{\"delta\":{\"content\":\"chat-ok\"},\"finish_reason\":\"stop\"}]}");
    Require(chatComplete.Content == "chat-ok", "Chat Completions terminal event was not accepted.");

    var responsesComplete = await RunSingleSseResponseAsync(logger,
        new ModelProfile { Name = "responses-terminal", Model = "responses-terminal", WireProtocol = "responses" },
        "{\"type\":\"response.output_text.delta\",\"delta\":\"responses-ok\"}",
        "{\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}");
    Require(responsesComplete.Content == "responses-ok", "Responses terminal event was not accepted.");

    var anthropicComplete = await RunSingleSseResponseAsync(logger,
        new ModelProfile { Name = "anthropic-terminal", Model = "anthropic-terminal", Provider = "anthropic", WireProtocol = "anthropic_messages" },
        "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"anthropic-ok\"}}",
        "{\"type\":\"message_stop\"}");
    Require(anthropicComplete.Content == "anthropic-ok", "Anthropic terminal event was not accepted.");
}

static async Task AssertProviderErrorBoundAsync(Logger logger)
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    int port = ((IPEndPoint)listener.LocalEndpoint).Port;
    using var serverCts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
    string errorBody = new string('x', ApiClient.MaxProviderErrorBytes + 1);
    var serverTask = Task.Run(async () =>
    {
        using var client = await listener.AcceptTcpClientAsync(serverCts.Token);
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, leaveOpen: true);
        while (!string.IsNullOrEmpty(await reader.ReadLineAsync(serverCts.Token))) { }
        byte[] body = Encoding.UTF8.GetBytes(errorBody);
        byte[] headers = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(headers, serverCts.Token);
        await stream.WriteAsync(body, serverCts.Token);
        await stream.FlushAsync(serverCts.Token);
    }, serverCts.Token);

    try
    {
        var profile = new ModelProfile
        {
            Name = "bounded-error",
            BaseUrl = $"http://127.0.0.1:{port}/v1",
            ApiKey = "test",
            Model = "bounded-error"
        };
        InvalidOperationException? failure = null;
        try
        {
            await new ApiClient(profile).Chat(profile.Model,
                new List<JsonNode> { new JsonObject { ["role"] = "user", ["content"] = "bounded error" } },
                "", logger, null, null, serverCts.Token);
        }
        catch (InvalidOperationException ex) { failure = ex; }
        Require(failure is not null, "Provider HTTP error was not surfaced.");
        Require(failure!.Message.Length < 2_000, "Provider HTTP error body escaped its presentation bound.");
    }
    finally
    {
        listener.Stop();
        try { await serverTask; } catch (OperationCanceledException) { } catch (SocketException) { } catch (IOException) { }
    }
}

static async Task AssertProviderStreamBoundsAsync(Logger logger)
{
    async Task ExpectLimitAsync(string name, string expectedMessage, params string[] events)
    {
        bool rejected = false;
        try
        {
            await RunSingleSseResponseAsync(logger,
                new ModelProfile { Name = name, Model = name }, events);
        }
        catch (InvalidDataException ex) when (ex.Message.Contains(expectedMessage, StringComparison.Ordinal))
        {
            rejected = true;
        }
        Require(rejected, name + " did not enforce the expected provider stream bound: " + expectedMessage);
    }

    await ExpectLimitAsync("sse-line-bound", "SSE line exceeded",
        new string('x', ApiClient.MaxSseLineCharacters + 1));

    const int deltaSize = 64 * 1024;
    string contentEvent = new JsonObject
    {
        ["choices"] = new JsonArray(new JsonObject
        {
            ["delta"] = new JsonObject { ["content"] = new string('c', deltaSize) },
            ["finish_reason"] = null
        })
    }.ToJsonString();
    int contentEvents = ApiClient.MaxContentCharacters / deltaSize + 1;
    await ExpectLimitAsync("content-bound", "provider content exceeded",
        Enumerable.Repeat(contentEvent, contentEvents).ToArray());

    const int argumentDeltaSize = 128 * 1024;
    string argumentsEvent = new JsonObject
    {
        ["choices"] = new JsonArray(new JsonObject
        {
            ["delta"] = new JsonObject
            {
                ["tool_calls"] = new JsonArray(new JsonObject
                {
                    ["index"] = 0,
                    ["id"] = "bounded-tool",
                    ["function"] = new JsonObject
                    {
                        ["name"] = "bounded_tool",
                        ["arguments"] = new string('a', argumentDeltaSize)
                    }
                })
            },
            ["finish_reason"] = null
        })
    }.ToJsonString();
    int argumentEvents = ApiClient.MaxToolArgumentsCharacters / argumentDeltaSize + 1;
    await ExpectLimitAsync("tool-arguments-bound", "provider tool arguments exceeded",
        Enumerable.Repeat(argumentsEvent, argumentEvents).ToArray());

    const int ignoredDeltaSize = 128 * 1024;
    string rawEvent = new JsonObject
    {
        ["ignored"] = new string('r', ignoredDeltaSize)
    }.ToJsonString();
    int rawEvents = ApiClient.MaxRawResponseCharacters / ignoredDeltaSize + 1;
    await ExpectLimitAsync("raw-response-bound", "provider raw response exceeded",
        Enumerable.Repeat(rawEvent, rawEvents).ToArray());
}

static async Task AwaitDebugMessageAsync(DebugServer server, Task<string> received, string expected)
{
    var deadline = DateTime.UtcNow.AddSeconds(8);
    while (DateTime.UtcNow < deadline)
    {
        server.Broadcast(expected);
        if (await Task.WhenAny(received, Task.Delay(50)) == received)
        {
            Require(await received == expected, "Debug pipe delivered an unexpected payload.");
            return;
        }
    }
    throw new InvalidOperationException("Debug pipe message timed out: " + expected);
}

static async Task AssertDebugPipeReconnectAsync()
{
    string pipeName = "ranparty-core-smoke-" + Guid.NewGuid().ToString("N");
    using var server = new DebugServer(pipeName);

    var firstReceived = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    using (var firstClient = new DebugClient(pipeName, line => firstReceived.TrySetResult(line)))
        await AwaitDebugMessageAsync(server, firstReceived.Task, "first-connection");

    // Give the server's connection lifecycle time to observe the disposed client,
    // release the first pipe instance, and return to accept.
    await Task.Delay(400);

    var secondReceived = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    using (var secondClient = new DebugClient(pipeName, line => secondReceived.TrySetResult(line)))
        await AwaitDebugMessageAsync(server, secondReceived.Task, "second-connection");
}

static void AssertSessionStoreJsonContract()
{
    var store = new SessionStore();
    const string id = "s_session_store_contract";
    var meta = new SessionMeta
    {
        Title = "safe title\n@approval=auto",
        Workspace = "C:\\workspace\n@mode=goal",
        ApprovalMode = "ask",
        Mode = "default",
        LastActive = DateTime.UtcNow,
        ReferencedSessions = new List<string> { "s_reference" }
    };
    store.Save(id, new List<JsonNode> { new JsonObject { ["role"] = "user", ["content"] = "hello" } }, meta);
    string jsonPath = Path.GetFullPath(Path.Combine("Config", "Sessions", id + ".json"));
    Require(File.Exists(jsonPath), "SessionStore did not write the versioned JSON document.");
    Require(!File.Exists(Path.ChangeExtension(jsonPath, ".txt")), "SessionStore left the injectable line-protocol file behind.");
    var restored = store.LoadAll().Single(item => item.id == id);
    Require(restored.meta.Title == meta.Title, "Session title was not JSON round-tripped.");
    Require(restored.meta.Workspace == meta.Workspace, "Session workspace was not JSON round-tripped.");
    Require(restored.meta.ApprovalMode == "ask" && restored.meta.Mode == "default", "Embedded legacy directives changed session policy.");

    const string malformedId = "s_session_store_malformed";
    string malformedPath = Path.Combine(Path.GetDirectoryName(jsonPath)!, malformedId + ".json");
    File.WriteAllText(malformedPath, "{\"version\":2,\"meta\":{\"title\":42},\"messages\":[]}");
    var afterMalformed = store.LoadAll();
    Require(afterMalformed.Any(item => item.id == id), "A malformed session prevented valid sessions from loading.");
    Require(afterMalformed.All(item => item.id != malformedId), "A malformed session was not isolated from startup restore.");
    File.Delete(malformedPath);
    store.Delete(id);
    Require(!File.Exists(jsonPath), "SessionStore.Delete did not remove the JSON document.");
}

static void AssertSessionStoreLegacyIsolation()
{
    var store = new SessionStore();
    const string sentinelId = "s_session_store_legacy_sentinel";
    store.Save(sentinelId,
        new List<JsonNode> { new JsonObject { ["role"] = "user", ["content"] = "sentinel" } },
        new SessionMeta { Title = "legacy isolation sentinel", LastActive = DateTime.UtcNow });

    string configRoot = Path.GetFullPath("Config");
    string sessionsRoot = Path.Combine(configRoot, "Sessions");
    string corruptGlobalPath = Path.Combine(configRoot, "session_active.txt");
    const string corruptPayload = "@title=must remain recoverable\n{\"role\":\"user\",\"content\":\"valid prefix\"}\n{\"role\":";
    File.WriteAllText(corruptGlobalPath, corruptPayload, new UTF8Encoding(false));

    string corruptSessionPath = Path.Combine(sessionsRoot, "s_legacy_corrupt.txt");
    File.WriteAllText(corruptSessionPath, corruptPayload, new UTF8Encoding(false));

    var afterCorrupt = store.LoadAll();
    Require(afterCorrupt.Any(item => item.id == sentinelId), "A corrupt legacy session prevented valid sessions from loading.");
    Require(afterCorrupt.All(item => item.id != "s_legacy_corrupt"), "A corrupt per-session legacy file was partially restored.");
    Require(afterCorrupt.All(item => item.meta.Title != "must remain recoverable"), "A corrupt global legacy file was partially migrated.");
    Require(File.Exists(corruptGlobalPath) && File.ReadAllText(corruptGlobalPath) == corruptPayload,
        "A corrupt global legacy source was deleted or modified.");
    Require(File.Exists(corruptSessionPath) && File.ReadAllText(corruptSessionPath) == corruptPayload,
        "A corrupt per-session legacy source was deleted or modified.");

    string oversizedGlobalPath = Path.Combine(configRoot, "SuperCat_active.txt");
    string oversizedSessionPath = Path.Combine(sessionsRoot, "s_legacy_oversized.txt");
    foreach (string path in new[] { oversizedGlobalPath, oversizedSessionPath })
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        stream.SetLength(64L * 1024 * 1024 + 1);
    }

    var afterOversized = store.LoadAll();
    Require(afterOversized.Any(item => item.id == sentinelId), "An oversized legacy session prevented valid sessions from loading.");
    Require(afterOversized.All(item => item.id != "s_legacy_oversized"), "An oversized per-session legacy file was restored.");
    Require(File.Exists(oversizedGlobalPath), "An oversized global legacy source was deleted.");
    Require(File.Exists(oversizedSessionPath), "An oversized per-session legacy source was deleted.");

    foreach (string path in new[] { corruptGlobalPath, corruptSessionPath, oversizedGlobalPath, oversizedSessionPath })
        File.Delete(path);
    store.Delete(sentinelId);
}

static void AssertIoTraversalBounds(CatRegistry registry, string toolRoot)
{
    string deepRoot = Path.Combine(toolRoot, "bounded-depth");
    Directory.CreateDirectory(deepRoot);
    string current = deepRoot;
    for (int depth = 1; depth <= IOCat.MaxFileTreeDepth + 2; depth++)
    {
        current = Path.Combine(current, $"depth-{depth:D2}");
        Directory.CreateDirectory(current);
    }
    string nestedMatch = Path.Combine(current, "nested-match.txt");
    File.WriteAllText(nestedMatch, "nested");

    bool reparseCreated = false;
    string reparsePath = Path.Combine(deepRoot, "loop-reparse");
    try
    {
        Directory.CreateSymbolicLink(reparsePath, deepRoot);
        reparseCreated = true;
    }
    catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or NotSupportedException) { }

    var depthTree = registry.Dispatch("file_tree", new JsonObject
    {
        ["path"] = deepRoot,
        ["depth"] = int.MaxValue
    });
    Require(!depthTree.IsError, "file_tree failed while testing its depth bound: " + depthTree.Content);
    Require(depthTree.Content.Contains($"depth-{IOCat.MaxFileTreeDepth:D2}/", StringComparison.Ordinal),
        "file_tree stopped before its documented hard depth.");
    Require(!depthTree.Content.Contains($"depth-{IOCat.MaxFileTreeDepth + 1:D2}/", StringComparison.Ordinal),
        "file_tree traversed beyond its hard depth.");
    if (reparseCreated)
        Require(!depthTree.Content.Contains("loop-reparse", StringComparison.Ordinal), "file_tree followed or returned a reparse point.");

    var recursiveGlob = registry.Dispatch("file_find", new JsonObject { ["dir"] = deepRoot, ["pattern"] = "**/*.txt" });
    Require(!recursiveGlob.IsError && recursiveGlob.Content.Contains(nestedMatch, StringComparison.OrdinalIgnoreCase),
        "file_find no longer honors a recursive relative glob pattern.");
    if (reparseCreated)
        Require(!recursiveGlob.Content.Contains("loop-reparse", StringComparison.Ordinal), "file_find followed a reparse point.");

    string crowded = Path.Combine(toolRoot, "bounded-results");
    Directory.CreateDirectory(crowded);
    for (int index = 0; index < IOCat.MaxDirectoryResultEntries + 2; index++)
        File.WriteAllText(Path.Combine(crowded, $"item-{index:D4}.txt"), "x");

    var listed = registry.Dispatch("file_list", new JsonObject { ["path"] = crowded });
    Require(!listed.IsError, "file_list failed while testing its result bound: " + listed.Content);
    Require(listed.Content.Length <= IOCat.MaxDirectoryOutputCharacters, "file_list exceeded its output-character bound.");
    Require(listed.Content.Contains("[output truncated:", StringComparison.Ordinal), "file_list did not disclose result truncation.");

    var found = registry.Dispatch("file_find", new JsonObject { ["dir"] = crowded, ["pattern"] = "*.txt" });
    Require(!found.IsError, "file_find failed while testing its bounds: " + found.Content);
    Require(found.Content.Length <= IOCat.MaxDirectoryOutputCharacters, "file_find exceeded its output-character bound.");
    Require(found.Content.Contains("[output truncated:", StringComparison.Ordinal), "file_find did not disclose output/result truncation.");

    var crowdedTree = registry.Dispatch("file_tree", new JsonObject { ["path"] = crowded, ["depth"] = 2 });
    Require(!crowdedTree.IsError, "file_tree failed while testing its result bound: " + crowdedTree.Content);
    Require(crowdedTree.Content.Length <= IOCat.MaxDirectoryOutputCharacters, "file_tree exceeded its output-character bound.");
    Require(crowdedTree.Content.Contains("[output truncated:", StringComparison.Ordinal), "file_tree did not disclose result truncation.");
}

string originalCwd = Environment.CurrentDirectory;
string root = Path.Combine(Path.GetTempPath(), "ranparty-core-smoke-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    string defaultLogRoot = Path.Combine(root, "default-log");
    Directory.CreateDirectory(defaultLogRoot);
    Environment.CurrentDirectory = defaultLogRoot;
    var logger = new Logger(logFullPayloads: false);
    Parallel.For(0, 32, index => logger.WriteCall(
        $"{{\"messages\":[{{\"role\":\"user\",\"content\":\"request-secret-{index}\"}}]}}",
        $"response-secret-{index}"));
    var summaries = Directory.GetFiles(logger.SessionDir, "CALL-*-summary.json");
    Require(summaries.Length == 32, $"Expected 32 unique summary files, found {summaries.Length}.");
    Require(Directory.GetFiles(logger.SessionDir, "CALL-*-full.txt").Length == 0, "Default logger wrote full payload files.");
    Require(!summaries.Select(File.ReadAllText).Any(text => text.Contains("secret", StringComparison.Ordinal)), "Summary log leaked payload content.");

    string fullLogRoot = Path.Combine(root, "full-log");
    Directory.CreateDirectory(fullLogRoot);
    Environment.CurrentDirectory = fullLogRoot;
    var fullLogger = new Logger(logFullPayloads: true);
    fullLogger.WriteCall("explicit-request-secret", "explicit-response-secret");
    string fullPath = Directory.GetFiles(fullLogger.SessionDir, "CALL-*-full.txt").Single();
    Require(File.ReadAllText(fullPath).Contains("explicit-request-secret", StringComparison.Ordinal), "Explicit full-payload opt-in did not write the payload.");

    string toolRoot = Path.Combine(root, "tools");
    Directory.CreateDirectory(toolRoot);
    Environment.CurrentDirectory = toolRoot;
    var config = new Config();
    config.IoRoots = toolRoot;
    config.BuildWhitelist();
    var registry = new CatRegistry();
    registry.Register(new IOCat(config, registry));
    registry.Register(new MdCat(config));
    registry.Register(new ShellCat(config));

    var direct = SchemaNames(registry.SchemasJson());
    Require(direct.Contains("tool_search"), "tool_search must remain directly visible.");
    Require(!direct.Contains("reformat_md") && !direct.Contains("open_url") && !direct.Contains("open_path"), "Deferred tools leaked into the direct schema.");
    var activated = SchemaNames(registry.SchemasJsonForTurn(new[] { "reformat_md", "open_url" }));
    Require(activated.Contains("reformat_md") && activated.Contains("open_url") && !activated.Contains("open_path"), "Turn-scoped schema activation is incorrect.");
    Require(registry.SearchDeferredTools("Markdown").Any(tool => tool.Name == "reformat_md"), "Deferred tool search did not find its owning Cat description.");
    var discovered = registry.Dispatch("tool_search", new JsonObject { ["query"] = "Markdown" });
    Require(!discovered.IsError && discovered.Content.Contains("reformat_md", StringComparison.Ordinal), "tool_search did not expose the deferred tool description.");
    AssertIoTraversalBounds(registry, toolRoot);

    var shell = await registry.DispatchAsync("ps_run", new JsonObject
    {
        ["command"] = "Write-Output shell-ok",
        ["workdir"] = toolRoot,
        ["timeout"] = 10
    }, CancellationToken.None);
    Require(!shell.IsError && shell.Content.Contains("shell-ok", StringComparison.Ordinal), "Shell async execution failed: " + shell.Content);

    string outsideRoot = Path.Combine(root, "outside-tools");
    Directory.CreateDirectory(outsideRoot);
    var rejectedWorkdir = await registry.DispatchAsync("ps_run", new JsonObject
    {
        ["command"] = "Write-Output should-not-run",
        ["workdir"] = outsideRoot,
        ["timeout"] = 10
    }, CancellationToken.None);
    Require(rejectedWorkdir.Error == ErrorKind.PermissionDenied, "Shell accepted a working directory outside the configured whitelist.");

    var parallelShells = await Task.WhenAll(Enumerable.Range(0, 2).Select(index =>
        registry.DispatchAsync("ps_run", new JsonObject
        {
            ["command"] = $"Start-Sleep -Milliseconds 250; Write-Output parallel-{index}",
            ["workdir"] = toolRoot,
            ["timeout"] = 10
        }, CancellationToken.None)));
    Require(parallelShells.Select((result, index) => !result.IsError && result.Content.Contains($"parallel-{index}", StringComparison.Ordinal)).All(value => value),
        "Per-command Job Objects did not support concurrent shell executions.");

    string sentinel = Path.Combine(toolRoot, "cancel-sentinel.txt");
    using (var shellCts = new CancellationTokenSource(TimeSpan.FromMilliseconds(350)))
    {
        var sw = Stopwatch.StartNew();
        bool cancelled = false;
        try
        {
            await registry.DispatchAsync("ps_run", new JsonObject
            {
                ["command"] = $"Start-Sleep -Seconds 5; Set-Content -LiteralPath '{sentinel}' -Value done",
                ["workdir"] = toolRoot,
                ["timeout"] = 30
            }, shellCts.Token);
        }
        catch (OperationCanceledException) when (shellCts.IsCancellationRequested)
        {
            cancelled = true;
        }
        Require(cancelled, "Shell cancellation was converted into a normal tool result.");
        Require(sw.Elapsed < TimeSpan.FromSeconds(5), "Shell cancellation did not terminate promptly.");
    }
    await Task.Delay(750);
    Require(!File.Exists(sentinel), "Cancelled shell command continued and produced its delayed side effect.");

    var timeout = await registry.DispatchAsync("ps_run", new JsonObject
    {
        ["command"] = "Start-Sleep -Seconds 5",
        ["workdir"] = toolRoot,
        ["timeout"] = 1
    }, CancellationToken.None);
    Require(timeout.Error == ErrorKind.Timeout, "Shell timeout did not return ErrorKind.Timeout.");

    var failedShell = await registry.DispatchAsync("ps_run", new JsonObject
    {
        ["command"] = "Write-Error 'structured-shell-failure'; exit 7",
        ["workdir"] = toolRoot,
        ["timeout"] = 10
    }, CancellationToken.None);
    Require(failedShell.Error == ErrorKind.Unknown, "Non-zero shell exit was not mapped to a structured tool error.");
    Require(failedShell.Content.Contains("[exit 7]", StringComparison.Ordinal)
        && failedShell.Content.Contains("structured-shell-failure", StringComparison.Ordinal),
        "Non-zero shell result did not preserve its exit code and stderr output.");

    await AssertApiCancellationAsync(logger);
    await AssertSseTerminalContractsAsync(logger);
    await AssertProviderErrorBoundAsync(logger);
    await AssertProviderStreamBoundsAsync(logger);
    await AssertDebugPipeReconnectAsync();
    AssertSessionStoreJsonContract();
    AssertSessionStoreLegacyIsolation();
    Console.WriteLine("Core runtime smoke passed: provider stream/error bounds, SSE terminal contracts, bounded IO traversal, API/Shell cancellation, debug reconnect, JSON sessions, log privacy, deferred schema.");
}
finally
{
    Environment.CurrentDirectory = originalCwd;
    try { Directory.Delete(root, recursive: true); } catch { }
}
