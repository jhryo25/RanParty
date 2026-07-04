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
}

public class ApiClient
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    readonly ModelProfile _profile;

    public ApiClient(ModelProfile profile) => _profile = profile;
    public ApiClient(string apiKey, string baseUrl) : this(new ModelProfile { ApiKey = apiKey, BaseUrl = baseUrl }) { }
    public void SetKey(string key) => _profile.ApiKey = key;
    public void SetBase(string baseUrl) => _profile.BaseUrl = baseUrl;

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
        string error = await response.Content.ReadAsStringAsync(ct);
        response.Dispose();
        throw new InvalidOperationException($"{ProviderLabel()} 请求失败（HTTP {(int)response.StatusCode}，{endpoint}）：{FriendlyError(error)}");
    }

    async Task<ChatResult> ReadOpenAiChatStream(HttpResponseMessage response, JsonObject body, Logger log,
        Action<string>? onDelta, Action<string>? onReasoning, CancellationToken ct)
    {
        var result = new ChatResult();
        var content = new StringBuilder();
        var raw = new StringBuilder();
        var tools = new Dictionary<int, JsonObject>();
        await ReadSse(response, ct, data =>
        {
            if (data == "[DONE]") return;
            raw.AppendLine(data);
            var node = TryParse(data);
            var delta = node?["choices"] is JsonArray choices && choices.Count > 0 ? choices[0]?["delta"] : null;
            Append(delta?["content"]?.GetValue<string>(), content, onDelta);
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
        });
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
        await ReadSse(response, ct, data =>
        {
            if (data == "[DONE]") return;
            raw.AppendLine(data);
            var node = TryParse(data);
            string type = node?["type"]?.GetValue<string>() ?? "";
            if (type == "response.output_text.delta") Append(node?["delta"]?.GetValue<string>(), content, onDelta);
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
            }
        });
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
        await ReadSse(response, ct, data =>
        {
            raw.AppendLine(data);
            var node = TryParse(data);
            string type = node?["type"]?.GetValue<string>() ?? "";
            int index = node?["index"]?.GetValue<int>() ?? 0;
            if (type == "content_block_start" && node?["content_block"]?["type"]?.GetValue<string>() == "tool_use")
                AppendTool(ToolAccumulator(tools, index), node?["content_block"]?["id"]?.GetValue<string>(), node?["content_block"]?["name"]?.GetValue<string>(), "");
            if (type == "content_block_delta")
            {
                string deltaType = node?["delta"]?["type"]?.GetValue<string>() ?? "";
                if (deltaType == "text_delta") Append(node?["delta"]?["text"]?.GetValue<string>(), content, onDelta);
                if (deltaType == "thinking_delta") onReasoning?.Invoke(node?["delta"]?["thinking"]?.GetValue<string>() ?? "");
                if (deltaType == "input_json_delta") AppendTool(ToolAccumulator(tools, index), null, null, node?["delta"]?["partial_json"]?.GetValue<string>());
            }
            var usage = node?["usage"] ?? node?["message"]?["usage"];
            result.UsageIn = usage?["input_tokens"]?.GetValue<int>() ?? result.UsageIn;
            result.UsageOut = usage?["output_tokens"]?.GetValue<int>() ?? result.UsageOut;
        });
        Finish(result, content, raw, tools, body, log);
        return result;
    }

    static async Task ReadSse(HttpResponseMessage response, CancellationToken ct, Action<string> onData)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
            if (line.StartsWith("data:", StringComparison.Ordinal)) onData(line[5..].Trim());
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
        try
        {
            var node = JsonNode.Parse(error);
            return node?["error"]?["message"]?.GetValue<string>() ?? node?["message"]?.GetValue<string>() ?? error;
        }
        catch { return error.Length > 800 ? error[..800] + "…" : error; }
    }

    static JsonArray Clone(List<JsonNode> messages) => new(messages.Select(message => message.DeepClone()).ToArray());
    static JsonNode? TryParse(string data) { try { return JsonNode.Parse(data); } catch { return null; } }
    static void Append(string? delta, StringBuilder target, Action<string>? callback) { if (string.IsNullOrEmpty(delta)) return; target.Append(delta); callback?.Invoke(delta); }
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
        if (!string.IsNullOrEmpty(arguments)) function["arguments"] = (function["arguments"]?.GetValue<string>() ?? "") + arguments;
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
                input.Add(new JsonObject { ["type"] = "function_call_output", ["call_id"] = message?["tool_call_id"]?.GetValue<string>() ?? "", ["output"] = ContentText(message?["content"]) });
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
}
