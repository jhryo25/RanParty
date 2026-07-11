using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace RanParty.Debug;

public sealed class DebugServer : IDisposable
{
    readonly string _pipeName;
    readonly CancellationTokenSource _shutdown;
    readonly Task _acceptTask;
    NamedPipeServerStream? _server;
    StreamWriter? _writer;
    TaskCompletionSource<bool>? _connectionClosed;
    readonly object _lock = new();
    int _disposed;

    public DebugServer(string pipeName, CancellationToken cancellationToken = default)
    {
        _pipeName = pipeName;
        _shutdown = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _acceptTask = AcceptLoop(_shutdown.Token);
    }

    async Task AcceptLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream? server = null;
            StreamWriter? writer = null;
            TaskCompletionSource<bool>? connectionClosed = null;
            try
            {
                server = new NamedPipeServerStream(_pipeName, PipeDirection.Out, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);
                writer = new StreamWriter(server, new UTF8Encoding(false), 1024, leaveOpen: true) { AutoFlush = true };
                connectionClosed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

                bool published;
                lock (_lock)
                {
                    published = Volatile.Read(ref _disposed) == 0 && !ct.IsCancellationRequested;
                    if (published)
                    {
                        _server = server;
                        _writer = writer;
                        _connectionClosed = connectionClosed;
                    }
                }
                if (!published) break;

                // Outbound-only pipes have no read loop to observe disconnects. Poll
                // IsConnected and also let Broadcast signal the lifecycle immediately
                // when a write discovers a broken client.
                while (!ct.IsCancellationRequested && server.IsConnected)
                {
                    var delay = Task.Delay(250, ct);
                    if (await Task.WhenAny(connectionClosed.Task, delay).ConfigureAwait(false) == connectionClosed.Task) break;
                    await delay.ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) when (ct.IsCancellationRequested) { break; }
            catch
            {
                try { await Task.Delay(500, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
            finally
            {
                lock (_lock)
                {
                    if (ReferenceEquals(_server, server))
                    {
                        _server = null;
                        _writer = null;
                        _connectionClosed = null;
                    }
                }
                connectionClosed?.TrySetResult(true);
                try { writer?.Dispose(); } catch { }
                try { server?.Dispose(); } catch { }
            }
        }
    }

    public void Broadcast(string line)
    {
        TaskCompletionSource<bool>? connectionClosed = null;
        lock (_lock)
        {
            try
            {
                if (_writer != null && _server != null && _server.IsConnected)
                    _writer.WriteLine(line);
                else if (_server != null)
                    connectionClosed = _connectionClosed;
            }
            catch { connectionClosed = _connectionClosed; }
        }
        connectionClosed?.TrySetResult(true);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _shutdown.Cancel();
        TaskCompletionSource<bool>? connectionClosed;
        lock (_lock)
        {
            connectionClosed = _connectionClosed;
            _connectionClosed = null;
            try { _server?.Dispose(); } catch { }
            try { _writer?.Dispose(); } catch { }
            _server = null;
            _writer = null;
        }
        connectionClosed?.TrySetResult(true);
        try { _acceptTask.Wait(TimeSpan.FromSeconds(2)); } catch { }
        _shutdown.Dispose();
    }
}

public sealed class DebugClient : IDisposable
{
    readonly string _pipeName;
    readonly Action<string> _onLine;
    readonly CancellationTokenSource _shutdown;
    readonly Task _runTask;
    readonly object _lock = new();
    NamedPipeClientStream? _client;
    int _disposed;

    public DebugClient(string pipeName, Action<string> onLine, CancellationToken cancellationToken = default)
    {
        _pipeName = pipeName;
        _onLine = onLine;
        _shutdown = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _runTask = Run(_shutdown.Token);
    }

    async Task Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeClientStream? client = null;
            try
            {
                client = new NamedPipeClientStream(".", _pipeName, PipeDirection.In,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                lock (_lock) _client = client;
                await client.ConnectAsync(5000, ct).ConfigureAwait(false);
                using var sr = new StreamReader(client, new UTF8Encoding(false));
                string? line;
                while ((line = await sr.ReadLineAsync(ct).ConfigureAwait(false)) != null)
                    _onLine(line);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) when (ct.IsCancellationRequested) { break; }
            catch { }
            finally
            {
                lock (_lock)
                    if (ReferenceEquals(_client, client)) _client = null;
                try { client?.Dispose(); } catch { }
            }
            try { await Task.Delay(250, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _shutdown.Cancel();
        lock (_lock)
        {
            try { _client?.Dispose(); } catch { }
            _client = null;
        }
        try { _runTask.Wait(TimeSpan.FromSeconds(2)); } catch { }
        _shutdown.Dispose();
    }
}
