using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using RanParty.Core;

namespace RanParty.Cats;

public class ShellCat : Cat
{
    private static readonly IntPtr JobObject = CreateJobObject(IntPtr.Zero, null);
    // 路径白名单由 Job Object 沙箱 (KILL_ON_JOB_CLOSE + ACTIVE_PROCESS=1) 覆盖，ps_run/shell_run 无法预知文件操作目标。

    private static JOBOBJECT_EXTENDED_LIMIT_INFORMATION CreateLimits()
    {
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = 0x2000 /*JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE*/ | 0x10 /*JOB_OBJECT_LIMIT_ACTIVE_PROCESS*/;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        return limits;
    }

    private static readonly IntPtr LimitsPtr = Marshal.AllocHGlobal(Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());

    static ShellCat()
    {
        var limits = CreateLimits();
        Marshal.StructureToPtr(limits, LimitsPtr, false);
        SetInformationJobObject(JobObject, 2 /*JobObjectExtendedLimitInformation*/, LimitsPtr, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr info, uint infoLen);
    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    }

    Config _cfg;
    public ShellCat(Config cfg) { _cfg = cfg;
        Name = "ShellCat";
        Add("shell_run", "在 cmd.exe 中执行命令（cmd /c）。高风险：可任意操作本机。用户会确认后执行。返回 [exit code] + stdout + stderr。",
            "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"},\"workdir\":{\"type\":\"string\"},\"timeout\":{\"type\":\"integer\"}},\"required\":[\"command\"]}");
        Add("ps_run", "在 PowerShell 中执行命令（-NoProfile -Command）。高风险：可任意操作本机。用户会确认后执行。返回 [exit code] + stdout + stderr。",
            "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"},\"workdir\":{\"type\":\"string\"},\"timeout\":{\"type\":\"integer\"}},\"required\":[\"command\"]}");
        Add("open_url", "用系统默认浏览器打开 http/https URL。",
            "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}");
        Add("open_path", "用系统默认程序打开文件/文件夹（如 .html 用默认浏览器打开）。路径必须在白名单内（工作区/CatTemp/RanParty/QQBot）。",
            "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},\"required\":[\"path\"]}");
    }

    public override ToolResult Execute(string tool, JsonNode args)
    {
        string S(string k) => args?[k]?.GetValue<string>() ?? "";
        int I(string k) => args?[k]?.GetValue<int>() ?? 0;
        try
        {
            return tool switch
            {
                "shell_run" => Run("cmd.exe", "/c " + S("command"), S("workdir"), I("timeout")),
                "ps_run" => Run("powershell.exe", "-NoProfile -Command " + S("command"), S("workdir"), I("timeout")),
                "open_url" => OpenUrl(S("url")),
                "open_path" => OpenPath(S("path")),
                _ => new ToolResult { Content = "ShellCat 未知工具: " + tool, IsError = true }
            };
        }
        catch (Exception ex) { return new ToolResult { Content = "ERR " + ex.Message, IsError = true }; }
    }

    ToolResult Run(string exe, string args, string workdir, int timeoutSec)
    {
        if (string.IsNullOrWhiteSpace(workdir)) workdir = Environment.CurrentDirectory;
        if (!System.IO.Directory.Exists(workdir)) return new ToolResult { Content = $"ERR workdir 不存在: {workdir}", IsError = true };
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            WorkingDirectory = workdir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        using var p = Process.Start(psi);
        if (p == null) return new ToolResult { Content = "ERR 启动进程失败", IsError = true };
        AssignProcessToJobObject(JobObject, p.Handle);
        var tOut = p.StandardOutput.ReadToEndAsync();
        var tErr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(60000))
        {
            try { p.Kill(true); } catch { }
            return new ToolResult { Content = $"命令超时（60 秒）。stdout:\n{TruncateOutput(tOut.Result)}\n\nstderr:\n{TruncateOutput(tErr.Result)}", IsError = true };
        }
        var sb = new StringBuilder();
        sb.Append("[exit ").Append(p.ExitCode).Append("]\n");
        if (!string.IsNullOrEmpty(tOut.Result)) sb.Append("stdout:\n").Append(TruncateOutput(tOut.Result)).Append("\n");
        if (!string.IsNullOrEmpty(tErr.Result)) sb.Append("stderr:\n").Append(TruncateOutput(tErr.Result)).Append("\n");
        return new ToolResult { Content = sb.ToString() };
    }

    ToolResult OpenUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return new ToolResult { Content = "ERR url 为空", IsError = true };
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return new ToolResult { Content = "ERR 仅允许 http/https URL", IsError = true };
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        return new ToolResult { Content = "OK 已打开: " + url };
    }

    ToolResult OpenPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return new ToolResult { Content = "ERR path 为空", IsError = true };
        if (!_cfg.InWhitelist(path)) return new ToolResult { Content = $"ERR 路径不在白名单内: {path}", IsError = true };
        if (!System.IO.File.Exists(path) && !System.IO.Directory.Exists(path))
            return new ToolResult { Content = $"ERR 路径不存在: {path}", IsError = true };
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        return new ToolResult { Content = "OK 已用默认程序打开: " + path };
    }

    static string TruncateOutput(string value) => (value ?? "").Length <= 16384 ? (value ?? "") : value.Substring(value.Length - 16384);
}
