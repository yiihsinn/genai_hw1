export function renderMemoryEntries(container, badge, entries, onDelete) {
  container.innerHTML = "";
  badge.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "memory-empty";
    empty.textContent = "No persistent memory yet. Save preferences or let auto-summarization collect them after long chats.";
    container.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
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
    button.addEventListener("click", () => onDelete(entry.id));

    footer.append(meta, button);
    card.append(summary, footer);
    container.appendChild(card);
  });
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
