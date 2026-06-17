const LOCAL_MIRROR_KEY = "filum-state-v1";
const DEFAULT_STEP = "capture";
const PERSIST_DEBOUNCE_MS = 400;
const steps = ["capture", "plan", "line"];

const MAX_IMAGE_EDGE = 1000;
const IMAGE_QUALITY = 0.82;
const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]}'"])/gi;
const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  threadId: null,
  threadName: "Untitled thread",
  tasks: [],
  currentStep: DEFAULT_STEP,
  focusIndex: 0,
};

let threadList = [];
let isDirty = false;
let isOffline = false;
let persistTimer = null;
let eventsBound = false;
let authEventsBound = false;

// Transient, never-persisted UI state.
let captureImages = []; // images staged for the next captured task
let editingTaskId = null; // task currently being edited in place (null = none)
let editingImages = []; // working copy of that task's images while editing
let untangleToken = 0; // bumped to cancel any in-flight untangle animation
let threadMenuOpen = false; // is the saved-threads dropdown open?

// Option lists for the in-place editor's selects, kept in sync with the
// capture form in index.html.
const URGENCY_OPTS = [["", "Skip"], ["Quiet", "Quiet"], ["Soon", "Soon"], ["Now", "Now"]];
const ENERGY_OPTS = [["", "Skip"], ["Light", "Light"], ["Steady", "Steady"], ["Deep", "Deep"]];
const TYPE_OPTS = [
  ["", "Skip"],
  ["Admin", "Admin"],
  ["Creative", "Creative"],
  ["Errand", "Errand"],
  ["Thinking", "Thinking"],
];

const elements = {
  authScreen: document.getElementById("authScreen"),
  vaultScreen: document.getElementById("vaultScreen"),
  vaultForm: document.getElementById("vaultForm"),
  vaultPassphrase: document.getElementById("vaultPassphrase"),
  googleSignInButton: document.getElementById("googleSignInButton"),
  sessionPanel: document.getElementById("sessionPanel"),
  accountLabel: document.getElementById("accountLabel"),
  signOutButton: document.getElementById("signOutButton"),
  taskForm: document.getElementById("taskForm"),
  taskTitle: document.getElementById("taskTitle"),
  taskUrgency: document.getElementById("taskUrgency"),
  taskEnergy: document.getElementById("taskEnergy"),
  taskType: document.getElementById("taskType"),
  taskNotes: document.getElementById("taskNotes"),
  taskCount: document.getElementById("taskCount"),
  taskPreviewList: document.getElementById("taskPreviewList"),
  miniThreadSvg: document.getElementById("miniThreadSvg"),
  captureAddImageButton: document.getElementById("captureAddImageButton"),
  captureImageInput: document.getElementById("captureImageInput"),
  captureAttachments: document.getElementById("captureAttachments"),
  finishAggregationButton: document.getElementById("finishAggregationButton"),
  resetButton: document.getElementById("resetButton"),
  toLineButton: document.getElementById("toLineButton"),
  focusPrevButton: document.getElementById("focusPrevButton"),
  focusNextButton: document.getElementById("focusNextButton"),
  planningList: document.getElementById("planningList"),
  lineSvg: document.getElementById("lineSvg"),
  linePanel: document.querySelector('.panel[data-step="line"]'),
  linearList: document.getElementById("linearList"),
  focusTitle: document.getElementById("focusTitle"),
  focusMeta: document.getElementById("focusMeta"),
  focusNotes: document.getElementById("focusNotes"),
  focusAttachments: document.getElementById("focusAttachments"),
  focusEditButton: document.getElementById("focusEditButton"),
  focusEditor: document.getElementById("focusEditor"),
  stepButtons: Array.from(document.querySelectorAll(".step")),
  panels: Array.from(document.querySelectorAll(".panel")),
  threadMenuButton: document.getElementById("threadMenuButton"),
  threadMenuLabel: document.getElementById("threadMenuLabel"),
  threadMenu: document.getElementById("threadMenu"),
  threadNameInput: document.getElementById("threadNameInput"),
  saveThreadButton: document.getElementById("saveThreadButton"),
  newThreadButton: document.getElementById("newThreadButton"),
  threadStatus: document.getElementById("threadStatus"),
};

const authState = {
  enabled: false,
  googleClientId: null,
  user: null,
};

const vaultState = {
  unlocked: false,
  key: null,
  salt: null,
  iterations: 210000,
  unlockedAt: null,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const VAULT_SALT_KEY = "filum-vault-salt-v1";
const BASE_PATH =
  typeof window !== "undefined" && typeof window.__FILUM_BASE_PATH__ === "string"
    ? window.__FILUM_BASE_PATH__.replace(/\/$/, "")
    : "";

function appPath(pathname) {
  return `${BASE_PATH}${pathname}`;
}

const storage = {
  async listThreads() {
    const res = await fetch(appPath("/api/threads"), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    const threads = await res.json();
    if (!authState.enabled) return threads;
    return Promise.all(threads.map(async (thread) => decryptThreadSummary(thread))).then((items) =>
      items.filter(Boolean)
    );
  },
  async loadThread(id) {
    const res = await fetch(appPath(`/api/threads/${encodeURIComponent(id)}`));
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    const thread = await res.json();
    return authState.enabled ? decryptThreadEnvelope(thread) : thread;
  },
  async createThread(name, threadState) {
    const payload = authState.enabled ? await encryptThreadState(name, threadState) : { name, state: threadState };
    const res = await fetch(appPath("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authState.enabled ? payload : { name, state: threadState }),
    });
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    const thread = await res.json();
    return authState.enabled ? decryptThreadEnvelope(thread) : thread;
  },
  async saveThread(thread) {
    const payload = authState.enabled ? await encryptThreadState(thread.name, thread.state) : { name: thread.name, state: thread.state };
    const res = await fetch(appPath(`/api/threads/${encodeURIComponent(thread.id)}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        authState.enabled
          ? { ...payload, encrypted: true }
          : { name: thread.name, state: thread.state }
      ),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    const saved = await res.json();
    return authState.enabled ? decryptThreadEnvelope(saved) : saved;
  },
};

initializeApp();
registerServiceWorker();

async function initializeApp() {
  try {
    bindAuthEvents();
    await loadAuthConfig();
    applyAuthUiState();
    if (authState.enabled && !authState.user) {
      showAuthScreen();
      await renderGoogleSignIn();
      return;
    }
    if (authState.enabled && !vaultState.unlocked) {
      showVaultScreen();
      bindVaultEvents();
      return;
    }
    hideAuthScreen();
    await bootstrapWorkspace();
  } catch (err) {
    console.error("[filum] startup failed:", err);
    showAuthScreen();
    setAuthMessage("Filum could not start. Check the server connection.");
  }
}

async function loadAuthConfig() {
  const res = await fetch(appPath("/api/config"), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`config failed: ${res.status}`);
  const config = await res.json();
  authState.enabled = Boolean(config.authEnabled);
  authState.googleClientId = config.googleClientId || null;
  authState.user = config.user || null;
}

function loadVaultSalt() {
  try {
    const existing = localStorage.getItem(VAULT_SALT_KEY);
    if (existing) return existing;
    const salt = cryptoRandomBase64(16);
    localStorage.setItem(VAULT_SALT_KEY, salt);
    return salt;
  } catch {
    return cryptoRandomBase64(16);
  }
}

function cryptoRandomBase64(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = "";
  buf.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

async function deriveVaultKey(passphrase, saltB64, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)),
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptThreadState(name, stateObject) {
  if (!vaultState.key) throw new Error("vault not unlocked");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify({ name, state: stateObject }));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, vaultState.key, plaintext);
  return {
    encrypted: true,
    vault: {
      v: 1,
      alg: "AES-GCM",
      kdf: "PBKDF2",
      iterations: vaultState.iterations,
      salt: vaultState.salt,
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(data))),
    },
  };
}

async function decryptThreadEnvelope(thread) {
  if (!thread || !thread.encrypted) return thread;
  const vault = thread.vault;
  if (!vaultState.key || !vault || !vault.data || !vault.iv) {
    throw new Error("vault locked");
  }
  const iv = Uint8Array.from(atob(vault.iv), (c) => c.charCodeAt(0));
  const data = Uint8Array.from(atob(vault.data), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, vaultState.key, data);
  const parsed = JSON.parse(textDecoder.decode(plaintext));
  return {
    ...thread,
    name: parsed.name || thread.name || "Untitled thread",
    state: parsed.state || emptyStateObject(),
  };
}

async function decryptThreadSummary(thread) {
  if (!thread) return null;
  if (!thread.encrypted) return thread;
  try {
    return await decryptThreadEnvelope(thread);
  } catch {
    return { ...thread, name: "Locked thread" };
  }
}

function bindAuthEvents() {
  if (authEventsBound) return;
  authEventsBound = true;
  if (elements.signOutButton) {
    elements.signOutButton.addEventListener("click", handleSignOut);
  }
}

function bindVaultEvents() {
  if (elements.vaultForm && !elements.vaultForm.dataset.bound) {
    elements.vaultForm.dataset.bound = "1";
    elements.vaultForm.addEventListener("submit", handleVaultUnlock);
  }
}

function applyAuthUiState() {
  const locked = authState.enabled && !authState.user;
  document.body.classList.toggle("is-auth-locked", locked);
  if (elements.sessionPanel) {
    elements.sessionPanel.hidden = !authState.user;
  }
  if (elements.accountLabel) {
    elements.accountLabel.textContent = authState.user
      ? authState.user.email || authState.user.name || "Signed in"
      : "";
  }
}

function showAuthScreen() {
  if (elements.authScreen) elements.authScreen.hidden = false;
  if (document.querySelector(".app-shell")) document.querySelector(".app-shell").hidden = true;
}

function hideAuthScreen() {
  if (elements.authScreen) elements.authScreen.hidden = true;
  if (elements.vaultScreen) elements.vaultScreen.hidden = true;
  if (document.querySelector(".app-shell")) document.querySelector(".app-shell").hidden = false;
}

function showVaultScreen() {
  if (elements.vaultScreen) elements.vaultScreen.hidden = false;
  if (document.querySelector(".app-shell")) document.querySelector(".app-shell").hidden = true;
}

function requireVaultUnlocked(actionLabel) {
  if (!authState.enabled || vaultState.key) return true;
  showVaultScreen();
  bindVaultEvents();
  setAuthMessage(actionLabel || "Unlock your vault to continue.");
  return false;
}

async function renderGoogleSignIn() {
  if (!elements.googleSignInButton) return;
  if (!authState.googleClientId) {
    elements.googleSignInButton.textContent = "Google sign-in is not configured on this server.";
    return;
  }
  try {
    await waitForGoogleLibrary();
  } catch (err) {
    console.warn("[filum] Google Identity Services unavailable:", err);
    elements.googleSignInButton.textContent = "Google sign-in could not load.";
    return;
  }
  if (!window.google?.accounts?.id) {
    elements.googleSignInButton.textContent = "Google sign-in could not load.";
    return;
  }
  elements.googleSignInButton.innerHTML = "";
  window.google.accounts.id.initialize({
    client_id: authState.googleClientId,
    callback: handleGoogleCredential,
  });
  window.google.accounts.id.renderButton(elements.googleSignInButton, {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "signin_with",
    width: 280,
  });
}

function waitForGoogleLibrary() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (window.google?.accounts?.id) {
        window.clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 10000) {
        window.clearInterval(timer);
        reject(new Error("Google Identity Services timed out"));
      }
    }, 50);
  });
}

async function handleGoogleCredential(response) {
  try {
    const res = await fetch(appPath("/auth/google"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    if (!res.ok) {
      throw new Error(`sign-in failed: ${res.status}`);
    }
    const payload = await res.json();
    authState.user = payload.user || null;
    applyAuthUiState();
    if (!vaultState.unlocked) {
      showVaultScreen();
      bindVaultEvents();
      return;
    }
    hideAuthScreen();
    await bootstrapWorkspace();
  } catch (err) {
    console.warn("[filum] Google sign-in failed:", err);
    setAuthMessage("Google sign-in failed. Try again.");
  }
}

async function handleVaultUnlock(event) {
  event.preventDefault();
  const input = elements.vaultPassphrase;
  const passphrase = input && input.value ? input.value : "";
  if (passphrase.length < 8) {
    setAuthMessage("Use a longer passphrase.");
    return;
  }
  const salt = loadVaultSalt();
  const key = await deriveVaultKey(passphrase, salt, vaultState.iterations);
  vaultState.key = key;
  vaultState.salt = salt;
  vaultState.unlocked = true;
  vaultState.unlockedAt = new Date().toISOString();
  hideAuthScreen();
  await bootstrapWorkspace();
}

async function handleSignOut() {
  try {
    await fetch(appPath("/auth/logout"), { method: "POST" });
  } catch (err) {
    console.warn("[filum] sign-out failed:", err);
  } finally {
    authState.user = null;
    vaultState.unlocked = false;
    vaultState.key = null;
    applyAuthUiState();
    showAuthScreen();
    await renderGoogleSignIn();
  }
}

function setAuthMessage(message) {
  if (!elements.googleSignInButton) return;
  elements.googleSignInButton.textContent = message;
}

async function bootstrapWorkspace() {
  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }
  try {
    threadList = await storage.listThreads();
    let thread;
    if (threadList.length === 0) {
      thread = await storage.createThread("Untitled thread", emptyStateObject());
      threadList = [thread];
    } else {
      thread = await storage.loadThread(threadList[0].id);
    }
    hydrate(thread);
    setStatus(`Saved · ${formatTime(thread.updatedAt)}`);
  } catch (err) {
    console.warn("[filum] starting offline:", err);
    isOffline = true;
    hydrate(loadOfflineMirror());
    setStatus("Working offline — server not reachable");
  }
  renderThreadMenu();
  render();
}

function hydrate(thread) {
  state.threadId = thread.id || null;
  state.threadName = thread.name || "Untitled thread";
  const incoming = thread.state || emptyStateObject();
  state.tasks = Array.isArray(incoming.tasks) ? incoming.tasks.map(normalizeTask) : [];
  state.currentStep = steps.includes(incoming.currentStep) ? incoming.currentStep : DEFAULT_STEP;
  state.focusIndex = Number.isInteger(incoming.focusIndex) ? incoming.focusIndex : 0;
  if (state.focusIndex >= state.tasks.length) {
    state.focusIndex = Math.max(0, state.tasks.length - 1);
  }
  isDirty = false;
}

function emptyStateObject() {
  return { tasks: [], currentStep: DEFAULT_STEP, focusIndex: 0 };
}

// Back-fill any fields that older thread files predate, so every task the rest
// of the app sees has a predictable shape.
function normalizeTask(task) {
  const t = task && typeof task === "object" ? task : {};
  return {
    id: typeof t.id === "string" && t.id ? t.id : crypto.randomUUID(),
    title: typeof t.title === "string" ? t.title : "",
    urgency: typeof t.urgency === "string" ? t.urgency : "",
    energy: typeof t.energy === "string" ? t.energy : "",
    type: typeof t.type === "string" ? t.type : "",
    notes: typeof t.notes === "string" ? t.notes : "",
    duration: typeof t.duration === "string" ? t.duration : "",
    images: Array.isArray(t.images)
      ? t.images
          .filter((img) => img && typeof img.src === "string" && img.src)
          .map((img) => ({
            id: typeof img.id === "string" && img.id ? img.id : crypto.randomUUID(),
            src: img.src,
            alt: typeof img.alt === "string" ? img.alt : "",
          }))
      : [],
  };
}

function bindEvents() {
  elements.taskForm.addEventListener("submit", handleAddTask);
  elements.finishAggregationButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      elements.taskTitle.focus();
      return;
    }
    setStep("plan");
  });
  elements.toLineButton.addEventListener("click", () => {
    if (!state.tasks.length) {
      setStep("capture");
      return;
    }
    playUntangle();
  });

  bindCaptureImages();
  if (elements.focusNextButton) {
    elements.focusNextButton.addEventListener("click", nextFocusTask);
  }
  if (elements.focusPrevButton) {
    elements.focusPrevButton.addEventListener("click", prevFocusTask);
  }
  elements.resetButton.addEventListener("click", resetState);

  if (elements.linePanel) {
    elements.linePanel.addEventListener("keydown", (event) => {
      // Never hijack arrows while editing — they belong to the inline editor's
      // fields and selects, not task navigation.
      if (editingTaskId !== null || event.target.closest(".inline-editor")) return;
      if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        nextFocusTask();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        prevFocusTask();
      }
    });
  }

  if (elements.linearList) {
    elements.linearList.addEventListener("click", (event) => {
      const item = event.target.closest(".linear-item");
      if (!item) return;
      const index = Number(item.dataset.focusIndex);
      if (Number.isInteger(index)) setFocusIndex(index);
    });
    elements.linearList.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const item = event.target.closest(".linear-item");
      if (!item) return;
      event.preventDefault();
      const index = Number(item.dataset.focusIndex);
      if (Number.isInteger(index)) setFocusIndex(index);
    });
  }

  elements.stepButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.stepTarget;
      if ((target === "plan" || target === "line") && !state.tasks.length) {
        return;
      }
      setStep(target);
    });
  });

  if (elements.taskPreviewList) {
    elements.taskPreviewList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-edit-task]");
      if (!trigger) return;
      startEdit(trigger.dataset.editTask);
    });
  }

  if (elements.focusEditButton) {
    elements.focusEditButton.addEventListener("click", () => {
      const current = state.tasks[state.focusIndex];
      if (current) startEdit(current.id);
    });
  }

  if (elements.threadMenuButton) {
    elements.threadMenuButton.addEventListener("click", toggleThreadMenu);
  }
  if (elements.threadMenu) {
    elements.threadMenu.addEventListener("click", (event) => {
      const row = event.target.closest("[data-thread-id]");
      if (row) openThreadById(row.dataset.threadId);
    });
    elements.threadMenu.addEventListener("keydown", handleThreadMenuKeydown);
  }
  // Close the dropdown on an outside click or Escape.
  document.addEventListener("click", (event) => {
    if (threadMenuOpen && !event.target.closest(".thread-menu")) closeThreadMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && threadMenuOpen) closeThreadMenu();
  });

  if (elements.threadNameInput) {
    elements.threadNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitRename();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelRename();
      }
    });
    elements.threadNameInput.addEventListener("blur", commitRename);
  }

  if (elements.saveThreadButton) {
    elements.saveThreadButton.addEventListener("click", startRename);
  }
  if (elements.newThreadButton) {
    elements.newThreadButton.addEventListener("click", handleNewThread);
  }

  window.addEventListener("resize", renderVisuals);
  window.addEventListener("beforeunload", flushPersistOnUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistOnUnload();
  });
}

function handleAddTask(event) {
  event.preventDefault();

  const title = elements.taskTitle.value.trim();
  if (!title) {
    elements.taskTitle.focus();
    return;
  }

  state.tasks.push({
    id: crypto.randomUUID(),
    title,
    urgency: elements.taskUrgency.value,
    energy: elements.taskEnergy.value,
    type: elements.taskType.value,
    notes: elements.taskNotes.value.trim(),
    duration: "",
    images: captureImages.slice(),
  });

  if (state.focusIndex >= state.tasks.length - 1) {
    state.focusIndex = state.tasks.length - 1;
  }

  elements.taskForm.reset();
  captureImages = [];
  renderCaptureAttachments();
  elements.taskTitle.focus();
  markDirty();
  render();
}

function resetState() {
  state.tasks = [];
  state.currentStep = DEFAULT_STEP;
  state.focusIndex = 0;
  captureImages = [];
  renderCaptureAttachments();
  markDirty();
  render();
}

function setFocusIndex(index) {
  if (!state.tasks.length) return;
  const clamped = Math.max(0, Math.min(index, state.tasks.length - 1));
  if (clamped === state.focusIndex) return;
  state.focusIndex = clamped;
  markDirty();
  renderLine();
  renderLineThread();
  bindInlineEditor(); // re-wire the editor if it re-rendered for the new focus
}

function nextFocusTask() {
  if (!state.tasks.length) return;
  setFocusIndex(state.focusIndex + 1);
}

function prevFocusTask() {
  if (!state.tasks.length) return;
  setFocusIndex(state.focusIndex - 1);
}

function setStep(step) {
  // Switching steps cancels any in-progress in-place edit.
  const wasEditing = editingTaskId !== null;
  if (wasEditing) {
    editingTaskId = null;
    editingImages = [];
  }
  state.currentStep = steps.includes(step) ? step : DEFAULT_STEP;
  markDirty();
  if (wasEditing) {
    render();
  } else {
    renderStepState();
  }
}

// ---- Saved-threads dropdown ---------------------------------------------

function toggleThreadMenu() {
  if (threadMenuOpen) closeThreadMenu();
  else openThreadMenu();
}

async function openThreadMenu() {
  if (!elements.threadMenu) return;
  threadMenuOpen = true;
  elements.threadMenu.hidden = false;
  if (elements.threadMenuButton) elements.threadMenuButton.setAttribute("aria-expanded", "true");
  renderThreadMenu(); // show what we already have, then refresh from disk
  await refreshThreadList();
  const first = elements.threadMenu.querySelector(".thread-menu-row");
  if (first) first.focus();
}

function closeThreadMenu() {
  if (!threadMenuOpen) return;
  threadMenuOpen = false;
  const hadFocusInside =
    elements.threadMenu && elements.threadMenu.contains(document.activeElement);
  if (elements.threadMenu) elements.threadMenu.hidden = true;
  if (elements.threadMenuButton) {
    elements.threadMenuButton.setAttribute("aria-expanded", "false");
    if (hadFocusInside) elements.threadMenuButton.focus();
  }
}

function handleThreadMenuKeydown(event) {
  const rows = Array.from(elements.threadMenu.querySelectorAll(".thread-menu-row"));
  if (!rows.length) return;
  const idx = rows.indexOf(document.activeElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    rows[Math.min(rows.length - 1, idx + 1)].focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    rows[Math.max(0, idx - 1)].focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    rows[0].focus();
  } else if (event.key === "End") {
    event.preventDefault();
    rows[rows.length - 1].focus();
  }
}

// Build the dropdown rows from the directory listing. The open thread is always
// represented (even if the listing hasn't caught it yet) and marked.
function renderThreadMenu() {
  if (elements.threadMenuLabel) {
    elements.threadMenuLabel.textContent = state.threadName || "Untitled thread";
  }
  if (!elements.threadMenu) return;
  const current = state.threadId;

  const items = threadList.slice();
  if (current && !items.some((t) => t.id === current)) {
    items.unshift({ id: current, name: state.threadName, updatedAt: new Date().toISOString() });
  }
  const others = items.filter((t) => t.id !== current);

  if (!others.length) {
    elements.threadMenu.innerHTML = `<p class="thread-menu-empty">${
      isOffline ? "Threads list when the server is running." : "No other saved threads yet."
    }</p>`;
    return;
  }

  elements.threadMenu.innerHTML = items
    .map((thread) => {
      const isCurrent = thread.id === current;
      const name = thread.name || "Untitled thread";
      const when = isCurrent ? "open now" : formatTime(thread.updatedAt);
      return `
        <button class="thread-menu-row ${isCurrent ? "is-current" : ""}" type="button" role="option"
          data-thread-id="${escapeHtml(thread.id)}" ${isCurrent ? 'aria-current="true"' : ""}>
          <span class="thread-menu-row-name">${escapeHtml(name)}</span>
          <span class="thread-menu-row-time">${escapeHtml(when)}</span>
        </button>`;
    })
    .join("");
}

// Open a saved thread, saving the current one in its present state first.
async function openThreadById(id) {
  if (!id || id === state.threadId) {
    closeThreadMenu();
    return;
  }
  if (!requireVaultUnlocked("Unlock your vault to open threads.")) return;
  closeThreadMenu();
  await flushPersistImmediate();
  try {
    const thread = await storage.loadThread(id);
    hydrate(thread);
    setStatus(`Opened · ${formatTime(thread.updatedAt)}`);
    render();
  } catch (err) {
    console.warn("[filum] open failed:", err);
    setStatus("Could not open thread");
  }
}

// ---- Inline rename (replaces the old window.prompt) ----------------------

function startRename() {
  if (!elements.threadNameInput) return;
  closeThreadMenu();
  elements.threadNameInput.value = state.threadName || "";
  elements.threadNameInput.hidden = false;
  if (elements.threadMenuButton) elements.threadMenuButton.hidden = true;
  elements.threadNameInput.focus();
  elements.threadNameInput.select();
}

async function commitRename() {
  if (!elements.threadNameInput || elements.threadNameInput.hidden) return;
  const trimmed = elements.threadNameInput.value.trim() || "Untitled thread";
  hideRenameInput(); // hide first so the resulting blur is a no-op
  state.threadName = trimmed;
  if (elements.threadMenuLabel) elements.threadMenuLabel.textContent = trimmed;
  await flushPersistImmediate();
  await refreshThreadList();
  setStatus(`Saved as “${trimmed}”`);
}

function cancelRename() {
  hideRenameInput();
}

function hideRenameInput() {
  if (!elements.threadNameInput) return;
  elements.threadNameInput.hidden = true;
  if (elements.threadMenuButton) elements.threadMenuButton.hidden = false;
}

async function handleNewThread() {
  if (!requireVaultUnlocked("Unlock your vault to create a new thread.")) return;
  await flushPersistImmediate(); // autosave already persists; save current silently
  try {
    const thread = await storage.createThread("Untitled thread", emptyStateObject());
    hydrate(thread);
    await refreshThreadList();
    setStatus("New thread started");
    render();
  } catch (err) {
    console.warn("[filum] create failed:", err);
    setStatus("Could not start a new thread");
  }
}

async function refreshThreadList() {
  try {
    threadList = await storage.listThreads();
    isOffline = false;
    renderThreadMenu();
  } catch (err) {
    console.warn("[filum] list failed:", err);
    isOffline = true;
    renderThreadMenu();
  }
}

function markDirty() {
  isDirty = true;
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(flushPersistImmediate, PERSIST_DEBOUNCE_MS);
}

async function flushPersistImmediate() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!state.threadId) {
    saveOfflineMirror();
    return;
  }
  const thread = {
    id: state.threadId,
    name: state.threadName,
    state: { tasks: state.tasks, currentStep: state.currentStep, focusIndex: state.focusIndex },
  };
  try {
    const saved = await storage.saveThread(thread);
    isDirty = false;
    if (isOffline) {
      isOffline = false;
    }
    setStatus(`Saved · ${formatTime(saved.updatedAt)}`);
  } catch (err) {
    console.warn("[filum] save failed, mirroring locally:", err);
    isOffline = true;
    saveOfflineMirror();
    setStatus(`Working offline — local copy at ${formatTime(new Date().toISOString())}`);
  }
}

function flushPersistOnUnload() {
  if (!state.threadId) {
    saveOfflineMirror();
    return;
  }
  saveOfflineMirror();
  const body = JSON.stringify({
    name: state.threadName,
    state: { tasks: state.tasks, currentStep: state.currentStep, focusIndex: state.focusIndex },
  });
  // keepalive PUT is the reliable cross-browser path for unload writes.
  try {
    fetch(appPath(`/api/threads/${encodeURIComponent(state.threadId)}`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore — the localStorage mirror above is the safety net.
  }
}

function saveOfflineMirror() {
  try {
    if (authState.enabled) return;
    const payload = {
      threadId: state.threadId,
      threadName: state.threadName,
      tasks: state.tasks,
      currentStep: state.currentStep,
      focusIndex: state.focusIndex,
      mirroredAt: new Date().toISOString(),
    };
    localStorage.setItem(LOCAL_MIRROR_KEY, JSON.stringify(payload));
  } catch {
    // storage may be full or disabled; ignore quietly
  }
}

function loadOfflineMirror() {
  try {
    const raw = localStorage.getItem(LOCAL_MIRROR_KEY);
    if (!raw) return { id: null, name: "Untitled thread", state: emptyStateObject() };
    const parsed = JSON.parse(raw);
    return {
      id: parsed.threadId || null,
      name: parsed.threadName || "Untitled thread",
      state: {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        currentStep: parsed.currentStep || DEFAULT_STEP,
        focusIndex: parsed.focusIndex || 0,
      },
    };
  } catch {
    return { id: null, name: "Untitled thread", state: emptyStateObject() };
  }
}

function setStatus(text) {
  if (!elements.threadStatus) return;
  elements.threadStatus.textContent = text;
}

function formatTime(iso) {
  if (!iso) return "just now";
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "just now";
  }
}

function render() {
  renderStepState();
  renderTaskPreview();
  renderCaptureAttachments();
  renderPlanningList();
  renderVisuals();
  renderLine();
  bindInlineEditor();
  if (elements.threadMenuLabel) {
    elements.threadMenuLabel.textContent = state.threadName || "Untitled thread";
  }
}

function renderStepState() {
  const activeStep = state.currentStep || DEFAULT_STEP;

  elements.stepButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.stepTarget === activeStep);
  });

  elements.panels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.step === activeStep);
  });
}

function renderTaskPreview() {
  const count = state.tasks.length;
  elements.taskCount.textContent = `${count} task${count === 1 ? "" : "s"}`;

  if (!count) {
    elements.taskPreviewList.innerHTML =
      '<div class="empty-state empty-state--soft">Start with a simple task name. Add details only when they help.</div>';
    return;
  }

  const recent = state.tasks.slice(-3).reverse();
  const overflow = count - recent.length;
  const chips = recent
    .map((task) => {
      if (editingTaskId === task.id && state.currentStep === "capture") {
        return `<article class="task-chip task-chip--editing">${renderInlineEditor(task)}</article>`;
      }
      return `
        <article class="task-chip">
          <div class="task-chip-head">
            <strong>${escapeHtml(task.title)}</strong>
            <button class="ghost-button mini-edit" type="button" data-edit-task="${task.id}">Edit</button>
          </div>
          <p>${linkify(summarizeTask(task))}</p>
          ${renderThumbStrip(task.images)}
        </article>
      `;
    })
    .join("");
  const more = overflow > 0 ? `<div class="task-chip-more">+${overflow} earlier</div>` : "";

  elements.taskPreviewList.innerHTML = chips + more;
}

// The capture form's own attachment tray (images staged for the next task).
function renderCaptureAttachments() {
  renderEditableTray(elements.captureAttachments, captureImages, (id) => {
    captureImages = captureImages.filter((img) => img.id !== id);
    renderCaptureAttachments();
  });
}

// Step 1 preview: a tangled thread that knots tighter as tasks are added.
function renderMiniThread() {
  const svg = elements.miniThreadSvg;
  if (!svg) return;
  const count = state.tasks.length;
  const width = 220;
  const height = 180;

  const a11y = `
    <title id="miniThreadTitle">A small preview of your knot</title>
    <desc id="miniThreadDesc">${
      count === 0
        ? "No tasks gathered yet."
        : `A thread tangled by ${count} task${count === 1 ? "" : "s"}; it knots further as you add more.`
    }</desc>`;

  if (!count) {
    svg.innerHTML =
      a11y +
      '<text x="110" y="92" text-anchor="middle" font-family="Iowan Old Style, Palatino, Georgia, serif" font-size="13" fill="rgba(110,103,92,0.6)">a quiet thread</text>';
    return;
  }

  const points = tangleScatter(state.tasks, width, height, 28);
  // Knot density rises with count but is capped so the preview stays legible.
  const knot = Math.min(1, 0.5 + count * 0.06);
  const d = knottedPath(points, knot, 0.3);
  const lastIndex = count - 1;

  const dots = points
    .map((point, index) => {
      const isNew = index === lastIndex;
      const r = isNew ? 5 : 4;
      const cls = isNew ? "mini-node mini-node--enter" : "mini-node";
      return `<circle class="${cls}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${r}" />`;
    })
    .join("");

  svg.innerHTML = `
    ${a11y}
    <g class="mini-thread-line">
      <path d="${d}" fill="none" stroke="var(--line-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </g>
    ${dots}
  `;
}

function renderPlanningList() {
  if (!state.tasks.length) {
    elements.planningList.innerHTML =
      '<div class="empty-state">Your ordered thread will appear here once tasks are added.</div>';
    return;
  }

  elements.planningList.innerHTML = state.tasks
    .map((task, index) => {
      if (editingTaskId === task.id && state.currentStep === "plan") {
        return `<article class="plan-item plan-item--editing" data-task-id="${task.id}">${renderInlineEditor(task)}</article>`;
      }
      return `
        <article class="plan-item" data-task-id="${task.id}">
          <div>
            <div class="plan-item-head">
              <div>
                <strong>${index + 1}. ${escapeHtml(task.title)}</strong>
                <p>${linkify(summarizeTask(task))}</p>
                ${renderThumbStrip(task.images)}
              </div>
              <div class="plan-controls">
                <button class="ghost-button mini-edit" type="button" data-edit aria-label="Edit task">Edit</button>
                <button class="mini-button" type="button" data-move="up" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
                <button class="mini-button" type="button" data-move="down" ${index === state.tasks.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
              </div>
            </div>
          </div>
          <div class="plan-side">
            <label class="plan-time-label">
              <span>Time</span>
              <input type="text" value="${escapeHtml(task.duration || "")}" maxlength="40" placeholder="25 min" aria-describedby="duration-hint-${index}" />
              <small id="duration-hint-${index}" class="field-hint">e.g. 25 min, 1h, 1:30</small>
            </label>
          </div>
        </article>
      `;
    })
    .join("");

  elements.planningList.querySelectorAll(".plan-item").forEach((item) => {
    // The item being edited shows the inline editor; bindInlineEditor wires it.
    if (item.classList.contains("plan-item--editing")) return;
    const taskId = item.dataset.taskId;
    const input = item.querySelector("input");
    const up = item.querySelector('[data-move="up"]');
    const down = item.querySelector('[data-move="down"]');
    const edit = item.querySelector("[data-edit]");
    if (edit) edit.addEventListener("click", () => startEdit(taskId));

    input.addEventListener("input", (event) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const raw = event.target.value;
      const result = validateDuration(raw);
      input.classList.toggle("is-invalid", !result.ok);
      if (result.ok) {
        task.duration = result.normalized;
        markDirty();
        renderLine();
        renderLineThread();
      }
    });
    input.addEventListener("blur", (event) => {
      const task = state.tasks.find((entry) => entry.id === taskId);
      if (!task) return;
      const result = validateDuration(event.target.value);
      if (!result.ok) {
        event.target.value = task.duration || "";
        input.classList.remove("is-invalid");
      }
    });

    up.addEventListener("click", () => moveTask(taskId, -1));
    down.addEventListener("click", () => moveTask(taskId, 1));
  });
}

function validateDuration(raw) {
  const value = (raw || "").trim();
  if (!value) return { ok: true, normalized: "" };
  const patterns = [
    /^\d{1,3}\s?(m|min|mins|minute|minutes)$/i,
    /^\d{1,3}\s?(h|hr|hrs|hour|hours)$/i,
    /^\d{1,2}:\d{2}$/,
    /^\d{1,3}\s?(s|sec|secs)$/i,
  ];
  if (patterns.some((p) => p.test(value))) return { ok: true, normalized: value };
  return { ok: false, normalized: value };
}

function moveTask(taskId, direction) {
  const index = state.tasks.findIndex((task) => task.id === taskId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= state.tasks.length) {
    return;
  }

  const [task] = state.tasks.splice(index, 1);
  state.tasks.splice(targetIndex, 0, task);

  if (state.focusIndex === index) {
    state.focusIndex = targetIndex;
  } else if (direction < 0 && state.focusIndex === targetIndex) {
    state.focusIndex += 1;
  } else if (direction > 0 && state.focusIndex === targetIndex) {
    state.focusIndex -= 1;
  }

  markDirty();
  renderPlanningList();
  renderVisuals();
  renderLine();
  bindInlineEditor(); // re-wire the editor if reordering re-rendered it
}

function renderVisuals() {
  renderMiniThread();
  renderLineThread();
}

function renderLine() {
  const currentTask = state.tasks[state.focusIndex] || null;
  const editingHere = !!(currentTask && editingTaskId === currentTask.id && state.currentStep === "line");

  // The editor renders in place of the read-only "Do this now" content.
  if (elements.focusEditor) {
    elements.focusEditor.innerHTML = editingHere ? renderInlineEditor(currentTask) : "";
    elements.focusEditor.hidden = !editingHere;
  }
  [elements.focusTitle, elements.focusMeta, elements.focusNotes, elements.focusAttachments].forEach((el) => {
    if (el) el.hidden = editingHere;
  });

  if (!currentTask) {
    elements.focusTitle.textContent = "This thread is empty";
    elements.focusMeta.textContent = "Gather a few thoughts in Step 1 first.";
    elements.focusNotes.innerHTML = "";
    if (elements.focusEditButton) elements.focusEditButton.hidden = true;
  } else if (editingHere) {
    if (elements.focusEditButton) elements.focusEditButton.hidden = true;
  } else {
    elements.focusTitle.textContent = currentTask.title;
    elements.focusMeta.textContent = summarizeTaskMeta(currentTask);
    elements.focusNotes.innerHTML = currentTask.notes
      ? renderRichNotes(currentTask.notes)
      : '<span class="focus-notes-empty">No extra notes. Just begin.</span>';
    if (elements.focusEditButton) elements.focusEditButton.hidden = false;
  }
  renderReadonlyTray(elements.focusAttachments, currentTask && !editingHere ? currentTask.images : []);

  if (elements.focusPrevButton) {
    elements.focusPrevButton.disabled = !state.tasks.length || state.focusIndex <= 0;
  }
  if (elements.focusNextButton) {
    elements.focusNextButton.disabled =
      !state.tasks.length || state.focusIndex >= state.tasks.length - 1;
  }

  if (!state.tasks.length) {
    elements.linearList.innerHTML =
      '<div class="empty-state">Once you have a sequence, the thread will appear here.</div>';
    return;
  }

  elements.linearList.innerHTML = state.tasks
    .map(
      (task, index) => `
        <article class="linear-item ${index === state.focusIndex ? "is-current" : "is-muted"}"
          data-focus-index="${index}"
          role="button"
          tabindex="0"
          ${index === state.focusIndex ? 'aria-current="step"' : ""}>
          <div class="linear-item-index">Step ${index + 1}</div>
          <strong>${escapeHtml(task.title)}</strong>
          <p>${escapeHtml(lineCardSubtitle(task))}</p>
        </article>
      `
    )
    .join("");
}

function renderLineThread() {
  const svg = elements.lineSvg;
  if (!state.tasks.length) {
    svg.innerHTML =
      '<title id="lineTitle">An empty thread</title><desc id="lineDesc">No tasks ordered yet.</desc>';
    return;
  }

  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  const count = state.tasks.length;
  const startX = 70;
  const endX = width - 70;
  const stepX = count === 1 ? 0 : (endX - startX) / (count - 1);
  const midY = 120;

  const a11y = `
    <title id="lineTitle">A clear thread of ${count} step${count === 1 ? "" : "s"}</title>
    <desc id="lineDesc">Each dot is one task in the chosen order. The current focus is the larger dot.</desc>
  `;

  const dots = state.tasks
    .map((task, index) => {
      const x = startX + stepX * index;
      const isCurrent = index === state.focusIndex;
      return `
        <circle cx="${x}" cy="${midY}" r="${isCurrent ? 10 : 7}" fill="#111111" />
        <text x="${x}" y="${midY - 22}" text-anchor="middle" font-family="Avenir Next, Segoe UI, sans-serif" font-size="11" fill="rgba(22,22,22,0.5)">
          ${index + 1}
        </text>
      `;
    })
    .join("");

  svg.innerHTML = `
    ${a11y}
    <path
      d="M ${startX} ${midY} C ${width * 0.3} ${midY - 16}, ${width * 0.65} ${midY + 16}, ${endX} ${midY}"
      fill="none"
      stroke="rgba(18,18,18,0.86)"
      stroke-width="3"
      stroke-linecap="round"
    />
    ${dots}
  `;
}

function seededRand(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

// Deterministic scatter of one point per task, used by the Step 1 preview and
// the untangle animation. Same task ids always land in the same place.
function tangleScatter(tasks, width, height, pad) {
  const centerX = width / 2;
  const centerY = height / 2;
  const baseRadius = Math.min(width, height) * 0.3;

  return tasks.map((task, i) => {
    const rand = seededRand((task && task.id) || `task-${i}`);
    const angle = i * 1.82 + rand() * Math.PI * 2;
    const radius = baseRadius + ((i % 5) - 2) * (baseRadius * 0.18) + rand() * (baseRadius * 0.3);
    const x = centerX + Math.cos(angle) * radius + Math.sin(i * 0.7 + rand()) * (width * 0.08);
    const y = centerY + Math.sin(angle * 1.12) * (radius * 0.7) + Math.cos(i * 0.52 + rand()) * (height * 0.1);
    return {
      x: clamp(x, pad, width - pad),
      y: clamp(y, pad, height - pad),
    };
  });
}

// A single smooth path through `points`. `knot` (0..1) scales the loop overshoot
// of each segment — 1 is a heavy tangle, 0 is a clean line. `amp` scales the
// overshoot to the canvas size.
function knottedPath(points, knot, amp) {
  const scale = typeof amp === "number" ? amp : 1;
  if (!points.length) return "";
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const point = points[i];
    const k = knot * scale;
    const c1x = (prev.x + point.x) / 2 + Math.sin(i * 1.4) * 82 * k;
    const c1y = prev.y + Math.cos(i * 0.8) * 58 * k;
    const c2x = (prev.x + point.x) / 2 + Math.cos(i * 1.1) * -76 * k;
    const c2y = point.y + Math.sin(i * 1.2) * 52 * k;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }
  return d;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function summarizeTask(task) {
  const parts = [task.urgency, task.energy, task.type, task.duration].filter(Boolean);
  const summary = parts.join(" · ");
  const notes = task.notes ? truncate(task.notes, 140) : "";
  if (summary && notes) {
    return `${summary} · ${notes}`;
  }
  return summary || notes || "No extra triage";
}

function summarizeTaskMeta(task) {
  const parts = [task.urgency, task.energy, task.type, task.duration].filter(Boolean);
  return parts.join(" · ") || "Ready to begin.";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(text, max) {
  const clean = String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ---- Rich text & attachments --------------------------------------------
//
// Notes are plain text. We escape first, then turn bare URLs into anchors, so
// no user input is ever interpreted as HTML. Links are the only place colour
// (a calm blue) is allowed — see new_features/PRD.md §9.
function linkify(text) {
  const raw = String(text == null ? "" : text);
  let out = "";
  let lastIndex = 0;
  URL_PATTERN.lastIndex = 0;
  let match;
  while ((match = URL_PATTERN.exec(raw)) !== null) {
    out += escapeHtml(raw.slice(lastIndex, match.index));
    const urlText = match[0];
    const href = urlText.startsWith("www.") ? `https://${urlText}` : urlText;
    out += `<a class="rich-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(urlText)}</a>`;
    lastIndex = match.index + urlText.length;
  }
  out += escapeHtml(raw.slice(lastIndex));
  return out;
}

function renderRichNotes(notes) {
  return linkify(notes).replace(/\n/g, "<br />");
}

function renderThumbStrip(images) {
  if (!Array.isArray(images) || !images.length) return "";
  const thumbs = images
    .slice(0, 4)
    .map(
      (img) =>
        `<img class="thumb thumb--xs" src="${escapeHtml(img.src)}" alt="${escapeHtml(
          img.alt || "reference image"
        )}" loading="lazy" />`
    )
    .join("");
  const more = images.length > 4 ? `<span class="thumb-more">+${images.length - 4}</span>` : "";
  return `<div class="thumb-strip">${thumbs}${more}</div>`;
}

// Editable tray (capture form + edit modal): thumbnails with a remove button.
function renderEditableTray(container, images, onRemove) {
  if (!container) return;
  if (!Array.isArray(images) || !images.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = images
    .map(
      (img) => `
        <div class="attachment" data-img-id="${img.id}">
          <img class="thumb" src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt || "reference image")}" />
          <button class="thumb-remove" type="button" data-remove-img="${img.id}" aria-label="Remove image">×</button>
        </div>`
    )
    .join("");
  container.querySelectorAll("[data-remove-img]").forEach((btn) => {
    btn.addEventListener("click", () => onRemove(btn.dataset.removeImg));
  });
}

// Read-only tray (focus card): thumbnails that open full size in a new tab.
function renderReadonlyTray(container, images) {
  if (!container) return;
  if (!Array.isArray(images) || !images.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = images
    .map(
      (img) => `
        <a class="attachment-link" href="${escapeHtml(img.src)}" target="_blank" rel="noopener noreferrer">
          <img class="thumb thumb--lg" src="${escapeHtml(img.src)}" alt="${escapeHtml(
            img.alt || "reference image"
          )}" loading="lazy" />
        </a>`
    )
    .join("");
}

// Step 4 card subtitle: urgency if set, else the start of the description.
function lineCardSubtitle(task) {
  if (task.urgency) return task.urgency;
  if (task.notes && task.notes.trim()) return truncate(task.notes, 70);
  if (task.duration) return task.duration;
  return "No details yet";
}

// ---- Image attachment plumbing ------------------------------------------

function bindCaptureImages() {
  if (elements.captureAddImageButton && elements.captureImageInput) {
    elements.captureAddImageButton.addEventListener("click", () => elements.captureImageInput.click());
    elements.captureImageInput.addEventListener("change", async (event) => {
      await addFilesToImages(event.target.files, captureImages, renderCaptureAttachments);
      event.target.value = "";
    });
  }
  if (elements.taskNotes) {
    elements.taskNotes.addEventListener("paste", (event) =>
      handleImagePaste(event, captureImages, renderCaptureAttachments)
    );
  }
}

async function addFilesToImages(fileList, target, rerender) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  for (const file of files) {
    try {
      const src = await fileToDownscaledDataUrl(file);
      target.push({ id: crypto.randomUUID(), src, alt: file.name || "" });
    } catch (err) {
      console.warn("[filum] could not read image:", err);
    }
  }
  if (files.length) rerender();
}

function handleImagePaste(event, target, rerender) {
  const clip = event.clipboardData;
  if (!clip || !clip.items) return;
  const files = [];
  for (const item of clip.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length) return;
  // Keep the pasted image binary out of the plain-text field.
  event.preventDefault();
  addFilesToImages(files, target, rerender);
}

// Decode, downscale to a sane edge, and re-encode as a compact JPEG data URL so
// images stay small enough to live inside the thread's own JSON file.
function fileToDownscaledDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- In-place task editor -----------------------------------------------
//
// Editing happens on the task itself: the read view swaps for this form right
// where the task sits (Step 1 chip, Step 2 plan item, or Step 3 focus card).
// No modal, no foreground window. Only one task edits at a time, and only in
// the active step (the render functions carry the step guards).

function optionTags(opts, selected) {
  const value = selected || "";
  return opts
    .map(
      ([val, label]) =>
        `<option value="${escapeHtml(val)}"${val === value ? " selected" : ""}>${escapeHtml(label)}</option>`
    )
    .join("");
}

function renderInlineEditor(task) {
  return `
    <form class="inline-editor" data-editor novalidate>
      <label class="inline-field">
        <span>Task</span>
        <input class="ie-title" type="text" maxlength="120" value="${escapeHtml(task.title)}" required />
      </label>
      <div class="inline-grid">
        <label class="inline-field">
          <span>Urgency</span>
          <select class="ie-urgency">${optionTags(URGENCY_OPTS, task.urgency)}</select>
        </label>
        <label class="inline-field">
          <span>Energy</span>
          <select class="ie-energy">${optionTags(ENERGY_OPTS, task.energy)}</select>
        </label>
        <label class="inline-field">
          <span>Type</span>
          <select class="ie-type">${optionTags(TYPE_OPTS, task.type)}</select>
        </label>
      </div>
      <label class="inline-field">
        <span>Notes or custom triage</span>
        <textarea class="ie-notes" rows="4" maxlength="2000" placeholder="Context, links, references — drop it all here. Paste an image straight in.">${escapeHtml(task.notes)}</textarea>
      </label>
      <div class="inline-attach-row">
        <button type="button" class="ghost-button attach-button ie-add-image">Add image</button>
        <input type="file" class="ie-image-input visually-hidden" accept="image/*" multiple />
        <label class="inline-time">
          <span>Time</span>
          <input class="ie-duration" type="text" maxlength="40" placeholder="25 min" value="${escapeHtml(task.duration || "")}" />
        </label>
      </div>
      <div class="ie-attachments attachment-tray"></div>
      <div class="inline-actions">
        <button type="button" class="ghost-button danger-ghost ie-remove">Remove task</button>
        <span class="inline-actions-right">
          <button type="button" class="ghost-button ie-cancel">Cancel</button>
          <button type="submit" class="primary-button ie-save">Save</button>
        </span>
      </div>
    </form>
  `;
}

function startEdit(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) return;
  editingTaskId = taskId;
  editingImages = task.images.map((img) => ({ ...img }));
  render();
  const titleInput = document.querySelector(".inline-editor .ie-title");
  if (titleInput) {
    titleInput.focus();
    const caret = titleInput.value.length;
    titleInput.setSelectionRange(caret, caret);
  }
}

function cancelEdit() {
  editingTaskId = null;
  editingImages = [];
  render();
}

function saveEdit(formEl) {
  const task = state.tasks.find((entry) => entry.id === editingTaskId);
  if (!task) {
    cancelEdit();
    return;
  }
  const titleInput = formEl.querySelector(".ie-title");
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    return;
  }
  const durationResult = validateDuration(formEl.querySelector(".ie-duration").value);

  task.title = title;
  task.urgency = formEl.querySelector(".ie-urgency").value;
  task.energy = formEl.querySelector(".ie-energy").value;
  task.type = formEl.querySelector(".ie-type").value;
  task.notes = formEl.querySelector(".ie-notes").value.trim();
  task.duration = durationResult.ok ? durationResult.normalized : task.duration;
  task.images = editingImages.map((img) => ({ ...img }));

  editingTaskId = null;
  editingImages = [];
  markDirty();
  render();
}

function removeEditingTask() {
  const index = state.tasks.findIndex((entry) => entry.id === editingTaskId);
  if (index < 0) {
    cancelEdit();
    return;
  }
  state.tasks.splice(index, 1);
  if (index < state.focusIndex) {
    state.focusIndex -= 1;
  }
  if (state.focusIndex >= state.tasks.length) {
    state.focusIndex = Math.max(0, state.tasks.length - 1);
  }
  if (!state.tasks.length) {
    state.currentStep = DEFAULT_STEP;
  }
  editingTaskId = null;
  editingImages = [];
  markDirty();
  render();
}

// Wire up whichever single inline editor is on the page now. Called at the end
// of every render(); there is at most one because of the step guards.
function bindInlineEditor() {
  const form = document.querySelector(".inline-editor[data-editor]");
  if (!form) return;
  // Each render rebuilds the form node; guard so a node is only wired once even
  // if bindInlineEditor runs more than once for the same render.
  if (form.dataset.bound === "1") return;
  form.dataset.bound = "1";

  const tray = form.querySelector(".ie-attachments");
  const renderTray = () => {
    renderEditableTray(tray, editingImages, (id) => {
      editingImages = editingImages.filter((img) => img.id !== id);
      renderTray();
    });
  };
  renderTray();

  const addBtn = form.querySelector(".ie-add-image");
  const fileInput = form.querySelector(".ie-image-input");
  if (addBtn && fileInput) {
    addBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (event) => {
      await addFilesToImages(event.target.files, editingImages, renderTray);
      event.target.value = "";
    });
  }

  const notes = form.querySelector(".ie-notes");
  if (notes) {
    notes.addEventListener("paste", (event) => handleImagePaste(event, editingImages, renderTray));
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveEdit(form);
  });
  form.querySelector(".ie-cancel").addEventListener("click", cancelEdit);
  form.querySelector(".ie-remove").addEventListener("click", removeEditingTask);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  });
}

// ---- Untangle animation --------------------------------------------------

// Step 2 "Untangle it": reveal the Follow step, then play the knot straightening
// directly into that step's thread — the line you pull resolves into the final
// thread, in place. The ordered task cards fade in over it as the overlay, for
// a single continuous motion. Honors reduced-motion and trivial task counts.
function playUntangle() {
  const svg = elements.lineSvg;
  if (!svg || prefersReducedMotion || state.tasks.length < 2) {
    setStep("line");
    return;
  }

  // Hold the ordered cards back, then reveal Follow so the knot resolves in
  // its final home rather than in a throwaway overlay.
  if (elements.linePanel) elements.linePanel.classList.add("is-untangling");
  setStep("line");

  const token = ++untangleToken;
  const width = svg.viewBox.baseVal.width;
  const height = svg.viewBox.baseVal.height;
  const count = state.tasks.length;
  const startX = 70;
  const endX = width - 70;
  const midY = 120;
  const stepX = count === 1 ? 0 : (endX - startX) / (count - 1);
  const start = tangleScatter(state.tasks, width, height, 40);
  const target = state.tasks.map((_, i) => ({ x: startX + stepX * i, y: midY }));

  const duration = 1150;
  const begin = performance.now();

  const frame = (now) => {
    if (token !== untangleToken) return; // a newer run superseded this one
    const tRaw = Math.min(1, (now - begin) / duration);
    const t = easeInOutCubic(tRaw);
    const knot = 1 - t;
    const points = start.map((p, i) => ({
      x: p.x + (target[i].x - p.x) * t,
      y: p.y + (target[i].y - p.y) * t,
    }));
    const d = knottedPath(points, knot, 0.7);
    const dots = points
      .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="#111111" />`)
      .join("");
    svg.innerHTML = `
      <path d="${d}" fill="none" stroke="rgba(18,18,18,0.86)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${dots}`;
    if (tRaw < 1) {
      requestAnimationFrame(frame);
    } else {
      renderLineThread(); // settle into the real thread (gentle curve + numbers)
      if (elements.linePanel) elements.linePanel.classList.remove("is-untangling");
    }
  };

  requestAnimationFrame(frame);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      const swPath = BASE_PATH ? `${BASE_PATH}/sw.js` : "./sw.js";
      navigator.serviceWorker.register(swPath).catch(() => {});
    });
  }
}
