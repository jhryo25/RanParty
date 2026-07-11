using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using RanParty.Core;

namespace RanParty.Cats;

public class ShellCat : Cat
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint JobObjectLimitJobMemory = 0x00000200;
    private const int JobObjectExtendedLimitInformation = 9;
    private const ulong MaxJobMemoryBytes = 512UL * 1024 * 1024;

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int infoType, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

    [DllImport("kernel32.dll", EntryPoint = "GetLongPathNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(string shortPath, StringBuilder longPath, uint bufferLength);

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
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
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
        AddDeferred("open_url");
        AddDeferred("open_path");
    }

    public override ToolResult Execute(string tool, JsonNode args) =>
        ExecuteAsync(tool, args, CancellationToken.None).GetAwaiter().GetResult();

    public override async Task<ToolResult> ExecuteAsync(string tool, JsonNode args, CancellationToken ct)
    {
        string S(string k) => args?[k]?.GetValue<string>() ?? "";
        int I(string k) => args?[k]?.GetValue<int>() ?? 0;
        try
        {
            ct.ThrowIfCancellationRequested();
            return tool switch
            {
                "shell_run" => CheckDangerousCommand(S("command")) ?? await RunAsync("cmd.exe", "/c " + S("command"), S("workdir"), I("timeout"), ct).ConfigureAwait(false),
                "ps_run" => CheckDangerousCommand(S("command")) ?? await RunAsync("powershell.exe", "-NoProfile -Command " + S("command"), S("workdir"), I("timeout"), ct).ConfigureAwait(false),
                "open_url" => OpenUrl(S("url")),
                "open_path" => OpenPath(S("path")),
                _ => new ToolResult { Content = "ShellCat unknown tool: " + tool, Error = ErrorKind.InvalidArgument }
            };
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return new ToolResult { Content = "ERR " + ex.Message, Error = ErrorKind.Unknown }; }
    }

    const int MaxOutputChars = 65536;

    async Task<ToolResult> RunAsync(string exe, string args, string workdir, int timeoutSec, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(workdir))
        {
            workdir = Path.GetFullPath("CatTemp");
            Directory.CreateDirectory(workdir);
        }
        else
        {
            try { workdir = Path.GetFullPath(workdir); }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
            {
                return new ToolResult { Content = "ERR invalid workdir: " + ex.Message, Error = ErrorKind.InvalidArgument };
            }
        }
        if (!Directory.Exists(workdir)) return new ToolResult { Content = "ERR workdir not found: " + workdir, Error = ErrorKind.InvalidArgument };
        if (!_cfg.InWhitelist(workdir)) return new ToolResult { Content = "ERR workdir not in whitelist: " + workdir, Error = ErrorKind.PermissionDenied };
        string processWorkdir = ExpandLongPath(workdir);
        int effectiveTimeoutSeconds = timeoutSec > 0 ? Math.Clamp(timeoutSec, 1, 3600) : 60;
        var psi = new ProcessStartInfo
        {
            FileName = exe, Arguments = args, WorkingDirectory = processWorkdir,
            UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using var job = CreateConfiguredJob();
        using var p = Process.Start(psi);
        if (p == null) return new ToolResult { Content = "ERR failed to start process", Error = ErrorKind.Fatal };
        if (!AssignProcessToJobObject(job, p.Handle))
        {
            int error = Marshal.GetLastWin32Error();
            KillProcessTree(p);
            throw new Win32Exception(error, "Failed to assign command process to its sandbox job object.");
        }

        var stdoutBuilder = new StringBuilder();
        var stderrBuilder = new StringBuilder();
        bool stdoutTruncated = false, stderrTruncated = false;
        var outTask = StreamReadAsync(p.StandardOutput, stdoutBuilder, MaxOutputChars, () => stdoutTruncated = true);
        var errTask = StreamReadAsync(p.StandardError, stderrBuilder, MaxOutputChars, () => stderrTruncated = true);

        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(effectiveTimeoutSeconds));
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        try
        {
            await p.WaitForExitAsync(linkedCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested && timeoutCts.IsCancellationRequested)
        {
            KillProcessTree(p);
            await DrainOutputAsync(outTask, errTask).ConfigureAwait(false);
            return new ToolResult
            {
                Content = "Command timeout (" + effectiveTimeoutSeconds + "s). stdout:\n" + stdoutBuilder + "\n\nstderr:\n" + stderrBuilder,
                Error = ErrorKind.Timeout
            };
        }
        catch (OperationCanceledException)
        {
            KillProcessTree(p);
            await DrainOutputAsync(outTask, errTask).ConfigureAwait(false);
            throw;
        }
        await DrainOutputAsync(outTask, errTask).ConfigureAwait(false);

        var sb = new StringBuilder();
        int exitCode = p.ExitCode;
        sb.Append("[exit ").Append(exitCode).Append("]\n");
        if (stdoutBuilder.Length > 0) sb.Append("stdout:\n").Append(stdoutBuilder).Append(stdoutTruncated ? "\n[stdout truncated]" : "").Append("\n");
        if (stderrBuilder.Length > 0) sb.Append("stderr:\n").Append(stderrBuilder).Append(stderrTruncated ? "\n[stderr truncated]" : "").Append("\n");
        return new ToolResult
        {
            Content = sb.ToString(),
            Error = exitCode == 0 ? ErrorKind.None : ErrorKind.Unknown
        };
    }

    private static string ExpandLongPath(string path)
    {
        if (!OperatingSystem.IsWindows()) return path;
        try
        {
            var buffer = new StringBuilder(32_768);
            uint length = GetLongPathName(path, buffer, (uint)buffer.Capacity);
            return length is > 0 and < 32_768 ? buffer.ToString() : path;
        }
        catch { return path; }
    }

    private static SafeFileHandle CreateConfiguredJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create command sandbox job object.");

        int size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        IntPtr limitsPtr = Marshal.AllocHGlobal(size);
        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
            {
                BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
                {
                    LimitFlags = JobObjectLimitKillOnJobClose | JobObjectLimitJobMemory
                },
                JobMemoryLimit = new UIntPtr(MaxJobMemoryBytes)
            };
            Marshal.StructureToPtr(limits, limitsPtr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsPtr, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to configure command sandbox job object.");
            return job;
        }
        catch
        {
            job.Dispose();
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(limitsPtr);
        }
    }

    private static void KillProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch { }
    }

    private static async Task DrainOutputAsync(Task stdout, Task stderr)
    {
        try
        {
            await Task.WhenAll(stdout, stderr).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or ObjectDisposedException) { }
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
