using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RanParty.Cats;
using RanParty.Core;

namespace RanParty.Backend;

internal sealed class BackendHost
{
    private static readonly HttpClient SkillHubClient = new() { Timeout = TimeSpan.FromSeconds(30) };
    private readonly TextReader _input;
    private readonly TextWriter _output;
    private readonly object _writeLock = new();
    private readonly Config _config = new();
    private readonly SessionStore _store = new();
    private readonly Logger _log = new();
    private readonly CatRegistry _registry = new();
    private readonly WebCat _webcat = new(new SearchCache());
    private readonly ConcurrentDictionary<string, BackendSession> _sessions = new();
    private readonly ConcurrentDictionary<string, PendingApproval> _approvals = new();
    private readonly ConcurrentDictionary<string, PendingClarification> _clarifications = new();
    private readonly ConcurrentDictionary<string, HashSet<string>> _sessionAllows = new();
    private readonly ConcurrentDictionary<string, string> _toolOutputs = new();
    private readonly ConcurrentDictionary<string, Queue<string>> _toolOutputQueues = new(); // session id → cache id 插入顺序（LRU 淘汰）
    private readonly SkillRegistry _skillRegistry = new();

    public BackendHost(TextReader input, TextWriter output)
    {
        _input = input;
        _output = output;
        _registry.Register(new IOCat(_config, _registry));
        _registry.Register(new MdCat(_config));
        _registry.Register(new ShellCat(_config));
        _registry.Register(new WebCat());
        ReloadSkillsAndNotify();
        RestoreSessions();
    }

    public async Task RunAsync()
    {
        Emit("backend.ready", new JsonObject { ["version"] = "1.0.0" });
        string? line;
        while ((line = await _input.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            _ = HandleLineAsync(line);
        }
    }

    private async Task HandleLineAsync(string line)
    {
        string requestId = "";
        try
        {
            var request = JsonNode.Parse(line)?.AsObject() ?? throw new InvalidOperationException("请求不是 JSON 对象");
            requestId = request["id"]?.GetValue<string>() ?? "";
            string method = request["method"]?.GetValue<string>() ?? "";
            var args = request["params"] as JsonObject ?? new JsonObject();
            JsonNode? result = method switch
            {
                "app.bootstrap" => Bootstrap(),
                "session.create" => CreateSession(args),
                "session.delete" => DeleteSession(args),
                "session.update" => UpdateSession(args),
                "session.compact" => await CompactSessionAsync(args),
                "chat.send" => StartChat(args),
                "chat.cancel" => CancelChat(args),
                "approval.respond" => RespondApproval(args),
                "clarification.respond" => RespondClarification(args),
                "settings.save" => SaveSettings(args),
                "profiles.save" => SaveProfile(args),
                "profiles.test" => await TestProfileAsync(args),
                "profiles.models" => await ListProviderModelsAsync(args),
                "profiles.setActive" => SetActiveProfile(args),
                "profiles.delete" => DeleteProfile(args),
                "characters.list" => ListCharacters(),
                "characters.read" => ReadCharacter(args),
                "characters.save" => SaveCharacter(args),
                "characters.rename" => RenameCharacter(args),
                "characters.delete" => DeleteCharacter(args),
                "skills.list" => ListSkills(args),
                "skills.marketplace.list" => ListSkillMarketplace(args),
                "skills.marketplace.install" => InstallMarketplaceSkill(args),
                "skills.marketplace.uninstall" => UninstallMarketplaceSkill(args),
                "skills.skillhub.list" => await ListSkillHubAsync(args),
                "skills.skillhub.install" => await InstallSkillHubAsync(args),
                "skills.skillhub.uninstall" => UninstallMarketplaceSkill(args),
                "workspace.files" => ListWorkspaceFiles(args),
                "path.open" => OpenPath(args),
                "path.preview" => PreviewPath(args),
                "file.saveDataUrl" => SaveDataUrl(args),
                "knowledge.list" => await KnowledgeList(args),
                "knowledge.update" => KnowledgeUpdate(args),
                "knowledge.search" => KnowledgeSearch(args),
                "connectors.list" => ListConnectors(),
                "connectors.save" => SaveConnector(args),
                "connectors.delete" => DeleteConnector(args),
                "connectors.test" => TestConnector(args),
                "connectors.tools" => ConnectorTools(args),
                _ => throw new InvalidOperationException($"未知方法: {method}")
            };
            Respond(requestId, result ?? new JsonObject());
        }
        catch (Exception ex)
        {
            _log.Err(ex.ToString());
            RespondError(requestId, ex.Message);
        }
        await Task.CompletedTask;
    }

    private JsonObject Bootstrap()
    {
        if (_sessions.IsEmpty) CreateSession(new JsonObject());
        return new JsonObject
        {
            ["sessions"] = new JsonArray(_sessions.Values.OrderByDescending(s => s.LastActive).Select(SessionJson).ToArray()),
            ["settings"] = SettingsJson(),
            ["tools"] = new JsonArray(_registry.Cats.SelectMany(c => c.Tools).Append("delegate_agent").Select(tool => (JsonNode?)JsonValue.Create(tool)).ToArray())
        };
    }

    private void RestoreSessions()
    {
        foreach (var (id, messages, meta, lastWrite) in _store.LoadAll())
        {
            var profile = FindProfile(meta.ProfileName);
            var session = new BackendSession
            {
                Id = id,
                Title = string.IsNullOrWhiteSpace(meta.Title) ? "新会话" : meta.Title,
                Workspace = meta.Workspace ?? "",
                ProfileName = profile.Name,
                Model = string.IsNullOrWhiteSpace(meta.Model) ? profile.Model : meta.Model,
                ApprovalMode = string.IsNullOrWhiteSpace(meta.ApprovalMode) ? _config.ShellMode : meta.ApprovalMode,
                Mode = NormalizeSessionMode(meta.Mode),
                GoalText = meta.GoalText ?? "",
                GoalStatus = NormalizeGoalStatus(meta.GoalStatus),
                TokensIn = meta.TokensIn,
                TokensOut = meta.TokensOut,
                ContextTokens = meta.ContextTokens,
                ContextThreshold = meta.ContextThreshold > 0 ? meta.ContextThreshold : _config.CompactThreshold,
                ContextWindow = meta.ContextWindow,
                LastActive = lastWrite,
                Messages = messages,
                L0Loaded = messages.Count > 0 && messages[0]?["role"]?.GetValue<string>() == "system"
            };
            if (session.ContextTokens <= 0)
            {
                session.ContextTokens = EstimateContextTokens(ContextMessages(session));
                session.LastInputTokens = session.ContextTokens;
            }
            _sessions[id] = session;
            WhitelistWorkspace(session.Workspace);
        }
    }

    private JsonObject CreateSession(JsonObject args)
    {
        var profile = _config.ActiveProfile;
        string workspace = StringArg(args, "workspace", "");
        var session = new BackendSession
        {
            Id = $"s_{DateTime.Now:yyyyMMddHHmmssfff}_{Guid.NewGuid():N}"[..31],
            Title = "新会话",
            Workspace = workspace,
            ProfileName = profile.Name,
            Model = profile.Model,
            ApprovalMode = _config.ShellMode,
            Mode = "default",
            GoalStatus = "active",
            ContextThreshold = _config.CompactThreshold,
            ContextWindow = profile.ContextWindow,
            LastActive = DateTime.Now
        };
        _sessions[session.Id] = session;
        WhitelistWorkspace(workspace);
        Save(session);
        var json = SessionJson(session);
        Emit("session.created", json.DeepClone());
        return json;
    }

    private JsonObject DeleteSession(JsonObject args)
    {
        string id = RequiredString(args, "sessionId");
        if (_sessions.TryRemove(id, out var session))
        {
            session.Cancellation?.Cancel();
            _store.Delete(id);
            _toolOutputQueues.TryRemove(id, out _);
            Emit("session.deleted", new JsonObject { ["sessionId"] = id });
        }
        return new JsonObject { ["sessionId"] = id };
    }

    private JsonObject UpdateSession(JsonObject args)
    {
        var session = GetSession(args);
        string previousProfileName = session.ProfileName;
        string previousModel = session.Model;
        if (args["title"] is JsonValue) session.Title = StringArg(args, "title", session.Title);
        if (args["workspace"] is JsonValue)
        {
            session.Workspace = StringArg(args, "workspace", session.Workspace);
            WhitelistWorkspace(session.Workspace);
            session.L0Loaded = false;
            RemoveSystemMessage(session);
        }
        if (args["profileName"] is JsonValue)
        {
            var profile = FindProfile(StringArg(args, "profileName", session.ProfileName));
            session.ProfileName = profile.Name;
            session.Model = profile.Model;
            session.ContextWindow = profile.ContextWindow;
            session.L0Loaded = false;
            RemoveSystemMessage(session);
        }
        if (args["model"] is JsonValue) session.Model = StringArg(args, "model", session.Model);
        if (args["approvalMode"] is JsonValue) session.ApprovalMode = StringArg(args, "approvalMode", session.ApprovalMode);
        if (args["mode"] is JsonValue)
        {
            string previousMode = session.Mode;
            session.Mode = NormalizeSessionMode(StringArg(args, "mode", session.Mode));
            if (!string.Equals(previousMode, session.Mode, StringComparison.Ordinal))
            {
                var modeNotice = new JsonObject
                {
                    ["role"] = "event",
                    ["event"] = "mode_changed",
                    ["content"] = ModeNotice(session),
                    ["mode"] = session.Mode,
                    ["context_excluded"] = true,
                    ["createdAt"] = DateTime.Now.ToString("O")
                };
                session.Messages.Add(modeNotice);
                Emit("message.added", new JsonObject { ["sessionId"] = session.Id, ["message"] = modeNotice.DeepClone() });
            }
        }
        if (args["goal"] is JsonObject goal)
        {
            session.GoalText = goal["text"]?.GetValue<string>()?.Trim() ?? session.GoalText;
            session.GoalStatus = NormalizeGoalStatus(goal["status"]?.GetValue<string>() ?? session.GoalStatus);
        }
        JsonObject? modelChanged = null;
        if (!string.Equals(previousProfileName, session.ProfileName, StringComparison.Ordinal) ||
            !string.Equals(previousModel, session.Model, StringComparison.Ordinal))
        {
            modelChanged = new JsonObject
            {
                ["role"] = "event",
                ["event"] = "model_changed",
                ["content"] = $"已切换模型：{previousProfileName} · {previousModel} → {session.ProfileName} · {session.Model}",
                ["previousProfileName"] = previousProfileName,
                ["previousModel"] = previousModel,
                ["profileName"] = session.ProfileName,
                ["model"] = session.Model,
                ["createdAt"] = DateTime.Now.ToString("O"),
                ["context_excluded"] = true
            };
            session.Messages.Add(modelChanged);
        }
        Save(session);
        var json = SessionJson(session);
        Emit("session.updated", json.DeepClone());
        if (modelChanged is not null)
        {
            Emit("message.added", new JsonObject
            {
                ["sessionId"] = session.Id,
                ["message"] = modelChanged.DeepClone()
            });
        }
        return json;
    }

    private async Task<JsonObject> CompactSessionAsync(JsonObject args)
    {
        var session = GetSession(args);
        if (session.Busy) throw new InvalidOperationException("当前会话正在生成，暂时不能总结上下文");
        EnsureL0(session);
        string requestedProfile = StringArg(args, "profileName", session.ProfileName);
        var compactProfile = FindProfile(requestedProfile);
        session.Busy = true;
        Emit("session.updated", SessionJson(session));
        try
        {
            return await CompactSessionCoreAsync(session, compactProfile, false, CancellationToken.None);
        }
        finally
        {
            session.Busy = false;
            Emit("session.updated", SessionJson(session));
        }
    }

    private JsonObject StartChat(JsonObject args)
    {
        var session = GetSession(args);
        if (session.Busy) throw new InvalidOperationException("会话正在生成中");
        string text = StringArg(args, "text", "").Trim();
        var imageDataUrls = StringArrayArg(args, "imageDataUrls");
        if (string.IsNullOrWhiteSpace(text) && imageDataUrls.Count == 0)
            throw new InvalidOperationException("消息和图片不能同时为空");
        if (string.IsNullOrWhiteSpace(session.Workspace))
            throw new InvalidOperationException("请先为当前会话选择工作区");
        if (imageDataUrls.Count > 8) throw new InvalidOperationException("一次最多发送 8 张图片");
        var profile = FindProfile(session.ProfileName);
        if (imageDataUrls.Count > 0 && !profile.SupportsImages)
        {
            // Handled in RunChatAsync (async vision routing)
        }
        var selectedSkills = ResolveSkills(session.Workspace, StringArrayArg(args, "skillIds"));
        var selectedExperts = ResolveSkills(session.Workspace, StringArrayArg(args, "expertIds"));
        session.Busy = true;
        session.Cancellation = new CancellationTokenSource();
        _ = RunChatAsync(session, text, imageDataUrls, selectedSkills, selectedExperts, session.Cancellation.Token);
        Emit("session.updated", SessionJson(session));
        return new JsonObject { ["accepted"] = true, ["sessionId"] = session.Id };
    }

    private JsonObject CancelChat(JsonObject args)
    {
        var session = GetSession(args);
        session.Cancellation?.Cancel();
        return new JsonObject { ["cancelled"] = true };
    }

    private async Task RunChatAsync(BackendSession session, string text, IReadOnlyList<string> imageDataUrls, IReadOnlyList<SkillInfo> skills, IReadOnlyList<SkillInfo> experts, CancellationToken ct)
    {
        bool completed = false;
        try
        {
            // Hermes-style auto vision routing: describe images for non-vision models
            var profile = FindProfile(session.ProfileName);
            if (imageDataUrls.Count > 0 && !profile.SupportsImages)
            {
                // Always save images to CatTemp first so they're accessible to sub-agents
                Directory.CreateDirectory("CatTemp");
                var savedPaths = new List<string>();
                for (int i = 0; i < imageDataUrls.Count; i++)
                {
                    try
                    {
                        string ext = imageDataUrls[i].Contains("image/png") ? "png" : imageDataUrls[i].Contains("image/gif") ? "gif" : "jpg";
                        string p = $"CatTemp/image_{DateTime.Now:HHmmssfff}_{i}.{ext}";
                        int comma = imageDataUrls[i].IndexOf(',');
                        if (comma > 0) File.WriteAllBytes(Path.GetFullPath(p), Convert.FromBase64String(imageDataUrls[i][(comma + 1)..]));
                        savedPaths.Add(p);
                    }
                    catch { }
                }
                var visionProfile = _config.Profiles.FirstOrDefault(p => p.SupportsImages && p.Name != profile.Name);
                _log.Log($"Vision routing: main={profile.Name}, images={imageDataUrls.Count}, saved={savedPaths.Count}, vision={(visionProfile?.Name ?? "NONE")}");
                if (visionProfile != null)
                {
                    Emit("agent.started", new JsonObject
                    {
                        ["sessionId"] = session.Id, ["agentName"] = visionProfile.Name,
                        ["model"] = visionProfile.Model, ["task"] = "识别图片内容"
                    });
                    var visionResultText = "";
                    try
                    {
                        var visionMessages = new List<JsonNode>
                        {
                            new JsonObject { ["role"] = "user", ["content"] = new JsonArray {
                                new JsonObject { ["type"] = "text", ["text"] = "Describe this image in detail. What do you see? Reply in the same language as any visible text, otherwise use Chinese." },
                                new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = imageDataUrls[0] } }
                            }}
                        };
                        var visionResult = await new ApiClient(visionProfile).Chat(visionProfile.Model, visionMessages, "", _log, null, null, ct);
                        visionResultText = visionResult.Content?.Trim() ?? "";
                    }
                    catch (Exception ex) { _log.Err($"Vision routing failed: {ex.Message}"); }
                    Emit("agent.completed", new JsonObject
                    {
                        ["sessionId"] = session.Id, ["agentName"] = visionProfile.Name,
                        ["model"] = visionProfile.Model, ["task"] = "识别图片内容",
                        ["content"] = visionResultText, ["usageIn"] = 0, ["usageOut"] = 0
                    });
                    // Inject description directly into text so main model sees it without delegation
                    if (!string.IsNullOrWhiteSpace(visionResultText))
                        text = text + "\n\n[视觉识别结果 via " + visionProfile.Name + "]\n" + visionResultText + "\n[/视觉识别结果]";
                    else if (savedPaths.Count > 0)
                        text = text + "\n\n[图片已保存: " + string.Join(", ", savedPaths) + "]\n视觉识别失败。如需识别图片内容，请使用 file_read 读取上述文件路径，或委派给支持识图的子Agent。";
                }
                else
                {
                    // No vision-capable profile — note that images were saved via outer block
                    if (savedPaths.Count > 0)
                    {
                        session.Messages.Add(new JsonObject
                        {
                            ["role"] = "tool", ["name"] = "system",
                            ["tool_call_id"] = "vision_none",
                            ["content"] = $"未配置识图模型。图片已保存到: {string.Join(", ", savedPaths)}\n可手动委派支持识图的子 Agent 读取这些文件。"
                        });
                        Emit("message.added", new JsonObject { ["sessionId"] = session.Id, ["message"] = session.Messages.Last().DeepClone() });
                    }
                }
                // DO NOT clear imageDataUrls — user message still needs images for display
            }

            WebCat.ResetSearchCounter(); // 每轮对话重置搜索计数
            EnsureL0(session);
            await AutoCompactIfNeededAsync(session, ct);
            if (skills.Count > 0 || experts.Count > 0)
            {
                string expertPrompt = experts.Count > 0
                    ? "本轮显式选择了专家套件。请把下面专家上下文作为本次回复的角色/方法参考；它只对本次发送生效。\n\n" + BuildSkillPrompt(experts)
                    : "";
                string skillPrompt = skills.Count > 0 ? BuildSkillPrompt(skills) : "";
                session.TransientSkillMessage = new JsonObject { ["role"] = "system", ["content"] = string.Join("\n\n", new[] { expertPrompt, skillPrompt }.Where(part => !string.IsNullOrWhiteSpace(part))) };
                session.Messages.Insert(Math.Min(1, session.Messages.Count), session.TransientSkillMessage);
            }
            JsonNode content;
            // Always include images in user message for display in transcript
            if (imageDataUrls.Count > 0)
            {
                var parts = new JsonArray();
                if (!string.IsNullOrWhiteSpace(text))
                    parts.Add(new JsonObject { ["type"] = "text", ["text"] = text + UserSuffix() });
                foreach (var imageDataUrl in imageDataUrls)
                    parts.Add(new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = imageDataUrl } });
                content = parts;
            }
            else
            {
                content = JsonValue.Create(text + UserSuffix())!;
            }
            session.Messages.Add(new JsonObject { ["role"] = "user", ["content"] = content });
            if (session.Title == "新会话") session.Title = FallbackTitle(string.IsNullOrWhiteSpace(text) ? "图片对话" : text);
            session.LastActive = DateTime.Now;
            Save(session);
            Emit("message.added", new JsonObject
            {
                ["sessionId"] = session.Id,
                ["message"] = new JsonObject { ["role"] = "user", ["content"] = content.DeepClone() }
            });
            await RoundTripAsync(session, ct, 0, new ToolLoopState());
            session.LastActive = DateTime.Now;
            Save(session);
            completed = true;
        }
        catch (OperationCanceledException)
        {
            Emit("chat.cancelled", new JsonObject { ["sessionId"] = session.Id });
        }
        catch (Exception ex)
        {
            _log.Err($"会话 {session.Id}: {ex}");
            string message = FriendlyChatError(ex);
            session.Messages.Add(new JsonObject { ["role"] = "assistant", ["content"] = message, ["is_error"] = true });
            Save(session);
            Emit("chat.error", new JsonObject { ["sessionId"] = session.Id, ["message"] = message });
        }
        finally
        {
            if (session.TransientSkillMessage is not null)
            {
                session.Messages.Remove(session.TransientSkillMessage);
                session.TransientSkillMessage = null;
                Save(session);
            }
            session.Busy = false;
            session.Cancellation?.Dispose();
            session.Cancellation = null;
            Emit("session.updated", SessionJson(session));
            if (completed) Emit("chat.completed", new JsonObject { ["sessionId"] = session.Id });
        }
    }

    private async Task<bool> AutoCompactIfNeededAsync(BackendSession session, CancellationToken ct)
    {
        int window = EffectiveContextWindow(session);
        int threshold = session.ContextThreshold is > 0 and <= 100 ? session.ContextThreshold : _config.CompactThreshold;
        int used = Math.Max(session.ContextTokens, EstimateContextTokens(ContextMessages(session)));
        if (window <= 1000 || used * 100L < window * (long)threshold) return false;
        var source = ContextMessages(session).Where(message => message?["role"]?.GetValue<string>() != "system").ToList();
        if (source.Count < 2) return false;
        await CompactSessionCoreAsync(session, FindProfile(session.ProfileName), true, ct);
        return true;
    }

    private async Task<JsonObject> CompactSessionCoreAsync(BackendSession session, ModelProfile compactProfile, bool automatic, CancellationToken ct)
    {
        var source = ContextMessages(session).Where(message => message?["role"]?.GetValue<string>() != "system").ToList();
        if (source.Count < 2) throw new InvalidOperationException("当前会话内容太少，暂时不需要总结");
        int before = Math.Max(session.ContextTokens, EstimateContextTokens(ContextMessages(session)));
        var prompt = new List<JsonNode>
        {
            new JsonObject { ["role"] = "system", ["content"] = CompactionPrompt },
            new JsonObject { ["role"] = "user", ["content"] = BuildCompactionTranscript(source) }
        };
        var result = await new ApiClient(compactProfile).Chat(compactProfile.Model, prompt, "", _log, null, null, ct);
        string summary = result.Content?.Trim() ?? "";
        if (string.IsNullOrWhiteSpace(summary)) throw new InvalidOperationException("总结模型没有返回可用内容");

        foreach (var message in session.Messages)
        {
            string role = message?["role"]?.GetValue<string>() ?? "";
            if (role != "system" || message?["context_summary"]?.GetValue<bool>() == true)
                if (message is JsonObject item) item["context_excluded"] = true;
        }
        session.Messages.Insert(Math.Min(1, session.Messages.Count), new JsonObject
        {
            ["role"] = "system",
            ["content"] = "[会话上下文摘要]\n" + summary,
            ["context_summary"] = true,
            ["compacted_at"] = DateTime.Now.ToString("O"),
            ["compacted_by"] = compactProfile.Name
        });
        session.TokensIn += result.UsageIn;
        session.TokensOut += result.UsageOut;
        session.ContextTokens = EstimateContextTokens(ContextMessages(session));
        session.LastInputTokens = session.ContextTokens;
        var notice = new JsonObject
        {
            ["role"] = "event",
            ["event"] = "context_compacted",
            ["content"] = automatic
                ? $"上下文达到 {EffectiveCompactThreshold(session)}% 阈值，已自动总结（{FormatTokenCount(before)} → {FormatTokenCount(session.ContextTokens)} Token）"
                : $"上下文已手动总结（{FormatTokenCount(before)} → {FormatTokenCount(session.ContextTokens)} Token）",
            ["profileName"] = compactProfile.Name,
            ["model"] = compactProfile.Model,
            ["createdAt"] = DateTime.Now.ToString("O"),
            ["context_excluded"] = true
        };
        session.Messages.Add(notice);
        Save(session);
        var json = SessionJson(session);
        Emit("session.updated", json.DeepClone());
        Emit("message.added", new JsonObject { ["sessionId"] = session.Id, ["message"] = notice.DeepClone() });
        Emit("context.compacted", new JsonObject
        {
            ["sessionId"] = session.Id,
            ["automatic"] = automatic,
            ["profileName"] = compactProfile.Name,
            ["model"] = compactProfile.Model,
            ["beforeTokens"] = before,
            ["contextTokens"] = session.ContextTokens
        });
        return json;
    }

    private async Task RoundTripAsync(BackendSession session, CancellationToken ct, int depth, ToolLoopState loop)
    {
        var profile = FindProfile(session.ProfileName);
        var api = new ApiClient(profile);
        await AutoCompactIfNeededAsync(session, ct);
        bool modeDisablesTools = session.Mode is "plan" or "ask";
        bool toolsAllowed = profile.SupportsTools && !modeDisablesTools && !loop.ForceFinal && depth < 200 && loop.TotalCalls < 400;
        var context = ContextMessages(session);
        ApplyModePrompt(session, context);
        // Strip image_url blocks for non-vision models (user still sees images in bubble)
        if (!profile.SupportsImages) StripImagesFromContext(context);
        if (!toolsAllowed && profile.SupportsTools)
            context.Add(new JsonObject { ["role"] = "system", ["content"] = "已达到本轮工具调用安全上限。请停止调用工具，基于已有进展给出阶段性答复：列出已完成事项、文件改动、未完成项与下一步恢复建议，方便用户接着推进。" });
        string messageId = Guid.NewGuid().ToString("N");
        Emit("assistant.started", new JsonObject { ["sessionId"] = session.Id, ["messageId"] = messageId });
        ChatResult result;
        int maxRetries = 3;
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                result = await api.Chat(session.Model, context, toolsAllowed ? BuildToolsSchema() : "", _log,
                    delta => Emit("assistant.delta", new JsonObject { ["sessionId"] = session.Id, ["messageId"] = messageId, ["delta"] = delta }),
                    delta => Emit("assistant.reasoning", new JsonObject { ["sessionId"] = session.Id, ["messageId"] = messageId, ["delta"] = delta }),
                    ct);
                break;
            }
            catch (OperationCanceledException) { throw; }
            catch (Exception ex) when (attempt < maxRetries && IsRetryableApiError(ex))
            {
                int delayMs = Math.Min(1000 * (int)Math.Pow(2, attempt), 10000);
                _log.Log($"API 调用失败 (尝试 {attempt}/{maxRetries})，{delayMs}ms 后重试: {ex.Message.Substring(0, Math.Min(ex.Message.Length, 120))}");
                await Task.Delay(delayMs, ct);
            }
        }

        if (string.IsNullOrWhiteSpace(result.Content) && (result.ToolCalls is null || result.ToolCalls.Count == 0))
            throw new InvalidOperationException("模型请求成功，但没有返回正文或工具调用。请检查模型名称、请求协议与服务商兼容性后重试。");

        var assistant = new JsonObject { ["role"] = "assistant", ["content"] = result.Content ?? "" };
        if (result.ToolCalls is not null) assistant["tool_calls"] = result.ToolCalls.DeepClone();
        session.Messages.Add(assistant);
        session.TokensIn += result.UsageIn;
        session.TokensOut += result.UsageOut;
        session.LastInputTokens = result.UsageIn;
        int providerUsage = result.UsageIn + result.UsageOut;
        int localEstimate = EstimateContextTokens(ContextMessages(session));
        session.ContextTokens = providerUsage > 100 ? Math.Max(providerUsage, localEstimate) : localEstimate;
        Emit("assistant.completed", new JsonObject
        {
            ["sessionId"] = session.Id,
            ["messageId"] = messageId,
            ["content"] = result.Content ?? "",
            ["usageIn"] = result.UsageIn,
            ["usageOut"] = result.UsageOut,
            ["model"] = session.Model
        });

        if (result.ToolCalls is null || result.ToolCalls.Count == 0) return;
        if (!toolsAllowed) return;

        // Phase 1: validate all calls, build execution plan
        var plan = new List<ToolPlanItem>();
        foreach (var call in result.ToolCalls)
        {
            string name = call?["function"]?["name"]?.GetValue<string>() ?? "";
            string argsText = call?["function"]?["arguments"]?.GetValue<string>() ?? "{}";
            JsonNode toolArgs;
            bool parseError = false;
            try { toolArgs = JsonNode.Parse(argsText) ?? new JsonObject(); }
            catch { toolArgs = new JsonObject(); parseError = true; }
            loop.TotalCalls++;
            string signature = name + "\n" + NormalizeJson(toolArgs);

            // 同类工具预算：防止交替调用绕过重复检测
            string category = ToolCategory(name);
            int catCount = loop.CategoryCalls.TryGetValue(category, out var c) ? c + 1 : 1;
            loop.CategoryCalls[category] = catCount;
            int catLimit = category == "search" ? 10 : category == "shell" ? 10 : category == "file_write" ? 20 : int.MaxValue;

            int repeated = loop.Signatures.TryGetValue(signature, out var previous) ? previous + 1 : 1;
            loop.Signatures[signature] = repeated;
            bool parallelSafe = _registry.IsParallelSafe(name) || name == "tool_output_lookup";
            if (parallelSafe && name is "shell_run" or "ps_run") parallelSafe = session.ApprovalMode == "auto";
            string agentName = name == "delegate_agent" ? toolArgs?["profileName"]?.GetValue<string>() ?? "" : "";
            Emit("tool.started", new JsonObject { ["sessionId"] = session.Id, ["name"] = name, ["arguments"] = argsText, ["agentName"] = agentName });
            plan.Add(new ToolPlanItem(call, name, argsText, toolArgs, signature, repeated, parallelSafe, agentName, catCount > catLimit, parseError));
        }

        // Phase 2: execute — parallel-safe first, then serial
        var toolResults = new ToolPlanResult[plan.Count];
        // 并行批次（排除已超限的调用）
        var parallelBatch = plan.Select((item, idx) => (item, idx)).Where(p => p.item.ParallelSafe && !p.item.CategoryExceeded && p.item.Repeated <= 2 && loop.TotalCalls <= 400).ToArray();
        if (parallelBatch.Length > 0)
        {
            await Task.WhenAll(parallelBatch.Select(async pair =>
            {
                var (item, idx) = pair;
                toolResults[idx] = await ExecuteSingleToolAsync(session, item, loop, ct);
            }));
        }
        // 串行批次（含被限制/超限的调用）
        foreach (var pair in plan.Select((item, idx) => (item, idx)).Where(p => !p.item.ParallelSafe || p.item.CategoryExceeded || p.item.Repeated > 2 || loop.TotalCalls > 400))
        {
            var (item, idx) = pair;
            toolResults[idx] = await ExecuteSingleToolAsync(session, item, loop, ct);
        }

        // Phase 3: record results in order and save
        for (int i = 0; i < toolResults.Length; i++)
        {
            var item = plan[i];
            var tr = toolResults[i];
            string cacheId = $"{session.Id}_{item.ToolName}_{Guid.NewGuid():N}";
            _toolOutputs[cacheId] = tr.Result.Content ?? "";
            var queue = _toolOutputQueues.GetOrAdd(session.Id, _ => new Queue<string>());
            lock (queue) { queue.Enqueue(cacheId); while (queue.Count > 50) { _toolOutputs.TryRemove(queue.Dequeue(), out _); } }
            string summary = (tr.Result.Content ?? "").Length > 200 ? (tr.Result.Content ?? "")[..200] + "..." : (tr.Result.Content ?? "");
            string truncatedContent = TruncateToolResult(tr.Result.Content ?? "", cacheId);
            var toolMessage = new JsonObject
            {
                ["role"] = "tool",
                ["name"] = item.ToolName,
                ["arguments"] = item.ArgsText,
                ["tool_call_id"] = item.Call?["id"]?.GetValue<string>() ?? "",
                ["content"] = truncatedContent,
                ["path"] = IsWriteTool(item.ToolName) ? ExtractPath(item.ToolName, item.ToolArgs) : "",
                ["is_error"] = tr.Result.IsError,
                ["cache_id"] = cacheId,
                ["summary"] = summary
            };
            if (item.ToolName == "update_plan")
            {
                if (item.ToolArgs["plan"] is JsonNode planNode) toolMessage["plan"] = planNode.DeepClone();
                if (item.ToolArgs["explanation"] is JsonNode expNode) toolMessage["plan_explanation"] = expNode.DeepClone();
            }
            session.Messages.Add(toolMessage);
            Emit("tool.completed", new JsonObject
            {
                ["sessionId"] = session.Id,
                ["name"] = item.ToolName,
                ["arguments"] = item.ArgsText,
                ["content"] = truncatedContent,
                ["isError"] = tr.Result.IsError,
                ["path"] = IsWriteTool(item.ToolName) ? ExtractPath(item.ToolName, item.ToolArgs) : "",
                ["agentName"] = item.AgentName
            });
            Save(session);
        }
        if (depth + 1 >= 200) loop.ForceFinal = true;
        // 每 10 轮注入反思 prompt
        if (depth == 0)
        {
            session._turnCount = (session._turnCount ?? 0) + 1;
            if (session._turnCount % 10 == 0)
            {
                session.Messages.Add(new JsonObject
                {
                    ["role"] = "system",
                    ["content"] = $"[系统] 本会话第 {session._turnCount} 轮。回顾最近的对话：如果用户透露了新的偏好、习惯或背景，调用 memory_add。如果遇到了值得复用的技术经验，调用 lesson_capture。如果旧的记忆不再准确，调用 memory_remove。没有值得记录的就不用操作。"
                });
            }
            // Curator 触发提示
            int coldCount = CountColdEntries();
            if (coldCount > 200 || DaysSinceCuratorLastRun() > 14)
            {
                session.Messages.Add(new JsonObject
                {
                    ["role"] = "system",
                    ["content"] = $"[系统] 冷知识库已积累 {coldCount} 条 / 上次整理距今 {DaysSinceCuratorLastRun()} 天。建议说「整理冷知识」触发 curator_review。"
                });
            }
        }
        await RoundTripAsync(session, ct, depth + 1, loop);
    }

    private static string FriendlyChatError(Exception ex)
    {
        if (ex is FileNotFoundException missing && !string.IsNullOrWhiteSpace(missing.FileName))
            return $"客户端运行组件缺失：{missing.FileName.Split(',')[0]}。请安装或重新解压最新版 RanParty 后重试。";
        if (ex is HttpRequestException) return $"模型网络请求失败：{ex.Message}";
        if (ex is TaskCanceledException) return "模型请求超时，请检查网络、API 地址或服务商状态后重试。";
        return string.IsNullOrWhiteSpace(ex.Message) ? "模型调用失败，后端未返回具体原因。" : ex.Message;
    }

    /// <summary>执行单个工具调用，含重复检测和上限检查</summary>
    private async Task<ToolPlanResult> ExecuteSingleToolAsync(BackendSession session, ToolPlanItem item, ToolLoopState loop, CancellationToken ct)
    {
        ToolResult toolResult;
        if (item.ParseError)
        {
            toolResult = new ToolResult { Content = "工具参数 JSON 解析失败。请检查 arguments 格式是否为合法 JSON。", Error = ErrorKind.InvalidArgument };
        }
        else if (item.CategoryExceeded)
        {
            toolResult = new ToolResult { Content = $"同类工具调用次数已达上限（{ToolCategory(item.ToolName)}）。请基于已有结果继续完成任务。", Error = ErrorKind.Unknown };
        }
        else if (item.Repeated > 2)
        {
            loop.DuplicateBlocks++;
            loop.ForceFinal = loop.DuplicateBlocks >= 2;
            toolResult = new ToolResult { Content = "重复工具调用已被拦截。请使用前两次调用的结果继续完成任务，不要再次提交相同参数。", Error = ErrorKind.Unknown };
        }
        else if (loop.TotalCalls > 400)
        {
            loop.ForceFinal = true;
            toolResult = new ToolResult { Content = "已达到本轮工具调用安全上限。请基于已有进展生成阶段性答复：已完成事项、未完成项与下一步建议。", Error = ErrorKind.Unknown };
        }
        else
        {
            toolResult = await DispatchWithApprovalAsync(session, item.ToolName, item.ToolArgs, "", ct);
        }
        return new ToolPlanResult(toolResult);
    }

    private static string TruncateToolResult(string content, string cacheId = null, int maxChars = 16000)
    {
        if (string.IsNullOrEmpty(content) || content.Length <= maxChars) return content ?? "";
        int head = maxChars * 2 / 3;
        int tail = maxChars - head;
        string hint = cacheId is not null
            ? $"\n\n[已截断：原始 {content.Length} 字符。使用 tool_output_lookup(\"{cacheId}\", offset) 分段读取]\n\n"
            : $"\n\n…[已截断：原始 {content.Length} 字符，保留前 {head} + 后 {tail}。如需更多请用 file_read_between 分段读取]…\n\n";
        return content.Substring(0, head)
            + hint
            + content.Substring(content.Length - tail);
    }

    private async Task<ToolResult> DispatchWithApprovalAsync(BackendSession session, string name, JsonNode args, string reason, CancellationToken ct)
    {
        if (name == "tool_output_lookup")
        {
            string cid = ((args as JsonObject) ?? new JsonObject())["cache_id"]?.GetValue<string>() ?? "";
            if (!_toolOutputs.TryGetValue(cid, out var full)) return new ToolResult { Content = "缓存未找到或已过期", Error = ErrorKind.NotFound };
            var obj = args as JsonObject ?? new JsonObject();
            int offset = Math.Max(0, obj["offset"]?.GetValue<int>() ?? 0);
            int limit = Math.Clamp(obj["limit"]?.GetValue<int>() ?? 8000, 1, 16000);
            string segment = full.Length <= offset ? "" : full.Substring(offset, Math.Min(limit, full.Length - offset));
            return new ToolResult { Content = segment };
        }
        if (name == "ask_user") return await RequestClarificationAsync(session, args, ct);
        if (name == "update_plan") return await UpdatePlanAsync(session, args, ct);
        if (name == "delegate_agent") return await DelegateAgentAsync(session, args, ct);
        if (name == "growth_record") return GrowthRecord(session, args);
        if (name == "curator_review") return await CuratorReview(session, args, ct);
        if (name is "web_search" or "web_search_cached" or "web_fetch" or "web_fetch_cached")
            return await Task.Run(() => _webcat.Execute(name, args), ct);
        if (!IsShellTool(name) || name is "open_url" or "open_path")
            return await Task.Run(() => _registry.Dispatch(name, args), ct);
        if (!string.IsNullOrWhiteSpace(session.Workspace) && string.IsNullOrWhiteSpace(args?["workdir"]?.GetValue<string>()))
            args!["workdir"] = session.Workspace;
        string command = args?["command"]?.GetValue<string>() ?? "";
        if (session.ApprovalMode == "auto" || IsSessionAllowed(session.Id, command))
            return await Task.Run(() => _registry.Dispatch(name, args), ct);

        string approvalId = Guid.NewGuid().ToString("N");
        var pending = new PendingApproval();
        _approvals[approvalId] = pending;
        Emit("approval.requested", new JsonObject
        {
            ["approvalId"] = approvalId,
            ["sessionId"] = session.Id,
            ["tool"] = name,
            ["command"] = command,
            ["workdir"] = args?["workdir"]?.GetValue<string>() ?? session.Workspace,
            ["reason"] = reason
        });
        using var registration = ct.Register(() => pending.Source.TrySetCanceled(ct));
        ApprovalDecision decision;
        try { decision = await pending.Source.Task; }
        finally { _approvals.TryRemove(approvalId, out _); }
        if (decision.Action == "allow_session")
        {
            var allowed = _sessionAllows.GetOrAdd(session.Id, _ => new HashSet<string>(StringComparer.Ordinal));
            lock (allowed) allowed.Add(command.Trim());
        }
        if (decision.Action is "allow_once" or "allow_session")
            return await Task.Run(() => _registry.Dispatch(name, args), ct);
        return new ToolResult
        {
            Content = string.IsNullOrWhiteSpace(decision.Feedback)
                ? "[用户拒绝执行该命令]"
                : $"[用户拒绝执行，反馈: {decision.Feedback}]"
        };
    }

    private string BuildToolsSchema()
    {
        var schemas = JsonNode.Parse(_registry.SchemasJson(ToolExposure.Direct))?.AsArray() ?? new JsonArray();
        var profileNames = new JsonArray(_config.Profiles.Select(profile => (JsonNode?)JsonValue.Create(profile.Name)).ToArray());
        schemas.Add(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = "delegate_agent",
                ["description"] = "将一个独立子任务委派给另一个模型配置。主 Agent 保持会话控制权，并在收到专家结果后继续整合回答。",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["profileName"] = new JsonObject { ["type"] = "string", ["enum"] = profileNames, ["description"] = "要调用的模型配置/Agent" },
                        ["task"] = new JsonObject { ["type"] = "string", ["description"] = "边界清晰、可独立完成的子任务" },
                        ["context"] = new JsonObject { ["type"] = "string", ["description"] = "完成子任务所需的最少背景，可省略" }, ["forkMode"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("fresh", "summary", "full"), ["description"] = "上下文: fresh=空白, summary=压缩, full=完整" },
                        ["toolsMode"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("auto", "full", "none"), ["description"] = "工具权限: auto=fresh无工具/summary+full给工具, full=始终给, none=零工具(纯顾问)" }
                    },
                    ["required"] = new JsonArray("profileName", "task"),
                    ["additionalProperties"] = false
                }
            }
        });
        schemas.Add(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = "ask_user",
                ["description"] = "强制反问工具：当缺少关键信息、用户意图有歧义、面临需要用户拍板的多种方案、或即将执行有副作用且影响不明的操作时，必须先调用本工具暂停并询问用户，拿到回复后再继续，禁止猜测。question 一次只问一个核心问题；凡是能给出候选答案的，务必提供 1-3 个 options 让用户一键确认（需要并列选择时设 multiSelect=true）。低风险、可逆、显而易见的操作不要调用本工具。调用后 Agent 会暂停，用户回复内容作为本工具结果返回。",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["question"] = new JsonObject { ["type"] = "string", ["description"] = "要问用户的问题，简洁明确，一次只问一个核心问题" },
                        ["context"] = new JsonObject { ["type"] = "string", ["description"] = "为什么会问、当前进展，可省略" },
                        ["options"] = new JsonObject { ["type"] = "array", ["items"] = new JsonObject { ["type"] = "string" }, ["description"] = "候选选项列表；若问题是选择题则提供，否则可省略让用户自由作答" },
                        ["multiSelect"] = new JsonObject { ["type"] = "boolean", ["description"] = "options 是否允许多选，默认 false" }
                    },
                    ["required"] = new JsonArray("question"),
                    ["additionalProperties"] = false
                }
            }
        });
        schemas.Add(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = "update_plan",
                ["description"] = "维护任务计划/TODO 清单，向用户展示进度。多步任务开始时调用一次建立计划，步骤推进时更新状态：同时只允许一个 in_progress，完成前先标 in_progress 再标 completed，全部完成时标全 completed。范围变化时带 explanation 更新。不要在消息里重复计划内容（界面已展示）。单步琐碎任务不要用。",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["explanation"] = new JsonObject { ["type"] = "string", ["description"] = "本次更新的理由，可省略" },
                        ["plan"] = new JsonObject
                        {
                            ["type"] = "array",
                            ["description"] = "步骤列表",
                            ["items"] = new JsonObject
                            {
                                ["type"] = "object",
                                ["properties"] = new JsonObject
                                {
                                    ["step"] = new JsonObject { ["type"] = "string", ["description"] = "步骤描述，5-7 字以内" },
                                    ["status"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("pending", "in_progress", "completed"), ["description"] = "步骤状态" }
                                },
                                ["required"] = new JsonArray("step", "status"),
                                ["additionalProperties"] = false
                            }
                        }
                    },
                    ["required"] = new JsonArray("plan"),
                    ["additionalProperties"] = false
                }
            }
        });
        schemas.Add(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = "tool_output_lookup",
                ["description"] = "Re-read a segment of a cached tool result by its cache_id. Use when a result was truncated in the transcript and you need more detail.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["cache_id"] = new JsonObject { ["type"] = "string", ["description"] = "cache_id from a previous tool result" },
                        ["offset"] = new JsonObject { ["type"] = "integer", ["minimum"] = 0, ["description"] = "character offset to start reading from, default 0" },
                        ["limit"] = new JsonObject { ["type"] = "integer", ["minimum"] = 1, ["maximum"] = 16000, ["description"] = "max characters to return, default 8000" }
                    },
                    ["required"] = new JsonArray("cache_id"),
                    ["additionalProperties"] = false
                }
            }
        });
        schemas.Add(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = "growth_record",
                ["description"] = "Record a character growth event (milestone, user preference, or tone shift). The character card grows with the user over time.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["action"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("milestone", "preference", "tone"), ["description"] = "Type of growth: milestone (relationship event), preference (user habit), tone (personality shift)" },
                        ["content"] = new JsonObject { ["type"] = "string", ["description"] = "The growth event description, 1-2 sentences" }
                    },
                    ["required"] = new JsonArray("action", "content"),
                    ["additionalProperties"] = false
                }
            }
        });
        schemas.Add(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = "curator_review",
                ["description"] = "Clean and consolidate cold knowledge archives: merge duplicates, mark obsolete, upgrade frequent lessons to LESSONS.md, split old entries by year.",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["scope"] = new JsonObject { ["type"] = "string", ["enum"] = new JsonArray("all", "lessons", "memories"), ["description"] = "Which archives to review, default 'all'" }
                    },
                    ["additionalProperties"] = false
                }
            }
        });
        // 兜底去重：防止不同来源注册了同名工具
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deduped = new JsonArray();
        foreach (var schema in schemas)
        {
            string name = schema?["function"]?["name"]?.GetValue<string>() ?? "";
            if (string.IsNullOrEmpty(name) || !seen.Add(name)) continue;
            deduped.Add(schema.DeepClone());
        }
        return deduped.ToJsonString();
    }

    private async Task<ToolResult> DelegateAgentAsync(BackendSession session, JsonNode args, CancellationToken ct)
    {
        string profileName = args?["profileName"]?.GetValue<string>()?.Trim() ?? "";
        string task = args?["task"]?.GetValue<string>()?.Trim() ?? "";
        string context = args?["context"]?.GetValue<string>()?.Trim() ?? "";
        string forkMode = args?["forkMode"]?.GetValue<string>()?.Trim() ?? "fresh";
        string toolsMode = args?["toolsMode"]?.GetValue<string>()?.Trim() ?? "auto";
        var profile = _config.Profiles.FirstOrDefault(candidate => string.Equals(candidate.Name, profileName, StringComparison.Ordinal));
        if (profile is null) return new ToolResult { Content = $"子 Agent 配置未找到: {profileName}", Error = ErrorKind.NotFound };
        if (string.IsNullOrWhiteSpace(task)) return new ToolResult { Content = "子 Agent 任务不能为空", Error = ErrorKind.InvalidArgument };

        // toolsMode: "auto" = full工具仅当forkMode!=fresh, "full" = 始终给工具, "none" = 零工具(纯顾问)
        bool giveTools = toolsMode switch { "none" => false, "full" => true, _ => forkMode != "fresh" };
        // Depth guard: prevent runaway nested delegation (max 3 levels)
        int depth = (session._turnDepth ?? 0) + 1;
        if (depth > 3) giveTools = false;

        Emit("agent.started", new JsonObject
        {
            ["sessionId"] = session.Id, ["agentName"] = profile.Name, ["model"] = profile.Model,
            ["task"] = task, ["forkMode"] = forkMode, ["toolsMode"] = toolsMode, ["depth"] = depth, ["giveTools"] = giveTools
        });
        try
        {
            var messages = new List<JsonNode>
            {
                new JsonObject
                {
                    ["role"] = "system",
                    ["content"] = giveTools
                        ? "你是被主 Agent 调用的子 Agent。你可以使用工具完成分配的独立任务。完成后给出简洁结论。如果遇到需要用户拍板的问题，返回你的建议让主 Agent 去确认，不要自己调用 ask_user。不要委派子子 Agent（delegate_agent）。"
                        : "你是被主 Agent 调用的专业子 Agent。只完成分配的独立任务；给出可核验的发现、风险和建议。不要假装执行未提供给你的工具，也不要与用户直接寒暄。"
                }
            };
            // Fork modes
            if (forkMode == "summary" || forkMode == "full")
            {
                var parentCtx = ContextMessages(session).Where(m => m?["role"]?.GetValue<string>() != "system").ToList();
                if (forkMode == "summary" && parentCtx.Count > 1)
                {
                    var compactPrompt = new List<JsonNode> { new JsonObject { ["role"] = "system", ["content"] = CompactionPrompt }, new JsonObject { ["role"] = "user", ["content"] = BuildCompactionTranscript(parentCtx) } };
                    var summaryResult = await new ApiClient(profile).Chat(profile.Model, compactPrompt, "", _log, null, null, ct);
                    messages.Add(new JsonObject { ["role"] = "user", ["content"] = $"[父会话摘要]\n{summaryResult.Content}\n\n任务：{task}" });
                }
                else if (forkMode == "full")
                {
                    messages.AddRange(parentCtx.Select(m => m.DeepClone()));
                    messages.Add(new JsonObject { ["role"] = "user", ["content"] = $"任务：{task}" });
                }
            }
            else
            {
                messages.Add(new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = $"任务：{task}\n\n必要背景：{(string.IsNullOrWhiteSpace(context) ? "无" : context)}\n\n工作区：{(string.IsNullOrWhiteSpace(session.Workspace) ? "未选择" : session.Workspace)}"
                });
            }

            var subAgentClient = new ApiClient(profile);
            if (profile.MaxOutputTokens <= 0) subAgentClient.SetMaxTokens(4096);
            string toolSchema = giveTools ? BuildToolsSchema() : "";
            var result = await subAgentClient.Chat(profile.Model, messages, toolSchema, _log, null, null, ct);

            // If sub-agent has tools, let it run a mini tool loop
            if (giveTools && result.ToolCalls is not null && result.ToolCalls.Count > 0)
            {
                session._turnDepth = depth;
                // Run up to 10 tool iterations for sub-agent (bounded)
                var subLoopState = new ToolLoopState();
                for (int iter = 0; iter < 10 && result.ToolCalls is not null && result.ToolCalls.Count > 0 && !subLoopState.ForceFinal; iter++)
                {
                    var assistantMsg = new JsonObject { ["role"] = "assistant", ["content"] = result.Content ?? "" };
                    assistantMsg["tool_calls"] = result.ToolCalls.DeepClone();
                    messages.Add(assistantMsg);
                    foreach (var call in result.ToolCalls)
                    {
                        string toolName = call?["function"]?["name"]?.GetValue<string>() ?? "";
                        // Block delegate_agent in sub-agents
                        if (toolName == "delegate_agent")
                        {
                            messages.Add(new JsonObject { ["role"] = "tool", ["tool_call_id"] = call?["id"]?.GetValue<string>() ?? "", ["name"] = toolName, ["content"] = "子 Agent 不允许递归委派", ["is_error"] = true });
                            continue;
                        }
                        string argsText = call?["function"]?["arguments"]?.GetValue<string>() ?? "{}";
                        JsonNode toolArgs;
                        try { toolArgs = JsonNode.Parse(argsText) ?? new JsonObject(); }
                        catch { toolArgs = new JsonObject(); }
                        // Route through both CatRegistry AND meta-tools
                        ToolResult toolResult = DispatchSubAgentTool(toolName, toolArgs, session, ct);
                        messages.Add(new JsonObject
                        {
                            ["role"] = "tool", ["tool_call_id"] = call?["id"]?.GetValue<string>() ?? "",
                            ["name"] = toolName, ["content"] = toolResult.Content ?? "", ["is_error"] = toolResult.IsError
                        });
                    }
                    result = await subAgentClient.Chat(profile.Model, messages, toolSchema, _log, null, null, ct);
                }
            }

            session.TokensIn += result.UsageIn;
            session.TokensOut += result.UsageOut;
            string output = string.IsNullOrWhiteSpace(result.Content) ? "子 Agent 未返回文字结果" : result.Content.Trim();
            Emit("agent.completed", new JsonObject
            {
                ["sessionId"] = session.Id, ["agentName"] = profile.Name, ["model"] = profile.Model,
                ["task"] = task, ["content"] = output, ["usageIn"] = result.UsageIn, ["usageOut"] = result.UsageOut
            });
            return new ToolResult { Content = $"子 Agent：{profile.Name}（{profile.Model}）\n任务：{task}\n\n{output}" };
        }
        catch (Exception ex)
        {
            Emit("agent.completed", new JsonObject
            {
                ["sessionId"] = session.Id, ["agentName"] = profile.Name, ["model"] = profile.Model,
                ["task"] = task, ["content"] = ex.Message, ["isError"] = true
            });
            return new ToolResult { Content = $"子 Agent {profile.Name} 调用失败：{ex.Message}", Error = ErrorKind.Unknown };
        }
    }

    private JsonObject RespondApproval(JsonObject args)
    {
        string approvalId = RequiredString(args, "approvalId");
        string action = StringArg(args, "action", "reject");
        string feedback = StringArg(args, "feedback", "");
        if (!_approvals.TryGetValue(approvalId, out var pending))
            throw new InvalidOperationException("审批请求已失效");
        if (!pending.Source.TrySetResult(new ApprovalDecision(action, feedback)))
            throw new InvalidOperationException("审批请求已被取消或已处理");
        return new JsonObject { ["accepted"] = true };
    }

    private async Task<ToolResult> UpdatePlanAsync(BackendSession session, JsonNode args, CancellationToken ct)
    {
        var obj = args as JsonObject ?? new JsonObject();
        var plan = obj["plan"] as JsonArray;
        string explanation = StringArg(obj, "explanation", "");
        int count = plan?.Count ?? 0;
        session.Plan = plan?.DeepClone();
        Emit("plan.updated", new JsonObject
        {
            ["sessionId"] = session.Id,
            ["explanation"] = explanation,
            ["plan"] = plan?.DeepClone() ?? new JsonArray()
        });
        await Task.CompletedTask;
        return new ToolResult { Content = $"计划已更新（{count} 步）。请继续执行 in_progress 步骤，完成后标记 completed。" };
    }

    private async Task<ToolResult> RequestClarificationAsync(BackendSession session, JsonNode args, CancellationToken ct)
    {
        var obj = args as JsonObject ?? new JsonObject();
        string question = RequiredString(obj, "question");
        string context = StringArg(obj, "context", "");
        var options = new List<string>();
        if (obj["options"] is JsonArray optionsArr)
            foreach (var item in optionsArr)
                if (item?.GetValue<string>() is string s && !string.IsNullOrWhiteSpace(s)) options.Add(s);
        bool multiSelect = obj["multiSelect"]?.GetValue<bool>() ?? false;

        string clarificationId = Guid.NewGuid().ToString("N");
        var pending = new PendingClarification();
        _clarifications[clarificationId] = pending;
        Emit("clarification.requested", new JsonObject
        {
            ["clarificationId"] = clarificationId,
            ["sessionId"] = session.Id,
            ["question"] = question,
            ["context"] = context,
            ["options"] = new JsonArray(options.Select(o => (JsonNode?)JsonValue.Create(o)).ToArray()),
            ["multiSelect"] = multiSelect
        });
        using var registration = ct.Register(() => pending.Source.TrySetCanceled(ct));
        ClarificationAnswer answer;
        try { answer = await pending.Source.Task; }
        finally { _clarifications.TryRemove(clarificationId, out _); }

        string text = (answer.Text ?? "").Trim();
        string selection = answer.Selection.Count > 0 ? string.Join("; ", answer.Selection) : "";
        string content = !string.IsNullOrEmpty(text) ? text
            : !string.IsNullOrEmpty(selection) ? selection
            : "[用户未提供回答]";
        return new ToolResult { Content = $"[用户回复] {content}" };
    }

    private JsonObject RespondClarification(JsonObject args)
    {
        string clarificationId = RequiredString(args, "clarificationId");
        string text = StringArg(args, "text", "");
        var selection = new List<string>();
        if (args["selection"] is JsonArray selArr)
            foreach (var item in selArr)
                if (item?.GetValue<string>() is string s && !string.IsNullOrWhiteSpace(s)) selection.Add(s);
        if (!_clarifications.TryGetValue(clarificationId, out var pending))
            throw new InvalidOperationException("反问请求已失效");
        if (!pending.Source.TrySetResult(new ClarificationAnswer(text, selection)))
            throw new InvalidOperationException("反问请求已被取消或已处理");
        return new JsonObject { ["accepted"] = true };
    }

    private JsonObject SaveSettings(JsonObject args)
    {
        var profileArgs = args["profile"] as JsonObject;
        if (profileArgs is not null)
        {
            string name = StringArg(profileArgs, "name", _config.ActiveProfile.Name);
            var existing = FindProfile(name);
            string key = StringArg(profileArgs, "apiKey", "");
            if (string.IsNullOrEmpty(key)) key = existing.ApiKey;
            _config.SaveProfile(
                name,
                StringArg(profileArgs, "baseUrl", existing.BaseUrl),
                key,
                StringArg(profileArgs, "model", existing.Model),
                StringArg(profileArgs, "characterCard", existing.CharacterCard));
        }
        if (args["ioRoots"] is JsonValue) _config.IoRoots = StringArg(args, "ioRoots", _config.IoRoots);
        if (args["shellMode"] is JsonValue) _config.ShellMode = StringArg(args, "shellMode", _config.ShellMode);
        if (args["contextWindow"] is JsonValue && args["contextWindow"]!.GetValue<int>() > 1000)
            _config.ContextWindow = args["contextWindow"]!.GetValue<int>();
        if (args["compactThreshold"] is JsonValue)
        {
            int threshold = args["compactThreshold"]!.GetValue<int>();
            if (threshold is > 0 and <= 100) _config.CompactThreshold = threshold;
        }
        _config.SyncActive();
        _config.Save();
        _config.BuildWhitelist();
        foreach (var session in _sessions.Values)
        {
            session.ContextThreshold = _config.CompactThreshold;
            WhitelistWorkspace(session.Workspace);
            Save(session);
        }
        var settings = SettingsJson();
        Emit("settings.changed", settings.DeepClone());
        return settings;
    }

    private JsonObject SaveProfile(JsonObject args)
    {
        var profileArgs = args["profile"] as JsonObject ?? throw new InvalidOperationException("缺少模型配置");
        string originalName = StringArg(args, "originalName", "").Trim();
        string name = RequiredString(profileArgs, "name").Trim();
        ValidateProfileName(name);
        var existing = !string.IsNullOrWhiteSpace(originalName)
            ? _config.Profiles.FirstOrDefault(p => p.Name == originalName)
            : _config.Profiles.FirstOrDefault(p => p.Name == name);
        if (existing is null) existing = new ModelProfile();
        if (_config.Profiles.Any(p => !ReferenceEquals(p, existing) && p.Name == name))
            throw new InvalidOperationException("配置名称已存在");
        string oldName = existing.Name;
        string key = StringArg(profileArgs, "apiKey", "");
        if (string.IsNullOrWhiteSpace(key)) key = existing.ApiKey;
        existing.Name = name;
        existing.BaseUrl = StringArg(profileArgs, "baseUrl", existing.BaseUrl).Trim();
        existing.ApiKey = key;
        existing.Model = StringArg(profileArgs, "model", existing.Model).Trim();
        existing.CharacterCard = StringArg(profileArgs, "characterCard", existing.CharacterCard).Trim();
        ApplyProfileOptions(existing, profileArgs);
        if (!_config.Profiles.Contains(existing)) _config.Profiles.Add(existing);
        if (string.IsNullOrWhiteSpace(_config.ActiveProfileName) || _config.ActiveProfileName == oldName)
            _config.ActiveProfileName = name;
        foreach (var session in _sessions.Values.Where(s => s.ProfileName == oldName || (string.IsNullOrEmpty(oldName) && s.ProfileName == name)))
        {
            session.ProfileName = name;
            session.Model = existing.Model;
            session.ContextWindow = existing.ContextWindow;
            session.L0Loaded = false;
            RemoveSystemMessage(session);
            Save(session);
            Emit("session.updated", SessionJson(session));
        }
        PersistConfig();
        return SettingsJson();
    }

    private async Task<JsonObject> TestProfileAsync(JsonObject args)
    {
        var profileArgs = args["profile"] as JsonObject ?? throw new InvalidOperationException("缺少模型配置");
        string originalName = StringArg(args, "originalName", "").Trim();
        var existing = _config.Profiles.FirstOrDefault(p => p.Name == originalName);
        string key = StringArg(profileArgs, "apiKey", "");
        if (string.IsNullOrWhiteSpace(key)) key = existing?.ApiKey ?? "";
        var profile = new ModelProfile
        {
            Name = StringArg(profileArgs, "name", "测试配置").Trim(),
            BaseUrl = RequiredString(profileArgs, "baseUrl").Trim(),
            ApiKey = key,
            Model = RequiredString(profileArgs, "model").Trim(),
            CharacterCard = StringArg(profileArgs, "characterCard", "")
        };
        ApplyProfileOptions(profile, profileArgs);
        if (string.IsNullOrWhiteSpace(profile.ApiKey)) throw new InvalidOperationException("请先填写 API 密钥再测试");
        var messages = new List<JsonNode> { new JsonObject { ["role"] = "user", ["content"] = "Reply with exactly: OK" } };
        var timer = Stopwatch.StartNew();
        var result = await new ApiClient(profile).Chat(profile.Model, messages, "", _log, null, null, CancellationToken.None);
        timer.Stop();
        if (string.IsNullOrWhiteSpace(result.Content))
            throw new InvalidOperationException("模型请求成功，但没有返回正文。请检查模型名称、请求协议与服务商兼容性后重试。");
        string reply = result.Content.Trim();
        return new JsonObject
        {
            ["ok"] = true,
            ["latencyMs"] = timer.ElapsedMilliseconds,
            ["reply"] = reply.Length > 160 ? reply[..160] + "…" : reply,
            ["protocol"] = profile.Provider == "anthropic" ? "Anthropic Messages" : profile.WireProtocol == "responses" ? "OpenAI Responses" : "OpenAI Chat Completions"
        };
    }

    private async Task<JsonObject> ListProviderModelsAsync(JsonObject args)
    {
        var profileArgs = args["profile"] as JsonObject ?? throw new InvalidOperationException("缺少模型配置");
        string originalName = StringArg(args, "originalName", "").Trim();
        var existing = _config.Profiles.FirstOrDefault(p => p.Name == originalName);
        string key = StringArg(profileArgs, "apiKey", "");
        if (string.IsNullOrWhiteSpace(key)) key = existing?.ApiKey ?? "";
        if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("请先填写 API 密钥");
        string provider = StringArg(profileArgs, "provider", "openai") == "anthropic" ? "anthropic" : "openai";
        string baseUrl = RequiredString(profileArgs, "baseUrl").TrimEnd('/');
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };
        var endpoints = ModelListEndpoints(baseUrl).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        string endpoint = endpoints[0];
        string raw = "";
        int status = 0;
        foreach (var candidate in endpoints)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, candidate);
            if (provider == "anthropic")
            {
                request.Headers.Add("x-api-key", key);
                request.Headers.Add("anthropic-version", "2023-06-01");
            }
            else request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", key);
            using var response = await client.SendAsync(request);
            raw = await response.Content.ReadAsStringAsync();
            status = (int)response.StatusCode;
            endpoint = candidate;
            if (response.IsSuccessStatusCode) break;
            if (status is not (404 or 405)) break;
        }
        if (status < 200 || status >= 300) throw new InvalidOperationException($"获取模型列表失败 HTTP {status}: {raw[..Math.Min(raw.Length, 240)]}");
        var parsed = JsonNode.Parse(raw);
        var data = parsed?["data"] as JsonArray ?? parsed?["models"] as JsonArray ?? new JsonArray();
        var models = data.Select(item =>
            item is JsonValue value && value.TryGetValue<string>(out var text)
                ? text
                : item?["id"]?.GetValue<string>() ?? item?["name"]?.GetValue<string>() ?? "")
            .Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().OrderBy(id => id).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray();
        return new JsonObject { ["models"] = new JsonArray(models), ["endpoint"] = endpoint };
    }

    private static IEnumerable<string> ModelListEndpoints(string baseUrl)
    {
        string normalized = baseUrl.TrimEnd('/');
        if (normalized.EndsWith("/models", StringComparison.OrdinalIgnoreCase))
        {
            yield return normalized;
            yield break;
        }
        yield return normalized + "/models";
        int v1Index = normalized.LastIndexOf("/v1", StringComparison.OrdinalIgnoreCase);
        if (v1Index >= 0) yield return normalized[..(v1Index + 3)] + "/models";
        if (Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
            yield return $"{uri.Scheme}://{uri.Authority}/v1/models";
    }

    private JsonObject ListWorkspaceFiles(JsonObject args)
    {
        var session = GetSession(args);
        if (string.IsNullOrWhiteSpace(session.Workspace) || !Directory.Exists(session.Workspace)) return new JsonObject { ["files"] = new JsonArray() };
        string root = Path.GetFullPath(session.Workspace);
        var files = Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories).Take(400).Select(path =>
        {
            bool directory = Directory.Exists(path);
            var info = directory ? null : new FileInfo(path);
            return (JsonNode?)new JsonObject
            {
                ["name"] = Path.GetFileName(path), ["path"] = Path.GetFullPath(path),
                ["relativePath"] = Path.GetRelativePath(root, path), ["isDirectory"] = directory,
                ["size"] = info?.Length ?? 0, ["lastWrite"] = (directory ? Directory.GetLastWriteTime(path) : info!.LastWriteTime).ToString("O")
            };
        }).ToArray();
        return new JsonObject { ["root"] = root, ["files"] = new JsonArray(files) };
    }

    private static void ApplyProfileOptions(ModelProfile profile, JsonObject args)
    {
        profile.Provider = StringArg(args, "provider", profile.Provider) == "anthropic" ? "anthropic" : "openai";
        string wire = StringArg(args, "wireProtocol", profile.WireProtocol);
        profile.WireProtocol = profile.Provider == "anthropic" ? "anthropic_messages" : wire == "responses" ? "responses" : "chat_completions";
        profile.SupportsTools = BoolArg(args, "supportsTools", profile.SupportsTools);
        profile.SupportsImages = BoolArg(args, "supportsImages", profile.SupportsImages);
        profile.SupportsReasoning = BoolArg(args, "supportsReasoning", profile.SupportsReasoning);
        profile.ContextWindow = IntArg(args, "contextWindow", profile.ContextWindow, 0, 4_000_000);
        profile.MaxOutputTokens = IntArg(args, "maxOutputTokens", profile.MaxOutputTokens, 0, 1_000_000);
    }

    private JsonObject SetActiveProfile(JsonObject args)
    {
        string name = RequiredString(args, "name");
        if (!_config.Profiles.Any(p => p.Name == name)) throw new InvalidOperationException("模型配置不存在");
        _config.SwitchProfile(name);
        PersistConfig();
        return SettingsJson();
    }

    private JsonObject DeleteProfile(JsonObject args)
    {
        string name = RequiredString(args, "name");
        if (_config.Profiles.Count <= 1) throw new InvalidOperationException("至少保留一个模型配置");
        var removed = _config.Profiles.FirstOrDefault(p => p.Name == name) ?? throw new InvalidOperationException("模型配置不存在");
        _config.Profiles.Remove(removed);
        if (_config.ActiveProfileName == name) _config.ActiveProfileName = _config.Profiles[0].Name;
        var fallback = _config.ActiveProfile;
        foreach (var session in _sessions.Values.Where(s => s.ProfileName == name))
        {
            session.ProfileName = fallback.Name;
            session.Model = fallback.Model;
            session.ContextWindow = fallback.ContextWindow;
            session.L0Loaded = false;
            RemoveSystemMessage(session);
            Save(session);
            Emit("session.updated", SessionJson(session));
        }
        PersistConfig();
        return SettingsJson();
    }

    private void PersistConfig()
    {
        _config.SyncActive();
        _config.Save();
        var settings = SettingsJson();
        Emit("settings.changed", settings.DeepClone());
    }

    private JsonObject ListCharacters()
    {
        string dir = Path.GetFullPath(Path.Combine("RanParty", "Characters"));
        Directory.CreateDirectory(dir);
        var items = new List<JsonNode?>
        {
            new JsonObject { ["name"] = "SOUL", ["displayName"] = CharacterTitle(Path.Combine("RanParty", "SOUL.md"), "SOUL"), ["path"] = Path.GetFullPath(Path.Combine("RanParty", "SOUL.md")), ["isSoul"] = true }
        };
        items.AddRange(Directory.GetFiles(dir, "*.md")
            .Where(path => !Path.GetFileName(path).EndsWith("_growth.md", StringComparison.OrdinalIgnoreCase))
            .Select(path => (JsonNode?)new JsonObject { ["name"] = Path.GetFileNameWithoutExtension(path), ["displayName"] = CharacterTitle(path, Path.GetFileNameWithoutExtension(path)), ["path"] = path, ["isSoul"] = false }));
        return new JsonObject { ["characters"] = new JsonArray(items.ToArray()) };
    }

    private JsonObject ReadCharacter(JsonObject args)
    {
        string name = SafeCharacterName(RequiredString(args, "name"));
        string path = CharacterPath(name);
        return new JsonObject { ["name"] = name, ["content"] = File.Exists(path) ? File.ReadAllText(path) : "", ["isSoul"] = name == "SOUL" };
    }

    private JsonObject SaveCharacter(JsonObject args)
    {
        string name = SafeCharacterName(RequiredString(args, "name"));
        string path = CharacterPath(name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, StringArg(args, "content", ""));
        RefreshCharacterDisplays(name);
        return new JsonObject { ["name"] = name, ["path"] = Path.GetFullPath(path) };
    }

    private JsonObject RenameCharacter(JsonObject args)
    {
        string oldName = SafeCharacterName(RequiredString(args, "oldName"));
        string newName = SafeCharacterName(RequiredString(args, "newName"));
        if (oldName == "SOUL" || newName == "SOUL") throw new InvalidOperationException("SOUL.md 不能重命名");
        string dir = Path.Combine("RanParty", "Characters");
        string oldPath = Path.Combine(dir, oldName + ".md");
        string newPath = Path.Combine(dir, newName + ".md");
        string oldGrowthPath = Path.Combine(dir, oldName + "_growth.md");
        string newGrowthPath = Path.Combine(dir, newName + "_growth.md");
        if (!File.Exists(oldPath)) throw new FileNotFoundException("角色卡不存在", oldPath);
        if (File.Exists(newPath)) throw new InvalidOperationException("角色卡名称已存在");
        File.Move(oldPath, newPath);
        if (File.Exists(oldGrowthPath) && !File.Exists(newGrowthPath)) File.Move(oldGrowthPath, newGrowthPath);
        foreach (var profile in _config.Profiles.Where(p => p.CharacterCard == oldName)) profile.CharacterCard = newName;
        PersistConfig();
        RefreshCharacterDisplays(newName);
        return new JsonObject { ["name"] = newName };
    }

    private JsonObject DeleteCharacter(JsonObject args)
    {
        string name = SafeCharacterName(RequiredString(args, "name"));
        if (name == "SOUL") throw new InvalidOperationException("SOUL.md 不能删除");
        string path = Path.Combine("RanParty", "Characters", name + ".md");
        if (File.Exists(path)) File.Delete(path);
        foreach (var profile in _config.Profiles.Where(p => p.CharacterCard == name)) profile.CharacterCard = "";
        PersistConfig();
        RefreshCharacterDisplays("SOUL");
        return new JsonObject { ["name"] = name };
    }

    private void RefreshCharacterDisplays(string characterName)
    {
        var settings = SettingsJson();
        Emit("settings.changed", settings.DeepClone());
        foreach (var session in _sessions.Values)
        {
            var profile = FindProfile(session.ProfileName);
            bool usesCharacter = characterName == "SOUL" ? string.IsNullOrWhiteSpace(profile.CharacterCard) : profile.CharacterCard == characterName;
            if (usesCharacter) Emit("session.updated", SessionJson(session));
        }
    }

    private JsonObject ListSkills(JsonObject args)
    {
        var skills = _skillRegistry.GetEnabled();
        return new JsonObject { ["skills"] = new JsonArray(skills.Select(skill => (JsonNode?)new JsonObject
        {
            ["id"] = skill.Id,
            ["name"] = skill.Name,
            ["description"] = skill.Description,
            ["source"] = skill.Source,
            ["pathLabel"] = skill.PathLabel
        }).ToArray()) };
    }

    private async Task<JsonObject> ListSkillHubAsync(JsonObject args)
    {
        string query = StringArg(args, "query", "").Trim();
        string section = StringArg(args, "section", "featured").Trim().ToLowerInvariant();
        if (section == "installed")
        {
            var installedItems = _skillRegistry.GetEnabled()
                .Where(skill => skill.Source is "Skill 市场" or "SkillHub CLI")
                .Select(skill => (JsonNode?)new JsonObject
                {
                    ["id"] = skill.Id,
                    ["name"] = skill.Name,
                    ["description"] = skill.Description,
                    ["pluginName"] = "已安装 Skill",
                    ["marketplace"] = skill.Source,
                    ["publisher"] = "本地",
                    ["category"] = "已安装",
                    ["version"] = "",
                    ["installed"] = true,
                    ["source"] = "installed"
                }).ToArray();
            return new JsonObject { ["items"] = new JsonArray(installedItems) };
        }
        if (section == "installed")
        {
            var installedItems = _skillRegistry.GetEnabled()
                .Where(skill => skill.Source == "Skill 市场")
                .Select(skill => (JsonNode?)new JsonObject
                {
                    ["id"] = skill.Id,
                    ["name"] = skill.Name,
                    ["description"] = skill.Description,
                    ["pluginName"] = "已安装 Skill",
                    ["marketplace"] = "RanParty",
                    ["publisher"] = "本地",
                    ["category"] = "已安装",
                    ["version"] = "",
                    ["installed"] = true,
                    ["source"] = "installed"
                }).ToArray();
            return new JsonObject { ["items"] = new JsonArray(installedItems) };
        }

        string url;
        if (!string.IsNullOrWhiteSpace(query))
        {
            url = $"https://api.skillhub.cn/api/v1/search?q={Uri.EscapeDataString(query)}&limit=60";
        }
        else
        {
            section = section is "hot" or "newest" or "recommended" or "trending" ? section : "featured";
            url = $"https://api.skillhub.cn/api/v1/showcase/{section}";
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("RanParty/1.7");
        request.Headers.Accept.ParseAdd("application/json");
        using var response = await SkillHubClient.SendAsync(request);
        response.EnsureSuccessStatusCode();
        string payload = await response.Content.ReadAsStringAsync();
        var root = JsonNode.Parse(payload) as JsonObject ?? throw new InvalidOperationException("SkillHub 返回了无效数据");
        var sourceItems = root["results"] as JsonArray ?? root["skills"] as JsonArray ?? new JsonArray();
        var installedNames = _skillRegistry.GetEnabled()
            .Select(skill => skill.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var items = new JsonArray();
        foreach (var node in sourceItems.OfType<JsonObject>())
        {
            string slug = node["slug"]?.GetValue<string>() ?? "";
            if (string.IsNullOrWhiteSpace(slug)) continue;
            string name = node["displayName"]?.GetValue<string>()
                ?? node["name"]?.GetValue<string>() ?? slug;
            string description = node["description_zh"]?.GetValue<string>()
                ?? node["summary"]?.GetValue<string>()
                ?? node["description"]?.GetValue<string>() ?? "";
            string publisher = node["ownerName"]?.GetValue<string>()
                ?? node["owner_name"]?.GetValue<string>() ?? "SkillHub";
            string iconUrl = node["iconUrl"]?.GetValue<string>()
                ?? node["icon_url"]?.GetValue<string>() ?? "";
            string requiresApiKey = (node["labels"] as JsonObject)?["requires_api_key"]?.GetValue<string>() ?? "false";
            items.Add(new JsonObject
            {
                ["id"] = $"skillhub:{slug}",
                ["slug"] = slug,
                ["name"] = name,
                ["description"] = description,
                ["pluginName"] = "SkillHub",
                ["marketplace"] = "SkillHub",
                ["publisher"] = publisher,
                ["category"] = node["category"]?.GetValue<string>() ?? "其他",
                ["version"] = node["version"]?.GetValue<string>() ?? "",
                ["installed"] = installedNames.Contains(slug) || installedNames.Contains(name),
                ["iconUrl"] = iconUrl,
                ["downloads"] = node["downloads"]?.GetValue<long>() ?? 0,
                ["stars"] = node["stars"]?.GetValue<long>() ?? 0,
                ["requiresApiKey"] = requiresApiKey.Equals("true", StringComparison.OrdinalIgnoreCase),
                ["source"] = node["source"]?.GetValue<string>() ?? "community"
            });
        }
        return new JsonObject { ["items"] = items, ["section"] = section, ["query"] = query };
    }

    private async Task<JsonObject> InstallSkillHubAsync(JsonObject args)
    {
        string slug = SafeSkillFolderName(RequiredString(args, "slug"));
        string id = $"skillhub:{slug}";
        string url = $"https://api.skillhub.cn/api/v1/download?slug={Uri.EscapeDataString(slug)}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd("RanParty/1.7");
        using var response = await SkillHubClient.SendAsync(request);
        response.EnsureSuccessStatusCode();
        byte[] archiveBytes = await response.Content.ReadAsByteArrayAsync();
        if (archiveBytes.Length > 25 * 1024 * 1024) throw new InvalidOperationException("Skill 压缩包超过 25MB 安全上限");
        using var archiveStream = new MemoryStream(archiveBytes, false);
        using var archive = new ZipArchive(archiveStream, ZipArchiveMode.Read, false);
        var skillEntry = archive.Entries
            .Where(entry => entry.FullName.Equals("SKILL.md", StringComparison.OrdinalIgnoreCase)
                || entry.FullName.EndsWith("/SKILL.md", StringComparison.OrdinalIgnoreCase))
            .OrderBy(entry => entry.FullName.Count(character => character == '/'))
            .FirstOrDefault() ?? throw new InvalidOperationException("下载包中没有 SKILL.md");
        if (skillEntry.Length > 1024 * 1024) throw new InvalidOperationException("SKILL.md 超过 1MB 安全上限");
        string content;
        using (var reader = new StreamReader(skillEntry.Open(), Encoding.UTF8, true)) content = await reader.ReadToEndAsync();
        if (string.IsNullOrWhiteSpace(content)) throw new InvalidOperationException("SKILL.md 内容为空");

        string userRoot = Path.GetFullPath(Path.Combine("RanParty", "InstalledSkills"));
        Directory.CreateDirectory(userRoot);
        string target = Path.GetFullPath(Path.Combine(userRoot, slug));
        if (!IsInsidePath(userRoot, target)) throw new InvalidOperationException("Skill 安装路径无效");
        string marker = Path.Combine(target, ".ranparty-market.json");
        if (Directory.Exists(target) && !File.Exists(marker))
            throw new InvalidOperationException($"用户目录中已存在同名 Skill「{slug}」，为避免覆盖请先手动处理");
        Directory.CreateDirectory(target);
        await File.WriteAllTextAsync(Path.Combine(target, "SKILL.md"), content, Encoding.UTF8);
        var (name, description) = ReadSkillMetadataLegacy(Path.Combine(target, "SKILL.md"));
        await File.WriteAllTextAsync(marker, new JsonObject
        {
            ["id"] = id,
            ["slug"] = slug,
            ["name"] = string.IsNullOrWhiteSpace(name) ? slug : name,
            ["description"] = description,
            ["source"] = "skillhub",
            ["marketplace"] = "SkillHub",
            ["installedAt"] = DateTime.Now.ToString("O")
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        ReloadSkillsAndNotify();
        return new JsonObject { ["installed"] = true, ["id"] = id, ["name"] = name, ["path"] = target };
    }

    private JsonObject ListSkillMarketplace(JsonObject args)
    {
        string workspace = StringArg(args, "workspace", "");
        var installed = _skillRegistry.GetEnabled().Select(skill => skill.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var catalog = DiscoverMarketplaceSkills(workspace);
        return new JsonObject
        {
            ["items"] = new JsonArray(catalog.Select(item => (JsonNode?)new JsonObject
            {
                ["id"] = item.Id,
                ["name"] = item.Name,
                ["description"] = item.Description,
                ["pluginName"] = item.PluginName,
                ["marketplace"] = item.Marketplace,
                ["publisher"] = item.Publisher,
                ["category"] = item.Category,
                ["version"] = item.Version,
                ["installed"] = installed.Contains(item.Name)
            }).ToArray())
        };
    }

    private JsonObject InstallMarketplaceSkill(JsonObject args)
    {
        string workspace = StringArg(args, "workspace", "");
        string id = RequiredString(args, "id");
        var item = DiscoverMarketplaceSkills(workspace).FirstOrDefault(candidate => candidate.Id == id)
            ?? throw new InvalidOperationException("市场 Skill 不存在或来源已失效");
        string userRoot = Path.GetFullPath(Path.Combine("RanParty", "InstalledSkills"));
        Directory.CreateDirectory(userRoot);
        string folderName = SafeSkillFolderName(item.Name);
        string target = Path.GetFullPath(Path.Combine(userRoot, folderName));
        if (!IsInsidePath(userRoot, target)) throw new InvalidOperationException("Skill 安装路径无效");
        string marker = Path.Combine(target, ".ranparty-market.json");
        if (Directory.Exists(target) && !File.Exists(marker))
            throw new InvalidOperationException($"用户目录中已存在同名 Skill「{folderName}」，为避免覆盖请先手动处理");
        Directory.CreateDirectory(target);
        File.Copy(item.SkillPath, Path.Combine(target, "SKILL.md"), true);
        File.WriteAllText(marker, new JsonObject
        {
            ["id"] = item.Id,
            ["pluginName"] = item.PluginName,
            ["marketplace"] = item.Marketplace,
            ["installedAt"] = DateTime.Now.ToString("O")
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        _skillRegistry.Reload();
        return new JsonObject { ["installed"] = true, ["name"] = item.Name, ["path"] = target };
    }

    private JsonObject UninstallMarketplaceSkill(JsonObject args)
    {
        string id = RequiredString(args, "id");
        string userRoot = Path.GetFullPath(Path.Combine("RanParty", "InstalledSkills"));
        if (!Directory.Exists(userRoot)) return new JsonObject { ["installed"] = false };
        foreach (var directory in Directory.GetDirectories(userRoot))
        {
            string target = Path.GetFullPath(directory);
            if (!IsInsidePath(userRoot, target)) continue;
            string marker = Path.Combine(target, ".ranparty-market.json");
            if (!File.Exists(marker)) continue;
            try
            {
                var metadata = JsonNode.Parse(File.ReadAllText(marker)) as JsonObject;
                if (metadata?["id"]?.GetValue<string>() != id) continue;
                Directory.Delete(target, true);
                ReloadSkillsAndNotify();
                return new JsonObject { ["installed"] = false };
            }
            catch (JsonException) { }
        }
        throw new InvalidOperationException("该 Skill 不是由 RanParty 市场安装，不能自动卸载");
    }

    // ---- SkillRegistry 替换旧的 DiscoverSkills/ResolveSkills ----

    private void ReloadSkillsAndNotify()
    {
        _skillRegistry.Reload();
        Emit("skills.changed", new JsonObject { ["count"] = _skillRegistry.GetEnabled().Count });
    }

    private IReadOnlyList<SkillInfo> ResolveSkills(string workspace, IReadOnlyList<string> ids)
    {
        if (ids.Count == 0) return Array.Empty<SkillInfo>();
        var result = new List<SkillInfo>();
        foreach (var id in ids.Distinct(StringComparer.Ordinal))
        {
            var skill = _skillRegistry.FindById(id);
            if (skill == null) throw new InvalidOperationException($"Skill 不存在: {id}");
            result.Add(skill.ToSkillInfo());
        }
        return result;
    }

    private List<MarketplaceSkillInfo> DiscoverMarketplaceSkills(string workspace)
    {
        var result = new List<MarketplaceSkillInfo>();
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void AddMarketplace(string path) { if (File.Exists(path)) files.Add(Path.GetFullPath(path)); }
        AddMarketplace(Path.GetFullPath(Path.Combine("RanParty", "SkillMarket", "marketplace.json")));
        AddMarketplace(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agents", "plugins", "marketplace.json"));
        AddMarketplace(Path.GetFullPath(Path.Combine(".agents", "plugins", "marketplace.json")));
        if (!string.IsNullOrWhiteSpace(workspace) && Directory.Exists(workspace))
        {
            var cursor = new DirectoryInfo(Path.GetFullPath(workspace));
            while (cursor is not null)
            {
                AddMarketplace(Path.Combine(cursor.FullName, ".agents", "plugins", "marketplace.json"));
                if (Directory.Exists(Path.Combine(cursor.FullName, ".git"))) break;
                cursor = cursor.Parent;
            }
        }
        foreach (string marketplaceFile in files)
        {
            try
            {
                var marketplace = JsonNode.Parse(File.ReadAllText(marketplaceFile)) as JsonObject;
                if (marketplace?["plugins"] is not JsonArray plugins) continue;
                string marketplaceRoot = Directory.GetParent(Directory.GetParent(Path.GetDirectoryName(marketplaceFile)!)!.FullName)!.FullName;
                string marketplaceName = marketplace?["interface"]?["displayName"]?.GetValue<string>()
                    ?? marketplace?["name"]?.GetValue<string>() ?? "本地市场";
                foreach (var node in plugins.OfType<JsonObject>())
                {
                    string relativePlugin = node["source"]?["path"]?.GetValue<string>() ?? "";
                    if (string.IsNullOrWhiteSpace(relativePlugin)) continue;
                    string pluginPath = Path.GetFullPath(Path.Combine(marketplaceRoot, relativePlugin));
                    if (!IsInsidePath(marketplaceRoot, pluginPath)) continue;
                    string manifestPath = Path.Combine(pluginPath, ".codex-plugin", "plugin.json");
                    if (!File.Exists(manifestPath)) continue;
                    var manifest = JsonNode.Parse(File.ReadAllText(manifestPath)) as JsonObject;
                    if (manifest is null) continue;
                    string skillsRelative = manifest["skills"]?.GetValue<string>() ?? "./skills/";
                    string skillsRoot = Path.GetFullPath(Path.Combine(pluginPath, skillsRelative));
                    if (!IsInsidePath(pluginPath, skillsRoot) || !Directory.Exists(skillsRoot)) continue;
                    string pluginName = manifest["interface"]?["displayName"]?.GetValue<string>()
                        ?? manifest["name"]?.GetValue<string>() ?? node["name"]?.GetValue<string>() ?? "Plugin";
                    string publisher = manifest["interface"]?["developerName"]?.GetValue<string>()
                        ?? manifest["author"]?["name"]?.GetValue<string>() ?? "未知发布者";
                    string category = node["category"]?.GetValue<string>()
                        ?? manifest["interface"]?["category"]?.GetValue<string>() ?? "其他";
                    string version = manifest["version"]?.GetValue<string>() ?? "0.0.0";
                    foreach (string skillDirectory in Directory.GetDirectories(skillsRoot))
                    {
                        string skillPath = Path.Combine(skillDirectory, "SKILL.md");
                        if (!File.Exists(skillPath)) continue;
                        var (name, description) = ReadSkillMetadataLegacy(skillPath);
                        if (string.IsNullOrWhiteSpace(name)) name = Path.GetFileName(skillDirectory);
                        string id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(skillPath).ToUpperInvariant())))[..20].ToLowerInvariant();
                        result.Add(new MarketplaceSkillInfo(id, name, description, pluginName, marketplaceName, publisher, category, version, Path.GetFullPath(skillPath)));
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { _log.Err($"读取 Skill 市场失败 {marketplaceFile}: {ex.Message}"); }
        }
        return result.GroupBy(item => item.Id).Select(group => group.First()).OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static (string name, string description) ReadSkillMetadataLegacy(string path)
    {
        var meta = SkillRegistry.ParseFrontmatter(File.Exists(path) ? File.ReadAllText(path) : "");
        return (meta.GetValueOrDefault("name", ""), meta.GetValueOrDefault("description", ""));
    }

    private static string BuildSkillPrompt(IReadOnlyList<SkillInfo> skills)
    {
        var sb = new StringBuilder("The user explicitly invoked the following skills for this turn. Follow their instructions for this request.\n");
        foreach (var skill in skills)
        {
            sb.Append("\n<skill name=\"").Append(skill.Name).Append("\" source=\"").Append(skill.Source).Append("\">\n");
            sb.Append(File.ReadAllText(skill.FullPath));
            sb.Append("\n</skill>\n");
        }
        return sb.ToString();
    }

    private JsonObject SaveDataUrl(JsonObject args)
    {
        string path = RequiredString(args, "path");
        string dataUrl = RequiredString(args, "dataUrl");
        string fullPath = Path.GetFullPath(path);
        if (!_config.InWhitelist(fullPath)) throw new InvalidOperationException("Path not in whitelist");
        // Decode base64 data URL
        int comma = dataUrl.IndexOf(',');
        if (comma < 0) throw new InvalidOperationException("Invalid data URL");
        byte[] bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllBytes(fullPath, bytes);
        return new JsonObject { ["saved"] = true, ["path"] = fullPath };
    }

    private JsonObject OpenPath(JsonObject args)
    {
        string path = RequiredString(args, "path");
        if (!_config.InWhitelist(path)) throw new InvalidOperationException("路径不在白名单内");
        if (!File.Exists(path) && !Directory.Exists(path)) throw new FileNotFoundException("文件或目录不存在", path);
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext is ".exe" or ".bat" or ".cmd" or ".ps1" or ".vbs" or ".com" or ".msi" or ".scr") throw new InvalidOperationException("Cannot open executable files with path.open");
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        return new JsonObject { ["opened"] = true };
    }

    // ── Evolution methods ──

    private ToolResult GrowthRecord(BackendSession session, JsonNode args)
    {
        string action = (args?["action"]?.GetValue<string>() ?? "").Trim();
        string content = (args?["content"]?.GetValue<string>() ?? "").Trim();
        if (string.IsNullOrWhiteSpace(action) || string.IsNullOrWhiteSpace(content))
            return new ToolResult { Content = "action and content are required", Error = ErrorKind.InvalidArgument };
        var profile = FindProfile(session.ProfileName);
        string charName = string.IsNullOrWhiteSpace(profile.CharacterCard) ? "SOUL" : profile.CharacterCard;
        if (charName.Any(ch => !char.IsLetterOrDigit(ch) && ch != '-' && ch != '_')) return new ToolResult { Content = "Invalid character name", Error = ErrorKind.InvalidArgument };
        string growthPath = Path.Combine("RanParty", "Characters", charName + "_growth.md");
        Directory.CreateDirectory(Path.GetDirectoryName(growthPath)!);
        string timestamp = DateTime.Now.ToString("yyyy-MM-dd");
        string section = action switch
        {
            "milestone" => "## 关系里程碑",
            "preference" => "## 你的偏好",
            "tone" => "## 性格微调",
            _ => "## 其他"
        };
        string entry = $"- {content} ({timestamp})\n";
        if (!File.Exists(growthPath))
        {
            File.WriteAllText(growthPath, $"> ver:1 | {timestamp}\n\n## 熟悉度: 初始\n\n## 你的偏好\n\n## 关系里程碑\n\n## 性格微调\n\n");
        }
        // Append to matching section
        var existing = File.ReadAllText(growthPath);
        int sectionIdx = existing.IndexOf(section);
        if (sectionIdx >= 0)
        {
            int insertAt = existing.IndexOf('\n', sectionIdx) + 1;
            existing = existing[..insertAt] + entry + existing[insertAt..];
        }
        else
        {
            existing += "\n" + section + "\n" + entry;
        }
        // Enforce 1500 char limit — keep header (400 chars) + tail (1050 chars)
        if (existing.Length > 1500) { int headKeep = 400; int tailKeep = 1050; existing = existing[..headKeep] + "\n...\n" + existing[^tailKeep..]; }
        File.WriteAllText(growthPath, existing);
        // Update version
        var verMatch = System.Text.RegularExpressions.Regex.Match(existing, @"ver:(\d+)");
        if (verMatch.Success)
        {
            int ver = int.Parse(verMatch.Groups[1].Value) + 1;
            existing = System.Text.RegularExpressions.Regex.Replace(existing, @"ver:\d+", "ver:" + ver);
            File.WriteAllText(growthPath, existing);
        }
        Emit("knowledge.updated", new JsonObject { ["sessionId"] = session.Id, ["file"] = charName + "_growth.md", ["action"] = action });
        // Reset L0 so growth is injected next turn
        session.L0Loaded = false;
        return new ToolResult { Content = $"Growth record added ({action}): {content[..Math.Min(60, content.Length)]}" };
    }

    /// <summary>子 Agent 专用工具分发：路由 CatRegistry 工具 + 元工具（growth_record, ask_user 等）</summary>
    private ToolResult DispatchSubAgentTool(string name, JsonNode args, BackendSession session, CancellationToken ct)
    {
        // Meta-tools that sub-agents can use
        if (name == "growth_record") return GrowthRecord(session, args);
        if (name == "ask_user")
            return new ToolResult { Content = "子 Agent 不允许反问用户。请基于已知信息给出建议，让主 Agent 去确认。", Error = ErrorKind.PermissionDenied };
        if (name == "update_plan") return new ToolResult { Content = "OK 计划已记录（子 Agent 本地）" };
        if (name == "tool_output_lookup")
        {
            string cid = (args as JsonObject ?? new JsonObject())["cache_id"]?.GetValue<string>() ?? "";
            if (_toolOutputs.TryGetValue(cid, out var full))
            {
                int offset = Math.Max(0, (args as JsonObject)?["offset"]?.GetValue<int>() ?? 0);
                int limit = Math.Clamp((args as JsonObject)?["limit"]?.GetValue<int>() ?? 8000, 1, 16000);
                return new ToolResult { Content = full.Length <= offset ? "" : full.Substring(offset, Math.Min(limit, full.Length - offset)) };
            }
            return new ToolResult { Content = "缓存未找到或已过期", Error = ErrorKind.NotFound };
        }
        if (name == "curator_review")
            return new ToolResult { Content = "子 Agent 不允许执行 curator。请主 Agent 自行触发。", Error = ErrorKind.PermissionDenied };
        // CatRegistry tools (file, shell, web, memory, lesson, archive_search, knowledge_read)
        return _registry.Dispatch(name, args);
    }

    private async Task<ToolResult> CuratorReview(BackendSession session, JsonNode args, CancellationToken ct)
    {
        string scope = (args?["scope"]?.GetValue<string>() ?? "all").Trim();
        var report = new StringBuilder("Curator Review Report\n\n");
        var archiveFiles = new[] { "LESSONS_archive.md", "MEMORY_archive.md" };
        int merged = 0, obsolete = 0;

        foreach (var file in archiveFiles)
        {
            if (scope != "all" && !file.ToLower().Contains(scope)) continue;
            string path = Path.Combine("RanParty", file);
            if (!File.Exists(path)) continue;
            var sections = File.ReadAllText(path).Split("---", StringSplitOptions.RemoveEmptyEntries)
                .Select(s => s.Trim()).Where(s => s.Length > 10).ToList();
            report.AppendLine($"{file}: {sections.Count} entries");
            // Mark obsolete
            for (int i = 0; i < sections.Count; i++)
            {
                if (sections[i].Contains("[obsolete:"))
                {
                    report.AppendLine($"  [obsolete] {sections[i][..Math.Min(80, sections[i].Length)]}...");
                    obsolete++;
                }
                else if (sections[i].Contains("hits:") && sections[i].Contains("建议升级"))
                {
                    report.AppendLine($"  [upgrade] {sections[i][..Math.Min(80, sections[i].Length)]}... → consider upgrading to LESSONS.md");
                    merged++;
                }
            }
        }

        // Update curator state
        string statePath = Path.Combine("RanParty", ".curator_state");
        var state = new JsonObject { ["last_run"] = DateTime.Now.ToString("O"), ["run_count"] = 1 };
        if (File.Exists(statePath))
            try { state = JsonNode.Parse(File.ReadAllText(statePath)) as JsonObject ?? state; }
            catch { }
        state["last_run"] = DateTime.Now.ToString("O");
        state["run_count"] = (state["run_count"]?.GetValue<int>() ?? 0) + 1;
        File.WriteAllText(statePath, state.ToJsonString());
        report.AppendLine($"\nTotal: {obsolete} obsolete, {merged} candidates for upgrade");

        return new ToolResult { Content = report.ToString() };
    }

    // ── Knowledge IPC ──

    private async Task<JsonObject> KnowledgeList(JsonObject args)
    {
        string file = (args["file"]?.GetValue<string>() ?? "").Trim();
        var result = new JsonObject();
        var knownFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["MEMORY.md"] = "memory",
            ["LESSONS.md"] = "lessons",
            ["MEMORY_archive.md"] = "memory_archive",
            ["LESSONS_archive.md"] = "lessons_archive",
            ["_search_index.md"] = "search_index"
        };
        bool isGrowthFile = IsGrowthKnowledgeFile(file);
        if (!string.IsNullOrEmpty(file) && knownFiles.TryGetValue(file, out var kind))
        {
            string path = Path.Combine("RanParty", file);
            result["content"] = File.Exists(path) ? File.ReadAllText(path) : "";
            result["kind"] = kind;
            result["file"] = file;
        }
        else if (!string.IsNullOrEmpty(file) && isGrowthFile)
        {
            string path = Path.Combine("RanParty", file);
            result["content"] = File.Exists(path) ? File.ReadAllText(path) : "";
            result["kind"] = "growth";
            result["file"] = file;
        }
        else
        {
            var items = new JsonArray();
            foreach (var kv in knownFiles)
            {
                string path = Path.Combine("RanParty", kv.Key);
                items.Add(new JsonObject
                {
                    ["file"] = kv.Key,
                    ["kind"] = kv.Value,
                    ["size"] = File.Exists(path) ? new FileInfo(path).Length : 0,
                    ["exists"] = File.Exists(path)
                });
            }
            // Add growth files for all character cards, including not-yet-created files.
            var charDir = Path.Combine("RanParty", "Characters");
            var growthFiles = new SortedSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "Characters/SOUL_growth.md"
            };
            if (Directory.Exists(charDir))
            {
                foreach (var card in Directory.GetFiles(charDir, "*.md"))
                {
                    string name = Path.GetFileNameWithoutExtension(card);
                    if (name.EndsWith("_growth", StringComparison.OrdinalIgnoreCase)) continue;
                    growthFiles.Add("Characters/" + name + "_growth.md");
                }
                foreach (var gf in Directory.GetFiles(charDir, "*_growth.md"))
                    growthFiles.Add("Characters/" + Path.GetFileName(gf));
            }
            foreach (var growthFile in growthFiles)
            {
                string path = Path.Combine("RanParty", growthFile);
                items.Add(new JsonObject
                {
                    ["file"] = growthFile,
                    ["kind"] = "growth",
                    ["size"] = File.Exists(path) ? new FileInfo(path).Length : 0,
                    ["exists"] = File.Exists(path)
                });
            }
            result["items"] = items;
        }
        await Task.CompletedTask;
        return result;
    }

    private JsonObject KnowledgeUpdate(JsonObject args)
    {
        string file = (args["file"]?.GetValue<string>() ?? "").Trim();
        string content = (args["content"]?.GetValue<string>() ?? "").Trim();
        var allowed = new[] { "MEMORY.md", "LESSONS.md", "MEMORY_archive.md", "LESSONS_archive.md", "_search_index.md" };
        bool isGrowthFile = IsGrowthKnowledgeFile(file);
        if (!allowed.Contains(file, StringComparer.OrdinalIgnoreCase) && !isGrowthFile)
            throw new InvalidOperationException("Cannot edit this knowledge file");
        string path = Path.Combine("RanParty", file);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return new JsonObject { ["updated"] = true, ["file"] = file };
    }

    private static bool IsGrowthKnowledgeFile(string file) =>
        file.StartsWith("Characters/", StringComparison.OrdinalIgnoreCase)
        && file.EndsWith("_growth.md", StringComparison.OrdinalIgnoreCase)
        && !file.Contains("..")
        && file.Split('/', '\\').All(part => !string.IsNullOrWhiteSpace(part));

    private JsonObject KnowledgeSearch(JsonObject args)
    {
        string query = (args["query"]?.GetValue<string>() ?? "").Trim();
        if (string.IsNullOrWhiteSpace(query)) throw new InvalidOperationException("query is required");
        var results = new JsonArray();
        var files = new[] { "MEMORY.md", "LESSONS.md", "MEMORY_archive.md", "LESSONS_archive.md" };
        foreach (var file in files)
        {
            string path = Path.Combine("RanParty", file);
            if (!File.Exists(path)) continue;
            var sections = File.ReadAllText(path).Split("---", StringSplitOptions.RemoveEmptyEntries)
                .Where(s => s.Contains(query, StringComparison.OrdinalIgnoreCase)).Take(5);
            foreach (var s in sections)
                results.Add(new JsonObject { ["file"] = file, ["snippet"] = s.Length > 300 ? s[..300] + "..." : s });
        }
        return new JsonObject { ["results"] = results };
    }

    private JsonObject PreviewPath(JsonObject args)
    {
        string path = Path.GetFullPath(RequiredString(args, "path"));
        if (!_config.InWhitelist(path)) throw new InvalidOperationException("路径不在工作区白名单内");
        if (!File.Exists(path)) throw new FileNotFoundException("文件不存在", path);
        var info = new FileInfo(path);
        string extension = info.Extension.ToLowerInvariant();
        string kind = extension switch
        {
            ".html" or ".htm" => "html",
            ".md" or ".markdown" => "markdown",
            ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".bmp" or ".svg" => "image",
            ".pdf" => "pdf",
            ".txt" or ".json" or ".jsonl" or ".csv" or ".log" or ".xml" or ".yaml" or ".yml" or ".cs" or ".ts" or ".tsx" or ".js" or ".jsx" or ".css" or ".py" or ".ps1" or ".sh" => "text",
            _ => "unsupported"
        };
        var result = new JsonObject
        {
            ["path"] = path,
            ["name"] = info.Name,
            ["extension"] = extension,
            ["size"] = info.Length,
            ["lastWrite"] = info.LastWriteTime.ToString("O"),
            ["kind"] = kind
        };
        const long previewLimit = 10 * 1024 * 1024;
        if (info.Length > previewLimit)
        {
            result["kind"] = "too_large";
            result["limit"] = previewLimit;
            return result;
        }
        if (kind is "html" or "markdown" or "text") result["content"] = File.ReadAllText(path);
        if (kind is "image" or "pdf")
        {
            string mime = extension switch
            {
                ".jpg" or ".jpeg" => "image/jpeg",
                ".gif" => "image/gif",
                ".webp" => "image/webp",
                ".bmp" => "image/bmp",
                ".svg" => "image/svg+xml",
                ".pdf" => "application/pdf",
                _ => "image/png"
            };
            result["dataUrl"] = $"data:{mime};base64,{Convert.ToBase64String(File.ReadAllBytes(path))}";
        }
        return result;
    }

    private JsonObject SettingsJson()
    {
        var profiles = new JsonArray();
        foreach (var profile in _config.Profiles)
        {
            profiles.Add(new JsonObject
            {
                ["name"] = profile.Name,
                ["baseUrl"] = profile.BaseUrl,
                ["model"] = profile.Model,
                ["characterCard"] = profile.CharacterCard,
                ["characterDisplayName"] = DisplayName(profile),
                ["provider"] = profile.Provider,
                ["wireProtocol"] = profile.WireProtocol,
                ["supportsTools"] = profile.SupportsTools,
                ["supportsImages"] = profile.SupportsImages,
                ["supportsReasoning"] = profile.SupportsReasoning,
                ["contextWindow"] = profile.ContextWindow,
                ["maxOutputTokens"] = profile.MaxOutputTokens,
                ["apiKeyConfigured"] = !string.IsNullOrWhiteSpace(profile.ApiKey)
            });
        }
        return new JsonObject
        {
            ["activeProfileName"] = _config.ActiveProfileName,
            ["profiles"] = profiles,
            ["ioRoots"] = _config.IoRoots,
            ["shellMode"] = _config.ShellMode,
            ["contextWindow"] = _config.ContextWindow,
            ["compactThreshold"] = _config.CompactThreshold
        };
    }

    private JsonObject SessionJson(BackendSession session)
    {
        var messages = new JsonArray();
        foreach (var message in session.Messages)
        {
            string role = message?["role"]?.GetValue<string>() ?? "";
            if (role == "system") continue;
            messages.Add(message?.DeepClone());
        }
        var profile = FindProfile(session.ProfileName);
        return new JsonObject
        {
            ["id"] = session.Id,
            ["title"] = session.Title,
            ["workspace"] = session.Workspace,
            ["profileName"] = session.ProfileName,
            ["model"] = session.Model,
            ["displayName"] = DisplayName(profile),
            ["mode"] = session.Mode,
            ["goal"] = string.IsNullOrWhiteSpace(session.GoalText) ? null : new JsonObject { ["text"] = session.GoalText, ["status"] = session.GoalStatus },
            ["approvalMode"] = session.ApprovalMode,
            ["tokensIn"] = session.TokensIn,
            ["tokensOut"] = session.TokensOut,
            ["contextWindow"] = session.ContextWindow > 1000 ? session.ContextWindow : profile.ContextWindow > 1000 ? profile.ContextWindow : _config.ContextWindow,
            ["lastInputTokens"] = session.LastInputTokens,
            ["contextTokens"] = session.ContextTokens,
            ["lastActive"] = session.LastActive.ToString("O"),
            ["busy"] = session.Busy,
            ["messages"] = messages
        };
    }

    private void EnsureL0(BackendSession session)
    {
        if (session.L0Loaded) return;
        var profile = FindProfile(session.ProfileName);
        string soul = string.IsNullOrWhiteSpace(profile.CharacterCard)
            ? Path.Combine("RanParty", "SOUL.md")
            : Path.Combine("RanParty", "Characters", profile.CharacterCard + ".md");
        if (!File.Exists(soul)) soul = Path.Combine("RanParty", "SOUL.md");
        var sections = new[] { soul, Path.Combine("RanParty", "AGENTS.md"), Path.Combine("RanParty", "TOOL.md"), Path.Combine("RanParty", "HUB.md") };
        var text = string.Join("\n\n", sections.Where(File.Exists).Select(File.ReadAllText));

        // Inject evolution files
        var evolutionFiles = new[] { "MEMORY.md", "LESSONS.md", "_search_index.md" };
        var evolutionText = new StringBuilder();
        foreach (var f in evolutionFiles)
        {
            string p = Path.Combine("RanParty", f);
            if (File.Exists(p)) evolutionText.AppendLine(File.ReadAllText(p));
        }
        if (evolutionText.Length > 0) text += "\n\n" + evolutionText;

        // Inject character growth
        string growthPath = Path.Combine("RanParty", "Characters", profile.CharacterCard + "_growth.md");
        if (string.IsNullOrWhiteSpace(profile.CharacterCard)) growthPath = Path.Combine("RanParty", "Characters", "SOUL_growth.md");
        if (File.Exists(growthPath)) text += "\n\n[成长轨迹]\n" + File.ReadAllText(growthPath);
        text += $"\n\n[当前会话工作区]: {session.Workspace}\n生成文件请优先写入此工作区并使用绝对路径。";
        text += "\n\n[协作规则]\n当任务可拆成边界清晰的独立子任务时，可调用 delegate_agent 并选择合适的模型配置；主 Agent 始终负责最终判断与答复。不要把同一个任务无意义地重复委派。使用工具后，最终答复应简要总结完成事项、关键结果、文件改动和未解决风险。";
        session.Messages.Insert(0, new JsonObject { ["role"] = "system", ["content"] = text });
        session.L0Loaded = true;
    }

    private void RemoveSystemMessage(BackendSession session)
    {
        if (session.Messages.Count > 0 && session.Messages[0]?["role"]?.GetValue<string>() == "system")
            session.Messages.RemoveAt(0);
    }

    private void Save(BackendSession session) => _store.Save(session.Id, session.Messages.Where(message => !ReferenceEquals(message, session.TransientSkillMessage)).ToList(), new SessionMeta
    {
        Workspace = session.Workspace,
        Model = session.Model,
        ProfileName = session.ProfileName,
        Title = session.Title,
        ApprovalMode = session.ApprovalMode,
        Mode = session.Mode,
        GoalText = session.GoalText,
        GoalStatus = session.GoalStatus,
        TokensIn = session.TokensIn,
        TokensOut = session.TokensOut,
        ContextTokens = session.ContextTokens,
        ContextThreshold = session.ContextThreshold,
        ContextWindow = session.ContextWindow,
        LastActive = session.LastActive
    });

    private static string NormalizeSessionMode(string? value) => value is "plan" or "ask" or "goal" ? value : "default";
    private static string NormalizeGoalStatus(string? value) => value is "complete" or "blocked" ? value : "active";

    private static string ModeNotice(BackendSession session) => session.Mode switch
    {
        "plan" => "已切换到 Plan 模式：本轮只输出计划，不执行工具或本地副作用。",
        "ask" => "已切换到 Ask 模式：仅回答问题，不调用工具、不写文件。",
        "goal" => string.IsNullOrWhiteSpace(session.GoalText)
            ? "已切换到 Goal 模式：将围绕持久目标推进。"
            : $"已切换到 Goal 模式：{session.GoalText}",
        _ => "已切换到默认模式：可以在审批约束下使用工具完成任务。"
    };

    private static void ApplyModePrompt(BackendSession session, List<JsonNode> context)
    {
        if (session.Mode == "plan")
            context.Add(new JsonObject { ["role"] = "system", ["content"] = "当前是 Plan 模式。只输出清晰计划、风险、验收方式和需要用户确认的点。不要调用工具，不要声称已经执行任何本地或外部操作。" });
        else if (session.Mode == "ask")
            context.Add(new JsonObject { ["role"] = "system", ["content"] = "当前是 Ask 模式。只回答用户问题，不调用工具，不写文件，不委派子 Agent，不执行任何本地副作用。" });
        else if (session.Mode == "goal" && !string.IsNullOrWhiteSpace(session.GoalText))
            context.Add(new JsonObject { ["role"] = "system", ["content"] = $"当前是 Goal 模式。会话目标：{session.GoalText}。目标状态：{session.GoalStatus}。围绕目标推进，并在需要时说明进度与阻塞。" });
    }

    private static string ConnectorConfigPath => Path.GetFullPath(Path.Combine("Config", "connectors.json"));

    private JsonObject ListConnectors()
    {
        return new JsonObject { ["connectors"] = LoadConnectors() };
    }

    private JsonObject SaveConnector(JsonObject args)
    {
        var connector = (args["connector"] as JsonObject)?.DeepClone() as JsonObject
            ?? throw new InvalidOperationException("缺少 connector 配置");
        string id = connector["id"]?.GetValue<string>() ?? "";
        if (string.IsNullOrWhiteSpace(id)) connector["id"] = "mcp_" + Guid.NewGuid().ToString("N")[..10];
        if (string.IsNullOrWhiteSpace(connector["name"]?.GetValue<string>() ?? "")) throw new InvalidOperationException("连接器名称不能为空");
        string type = connector["type"]?.GetValue<string>() ?? "stdio";
        if (type is not "stdio" and not "http") throw new InvalidOperationException("连接器类型必须是 stdio 或 http");
        connector["status"] = IsConnectorConfigured(connector) ? "disconnected" : "not_configured";
        var connectors = LoadConnectors();
        string connectorId = connector["id"]!.GetValue<string>();
        var next = new JsonArray();
        bool replaced = false;
        foreach (var item in connectors.OfType<JsonObject>())
        {
            if (string.Equals(item["id"]?.GetValue<string>(), connectorId, StringComparison.Ordinal))
            {
                next.Add(connector);
                replaced = true;
            }
            else next.Add(item.DeepClone());
        }
        if (!replaced) next.Add(connector);
        PersistConnectors(next);
        return new JsonObject { ["connector"] = connector.DeepClone(), ["connectors"] = next.DeepClone() };
    }

    private JsonObject DeleteConnector(JsonObject args)
    {
        string id = RequiredString(args, "id");
        var next = new JsonArray(LoadConnectors().OfType<JsonObject>()
            .Where(item => !string.Equals(item["id"]?.GetValue<string>(), id, StringComparison.Ordinal))
            .Select(item => item.DeepClone()).ToArray());
        PersistConnectors(next);
        return new JsonObject { ["connectors"] = next };
    }

    private JsonObject TestConnector(JsonObject args)
    {
        var connector = (args["connector"] as JsonObject) ?? FindConnector(RequiredString(args, "id"));
        bool configured = IsConnectorConfigured(connector);
        return new JsonObject
        {
            ["ok"] = configured,
            ["status"] = configured ? "disconnected" : "not_configured",
            ["message"] = configured
                ? "配置格式有效。首版为安全起见只做配置校验和工具发现占位，实际 MCP 进程调用需在启用工具 allowlist 后接入。"
                : "连接器缺少必要字段：stdio 需要 command，http 需要 url。"
        };
    }

    private JsonObject ConnectorTools(JsonObject args)
    {
        var connector = FindConnector(RequiredString(args, "id"));
        var enabled = connector["enabledTools"] as JsonArray ?? new JsonArray();
        return new JsonObject
        {
            ["connectorId"] = connector["id"]?.GetValue<string>() ?? "",
            ["tools"] = new JsonArray(enabled.Select(item => (JsonNode?)new JsonObject
            {
                ["name"] = item?.GetValue<string>() ?? "",
                ["enabled"] = true,
                ["approvalMode"] = connector["approvalMode"]?.GetValue<string>() ?? "ask"
            }).ToArray())
        };
    }

    private static JsonArray LoadConnectors()
    {
        try
        {
            if (!File.Exists(ConnectorConfigPath)) return new JsonArray();
            return JsonNode.Parse(File.ReadAllText(ConnectorConfigPath)) as JsonArray ?? new JsonArray();
        }
        catch { return new JsonArray(); }
    }

    private static void PersistConnectors(JsonArray connectors)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ConnectorConfigPath)!);
        File.WriteAllText(ConnectorConfigPath, connectors.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private static JsonObject FindConnector(string id)
    {
        return LoadConnectors().OfType<JsonObject>()
            .FirstOrDefault(item => string.Equals(item["id"]?.GetValue<string>(), id, StringComparison.Ordinal))
            ?? throw new InvalidOperationException("连接器不存在");
    }

    private static bool IsConnectorConfigured(JsonObject connector)
    {
        string type = connector["type"]?.GetValue<string>() ?? "stdio";
        return type == "http"
            ? !string.IsNullOrWhiteSpace(connector["url"]?.GetValue<string>())
            : !string.IsNullOrWhiteSpace(connector["command"]?.GetValue<string>());
    }

    private void WhitelistWorkspace(string workspace)
    {
        if (string.IsNullOrWhiteSpace(workspace)) return;
        string full = Path.GetFullPath(workspace);
        if (!_config.Whitelist.Contains(full, StringComparer.OrdinalIgnoreCase)) _config.Whitelist.Add(full);
    }

    private BackendSession GetSession(JsonObject args)
    {
        string id = RequiredString(args, "sessionId");
        return _sessions.TryGetValue(id, out var session) ? session : throw new InvalidOperationException("会话不存在");
    }

    private ModelProfile FindProfile(string? name) =>
        _config.Profiles.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.Ordinal)) ?? _config.ActiveProfile;

    /// <summary>Replace image_url blocks with text placeholders for non-vision models</summary>
    private static void StripImagesFromContext(List<JsonNode> messages)
    {
        foreach (var message in messages)
        {
            if (message?["content"] is not JsonArray parts) continue;
            var textOnly = new JsonArray();
            foreach (var part in parts)
            {
                string type = part?["type"]?.GetValue<string>() ?? "";
                if (type == "image_url")
                {
                    // Extract filename hint from URL for better context
                    string hint = part?["image_url"]?["url"]?.GetValue<string>() ?? "";
                    if (hint.StartsWith("data:")) hint = "[图片]";
                    else if (hint.Length > 60) hint = "[图片: " + hint[..60] + "...]";
                    textOnly.Add(new JsonObject { ["type"] = "text", ["text"] = hint });
                }
                else
                    textOnly.Add(part?.DeepClone());
            }
            message["content"] = textOnly;
        }
    }

    private static List<JsonNode> ContextMessages(BackendSession session) => session.Messages
        .Where(message => message?["role"]?.GetValue<string>() != "event" && message?["context_excluded"]?.GetValue<bool>() != true)
        .Select(message => message.DeepClone())
        .ToList();

    private static int EstimateContextTokens(IEnumerable<JsonNode> messages)
    {
        long characters = messages.Sum(message => (long)message.ToJsonString().Length);
        return (int)Math.Clamp((characters + 2) / 3, 0, int.MaxValue);
    }

    private int EffectiveContextWindow(BackendSession session)
    {
        var profile = FindProfile(session.ProfileName);
        return session.ContextWindow > 1000 ? session.ContextWindow : profile.ContextWindow > 1000 ? profile.ContextWindow : _config.ContextWindow;
    }

    private int EffectiveCompactThreshold(BackendSession session) =>
        session.ContextThreshold is > 0 and <= 100 ? session.ContextThreshold : _config.CompactThreshold;

    private static string FormatTokenCount(int value) => value >= 1000
        ? $"{value / 1000d:0.#}K"
        : value.ToString();

    private static string SafeSkillFolderName(string value)
    {
        string safe = new(value.Trim().ToLowerInvariant().Select(ch => char.IsLetterOrDigit(ch) || ch == '-' ? ch : '-').ToArray());
        safe = safe.Trim('-');
        if (string.IsNullOrWhiteSpace(safe) || safe.Length > 64) throw new InvalidOperationException("Skill 名称无法转换为安全目录名");
        return safe;
    }

    private static bool IsInsidePath(string root, string path)
    {
        string normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string normalizedPath = Path.GetFullPath(path);
        return normalizedPath.Equals(normalizedRoot, StringComparison.OrdinalIgnoreCase)
            || normalizedPath.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildCompactionTranscript(IEnumerable<JsonNode> messages)
    {
        var builder = new StringBuilder("请压缩以下会话。只输出摘要正文。\n\n");
        foreach (var message in messages)
        {
            string role = message?["role"]?.GetValue<string>() ?? "unknown";
            builder.Append("## ").Append(role).Append('\n');
            JsonNode? content = message?["content"];
            if (content is JsonValue) builder.Append(content.GetValue<string>());
            else if (content is JsonArray parts)
            {
                foreach (var part in parts)
                {
                    string type = part?["type"]?.GetValue<string>() ?? "";
                    if (type == "text") builder.Append(part?["text"]?.GetValue<string>() ?? "");
                    else if (type == "image_url") builder.Append("[图片附件]");
                }
            }
            if (message?["tool_calls"] is JsonArray calls)
                builder.Append("\n[工具调用] ").Append(calls.ToJsonString());
            builder.Append("\n\n");
        }
        return builder.ToString();
    }

    private const string CompactionPrompt = """
你是会话上下文压缩器。把完整对话压缩为可供另一个模型无缝继续工作的结构化摘要。
必须忠实保留：用户目标与偏好、已经确认的决定、关键事实与约束、重要文件/路径/标识符、已执行操作及结果、错误与未解决问题、当前工作状态、明确的下一步。
区分事实、推断与未验证信息。不要回答原始问题，不要添加新建议，不要虚构内容，不要保留寒暄或重复表述。
使用简洁 Markdown，优先采用"目标、约束、已完成、关键上下文、待办、风险"结构。摘要必须自包含，允许任何兼容模型继续会话。
""";

    private bool IsSessionAllowed(string sessionId, string command)
    {
        if (!_sessionAllows.TryGetValue(sessionId, out var allowed)) return false;
        lock (allowed) return allowed.Contains(command.Trim());
    }

    private static string DisplayName(ModelProfile profile)
    {
        string fallback = string.IsNullOrWhiteSpace(profile.CharacterCard) ? "SOUL" : Path.GetFileNameWithoutExtension(profile.CharacterCard);
        string path = string.IsNullOrWhiteSpace(profile.CharacterCard)
            ? Path.Combine("RanParty", "SOUL.md")
            : Path.Combine("RanParty", "Characters", profile.CharacterCard + ".md");
        return CharacterTitle(path, fallback);
    }

    private static string CharacterTitle(string path, string fallback)
    {
        try
        {
            if (File.Exists(path))
                foreach (var line in File.ReadLines(path).Take(80))
                    if (line.StartsWith("# ", StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(line[2..])) return line[2..].Trim();
        }
        catch { }
        return fallback;
    }

    private static int CountColdEntries()
    {
        int count = 0;
        foreach (var file in new[] { "LESSONS_archive.md", "MEMORY_archive.md" })
        {
            string path = Path.Combine("RanParty", file);
            if (File.Exists(path))
                count += File.ReadAllText(path).Split("---", StringSplitOptions.RemoveEmptyEntries).Length;
        }
        return count;
    }

    private static int DaysSinceCuratorLastRun()
    {
        string statePath = Path.Combine("RanParty", ".curator_state");
        if (!File.Exists(statePath)) return 999;
        try
        {
            var state = JsonNode.Parse(File.ReadAllText(statePath)) as JsonObject;
            if (state?["last_run"]?.GetValue<DateTime>() is DateTime last)
                return (int)(DateTime.Now - last).TotalDays;
        }
        catch { }
        return 999;
    }

    private static string ToolCategory(string name) => name switch
    {
        "web_search" or "web_search_cached" or "web_fetch" or "web_fetch_cached" => "search",
        "shell_run" or "ps_run" => "shell",
        "file_write" or "file_append" or "file_replace" or "file_move" or "file_delete" or "file_write_excel" or "file_write_docx" or "file_batch" => "file_write",
        _ => "other"
    };

    /// <summary>递归排序 JSON 属性键，确保相同语义的 JSON 产生一致签名</summary>
    private static string NormalizeJson(JsonNode? node)
    {
        if (node is null) return "null";
        if (node is JsonValue val) return val.ToJsonString();
        if (node is JsonArray arr)
        {
            var items = arr.Select(NormalizeJson);
            return "[" + string.Join(",", items) + "]";
        }
        if (node is JsonObject obj)
        {
            var sorted = obj.OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => $"\"{kv.Key}\":{NormalizeJson(kv.Value)}");
            return "{" + string.Join(",", sorted) + "}";
        }
        return node.ToJsonString();
    }

    private static bool IsRetryableApiError(Exception ex)
    {
        string msg = ex.Message;
        // HTTP 429 (Rate Limit), 5xx (Server Error), and transient network failures
        return msg.Contains("HTTP 429") || msg.Contains("HTTP 5")
            || msg.Contains("请求失败") && (msg.Contains("超时") || msg.Contains("连接"))
            || ex is HttpRequestException or TaskCanceledException or IOException;
    }

    private static bool IsShellTool(string name) => name is "shell_run" or "ps_run" or "open_url" or "open_path";
    private static bool IsWriteTool(string name) => name is "file_write" or "file_append" or "file_replace" or "file_write_excel" or "file_write_docx" or "file_move";
    private static string ExtractPath(string tool, JsonNode args) => tool == "file_move" ? args?["dst"]?.GetValue<string>() ?? "" : args?["path"]?.GetValue<string>() ?? "";
    private string UserSuffix() => string.IsNullOrEmpty(_config.UserSuffix) ? "" : "\n" + _config.UserSuffix;
    private static string FallbackTitle(string text) => string.IsNullOrWhiteSpace(text) ? "新会话" : (text.Length > 18 ? text[..18] + "…" : text);
    private static string SafeCharacterName(string name)
    {
        if (name.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '-' or '_'))) throw new InvalidOperationException("角色卡名称只能包含字母、数字、- 和 _");
        return name;
    }

    private static string CharacterPath(string name) => name == "SOUL"
        ? Path.Combine("RanParty", "SOUL.md")
        : Path.Combine("RanParty", "Characters", name + ".md");

    private static string RequiredString(JsonObject args, string key) =>
        args[key]?.GetValue<string>() is { Length: > 0 } value ? value : throw new InvalidOperationException($"缺少参数: {key}");
    private static string StringArg(JsonObject args, string key, string fallback) => args[key]?.GetValue<string>() ?? fallback;
    private static bool BoolArg(JsonObject args, string key, bool fallback) => args[key] is JsonValue value && value.TryGetValue<bool>(out var parsed) ? parsed : fallback;
    private static int IntArg(JsonObject args, string key, int fallback, int min, int max) => args[key] is JsonValue value && value.TryGetValue<int>(out var parsed) ? Math.Clamp(parsed, min, max) : fallback;
    private static List<string> StringArrayArg(JsonObject args, string key) =>
        args[key] is JsonArray values ? values.Select(value => value?.GetValue<string>() ?? "").Where(value => value.Length > 0).ToList() : new List<string>();
    private static void ValidateProfileName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.IndexOfAny(['|', '\r', '\n']) >= 0)
            throw new InvalidOperationException("配置名称不能为空且不能包含 | 或换行");
    }

    private void Respond(string id, JsonNode result) => Write(new JsonObject { ["type"] = "response", ["id"] = id, ["result"] = result });
    private void RespondError(string id, string message) => Write(new JsonObject { ["type"] = "response", ["id"] = id, ["error"] = message });
    private void Emit(string eventName, JsonNode? data) => Write(new JsonObject { ["type"] = "event", ["event"] = eventName, ["data"] = data });
    private void Write(JsonObject message)
    {
        lock (_writeLock)
        {
            _output.WriteLine(message.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
            _output.Flush();
        }
    }
}

internal sealed class BackendSession
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "新会话";
    public string Workspace { get; set; } = "";
    public string ProfileName { get; set; } = "";
    public string Model { get; set; } = "";
    public string ApprovalMode { get; set; } = "ask";
    public string Mode { get; set; } = "default";
    public string GoalText { get; set; } = "";
    public string GoalStatus { get; set; } = "active";
    public int TokensIn { get; set; }
    public int TokensOut { get; set; }
    public int LastInputTokens { get; set; }
    public int ContextTokens { get; set; }
    public int ContextThreshold { get; set; }
    public int ContextWindow { get; set; }
    public DateTime LastActive { get; set; } = DateTime.Now;
    public bool Busy { get; set; }
    public bool L0Loaded { get; set; }
    public JsonNode? Plan { get; set; }
    public List<JsonNode> Messages { get; set; } = new();
    public CancellationTokenSource? Cancellation { get; set; }
    public JsonNode? TransientSkillMessage { get; set; }
    public int? _turnCount { get; set; }
    public int? _turnDepth { get; set; }
}

internal sealed record MarketplaceSkillInfo(string Id, string Name, string Description, string PluginName, string Marketplace, string Publisher, string Category, string Version, string SkillPath);

internal sealed class PendingApproval
{
    public TaskCompletionSource<ApprovalDecision> Source { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed record ApprovalDecision(string Action, string Feedback);

internal sealed class PendingClarification
{
    public TaskCompletionSource<ClarificationAnswer> Source { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed record ClarificationAnswer(string Text, List<string> Selection);

internal sealed class ToolLoopState
{
    public int TotalCalls { get; set; }
    public int DuplicateBlocks { get; set; }
    public bool ForceFinal { get; set; }
    public Dictionary<string, int> Signatures { get; } = new(StringComparer.Ordinal);
    // 同类工具预算：防止交替调用绕过重复检测
    public Dictionary<string, int> CategoryCalls { get; } = new(StringComparer.Ordinal);
}

internal sealed record ToolPlanItem(JsonNode Call, string ToolName, string ArgsText, JsonNode ToolArgs, string Signature, int Repeated, bool ParallelSafe, string AgentName, bool CategoryExceeded, bool ParseError);
internal sealed record ToolPlanResult(ToolResult Result, string RejectReason = "", long DurationMs = 0);
