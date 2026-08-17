' Wes's daily error log — invoked by Windows Task Scheduler (9:15pm).
' wscript has no console, so the node server runs with zero window flash and
' no stray black window sitting open for the 30 minutes it stays alive.
' The browser is opened here rather than by node, so the only window that
' appears is the page itself.
Dim sh, log
Set sh = CreateObject("Wscript.Shell")
log = "C:\Users\sandm\.claude\scripts\errorlog\out\daily.log"

sh.Run "cmd /c node ""C:\Users\sandm\.claude\tools\errorlog\daily.cjs"" --no-open >> """ & log & """ 2>&1", 0, False
WScript.Sleep 1500
sh.Run "http://localhost:7841", 1, False
