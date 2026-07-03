using System.Drawing;
using System.Windows.Forms;

namespace RanParty.Debug;

public class FDebug : Form
{
    RichTextBox _log;
    DebugClient _client;

    public FDebug(string pipeName)
    {
        Text = "RanParty Debug";
        ClientSize = new Size(720, 520);
        _log = new RichTextBox
        {
            Dock = DockStyle.Fill,
            ReadOnly = true,
            BackColor = Color.Black,
            ForeColor = Color.LimeGreen,
            Font = new Font("Consolas", 9f)
        };
        Controls.Add(_log);
        _client = new DebugClient(pipeName, line => Append(line));
    }

    void Append(string line)
    {
        if (InvokeRequired) { BeginInvoke(new Action(() => Append(line))); return; }
        _log.AppendText(line + "\n");
        _log.ScrollToCaret();
    }
}
