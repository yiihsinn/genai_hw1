export function createToolCallMessage(data) {
  return {
    role: "tool",
    toolName: data?.name || "tool",
    toolState: "calling",
    content: `Calling tool: ${formatToolInvocation(data?.name, data?.args)}`
  };
}

export function applyToolResult(messages, data) {
  const resultText = formatToolResult(data?.result);
  const existing = [...messages]
    .reverse()
    .find((message) => message.role === "tool" && message.toolState === "calling" && message.toolName === data?.name);

  if (existing) {
    existing.toolState = "done";
    existing.content = `${data?.name || "tool"} -> ${resultText}`;
    return true;
  }

  return false;
}

export function createCompletedToolMessage(data) {
  return {
    role: "tool",
    toolName: data?.name || "tool",
    toolState: "done",
    content: `${data?.name || "tool"} -> ${formatToolResult(data?.result)}`
  };
}

export function formatToolInvocation(name, args) {
  return `${name || "tool"}(${JSON.stringify(args || {})})`;
}

function formatToolResult(result) {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result);
}
