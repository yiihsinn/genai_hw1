const fs = require("fs");

function createMemoryStore(memoryFile) {
  const lockFile = `${memoryFile}.lock`;

  ensureMemoryStore();

  return {
    ensureMemoryStore,
    getMemoryEntries,
    addMemory,
    deleteMemoryEntry
  };

  function ensureMemoryStore() {
    if (fs.existsSync(memoryFile)) {
      return;
    }

    fs.writeFileSync(memoryFile, JSON.stringify({ entries: [] }, null, 2));
  }

  function getMemoryEntries() {
    return withMemoryLock(() => {
      const store = readMemoryStoreUnsafe();
      return [...store.entries].sort((left, right) => {
        return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
    });
  }

  function addMemory(input) {
    const summary = typeof input?.summary === "string" ? input.summary.trim() : "";
    if (!summary) {
      return null;
    }

    return withMemoryLock(() => {
      const store = readMemoryStoreUnsafe();
      const now = new Date().toISOString();
      const sourceMessageCount = clampInteger(input?.sourceMessageCount, 0, 10_000, 0);
      const existingIndex = store.entries.findIndex((entry) => entry.id === input?.id);

      if (existingIndex >= 0) {
        const existing = store.entries[existingIndex];
        const updated = {
          ...existing,
          summary,
          updatedAt: now,
          sourceMessageCount
        };
        store.entries[existingIndex] = updated;
        writeMemoryStoreUnsafe(store);
        return updated;
      }

      const entry = {
        id: createId(),
        summary,
        createdAt: now,
        updatedAt: now,
        sourceMessageCount
      };

      store.entries.push(entry);
      writeMemoryStoreUnsafe(store);
      return entry;
    });
  }

  function deleteMemoryEntry(id) {
    return withMemoryLock(() => {
      const store = readMemoryStoreUnsafe();
      const nextEntries = store.entries.filter((entry) => entry.id !== id);

      if (nextEntries.length === store.entries.length) {
        return false;
      }

      store.entries = nextEntries;
      writeMemoryStoreUnsafe(store);
      return true;
    });
  }

  function withMemoryLock(task) {
    acquireMemoryLock();

    try {
      return task();
    } finally {
      releaseMemoryLock();
    }
  }

  function acquireMemoryLock() {
    const deadline = Date.now() + 2_000;

    while (true) {
      try {
        fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
        return;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }

        if (Date.now() > deadline) {
          throw new Error("Timed out while waiting for memory lock.");
        }
      }
    }
  }

  function releaseMemoryLock() {
    try {
      fs.unlinkSync(lockFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  function readMemoryStoreUnsafe() {
    ensureMemoryStore();

    try {
      const raw = fs.readFileSync(memoryFile, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];

      return {
        entries: entries
          .map(normalizeMemoryEntry)
          .filter(Boolean)
      };
    } catch {
      return { entries: [] };
    }
  }

  function writeMemoryStoreUnsafe(store) {
    const normalizedStore = {
      entries: Array.isArray(store?.entries)
        ? store.entries.map(normalizeMemoryEntry).filter(Boolean)
        : []
    };

    fs.writeFileSync(memoryFile, `${JSON.stringify(normalizedStore, null, 2)}\n`);
  }
}

function normalizeMemoryEntry(entry) {
  if (!entry || typeof entry.summary !== "string" || !entry.summary.trim()) {
    return null;
  }

  const createdAt = isIsoDateString(entry.createdAt) ? entry.createdAt : new Date().toISOString();
  const updatedAt = isIsoDateString(entry.updatedAt) ? entry.updatedAt : createdAt;

  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id : createId(),
    summary: entry.summary.trim(),
    createdAt,
    updatedAt,
    sourceMessageCount: clampInteger(entry.sourceMessageCount, 0, 10_000, 0)
  };
}

function isIsoDateString(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function createId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

module.exports = {
  createMemoryStore
};
