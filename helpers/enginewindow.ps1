# Hides, shows or closes the linked player's main window, so it can run as Lumen's
# music engine without its window on screen.
#
#   -Action hide   wait for the window to appear (up to -WaitSeconds), then hide it
#   -Action show   bring a hidden window back
#   -Action close  ask the player to close, the same as clicking its X
#   -Action state  print whether the player is running and whether its window is visible
#
# The player is named by -ProcessName (no .exe) and -WindowClass, both from
# engine.config.json.

param(
  [Parameter(Mandatory)][ValidateSet("hide", "show", "close", "state")][string]$Action,
  [Parameter(Mandatory)][string]$ProcessName,
  [string]$WindowClass = "Chrome_WidgetWin_1",
  [int]$WaitSeconds = 0
)

$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class EngineWindow {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  // The player's main window: the largest titled window of that class its processes
  // own. The floating mini player is small and the helper windows have no title.
  public static IntPtr Find(uint[] pids, string windowClass) {
    var wanted = new HashSet<uint>(pids);
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr hwnd, IntPtr l) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (!wanted.Contains(pid) || GetWindowTextLength(hwnd) == 0) return true;
      var cls = new StringBuilder(64); GetClassName(hwnd, cls, 64);
      if (cls.ToString() != windowClass) return true;
      RECT r; GetWindowRect(hwnd, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > bestArea) { bestArea = area; best = hwnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

function Find-PlayerWindow {
  $ids = [uint32[]]@(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($ids.Count -eq 0) { return [IntPtr]::Zero }
  [EngineWindow]::Find($ids, $WindowClass)
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  $window = Find-PlayerWindow
  # for "hide", keep waiting until the window has actually been shown
  $ready = $window -ne [IntPtr]::Zero -and ($Action -ne "hide" -or [EngineWindow]::IsWindowVisible($window))
  if ($ready -or (Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
} while ($true)

$running = [bool](Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($window -eq [IntPtr]::Zero) {
  Write-Output (@{ running = $running; found = $false } | ConvertTo-Json -Compress)
  exit 0
}

switch ($Action) {
  "hide" { $null = [EngineWindow]::ShowWindow($window, 0) }   # SW_HIDE
  "show" { $null = [EngineWindow]::ShowWindow($window, 5) }   # SW_SHOW
  "close" { $null = [EngineWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }  # WM_CLOSE
}
Write-Output (@{ running = $running; found = $true; visible = [EngineWindow]::IsWindowVisible($window) } | ConvertTo-Json -Compress)
