Option Explicit
Dim args, i, name, command, shell, fso, root, ps
Set args = WScript.Arguments
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = Q(ps) & " -NoLogo -NoProfile -STA -ExecutionPolicy RemoteSigned -File " & Q(root & "\scripts\ServerWindow.ps1")
If args.Count = 1 Then
  If LCase(args(0)) = "-probe" Then WScript.Quit shell.Run(command & " -Probe", 0, True)
End If
If args.Count Mod 2 <> 0 Then
  MsgBox "Invalid arguments: each option requires a value.", 16, "TradeLoom Enterprise Server"
  WScript.Quit 1
End If
For i = 0 To args.Count - 1 Step 2
  name = LCase(args(i))
  Select Case name
    Case "-dataroot", "-runtimesource", "-port", "-postgresport"
      command = command & " " & args(i) & " " & Q(args(i+1))
    Case Else
      MsgBox "Unknown option: " & args(i), 16, "TradeLoom Enterprise Server"
      WScript.Quit 1
  End Select
Next
shell.Run command, 0, False
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
