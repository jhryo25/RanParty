using System;
using System.Windows.Forms;

using RanParty.Ui;
using RanParty.Debug;
namespace RanParty;

internal static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // --debug-child <pid> : 仅作为 FDebug 调试器子进程运行
        if (args.Length >= 2 && args[0] == "--debug-child")
        {
            string pipe = "RanParty-Debug-" + args[1];
            Application.Run(new FDebug(pipe));
            return;
        }

        bool debug = Array.Exists(args, a => string.Equals(a, "--debug", StringComparison.OrdinalIgnoreCase));
        Application.Run(new FMain(debug));
    }
}
