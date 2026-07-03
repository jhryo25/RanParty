using System.IO;
using System.Text;
using ClosedXML.Excel;

namespace RanParty.Tools;

public static class Excel
{
    public static string Read(string path)
    {
        var sb = new StringBuilder();
        using var wb = new XLWorkbook(path);
        var ws = wb.Worksheet(1);
        var used = ws.RangeUsed();
        if (used == null) return "";
        int lastRow = used.LastRow().RowNumber();
        int lastCol = used.LastColumn().ColumnNumber();
        for (int r = 1; r <= lastRow; r++)
        {
            for (int c = 1; c <= lastCol; c++)
            {
                if (c > 1) sb.Append('\t');
                sb.Append(ws.Cell(r, c).Value.ToString());
            }
            sb.Append('\n');
        }
        return sb.ToString();
    }

    public static void Write(string path, string tsv)
    {
        using var wb = new XLWorkbook();
        var ws = wb.AddWorksheet("Sheet1");
        int r = 1;
        foreach (var line in tsv.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.Length == 0) { r++; continue; }
            var cells = line.Split('\t');
            for (int c = 0; c < cells.Length; c++)
                ws.Cell(r, c + 1).Value = cells[c];
            r++;
        }
        wb.SaveAs(path);
    }
}
