export const LEGACY_STORAGE_KEY = "my-own-chatgpt-state-v1";
export const ACTIVE_CHAT_KEY = "my-own-chatgpt-active-chat-v2";
export const CHAT_KEY_PREFIX = "chat_";
export const SUMMARY_THRESHOLD = 20;

export const defaultState = {
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
  const firstUserMessage = (chatState.messages || []).find((message) => message.role === "user" && typeof message.content === "string" && message.content.trim());
  if (!firstUserMessage) {
    return "New Chat";
  }

  const text = firstUserMessage.content.trim();
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
