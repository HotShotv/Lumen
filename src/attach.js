// Pins a window behind the Windows desktop icons, the way live-wallpaper apps do.
// There is no Electron API for it, so a short PowerShell script makes the Win32 calls.

const { execFile } = require("node:child_process");

// {HWND} is replaced with the window handle as a decimal number.
const SCRIPT = `
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumenDesktop {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  const uint NOSIZE = 0x1, NOMOVE = 0x2, NOACTIVATE = 0x10, SHOW = 0x40, NOSENDCHANGING = 0x400;

  // fills the whole desktop layer, taskbar strip included (a translucent taskbar shows it)
  static void Place(IntPtr window, IntPtr parent, IntPtr after) {
    RECT area;
    GetClientRect(parent, out area);
    // NOSENDCHANGING skips the size check that would shrink the window back to the work area
    SetWindowPos(window, after, 0, 0, area.R - area.L, area.B - area.T, NOACTIVATE | SHOW | NOSENDCHANGING);
  }

  static bool IsChildOf(IntPtr window, IntPtr parent) {
    return GetAncestor(window, 1) == parent; // 1 = GA_PARENT
  }

  // interactive: above the icons so it can be clicked; otherwise behind them, display only
  public static string Attach(IntPtr window, bool interactive) {
    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) return "no-progman";

    // asks the shell to split the wallpaper onto its own layer behind the icons
    IntPtr ignored;
    SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(1), 0, 1000, out ignored);

    // classic layout: the icons live in a top-level WorkerW, and the wallpaper
    // layer is the next WorkerW after it
    IntPtr layer = IntPtr.Zero;
    IntPtr iconHost = IntPtr.Zero;
    EnumWindows(delegate(IntPtr top, IntPtr l) {
      if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
        IntPtr next = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
        if (next != IntPtr.Zero) { layer = next; iconHost = top; }
      }
      return true;
    }, IntPtr.Zero);
    if (layer != IntPtr.Zero && interactive) {
      SetParent(window, iconHost);
      Place(window, iconHost, IntPtr.Zero); // top of the icon window's children
      return IsChildOf(window, iconHost) ? "workerw-interactive" : "failed-workerw";
    }
    if (layer != IntPtr.Zero) {
      SetParent(window, layer);
      Place(window, layer, IntPtr.Zero);
      return IsChildOf(window, layer) ? "workerw" : "failed-workerw";
    }

    // newer Windows 11 layout: icons and wallpaper layer are both children of
    // Progman, so the window goes between them
    IntPtr icons = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (icons == IntPtr.Zero) return "no-icon-layer";
    IntPtr wallpaper = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
    SetParent(window, progman);
    Place(window, progman, interactive ? IntPtr.Zero : icons);
    if (wallpaper != IntPtr.Zero && !interactive)
      SetWindowPos(wallpaper, window, 0, 0, 0, 0, NOSIZE | NOMOVE | NOACTIVATE);
    if (!IsChildOf(window, progman)) return "failed-progman";
    return interactive ? "progman-interactive" : "progman";
  }
}
"@
[LumenDesktop]::Attach([IntPtr]{HWND}, [bool]{INTERACTIVE})
`;

/**
 * @param {Electron.BrowserWindow} window
 * @param {boolean} interactive above the icons (clickable) instead of behind them
 * @returns {Promise<string>} which desktop layout it attached to, or a failure reason
 */
function attachToDesktop(window, interactive) {
  return new Promise((resolve) => {
    const handle = window.getNativeWindowHandle();
    const hwnd =
      handle.length >= 8
        ? handle.readBigUInt64LE(0).toString()
        : String(handle.readUInt32LE(0));
    // -EncodedCommand takes base64 UTF-16, which sidesteps all quoting
    const encoded = Buffer.from(SCRIPT.replace("{HWND}", hwnd).replace("{INTERACTIVE}", interactive ? "1" : "0"), "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) resolve(`error: ${(stderr || error.message).trim().slice(0, 300)}`);
        else resolve(stdout.trim().split(/\r?\n/).pop() || "no-output");
      },
    );
  });
}

module.exports = { attachToDesktop };
