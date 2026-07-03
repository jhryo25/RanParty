using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace RanParty.Core;

public class ChatResult
{
    public string Content = "";
    public JsonArray ToolCalls;
    public string RawResponse = "";
    public int UsageIn, UsageOut, UsageReasoning;
}

public class ApiClient
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    string _apiKey;
    string _baseUrl;

    public ApiClient(string apiKey, string baseUrl) { _apiKey = apiKey; _baseUrl = baseUrl; }
    public void SetKey(string k) { _apiKey = k; }
    public void SetBase(string b) { _baseUrl = b; }

    public async Task<ChatResult> Chat(string model, List<JsonNode> messages, string toolsSchema,
        Logger log, Action<string> onDelta, Action<string> onReasoning, CancellationToken ct = default)
    {
        var body = new JsonObject
        {
            ["model"] = model,
            ["messages"] = JsonNode.Parse(JsonSerializer.Serialize(messages)),
            ["stream"] = true,
            ["stream_options"] = new JsonObject { ["include_usage"] = true }
        };
        if (!string.IsNullOrEmpty(toolsSchema))
            body["tools"] = JsonNode.Parse(toolsSchema);

        string bodyStr = body.ToJsonString();
        string endpoint = (_baseUrl ?? "https://api.deepseek.com").TrimEnd('/') + "/chat/completions";
        var req = new HttpRequestMessage(HttpMethod.Post, endpoint);
        req.Content = new StringContent(bodyStr, Encoding.UTF8, "application/json");
        if (!string.IsNullOrEmpty(_apiKey))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        using var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode)
        {
            string err = await resp.Content.ReadAsStringAsync(ct);
            log.WriteCall(bodyStr, $"HTTP {(int)resp.StatusCode}\r\n{err}");
            throw new Exception($"API {(int)resp.StatusCode}: {err}");
        }

        var result = new ChatResult();
        var sbContent = new StringBuilder();
        var toolAcc = new Dictionary<int, JsonObject>();
        var respSb = new StringBuilder();

        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var sr = new StreamReader(stream);
        string line;
        while ((line = await sr.ReadLineAsync(ct)) != null)
        {
            if (string.IsNullOrEmpty(line) || !line.StartsWith("data:")) continue;
            string data = line.Substring(5).Trim();
            if (data == "[DONE]") break;
            respSb.AppendLine(data);
            try
            {
                var node = JsonNode.Parse(data);
                var delta = node?["choices"]?[0]?["delta"];
                if (delta == null) continue;
                var content = delta["content"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(content))
                {
                    sbContent.Append(content);
                    onDelta?.Invoke(content);
                }
                var reasoning = delta["reasoning_content"]?.GetValue<string>();
                if (!string.IsNullOrEmpty(reasoning))
                    onReasoning?.Invoke(reasoning);
                var tcs = delta["tool_calls"]?.AsArray();
                if (tcs != null)
                {
                    foreach (var tc in tcs)
                    {
                        int idx = tc?["index"]?.GetValue<int>() ?? 0;
                        if (!toolAcc.TryGetValue(idx, out var acc))
                        {
                            acc = new JsonObject
                            {
                                ["id"] = "",
                                ["type"] = "function",
                                ["function"] = new JsonObject { ["name"] = "", ["arguments"] = "" }
                            };
                            toolAcc[idx] = acc;
                        }
                        var fn = acc["function"]!.AsObject();
                        var id = tc?["id"]?.GetValue<string>();
                        if (!string.IsNullOrEmpty(id)) acc["id"] = id;
                        var name = tc?["function"]?["name"]?.GetValue<string>();
                        if (!string.IsNullOrEmpty(name)) fn["name"] = name;
                        var argsChunk = tc?["function"]?["arguments"]?.GetValue<string>();
                        if (!string.IsNullOrEmpty(argsChunk))
                            fn["arguments"] = (fn["arguments"]?.GetValue<string>() ?? "") + argsChunk;
                    }
                }
                // usage（最终 chunk 的顶层字段，不在 delta 内）
                var usage = node?["usage"];
                if (usage != null)
                {
                    result.UsageIn = usage["prompt_tokens"]?.GetValue<int>() ?? result.UsageIn;
                    result.UsageOut = usage["completion_tokens"]?.GetValue<int>() ?? result.UsageOut;
                    result.UsageReasoning = usage["completion_tokens_details"]?["reasoning_tokens"]?.GetValue<int>() ?? result.UsageReasoning;
                }
            }
            catch { }
        }

        result.Content = sbContent.ToString();
        if (toolAcc.Count > 0)
        {
            var arr = new JsonArray();
            foreach (var kv in toolAcc.OrderBy(k => k.Key)) arr.Add(kv.Value);
            result.ToolCalls = arr;
        }
        result.RawResponse = respSb.ToString();
        log.WriteCall(bodyStr, result.RawResponse);
        return result;
    }

    public async Task<string> Complete(string model, List<JsonNode> messages, Logger log, CancellationToken ct = default)
    {
        var body = new JsonObject
        {
            ["model"] = model,
            ["messages"] = JsonNode.Parse(JsonSerializer.Serialize(messages)),
            ["stream"] = false,
            ["max_tokens"] = 40
        };
        string bodyStr = body.ToJsonString();
        string endpoint = (_baseUrl ?? "https://api.deepseek.com").TrimEnd('/') + "/chat/completions";
        var req = new HttpRequestMessage(HttpMethod.Post, endpoint);
        req.Content = new StringContent(bodyStr, Encoding.UTF8, "application/json");
        if (!string.IsNullOrEmpty(_apiKey))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        using var resp = await Http.SendAsync(req, ct);
        string respStr = await resp.Content.ReadAsStringAsync(ct);
        log.WriteCall(bodyStr, respStr);
        if (!resp.IsSuccessStatusCode) return "";
        try
        {
            var node = JsonNode.Parse(respStr);
            return node?["choices"]?[0]?["message"]?["content"]?.GetValue<string>()?.Trim() ?? "";
        }
        catch { return ""; }
    }
}
