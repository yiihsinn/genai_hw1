function createGeminiService(options) {
  const {
    apiKey,
    apiBase,
    modelOptions,
    defaultChatModel,
    visionModel,
    liteModel,
    blockedModels,
    summaryThreshold,
    summaryBatchSize,
    inlineDataLimit,
    tools,
    memoryStore,
    sse
  } = options;

  const longContextModel = options.longContextModel || defaultChatModel;
  const translationModel = options.translationModel || liteModel;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey || ""}`
  };

  return {
    apiKey,
    maxRequestBodySize: options.maxRequestBodySize,
    getGeminiModels,
    handleChat
  };

  async function handleChat(req, res, body) {
    if (!apiKey) {
      return sendJson(res, 500, {
        error: "NIM_API_KEY is missing. Add NIM_API_KEY or NVIDIA_API_KEY to .env."
      });
    }

    const {
      model,
      autoRoute,
      tools: toolsEnabled,
      systemPrompt,
      temperature,
      topP,
      maxOutputTokens,
      messages
    } = body || {};

    if (!model || !Array.isArray(messages) || messages.length === 0) {
      return sendJson(res, 400, { error: "Invalid request payload." });
    }

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let workingMessages = sanitizeMessages(messages);
    if (workingMessages.length === 0) {
      return sendJson(res, 400, { error: "No valid messages were provided." });
    }

    const imageUrls = getImageUrls(workingMessages);
    if (imageUrls.some((url) => isOversizedDataUrl(url, inlineDataLimit))) {
      return sendJson(res, 413, {
        error: "Inline image data exceeds the 10MB upload limit."
      });
    }

    const requestedModel = sanitizeRequestedModel(model);
    const latestUserMessage = getLatestUserMessageText(workingMessages);
    const availableModels = Array.from(new Set([
      defaultChatModel,
      visionModel,
      liteModel,
      longContextModel,
      translationModel,
      requestedModel
    ]));

    const hasImages = imageUrls.length > 0;
    let selectedModel = hasImages ? visionModel : requestedModel;
    let routingPayload = null;

    if (autoRoute) {
      routingPayload = selectModel(latestUserMessage, availableModels, {
        preferredModel: requestedModel,
        hasImages
      });
      selectedModel = routingPayload.model;
    }

    const modelOverridePayload = hasImages
      ? {
        model: visionModel,
        reason: "image detected"
      }
      : null;

    let pendingSummary = null;

    if (workingMessages.length > summaryThreshold) {
      pendingSummary = await summarizeOldMessages(selectedModel, workingMessages, systemPrompt, controller.signal);
      if (pendingSummary?.summary) {
        const summaryText = `[Memory] Key context from previous conversations:\n${normalizeSummaryForPrompt(pendingSummary.summary)}`;
        workingMessages = [
          {
            role: "user",
            content: summaryText,
            textContent: summaryText,
            hasImage: false
          },
          ...workingMessages.slice(pendingSummary.sourceMessageCount)
        ];
      }
    }

    const apiMessages = buildApiMessages(workingMessages, systemPrompt);
    const settings = {
      temperature,
      topP,
      maxOutputTokens
    };

    if (toolsEnabled) {
      return handleChatWithTools({
        res,
        model: selectedModel,
        messages: apiMessages,
        settings,
        controller,
        modelOverridePayload,
        routingPayload,
        pendingSummary
      });
    }

    let upstream;

    try {
      upstream = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(buildChatPayload(selectedModel, apiMessages, settings, { stream: true })),
        signal: controller.signal
      });
    } catch (error) {
      const message = error.name === "AbortError"
        ? "Client disconnected."
        : "Failed to connect to NVIDIA NIM API.";
      return sendJson(res, 502, { error: message });
    }

    if (!upstream.ok || !upstream.body) {
      const errorText = await upstream.text();
      const parsed = tryParseJson(errorText);
      const message = parsed?.error?.message || errorText || "NVIDIA NIM request failed.";
      return sendJson(res, upstream.status || 500, { error: message });
    }

    sse.startSseResponse(res);
    emitPreflightEvents(res, {
      modelOverridePayload,
      routingPayload,
      pendingSummary
    });

    try {
      await streamNimResponse(upstream, res);
      sse.writeSse(res, "done", {});
    } catch (error) {
      if (error.name !== "AbortError") {
        sse.writeSse(res, "error", {
          message: "Streaming interrupted while reading the model response."
        });
      }
    } finally {
      res.end();
    }
  }

  async function handleChatWithTools(context) {
    const {
      res,
      model,
      messages,
      settings,
      controller,
      modelOverridePayload,
      routingPayload,
      pendingSummary
    } = context;

    let history = messages.map(cloneJsonValue);
    let responsePayload;

    try {
      responsePayload = await requestChatJson(
        buildChatPayload(model, history, settings, {
          tools: tools.TOOLS,
          tool_choice: "auto"
        }),
        controller.signal
      );
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const message = error.name === "AbortError"
        ? "Client disconnected."
        : error.message || "NVIDIA NIM request failed.";
      return sendJson(res, statusCode, { error: message });
    }

    sse.startSseResponse(res);
    emitPreflightEvents(res, {
      modelOverridePayload,
      routingPayload,
      pendingSummary
    });

    try {
      let rounds = 0;
      let currentResponse = responsePayload;

      while (rounds < 3) {
        const toolCalls = extractToolCalls(currentResponse);
        if (toolCalls.length === 0) {
          emitJsonResponseText(currentResponse, res);
          sse.writeSse(res, "done", {});
          return res.end();
        }

        history.push(buildAssistantToolCallMessage(currentResponse));

        for (const toolCall of toolCalls) {
          sse.writeSse(res, "tool_call", {
            name: toolCall.name,
            args: toolCall.args
          });

          let toolResult;

          try {
            toolResult = await tools.executeTool(toolCall.name, toolCall.args, controller.signal);
          } catch (error) {
            toolResult = `Tool error: ${error.message}`;
          }

          sse.writeSse(res, "tool_result", {
            name: toolCall.name,
            result: toolResult
          });

          history.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult)
          });
        }

        rounds += 1;

        if (rounds >= 3) {
          break;
        }

        currentResponse = await requestChatJson(
          buildChatPayload(model, history, settings, {
            tools: tools.TOOLS,
            tool_choice: "auto"
          }),
          controller.signal
        );
      }

      const upstream = await requestChatStream(
        buildChatPayload(model, history, settings, { stream: true }),
        controller.signal
      );

      await streamNimResponse(upstream, res);
      sse.writeSse(res, "done", {});
    } catch (error) {
      if (error.name !== "AbortError") {
        sse.writeSse(res, "error", {
          message: error.message || "Tool-assisted request failed."
        });
      }
    } finally {
      res.end();
    }
  }

  function buildChatPayload(model, messages, settings, overrides = {}) {
    const payload = {
      model,
      messages,
      temperature: clampNumber(settings.temperature, 0, 2, 1),
      top_p: clampNumber(settings.topP, 0, 1, 1),
      max_tokens: clampInteger(settings.maxOutputTokens, 32, 8192, 512),
      stream: Boolean(overrides.stream)
    };

    return {
      ...payload,
      ...overrides
    };
  }

  async function summarizeOldMessages(model, messages, systemPrompt, signal) {
    const slice = messages.slice(0, summaryBatchSize);
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
      const response = await requestChatJson(
        buildChatPayload(model, buildApiMessages([
          {
            role: "user",
            content: summaryPrompt,
            textContent: summaryPrompt,
            hasImage: false
          }
        ], systemPrompt), {
          temperature: 0.2,
          topP: 1,
          maxOutputTokens: 256
        }),
        signal
      );

      const summary = extractResponseText(response).trim();
      if (!summary) {
        return null;
      }

      return {
        summary,
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

      const normalizedContent = normalizeMessageContent(message);
      if (normalizedContent == null) {
        continue;
      }

      const textContent = extractTextContent(normalizedContent);
      const hasImage = containsImage(normalizedContent);

      if (!textContent && !hasImage) {
        continue;
      }

      sanitized.push({
        role: message.role,
        content: normalizedContent,
        textContent,
        hasImage
      });
    }

    return sanitized;
  }

  function normalizeMessageContent(message) {
    if (Array.isArray(message?.content)) {
      return normalizeContentArray(message.content);
    }

    if (Array.isArray(message?.parts)) {
      return convertLegacyParts(message.parts);
    }

    if (typeof message?.content === "string" && message.content.trim()) {
      return message.content.trim();
    }

    return null;
  }

  function normalizeContentArray(content) {
    const normalized = [];

    for (const item of content) {
      if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
        normalized.push({
          type: "text",
          text: item.text.trim()
        });
      }

      if (item?.type === "image_url" && typeof item.image_url?.url === "string" && item.image_url.url.trim()) {
        normalized.push({
          type: "image_url",
          image_url: {
            url: item.image_url.url.trim()
          }
        });
      }
    }

    if (normalized.length === 0) {
      return null;
    }

    return normalized.some((item) => item.type === "image_url")
      ? normalized
      : normalized.map((item) => item.text).join("\n\n");
  }

  function convertLegacyParts(parts) {
    const textParts = [];
    const content = [];

    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        const text = part.text.trim();
        textParts.push(text);
        content.push({
          type: "text",
          text
        });
      }

      const inlineData = part?.inline_data;
      const mimeType = inlineData?.mime_type || inlineData?.mimeType;
      const data = inlineData?.data;

      if (typeof mimeType === "string" && mimeType.trim() && typeof data === "string" && data.trim()) {
        content.push({
          type: "image_url",
          image_url: {
            url: `data:${mimeType.trim()};base64,${data.trim()}`
          }
        });
      }
    }

    if (content.length === 0) {
      return null;
    }

    return content.some((item) => item.type === "image_url")
      ? content
      : textParts.join("\n\n");
  }

  function buildApiMessages(messages, systemPrompt) {
    const apiMessages = [];

    if (typeof systemPrompt === "string" && systemPrompt.trim()) {
      apiMessages.push({
        role: "system",
        content: systemPrompt.trim()
      });
    }

    messages.forEach((message) => {
      apiMessages.push({
        role: message.role,
        content: cloneJsonValue(message.content)
      });
    });

    return apiMessages;
  }

  function getImageUrls(messages) {
    return messages.flatMap((message) => {
      if (!Array.isArray(message.content)) {
        return [];
      }

      return message.content
        .filter((item) => item?.type === "image_url" && typeof item.image_url?.url === "string")
        .map((item) => item.image_url.url);
    });
  }

  function getLatestUserMessageText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") {
        return message.textContent || "";
      }
    }

    return "";
  }

  function containsImage(content) {
    return Array.isArray(content) && content.some((item) => item.type === "image_url");
  }

  function extractTextContent(content) {
    if (typeof content === "string") {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return "";
    }

    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  function buildConversationTranscript(messages) {
    return messages
      .map((message) => {
        const speaker = message.role === "assistant" ? "Assistant" : "User";
        const content = message.textContent || (message.hasImage ? "[Image attached]" : "");
        return `${speaker}: ${content || "[No text content]"}`;
      })
      .join("\n\n")
      .trim();
  }

  function selectModel(userMessage, availableModels, config = {}) {
    const preferredModel = sanitizeRequestedModel(config.preferredModel || defaultChatModel);
    const text = typeof userMessage === "string" ? userMessage : "";

    if (config.hasImages && availableModels.includes(visionModel)) {
      return {
        model: visionModel,
        reason: "image detected"
      };
    }

    if ((text.includes("```") || text.length > 1000) && availableModels.includes(longContextModel)) {
      return {
        model: longContextModel,
        reason: text.includes("```") ? "code block detected" : "long content"
      };
    }

    if (/(translate|\u7ffb\u8b6f|summarize|\u6458\u8981)/i.test(text) && availableModels.includes(translationModel)) {
      return {
        model: translationModel,
        reason: "translation or summarization task"
      };
    }

    if (text.length > 0 && text.length < 100 && !/[?\uFF1F]/.test(text) && availableModels.includes(liteModel)) {
      return {
        model: liteModel,
        reason: "short casual prompt"
      };
    }

    return {
      model: preferredModel,
      reason: "using selected model"
    };
  }

  function sanitizeRequestedModel(model) {
    if (typeof model !== "string" || !model.trim() || blockedModels.has(model.trim())) {
      return defaultChatModel;
    }

    return model.trim();
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

  async function requestChatJson(payload, signal) {
    let response;

    try {
      response = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }

      const networkError = new Error("Failed to connect to NVIDIA NIM API.");
      networkError.statusCode = 502;
      throw networkError;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const parsed = tryParseJson(errorText);
      const message = parsed?.error?.message || errorText || "NVIDIA NIM request failed.";
      const apiError = new Error(message);
      apiError.statusCode = response.status || 500;
      throw apiError;
    }

    const data = await response.json();
    if (data?.error?.message) {
      const apiError = new Error(data.error.message);
      apiError.statusCode = 500;
      throw apiError;
    }

    return data;
  }

  async function requestChatStream(payload, signal) {
    let response;

    try {
      response = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }

      const networkError = new Error("Failed to connect to NVIDIA NIM API.");
      networkError.statusCode = 502;
      throw networkError;
    }

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      const parsed = tryParseJson(errorText);
      const message = parsed?.error?.message || errorText || "NVIDIA NIM request failed.";
      const apiError = new Error(message);
      apiError.statusCode = response.status || 500;
      throw apiError;
    }

    return response;
  }

  async function streamNimResponse(upstream, res) {
    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";

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
        forwardNimEvent(rawEvent, res);
      }
    }

    if (buffer.trim()) {
      forwardNimEvent(buffer, res);
    }
  }

  function forwardNimEvent(rawEvent, res) {
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
        sse.writeSse(res, "error", { message: parsed.error.message });
        continue;
      }

      const delta = extractDeltaText(parsed);
      if (delta) {
        sse.writeSse(res, "token", { delta });
      }

      const finishReason = parsed?.choices?.[0]?.finish_reason;
      if (finishReason) {
        sse.writeSse(res, "finish", {
          reason: finishReason,
          message: ""
        });
      }
    }
  }

  function extractDeltaText(payload) {
    const deltaContent = payload?.choices?.[0]?.delta?.content;
    if (typeof deltaContent === "string") {
      return deltaContent;
    }

    if (Array.isArray(deltaContent)) {
      return deltaContent
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("");
    }

    return "";
  }

  function extractResponseText(payload) {
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("");
    }

    return "";
  }

  function emitJsonResponseText(payload, res) {
    const text = extractResponseText(payload) || "The model returned no content.";
    sse.streamTextChunks(res, text);
    sse.writeSse(res, "finish", {
      reason: payload?.choices?.[0]?.finish_reason || "stop",
      message: ""
    });
  }

  function extractToolCalls(payload) {
    const toolCalls = payload?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls)) {
      return [];
    }

    return toolCalls
      .map((toolCall) => {
        const name = toolCall?.function?.name;
        const argsText = toolCall?.function?.arguments || "{}";

        if (typeof name !== "string" || !name.trim()) {
          return null;
        }

        let args;
        try {
          args = JSON.parse(argsText);
        } catch {
          args = {};
        }

        return {
          id: toolCall.id || createId(),
          name: name.trim(),
          args
        };
      })
      .filter(Boolean);
  }

  function buildAssistantToolCallMessage(payload) {
    const message = payload?.choices?.[0]?.message || {};
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : "",
      tool_calls: cloneJsonValue(message.tool_calls || [])
    };
  }

  function emitPreflightEvents(res, eventPayloads) {
    const {
      modelOverridePayload,
      routingPayload,
      pendingSummary
    } = eventPayloads;

    if (modelOverridePayload) {
      sse.writeSse(res, "model_override", modelOverridePayload);
    }

    if (routingPayload) {
      sse.writeSse(res, "routing", routingPayload);
    }

    if (pendingSummary?.summary) {
      try {
        const memoryEntry = memoryStore.addMemory({
          summary: pendingSummary.summary,
          sourceMessageCount: pendingSummary.sourceMessageCount
        });

        if (memoryEntry) {
          sse.writeSse(res, "memory_summary", {
            id: memoryEntry.id,
            summary: memoryEntry.summary,
            sourceMessageCount: memoryEntry.sourceMessageCount
          });
        }
      } catch (error) {
        sse.writeSse(res, "error", {
          message: `Failed to persist summarized memory: ${error.message}`
        });
      }
    }
  }

  async function getGeminiModels() {
    if (!apiKey) {
      return modelOptions;
    }

    try {
      const response = await fetch(`${apiBase}/models`, {
        headers,
        method: "GET"
      });

      if (!response.ok) {
        return modelOptions;
      }

      const payload = await response.json();
      const models = Array.isArray(payload?.data) ? payload.data : [];
      const available = models
        .map((modelInfo) => modelInfo?.id)
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim())
        .filter((id) => !blockedModels.has(id));

      return Array.from(new Set([...available, ...modelOptions])).sort();
    } catch {
      return modelOptions;
    }
  }
}

module.exports = {
  createGeminiService
};

function isOversizedDataUrl(url, limit) {
  return typeof url === "string" && url.startsWith("data:") && url.length > limit;
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

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
