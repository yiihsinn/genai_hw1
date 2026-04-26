const MAX_RETRIES = 2;

export async function getHealth() {
  const response = await fetchWithRetry("/api/health");
  return response.json();
}

export async function getMemoryEntries() {
  const response = await fetchWithRetry("/api/memory");
  return response.json();
}

export async function saveMemoryEntry(payload) {
  const response = await fetchWithRetry("/api/memory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await safeParseJson(response);
    throw new Error(error?.error || "Failed to save memory.");
  }

  return response.json();
}

export async function deleteMemoryEntry(id) {
  const response = await fetchWithRetry(`/api/memory/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    const error = await safeParseJson(response);
    throw new Error(error?.error || "Failed to delete memory.");
  }

  return response.json();
}

export async function requestChatStream(payload, signal) {
  return fetchWithRetry("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal
  });
}

export async function consumeSse(response, onEvent) {
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
      if (parsedEvent) {
        await onEvent(parsedEvent);
      }
    }
  }
}

export async function fetchWithRetry(url, options = {}) {
  let attempt = 0;
  let lastError = null;

  while (attempt <= MAX_RETRIES) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status < 500 || attempt === MAX_RETRIES) {
        return response;
      }

      lastError = new Error(`Request failed with status ${response.status}.`);
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }

      lastError = error;
    }

    attempt += 1;
    await delay(250 * (2 ** (attempt - 1)));
  }

  throw lastError || new Error("Request failed.");
}

export async function safeParseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
