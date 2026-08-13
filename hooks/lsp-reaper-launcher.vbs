' Launches lsp-reaper.ps1 with zero window flash (wscript has no console).
' Used by the ClaudeLspReaper scheduled task.
CreateObject("Wscript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\sandm\.claude\hooks\lsp-reaper.ps1""", 0, False
