// Runs helpers/nowplaying.ps1 in the background and turns its JSON lines into events.

const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const HELPER = path.join(__dirname, "..", "helpers", "nowplaying.ps1");
const RESTART_DELAY_MS = 3000;
const BASE_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER];

class NowPlaying {
  /** @param {(state: object) => void} onState */
  constructor(onState) {
    this.onState = onState;
    this.child = null;
    /** a second helper that stays open to run commands without start-up delay */
    this.commander = null;
    this.stopped = false;
    this.restartTimer = null;
  }

  start() {
    if (this.child || this.stopped) return;
    this.startCommander();
    const child = spawn("powershell.exe", BASE_ARGS, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const state = JSON.parse(line);
        if (state?.type === "state") this.onState(state);
      } catch {
        // a partial or non-JSON line: skip it
      }
    });

    child.on("exit", () => {
      this.child = null;
      if (this.stopped) return;
      this.onState({ type: "state", active: false });
      this.restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.child?.kill();
    this.child = null;
    this.commander?.kill();
    this.commander = null;
  }

  startCommander() {
    if (this.commander || this.stopped) return;
    const commander = spawn("powershell.exe", [...BASE_ARGS, "-Serve"], {
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    commander.stdin.on("error", () => {});
    commander.on("exit", () => {
      if (this.commander === commander) this.commander = null;
    });
    this.commander = commander;
  }

  /**
   * @param {"play"|"pause"|"toggle"|"next"|"previous"|"seek"} command
   * @param {number} [argument] milliseconds, for seek
   */
  send(command, argument) {
    this.startCommander();
    const line = argument === undefined ? command : command + " " + Math.round(argument);
    this.commander?.stdin.write(line + "\n");
  }
}

module.exports = { NowPlaying };
