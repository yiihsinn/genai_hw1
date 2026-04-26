const STORAGE_KEY = "my-own-chatgpt-state-v1";
const SUMMARY_THRESHOLD = 20;

const defaultState = {
  model: "gemini-2.5-flash",
  customModel: "",
  systemPrompt: "You are a helpful AI assistant. Answer clearly and concisely.",
  temperature: 0.7,
  topP: 1,
  maxOutputTokens: 512,
  memoryTurns: 6,
  messages: []
};

const state = loadState();

const modelSelect = document.querySelector("#modelSelect");
const customModelInput = document.querySelector("#customModelInput");
const systemPromptInput = document.querySelector("#systemPromptInput");
const temperatureInput = document.querySelector("#temperatureInput");
const topPInput = document.querySelector("#topPInput");
const maxTokensInput = document.querySelector("#maxTokensInput");
const memoryTurnsInput = document.querySelector("#memoryTurnsInput");
const savePresetButton = document.querySelector("#savePresetButton");
const clearChatButton = document.querySelector("#clearChatButton");
const statusText = document.querySelector("#statusText");
const memoryBadge = document.querySelector("#memoryBadge");
const messageList = document.querySelector("#messageList");
const composerForm = document.querySelector("#composerForm");
const userInput = document.querySelector("#userInput");
const stopButton = document.querySelector("#stopButton");
const sendButton = document.querySelector("#sendButton");
const messageTemplate = document.querySelector("#messageTemplate");
const memoryInput = document.querySelector("#memoryInput");
const addMemoryButton = document.querySelector("#addMemoryButton");
const memoryList = document.querySelector("#memoryList");
const memoryCountBadge = document.querySelector("#memoryCountBadge");

let abortController = null;
let serverModels = [];
let lastFinishReason = "";
let memoryEntries = [];

boot();

async function boot() {
  bindEvents();
  syncControlsFromState();
  renderMessages();
  renderMemoryEntries();

  await Promise.all([
    loadHealth(),
    refreshMemoryEntries({ silent: true })
  ]);
}

function bindEvents() {
  composerForm.addEventListener("submit", handleSubmit);
  stopButton.addEventListener("click", stopStreaming);
  clearChatButton.addEventListener("click", clearChat);
  savePresetButton.addEventListener("click", saveSettingsOnly);
  addMemoryButton.addEventListener("click", handleAddMemory);

  memoryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddMemory();
    }
  });

  modelSelect.addEventListener("change", () => {
    state.model = modelSelect.value;
    persistState();
  });

  customModelInput.addEventListener("input", () => {
    state.customModel = customModelInput.value.trim();
    persistState();
  });

  systemPromptInput.addEventListener("input", () => {
    state.systemPrompt = systemPromptInput.value;
    persistState();
  });

  temperatureInput.addEventListener("input", () => {
    state.temperature = Number(temperatureInput.value || defaultState.temperature);
    persistState();
  });

  topPInput.addEventListener("input", () => {
    state.topP = Number(topPInput.value || defaultState.topP);
    persistState();
  });

  maxTokensInput.addEventListener("input", () => {
    state.maxOutputTokens = Number(maxTokensInput.value || defaultState.maxOutputTokens);
    persistState();
  });

  memoryTurnsInput.addEventListener("input", () => {
    state.memoryTurns = Number(memoryTurnsInput.value || defaultState.memoryTurns);
    updateMemoryBadge();
    persistState();
  });
}

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    serverModels = Array.isArray(data.models) ? data.models : [];
    populateModelOptions(serverModels);

    if (!data.hasApiKey) {
      statusText.textContent = "GEMINI_API_KEY is missing. Create a .env file first.";
      setComposerEnabled(false);
      return;
    }

    statusText.textContent = "Gemini API is ready. Persistent memory is available.";
    setComposerEnabled(true);
  } catch {
    statusText.textContent = "Cannot reach the local server. Make sure server.js is running.";
    populateModelOptions(serverModels);
    setComposerEnabled(false);
  }
}

function populateModelOptions(models) {
  const options = [...models];
  if (!options.includes(defaultState.model)) {
    options.unshift(defaultState.model);
  }

  modelSelect.innerHTML = "";

  for (const model of options) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSelect.appendChild(option);
  }

  if (state.model && options.includes(state.model)) {
    modelSelect.value = state.model;
  }
}

function syncControlsFromState() {
  modelSelect.value = state.model;
  customModelInput.value = state.customModel;
  systemPromptInput.value = state.systemPrompt;
  temperatureInput.value = String(state.temperature);
  topPInput.value = String(state.topP);
  maxTokensInput.value = String(state.maxOutputTokens);
  memoryTurnsInput.value = String(state.memoryTurns);
  updateMemoryBadge();
}

function setComposerEnabled(enabled) {
  userInput.disabled = !enabled;
  sendButton.disabled = !enabled;
}

function saveSettingsOnly() {
  syncStateFromControls();
  persistState();
  statusText.textContent = "Settings saved to localStorage.";
}

function clearChat() {
  stopStreaming();
  state.messages = [];
  persistState();
  renderMessages();
  statusText.textContent = "Chat history cleared.";
}

async function handleAddMemory() {
  const summary = memoryInput.value.trim();
  if (!summary) {
    return;
  }

  addMemoryButton.disabled = true;

  try {
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        summary,
        sourceMessageCount: 0
      })
    });

    if (!response.ok) {
      const error = await safeParseJson(response);
      throw new Error(error?.error || "Failed to save memory.");
    }

    memoryInput.value = "";
    await refreshMemoryEntries({ silent: true });
    statusText.textContent = "Persistent memory saved.";
  } catch (error) {
    statusText.textContent = error.message || "Failed to save memory.";
  } finally {
    addMemoryButton.disabled = false;
  }
}

async function handleDeleteMemory(id) {
  try {
    const response = await fetch(`/api/memory/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      const error = await safeParseJson(response);
      throw new Error(error?.error || "Failed to delete memory.");
    }

    await refreshMemoryEntries({ silent: true });
    statusText.textContent = "Memory entry deleted.";
  } catch (error) {
    statusText.textContent = error.message || "Failed to delete memory.";
  }
}

async function refreshMemoryEntries(options = {}) {
  const { silent = false } = options;

  try {
    const response = await fetch("/api/memory");
    if (!response.ok) {
      throw new Error("Failed to load memory.");
    }

    const data = await response.json();
    memoryEntries = Array.isArray(data) ? data : [];
    renderMemoryEntries();
  } catch (error) {
    if (!silent) {
      statusText.textContent = error.message || "Failed to load memory.";
    }
    memoryEntries = [];
    renderMemoryEntries();
  }
}

function renderMemoryEntries() {
  memoryList.innerHTML = "";
  memoryCountBadge.textContent = `${memoryEntries.length} entr${memoryEntries.length === 1 ? "y" : "ies"}`;

  if (memoryEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No persistent memory yet. Save preferences or let auto-summarization collect them after long chats.";
    memoryList.appendChild(empty);
    return;
  }

  memoryEntries.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "memory-card";

    const summary = document.createElement("p");
    summary.className = "memory-summary";
    summary.textContent = entry.summary;

    const footer = document.createElement("div");
    footer.className = "memory-footer";

    const meta = document.createElement("p");
    meta.className = "memory-meta";
    meta.textContent = formatMemoryMeta(entry);

    const button = document.createElement("button");
    button.className = "danger-button";
    button.type = "button";
    button.textContent = "Delete";
    button.addEventListener("click", () => {
      handleDeleteMemory(entry.id);
    });

    footer.append(meta, button);
    card.append(summary, footer);
    memoryList.appendChild(card);
  });
}

async function handleSubmit(event) {
  event.preventDefault();
  if (abortController) {
    return;
  }

  const prompt = userInput.value.trim();
  if (!prompt) {
    return;
  }

  syncStateFromControls();
  await refreshMemoryEntries({ silent: true });

  const selectedModel = state.customModel || state.model;
  const userMessage = { role: "user", content: prompt };
  const assistantMessage = { role: "assistant", content: "" };

  state.messages.push(userMessage, assistantMessage);
  persistState();
  renderMessages({ streamingIndex: state.messages.length - 1 });

  userInput.value = "";
  userInput.focus();
  setStreamingUi(true);
  statusText.textContent = `Streaming reply from ${selectedModel}...`;
  lastFinishReason = "";

  abortController = new AbortController();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: selectedModel,
        systemPrompt: buildSystemPrompt(state.systemPrompt, memoryEntries),
        temperature: state.temperature,
        topP: state.topP,
        maxOutputTokens: state.maxOutputTokens,
        messages: getRequestMessages(state.messages, state.memoryTurns)
      }),
      signal: abortController.signal
    });

    if (!response.ok || !response.body) {
      const data = await safeParseJson(response);
      throw new Error(data?.error || "Server request failed.");
    }

    await consumeEventStream(response, assistantMessage);

    if (!assistantMessage.content.trim()) {
      assistantMessage.content = "The model returned no content.";
    }

    statusText.textContent = lastFinishReason === "MAX_TOKENS"
      ? "Reply stopped because max output tokens was reached."
      : "Reply completed.";
  } catch (error) {
    if (error.name === "AbortError") {
      statusText.textContent = "Reply stopped.";
      if (!assistantMessage.content.trim()) {
        state.messages.pop();
        state.messages.pop();
      }
    } else {
      assistantMessage.content = assistantMessage.content.trim() || `Error: ${error.message}`;
      statusText.textContent = "Request failed. Check the API key, model name, or parameters.";
    }
  } finally {
    abortController = null;
    setStreamingUi(false);
    persistState();
    renderMessages();
  }
}

async function consumeEventStream(response, assistantMessage) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const boundaryIndex = buffer.indexOf("\n\n");
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const parsedEvent = parseSse(rawEvent);

      if (!parsedEvent) {
        continue;
      }

      if (parsedEvent.event === "memory_summary") {
        handleMemorySummaryEvent(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "token" && parsedEvent.data?.delta) {
        assistantMessage.content += parsedEvent.data.delta;
        persistState();
        renderMessages({ streamingIndex: state.messages.length - 1 });
      }

      if (parsedEvent.event === "error") {
        throw new Error(parsedEvent.data?.message || "Streaming failed.");
      }

      if (parsedEvent.event === "finish") {
        lastFinishReason = parsedEvent.data?.reason || "";
      }

      if (parsedEvent.event === "done") {
        return;
      }
    }
  }
}

function handleMemorySummaryEvent(data) {
  const removedCount = Number(data?.sourceMessageCount || 0);
  if (removedCount > 0) {
    state.messages.splice(0, removedCount);
    persistState();
    renderMessages({ streamingIndex: state.messages.length - 1 });
  }

  refreshMemoryEntries({ silent: true });
  statusText.textContent = "Older messages were summarized into persistent memory.";
}

function parseSse(rawEvent) {
  const lines = rawEvent.split("\n");
  let event = "message";
  let data = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }

  if (!data) {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(data)
    };
  } catch {
    return null;
  }
}

function stopStreaming() {
  if (abortController) {
    abortController.abort();
  }
}

function setStreamingUi(active) {
  stopButton.disabled = !active;
  sendButton.disabled = active;
  userInput.disabled = active;
}

function renderMessages(options = {}) {
  const { streamingIndex = -1 } = options;
  messageList.innerHTML = "";

  if (state.messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "message-empty";
    empty.textContent = "Start a new conversation. Adjust the model, system prompt, and parameters before sending your first message.";
    messageList.appendChild(empty);
    updateMemoryBadge();
    return;
  }

  state.messages.forEach((message, index) => {
    const node = messageTemplate.content.firstElementChild.cloneNode(true);
    const roleTag = node.querySelector(".role-tag");
    const body = node.querySelector(".message-body");

    node.classList.add(message.role);
    if (index === streamingIndex) {
      node.classList.add("streaming");
    }

    roleTag.textContent = message.role === "user" ? "You" : "Assistant";
    body.textContent = message.content;
    messageList.appendChild(node);
  });

  updateMemoryBadge();
  messageList.scrollTop = messageList.scrollHeight;
}

function updateMemoryBadge() {
  const turnCount = Math.ceil(state.messages.length / 2);
  memoryBadge.textContent = `Memory ${turnCount} turns`;
}

function getRequestMessages(messages, memoryTurns) {
  if (messages.length > SUMMARY_THRESHOLD) {
    return messages;
  }

  const limit = Math.max(1, Number(memoryTurns) || defaultState.memoryTurns) * 2;
  return messages.slice(-limit);
}

function buildSystemPrompt(basePrompt, entries) {
  const blocks = [];
  const trimmedBasePrompt = typeof basePrompt === "string" ? basePrompt.trim() : "";
  const persistentMemoryBlock = buildPersistentMemoryBlock(entries);

  if (trimmedBasePrompt) {
    blocks.push(trimmedBasePrompt);
  }

  if (persistentMemoryBlock) {
    blocks.push(`[Persistent Memory]\n${persistentMemoryBlock}`);
  }

  return blocks.join("\n\n");
}

function buildPersistentMemoryBlock(entries) {
  const lines = [];

  entries.forEach((entry) => {
    const summaryLines = String(entry.summary || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    summaryLines.forEach((line) => {
      if (line.startsWith("-")) {
        lines.push(line);
      } else if (line.startsWith("*")) {
        lines.push(`-${line.slice(1)}`);
      } else {
        lines.push(`- ${line}`);
      }
    });
  });

  return lines.join("\n");
}

function syncStateFromControls() {
  state.model = modelSelect.value;
  state.customModel = customModelInput.value.trim();
  state.systemPrompt = systemPromptInput.value;
  state.temperature = Number(temperatureInput.value || defaultState.temperature);
  state.topP = Number(topPInput.value || defaultState.topP);
  state.maxOutputTokens = Number(maxTokensInput.value || defaultState.maxOutputTokens);
  state.memoryTurns = Number(memoryTurnsInput.value || defaultState.memoryTurns);
  persistState();
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return structuredClone(defaultState);
    }

    return {
      ...structuredClone(defaultState),
      ...JSON.parse(raw)
    };
  } catch {
    return structuredClone(defaultState);
  }
}

function formatMemoryMeta(entry) {
  const parts = [];

  if (entry.sourceMessageCount > 0) {
    parts.push(`From ${entry.sourceMessageCount} messages`);
  } else {
    parts.push("Manual");
  }

  if (entry.updatedAt) {
    parts.push(new Date(entry.updatedAt).toLocaleString());
  }

  return parts.join(" • ");
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
