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

  return {
    apiKey,
    maxRequestBodySize: options.maxRequestBodySize,
    getGeminiModels,
    handleChat
  };

  async function handleChat(req, res, body) {
    if (!apiKey) {
      return sendJson(res, 500, {
        error: "GEMINI_API_KEY is missing. Please create a .env file first."
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

    let workingMessages = sanitizeMessages(messages);
    if (workingMessages.length === 0) {
      return sendJson(res, 400, { error: "No valid messages were provided." });
    }

    const inlineDataParts = getInlineDataParts(workingMessages);
    if (inlineDataParts.some((part) => part.inline_data.data.length > inlineDataLimit)) {
      return sendJson(res, 413, {
        error: "Inline image data exceeds the 10MB upload limit."
      });
    }

    const requestedModel = sanitizeRequestedModel(model);
    const latestUserMessage = getLatestUserMessage(workingMessages);
    const availableModels = Array.from(new Set([
      defaultChatModel,
      visionModel,
      liteModel,
      requestedModel
    ]));

    let selectedModel = inlineDataParts.length > 0 ? visionModel : requestedModel;
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
        model: visionModel,
        reason: "image detected: cost optimization"
      }
      : null;

    const controller = new AbortController();
    req.on("close", () => controller.abort());

    let pendingSummary = null;

    if (workingMessages.length > summaryThreshold) {
      pendingSummary = await summarizeOldMessages(selectedModel, workingMessages, controller.signal);
      if (pendingSummary?.summary) {
        const summaryText = `[Memory] Key context from previous conversations:\n${normalizeSummaryForPrompt(pendingSummary.summary)}`;
        workingMessages = [
          {
            role: "user",
            content: summaryText,
            parts: [{ text: summaryText }]
          },
          ...workingMessages.slice(pendingSummary.sourceMessageCount)
        ];
      }
    }

    const contents = workingMessages
      .map(convertMessageToGeminiContent)
      .filter(Boolean);

    const settings = {
      systemPrompt,
      temperature,
      topP,
      maxOutputTokens
    };

    if (toolsEnabled) {
      return handleChatWithTools({
        res,
        model: selectedModel,
        contents,
        settings,
        controller,
        modelOverridePayload,
        routingPayload,
        pendingSummary
      });
    }

    const payload = buildGeminiPayload(contents, settings);

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

    sse.startSseResponse(res);
    emitPreflightEvents(res, {
      modelOverridePayload,
      routingPayload,
      pendingSummary
    });

    try {
      await streamGeminiResponse(upstream, res);
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
      contents,
      settings,
      controller,
      modelOverridePayload,
      routingPayload,
      pendingSummary
    } = context;

    let history = contents.map(cloneJsonValue);
    let responsePayload;

    try {
      responsePayload = await generateGeminiJson(
        model,
        buildGeminiPayload(history, settings, { includeTools: true }),
        controller.signal
      );
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const message = error.name === "AbortError"
        ? "Client disconnected."
        : error.message || "Gemini API request failed.";
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
        const functionCall = extractFunctionCall(currentResponse);
        if (!functionCall) {
          emitResponseText(currentResponse, res);
          sse.writeSse(res, "done", {});
          return res.end();
        }

        sse.writeSse(res, "tool_call", {
          name: functionCall.name,
          args: functionCall.args || {}
        });

        let toolResult;

        try {
          toolResult = await tools.executeTool(functionCall.name, functionCall.args || {}, controller.signal);
        } catch (error) {
          toolResult = `Tool error: ${error.message}`;
        }

        sse.writeSse(res, "tool_result", {
          name: functionCall.name,
          result: toolResult
        });

        history.push(cloneGeminiContent(currentResponse?.candidates?.[0]?.content) || buildModelFunctionCallContent(functionCall));
        history.push(buildFunctionResponseContent(functionCall, toolResult));

        rounds += 1;

        if (rounds >= 3) {
          break;
        }

        currentResponse = await generateGeminiJson(
          model,
          buildGeminiPayload(history, settings, { includeTools: true }),
          controller.signal
        );
      }

      const finalResponse = await generateGeminiJson(
        model,
        buildGeminiPayload(history, settings),
        controller.signal
      );

      emitResponseText(finalResponse, res);
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

  function emitResponseText(payload, res) {
    const text = extractGeminiText(payload) || "The model returned no content.";
    sse.streamTextChunks(res, text);

    sse.writeSse(res, "finish", {
      reason: payload?.candidates?.[0]?.finishReason || "STOP",
      message: payload?.candidates?.[0]?.finishMessage || ""
    });
  }

  function buildGeminiPayload(contents, settings, config = {}) {
    const payload = {
      contents,
      generationConfig: {
        temperature: clampNumber(settings.temperature, 0, 2, 1),
        topP: clampNumber(settings.topP, 0, 1, 1),
        maxOutputTokens: clampInteger(settings.maxOutputTokens, 32, 8192, 512)
      }
    };

    if (typeof settings.systemPrompt === "string" && settings.systemPrompt.trim()) {
      payload.systemInstruction = {
        parts: [{ text: settings.systemPrompt.trim() }]
      };
    }

    if (config.includeTools) {
      payload.tools = tools.TOOLS;
    }

    return payload;
  }

  async function summarizeOldMessages(model, messages, signal) {
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

    if (part?.functionCall || part?.function_call) {
      return {
        functionCall: cloneJsonValue(part.functionCall || part.function_call)
      };
    }

    if (part?.functionResponse) {
      return {
        functionResponse: cloneJsonValue(part.functionResponse)
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

  function selectModel(userMessage, availableModels, config = {}) {
    const hasInlineImage = Boolean(config.hasInlineImage);
    const preferredModel = sanitizeRequestedModel(config.preferredModel || defaultChatModel);
    const text = typeof userMessage === "string" ? userMessage : "";

    if (hasInlineImage && availableModels.includes(visionModel)) {
      return {
        model: visionModel,
        reason: "image detected"
      };
    }

    if (text.includes("```") && availableModels.includes(defaultChatModel)) {
      return {
        model: defaultChatModel,
        reason: "code block detected"
      };
    }

    if (text.length > 1000 && availableModels.includes(defaultChatModel)) {
      return {
        model: defaultChatModel,
        reason: "long content"
      };
    }

    if (/(translate|\u7ffb\u8b6f|summarize|summary|\u6458\u8981)/i.test(text) && availableModels.includes(visionModel)) {
      return {
        model: visionModel,
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
    if (typeof model !== "string" || !model.trim() || isBlockedModel(model.trim())) {
      return defaultChatModel;
    }

    return model.trim();
  }

  function isBlockedModel(model) {
    return model.startsWith("gemini-1.5-") || blockedModels.has(model);
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

  function extractFunctionCall(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      return null;
    }

    for (const part of parts) {
      const functionCall = part?.functionCall || part?.function_call;
      if (functionCall?.name) {
        return {
          id: functionCall.id,
          name: functionCall.name,
          args: cloneJsonValue(functionCall.args || {})
        };
      }
    }

    return null;
  }

  function buildFunctionResponseContent(functionCall, result) {
    const functionResponse = {
      name: functionCall.name,
      response: {
        result
      }
    };

    if (functionCall.id) {
      functionResponse.id = functionCall.id;
    }

    return {
      role: "user",
      parts: [
        {
          functionResponse
        }
      ]
    };
  }

  function buildModelFunctionCallContent(functionCall) {
    return {
      role: "model",
      parts: [
        {
          functionCall: cloneJsonValue(functionCall)
        }
      ]
    };
  }

  function cloneGeminiContent(content) {
    if (!content || typeof content !== "object") {
      return null;
    }

    return cloneJsonValue(content);
  }

  function cloneJsonValue(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  async function generateGeminiText(model, payload, signal) {
    const data = await generateGeminiJson(model, payload, signal);
    return extractGeminiText(data);
  }

  async function generateGeminiJson(model, payload, signal) {
    let response;

    try {
      response = await fetch(buildGeminiUrl(model, false), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        throw error;
      }

      const networkError = new Error("Failed to connect to Gemini API.");
      networkError.statusCode = 502;
      throw networkError;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const parsed = tryParseJson(errorText);
      const message = parsed?.error?.message || errorText || "Gemini API request failed.";
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

  function buildGeminiUrl(model, stream) {
    const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const separator = stream ? "&" : "?";
    return `${apiBase}/models/${encodeURIComponent(model)}:${action}${separator}key=${encodeURIComponent(apiKey)}`;
  }

  async function streamGeminiResponse(upstream, res) {
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
        forwardGeminiEvent(rawEvent, res);
      }
    }

    if (buffer.trim()) {
      forwardGeminiEvent(buffer, res);
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
        sse.writeSse(res, "error", { message: parsed.error.message });
        continue;
      }

      const text = extractGeminiText(parsed);
      if (text) {
        sse.writeSse(res, "token", { delta: text });
      }

      const finishReason = parsed?.candidates?.[0]?.finishReason;
      const finishMessage = parsed?.candidates?.[0]?.finishMessage || "";
      if (finishReason) {
        sse.writeSse(res, "finish", {
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
    if (!apiKey) {
      return modelOptions;
    }

    try {
      const response = await fetch(
        `${apiBase}/models?key=${encodeURIComponent(apiKey)}&pageSize=100`,
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

      if (!response.ok) {
        return modelOptions;
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

      return Array.from(new Set([...available, ...modelOptions])).sort();
    } catch {
      return modelOptions;
    }
  }
}

module.exports = {
  createGeminiService
};

function stripModelPrefix(name) {
  if (typeof name !== "string") {
    return "";
  }

  return name.startsWith("models/") ? name.slice("models/".length) : name;
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}
