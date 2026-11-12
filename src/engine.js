// Starts the linked player out of sight so it can act as Lumen's music engine, and
// shows, hides or closes its window on request.
//
// Which player that is, is not baked in: it comes from engine.config.json at the
// repo root (see engine.config.example.json). Without that file Lumen simply runs
// on the Windows now-playing fallback.

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HELPER = path.join(__dirname, "..", "helpers", "enginewindow.ps1");
const HIDE_WAIT_SECONDS = 30;
const CONFIG_FILE = path.join(__dirname, "..", "engine.config.json");

const DEFAULTS = {
  /** process name without .exe, as it shows in Task Manager */
  processName: "",
  /** absolute path of the player's executable; %VARS% are expanded */
  exePath: "",
  /** window class the player's main window uses */
  windowClass: "Chrome_WidgetWin_1",
  /** app id recorded on tracks from this engine */
  appId: "engine",
  /** hostnames covers may be fetched from, so their pixels can be read */
  coverHosts: ["ytimg.com", "ggpht.com", "googleusercontent.com", "sndcdn.com"],
};

function expand(value) {
  return String(value || "").replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
}

/** Reads engine.config.json once. Missing or malformed config yields the defaults. */
function engineConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    raw = {};
  }
  const config = { ...DEFAULTS, ...raw };
  config.exePath = expand(config.exePath);
  config.processName = String(config.processName || "").trim();
  config.coverHosts = (Array.isArray(config.coverHosts) ? config.coverHosts : DEFAULTS.coverHosts)
    .filter((host) => typeof host === "string" && host.trim())
    .map((host) => host.trim());
  return config;
}

/** @returns {Promise<{ running?: boolean, found?: boolean, visible?: boolean, error?: string }>} */
function windowAction(config, action, waitSeconds = 0) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", HELPER,
        "-Action", action,
        "-ProcessName", config.processName,
        "-WindowClass", config.windowClass,
        "-WaitSeconds", String(waitSeconds),
      ],
      { windowsHide: true, timeout: (waitSeconds + 20) * 1000 },
      (error, stdout) => {
        if (error) return resolve({ error: error.message.slice(0, 200) });
        try {
          resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop()));
        } catch {
          resolve({ error: "unreadable helper output" });
        }
      },
    );
  });
}

class Engine {
  constructor(config = engineConfig()) {
    this.config = config;
    /** true when this run of Lumen launched the player, so Lumen also closes it on quit */
    this.startedHere = false;
  }

  /** true when the config names a player that is actually on disk */
  installed() {
    return Boolean(this.config.exePath) && fs.existsSync(this.config.exePath);
  }

  /**
   * Starts the player hidden if it is not running. One the user already has open is
   * left alone.
   * @returns {Promise<string>} what happened, for the log
   */
  async ensureRunningHidden() {
    if (!this.installed()) return "engine not configured";
    const before = await windowAction(this.config, "state");
    if (before.running) return "engine already running";

    spawn(this.config.exePath, [], { detached: true, stdio: "ignore" }).unref();
    this.startedHere = true;
    const hidden = await windowAction(this.config, "hide", HIDE_WAIT_SECONDS);
    if (hidden.error) return `started engine, hide failed: ${hidden.error}`;
    return hidden.found ? "started engine hidden" : "started engine, window not found";
  }

  show() {
    return windowAction(this.config, "show");
  }

  hide() {
    return windowAction(this.config, "hide");
  }

  /** Closes the player, but only if Lumen was the one that started it. */
  async closeIfStartedHere() {
    if (!this.startedHere) return;
    this.startedHere = false;
    await windowAction(this.config, "close");
  }
}

module.exports = { Engine, engineConfig };
