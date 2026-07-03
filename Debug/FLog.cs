using System;
using System.Drawing;
using System.Windows.Forms;

using RanParty.Core;
namespace RanParty.Debug;

public class FLog : Form
{
    Logger _log;
    RichTextBox _box;

    public FLog(Logger log)
    {
        _log = log;
        Text = "RanParty 日志监控";
        ClientSize = new Size(760, 560);
        _box = new RichTextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            BackColor = Color.Black,
            ForeColor = Color.LimeGreen,
            Font = new Font("Consolas", 9f)
        };
        Controls.Add(_box);
        _log.OnLog += Append;
        FormClosed += (s, e) => _log.OnLog -= Append;
    }

    void Append(string line)
    {
        if (IsDisposed) return;
        if (_box.InvokeRequired) { _box.BeginInvoke(new Action(() => Append(line))); return; }
        _box.AppendText(line + "\n");
        _box.ScrollToCaret();
    }
}
