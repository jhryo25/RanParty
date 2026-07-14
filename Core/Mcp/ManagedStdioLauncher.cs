using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace RanParty.Core.Mcp;

public static class ManagedStdioLauncher
{
    private sealed record LaunchRequest(string Command, List<string> Arguments);

    public static (string Command, List<string> Arguments) CreateCommand(string command, IReadOnlyList<string> arguments)
    {
        string payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new LaunchRequest(command, arguments.ToList()), McpConnectorJson.Options)));
        string process = Environment.ProcessPath ?? throw new InvalidOperationException("无法定位 RanParty 后端进程");
        var launcherArguments = new List<string>();
        if (string.Equals(Path.GetFileNameWithoutExtension(process), "dotnet", StringComparison.OrdinalIgnoreCase))
            launcherArguments.Add(Assembly.GetEntryAssembly()?.Location ?? throw new InvalidOperationException("无法定位 RanParty 后端程序集"));
        launcherArguments.Add("--mcp-stdio-launcher");
        launcherArguments.Add(payload);
        return (process, launcherArguments);
    }

    public static async Task<int> RunAsync(string payload)
    {
        LaunchRequest request = JsonSerializer.Deserialize<LaunchRequest>(Encoding.UTF8.GetString(Convert.FromBase64String(payload)), McpConnectorJson.Options)
            ?? throw new InvalidOperationException("MCP launcher payload 无效");
        var start = new ProcessStartInfo
        {
            FileName = request.Command,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        foreach (string argument in request.Arguments) start.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        if (!process.Start()) throw new InvalidOperationException("无法启动 MCP stdio 服务器");
        using var job = OperatingSystem.IsWindows() ? WindowsJob.CreateAndAssign(process) : null;

        Task stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        Task stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        Task stdin = ForwardInputAsync(process);
        await process.WaitForExitAsync();
        await Task.WhenAll(IgnoreFailure(stdout), IgnoreFailure(stderr), IgnoreFailure(stdin));
        return process.ExitCode;
    }

    private static async Task ForwardInputAsync(Process process)
    {
        try { await Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream); }
        catch (IOException) { }
        finally
        {
            try { process.StandardInput.Close(); } catch { }
        }
    }

    private static async Task IgnoreFailure(Task task)
    {
        try { await task; } catch (IOException) { } catch (ObjectDisposedException) { }
    }

    private sealed class WindowsJob : IDisposable
    {
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private readonly IntPtr _handle;

        private WindowsJob(IntPtr handle) => _handle = handle;

        public static WindowsJob CreateAndAssign(Process process)
        {
            IntPtr handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new InvalidOperationException("创建 MCP Windows Job Object 失败");
            var job = new WindowsJob(handle);
            try
            {
                var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
                {
                    BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION { LimitFlags = JobObjectLimitKillOnJobClose }
                };
                int length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
                IntPtr pointer = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(information, pointer, false);
                    if (!SetInformationJobObject(handle, 9, pointer, (uint)length)) throw new InvalidOperationException("配置 MCP Windows Job Object 失败");
                }
                finally { Marshal.FreeHGlobal(pointer); }
                if (!AssignProcessToJobObject(handle, process.Handle)) throw new InvalidOperationException("MCP 进程加入 Windows Job Object 失败");
                return job;
            }
            catch { job.Dispose(); throw; }
        }

        public void Dispose() { if (_handle != IntPtr.Zero) CloseHandle(_handle); }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string? name);
        [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    }
}
