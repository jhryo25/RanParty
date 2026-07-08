using System;
using System.Collections.Generic;
using System.Linq;

namespace RanParty.Core;

/// <summary>BM25 文档评分，用于冷归档检索和去重</summary>
public static class Bm25
{
    const double k1 = 1.5, b = 0.75;

    /// <summary>搜索 top-K 文档，返回 (index, score)，按分降序</summary>
    public static List<(int index, double score)> Search(string query, List<string> docs, int topK = 3)
    {
        if (docs.Count == 0 || string.IsNullOrWhiteSpace(query)) return new();
        var qWords = Tokenize(query);
        if (qWords.Count == 0) return new();

        int N = docs.Count;
        var docTokens = docs.Select(Tokenize).ToList();
        double avgdl = docTokens.Average(d => (double)d.Count);

        var scores = new List<(int idx, double score)>();
        for (int i = 0; i < N; i++)
        {
            var dWords = docTokens[i];
            if (dWords.Count == 0) continue;
            double score = 0;
            foreach (var qw in qWords.Distinct())
            {
                int df = docTokens.Count(d => d.Contains(qw));
                double idf = Math.Log((N - df + 0.5) / (df + 0.5) + 1);
                int tf = dWords.Count(w => w == qw);
                double norm = k1 * (1 - b + b * dWords.Count / avgdl);
                score += idf * (tf * (k1 + 1)) / (tf + norm);
            }
            if (score > 0) scores.Add((i, score));
        }
        return scores.OrderByDescending(s => s.score).Take(topK).ToList();
    }

    /// <summary>提取关键词（2字以上、去停用词）</summary>
    public static List<string> Tokenize(string text)
    {
        var raw = (text ?? "").ToLowerInvariant()
            .Split(new[] { ' ', '\n', '\r', '\t', '.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '/', '\\', '-', '_', '!', '?', '\'', '"', '`', '*', '#', '@', '|', '<', '>', '=', '+' },
                StringSplitOptions.RemoveEmptyEntries);
        return raw.Where(w => w.Length > 1 && !StopWords.Contains(w)).ToList();
    }

    /// <summary>计算两段文本的关键词重叠率（用于去重判定）</summary>
    public static double KeywordOverlap(string a, string b)
    {
        var ka = new HashSet<string>(Tokenize(a));
        var kb = new HashSet<string>(Tokenize(b));
        if (ka.Count == 0 || kb.Count == 0) return 0;
        int overlap = ka.Count(kb.Contains);
        return (double)overlap / Math.Min(ka.Count, kb.Count);
    }

    static readonly HashSet<string> StopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "the", "and", "for", "that", "this", "with", "from", "have", "been",
        "was", "are", "not", "but", "you", "all", "can", "had", "her", "his",
        "its", "one", "out", "she", "than", "them", "then", "were", "when"
    };
}
