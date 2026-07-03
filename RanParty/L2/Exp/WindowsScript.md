# WindowsScript.md — 批处理/PowerShell/VBScript

> 版本：1.1-public | 2026-07-02
> 类别：L2-Exp

---

## 一、工具定位

Windows 环境下三种脚本语言的编码、转义、运行铁律。避免常见踩坑。

## 二、部署/接入

系统自带，无需额外安装。

## 三、核心操作

### .bat 编码铁律

- **编码：** 必须用 GBK（代码页 936），不用 UTF-8
- **换行符：** 必须用 `\r\n`（CRLF），不用 `\n`
- **特殊字符转义：**

| 字符 | 含义 | 转义写法 |
|------|------|---------|
| `\|` | 管道符 | `^\|` |
| `>` | 重定向输出 | `^>` |
| `<` | 重定向输入 | `^<` |
| `&` | 命令连接符 | `^&` |

**调试：** 末尾加 `pause` 阻止关闭；`chcp 65001 >nul` 切 UTF-8 代码页

### PowerShell 实用技巧

**静默启动：**
```powershell
Start-Process -WindowStyle Hidden -FilePath "node.exe" -ArgumentList "..."
```

**保留变量注意：** `$pid` 是只读保留变量（当前进程 PID），用 `$procId` 代替

**延迟：** WaitForInputIdle 对 cmd.exe 不适用，改用 Start-Sleep 或 FindWindow 轮询

### VBScript 注意
- VBScript **不识别 UTF-8**，需要 ANSI/ASCII
- 中文环境建议直接改用 bat（GBK）或 PowerShell

### ICO 文件手写
.NET 的 `Image.Save(path, ImageFormat.Icon)` 不会生成标准 ICO。
方案：手动构建 ICO 二进制（6字节头部 + 16字节条目 + PNG 数据体），用 `WriteAllBytes` 写出。

## 四、踩坑记录

| 问题 | 现象 | 对策 |
|------|------|------|
| bat 双击闪退 | 文件关联丢失 | `ftype batfile="%COMSPEC%" /c "%1" %*` 修复 |
| bat 中文乱码 | 文件存了 UTF-8 | 显式指定 GBK 编码写出 |
| VBScript 字符串报错 | "未结束的字符串常量" | 通常是编码问题，改用 ANSI |
| .NET Encoding.Default | Win11 可能返回 UTF-8 非 GBK | 显式用 `GetEncoding(936)` |
