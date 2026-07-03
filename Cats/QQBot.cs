using System;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

using RanParty.Core;
namespace RanParty.Cats;

public class QQBot
{
    Config _cfg;
    Logger _log;
    string _token;
    string _gateway;
    ClientWebSocket _ws;
    int _seq = 0;
    CancellationTokenSource _cts;

    // 收到群@消息：group_openid, content, msg_id
    public Action<string, string, string> OnGroupMessage;
    // 收到C2C消息：user_openid, content, msg_id
    public Action<string, string, string> OnC2CMessage;

    public QQBot(Config cfg, Logger log) { _cfg = cfg; _log = log; }

    public async Task Start()
    {
        _cts = new CancellationTokenSource();
        try
        {
            await GetAccessToken();
            await GetGateway();
            _ = RunWs(_cts.Token);
            _log.Log("QQBot 启动");
        }
        catch (Exception ex) { _log.Err("QQBot 启动失败: " + ex.Message); }
    }

    async Task GetAccessToken()
    {
        using var http = new HttpClient();
        var body = new JsonObject { ["appId"] = _cfg.QqAppid, ["clientSecret"] = _cfg.QqSecret };
        var resp = await http.PostAsync("https://bots.qq.com/app/getAppAccessToken",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
        _token = json?["access_token"]?.GetValue<string>() ?? "";
        if (string.IsNullOrEmpty(_token)) throw new Exception("access_token 为空");
    }

    async Task GetGateway()
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("QQBot", _token);
        var resp = await http.GetAsync("https://api.sgroup.qq.com/gateway");
        var json = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
        _gateway = json?["url"]?.GetValue<string>() ?? "";
        if (string.IsNullOrEmpty(_gateway)) throw new Exception("gateway url 为空");
    }

    async Task RunWs(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _ws = new ClientWebSocket();
                await _ws.ConnectAsync(new Uri(_gateway), ct);
                await ReceiveLoop(ct);
            }
            catch (Exception ex) { _log.Err("QQBot WS 异常: " + ex.Message); }
            await Task.Delay(3000, ct);
        }
    }

    async Task ReceiveLoop(CancellationToken ct)
    {
        var buf = new byte[8192];
        var sb = new StringBuilder();
        while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult r;
            do
            {
                r = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), ct);
                sb.Append(Encoding.UTF8.GetString(buf, 0, r.Count));
            } while (!r.EndOfMessage);

            string msg = sb.ToString(); sb.Clear();
            var node = JsonNode.Parse(msg);
            int op = node?["op"]?.GetValue<int>() ?? 0;
            switch (op)
            {
                case 10: // Hello
                    int interval = node["d"]?["heartbeat_interval"]?.GetValue<int>() ?? 30000;
                    await Identify();
                    _ = HeartbeatLoop(interval);
                    break;
                case 0: // Dispatch
                    _seq = node["s"]?.GetValue<int>() ?? _seq;
                    Dispatch(node["t"]?.GetValue<string>() ?? "", node["d"]);
                    break;
                case 11: break; // Heartbeat ACK
            }
        }
    }

    async Task Identify()
    {
        var id = new JsonObject
        {
            ["op"] = 2,
            ["d"] = new JsonObject
            {
                ["token"] = "QQBot " + _token,
                ["intents"] = 1 << 30,
                ["shard"] = new JsonArray { 0, 1 }
            }
        };
        await Send(id);
        _log.Log("QQBot Identify 已发送 (intents=1<<30，群/C2C 按需调整)");
    }

    async Task HeartbeatLoop(int interval)
    {
        while (_ws?.State == WebSocketState.Open)
        {
            await Task.Delay(interval);
            var hb = new JsonObject { ["op"] = 1, ["d"] = _seq == 0 ? null : (JsonNode)_seq };
            await Send(hb);
        }
    }

    async Task Send(JsonNode node)
    {
        try
        {
            if (_ws?.State == WebSocketState.Open)
            {
                var bytes = Encoding.UTF8.GetBytes(node.ToJsonString());
                await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);
            }
        }
        catch { }
    }

    void Dispatch(string t, JsonNode d)
    {
        if (d == null) return;
        if (t == "GROUP_AT_MESSAGE_CREATE")
        {
            string gid = d["group_openid"]?.GetValue<string>() ?? "";
            string content = (d["content"]?.GetValue<string>() ?? "").Trim();
            string mid = d["id"]?.GetValue<string>() ?? "";
            _log.Log($"QQ 群消息: gid={gid} content={content}");
            OnGroupMessage?.Invoke(gid, content, mid);
        }
        else if (t == "C2C_MESSAGE_CREATE")
        {
            string uid = d["author"]?["user_openid"]?.GetValue<string>() ?? "";
            string content = (d["content"]?.GetValue<string>() ?? "").Trim();
            string mid = d["id"]?.GetValue<string>() ?? "";
            _log.Log($"QQ C2C 消息: uid={uid} content={content}");
            OnC2CMessage?.Invoke(uid, content, mid);
        }
    }

    public async Task SendGroup(string groupOpenid, string content, string msgId)
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("QQBot", _token);
        var body = new JsonObject { ["content"] = content, ["msg_type"] = 0, ["msg_id"] = msgId };
        await http.PostAsync($"https://api.sgroup.qq.com/v2/groups/{groupOpenid}/messages",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
    }

    public async Task SendC2C(string openid, string content, string msgId)
    {
        using var http = new HttpClient();
        http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("QQBot", _token);
        var body = new JsonObject { ["content"] = content, ["msg_type"] = 0, ["msg_id"] = msgId };
        await http.PostAsync($"https://api.sgroup.qq.com/v2/users/{openid}/messages",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
    }
}
