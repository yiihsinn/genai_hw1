import {
  initializeActiveChatId,
  loadChatState,
  createDefaultState,
  createChatId,
  persistChatState,
  listStoredChats,
  isChatMessage,
  getRequestMessages,
  defaultState,
  getMessageText,
  messageHasImage
} from "./modules/state.js";
import {
  getHealth,
  getMemoryEntries,
  saveMemoryEntry,
  deleteMemoryEntry,
  requestChatStream,
  consumeSse,
  safeParseJson
} from "./modules/api.js";
import {
  populateModelOptions,
  updateMemoryBadge,
  renderSessionList,
  renderMessages as renderMessagesView,
  renderPendingImage,
  showRuntimeNotice,
  hideRuntimeNotice,
  setComposerEnabled,
  setStreamingUi
} from "./modules/ui.js";
import { renderMemoryEntries as renderMemoryEntriesView } from "./modules/memory-ui.js";
import {
  createToolCallMessage,
  applyToolResult,
  createCompletedToolMessage
} from "./modules/tools-ui.js";

const IMAGE_BASE64_LIMIT = 13_000_000;

let activeChatId = initializeActiveChatId();
let state = loadChatState(activeChatId);

const elements = {
  chatPanel: document.querySelector(".chat-panel"),
  runtimeNotice: document.querySelector("#runtimeNotice"),
  chatSessionList: document.querySelector("#chatSessionList"),
  newChatButton: document.querySelector("#newChatButton"),
  exportButton: document.querySelector("#exportButton"),
  exportMenu: document.querySelector("#exportMenu"),
  exportJsonButton: document.querySelector("#exportJsonButton"),
  exportMarkdownButton: document.querySelector("#exportMarkdownButton"),
  modelField: document.querySelector("#modelField"),
  customModelField: document.querySelector("#customModelField"),
  modelSelect: document.querySelector("#modelSelect"),
  customModelInput: document.querySelector("#customModelInput"),
  autoRouteToggle: document.querySelector("#autoRouteToggle"),
  toolsToggle: document.querySelector("#toolsToggle"),
  systemPromptInput: document.querySelector("#systemPromptInput"),
  temperatureInput: document.querySelector("#temperatureInput"),
  topPInput: document.querySelector("#topPInput"),
  maxTokensInput: document.querySelector("#maxTokensInput"),
  memoryTurnsInput: document.querySelector("#memoryTurnsInput"),
  savePresetButton: document.querySelector("#savePresetButton"),
  clearChatButton: document.querySelector("#clearChatButton"),
  statusText: document.querySelector("#statusText"),
  memoryBadge: document.querySelector("#memoryBadge"),
  messageList: document.querySelector("#messageList"),
  composerForm: document.querySelector("#composerForm"),
  userInput: document.querySelector("#userInput"),
  stopButton: document.querySelector("#stopButton"),
  sendButton: document.querySelector("#sendButton"),
  messageTemplate: document.querySelector("#messageTemplate"),
  memoryTypeSelect: document.querySelector("#memoryTypeSelect"),
  memoryInput: document.querySelector("#memoryInput"),
  addMemoryButton: document.querySelector("#addMemoryButton"),
  memoryList: document.querySelector("#memoryList"),
  memoryCountBadge: document.querySelector("#memoryCountBadge"),
  attachImageButton: document.querySelector("#attachImageButton"),
  voiceInputButton: document.querySelector("#voiceInputButton"),
  imageInput: document.querySelector("#imageInput"),
  pendingImageContainer: document.querySelector("#pendingImageContainer")
};

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
  renderSessionListView();
  renderMessages();
  renderMemoryEntriesPanel();
  renderPendingImageView();

  await Promise.all([
    loadHealthStatus(),
    refreshMemoryEntries({ silent: true })
  ]);
}

function bindEvents() {
  elements.composerForm.addEventListener("submit", handleSubmit);
  elements.stopButton.addEventListener("click", stopStreaming);
  elements.clearChatButton.addEventListener("click", clearChat);
  elements.savePresetButton.addEventListener("click", saveSettingsOnly);
  elements.addMemoryButton.addEventListener("click", handleAddMemory);
  elements.attachImageButton.addEventListener("click", () => elements.imageInput.click());
  elements.imageInput.addEventListener("change", handleImageInputChange);
  elements.newChatButton.addEventListener("click", createNewChat);
  elements.exportButton.addEventListener("click", toggleExportMenu);
  elements.exportJsonButton.addEventListener("click", exportCurrentChatAsJson);
  elements.exportMarkdownButton.addEventListener("click", exportCurrentChatAsMarkdown);

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".export-shell")) {
      closeExportMenu();
    }
  });

  elements.memoryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAddMemory();
    }
  });

  elements.modelSelect.addEventListener("change", () => {
    state.model = elements.modelSelect.value;
    persistState();
  });

  elements.customModelInput.addEventListener("input", () => {
    state.customModel = elements.customModelInput.value.trim();
    persistState();
  });

  elements.autoRouteToggle.addEventListener("change", () => {
    state.autoRoute = elements.autoRouteToggle.checked;
    updateModelControlsVisibility();
    persistState();
  });

  elements.toolsToggle.addEventListener("change", () => {
    state.toolsEnabled = elements.toolsToggle.checked;
    persistState();
  });

  elements.systemPromptInput.addEventListener("input", () => {
    state.systemPrompt = elements.systemPromptInput.value;
    persistState();
  });

  elements.temperatureInput.addEventListener("input", () => {
    state.temperature = Number(elements.temperatureInput.value || defaultState.temperature);
    persistState();
  });

  elements.topPInput.addEventListener("input", () => {
    state.topP = Number(elements.topPInput.value || defaultState.topP);
    persistState();
  });

  elements.maxTokensInput.addEventListener("input", () => {
    state.maxOutputTokens = Number(elements.maxTokensInput.value || defaultState.maxOutputTokens);
    persistState();
  });

  elements.memoryTurnsInput.addEventListener("input", () => {
    state.memoryTurns = Number(elements.memoryTurnsInput.value || defaultState.memoryTurns);
    renderMemoryBadge();
    persistState();
  });

  bindDragAndDrop();
}

function stopStreaming() {
  if (abortController) {
    abortController.abort();
  }
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
    elements.chatPanel.classList.add("drag-active");
  };

  const handleDragLeave = (event) => {
    if (!hasFileTransfer(event)) {
      return;
    }

    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      elements.chatPanel.classList.remove("drag-active");
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
    elements.chatPanel.classList.remove("drag-active");
    await useSelectedImageFile(event.dataTransfer.files[0]);
  };

  elements.chatPanel.addEventListener("dragenter", handleDragEnter);
  elements.chatPanel.addEventListener("dragleave", handleDragLeave);
  elements.chatPanel.addEventListener("dragover", handleDragOver);
  elements.chatPanel.addEventListener("drop", handleDrop);
}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    elements.voiceInputButton.disabled = true;
    elements.voiceInputButton.title = "Speech not supported in this browser";
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = navigator.language || "en-US";
  speechRecognition.interimResults = false;
  speechRecognition.maxAlternatives = 1;

  elements.voiceInputButton.addEventListener("click", () => {
    if (!speechRecognition || isListening) {
      return;
    }

    try {
      speechRecognition.start();
    } catch {
      elements.statusText.textContent = "Voice input could not start.";
    }
  });

  speechRecognition.addEventListener("start", () => {
    isListening = true;
    elements.statusText.textContent = "Listening for speech input...";
  });

  speechRecognition.addEventListener("end", () => {
    isListening = false;
    elements.statusText.textContent = "Voice input ready.";
  });

  speechRecognition.addEventListener("result", (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();

    if (transcript) {
      elements.userInput.value = transcript;
      elements.userInput.focus();
      elements.statusText.textContent = "Speech captured. Review and send when ready.";
    }
  });

  speechRecognition.addEventListener("error", (event) => {
    isListening = false;
    elements.statusText.textContent = event.error === "not-allowed"
      ? "Microphone permission was denied."
      : "Voice input failed.";
  });
}

async function loadHealthStatus() {
  try {
    const data = await getHealth();
    serverModels = Array.isArray(data.models) ? data.models : [];
    populateModelOptions(elements.modelSelect, serverModels, defaultState.model, state.model);

    if (!data.hasApiKey) {
      elements.statusText.textContent = "NIM_API_KEY is missing. Add it to .env before sending requests.";
      setComposerEnabled(elements, false, Boolean(speechRecognition));
      return;
    }

    elements.statusText.textContent = `NVIDIA NIM is ready. Memory entries: ${data.memoryCount}. Tools: ${data.tools?.names?.join(", ") || "none"}.`;
    setComposerEnabled(elements, true, Boolean(speechRecognition));
  } catch {
    elements.statusText.textContent = "Cannot reach the local server. Make sure server.js is running.";
    populateModelOptions(elements.modelSelect, serverModels, defaultState.model, state.model);
    setComposerEnabled(elements, false, Boolean(speechRecognition));
  }
}

function syncControlsFromState() {
  elements.modelSelect.value = state.model;
  elements.customModelInput.value = state.customModel;
  elements.autoRouteToggle.checked = Boolean(state.autoRoute);
  elements.toolsToggle.checked = Boolean(state.toolsEnabled);
  elements.systemPromptInput.value = state.systemPrompt;
  elements.temperatureInput.value = String(state.temperature);
  elements.topPInput.value = String(state.topP);
  elements.maxTokensInput.value = String(state.maxOutputTokens);
  elements.memoryTurnsInput.value = String(state.memoryTurns);
  updateModelControlsVisibility();
  renderMemoryBadge();
}

function updateModelControlsVisibility() {
  const hidden = Boolean(state.autoRoute);
  elements.modelField.hidden = hidden;
  elements.customModelField.hidden = hidden;
}

function saveSettingsOnly() {
  syncStateFromControls();
  persistState();
  elements.statusText.textContent = "Settings saved to localStorage.";
}

function createNewChat() {
  stopStreaming();
  closeExportMenu();
  clearPendingImage();
  hideRuntimeNotice(elements.runtimeNotice);
  editingMessageIndex = -1;
  activeChatId = createChatId();
  state = createDefaultState();
  persistState();
  syncControlsFromState();
  renderMessages();
  renderSessionListView();
  elements.userInput.value = "";
  elements.userInput.focus();
  elements.statusText.textContent = "Started a new chat.";
}

function switchChat(chatId) {
  if (!chatId || chatId === activeChatId) {
    return;
  }

  stopStreaming();
  closeExportMenu();
  clearPendingImage();
  hideRuntimeNotice(elements.runtimeNotice);
  editingMessageIndex = -1;
  activeChatId = chatId;
  localStorage.setItem("my-own-chatgpt-active-chat-v2", activeChatId);
  state = loadChatState(chatId);
  syncControlsFromState();
  renderMessages();
  renderSessionListView();
  elements.userInput.value = "";
  elements.statusText.textContent = "Switched chat.";
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
      localStorage.setItem("my-own-chatgpt-active-chat-v2", activeChatId);
    }

    clearPendingImage();
    hideRuntimeNotice(elements.runtimeNotice);
    editingMessageIndex = -1;
    syncControlsFromState();
    renderMessages();
  }

  renderSessionListView();
  elements.statusText.textContent = "Chat deleted.";
}

function clearChat() {
  stopStreaming();
  state.messages = [];
  editingMessageIndex = -1;
  clearPendingImage();
  persistState();
  renderMessages();
  renderSessionListView();
  elements.statusText.textContent = "Chat history cleared.";
}

function renderSessionListView() {
  renderSessionList(elements.chatSessionList, listStoredChats(), activeChatId, switchChat, deleteChat);
}

function toggleExportMenu() {
  elements.exportMenu.hidden = !elements.exportMenu.hidden;
}

function closeExportMenu() {
  elements.exportMenu.hidden = true;
}

function exportCurrentChatAsJson() {
  closeExportMenu();
  downloadTextFile("chat-export.json", JSON.stringify(state.messages, null, 2), "application/json");
}

function exportCurrentChatAsMarkdown() {
  closeExportMenu();
  const markdown = state.messages
    .map((message) => `## ${formatExportRole(message.role)}\n${formatExportMessage(message)}`.trim())
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
  const summary = elements.memoryInput.value.trim();
  const type = elements.memoryTypeSelect.value || "semantic";
  if (!summary) {
    return;
  }

  elements.addMemoryButton.disabled = true;

  try {
    await saveMemoryEntry({
      type,
      origin: "manual",
      summary,
      sourceMessageCount: 0
    });

    elements.memoryInput.value = "";
    await refreshMemoryEntries({ silent: true });
    elements.statusText.textContent = "Persistent memory saved.";
  } catch (error) {
    elements.statusText.textContent = error.message || "Failed to save memory.";
  } finally {
    elements.addMemoryButton.disabled = false;
  }
}

async function handleDeleteMemory(id) {
  try {
    await deleteMemoryEntry(id);
    await refreshMemoryEntries({ silent: true });
    elements.statusText.textContent = "Memory entry deleted.";
  } catch (error) {
    elements.statusText.textContent = error.message || "Failed to delete memory.";
  }
}

async function refreshMemoryEntries(options = {}) {
  const { silent = false } = options;

  try {
    memoryEntries = await getMemoryEntries();
    renderMemoryEntriesPanel();
  } catch (error) {
    if (!silent) {
      elements.statusText.textContent = error.message || "Failed to load memory.";
    }
    memoryEntries = [];
    renderMemoryEntriesPanel();
  }
}

function renderMemoryEntriesPanel() {
  renderMemoryEntriesView(
    elements.memoryList,
    elements.memoryCountBadge,
    memoryEntries,
    handleDeleteMemory
  );
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
    elements.statusText.textContent = "Only image files are supported.";
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

    renderPendingImageView();
    elements.statusText.textContent = "Image attached. Add a prompt and send it with the message.";
  } catch (error) {
    clearPendingImage();
    elements.statusText.textContent = error.message || "Failed to load image.";
  }
}

function renderPendingImageView() {
  renderPendingImage(elements.pendingImageContainer, pendingImage, clearPendingImage);
}

function clearPendingImage() {
  pendingImage = null;
  elements.imageInput.value = "";
  renderPendingImageView();
}

async function handleSubmit(event) {
  event.preventDefault();
  if (abortController) {
    return;
  }

  const prompt = elements.userInput.value.trim();
  if (!prompt) {
    return;
  }

  closeExportMenu();
  syncStateFromControls();
  await refreshMemoryEntries({ silent: true });
  hideRuntimeNotice(elements.runtimeNotice);
  editingMessageIndex = -1;

  const imageForMessage = pendingImage ? { ...pendingImage } : null;
  const userMessage = createUserMessage(prompt, imageForMessage);
  const assistantMessage = { role: "assistant", content: "" };

  state.messages.push(userMessage, assistantMessage);
  streamingAssistantMessage = assistantMessage;
  clearPendingImage();
  persistState();
  renderMessages(state.messages.length - 1);
  renderSessionListView();

  elements.userInput.value = "";
  elements.userInput.focus();
  await requestAssistantReply(assistantMessage);
}

async function requestAssistantReply(assistantMessage) {
  const selectedModel = state.customModel || state.model;

  setStreamingUi(elements, true, Boolean(speechRecognition));
  elements.statusText.textContent = `Streaming reply from ${selectedModel}...`;
  lastFinishReason = "";
  abortController = new AbortController();

  try {
    const response = await requestChatStream({
      model: selectedModel,
      systemPrompt: buildSystemPrompt(state.systemPrompt, memoryEntries, state.messages),
      temperature: state.temperature,
      topP: state.topP,
      maxOutputTokens: state.maxOutputTokens,
      autoRoute: state.autoRoute,
      tools: state.toolsEnabled,
      messages: getRequestMessages(state.messages, state.memoryTurns)
    }, abortController.signal);

    if (!response.ok || !response.body) {
      const data = await safeParseJson(response);
      throw new Error(data?.error || "Server request failed.");
    }

    await consumeSse(response, async (parsedEvent) => {
      if (parsedEvent.event === "memory_summary") {
        handleMemorySummaryEvent(parsedEvent.data);
        return;
      }

      if (parsedEvent.event === "model_override") {
        handleModelOverrideEvent(parsedEvent.data);
        return;
      }

      if (parsedEvent.event === "routing") {
        handleRoutingEvent(parsedEvent.data);
        return;
      }

      if (parsedEvent.event === "tool_call") {
        handleToolCallEvent(parsedEvent.data);
        return;
      }

      if (parsedEvent.event === "tool_result") {
        handleToolResultEvent(parsedEvent.data);
        return;
      }

      if (parsedEvent.event === "token" && parsedEvent.data?.delta) {
        assistantMessage.content += parsedEvent.data.delta;
        persistState();
        renderMessages(state.messages.indexOf(assistantMessage));
      }

      if (parsedEvent.event === "error") {
        throw new Error(parsedEvent.data?.message || "Streaming failed.");
      }

      if (parsedEvent.event === "finish") {
        lastFinishReason = parsedEvent.data?.reason || "";
      }
    });

    if (!assistantMessage.content.trim()) {
      assistantMessage.content = "The model returned no content.";
    }

    elements.statusText.textContent = lastFinishReason === "MAX_TOKENS" || lastFinishReason === "length"
      ? "Reply stopped because max output tokens was reached."
      : "Reply completed.";
  } catch (error) {
    if (error.name === "AbortError") {
      elements.statusText.textContent = "Reply stopped.";
      if (!assistantMessage.content.trim()) {
        state.messages = state.messages.filter((message) => message !== assistantMessage);
      }
    } else {
      assistantMessage.content = assistantMessage.content.trim() || `Error: ${error.message}`;
      elements.statusText.textContent = "Request failed. Check the NVIDIA NIM key, model name, or parameters.";
    }
  } finally {
    abortController = null;
    streamingAssistantMessage = null;
    setStreamingUi(elements, false, Boolean(speechRecognition));
    persistState();
    renderMessages();
    renderSessionListView();
  }
}

function createUserMessage(prompt, image) {
  if (image) {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: prompt
        },
        {
          type: "image_url",
          image_url: {
            url: image.dataUrl
          }
        }
      ],
      imagePreviewUrl: image.dataUrl,
      imageName: image.name,
      imageMimeType: image.mimeType
    };
  }

  return {
    role: "user",
    content: prompt
  };
}

function handleMemorySummaryEvent(data) {
  trimSummarizedMessages(Number(data?.sourceMessageCount || 0));
  refreshMemoryEntries({ silent: true });
  elements.statusText.textContent = `Older messages were processed into long-term memory${data?.createdCount ? ` (${data.createdCount} entries)` : ""}.`;
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
    renderMessages(state.messages.indexOf(streamingAssistantMessage));
  }
}

function handleModelOverrideEvent(data) {
  if (!data?.model) {
    return;
  }

  showRuntimeNotice(elements.runtimeNotice, `Using ${data.model} because ${data.reason || "an image was attached"}.`);
}

function handleRoutingEvent(data) {
  if (!data?.model) {
    return;
  }

  showRuntimeNotice(elements.runtimeNotice, `Routed to ${data.model} (${data.reason || "automatic routing"})`);
}

function handleToolCallEvent(data) {
  insertTimelineMessage(createToolCallMessage(data));
}

function handleToolResultEvent(data) {
  if (applyToolResult(state.messages, data)) {
    persistState();
    renderMessages(state.messages.indexOf(streamingAssistantMessage));
    return;
  }

  insertTimelineMessage(createCompletedToolMessage(data));
}

function insertTimelineMessage(message) {
  const assistantIndex = streamingAssistantMessage ? state.messages.indexOf(streamingAssistantMessage) : -1;

  if (assistantIndex >= 0) {
    state.messages.splice(assistantIndex, 0, message);
    persistState();
    renderMessages(state.messages.indexOf(streamingAssistantMessage));
    return;
  }

  state.messages.push(message);
  persistState();
  renderMessages();
}

function renderMessages(streamingIndex = -1) {
  renderMessagesView({
    container: elements.messageList,
    messageTemplate: elements.messageTemplate,
    messages: state.messages,
    streamingIndex,
    editingMessageIndex,
    abortControllerActive: Boolean(abortController),
    onStartEdit: (index) => {
      editingMessageIndex = index;
      renderMessages();
    },
    onRegenerate: regenerateFromMessage,
    onCancelEdit: () => {
      editingMessageIndex = -1;
      renderMessages();
    }
  });

  renderMemoryBadge();
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
  hideRuntimeNotice(elements.runtimeNotice);

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
  renderMessages(state.messages.length - 1);
  renderSessionListView();
  await requestAssistantReply(assistantMessage);
}

function updateUserMessageText(message, nextText) {
  if (!Array.isArray(message.content)) {
    message.content = nextText;
    return;
  }

  const preservedItems = message.content.filter((item) => item?.type !== "text");
  message.content = [
    {
      type: "text",
      text: nextText
    },
    ...preservedItems
  ];
}

function renderMemoryBadge() {
  updateMemoryBadge(elements.memoryBadge, state.messages, isChatMessage);
}

function syncStateFromControls() {
  state.model = elements.modelSelect.value || defaultState.model;
  state.customModel = elements.customModelInput.value.trim();
  state.autoRoute = elements.autoRouteToggle.checked;
  state.toolsEnabled = elements.toolsToggle.checked;
  state.systemPrompt = elements.systemPromptInput.value;
  state.temperature = Number(elements.temperatureInput.value || defaultState.temperature);
  state.topP = Number(elements.topPInput.value || defaultState.topP);
  state.maxOutputTokens = Number(elements.maxTokensInput.value || defaultState.maxOutputTokens);
  state.memoryTurns = Number(elements.memoryTurnsInput.value || defaultState.memoryTurns);
  persistState();
}

function persistState() {
  state = persistChatState(activeChatId, state);
}

function buildSystemPrompt(basePrompt, entries, messages) {
  const blocks = [];
  const trimmedBasePrompt = typeof basePrompt === "string" ? basePrompt.trim() : "";
  const relevantEntries = selectRelevantMemoryEntries(entries, messages);
  const persistentMemoryBlock = buildPersistentMemoryBlock(relevantEntries);

  if (trimmedBasePrompt) {
    blocks.push(trimmedBasePrompt);
  }

  if (persistentMemoryBlock) {
    blocks.push(`[Persistent Memory]\n${persistentMemoryBlock}`);
  }

  return blocks.join("\n\n");
}

function buildPersistentMemoryBlock(entries) {
  const sections = [];
  const semanticEntries = entries.filter((entry) => entry.type === "semantic");
  const proceduralEntries = entries.filter((entry) => entry.type === "procedural");
  const episodicEntries = entries.filter((entry) => entry.type === "episodic");

  if (semanticEntries.length > 0) {
    sections.push(buildMemorySection("Semantic Memory", semanticEntries));
  }

  if (proceduralEntries.length > 0) {
    sections.push(buildMemorySection("Procedural Memory", proceduralEntries));
  }

  if (episodicEntries.length > 0) {
    sections.push(buildMemorySection("Relevant Episodes", episodicEntries));
  }

  return sections.filter(Boolean).join("\n\n");
}

function selectRelevantMemoryEntries(entries, messages) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const queryText = collectMemoryQuery(messages);
  const queryTokens = tokenizeMemoryText(queryText);
  const ranked = entries
    .map((entry, index) => ({
      entry,
      score: scoreMemoryEntry(entry, queryText, queryTokens, index)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return Date.parse(right.entry.updatedAt || 0) - Date.parse(left.entry.updatedAt || 0);
    });

  const limits = {
    semantic: 4,
    procedural: 3,
    episodic: 2
  };
  const counts = {
    semantic: 0,
    procedural: 0,
    episodic: 0
  };
  const selected = [];

  ranked.forEach(({ entry, score }) => {
    const type = entry.type || "semantic";
    if (selected.length >= 8) {
      return;
    }

    if ((limits[type] || 2) <= (counts[type] || 0)) {
      return;
    }

    if (queryTokens.length > 0 && score <= 0) {
      return;
    }

    counts[type] = (counts[type] || 0) + 1;
    selected.push(entry);
  });

  return selected.length > 0
    ? selected
    : ranked
      .slice(0, 4)
      .map(({ entry }) => entry);
}

function collectMemoryQuery(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  return messages
    .filter((message) => message?.role === "user")
    .slice(-2)
    .map((message) => getMessageText(message))
    .filter(Boolean)
    .join("\n");
}

function scoreMemoryEntry(entry, queryText, queryTokens, index) {
  const type = entry?.type || "semantic";
  const baseScore = type === "semantic"
    ? 40
    : type === "procedural"
      ? 32
      : 18;
  const originBonus = entry?.origin === "reflected"
    ? 8
    : entry?.origin === "manual"
      ? 6
      : 0;
  const freshnessBonus = Math.max(0, 10 - index);

  if (queryTokens.length === 0) {
    return baseScore + originBonus + freshnessBonus;
  }

  const summaryText = String(entry?.summary || "").toLowerCase();
  const overlap = queryTokens.filter((token) => summaryText.includes(token)).length;
  const directBonus = queryText && summaryText.includes(queryText.toLowerCase()) ? 6 : 0;

  return baseScore + originBonus + freshnessBonus + (overlap * 10) + directBonus;
}

function tokenizeMemoryText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  return Array.from(new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [])
      .filter((token) => token.length > 1)
  ));
}

function buildMemorySection(title, entries) {
  const lines = entries
    .flatMap((entry) => normalizeMemoryLines(entry.summary))
    .slice(0, 8);

  if (lines.length === 0) {
    return "";
  }

  return `[${title}]\n${lines.join("\n")}`;
}

function normalizeMemoryLines(summary) {
  return String(summary || "")
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
    });
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

function formatExportRole(role) {
  if (role === "user") {
    return "User";
  }

  if (role === "assistant") {
    return "Assistant";
  }

  return "Tool";
}

function formatExportMessage(message) {
  const lines = [];
  const text = getMessageText(message);

  if (text) {
    lines.push(text);
  }

  if (messageHasImage(message)) {
    lines.push("[Image attached]");
  }

  return lines.join("\n");
}
