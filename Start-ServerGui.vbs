Option Explicit
Dim args, i, name, command, shell, fso, root, ps, exitCode, nativeCommand, workbench, first, forceLegacy
Set args = WScript.Arguments
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
nativeCommand = Q(ps) & " -NoLogo -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File " & Q(root & "\scripts\ServerWindow.ps1")
If args.Count = 1 Then
  If LCase(args(0)) = "-probe" Then WScript.Quit shell.Run(nativeCommand & " -Probe", 0, True)
  If LCase(args(0)) = "-visibilityprobe" Then WScript.Quit shell.Run(nativeCommand & " -VisibilityProbe", 1, True)
End If
first = 0: forceLegacy = False
If args.Count > 0 Then
  If LCase(args(0)) = "-winforms" Then first = 1: forceLegacy = True
End If
workbench = root & "\server-workbench\TradeLoom Enterprise Server.exe"
command = nativeCommand
If (Not forceLegacy) And fso.FileExists(workbench) Then command = Q(workbench)
If (args.Count - first) Mod 2 <> 0 Then
  MsgBox "Invalid arguments: each option requires a value.", 16, "TradeLoom Enterprise Server"
  WScript.Quit 1
End If
For i = first To args.Count - 1 Step 2
  name = LCase(args(i))
  Select Case name
    Case "-dataroot", "-runtimesource", "-port", "-postgresport"
      command = command & " " & args(i) & " " & Q(args(i+1))
    Case Else
      MsgBox "Unknown option: " & args(i), 16, "TradeLoom Enterprise Server"
      WScript.Quit 1
  End Select
Next
' Keep normal first-window intent; PowerShell hides only its own console.
' Wait for the window process so an immediate failure cannot disappear silently.
On Error Resume Next
exitCode = shell.Run(command, 1, True)
If Err.Number <> 0 Then
  Err.Clear
  MsgBox "The server window could not start. Please contact server support with this Server package version.", 16, "TradeLoom Enterprise Server"
  WScript.Quit 1
End If
On Error GoTo 0
If exitCode <> 0 Then
  MsgBox "The server window closed unexpectedly. Please contact server support with this Server package version.", 16, "TradeLoom Enterprise Server"
  WScript.Quit exitCode
End If
Function Q(value)
  Dim j, c, n, result
  result = Chr(34): n = 0
  For j = 1 To Len(value)
    c = Mid(value,j,1)
    If c = "\" Then
      n = n + 1
    Else
      If c = Chr(34) Then
        result = result & String(n * 2 + 1, "\") & c
      Else
        result = result & String(n, "\") & c
      End If
      n = 0
    End If
  Next
  Q = result & String(n * 2, "\") & Chr(34)
End Function
