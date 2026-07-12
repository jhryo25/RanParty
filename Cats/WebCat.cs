using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml.Linq;
using RanParty.Core;

namespace RanParty.Cats;

public sealed class WebCat : Cat
{
    private const int MaxResults = 8;
    private const int MaxPageCharacters = 60_000;
    private const int MaxSearchCharacters = 600_000;
    private const long MaxResponseBytes = 2 * 1024 * 1024;
    private const int MinDomainIntervalMs = 500;
    private static readonly HttpClient Http = CreateHttpClient();
    private static readonly ConcurrentDictionary<string, DateTime> DomainLastRequest = new(StringComparer.OrdinalIgnoreCase);
    private readonly SearchCache _cache;

    public WebCat(SearchCache? cache = null)
    {
        _cache = cache ?? new SearchCache();
        Name = "WebCat";
        Add("web_search", "Search the public web. Returns titles, URLs, and snippets.",
            "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"},\"count\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":8}},\"required\":[\"query\"]}");
        Add("web_search_cached", "Search with 24h result cache.",
            "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"},\"count\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":8}},\"required\":[\"query\"]}");
        Add("web_fetch", "Read a public HTTP/HTTPS page as plain text.",
            "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}");
        Add("web_fetch_cached", "Read a public page with 7d cache.",
            "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}");

        AddParallel("web_search"); AddParallel("web_search_cached");
        AddParallel("web_fetch"); AddParallel("web_fetch_cached");
    }

    public override ToolResult Execute(string tool, JsonNode args) => ExecuteCore(tool, args, CancellationToken.None);

    public override Task<ToolResult> ExecuteAsync(string tool, JsonNode args, CancellationToken ct) =>
        Task.Run(() => ExecuteCore(tool, args, ct), ct);

    private ToolResult ExecuteCore(string tool, JsonNode args, CancellationToken ct)
    {
        try
        {
            ct.ThrowIfCancellationRequested();
            return tool switch
            {
                "web_search" => Search(args?["query"]?.GetValue<string>() ?? "", args?["count"]?.GetValue<int>() ?? 5, ct),
                "web_search_cached" => SearchCached(args?["query"]?.GetValue<string>() ?? "", args?["count"]?.GetValue<int>() ?? 5, ct),
                "web_fetch" => Fetch(args?["url"]?.GetValue<string>() ?? "", ct),
                "web_fetch_cached" => FetchCached(args?["url"]?.GetValue<string>() ?? "", ct),
                _ => Error("Unknown WebCat tool: " + tool)
            };
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return Error(FriendlyNetworkFailure("读取网页失败", ex)); }
    }

    private ToolResult SearchCached(string query, int count, CancellationToken ct)
    {
        if (_cache.TryGet(query, out var cached)) return Ok(cached);
        var result = Search(query, count, ct);
        if (!result.IsError) _cache.Put(query, result.Content, "ranparty-local");
        return result;
    }

    private ToolResult FetchCached(string url, CancellationToken ct)
    {
        string key = "fetch:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(url)))[..16].ToLowerInvariant();
        if (_cache.TryGet(key, out var cached, TimeSpan.FromDays(7))) return Ok(cached);
        var result = Fetch(url, ct);
        if (!result.IsError) _cache.Put(key, result.Content, "ranparty-local");
        return result;
    }

    private static ToolResult Search(string query, int requestedCount, CancellationToken ct)
    {
        query = query.Trim();
        if (string.IsNullOrWhiteSpace(query)) return Error("query is required");
        int count = Math.Clamp(requestedCount, 1, MaxResults);

        Exception? bingRssError = null;
        try { var results = SearchBingRss(query, count, ct); if (results.Count > 0) return SearchResult(query, "bing-rss", results); }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { bingRssError = ex; }

        Exception? bingHtmlError = null;
        try { var results = SearchBingHtml(query, count, ct); if (results.Count > 0) return SearchResult(query, "bing-html", results); }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { bingHtmlError = ex; }

        try
        {
            var results = SearchDuckDuckGo(query, count, ct);
            if (results.Count > 0) return SearchResult(query, "duckduckgo", results);
            return Error("No public search results were returned.");
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return Error(FriendlyNetworkFailure("搜索失败", ex)); }
    }

    private static string FriendlyNetworkFailure(string action, Exception ex)
    {
        string detail = ex.Message;
        if (detail.StartsWith("Request blocked:", StringComparison.OrdinalIgnoreCase))
            return $"联网工具被安全策略拦截，未向目标发送请求。展开详情可查看原因。\n诊断：{detail}";
        return $"{action}暂时不可用。展开详情可查看原因。\n诊断：{detail}";
    }

    private static JsonArray SearchBingRss(string query, int count, CancellationToken ct)
    {
        var url = new Uri("https://www.bing.com/search?format=rss&q=" + Uri.EscapeDataString(query));
        using var response = SendPublicGet(url, ct);
        string xml = ReadLimitedText(response, MaxPageCharacters);
        var document = XDocument.Parse(xml);
        var results = new JsonArray();
        foreach (var item in document.Descendants("item").Take(count))
        {
            string title = CleanText(item.Element("title")?.Value ?? "");
            string link = item.Element("link")?.Value?.Trim() ?? "";
            string snippet = CleanText(item.Element("description")?.Value ?? "");
            if (string.IsNullOrWhiteSpace(title) || !IsPublicHttpUrl(link)) continue;
            results.Add(new JsonObject { ["title"] = title, ["url"] = link, ["snippet"] = snippet });
        }
        return results;
    }

    private static JsonArray SearchBingHtml(string query, int count, CancellationToken ct)
    {
        var url = new Uri("https://www.bing.com/search?setlang=en-US&cc=US&q=" + Uri.EscapeDataString(query));
        using var response = SendPublicGet(url, ct);
        string html = ReadLimitedText(response, MaxSearchCharacters);
        var results = new JsonArray();
        foreach (Match item in Regex.Matches(html, "<li class=\"b_algo\"[^>]*>(.*?)</li>", RegexOptions.IgnoreCase | RegexOptions.Singleline))
        {
            var heading = Regex.Match(item.Groups[1].Value, "<h2[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>\\s*</h2>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            if (!heading.Success) continue;
            string link = WebUtility.HtmlDecode(heading.Groups[1].Value).Trim();
            string title = StripTags(heading.Groups[2].Value);
            var caption = Regex.Match(item.Groups[1].Value, "<div class=\"b_caption\"[^>]*>.*?<p[^>]*>(.*?)</p>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            string snippet = caption.Success ? StripTags(caption.Groups[1].Value) : "";
            if (string.IsNullOrWhiteSpace(title) || !IsPublicHttpUrl(link)) continue;
            results.Add(new JsonObject { ["title"] = title, ["url"] = link, ["snippet"] = snippet });
            if (results.Count >= count) break;
        }
        return results;
    }

    private static JsonArray SearchDuckDuckGo(string query, int count, CancellationToken ct)
    {
        var url = new Uri("https://lite.duckduckgo.com/lite/?q=" + Uri.EscapeDataString(query));
        using var response = SendPublicGet(url, ct);
        string html = ReadLimitedText(response, MaxPageCharacters);
        var results = new JsonArray();
        var rowRegex = new Regex("<tr class=\"result-snippet\">.*?</tr>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        var linkRegex = new Regex("<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        var snippetRegex = new Regex("<td class=\"result-snippet\">(.*?)</td>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        foreach (Match row in rowRegex.Matches(html))
        {
            var linkMatch = linkRegex.Match(row.Value);
            if (!linkMatch.Success) continue;
            string link = WebUtility.HtmlDecode(linkMatch.Groups[1].Value).Trim();
            string title = StripTags(linkMatch.Groups[2].Value);
            string snippet = snippetRegex.Match(row.Value) is { Success: true } sm ? StripTags(sm.Groups[1].Value) : "";
            if (string.IsNullOrWhiteSpace(title) || !IsPublicHttpUrl(link)) continue;
            results.Add(new JsonObject { ["title"] = title, ["url"] = link, ["snippet"] = snippet });
            if (results.Count >= count) break;
        }
        if (results.Count == 0)
        {
            // DuckDuckGo JSON API fallback
            try
            {
                var apiUrl = new Uri("https://api.duckduckgo.com/?q=" + Uri.EscapeDataString(query) + "&format=json&no_html=1&skip_disambig=1");
                using var apiResponse = SendPublicGet(apiUrl, ct);
                string json = ReadLimitedText(apiResponse, MaxPageCharacters);
                var root = JsonNode.Parse(json) as JsonObject;
                if (root != null)
                {
                    string heading = root["Heading"]?.GetValue<string>() ?? query;
                    string absUrl = root["AbstractURL"]?.GetValue<string>() ?? "";
                    string absText = root["AbstractText"]?.GetValue<string>() ?? "";
                    if (!string.IsNullOrWhiteSpace(absText) && IsPublicHttpUrl(absUrl))
                        results.Add(new JsonObject { ["title"] = heading, ["url"] = absUrl, ["snippet"] = absText });
                    foreach (var topic in (root["RelatedTopics"] as JsonArray ?? new JsonArray()).OfType<JsonObject>())
                    {
                        string t = topic["Text"]?.GetValue<string>() ?? "";
                        string u = topic["FirstURL"]?.GetValue<string>() ?? "";
                        if (!string.IsNullOrWhiteSpace(t) && IsPublicHttpUrl(u))
                            results.Add(new JsonObject { ["title"] = "", ["url"] = u, ["snippet"] = CleanText(t) });
                    }
                }
            }
            catch (OperationCanceledException) { throw; }
            catch { }
        }
        return results;
    }

    private static void AddResult(JsonArray results, string title, string url, string snippet, int count) { }

    private static ToolResult SearchResult(string query, string provider, JsonArray results)
    {
        return Ok(new JsonObject { ["query"] = query, ["provider"] = provider, ["results"] = results }.ToJsonString());
    }

    private static ToolResult Fetch(string url, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url)) return Error("url is required");
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return Error("Only HTTP/HTTPS URLs are allowed.");
        var uri = new Uri(url);
        using var response = SendPublicGet(uri, ct);
        string mediaType = response.Content.Headers.ContentType?.MediaType ?? "";
        if (!IsTextContent(mediaType)) return Error("Content is not text: " + mediaType);
        string text = ReadLimitedText(response, MaxPageCharacters);
        string title = ExtractTitle(text);
        string body = HtmlToText(Regex.Replace(text, "<title[^>]*>.*?</title>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline));
        return Ok((string.IsNullOrWhiteSpace(title) ? "" : "Title: " + title + "\n\n") + body);
    }

    private static HttpResponseMessage SendPublicGet(Uri initialUri, CancellationToken ct)
    {
        EnsurePublicUri(initialUri);
        Uri current = initialUri;
        for (int redirect = 0; redirect <= 5; redirect++)
        {
            ct.ThrowIfCancellationRequested();
            ThrottleDomain(current.Host);
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Accept.ParseAdd("text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1");
            var response = Http.Send(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is >= 300 and < 400 && response.Headers.Location is not null)
            {
                Uri next = response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(current, response.Headers.Location);
                response.Dispose();
                EnsurePublicUri(next); // pre-validate redirect target before following
                current = next;
                continue;
            }
            if (!response.IsSuccessStatusCode) { string s = "HTTP " + (int)response.StatusCode + " " + response.ReasonPhrase; response.Dispose(); throw new InvalidOperationException(s); }
            if (response.Content.Headers.ContentLength is > MaxResponseBytes) { response.Dispose(); throw new InvalidOperationException("Response is larger than 2 MB."); }
            return response;
        }
        throw new InvalidOperationException("Too many redirects.");
    }

    private static void EnsurePublicUri(Uri uri)
    {
        if (uri.Scheme is not ("http" or "https")) throw new InvalidOperationException("Only HTTP and HTTPS are allowed.");
        if (uri.Port is not (80 or 443)) throw new InvalidOperationException("Only ports 80 and 443 are allowed.");
        if (string.IsNullOrWhiteSpace(uri.Host) || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".local", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Localhost and .local addresses are blocked.");
        try
        {
            var addresses = Dns.GetHostAddresses(uri.DnsSafeHost);
            if (addresses.Length == 0 || addresses.Any(address => !IsPublicAddress(address)))
                throw new InvalidOperationException("Request blocked: host resolves to a non-public or unsupported address.");
        }
        catch (InvalidOperationException) { throw; }
        catch (Exception ex) when (ex is SocketException or ArgumentException)
        {
            throw new InvalidOperationException("Request blocked: DNS validation failed.", ex);
        }
    }

    internal static bool IsPublicAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) return IsPublicAddress(address.MapToIPv4());
        byte[] bytes = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            int a = bytes[0], b = bytes[1], c = bytes[2];
            if (a == 0 || a == 10 || a == 127) return false;
            if (a == 100 && b is >= 64 and <= 127) return false; // CGNAT
            if (a == 169 && b == 254) return false;
            if (a == 172 && b is >= 16 and <= 31) return false;
            if (a == 192 && b == 168) return false;
            if (a == 192 && b == 0 && c is 0 or 2) return false;
            if (a == 192 && b == 88 && c == 99) return false;
            if (a == 198 && b is 18 or 19) return false;
            if (a == 198 && b == 51 && c == 100) return false;
            if (a == 203 && b == 0 && c == 113) return false;
            return a is > 0 and < 224;
        }
        if (address.AddressFamily != AddressFamily.InterNetworkV6) return false;
        if (address.Equals(IPAddress.IPv6None) || address.Equals(IPAddress.IPv6Any)
            || address.Equals(IPAddress.IPv6Loopback) || address.IsIPv6LinkLocal
            || address.IsIPv6SiteLocal || address.IsIPv6Multicast) return false;
        if ((bytes[0] & 0xfe) == 0xfc) return false; // fc00::/7 ULA
        if (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8) return false; // documentation
        if (bytes[0] == 0x01 && bytes.Skip(1).Take(7).All(value => value == 0)) return false; // 100::/64 discard-only
        return true;
    }

    private static bool IsPublicHttpUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return false;
        try { EnsurePublicUri(new Uri(url)); return true; } catch { return false; }
    }

    private static bool IsTextContent(string mediaType) =>
        mediaType.StartsWith("text/") || mediaType.Contains("json") || mediaType.Contains("xml") || mediaType.Contains("javascript") || string.IsNullOrWhiteSpace(mediaType);

    private static string ReadLimitedText(HttpResponseMessage response, int maxCharacters)
    {
        using var stream = response.Content.ReadAsStream();
        using var reader = new StreamReader(stream, Encoding.UTF8, true);
        var builder = new StringBuilder(Math.Min(maxCharacters, 16_384));
        var buffer = new char[4096];
        while (builder.Length < maxCharacters)
        {
            int read = reader.Read(buffer, 0, Math.Min(buffer.Length, maxCharacters - builder.Length));
            if (read <= 0) break;
            builder.Append(buffer, 0, read);
        }
        return builder.ToString();
    }

    private static string ExtractTitle(string html)
    {
        var match = Regex.Match(html, "<title[^>]*>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        return match.Success ? CleanText(match.Groups[1].Value) : "";
    }

    private static string StripTags(string html) => CleanText(Regex.Replace(html, "<[^>]+>", " "));

    private static string HtmlToText(string html)
    {
        string text = Regex.Replace(html, "<(script|style|noscript|template|svg)[^>]*>.*?</\\1>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        text = Regex.Replace(text, "</?(p|div|section|article|main|header|footer|h[1-6]|li|tr|br|blockquote)[^>]*>", "\n", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, "<[^>]+>", " ");
        return CleanText(text, preserveLines: true);
    }

    private static string CleanText(string value, bool preserveLines = false)
    {
        string text = WebUtility.HtmlDecode(value ?? "").Replace('\0', ' ');
        text = Regex.Replace(text, "[\\t\\f\\v ]+", " ");
        if (preserveLines) { text = Regex.Replace(text, " ?\\r?\\n ?", "\n"); text = Regex.Replace(text, "\\n{3,}", "\n\n"); }
        else text = Regex.Replace(text, "\\s+", " ");
        return text.Trim();
    }

    private static HttpClient CreateHttpClient()
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.All,
            ConnectCallback = ConnectPublicAsync
        };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("RanParty/1.0 (+controlled-web-tool)");
        return client;
    }

    private static async ValueTask<Stream> ConnectPublicAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        IPAddress[] addresses;
        try { addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct); }
        catch (Exception ex) when (ex is SocketException or ArgumentException)
        {
            throw new HttpRequestException("Request blocked: DNS resolution failed.", ex);
        }
        if (addresses.Length == 0 || addresses.Any(address => !IsPublicAddress(address)))
            throw new HttpRequestException("Request blocked: connection target is not a public address.");

        Exception? lastError = null;
        foreach (IPAddress address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (Exception ex) when (ex is SocketException or OperationCanceledException)
            {
                socket.Dispose();
                if (ex is OperationCanceledException) throw;
                lastError = ex;
            }
        }
        throw new HttpRequestException("Unable to connect to a validated public address.", lastError);
    }

    private static ToolResult Ok(string content) => new() { Content = content };
    private static ToolResult Ok(JsonNode node) => new() { Content = node.ToJsonString() };
    private static ToolResult Error(string content) => new() { Content = "ERR " + content, Error = ErrorKind.Unknown };

    private static void ThrottleDomain(string host)
    {
        var now = DateTime.UtcNow;
        if (DomainLastRequest.TryGetValue(host, out var last))
        {
            double elapsed = (now - last).TotalMilliseconds;
            if (elapsed < MinDomainIntervalMs) Thread.Sleep(Math.Max(1, MinDomainIntervalMs - (int)elapsed));
        }
        DomainLastRequest[host] = DateTime.UtcNow;
    }

}
