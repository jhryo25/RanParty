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
    private static int _searchCallCount;
    private const int MaxSearchCallsPerTurn = 20;
    private readonly SearchCache _cache;

    public WebCat(SearchCache cache = null)
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

    public override ToolResult Execute(string tool, JsonNode args)
    {
        if (tool is "web_search" or "web_search_cached" or "web_fetch" or "web_fetch_cached")
        {
            if (Interlocked.Increment(ref _searchCallCount) > MaxSearchCallsPerTurn)
                return new ToolResult { Content = "Search/fetch limit reached (20 per turn). Continue with existing results.", Error = ErrorKind.Unknown };
        }
        try
        {
            return tool switch
            {
                "web_search" => Search(args?["query"]?.GetValue<string>() ?? "", args?["count"]?.GetValue<int>() ?? 5),
                "web_search_cached" => SearchCached(args?["query"]?.GetValue<string>() ?? "", args?["count"]?.GetValue<int>() ?? 5),
                "web_fetch" => Fetch(args?["url"]?.GetValue<string>() ?? ""),
                "web_fetch_cached" => FetchCached(args?["url"]?.GetValue<string>() ?? ""),
                _ => Error("Unknown WebCat tool: " + tool)
            };
        }
        catch (Exception ex) { return Error("Web request failed: " + ex.Message); }
    }

    private ToolResult SearchCached(string query, int count)
    {
        if (_cache.TryGet(query, out var cached)) return Ok(cached);
        var result = Search(query, count);
        if (!result.IsError) _cache.Put(query, result.Content, "ranparty-local");
        return result;
    }

    private ToolResult FetchCached(string url)
    {
        string key = "fetch:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(url)))[..16].ToLowerInvariant();
        if (_cache.TryGet(key, out var cached, TimeSpan.FromDays(7))) return Ok(cached);
        var result = Fetch(url);
        if (!result.IsError) _cache.Put(key, result.Content, "ranparty-local");
        return result;
    }

    private static ToolResult Search(string query, int requestedCount)
    {
        query = query.Trim();
        if (string.IsNullOrWhiteSpace(query)) return Error("query is required");
        int count = Math.Clamp(requestedCount, 1, MaxResults);

        Exception? bingRssError = null;
        try { var results = SearchBingRss(query, count); if (results.Count > 0) return SearchResult(query, "bing-rss", results); }
        catch (Exception ex) { bingRssError = ex; }

        Exception? bingHtmlError = null;
        try { var results = SearchBingHtml(query, count); if (results.Count > 0) return SearchResult(query, "bing-html", results); }
        catch (Exception ex) { bingHtmlError = ex; }

        try
        {
            var results = SearchDuckDuckGo(query, count);
            if (results.Count > 0) return SearchResult(query, "duckduckgo", results);
            return Error("No public search results were returned.");
        }
        catch (Exception ex) { return Error("Search providers failed: " + ex.Message); }
    }

    private static JsonArray SearchBingRss(string query, int count)
    {
        var url = new Uri("https://www.bing.com/search?format=rss&q=" + Uri.EscapeDataString(query));
        using var response = SendPublicGet(url);
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

    private static JsonArray SearchBingHtml(string query, int count)
    {
        var url = new Uri("https://www.bing.com/search?setlang=en-US&cc=US&q=" + Uri.EscapeDataString(query));
        using var response = SendPublicGet(url);
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

    private static JsonArray SearchDuckDuckGo(string query, int count)
    {
        var url = new Uri("https://lite.duckduckgo.com/lite/?q=" + Uri.EscapeDataString(query));
        using var response = SendPublicGet(url);
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
                using var apiResponse = SendPublicGet(apiUrl);
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
            catch { }
        }
        return results;
    }

    private static void AddResult(JsonArray results, string title, string url, string snippet, int count) { }

    private static ToolResult SearchResult(string query, string provider, JsonArray results)
    {
        return Ok(new JsonObject { ["query"] = query, ["provider"] = provider, ["results"] = results }.ToJsonString());
    }

    private static ToolResult Fetch(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return Error("url is required");
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return Error("Only HTTP/HTTPS URLs are allowed.");
        var uri = new Uri(url);
        using var response = SendPublicGet(uri);
        string mediaType = response.Content.Headers.ContentType?.MediaType ?? "";
        if (!IsTextContent(mediaType)) return Error("Content is not text: " + mediaType);
        string text = ReadLimitedText(response, MaxPageCharacters);
        string title = ExtractTitle(text);
        string body = HtmlToText(Regex.Replace(text, "<title[^>]*>.*?</title>", "", RegexOptions.IgnoreCase | RegexOptions.Singleline));
        return Ok((string.IsNullOrWhiteSpace(title) ? "" : "Title: " + title + "\n\n") + body);
    }

    private static HttpResponseMessage SendPublicGet(Uri initialUri)
    {
        EnsurePublicUri(initialUri);
        Uri current = initialUri;
        for (int redirect = 0; redirect <= 5; redirect++)
        {
            ThrottleDomain(current.Host);
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            request.Headers.Accept.ParseAdd("text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.1");
            var response = Http.Send(request, HttpCompletionOption.ResponseHeadersRead);
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
            foreach (var addr in addresses)
            {
                byte[] bytes = addr.GetAddressBytes();
                if (addr.AddressFamily == AddressFamily.InterNetworkV6)
                {
                    // IPv6: block link-local, site-local, multicast, loopback
                    if (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80) throw new InvalidOperationException("Link-local IPv6 blocked.");
                    if (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0xc0) throw new InvalidOperationException("Site-local IPv6 blocked.");
                    if (addr.Equals(IPAddress.IPv6Loopback)) throw new InvalidOperationException("Loopback IPv6 blocked.");
                    if (addr.IsIPv6Multicast) throw new InvalidOperationException("Multicast IPv6 blocked.");
                    // Also block unique local addresses (fc00::/7, fd00::/8)
                    if (bytes[0] >= 0xfc && bytes[0] <= 0xfd) throw new InvalidOperationException("Unique local IPv6 blocked.");
                    continue;
                }
                // IPv4 checks
                if (bytes[0] == 10) throw new InvalidOperationException("Private network (10.x) is blocked.");
                if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) throw new InvalidOperationException("Private network (172.16-31.x) is blocked.");
                if (bytes[0] == 192 && bytes[1] == 168) throw new InvalidOperationException("Private network (192.168.x) is blocked.");
                if (bytes[0] == 127) throw new InvalidOperationException("Loopback is blocked.");
                if (bytes[0] == 169 && bytes[1] == 254) throw new InvalidOperationException("Link-local is blocked.");
                if (bytes[0] >= 224) throw new InvalidOperationException("Multicast/reserved is blocked.");
            }
        }
        catch (InvalidOperationException) { throw; }
        catch { }
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
        var handler = new HttpClientHandler { AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.All };
        var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("RanParty/1.0 (+controlled-web-tool)");
        return client;
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

    public static void ResetSearchCounter() => Interlocked.Exchange(ref _searchCallCount, 0);
}
