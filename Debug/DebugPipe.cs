using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;

namespace RanParty.Debug;

public class DebugServer
{
    string _pipeName;
    NamedPipeServerStream _server;
    StreamWriter _writer;
    object _lock = new();

    public DebugServer(string pipeName)
    {
        _pipeName = pipeName;
        _ = AcceptLoop();
    }

    async Task AcceptLoop()
    {
        while (true)
        {
            try
            {
                _server = new NamedPipeServerStream(_pipeName, PipeDirection.Out, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await _server.WaitForConnectionAsync();
                lock (_lock)
                    _writer = new StreamWriter(_server, new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch { await Task.Delay(500); }
        }
    }

    public void Broadcast(string line)
    {
        lock (_lock)
        {
            try
            {
                if (_writer != null && _server != null && _server.IsConnected)
                    _writer.WriteLine(line);
            }
            catch { }
        }
    }
}

public class DebugClient
{
    string _pipeName;
    Action<string> _onLine;

    public DebugClient(string pipeName, Action<string> onLine)
    {
        _pipeName = pipeName;
        _onLine = onLine;
        _ = Run();
    }

    async Task Run()
    {
        while (true)
        {
            try
            {
                var client = new NamedPipeClientStream(".", _pipeName, PipeDirection.In, PipeOptions.Asynchronous);
                await client.ConnectAsync(5000);
                using var sr = new StreamReader(client, new UTF8Encoding(false));
                string line;
                while ((line = await sr.ReadLineAsync()) != null)
                    _onLine?.Invoke(line);
            }
            catch { }
            await Task.Delay(1000);
        }
    }
}
