using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using RanParty.Cats;

namespace RanParty.Core;

/// <summary>PreHook: (tool, args) → (modifiedArgs | null, blockResult | null)</summary>
public delegate (JsonNode? args, ToolResult? block) PreToolHook(string tool, JsonNode? args);

/// <summary>PostHook: (tool, args, result) → modified result</summary>
public delegate ToolResult PostToolHook(string tool, JsonNode? args, ToolResult result);

/// <summary>工具执行前后钩子链，通配符 * 匹配所有工具</summary>
public class ToolHooks
{
    private readonly List<(string pattern, PreToolHook hook)> _pre = new();
    private readonly List<(string pattern, PostToolHook hook)> _post = new();

    public void AddPre(string toolPattern, PreToolHook hook) => _pre.Add((toolPattern, hook));
    public void AddPost(string toolPattern, PostToolHook hook) => _post.Add((toolPattern, hook));

    /// <summary>执行 pre hooks。返回被拦截的 ToolResult，或 null 表示放行</summary>
    public (JsonNode? args, ToolResult? block) RunPre(string tool, JsonNode? args)
    {
        JsonNode? current = args;
        foreach (var (pattern, hook) in _pre)
        {
            if (!Match(pattern, tool)) continue;
            var (modified, block) = hook(tool, current);
            if (block != null) return (current, block);
            if (modified != null) current = modified;
        }
        return (current, null);
    }

    /// <summary>执行 post hooks。按链顺序修改 result</summary>
    public ToolResult RunPost(string tool, JsonNode? args, ToolResult result)
    {
        ToolResult current = result;
        foreach (var (pattern, hook) in _post)
        {
            if (!Match(pattern, tool)) continue;
            current = hook(tool, args, current);
        }
        return current;
    }

    static bool Match(string pattern, string tool)
        => pattern == "*" || string.Equals(pattern, tool, StringComparison.Ordinal);
}
