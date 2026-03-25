const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PUBLIC_DIR = path.join(__dirname, "public");
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const MODEL_OPTIONS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];

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

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      const models = await getGeminiModels();
      return sendJson(res, 200, {
        ok: true,
        provider: "gemini",
        hasApiKey: Boolean(GEMINI_API_KEY),
        models
      });
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      return handleChat(req, res);
    }

    if (req.method === "GET") {
      return serveStaticFile(req, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("Unexpected server error:", error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

async function handleChat(req, res) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, {
      error: "GEMINI_API_KEY is missing. Please create a .env file first."
    });
  }

  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const {
    model,
    systemPrompt,
    temperature,
    topP,
    maxOutputTokens,
    messages
  } = body || {};

  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, { error: "Invalid request payload." });
  }

  const contents = [];

  for (const message of messages) {
    if (!message || typeof message.content !== "string" || !message.content.trim()) {
      continue;
    }

    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content.trim() }]
    });
  }

  if (contents.length === 0) {
    return sendJson(res, 400, { error: "No valid messages were provided." });
  }

  const payload = {
    contents,
    generationConfig: {
      temperature: clampNumber(temperature, 0, 2, 1),
      topP: clampNumber(topP, 0, 1, 1),
      maxOutputTokens: clampInteger(maxOutputTokens, 32, 8192, 512)
    }
  };

  if (typeof systemPrompt === "string" && systemPrompt.trim()) {
    payload.systemInstruction = {
      parts: [{ text: systemPrompt.trim() }]
    };
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstream;

  try {
    upstream = await fetch(
      `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      }
    );
  } catch (error) {
    const message = error.name === "AbortError"
      ? "Client disconnected."
      : "Failed to connect to Gemini API.";
    return sendJson(res, 502, { error: message });
  }

  if (!upstream.ok || !upstream.body) {
    const errorText = await upstream.text();
    const parsed = tryParseJson(errorText);
    const message = parsed?.error?.message || errorText || "Gemini API request failed.";
    return sendJson(res, upstream.status || 500, { error: message });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      while (buffer.includes("\n\n")) {
        const boundaryIndex = buffer.indexOf("\n\n");
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        forwardGeminiEvent(rawEvent, res);
      }
    }

    if (buffer.trim()) {
      forwardGeminiEvent(buffer, res);
    }

    writeSse(res, "done", {});
  } catch (error) {
    if (error.name !== "AbortError") {
      writeSse(res, "error", {
        message: "Streaming interrupted while reading the model response."
      });
    }
  } finally {
    res.end();
  }
}

function forwardGeminiEvent(rawEvent, res) {
  const lines = rawEvent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const parsed = tryParseJson(payload);
    if (!parsed) {
      continue;
    }

    if (parsed.error?.message) {
      writeSse(res, "error", { message: parsed.error.message });
      continue;
    }

    const text = extractGeminiText(parsed);
    if (text) {
      writeSse(res, "token", { delta: text });
    }

    const finishReason = parsed?.candidates?.[0]?.finishReason;
    const finishMessage = parsed?.candidates?.[0]?.finishMessage || "";
    if (finishReason) {
      writeSse(res, "finish", {
        reason: finishReason,
        message: finishMessage
      });
    }
  }
}

function extractGeminiText(payload) {
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

async function getGeminiModels() {
  if (!GEMINI_API_KEY) {
    return MODEL_OPTIONS;
  }

  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/models?key=${encodeURIComponent(GEMINI_API_KEY)}&pageSize=100`,
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      return MODEL_OPTIONS;
    }

    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models : [];
    const available = models
      .filter((modelInfo) => Array.isArray(modelInfo.supportedGenerationMethods))
      .filter((modelInfo) => modelInfo.supportedGenerationMethods.includes("generateContent"))
      .map((modelInfo) => modelInfo.baseModelId || stripModelPrefix(modelInfo.name))
      .filter(Boolean)
      .filter((name) => name.startsWith("gemini-"))
      .filter((name) => !name.includes("2.0-flash"));

    return Array.from(new Set([...available, ...MODEL_OPTIONS])).sort();
  } catch {
    return MODEL_OPTIONS;
  }
}

function stripModelPrefix(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function serveStaticFile(req, res) {
  const normalizedUrl = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, path.normalize(normalizedUrl));

  if (!filePath.startsWith(PUBLIC_DIR)) {
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
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

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const fileContent = fs.readFileSync(envPath, "utf8");
  const lines = fileContent.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const unquotedValue = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && !(key in process.env)) {
      process.env[key] = unquotedValue;
    }
  }
}
