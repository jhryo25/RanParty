using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using RanParty.Core;

namespace RanParty.Cats;

public class ShellCat : Cat
{
    private static readonly IntPtr JobObject = CreateJobObject(IntPtr.Zero, null);

    private static JOBOBJECT_EXTENDED_LIMIT_INFORMATION CreateLimits()
    {
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = 0x2000 /*KILL_ON_JOB_CLOSE*/ | 0x10 /*ACTIVE_PROCESS*/ | 0x100 /*WORKINGSET*/ | 0x1 /*UILIMIT_HANDLES*/;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.BasicLimitInformation.MaximumWorkingSetSize = (UIntPtr)(512 * 1024 * 1024);
        return limits;
    }

    private static readonly IntPtr LimitsPtr = Marshal.AllocHGlobal(Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());

    static ShellCat()
    {
        var limits = CreateLimits();
        Marshal.StructureToPtr(limits, LimitsPtr, false);
        SetInformationJobObject(JobObject, 2, LimitsPtr, (uint)Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>());
    }

    [DllImport("kernel32.dll")] private static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr info, uint infoLen);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

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
        Add("shell_run", "Execute command in cmd.exe (cmd /c). High risk. Returns [exit code] + stdout + stderr.",
            "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"},\"workdir\":{\"type\":\"string\"},\"timeout\":{\"type\":\"integer\"}},\"required\":[\"command\"]}");
        Add("ps_run", "Execute PowerShell (-NoProfile -Command). High risk. Returns [exit code] + stdout + stderr.",
            "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"},\"workdir\":{\"type\":\"string\"},\"timeout\":{\"type\":\"integer\"}},\"required\":[\"command\"]}");
        Add("open_url", "Open http/https URL with default browser.",
            "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}");
        Add("open_path", "Open file/dir with default program. Must be in whitelist.",
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
                "shell_run" => CheckDangerousCommand(S("command")) ?? Run("cmd.exe", "/c " + S("command"), S("workdir"), I("timeout")),
                "ps_run" => CheckDangerousCommand(S("command")) ?? Run("powershell.exe", "-NoProfile -Command " + S("command"), S("workdir"), I("timeout")),
                "open_url" => OpenUrl(S("url")),
                "open_path" => OpenPath(S("path")),
                _ => new ToolResult { Content = "ShellCat unknown tool: " + tool, Error = ErrorKind.InvalidArgument }
            };
        }
        catch (Exception ex) { return new ToolResult { Content = "ERR " + ex.Message, Error = ErrorKind.Unknown }; }
    }

    const int MaxOutputChars = 65536;

    ToolResult Run(string exe, string args, string workdir, int timeoutSec)
    {
        if (string.IsNullOrWhiteSpace(workdir)) workdir = Environment.CurrentDirectory;
        if (!Directory.Exists(workdir)) return new ToolResult { Content = "ERR workdir not found: " + workdir, Error = ErrorKind.InvalidArgument };
        var psi = new ProcessStartInfo
        {
            FileName = exe, Arguments = args, WorkingDirectory = workdir,
            UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using var p = Process.Start(psi);
        if (p == null) return new ToolResult { Content = "ERR failed to start process", Error = ErrorKind.Fatal };
        AssignProcessToJobObject(JobObject, p.Handle);

        var stdoutBuilder = new StringBuilder();
        var stderrBuilder = new StringBuilder();
        bool stdoutTruncated = false, stderrTruncated = false;
        var outTask = StreamReadAsync(p.StandardOutput, stdoutBuilder, MaxOutputChars, () => stdoutTruncated = true);
        var errTask = StreamReadAsync(p.StandardError, stderrBuilder, MaxOutputChars, () => stderrTruncated = true);

        if (!p.WaitForExit(timeoutSec > 0 ? timeoutSec * 1000 : 60000))
        {
            try { p.Kill(true); p.WaitForExit(5000); } catch { }
            try { Task.WaitAll(new Task[] { outTask, errTask }, 3000); } catch { }
            return new ToolResult { Content = "Command timeout (" + (timeoutSec > 0 ? timeoutSec : 60) + "s). stdout:\n" + stdoutBuilder + "\n\nstderr:\n" + stderrBuilder, Error = ErrorKind.Timeout };
        }
        try { Task.WaitAll(new Task[] { outTask, errTask }, 5000); } catch { }

        var sb = new StringBuilder();
        sb.Append("[exit ").Append(p.ExitCode).Append("]\n");
        if (stdoutBuilder.Length > 0) sb.Append("stdout:\n").Append(stdoutBuilder).Append(stdoutTruncated ? "\n[stdout truncated]" : "").Append("\n");
        if (stderrBuilder.Length > 0) sb.Append("stderr:\n").Append(stderrBuilder).Append(stderrTruncated ? "\n[stderr truncated]" : "").Append("\n");
        return new ToolResult { Content = sb.ToString() };
    }

    static async Task StreamReadAsync(StreamReader reader, StringBuilder target, int maxChars, Action onTruncated)
    {
        var buffer = new char[4096];
        try
        {
            while (true)
            {
                int read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (read == 0) break;
                if (target.Length < maxChars)
                {
                    int space = maxChars - target.Length;
                    target.Append(buffer, 0, Math.Min(read, space));
                    if (target.Length >= maxChars) onTruncated();
                }
            }
        }
        catch (ObjectDisposedException) { }
        catch (IOException) { }
    }

    ToolResult? CheckDangerousCommand(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        string lower = command.ToLowerInvariant().Trim();
        if (Regex.IsMatch(lower, @"\bformat\b\s+[a-z]:") ||
            Regex.IsMatch(lower, @"\bdel\b\s+/[fs]\s+/[sq].*\\windows") ||
            Regex.IsMatch(lower, @"\brm\b\s+-rf\s+/") ||
            Regex.IsMatch(lower, @"\brmdir\b\s+/[sq]\s+[a-z]:\\windows") ||
            Regex.IsMatch(lower, @"\bremove-item\b.*-recurse.*\\windows") ||
            Regex.IsMatch(lower, @"\bwmic\b.*\bdelete\b") ||
            Regex.IsMatch(lower, @"\bsc\b\s+delete\b") ||
            Regex.IsMatch(lower, @"\bstop-process\b.*-name\s+(winlogon|lsass|csrss|smss|wininit|services|svchost)") ||
            Regex.IsMatch(lower, @"\bkill\b\s+-9\s+1\b"))
            return new ToolResult { Content = "High-risk command blocked by RanParty security policy (disk format / system dir deletion / critical process termination). Split into safer steps if needed.", Error = ErrorKind.PermissionDenied };
        return null;
    }

    ToolResult OpenUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return new ToolResult { Content = "ERR url is empty", Error = ErrorKind.InvalidArgument };
        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return new ToolResult { Content = "ERR only http/https URLs allowed", Error = ErrorKind.InvalidArgument };
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        return new ToolResult { Content = "OK opened: " + url };
    }

    ToolResult OpenPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return new ToolResult { Content = "ERR path is empty", Error = ErrorKind.InvalidArgument };
        if (!_cfg.InWhitelist(path)) return new ToolResult { Content = "ERR path not in whitelist: " + path, Error = ErrorKind.PermissionDenied };
        if (!File.Exists(path) && !Directory.Exists(path))
            return new ToolResult { Content = "ERR path not found: " + path, Error = ErrorKind.NotFound };
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext is ".exe" or ".bat" or ".cmd" or ".ps1" or ".vbs" or ".com" or ".msi" or ".scr")
            return new ToolResult { Content = "Cannot open executable files (" + ext + ") with open_path. Use file viewer or editor instead.", Error = ErrorKind.PermissionDenied };
        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        return new ToolResult { Content = "OK opened with default program: " + path };
    }
}
