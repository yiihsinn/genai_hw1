const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PUBLIC_DIR = path.join(__dirname, "public");
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MEMORY_LOCK_FILE = `${MEMORY_FILE}.lock`;
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const SUMMARY_THRESHOLD = 20;
const SUMMARY_BATCH_SIZE = 10;
const MAX_REQUEST_BODY_SIZE = 16_000_000;
const INLINE_DATA_LIMIT = 13_000_000;
const VISION_MODEL = "gemini-3-flash-preview";
const DEFAULT_CHAT_MODEL = "gemini-2.5-flash";
const BLOCKED_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-3.1-pro-preview"
]);

const MODEL_OPTIONS = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview"
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

ensureMemoryStore();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      const models = await getGeminiModels();
      return sendJson(res, 200, {
        ok: true,
        provider: "gemini",
        hasApiKey: Boolean(GEMINI_API_KEY),
        models
      });
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/memory") {
      return sendJson(res, 200, getMemoryEntries());
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/memory") {
      return handleUpsertMemory(req, res);
    }

    if (req.method === "DELETE" && requestUrl.pathname.startsWith("/api/memory/")) {
      const id = decodeURIComponent(requestUrl.pathname.slice("/api/memory/".length));
      return handleDeleteMemory(res, id);
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/chat") {
      return handleChat(req, res);
    }

    if (req.method === "GET") {
      return serveStaticFile(requestUrl.pathname, res);
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

async function handleUpsertMemory(req, res) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }

  const entry = addMemory({
    id: typeof body?.id === "string" ? body.id.trim() : "",
    summary: typeof body?.summary === "string" ? body.summary : "",
    sourceMessageCount: clampInteger(body?.sourceMessageCount, 0, 10_000, 0)
  });

  if (!entry) {
    return sendJson(res, 400, { error: "Memory summary is required." });
  }

  sendJson(res, 200, entry);
}

function handleDeleteMemory(res, id) {
  if (!id) {
    return sendJson(res, 400, { error: "Memory id is required." });
  }

  const deleted = deleteMemoryEntry(id);
  if (!deleted) {
    return sendJson(res, 404, { error: "Memory entry not found." });
  }

  sendJson(res, 200, { ok: true, id });
}

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
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }

  const {
    model,
    autoRoute,
    systemPrompt,
    temperature,
    topP,
    maxOutputTokens,
    messages
  } = body || {};

  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, { error: "Invalid request payload." });
  }

  let workingMessages = sanitizeMessages(messages);
  if (workingMessages.length === 0) {
    return sendJson(res, 400, { error: "No valid messages were provided." });
  }

  const inlineDataParts = getInlineDataParts(workingMessages);
  if (inlineDataParts.some((part) => part.inline_data.data.length > INLINE_DATA_LIMIT)) {
    return sendJson(res, 413, {
      error: "Inline image data exceeds the 10MB upload limit."
    });
  }

  const requestedModel = sanitizeRequestedModel(model);
  const latestUserMessage = getLatestUserMessage(workingMessages);
  const availableModels = Array.from(new Set([
    DEFAULT_CHAT_MODEL,
    VISION_MODEL,
    "gemini-3.1-flash-lite-preview",
    requestedModel
  ]));

  let selectedModel = inlineDataParts.length > 0 ? VISION_MODEL : requestedModel;
  let routingPayload = null;

  if (autoRoute) {
    routingPayload = selectModel(latestUserMessage, availableModels, {
      preferredModel: requestedModel,
      hasInlineImage: inlineDataParts.length > 0
    });
    selectedModel = routingPayload.model;
  }

  const modelOverridePayload = inlineDataParts.length > 0
    ? {
      model: VISION_MODEL,
      reason: "image detected: cost optimization"
    }
    : null;

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let pendingSummary = null;

  if (workingMessages.length > SUMMARY_THRESHOLD) {
    pendingSummary = await summarizeOldMessages(selectedModel, workingMessages, controller.signal);
    if (pendingSummary?.summary) {
      workingMessages = [
        {
          role: "user",
          content: `[Memory] Key context from previous conversations:\n${normalizeSummaryForPrompt(pendingSummary.summary)}`
        },
        ...workingMessages.slice(pendingSummary.sourceMessageCount)
      ];
    }
  }

  const contents = workingMessages
    .map(convertMessageToGeminiContent)
    .filter(Boolean);

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

  let upstream;

  try {
    upstream = await fetch(buildGeminiUrl(selectedModel, true), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
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

  if (modelOverridePayload) {
    writeSse(res, "model_override", modelOverridePayload);
  }

  if (routingPayload) {
    writeSse(res, "routing", routingPayload);
  }

  if (pendingSummary?.summary) {
    try {
      const memoryEntry = addMemory({
        summary: pendingSummary.summary,
        sourceMessageCount: pendingSummary.sourceMessageCount
      });

      if (memoryEntry) {
        writeSse(res, "memory_summary", {
          id: memoryEntry.id,
          summary: memoryEntry.summary,
          sourceMessageCount: memoryEntry.sourceMessageCount
        });
      }
    } catch (error) {
      writeSse(res, "error", {
        message: `Failed to persist summarized memory: ${error.message}`
      });
    }
  }

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

async function summarizeOldMessages(model, messages, signal) {
  const slice = messages.slice(0, SUMMARY_BATCH_SIZE);
  const transcript = buildConversationTranscript(slice);

  if (!transcript) {
    return null;
  }

  const summaryPrompt = [
    "Summarize the key facts, user preferences, and important context from the following conversation in 3-5 concise bullet points. Output ONLY the bullets, no preamble.",
    "",
    transcript
  ].join("\n");

  try {
    const summary = await generateGeminiText(model, {
      contents: [
        {
          role: "user",
          parts: [{ text: summaryPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 1,
        maxOutputTokens: 256
      }
    }, signal);

    if (!summary) {
      return null;
    }

    return {
      summary: summary.trim(),
      sourceMessageCount: slice.length
    };
  } catch (error) {
    console.warn("Skipping automatic summarization:", error.message);
    return null;
  }
}

function sanitizeMessages(messages) {
  const sanitized = [];

  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }

    const parts = normalizeMessageParts(message);
    if (parts.length === 0) {
      continue;
    }

    sanitized.push({
      role: message.role,
      content: extractTextFromParts(parts),
      parts
    });
  }

  return sanitized;
}

function convertMessageToGeminiContent(message) {
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    return null;
  }

  const parts = Array.isArray(message.parts)
    ? message.parts.map(cloneGeminiPart).filter(Boolean)
    : [];

  if (parts.length === 0) {
    return null;
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts
  };
}

function buildConversationTranscript(messages) {
  return messages
    .map((message) => {
      const speaker = message.role === "assistant" ? "Assistant" : "User";
      const content = message.content || "[Image attached]";
      return `${speaker}: ${content}`;
    })
    .join("\n\n")
    .trim();
}

function normalizeMessageParts(message) {
  if (Array.isArray(message?.parts) && message.parts.length > 0) {
    const normalizedParts = [];

    for (const part of message.parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        normalizedParts.push({ text: part.text.trim() });
      }

      const inlineData = part?.inline_data;
      const mimeType = inlineData?.mime_type || inlineData?.mimeType;
      const data = inlineData?.data;

      if (typeof mimeType === "string" && mimeType.trim() && typeof data === "string" && data.trim()) {
        normalizedParts.push({
          inline_data: {
            mime_type: mimeType.trim(),
            data: data.trim()
          }
        });
      }
    }

    if (normalizedParts.length > 0) {
      return normalizedParts;
    }
  }

  const content = typeof message?.content === "string" ? message.content.trim() : "";
  return content ? [{ text: content }] : [];
}

function extractTextFromParts(parts) {
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

function cloneGeminiPart(part) {
  if (typeof part?.text === "string" && part.text.trim()) {
    return { text: part.text.trim() };
  }

  const inlineData = part?.inline_data;
  if (typeof inlineData?.mime_type === "string" && inlineData.mime_type.trim() && typeof inlineData?.data === "string" && inlineData.data.trim()) {
    return {
      inline_data: {
        mime_type: inlineData.mime_type.trim(),
        data: inlineData.data.trim()
      }
    };
  }

  return null;
}

function getInlineDataParts(messages) {
  return messages.flatMap((message) => {
    return Array.isArray(message.parts)
      ? message.parts.filter((part) => part?.inline_data)
      : [];
  });
}

function getLatestUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.content || "";
    }
  }

  return "";
}

function selectModel(userMessage, availableModels, options = {}) {
  const hasInlineImage = Boolean(options.hasInlineImage);
  const preferredModel = sanitizeRequestedModel(options.preferredModel || DEFAULT_CHAT_MODEL);
  const text = typeof userMessage === "string" ? userMessage : "";

  if (hasInlineImage && availableModels.includes(VISION_MODEL)) {
    return {
      model: VISION_MODEL,
      reason: "image detected"
    };
  }

  if (text.includes("```") && availableModels.includes(DEFAULT_CHAT_MODEL)) {
    return {
      model: DEFAULT_CHAT_MODEL,
      reason: "code block detected"
    };
  }

  if (text.length > 1000 && availableModels.includes(DEFAULT_CHAT_MODEL)) {
    return {
      model: DEFAULT_CHAT_MODEL,
      reason: "long content"
    };
  }

  if (/(translate|翻譯|summarize|summary|摘要)/i.test(text) && availableModels.includes(VISION_MODEL)) {
    return {
      model: VISION_MODEL,
      reason: "translation or summarization task"
    };
  }

  if (text.length > 0 && text.length < 100 && !/[?？]/.test(text) && availableModels.includes("gemini-3.1-flash-lite-preview")) {
    return {
      model: "gemini-3.1-flash-lite-preview",
      reason: "short casual prompt"
    };
  }

  return {
    model: preferredModel,
    reason: "using selected model"
  };
}

function sanitizeRequestedModel(model) {
  if (typeof model !== "string" || !model.trim() || isBlockedModel(model.trim())) {
    return DEFAULT_CHAT_MODEL;
  }

  return model.trim();
}

function isBlockedModel(model) {
  return model.startsWith("gemini-1.5-") || BLOCKED_MODELS.has(model);
}

function normalizeSummaryForPrompt(summary) {
  return summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("-")) {
        return line;
      }

      if (line.startsWith("*")) {
        return `-${line.slice(1)}`;
      }

      return `- ${line}`;
    })
    .join("\n");
}

async function generateGeminiText(model, payload, signal) {
  const response = await fetch(buildGeminiUrl(model, false), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    const parsed = tryParseJson(errorText);
    const message = parsed?.error?.message || errorText || "Gemini API request failed.";
    throw new Error(message);
  }

  const data = await response.json();
  if (data?.error?.message) {
    throw new Error(data.error.message);
  }

  return extractGeminiText(data);
}

function buildGeminiUrl(model, stream) {
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const separator = stream ? "&" : "?";
  return `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:${action}${separator}key=${encodeURIComponent(GEMINI_API_KEY)}`;
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
      .filter((name) => !isBlockedModel(name));

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

function serveStaticFile(requestPath, res) {
  const normalizedPath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, path.normalize(normalizedPath));

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
      if (body.length > MAX_REQUEST_BODY_SIZE) {
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

function ensureMemoryStore() {
  if (fs.existsSync(MEMORY_FILE)) {
    return;
  }

  fs.writeFileSync(MEMORY_FILE, JSON.stringify({ entries: [] }, null, 2));
}

function getMemoryEntries() {
  return withMemoryLock(() => {
    const store = readMemoryStoreUnsafe();
    return [...store.entries].sort((left, right) => {
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  });
}

function addMemory(input) {
  const summary = typeof input?.summary === "string" ? input.summary.trim() : "";
  if (!summary) {
    return null;
  }

  return withMemoryLock(() => {
    const store = readMemoryStoreUnsafe();
    const now = new Date().toISOString();
    const sourceMessageCount = clampInteger(input?.sourceMessageCount, 0, 10_000, 0);
    const existingIndex = store.entries.findIndex((entry) => entry.id === input?.id);

    if (existingIndex >= 0) {
      const existing = store.entries[existingIndex];
      const updated = {
        ...existing,
        summary,
        updatedAt: now,
        sourceMessageCount
      };
      store.entries[existingIndex] = updated;
      writeMemoryStoreUnsafe(store);
      return updated;
    }

    const entry = {
      id: createId(),
      summary,
      createdAt: now,
      updatedAt: now,
      sourceMessageCount
    };

    store.entries.push(entry);
    writeMemoryStoreUnsafe(store);
    return entry;
  });
}

function deleteMemoryEntry(id) {
  return withMemoryLock(() => {
    const store = readMemoryStoreUnsafe();
    const nextEntries = store.entries.filter((entry) => entry.id !== id);

    if (nextEntries.length === store.entries.length) {
      return false;
    }

    store.entries = nextEntries;
    writeMemoryStoreUnsafe(store);
    return true;
  });
}

function withMemoryLock(task) {
  acquireMemoryLock();

  try {
    return task();
  } finally {
    releaseMemoryLock();
  }
}

function acquireMemoryLock() {
  const deadline = Date.now() + 2_000;

  while (true) {
    try {
      fs.writeFileSync(MEMORY_LOCK_FILE, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() > deadline) {
        throw new Error("Timed out while waiting for memory lock.");
      }
    }
  }
}

function releaseMemoryLock() {
  try {
    fs.unlinkSync(MEMORY_LOCK_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function readMemoryStoreUnsafe() {
  ensureMemoryStore();

  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];

    return {
      entries: entries
        .map(normalizeMemoryEntry)
        .filter(Boolean)
    };
  } catch {
    return { entries: [] };
  }
}

function writeMemoryStoreUnsafe(store) {
  const normalizedStore = {
    entries: Array.isArray(store?.entries)
      ? store.entries.map(normalizeMemoryEntry).filter(Boolean)
      : []
  };

  fs.writeFileSync(MEMORY_FILE, `${JSON.stringify(normalizedStore, null, 2)}\n`);
}

function normalizeMemoryEntry(entry) {
  if (!entry || typeof entry.summary !== "string" || !entry.summary.trim()) {
    return null;
  }

  const createdAt = isIsoDateString(entry.createdAt) ? entry.createdAt : new Date().toISOString();
  const updatedAt = isIsoDateString(entry.updatedAt) ? entry.updatedAt : createdAt;

  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id : createId(),
    summary: entry.summary.trim(),
    createdAt,
    updatedAt,
    sourceMessageCount: clampInteger(entry.sourceMessageCount, 0, 10_000, 0)
  };
}

function isIsoDateString(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
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
