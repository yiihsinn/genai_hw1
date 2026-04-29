export const LEGACY_STORAGE_KEY = "my-own-chatgpt-state-v1";
export const ACTIVE_CHAT_KEY = "my-own-chatgpt-active-chat-v2";
export const CHAT_KEY_PREFIX = "chat_";
export const SUMMARY_THRESHOLD = 20;

export const defaultState = {
  model: "meta/llama-3.3-70b-instruct",
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

export function initializeActiveChatId() {
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

export function loadChatState(chatId) {
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

export function createDefaultState() {
  const now = new Date().toISOString();
  return {
    ...structuredClone(defaultState),
    createdAt: now,
    updatedAt: now
  };
}

export function createChatId() {
  return `${CHAT_KEY_PREFIX}${Date.now()}`;
}

export function persistChatState(activeChatId, state) {
  const nextState = {
    ...state,
    updatedAt: new Date().toISOString(),
    createdAt: state.createdAt || new Date().toISOString()
  };

  localStorage.setItem(activeChatId, JSON.stringify(serializeState(nextState)));
  localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId);
  return nextState;
}

export function listStoredChats() {
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

export function buildChatTitle(chatState) {
  const firstUserMessage = (chatState.messages || []).find((message) => {
    return message.role === "user" && getMessageText(message);
  });

  if (!firstUserMessage) {
    return "New Chat";
  }

  const text = getMessageText(firstUserMessage);
  return text.length > 30 ? `${text.slice(0, 30)}...` : text;
}

export function isChatMessage(message) {
  return message?.role === "user" || message?.role === "assistant";
}

export function getRequestMessages(messages, memoryTurns) {
  const chatMessages = messages.filter(isChatMessage);
  const selectedMessages = chatMessages.length > SUMMARY_THRESHOLD
    ? chatMessages
    : chatMessages.slice(-Math.max(1, Number(memoryTurns) || defaultState.memoryTurns) * 2);

  return selectedMessages.map((message) => {
    return {
      role: message.role,
      content: getRequestContent(message)
    };
  });
}

export function getMessageText(message) {
  if (typeof message?.content === "string") {
    return message.content.trim();
  }

  if (Array.isArray(message?.content)) {
    return message.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  if (Array.isArray(message?.parts)) {
    return message.parts
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  return "";
}

export function messageHasImage(message) {
  return getImageUrls(message).length > 0;
}

export function getPrimaryImageUrl(message) {
  return getImageUrls(message)[0] || "";
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

function serializeState(state) {
  return {
    ...state,
    messages: state.messages.map((message) => {
      const serialized = {
        role: message.role,
        content: serializeContent(message)
      };

      if (message.toolName) {
        serialized.toolName = message.toolName;
      }

      if (message.toolState) {
        serialized.toolState = message.toolState;
      }

      if (typeof message.imagePreviewUrl === "string" && message.imagePreviewUrl) {
        serialized.imagePreviewUrl = message.imagePreviewUrl;
      }

      if (typeof message.imageName === "string" && message.imageName) {
        serialized.imageName = message.imageName;
      }

      if (typeof message.imageMimeType === "string" && message.imageMimeType) {
        serialized.imageMimeType = message.imageMimeType;
      }

      if (Array.isArray(message.parts) && !Array.isArray(message.content)) {
        serialized.parts = message.parts
          .map((part) => {
            if (typeof part?.text === "string" && part.text.trim()) {
              return { text: part.text };
            }

            if (part?.inline_data?.mime_type && part?.inline_data?.data) {
              return {
                inline_data: {
                  mime_type: part.inline_data.mime_type,
                  data: part.inline_data.data
                }
              };
            }

            return null;
          })
          .filter(Boolean);
      }

      return serialized;
    })
  };
}

function getRequestContent(message) {
  if (Array.isArray(message?.content) && message.content.length > 0) {
    return cloneJsonValue(message.content);
  }

  if (Array.isArray(message?.parts) && message.parts.length > 0) {
    return convertLegacyPartsToContent(message.parts);
  }

  return typeof message?.content === "string" ? message.content : "";
}

function convertLegacyPartsToContent(parts) {
  const content = [];
  const textParts = [];

  parts.forEach((part) => {
    if (typeof part?.text === "string" && part.text.trim()) {
      const text = part.text.trim();
      textParts.push(text);
      content.push({
        type: "text",
        text
      });
    }

    const inlineData = part?.inline_data;
    if (typeof inlineData?.mime_type === "string" && typeof inlineData?.data === "string" && inlineData.data.trim()) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${inlineData.mime_type};base64,${inlineData.data.trim()}`
        }
      });
    }
  });

  if (content.some((item) => item.type === "image_url")) {
    return content;
  }

  return textParts.join("\n\n");
}

function getImageUrls(message) {
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((item) => item?.type === "image_url" && typeof item.image_url?.url === "string" && item.image_url.url.trim())
      .map((item) => item.image_url.url.trim());
  }

  if (Array.isArray(message?.parts)) {
    return message.parts
      .filter((part) => typeof part?.inline_data?.mime_type === "string" && typeof part?.inline_data?.data === "string" && part.inline_data.data.trim())
      .map((part) => `data:${part.inline_data.mime_type};base64,${part.inline_data.data.trim()}`);
  }

  if (typeof message?.imagePreviewUrl === "string" && message.imagePreviewUrl) {
    return [message.imagePreviewUrl];
  }

  return [];
}

function serializeContent(message) {
  if (Array.isArray(message?.content)) {
    return cloneJsonValue(message.content);
  }

  return typeof message?.content === "string" ? message.content : "";
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
