export function populateModelOptions(select, models, defaultModel, currentModel) {
  const options = [...models];
  if (!options.includes(defaultModel)) {
    options.unshift(defaultModel);
  }

  select.innerHTML = "";

  for (const model of options) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }

  if (currentModel && options.includes(currentModel)) {
    select.value = currentModel;
  }
}

export function updateMemoryBadge(element, messages, isChatMessage) {
  const turnCount = Math.ceil(messages.filter(isChatMessage).length / 2);
  element.textContent = `Memory ${turnCount} turns`;
}

export function renderSessionList(container, sessions, activeChatId, onSelect, onDelete) {
  container.innerHTML = "";

  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No chats yet. Start a new conversation to create one.";
    container.appendChild(empty);
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
    button.addEventListener("click", () => onSelect(session.id));

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
      onDelete(session.id);
    });

    item.append(button, removeButton);
    container.appendChild(item);
  });
}

export function renderMessages(options) {
  const {
    container,
    messageTemplate,
    messages,
    streamingIndex,
    editingMessageIndex,
    abortControllerActive,
    onStartEdit,
    onRegenerate,
    onCancelEdit
  } = options;

  container.innerHTML = "";

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "message-empty";
    empty.textContent = "Start a new conversation. Adjust the model, system prompt, and parameters before sending your first message.";
    container.appendChild(empty);
    return;
  }

  messages.forEach((message, index) => {
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

    if (message.role === "user" && !abortControllerActive) {
      editButton.hidden = false;
      editButton.addEventListener("click", () => onStartEdit(index));
    } else {
      editButton.hidden = true;
    }

    renderMessageBody(body, message, index, editingMessageIndex, onRegenerate, onCancelEdit);
    container.appendChild(node);
  });

  container.scrollTop = container.scrollHeight;
}

export function renderPendingImage(container, pendingImage, onRemove) {
  container.innerHTML = "";

  if (!pendingImage) {
    container.hidden = true;
    return;
  }

  container.hidden = false;

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
  removeButton.addEventListener("click", onRemove);

  copy.append(title, meta);
  card.append(preview, copy, removeButton);
  container.appendChild(card);
}

export function showRuntimeNotice(element, message) {
  element.hidden = false;
  element.textContent = message;
}

export function hideRuntimeNotice(element) {
  element.hidden = true;
  element.textContent = "";
}

export function setComposerEnabled(elements, enabled, hasSpeechRecognition) {
  elements.userInput.disabled = !enabled;
  elements.sendButton.disabled = !enabled;
  elements.attachImageButton.disabled = !enabled;
  elements.voiceInputButton.disabled = hasSpeechRecognition ? !enabled : true;
}

export function setStreamingUi(elements, active, hasSpeechRecognition) {
  elements.stopButton.disabled = !active;
  elements.sendButton.disabled = active;
  elements.userInput.disabled = active;
  elements.attachImageButton.disabled = active;
  if (hasSpeechRecognition) {
    elements.voiceInputButton.disabled = active;
  }
}

function renderMessageBody(body, message, index, editingMessageIndex, onRegenerate, onCancelEdit) {
  body.innerHTML = "";

  if (editingMessageIndex === index && message.role === "user") {
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
    regenerateButton.addEventListener("click", () => onRegenerate(index, textarea.value));

    const cancelButton = document.createElement("button");
    cancelButton.className = "secondary-button";
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", onCancelEdit);

    buttonRow.append(regenerateButton, cancelButton);
    wrapper.append(textarea, buttonRow);
    body.appendChild(wrapper);
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
