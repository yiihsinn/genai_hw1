const LEGACY_STORAGE_KEY = "my-own-chatgpt-state-v1";
const ACTIVE_CHAT_KEY = "my-own-chatgpt-active-chat-v2";
const CHAT_KEY_PREFIX = "chat_";
const SUMMARY_THRESHOLD = 20;
const IMAGE_BASE64_LIMIT = 13_000_000;

const defaultState = {
  model: "gemini-2.5-flash",
  customModel: "",
  autoRoute: false,
  toolsEnabled: false,
  systemPrompt: "You are a helpful AI assistant. Answer clearly and concisely.",
  temperature: 0.7,
  topP: 1,
  maxOutputTokens: 512,
  memoryTurns: 6,
  messages: [],
  createdAt: "",
  updatedAt: ""
};

let activeChatId = initializeActiveChatId();
let state = loadChatState(activeChatId);

const chatPanel = document.querySelector(".chat-panel");
const runtimeNotice = document.querySelector("#runtimeNotice");
const chatSessionList = document.querySelector("#chatSessionList");
const newChatButton = document.querySelector("#newChatButton");
const exportButton = document.querySelector("#exportButton");
const exportMenu = document.querySelector("#exportMenu");
const exportJsonButton = document.querySelector("#exportJsonButton");
const exportMarkdownButton = document.querySelector("#exportMarkdownButton");
const modelField = document.querySelector("#modelField");
const customModelField = document.querySelector("#customModelField");
const modelSelect = document.querySelector("#modelSelect");
const customModelInput = document.querySelector("#customModelInput");
const autoRouteToggle = document.querySelector("#autoRouteToggle");
const toolsToggle = document.querySelector("#toolsToggle");
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
const attachImageButton = document.querySelector("#attachImageButton");
const voiceInputButton = document.querySelector("#voiceInputButton");
const imageInput = document.querySelector("#imageInput");
const pendingImageContainer = document.querySelector("#pendingImageContainer");

let abortController = null;
let serverModels = [];
let lastFinishReason = "";
let memoryEntries = [];
let pendingImage = null;
let dragDepth = 0;
let streamingAssistantMessage = null;
let editingMessageIndex = -1;
let speechRecognition = null;
let isListening = false;

boot();

async function boot() {
  bindEvents();
  setupVoiceInput();
  syncControlsFromState();
  renderSessionList();
  renderMessages();
  renderMemoryEntries();
  renderPendingImage();

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
  attachImageButton.addEventListener("click", () => imageInput.click());
  imageInput.addEventListener("change", handleImageInputChange);
  newChatButton.addEventListener("click", createNewChat);
  exportButton.addEventListener("click", toggleExportMenu);
  exportJsonButton.addEventListener("click", exportCurrentChatAsJson);
  exportMarkdownButton.addEventListener("click", exportCurrentChatAsMarkdown);

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".export-shell")) {
      closeExportMenu();
    }
  });

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

  autoRouteToggle.addEventListener("change", () => {
    state.autoRoute = autoRouteToggle.checked;
    updateModelControlsVisibility();
    persistState();
  });

  toolsToggle.addEventListener("change", () => {
    state.toolsEnabled = toolsToggle.checked;
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

  bindDragAndDrop();
}

function bindDragAndDrop() {
  const hasFileTransfer = (event) => {
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  };

  const handleDragEnter = (event) => {
    if (!hasFileTransfer(event)) {
      return;
    }

    dragDepth += 1;
    event.preventDefault();
    chatPanel.classList.add("drag-active");
  };

  const handleDragLeave = (event) => {
    if (!hasFileTransfer(event)) {
      return;
    }

    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      chatPanel.classList.remove("drag-active");
    }
  };

  const handleDragOver = (event) => {
    if (!hasFileTransfer(event)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = async (event) => {
    if (!event.dataTransfer?.files?.length) {
      return;
    }

    event.preventDefault();
    dragDepth = 0;
    chatPanel.classList.remove("drag-active");
    await useSelectedImageFile(event.dataTransfer.files[0]);
  };

  chatPanel.addEventListener("dragenter", handleDragEnter);
  chatPanel.addEventListener("dragleave", handleDragLeave);
  chatPanel.addEventListener("dragover", handleDragOver);
  chatPanel.addEventListener("drop", handleDrop);
}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceInputButton.disabled = true;
    voiceInputButton.title = "Speech not supported in this browser";
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = navigator.language || "en-US";
  speechRecognition.interimResults = false;
  speechRecognition.maxAlternatives = 1;

  voiceInputButton.addEventListener("click", () => {
    if (!speechRecognition || isListening) {
      return;
    }

    try {
      speechRecognition.start();
    } catch {
      statusText.textContent = "Voice input could not start.";
    }
  });

  speechRecognition.addEventListener("start", () => {
    isListening = true;
    statusText.textContent = "Listening for speech input...";
  });

  speechRecognition.addEventListener("end", () => {
    isListening = false;
    statusText.textContent = "Voice input ready.";
  });

  speechRecognition.addEventListener("result", (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();

    if (transcript) {
      userInput.value = transcript;
      userInput.focus();
      statusText.textContent = "Speech captured. Review and send when ready.";
    }
  });

  speechRecognition.addEventListener("error", (event) => {
    isListening = false;
    statusText.textContent = event.error === "not-allowed"
      ? "Microphone permission was denied."
      : "Voice input failed.";
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
  autoRouteToggle.checked = Boolean(state.autoRoute);
  toolsToggle.checked = Boolean(state.toolsEnabled);
  systemPromptInput.value = state.systemPrompt;
  temperatureInput.value = String(state.temperature);
  topPInput.value = String(state.topP);
  maxTokensInput.value = String(state.maxOutputTokens);
  memoryTurnsInput.value = String(state.memoryTurns);
  updateModelControlsVisibility();
  updateMemoryBadge();
}

function updateModelControlsVisibility() {
  const hidden = Boolean(state.autoRoute);
  modelField.hidden = hidden;
  customModelField.hidden = hidden;
}

function setComposerEnabled(enabled) {
  userInput.disabled = !enabled;
  sendButton.disabled = !enabled;
  attachImageButton.disabled = !enabled;
  if (!speechRecognition) {
    voiceInputButton.disabled = true;
  } else {
    voiceInputButton.disabled = !enabled;
  }
}

function saveSettingsOnly() {
  syncStateFromControls();
  persistState();
  statusText.textContent = "Settings saved to localStorage.";
}

function clearChat() {
  stopStreaming();
  state.messages = [];
  editingMessageIndex = -1;
  clearPendingImage();
  persistState();
  renderMessages();
  renderSessionList();
  statusText.textContent = "Chat history cleared.";
}

function createNewChat() {
  stopStreaming();
  closeExportMenu();
  clearPendingImage();
  hideRuntimeNotice();
  editingMessageIndex = -1;
  activeChatId = createChatId();
  state = createDefaultState();
  persistState();
  syncControlsFromState();
  renderMessages();
  renderSessionList();
  userInput.value = "";
  userInput.focus();
  statusText.textContent = "Started a new chat.";
}

function switchChat(chatId) {
  if (!chatId || chatId === activeChatId) {
    return;
  }

  stopStreaming();
  closeExportMenu();
  clearPendingImage();
  hideRuntimeNotice();
  editingMessageIndex = -1;
  activeChatId = chatId;
  localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId);
  state = loadChatState(chatId);
  syncControlsFromState();
  renderMessages();
  renderSessionList();
  userInput.value = "";
  statusText.textContent = "Switched chat.";
}

function deleteChat(chatId) {
  if (!chatId) {
    return;
  }

  stopStreaming();
  localStorage.removeItem(chatId);

  const remainingSessions = listStoredChats();
  if (chatId === activeChatId) {
    if (remainingSessions.length === 0) {
      activeChatId = createChatId();
      state = createDefaultState();
      persistState();
    } else {
      activeChatId = remainingSessions[0].id;
      state = loadChatState(activeChatId);
      localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId);
    }

    clearPendingImage();
    hideRuntimeNotice();
    editingMessageIndex = -1;
    syncControlsFromState();
    renderMessages();
  }

  renderSessionList();
  statusText.textContent = "Chat deleted.";
}

function renderSessionList() {
  chatSessionList.innerHTML = "";
  const sessions = listStoredChats();

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No chats yet. Start a new conversation to create one.";
    chatSessionList.appendChild(empty);
    return;
  }

  sessions.forEach((session) => {
    const item = document.createElement("article");
    item.className = "chat-session-item";
    if (session.id === activeChatId) {
      item.classList.add("active");
    }

    const button = document.createElement("button");
    button.className = "chat-session-button";
    button.type = "button";
    button.addEventListener("click", () => switchChat(session.id));

    const title = document.createElement("p");
    title.className = "chat-session-title";
    title.textContent = session.title;

    const meta = document.createElement("p");
    meta.className = "chat-session-meta";
    meta.textContent = session.updatedAt
      ? new Date(session.updatedAt).toLocaleString()
      : "Not saved yet";

    button.append(title, meta);

    const removeButton = document.createElement("button");
    removeButton.className = "danger-button";
    removeButton.type = "button";
    removeButton.textContent = "Delete";
    removeButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(session.id);
    });

    item.append(button, removeButton);
    chatSessionList.appendChild(item);
  });
}

function toggleExportMenu() {
  exportMenu.hidden = !exportMenu.hidden;
}

function closeExportMenu() {
  exportMenu.hidden = true;
}

function exportCurrentChatAsJson() {
  closeExportMenu();
  downloadTextFile("chat-export.json", JSON.stringify(state.messages, null, 2), "application/json");
}

function exportCurrentChatAsMarkdown() {
  closeExportMenu();
  const markdown = state.messages
    .map((message) => `## ${formatExportRole(message.role)}\n${message.content || ""}`.trim())
    .join("\n\n");
  downloadTextFile("chat-export.md", `${markdown}\n`, "text/markdown");
}

function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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

async function handleImageInputChange(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  await useSelectedImageFile(file);
}

async function useSelectedImageFile(file) {
  if (!file.type.startsWith("image/")) {
    statusText.textContent = "Only image files are supported.";
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const commaIndex = dataUrl.indexOf(",");
    const base64Data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "";
    const mimeType = file.type || extractMimeTypeFromDataUrl(dataUrl) || "image/jpeg";

    if (!base64Data) {
      throw new Error("Failed to read image data.");
    }

    if (base64Data.length > IMAGE_BASE64_LIMIT) {
      throw new Error("Image is larger than the 10MB inline upload limit.");
    }

    pendingImage = {
      name: file.name,
      mimeType,
      base64Data,
      dataUrl
    };

    renderPendingImage();
    statusText.textContent = "Image attached. Add a prompt and send it with the message.";
  } catch (error) {
    clearPendingImage();
    statusText.textContent = error.message || "Failed to load image.";
  }
}

function renderPendingImage() {
  pendingImageContainer.innerHTML = "";

  if (!pendingImage) {
    pendingImageContainer.hidden = true;
    return;
  }

  pendingImageContainer.hidden = false;

  const card = document.createElement("div");
  card.className = "pending-image-card";

  const preview = document.createElement("img");
  preview.src = pendingImage.dataUrl;
  preview.alt = pendingImage.name || "Pending image preview";

  const copy = document.createElement("div");
  copy.className = "pending-image-copy";

  const title = document.createElement("p");
  title.className = "pending-image-title";
  title.textContent = pendingImage.name || "Attached image";

  const meta = document.createElement("p");
  meta.className = "pending-image-meta";
  meta.textContent = `${pendingImage.mimeType} • ${Math.round(pendingImage.base64Data.length / 1024)} KB base64`;

  const removeButton = document.createElement("button");
  removeButton.className = "remove-image-button";
  removeButton.type = "button";
  removeButton.textContent = "✕";
  removeButton.addEventListener("click", clearPendingImage);

  copy.append(title, meta);
  card.append(preview, copy, removeButton);
  pendingImageContainer.appendChild(card);
}

function clearPendingImage() {
  pendingImage = null;
  imageInput.value = "";
  renderPendingImage();
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

  closeExportMenu();
  syncStateFromControls();
  await refreshMemoryEntries({ silent: true });
  hideRuntimeNotice();
  editingMessageIndex = -1;

  const imageForMessage = pendingImage ? { ...pendingImage } : null;
  const userMessage = createUserMessage(prompt, imageForMessage);
  const assistantMessage = { role: "assistant", content: "" };

  state.messages.push(userMessage, assistantMessage);
  streamingAssistantMessage = assistantMessage;
  clearPendingImage();
  persistState();
  renderMessages({ streamingIndex: state.messages.length - 1 });
  renderSessionList();

  userInput.value = "";
  userInput.focus();
  await requestAssistantReply(assistantMessage);
}

async function requestAssistantReply(assistantMessage) {
  const selectedModel = state.customModel || state.model;

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
        autoRoute: state.autoRoute,
        tools: state.toolsEnabled,
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
        state.messages = state.messages.filter((message) => message !== assistantMessage);
      }
    } else {
      assistantMessage.content = assistantMessage.content.trim() || `Error: ${error.message}`;
      statusText.textContent = "Request failed. Check the API key, model name, or parameters.";
    }
  } finally {
    abortController = null;
    streamingAssistantMessage = null;
    setStreamingUi(false);
    persistState();
    renderMessages();
    renderSessionList();
  }
}

function createUserMessage(prompt, image) {
  const message = {
    role: "user",
    content: prompt
  };

  if (image) {
    message.parts = [
      { text: prompt },
      {
        inline_data: {
          mime_type: image.mimeType,
          data: image.base64Data
        }
      }
    ];
    message.imagePreviewUrl = image.dataUrl;
    message.imageName = image.name;
    message.imageMimeType = image.mimeType;
  }

  return message;
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

      if (parsedEvent.event === "model_override") {
        handleModelOverrideEvent(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "routing") {
        handleRoutingEvent(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "tool_call") {
        handleToolCallEvent(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "tool_result") {
        handleToolResultEvent(parsedEvent.data);
        continue;
      }

      if (parsedEvent.event === "token" && parsedEvent.data?.delta) {
        assistantMessage.content += parsedEvent.data.delta;
        persistState();
        renderMessages({ streamingIndex: state.messages.indexOf(assistantMessage) });
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
  trimSummarizedMessages(Number(data?.sourceMessageCount || 0));
  refreshMemoryEntries({ silent: true });
  statusText.textContent = "Older messages were summarized into persistent memory.";
}

function trimSummarizedMessages(chatMessageCount) {
  if (chatMessageCount <= 0) {
    return;
  }

  let seenChatMessages = 0;
  let removeUntilIndex = -1;

  for (let index = 0; index < state.messages.length; index += 1) {
    if (isChatMessage(state.messages[index])) {
      seenChatMessages += 1;
    }

    if (seenChatMessages >= chatMessageCount) {
      removeUntilIndex = index;
      break;
    }
  }

  if (removeUntilIndex >= 0) {
    state.messages.splice(0, removeUntilIndex + 1);
    persistState();
    renderMessages({ streamingIndex: state.messages.indexOf(streamingAssistantMessage) });
  }
}

function handleModelOverrideEvent(data) {
  if (!data?.model) {
    return;
  }

  showRuntimeNotice(`Using ${data.model} because ${data.reason || "an image was attached"}.`);
}

function handleRoutingEvent(data) {
  if (!data?.model) {
    return;
  }

  showRuntimeNotice(`→ Routed to ${data.model} (${data.reason || "automatic routing"})`);
}

function handleToolCallEvent(data) {
  const toolMessage = {
    role: "tool",
    toolName: data?.name || "tool",
    toolState: "calling",
    content: `⚙️ Calling tool: ${formatToolInvocation(data?.name, data?.args)}`
  };

  insertTimelineMessage(toolMessage);
}

function handleToolResultEvent(data) {
  const resultText = formatToolResult(data?.result);
  const existing = [...state.messages]
    .reverse()
    .find((message) => message.role === "tool" && message.toolState === "calling" && message.toolName === data?.name);

  if (existing) {
    existing.toolState = "done";
    existing.content = `✅ ${data?.name || "tool"} → ${resultText}`;
    persistState();
    renderMessages({ streamingIndex: state.messages.indexOf(streamingAssistantMessage) });
    return;
  }

  insertTimelineMessage({
    role: "tool",
    toolName: data?.name || "tool",
    toolState: "done",
    content: `✅ ${data?.name || "tool"} → ${resultText}`
  });
}

function insertTimelineMessage(message) {
  const assistantIndex = streamingAssistantMessage ? state.messages.indexOf(streamingAssistantMessage) : -1;

  if (assistantIndex >= 0) {
    state.messages.splice(assistantIndex, 0, message);
    persistState();
    renderMessages({ streamingIndex: state.messages.indexOf(streamingAssistantMessage) });
    return;
  }

  state.messages.push(message);
  persistState();
  renderMessages();
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
  attachImageButton.disabled = active;
  if (speechRecognition) {
    voiceInputButton.disabled = active;
  }
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
    const editButton = node.querySelector(".message-edit-button");
    const body = node.querySelector(".message-body");

    node.classList.add(message.role);
    if (index === streamingIndex) {
      node.classList.add("streaming");
    }

    roleTag.textContent = message.role === "user"
      ? "You"
      : message.role === "tool"
        ? "Tool"
        : "Assistant";

    if (message.role === "user" && !abortController) {
      editButton.hidden = false;
      editButton.addEventListener("click", () => {
        editingMessageIndex = index;
        renderMessages();
      });
    } else {
      editButton.hidden = true;
    }

    renderMessageBody(body, message, index);
    messageList.appendChild(node);
  });

  updateMemoryBadge();
  messageList.scrollTop = messageList.scrollHeight;
}

function renderMessageBody(body, message, index) {
  body.innerHTML = "";

  if (editingMessageIndex === index && message.role === "user") {
    renderEditableMessage(body, message, index);
    return;
  }

  if (message.imagePreviewUrl) {
    const image = document.createElement("img");
    image.className = "message-image";
    image.src = message.imagePreviewUrl;
    image.alt = message.imageName || "Uploaded image";
    body.appendChild(image);
  }

  if (message.content) {
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = message.content;
    body.appendChild(text);
  }
}

function renderEditableMessage(body, message, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "message-edit-area";

  const textarea = document.createElement("textarea");
  textarea.value = message.content || "";
  textarea.rows = 5;

  const buttonRow = document.createElement("div");
  buttonRow.className = "composer-actions";

  const regenerateButton = document.createElement("button");
  regenerateButton.className = "primary-button";
  regenerateButton.type = "button";
  regenerateButton.textContent = "✓ Regenerate";
  regenerateButton.addEventListener("click", async () => {
    await regenerateFromMessage(index, textarea.value);
  });

  const cancelButton = document.createElement("button");
  cancelButton.className = "secondary-button";
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => {
    editingMessageIndex = -1;
    renderMessages();
  });

  buttonRow.append(regenerateButton, cancelButton);
  wrapper.append(textarea, buttonRow);
  body.appendChild(wrapper);
}

async function regenerateFromMessage(index, nextText) {
  if (abortController) {
    return;
  }

  const trimmedText = nextText.trim();
  if (!trimmedText) {
    return;
  }

  closeExportMenu();
  syncStateFromControls();
  await refreshMemoryEntries({ silent: true });
  hideRuntimeNotice();

  const message = state.messages[index];
  if (!message || message.role !== "user") {
    return;
  }

  updateUserMessageText(message, trimmedText);
  state.messages = state.messages.slice(0, index + 1);
  editingMessageIndex = -1;

  const assistantMessage = { role: "assistant", content: "" };
  state.messages.push(assistantMessage);
  streamingAssistantMessage = assistantMessage;

  persistState();
  renderMessages({ streamingIndex: state.messages.length - 1 });
  renderSessionList();
  await requestAssistantReply(assistantMessage);
}

function updateUserMessageText(message, nextText) {
  message.content = nextText;

  if (!Array.isArray(message.parts)) {
    return;
  }

  const inlinePart = message.parts.find((part) => part?.inline_data);
  message.parts = inlinePart
    ? [{ text: nextText }, inlinePart]
    : [{ text: nextText }];
}

function updateMemoryBadge() {
  const turnCount = Math.ceil(state.messages.filter(isChatMessage).length / 2);
  memoryBadge.textContent = `Memory ${turnCount} turns`;
}

function getRequestMessages(messages, memoryTurns) {
  const chatMessages = messages.filter(isChatMessage);
  const selectedMessages = chatMessages.length > SUMMARY_THRESHOLD
    ? chatMessages
    : chatMessages.slice(-Math.max(1, Number(memoryTurns) || defaultState.memoryTurns) * 2);

  return selectedMessages.map((message) => {
    const payload = {
      role: message.role,
      content: message.content
    };

    if (Array.isArray(message.parts) && message.parts.length > 0) {
      payload.parts = message.parts.map((part) => {
        if (part?.inline_data) {
          return {
            inline_data: {
              mime_type: part.inline_data.mime_type,
              data: part.inline_data.data
            }
          };
        }

        return {
          text: part?.text || ""
        };
      });
    }

    return payload;
  });
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
  state.autoRoute = autoRouteToggle.checked;
  state.toolsEnabled = toolsToggle.checked;
  state.systemPrompt = systemPromptInput.value;
  state.temperature = Number(temperatureInput.value || defaultState.temperature);
  state.topP = Number(topPInput.value || defaultState.topP);
  state.maxOutputTokens = Number(maxTokensInput.value || defaultState.maxOutputTokens);
  state.memoryTurns = Number(memoryTurnsInput.value || defaultState.memoryTurns);
  persistState();
}

function persistState() {
  state.updatedAt = new Date().toISOString();
  if (!state.createdAt) {
    state.createdAt = state.updatedAt;
  }

  localStorage.setItem(activeChatId, JSON.stringify(serializeState()));
  localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId);
}

function serializeState() {
  return {
    ...state,
    messages: state.messages.map((message) => {
      const serialized = {
        role: message.role,
        content: message.content
      };

      if (message.toolName) {
        serialized.toolName = message.toolName;
      }

      if (message.toolState) {
        serialized.toolState = message.toolState;
      }

      if (Array.isArray(message.parts)) {
        const parts = [];

        message.parts.forEach((part) => {
          if (typeof part?.text === "string" && part.text.trim()) {
            parts.push({ text: part.text });
          }
        });

        if (parts.length > 0) {
          serialized.parts = parts;
        }
      }

      return serialized;
    })
  };
}

function initializeActiveChatId() {
  migrateLegacyStateIfNeeded();

  let chatId = localStorage.getItem(ACTIVE_CHAT_KEY);
  if (chatId && localStorage.getItem(chatId)) {
    return chatId;
  }

  const sessions = listStoredChats();
  if (sessions.length > 0) {
    localStorage.setItem(ACTIVE_CHAT_KEY, sessions[0].id);
    return sessions[0].id;
  }

  chatId = createChatId();
  localStorage.setItem(chatId, JSON.stringify(createDefaultState()));
  localStorage.setItem(ACTIVE_CHAT_KEY, chatId);
  return chatId;
}

function migrateLegacyStateIfNeeded() {
  const hasChatSessions = Object.keys(localStorage).some((key) => key.startsWith(CHAT_KEY_PREFIX));
  if (hasChatSessions) {
    return;
  }

  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacyRaw) {
    return;
  }

  try {
    const legacyState = {
      ...createDefaultState(),
      ...JSON.parse(legacyRaw)
    };

    const chatId = createChatId();
    localStorage.setItem(chatId, JSON.stringify(legacyState));
    localStorage.setItem(ACTIVE_CHAT_KEY, chatId);
  } catch {
    const chatId = createChatId();
    localStorage.setItem(chatId, JSON.stringify(createDefaultState()));
    localStorage.setItem(ACTIVE_CHAT_KEY, chatId);
  }
}

function loadChatState(chatId) {
  try {
    const raw = localStorage.getItem(chatId);
    if (!raw) {
      return createDefaultState();
    }

    const parsed = JSON.parse(raw);
    return {
      ...createDefaultState(),
      ...parsed,
      messages: Array.isArray(parsed?.messages) ? parsed.messages : []
    };
  } catch {
    return createDefaultState();
  }
}

function createDefaultState() {
  const now = new Date().toISOString();
  return {
    ...structuredClone(defaultState),
    createdAt: now,
    updatedAt: now
  };
}

function createChatId() {
  return `${CHAT_KEY_PREFIX}${Date.now()}`;
}

function listStoredChats() {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(CHAT_KEY_PREFIX))
    .map((key) => {
      const chatState = loadChatState(key);
      return {
        id: key,
        title: buildChatTitle(chatState),
        updatedAt: chatState.updatedAt || chatState.createdAt || ""
      };
    })
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
}

function buildChatTitle(chatState) {
  const firstUserMessage = (chatState.messages || []).find((message) => message.role === "user" && typeof message.content === "string" && message.content.trim());
  if (!firstUserMessage) {
    return "New Chat";
  }

  const text = firstUserMessage.content.trim();
  return text.length > 30 ? `${text.slice(0, 30)}...` : text;
}

function showRuntimeNotice(message) {
  runtimeNotice.hidden = false;
  runtimeNotice.textContent = message;
}

function hideRuntimeNotice() {
  runtimeNotice.hidden = true;
  runtimeNotice.textContent = "";
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read image file."));
    reader.readAsDataURL(file);
  });
}

function extractMimeTypeFromDataUrl(dataUrl) {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] || "";
}

function isChatMessage(message) {
  return message?.role === "user" || message?.role === "assistant";
}

function formatToolInvocation(name, args) {
  return `${name || "tool"}(${JSON.stringify(args || {})})`;
}

function formatToolResult(result) {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}

function formatExportRole(role) {
  if (role === "user") {
    return "User";
  }

  if (role === "assistant") {
    return "Assistant";
  }

  return "Tool";
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
