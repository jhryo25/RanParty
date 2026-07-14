# 附件与桌面宠物

## 设计选择

RanParty 采用“渲染层预检 + C# 后端复检 + 本地提取”的附件链路。它吸收 Hermes Context References 的内联附加上下文、硬上限、二进制检测和非可信数据边界，但适配桌面拖放：文件内容通过固定 IPC 传给后端，不依赖模型自行读取临时路径，也不把 Base64 当作文本 Token。

参考：

- [Hermes Context References](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-references)
- [Hermes Discord 附件处理](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/messaging/discord.md)
- `RanParty/skills/hatch-pet/references/codex-pet-contract.md`

## 使用附件

可在已有会话发言栏或新任务页执行以下操作：

1. 将文件拖入输入区域。
2. 从剪贴板粘贴图片或文件。
3. 点击图片按钮选择图片，或点击文件按钮选择文档。
4. 在预览条确认文件名并发送；非图片附件显示文件图标。

拖入文件进入可接收区域后会显示明确的落点反馈；松开前不会读取文件。新任务页和已有会话使用相同的数量、单文件大小与总大小校验。

发送后，后端在本机提取正文，将其放进本轮用户消息前的 `[RanParty 附加上下文开始/结束]` 边界。聊天记录只显示附件摘要，模型上下文仍保留提取内容。

## 支持格式

| 类别 | 扩展名 |
| --- | --- |
| 图片 | `.png .jpg .jpeg .gif .webp .bmp` |
| 文档 | `.pdf .docx .pptx` |
| 表格与数据 | `.xlsx .csv .tsv .json .jsonl .xml` |
| 文本与配置 | `.txt .md .markdown .log .html .htm .css .yaml .yml .toml .ini .cfg .env` |
| 源码 | `.js .jsx .ts .tsx .py .java .cs .go .rs .c .cpp .cc .h .hpp .sh .ps1 .sql .rb .php .swift .kt .scala .r .lua .vue .svelte` |

当前不支持旧 Office 二进制格式（`.doc .xls .ppt`）、压缩包、音视频、可执行文件和任意二进制。扫描版 PDF 若没有文字层，会返回“未包含可提取文本”；首版不内置 OCR。

## 限制与安全

- 图片：单个 5MB。
- 文档：单个 10MB。
- 每轮：最多 8 个，Base64 解码前后双重校验，原始文件合计最多 25MB。
- 提取文本：单文件最多 40,000 字符，每轮最多 100,000 字符，超限保留头尾并标明截断。
- PDF 最多提取前 200 页；PPTX 最多 200 页；XLSX 最多 20 个工作表、每表 5,000 行。
- 文本文件必须是有效 UTF-8 或带 BOM 的 UTF-16；空字节伪装的二进制会被拒绝。
- Office XML 禁用 DTD、外部实体和超大 XML 部件。
- 附件正文被标记为非可信资料，不能授予权限或覆盖系统规则。模型仍可能误判内容，敏感资料发送前应确认所用模型服务的隐私政策。

## Codex v2 宠物包

目录结构：

```text
my-pet/
├── pet.json
└── spritesheet.webp
```

清单格式：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "One short sentence.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

图集必须为透明 PNG 或 WebP，尺寸 1536×2288，网格为 8 列 × 11 行，每格 192×208。标准动画行依次为 idle、running-right、running-left、waving、jumping、failed、waiting、running、review；最后两行是 16 个顺时针观察方向。

## 安装与运行

1. 打开“设置 → 桌面宠物”。
2. 点击“安装宠物包”，选择包内的 `pet.json`。
3. 后端校验清单、路径、文件链接、大小、图片头和画布尺寸。
4. 有同 ID 包时使用暂存目录原子替换；第一个有效包会自动选择并启用。
5. 可调整显示比例、切换宠物、关闭显示或删除包。

覆盖安装同 ID 包会立即刷新预览和桌面图集；删除当前宠物时，如果仍有其他有效包，RanParty 会自动选中下一个并保持原显示开关。

宠物位置可拖动并在本机保存。单击触发招手，双击触发跳跃；任务运行、审批/澄清等待、结果完成和失败会分别映射到 running、waiting、review、failed 动画。闲置时，指针靠近会使用 v2 的 16 向观察姿态。启用系统“减少动态效果”后固定在每行首帧。

开发模式数据位于 `RanParty/Pets` 和 `Config/pets.json`。portable 版本位于可执行文件旁的 `RanPartyData/RanParty/Pets` 与 `RanPartyData/Config/pets.json`。

## hatch-pet Skill

内置 Skill 位于 `RanParty/skills/hatch-pet`，保留 Codex v2 的 9 行标准动画、16 向观察、确定性拼图、去色边、校验和 QA 流程。使用前需要：

- 可调用的图像生成 MCP 工具；Skill 中的 `$imagegen` 在 RanParty 内指该工具。
- Python 3 及脚本报告的图像处理依赖。
- 足够的生成预算；完整流程最多包含基础形象、标准动画行和观察方向行等多次生成。

最终包输出到运行目录的 `package/<pet-id>/`，再通过设置页安装。RanParty 不直接把 Skill 生成物写入应用数据，也不会绕过安装校验。

## 故障排查

- “格式不受支持”：确认扩展名在支持列表中；只改扩展名不会绕过后端解析。
- “不是有效的 base64 data URL”：文件在 IPC 传输前已损坏，重新选择或拖入。
- PDF 没有正文：通常是扫描件或加密文件；当前需先在外部完成 OCR/解密。
- 宠物图集尺寸错误：只接受 v2 的 1536×2288；1536×1872 是中间 v1/8×9 图集，不能安装。
- 宠物不显示：确认已选择宠物、打开“显示桌面宠物”，并检查图集能否被 Chromium 解码。
- `hatch-pet` 找不到 `$imagegen`：先在“设置 → 连接器”接入并启用一个图像生成 MCP 工具。
- portable 显示“无法连接本地后端”：先点击“重新连接”；若仍失败，点击“打开诊断日志”。日志位于 EXE 旁的 `RanPartyData/Log/backend-startup.log`，应用会保留一个轮换的上一份日志，不会无限增长。
