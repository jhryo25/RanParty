using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RanParty.Core;

public class ChatResult
{
    public string Content = "";
    public JsonArray? ToolCalls;
    public string RawResponse = "";
    public int UsageIn, UsageOut, UsageReasoning;
    public JsonArray? SearchResults; // deepseek online:true 返回的搜索引用
}

public class ApiClient
{
    internal const int MaxProviderErrorBytes = 64 * 1024;
    internal const int MaxSseLineCharacters = 512 * 1024;
    internal const int MaxRawResponseCharacters = 4 * 1024 * 1024;
    internal const int MaxContentCharacters = 2 * 1024 * 1024;
    internal const int MaxToolArgumentsCharacters = 1024 * 1024;
    const int MaxFriendlyErrorCharacters = 800;

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    readonly ModelProfile _profile;

    public ApiClient(ModelProfile profile) => _profile = profile;
    public ApiClient(string apiKey, string baseUrl) : this(new ModelProfile { ApiKey = apiKey, BaseUrl = baseUrl }) { }
    public void SetKey(string key) => _profile.ApiKey = key;
    public void SetBase(string baseUrl) => _profile.BaseUrl = baseUrl;
    public void SetMaxTokens(int maxTokens) => _profile.MaxOutputTokens = maxTokens;

    public async Task<ChatResult> Chat(string model, List<JsonNode> messages, string toolsSchema,
        Logger log, Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct = default)
    {
        return _profile.Provider == "anthropic"
            ? await ChatAnthropic(model, messages, toolsSchema, log, onDelta, onReasoning, ct)
            : _profile.WireProtocol == "responses"
                ? await ChatResponses(model, messages, toolsSchema, log, onDelta, onReasoning, ct)
                : await ChatCompletions(model, messages, toolsSchema, log, onDelta, onReasoning, ct);
    }

    public async Task<string> Complete(string model, List<JsonNode> messages, Logger log, CancellationToken ct = default)
    {
        var result = await Chat(model, messages, "", log, null, null, ct);
        return result.Content.Trim();
    }

    async Task<ChatResult> ChatCompletions(string model, List<JsonNode> messages, string toolsSchema,
        Logger log, Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["model"] = model,
            ["messages"] = Clone(messages),
            ["stream"] = true
        };
        if (_profile.MaxOutputTokens > 0) body["max_tokens"] = _profile.MaxOutputTokens;
        if (_profile.SupportsTools && !string.IsNullOrWhiteSpace(toolsSchema)) body["tools"] = JsonNode.Parse(toolsSchema);
        if (IsDeepSeek() && !string.IsNullOrWhiteSpace(toolsSchema)) body["search"] = new JsonObject { ["enabled"] = true };
        using var response = await Send(body, BuildEndpoint("chat/completions"), false, ct);
        return await ReadOpenAiChatStream(response, body, log, onDelta, onReasoning, ct);
    }

    async Task<ChatResult> ChatResponses(string model, List<JsonNode> messages, string toolsSchema,
        Logger log, Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["model"] = model,
            ["input"] = ToResponsesInput(messages),
            ["stream"] = true
        };
        if (_profile.MaxOutputTokens > 0) body["max_output_tokens"] = _profile.MaxOutputTokens;
        if (_profile.SupportsTools && !string.IsNullOrWhiteSpace(toolsSchema)) body["tools"] = ToResponsesTools(toolsSchema);
        if (_profile.SupportsReasoning) body["reasoning"] = new JsonObject { ["summary"] = "auto" };
        using var response = await Send(body, BuildEndpoint("responses"), false, ct);
        return await ReadResponsesStream(response, body, log, onDelta, onReasoning, ct);
    }

    async Task<ChatResult> ChatAnthropic(string model, List<JsonNode> messages, string toolsSchema,
        Logger log, Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var (system, converted) = ToAnthropicMessages(messages);
        var body = new JsonObject
        {
            ["model"] = model,
            ["messages"] = converted,
            ["stream"] = true,
            ["max_tokens"] = Math.Max(1, _profile.MaxOutputTokens)
        };
        if (!string.IsNullOrWhiteSpace(system)) body["system"] = system;
        if (_profile.SupportsTools && !string.IsNullOrWhiteSpace(toolsSchema)) body["tools"] = ToAnthropicTools(toolsSchema);
        using var response = await Send(body, BuildEndpoint("messages"), true, ct);
        return await ReadAnthropicStream(response, body, log, onDelta, onReasoning, ct);
    }

    async Task<HttpResponseMessage> Send(JsonObject body, string endpoint, bool anthropic, CancellationToken ct)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json")
        };
        if (!string.IsNullOrWhiteSpace(_profile.ApiKey))
        {
            if (anthropic)
            {
                request.Headers.TryAddWithoutValidation("x-api-key", _profile.ApiKey);
                request.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
            }
            else request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _profile.ApiKey);
        }
        var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.IsSuccessStatusCode) return response;
        int statusCode = (int)response.StatusCode;
        string error;
        try { error = await ReadProviderErrorAsync(response.Content, ct); }
        finally { response.Dispose(); }
        throw new InvalidOperationException($"{ProviderLabel()} 请求失败（HTTP {statusCode}，{endpoint}）：{FriendlyError(error)}");
    }

    async Task<ChatResult> ReadOpenAiChatStream(HttpResponseMessage response, JsonObject body, Logger log,
        Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var result = new ChatResult();
        var content = new StringBuilder();
        var raw = new StringBuilder();
        var tools = new Dictionary<int, JsonObject>();
        bool protocolTerminal = false;
        bool doneMarker = await ReadSse(response, ct, data =>
        {
            AppendRawEvent(raw, data);
            var node = TryParse(data);
            var choices = node?["choices"] as JsonArray;
            var delta = choices is { Count: > 0 } ? choices[0]?["delta"] : null;
            AppendContent(delta?["content"]?.GetValue<string>(), content, onDelta);
            onReasoning?.Invoke(delta?["reasoning_content"]?.GetValue<string>() ?? "");
            foreach (var call in delta?["tool_calls"]?.AsArray() ?? [])
            {
                int index = call?["index"]?.GetValue<int>() ?? 0;
                var target = ToolAccumulator(tools, index);
                AppendTool(target, call?["id"]?.GetValue<string>(), call?["function"]?["name"]?.GetValue<string>(), call?["function"]?["arguments"]?.GetValue<string>());
            }
            var usage = node?["usage"];
            result.UsageIn = usage?["prompt_tokens"]?.GetValue<int>() ?? result.UsageIn;
            result.UsageOut = usage?["completion_tokens"]?.GetValue<int>() ?? result.UsageOut;
            result.UsageReasoning = usage?["completion_tokens_details"]?["reasoning_tokens"]?.GetValue<int>() ?? result.UsageReasoning;
            if (choices is not null && choices.Any(choice => choice?["finish_reason"] is JsonValue))
                protocolTerminal = true;
        });
        EnsureStreamTerminated(doneMarker, protocolTerminal, "OpenAI Chat Completions");
        Finish(result, content, raw, tools, body, log);
        return result;
    }

    async Task<ChatResult> ReadResponsesStream(HttpResponseMessage response, JsonObject body, Logger log,
        Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var result = new ChatResult();
        var content = new StringBuilder();
        var raw = new StringBuilder();
        var tools = new Dictionary<int, JsonObject>();
        var itemIndexes = new Dictionary<string, int>(StringComparer.Ordinal);
        bool protocolTerminal = false;
        bool doneMarker = await ReadSse(response, ct, data =>
        {
            AppendRawEvent(raw, data);
            var node = TryParse(data);
            string type = node?["type"]?.GetValue<string>() ?? "";
            if (type == "response.output_text.delta") AppendContent(node?["delta"]?.GetValue<string>(), content, onDelta);
            if (type is "response.reasoning_summary_text.delta" or "response.reasoning_text.delta") onReasoning?.Invoke(node?["delta"]?.GetValue<string>() ?? "");
            if (type == "response.output_item.added" && node?["item"]?["type"]?.GetValue<string>() == "function_call")
            {
                int index = node?["output_index"]?.GetValue<int>() ?? tools.Count;
                string itemId = node?["item"]?["id"]?.GetValue<string>() ?? index.ToString();
                itemIndexes[itemId] = index;
                AppendTool(ToolAccumulator(tools, index), node?["item"]?["call_id"]?.GetValue<string>() ?? itemId, node?["item"]?["name"]?.GetValue<string>(), node?["item"]?["arguments"]?.GetValue<string>());
            }
            if (type == "response.function_call_arguments.delta")
            {
                string itemId = node?["item_id"]?.GetValue<string>() ?? "";
                int index = itemIndexes.TryGetValue(itemId, out var found) ? found : node?["output_index"]?.GetValue<int>() ?? 0;
                AppendTool(ToolAccumulator(tools, index), null, null, node?["delta"]?.GetValue<string>());
            }
            if (type == "response.completed")
            {
                var usage = node?["response"]?["usage"];
                result.UsageIn = usage?["input_tokens"]?.GetValue<int>() ?? result.UsageIn;
                result.UsageOut = usage?["output_tokens"]?.GetValue<int>() ?? result.UsageOut;
                result.UsageReasoning = usage?["output_tokens_details"]?["reasoning_tokens"]?.GetValue<int>() ?? result.UsageReasoning;
                protocolTerminal = true;
            }
            if (type is "response.failed" or "response.incomplete" or "error")
                throw new InvalidOperationException("OpenAI Responses stream ended with " + type + ": " + StreamError(node));
        });
        EnsureStreamTerminated(doneMarker, protocolTerminal, "OpenAI Responses");
        Finish(result, content, raw, tools, body, log);
        return result;
    }

    async Task<ChatResult> ReadAnthropicStream(HttpResponseMessage response, JsonObject body, Logger log,
        Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var result = new ChatResult();
        var content = new StringBuilder();
        var raw = new StringBuilder();
        var tools = new Dictionary<int, JsonObject>();
        bool protocolTerminal = false;
        bool doneMarker = await ReadSse(response, ct, data =>
        {
            AppendRawEvent(raw, data);
            var node = TryParse(data);
            string type = node?["type"]?.GetValue<string>() ?? "";
            int index = node?["index"]?.GetValue<int>() ?? 0;
            if (type == "content_block_start" && node?["content_block"]?["type"]?.GetValue<string>() == "tool_use")
                AppendTool(ToolAccumulator(tools, index), node?["content_block"]?["id"]?.GetValue<string>(), node?["content_block"]?["name"]?.GetValue<string>(), "");
            if (type == "content_block_delta")
            {
                string deltaType = node?["delta"]?["type"]?.GetValue<string>() ?? "";
                if (deltaType == "text_delta") AppendContent(node?["delta"]?["text"]?.GetValue<string>(), content, onDelta);
                if (deltaType == "thinking_delta") onReasoning?.Invoke(node?["delta"]?["thinking"]?.GetValue<string>() ?? "");
                if (deltaType == "input_json_delta") AppendTool(ToolAccumulator(tools, index), null, null, node?["delta"]?["partial_json"]?.GetValue<string>());
            }
            var usage = node?["usage"] ?? node?["message"]?["usage"];
            result.UsageIn = usage?["input_tokens"]?.GetValue<int>() ?? result.UsageIn;
            result.UsageOut = usage?["output_tokens"]?.GetValue<int>() ?? result.UsageOut;
            if (type == "message_stop") protocolTerminal = true;
            if (type == "error") throw new InvalidOperationException("Anthropic stream error: " + StreamError(node));
        });
        EnsureStreamTerminated(doneMarker, protocolTerminal, "Anthropic Messages");
        Finish(result, content, raw, tools, body, log);
        return result;
    }

    static async Task<bool> ReadSse(HttpResponseMessage response, CancellationToken ct, Action<string> onData)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8, true, 8192);
        var lines = new BoundedLineReader(reader);
        while (true)
        {
            // Cancellation and transport failures must reach the agent run. Treating
            // either as a clean EOF can turn a partial stream into a successful reply
            // and causes chat.cancel to surface as chat.completed/chat.error.
            string? line = await lines.ReadLineAsync(MaxSseLineCharacters, ct);
            if (line is null) break;
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            string data = line[5..].Trim();
            if (data == "[DONE]") return true;
            onData(data);
        }
        return false;
    }

    static void EnsureStreamTerminated(bool doneMarker, bool protocolTerminal, string protocol)
    {
        if (doneMarker || protocolTerminal) return;
        // EndOfStreamException is an IOException, so the host's transient-failure
        // policy retries the request. More importantly, no partial content or tool
        // call escapes this method as a committed ChatResult.
        throw new EndOfStreamException($"{protocol} SSE stream closed before a terminal event or [DONE] marker.");
    }

    static string StreamError(JsonNode? node)
    {
        string message = node?["error"]?["message"]?.GetValue<string>()
            ?? node?["response"]?["error"]?["message"]?.GetValue<string>()
            ?? node?["message"]?.GetValue<string>()
            ?? "provider reported an unsuccessful terminal event";
        return message.Length <= 800 ? message : message[..800] + "…";
    }

    string BuildEndpoint(string suffix)
    {
        string baseUrl = (_profile.BaseUrl ?? "").Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new InvalidOperationException("API 地址不能为空");
        string finalSegment = suffix.Split('/').Last();
        if (baseUrl.EndsWith("/" + suffix, StringComparison.OrdinalIgnoreCase) || baseUrl.EndsWith("/" + finalSegment, StringComparison.OrdinalIgnoreCase)) return baseUrl;
        return baseUrl + "/" + suffix;
    }

    string ProviderLabel() => _profile.Provider == "anthropic" ? "Anthropic 兼容 API" : _profile.WireProtocol == "responses" ? "OpenAI Responses API" : "OpenAI Chat Completions API";
    static string FriendlyError(string error)
    {
        if (string.IsNullOrWhiteSpace(error)) return "服务端未返回错误详情";
        string friendly;
        try
        {
            var node = JsonNode.Parse(error);
            friendly = node?["error"]?["message"]?.GetValue<string>() ?? node?["message"]?.GetValue<string>() ?? error;
        }
        catch { friendly = error; }
        return friendly.Length > MaxFriendlyErrorCharacters
            ? friendly[..MaxFriendlyErrorCharacters] + "…"
            : friendly;
    }

    static async Task<string> ReadProviderErrorAsync(HttpContent content, CancellationToken ct)
    {
        await using var stream = await content.ReadAsStreamAsync(ct);
        int initialCapacity = (int)Math.Min(content.Headers.ContentLength ?? 0, MaxProviderErrorBytes);
        using var bounded = new MemoryStream(Math.Max(0, initialCapacity));
        var buffer = new byte[8192];
        int remaining = MaxProviderErrorBytes;
        bool truncated = false;
        while (remaining > 0)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remaining)), ct);
            if (read == 0) break;
            bounded.Write(buffer, 0, read);
            remaining -= read;
        }
        if (remaining == 0) truncated = true;

        Encoding encoding = Encoding.UTF8;
        string? charset = content.Headers.ContentType?.CharSet?.Trim('"', '\'');
        if (!string.IsNullOrWhiteSpace(charset))
        {
            try { encoding = Encoding.GetEncoding(charset); }
            catch (ArgumentException) { }
        }
        string text = encoding.GetString(bounded.GetBuffer(), 0, checked((int)bounded.Length));
        return truncated ? text + "\n[provider error body truncated]" : text;
    }

    static JsonArray Clone(List<JsonNode> messages) => new(messages.Select(message => message.DeepClone()).ToArray());
    static JsonNode? TryParse(string data) { try { return JsonNode.Parse(data); } catch { return null; } }
    static void AppendContent(string? delta, StringBuilder target, Action<string>? callback)
    {
        if (string.IsNullOrEmpty(delta)) return;
        AppendBounded(target, delta, MaxContentCharacters, "provider content");
        callback?.Invoke(delta);
    }

    static void AppendRawEvent(StringBuilder target, string data)
    {
        AppendBounded(target, data, MaxRawResponseCharacters, "provider raw response");
        AppendBounded(target, Environment.NewLine, MaxRawResponseCharacters, "provider raw response");
    }

    static void AppendBounded(StringBuilder target, string value, int limit, string label)
    {
        if (value.Length > limit - target.Length)
            throw new InvalidDataException($"{label} exceeded the {limit}-character limit.");
        target.Append(value);
    }
    static JsonObject ToolAccumulator(Dictionary<int, JsonObject> tools, int index)
    {
        if (tools.TryGetValue(index, out var existing)) return existing;
        var created = new JsonObject { ["id"] = "", ["type"] = "function", ["function"] = new JsonObject { ["name"] = "", ["arguments"] = "" } };
        tools[index] = created;
        return created;
    }
    static void AppendTool(JsonObject target, string? id, string? name, string? arguments)
    {
        if (!string.IsNullOrWhiteSpace(id)) target["id"] = id;
        var function = target["function"]!.AsObject();
        if (!string.IsNullOrWhiteSpace(name)) function["name"] = name;
        if (!string.IsNullOrEmpty(arguments))
        {
            string existing = function["arguments"]?.GetValue<string>() ?? "";
            if (arguments.Length > MaxToolArgumentsCharacters - existing.Length)
                throw new InvalidDataException($"provider tool arguments exceeded the {MaxToolArgumentsCharacters}-character limit.");
            function["arguments"] = existing + arguments;
        }
    }
    static void Finish(ChatResult result, StringBuilder content, StringBuilder raw, Dictionary<int, JsonObject> tools, JsonObject body, Logger log)
    {
        result.Content = content.ToString();
        result.RawResponse = raw.ToString();
        if (tools.Count > 0) result.ToolCalls = new JsonArray(tools.OrderBy(pair => pair.Key).Select(pair => (JsonNode?)pair.Value).ToArray());
        log.WriteCall(body.ToJsonString(), result.RawResponse);
    }

    static JsonArray ToResponsesInput(List<JsonNode> messages)
    {
        var input = new JsonArray();
        foreach (var message in messages)
        {
            string role = message?["role"]?.GetValue<string>() ?? "user";
            if (role == "tool")
            {
                var outputItem = new JsonObject { ["type"] = "function_call_output", ["call_id"] = message?["tool_call_id"]?.GetValue<string>() ?? "", ["output"] = ContentText(message?["content"]) };
                if (message?["is_error"]?.GetValue<bool>() == true) outputItem["status"] = "error";
                input.Add(outputItem);
                continue;
            }
            var content = new JsonArray();
            if (message?["content"] is JsonArray parts)
            {
                foreach (var part in parts)
                {
                    if (part?["type"]?.GetValue<string>() == "text") content.Add(new JsonObject { ["type"] = role == "assistant" ? "output_text" : "input_text", ["text"] = part?["text"]?.GetValue<string>() ?? "" });
                    if (part?["type"]?.GetValue<string>() == "image_url") content.Add(new JsonObject { ["type"] = "input_image", ["image_url"] = part?["image_url"]?["url"]?.GetValue<string>() ?? "" });
                }
            }
            else
            {
                string text = ContentText(message?["content"]);
                if (!string.IsNullOrEmpty(text)) content.Add(new JsonObject { ["type"] = role == "assistant" ? "output_text" : "input_text", ["text"] = text });
            }
            if (content.Count > 0) input.Add(new JsonObject { ["role"] = role, ["content"] = content });
            foreach (var call in message?["tool_calls"]?.AsArray() ?? [])
                input.Add(new JsonObject { ["type"] = "function_call", ["call_id"] = call?["id"]?.GetValue<string>() ?? "", ["name"] = call?["function"]?["name"]?.GetValue<string>() ?? "", ["arguments"] = call?["function"]?["arguments"]?.GetValue<string>() ?? "{}" });
        }
        return input;
    }

    static JsonArray ToResponsesTools(string schema)
    {
        var output = new JsonArray();
        foreach (var tool in JsonNode.Parse(schema)?.AsArray() ?? [])
            output.Add(new JsonObject { ["type"] = "function", ["name"] = tool?["function"]?["name"]?.GetValue<string>() ?? "", ["description"] = tool?["function"]?["description"]?.GetValue<string>() ?? "", ["parameters"] = tool?["function"]?["parameters"]?.DeepClone() });
        return output;
    }

    static JsonArray ToAnthropicTools(string schema)
    {
        var output = new JsonArray();
        foreach (var tool in JsonNode.Parse(schema)?.AsArray() ?? [])
            output.Add(new JsonObject { ["name"] = tool?["function"]?["name"]?.GetValue<string>() ?? "", ["description"] = tool?["function"]?["description"]?.GetValue<string>() ?? "", ["input_schema"] = tool?["function"]?["parameters"]?.DeepClone() });
        return output;
    }

    static (string system, JsonArray messages) ToAnthropicMessages(List<JsonNode> source)
    {
        var systems = new List<string>();
        var output = new JsonArray();
        foreach (var message in source)
        {
            string role = message?["role"]?.GetValue<string>() ?? "user";
            if (role == "system") { systems.Add(ContentText(message?["content"])); continue; }
            if (role == "tool")
            {
                AddAnthropicMessage(output, "user", new JsonObject { ["type"] = "tool_result", ["tool_use_id"] = message?["tool_call_id"]?.GetValue<string>() ?? "", ["content"] = ContentText(message?["content"]) });
                continue;
            }
            var content = new JsonArray();
            if (message?["content"] is JsonArray parts)
            {
                foreach (var part in parts)
                {
                    if (part?["type"]?.GetValue<string>() == "text") content.Add(new JsonObject { ["type"] = "text", ["text"] = part?["text"]?.GetValue<string>() ?? "" });
                    if (part?["type"]?.GetValue<string>() == "image_url" && TryDataUrl(part?["image_url"]?["url"]?.GetValue<string>() ?? "", out var mediaType, out var data))
                        content.Add(new JsonObject { ["type"] = "image", ["source"] = new JsonObject { ["type"] = "base64", ["media_type"] = mediaType, ["data"] = data } });
                }
            }
            else content.Add(new JsonObject { ["type"] = "text", ["text"] = ContentText(message?["content"]) });
            foreach (var call in message?["tool_calls"]?.AsArray() ?? [])
            {
                JsonNode input;
                try { input = JsonNode.Parse(call?["function"]?["arguments"]?.GetValue<string>() ?? "{}") ?? new JsonObject(); } catch { input = new JsonObject(); }
                content.Add(new JsonObject { ["type"] = "tool_use", ["id"] = call?["id"]?.GetValue<string>() ?? "", ["name"] = call?["function"]?["name"]?.GetValue<string>() ?? "", ["input"] = input });
            }
            AddAnthropicMessage(output, role == "assistant" ? "assistant" : "user", content);
        }
        return (string.Join("\n\n", systems.Where(value => !string.IsNullOrWhiteSpace(value))), output);
    }

    static void AddAnthropicMessage(JsonArray messages, string role, JsonNode content)
    {
        JsonArray blocks = content as JsonArray ?? new JsonArray(content);
        if (messages.LastOrDefault() is JsonObject last && last["role"]?.GetValue<string>() == role)
        {
            foreach (var block in blocks.ToArray()) last["content"]!.AsArray().Add(block?.DeepClone());
        }
        else messages.Add(new JsonObject { ["role"] = role, ["content"] = blocks.DeepClone() });
    }

    static string ContentText(JsonNode? content)
    {
        if (content is JsonValue value && value.TryGetValue<string>(out var text)) return text;
        if (content is JsonArray parts) return string.Join("\n", parts.Where(part => part?["type"]?.GetValue<string>() == "text").Select(part => part?["text"]?.GetValue<string>() ?? ""));
        return "";
    }

    static bool TryDataUrl(string url, out string mediaType, out string data)
    {
        mediaType = "image/png"; data = "";
        if (!url.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return false;
        int semicolon = url.IndexOf(';'), comma = url.IndexOf(',');
        if (semicolon < 5 || comma < semicolon) return false;
        mediaType = url[5..semicolon]; data = url[(comma + 1)..]; return true;
    }

    bool IsDeepSeek() =>
        _profile.Provider == "deepseek" ||
        _profile.BaseUrl?.Contains("deepseek", StringComparison.OrdinalIgnoreCase) == true ||
        _profile.Model?.StartsWith("deepseek", StringComparison.OrdinalIgnoreCase) == true;

    sealed class BoundedLineReader
    {
        readonly StreamReader _reader;
        readonly char[] _buffer = new char[8192];
        int _position;
        int _count;
        bool _skipLeadingLf;

        public BoundedLineReader(StreamReader reader) => _reader = reader;

        public async ValueTask<string?> ReadLineAsync(int maxCharacters, CancellationToken ct)
        {
            var line = new StringBuilder(Math.Min(256, maxCharacters), maxCharacters);
            bool sawCharacter = false;
            while (true)
            {
                int value = await ReadCharacterAsync(ct);
                if (value < 0) return sawCharacter ? line.ToString() : null;
                char current = (char)value;
                if (_skipLeadingLf)
                {
                    _skipLeadingLf = false;
                    if (current == '\n') continue;
                }
                sawCharacter = true;
                if (current == '\r')
                {
                    _skipLeadingLf = true;
                    return line.ToString();
                }
                if (current == '\n') return line.ToString();
                if (line.Length == maxCharacters)
                    throw new InvalidDataException($"SSE line exceeded the {maxCharacters}-character limit.");
                line.Append(current);
            }
        }

        async ValueTask<int> ReadCharacterAsync(CancellationToken ct)
        {
            if (_position >= _count)
            {
                _count = await _reader.ReadAsync(_buffer.AsMemory(), ct);
                _position = 0;
                if (_count == 0) return -1;
            }
            return _buffer[_position++];
        }
    }
}
