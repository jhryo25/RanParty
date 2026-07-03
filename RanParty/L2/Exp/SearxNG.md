# SearxNG.md — 本地隐私搜索引擎

> 版本：1.2-public | 2026-07-02
> 类别：L2-Exp

---

## 一、工具定位

本地自建隐私搜索引擎，容器化运行，为本地 AI 搜索提供无追踪的搜索结果聚合。

**镜像：** `searxng/searxng:latest`
**默认访问：** `http://127.0.0.1:{你的端口}`

## 二、部署/接入

### Docker 部署

```bash
# 拉取镜像
docker pull searxng/searxng:latest

# 启动容器
docker run -d --name searxng -p {端口}:8080 searxng/searxng:latest

# 日常管理
docker start searxng      # 启动
docker stop searxng       # 停止
docker ps -a --filter name=searxng  # 状态检查
```

### 配置文件

配置文件位于容器内 `/etc/searxng/settings.yml`，可通过 volume 挂载到本地编辑：

```bash
docker run -d --name searxng \
  -p {端口}:8080 \
  -v /你的路径/searxng_settings.yml:/etc/searxng/settings.yml:ro \
  searxng/searxng:latest
```

## 三、核心操作

### 搜索引擎配置

在 `settings.yml` 中配置各搜索引擎的权重：

```yaml
search:
  engines:
    - name: bing
      weight: 1.0
    - name: google
      weight: 1.0
    - name: duckduckgo
      weight: 0.8
```

- 权重越高，结果排序越靠前
- 可按语言偏好调整引擎组合（中文场景推荐加入搜狗/百度）

### 与 AI 集成

SearxNG 提供 JSON API，可直接作为 AI 的 web_search 后端：

```
GET http://127.0.0.1:{端口}/search?q={查询词}&format=json
```

返回结构化搜索结果（标题/URL/摘要），无需解析 HTML。

## 四、踩坑记录

| 问题 | 原因 | 对策 |
|------|------|------|
| Docker Desktop 宕机 | WSL2 后端管道连接丢失 | 重启 Docker Desktop，等待 WSL2 恢复，再 `docker start searxng` |
| web_search 静默失败 | 容器不在线 | 优先检查 `docker ps` → 确认 Docker Desktop 正常运行 |
| 搜索结果偏少 | 某些引擎被限流 | 增加引擎数量或调整权重分散请求 |
| 中文结果不足 | 默认引擎偏向英文 | 在 settings.yml 中添加搜狗/百度等中文引擎 |

---

_版本 1.2-public | 2026-07-02 — 脱敏公开版：移除本机端口/路径/具体权重值，保留通用 Docker 部署模式。_
