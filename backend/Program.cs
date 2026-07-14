using System.Text;

namespace RanParty.Backend;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args is ["--mcp-stdio-launcher", var payload])
            return await Core.Mcp.ManagedStdioLauncher.RunAsync(payload);
        var host = new BackendHost(Console.In, Console.Out);
        await host.RunAsync();
        return 0;
    }
}
