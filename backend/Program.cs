using System.Text;

namespace RanParty.Backend;

internal static class Program
{
    public static async Task Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var host = new BackendHost(Console.In, Console.Out);
        await host.RunAsync();
    }
}
