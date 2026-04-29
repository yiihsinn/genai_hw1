const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function createRequestHandler(options) {
  const {
    publicDir,
    memoryStore,
    geminiService,
    tools
  } = options;

  const routes = [
    {
      method: "GET",
      match: (requestUrl) => requestUrl.pathname === "/api/health",
      handler: asyncHandler(async (req, res) => {
        const models = await geminiService.getGeminiModels();
        sendJson(res, 200, {
          ok: true,
          provider: "nvidia-nim",
          hasApiKey: Boolean(geminiService.apiKey),
          models,
          memoryCount: memoryStore.getMemoryEntries().length,
          tools: {
            enabled: true,
            names: tools.getToolNames()
          }
        });
      })
    },
    {
      method: "GET",
      match: (requestUrl) => requestUrl.pathname === "/api/memory",
      handler: asyncHandler(async (req, res) => {
        sendJson(res, 200, memoryStore.getMemoryEntries());
      })
    },
    {
      method: "POST",
      match: (requestUrl) => requestUrl.pathname === "/api/memory",
      handler: asyncHandler(async (req, res) => {
        const body = await readJsonBody(req, geminiService.maxRequestBodySize);
        const entry = memoryStore.addMemory({
          id: typeof body?.id === "string" ? body.id.trim() : "",
          type: typeof body?.type === "string" ? body.type : "",
          origin: typeof body?.origin === "string" ? body.origin : "",
          summary: typeof body?.summary === "string" ? body.summary : "",
          sourceMessageCount: clampInteger(body?.sourceMessageCount, 0, 10_000, 0)
        });

        if (!entry) {
          return sendJson(res, 400, { error: "Memory summary is required." });
        }

        sendJson(res, 200, entry);
      })
    },
    {
      method: "DELETE",
      match: (requestUrl) => requestUrl.pathname.startsWith("/api/memory/"),
      handler: asyncHandler(async (req, res, requestUrl) => {
        const id = decodeURIComponent(requestUrl.pathname.slice("/api/memory/".length));
        if (!id) {
          return sendJson(res, 400, { error: "Memory id is required." });
        }

        const deleted = memoryStore.deleteMemoryEntry(id);
        if (!deleted) {
          return sendJson(res, 404, { error: "Memory entry not found." });
        }

        sendJson(res, 200, { ok: true, id });
      })
    },
    {
      method: "POST",
      match: (requestUrl) => requestUrl.pathname === "/api/chat",
      handler: asyncHandler(async (req, res) => {
        const body = await readJsonBody(req, geminiService.maxRequestBodySize);
        await geminiService.handleChat(req, res, body);
      })
    }
  ];

  return async function handleRequest(req, res) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = routes.find((entry) => entry.method === req.method && entry.match(requestUrl));

    if (route) {
      return route.handler(req, res, requestUrl);
    }

    if (req.method === "GET") {
      return serveStaticFile(publicDir, requestUrl.pathname, res);
    }

    sendJson(res, 404, { error: "Not found" });
  };
}

function asyncHandler(fn) {
  return async (req, res, requestUrl) => {
    try {
      await fn(req, res, requestUrl);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, error.statusCode || 500, {
          error: error.message || "Internal server error"
        });
      } else {
        res.end();
      }
    }
  };
}

function serveStaticFile(publicDir, requestPath, res) {
  const normalizedPath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.join(publicDir, path.normalize(normalizedPath));

  if (!filePath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        return sendJson(res, 404, { error: "File not found" });
      }

      return sendJson(res, 500, { error: "Failed to read file" });
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream"
    });
    res.end(data);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxRequestBodySize) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxRequestBodySize) {
        const error = new Error("Request body too large.");
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

module.exports = {
  createRequestHandler,
  asyncHandler
};
