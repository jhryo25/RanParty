# Codex Skill 市场接入调研（2026-07）

## 结论

Codex 当前把“可分发的 Skill”归入 **Plugin**：Skill 仍然使用 `目录/SKILL.md`，但市场分发单元是带 `.codex-plugin/plugin.json` 的 Plugin。RanParty 现有的本地 Skill 扫描与单次显式注入可以保留；市场能力应作为安装层叠加，而不应改变会话内的调用语义。

## Codex 的两层机制

1. 本地发现：Codex 从当前目录到仓库根逐级扫描 `.agents/skills`，也扫描用户级 `$HOME/.agents/skills`。Skill 文件夹可以是符号链接。来源：[Agent Skills](https://developers.openai.com/codex/skills#where-to-save-skills)。
2. 市场分发：Codex App 的 Plugins 页面和 CLI `/plugins` 浏览市场、查看详情并安装；安装后的 Plugin 可以包含 skills、MCP、apps、hooks、assets 等。来源：[Plugins](https://developers.openai.com/codex/plugins#use-and-install-plugins)。

官方示例已经从旧 `openai/skills` 迁移到 [`openai/plugins`](https://github.com/openai/plugins)。标准 Plugin 至少包含：

```text
plugin-name/
├─ .codex-plugin/plugin.json
├─ skills/
│  └─ skill-name/SKILL.md
├─ .mcp.json          # 可选
├─ .app.json          # 可选
├─ hooks.json         # 可选
└─ assets/            # 可选
```

市场索引使用 `.agents/plugins/marketplace.json`。每个条目关联一个 Plugin 来源，并声明安装策略、认证时机和分类；完整规范见 [Build plugins](https://developers.openai.com/codex/plugins/build) 与官方 [`marketplace.json` 示例](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/plugin-creator/references/plugin-json-spec.md#marketplace-json-sample-spec)。

## RanParty 推荐方案

### 第一阶段：Skill-only 市场

- 读取远程 `marketplace.json`，展示名称、作者、说明、版本、权限声明和哈希。
- 下载后先进入暂存目录，校验 SHA-256、目录穿越、文件大小和 `SKILL.md` 元数据。
- 用户确认后原子安装到 `%USERPROFILE%\.agents\skills\<name>`；工作区安装则写入 `<repo>\.agents\skills\<name>`。
- 更新时保留版本锁和来源 URL；支持禁用、卸载和回滚。
- 延续现有规则：只在用户显式选中后读取完整 `SKILL.md`，只影响下一次发送。

### 第二阶段：Codex Plugin 兼容

- 解析 `.codex-plugin/plugin.json` 和 `marketplace.json`，Skill-only Plugin 可直接安装。
- MCP、App、Hook、脚本等能力分项显示权限，不能随 Skill 静默启用。
- RanParty 暂不支持的组件应标为“不兼容”，不能假装安装成功。

### 安全边界

- 安装不等于执行；脚本、Hook、MCP 需要独立授权。
- 禁止 ZIP 路径穿越、符号链接逃逸、覆盖市场目录之外的文件。
- 市场元数据与包内容分别校验；记录来源、版本、哈希和安装时间。
- 第三方市场默认不受信任；升级时重新展示新增权限。

## 与当前实现的对应关系

RanParty 后端已经扫描仓库级和用户级 `.agents/skills`，并由后端签发 Skill ID、校验路径、按次注入 `SKILL.md`。因此接入市场只需新增“目录浏览 + 安装器 + 版本状态”，无需重写聊天注入链路。
