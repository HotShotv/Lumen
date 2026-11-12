// The local link to the music engine. A linked player on this PC connects here: it
// reports what it is playing and takes commands. Loopback only; nothing is reachable
// from the network.
//
// Protocol (see docs/engine-protocol.md):
//   GET  /to-engine    long-lived SSE stream of commands, one JSON frame each
//   POST /from-engine  one JSON message per request: state, lyrics, playlists, ...
//   GET  /app/*        Lumen's own page, when it is served rather than opened as a file
//   GET  /media?f=     a background file from the vault

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const PORT = 38917;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const KEEPALIVE_MS = 20000;
const CORS = { "Access-Control-Allow-Origin": "*" };

// An embedded player page is loaded from disk, so its Origin is "null" or file://.
// A website open in a browser would send its own http(s) origin, and is turned away.
function fromLocalApp(request) {
  const origin = request.headers.origin;
  return !origin || origin === "null" || origin.startsWith("file://");
}

/**
 * Events: "message" (object posted by the engine), "link" (boolean, engine connected
 * or gone).
 */
class EngineBridge extends EventEmitter {
  constructor() {
    super();
    /** @type {Set<http.ServerResponse>} open command streams */
    this.streams = new Set();
    this.server = null;
    /** the folder of Lumen's own page, served under /app/ */
    this.staticRoot = null;
    /** says whether a background file may be served (only ones in the vault) */
    this.allowMedia = () => false;
    /** resolves to true once the server is listening, false if it could not start */
    this.ready = Promise.resolve(false);
  }

  /** Lumen's page and its background files, for Lumen's own window. */
  serveLocal(request, response) {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith("/app/") && this.staticRoot) {
      const file = path.normalize(path.join(this.staticRoot, decodeURIComponent(url.pathname.slice(5))));
      if (!file.startsWith(this.staticRoot + path.sep)) {
        response.writeHead(403).end();
        return true;
      }
      sendFile(request, response, file);
      return true;
    }
    if (url.pathname === "/media") {
      const file = url.searchParams.get("f") || "";
      if (!this.allowMedia(file)) response.writeHead(403).end();
      else sendFile(request, response, file);
      return true;
    }
    return false;
  }

  get linked() {
    return this.streams.size > 0;
  }

  start() {
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.ready = new Promise((resolve) => {
      this.server.once("error", () => resolve(false));
      this.server.listen(PORT, HOST, () => resolve(true));
    });
    this.server.on("error", (error) => this.emit("error", error));
  }

  stop() {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    this.server?.close();
  }

  /** @param {object} command sent to every connected engine */
  send(command) {
    const frame = `data: ${JSON.stringify(command)}\n\n`;
    for (const stream of this.streams) stream.write(frame);
    return this.streams.size > 0;
  }

  handle(request, response) {
    if (!fromLocalApp(request)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...CORS, "Access-Control-Allow-Headers": "Content-Type" }).end();
      return;
    }

    if (request.method === "GET" && request.url === "/to-engine") {
      response.writeHead(200, {
        ...CORS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      const keepalive = setInterval(() => response.write(": ping\n\n"), KEEPALIVE_MS);
      this.streams.add(response);
      this.emit("link", true);
      request.on("close", () => {
        clearInterval(keepalive);
        this.streams.delete(response);
        if (!this.linked) this.emit("link", false);
      });
      return;
    }

    if (request.method === "GET" && this.serveLocal(request, response)) return;

    if (request.method === "POST" && request.url === "/from-engine") {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        response.writeHead(204, CORS).end();
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (message && typeof message.kind === "string") this.emit("message", message);
        } catch {
          // not JSON: ignore
        }
      });
      return;
    }

    response.writeHead(404, CORS).end();
  }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Sends a file, honouring a Range header so videos can loop and seek. */
function sendFile(request, response, file) {
  let size;
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || "");
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start <= end) || start >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(file).pipe(response);
}

module.exports = { EngineBridge, ORIGIN: `http://${HOST}:${PORT}` };
