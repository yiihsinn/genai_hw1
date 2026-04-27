const http = require("http");
const path = require("path");
const { createRequestHandler } = require("./lib/router");
const { createMemoryStore } = require("./lib/memory");
const tools = require("./lib/tools");
const sse = require("./lib/sse");
const { createGeminiService } = require("./lib/gemini");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MEMORY_FILE = path.join(__dirname, "memory.json");

const memoryStore = createMemoryStore(MEMORY_FILE);
const geminiService = createGeminiService({
  apiKey: process.env.NIM_API_KEY || process.env.NVIDIA_API_KEY,
  apiBase: "https://integrate.api.nvidia.com/v1",
  modelOptions: [
    "minimax/minimax-m2.7",
    "moonshotai/kimi-k2.5",
    "meta/llama-3.3-70b-instruct",
    "microsoft/phi-4-reasoning-plus",
    "deepseek-ai/deepseek-r1-0528",
    "thudm/glm-5-plus"
  ],
  defaultChatModel: "minimax/minimax-m2.7",
  visionModel: "meta/llama-3.3-70b-instruct",
  liteModel: "microsoft/phi-4-reasoning-plus",
  longContextModel: "moonshotai/kimi-k2.5",
  translationModel: "microsoft/phi-4-reasoning-plus",
  blockedModels: new Set(),
  summaryThreshold: 20,
  summaryBatchSize: 10,
  maxRequestBodySize: 16_000_000,
  inlineDataLimit: 13_000_000,
  tools,
  memoryStore,
  sse
});

const server = http.createServer(createRequestHandler({
  publicDir: PUBLIC_DIR,
  memoryStore,
  geminiService,
  tools
}));

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = {
  server
};

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!require("fs").existsSync(envPath)) {
    return;
  }

  const fileContent = require("fs").readFileSync(envPath, "utf8");
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
