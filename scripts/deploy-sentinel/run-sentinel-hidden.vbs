' Hidden launcher for Deploy Sentinel — Task Scheduler calls this instead of
' bash directly so no console window flashes every 30 minutes.
CreateObject("WScript.Shell").Run _
  """C:\Program Files\Git\bin\bash.exe"" C:\Users\sandm\.claude\scripts\deploy-sentinel\run-sentinel.sh", 0, False
