importScripts(
  "lib/common.js",
  "lib/steps.js",
  "lib/prompt-privacy.js",
  "lib/skill-package.js",
  "lib/generation-utils.js"
);

const DEBUGGER_VERSION = "1.3";
const STORAGE_KEY = "browserSkillRecorderState";
const LLM_SETTINGS_KEY = "browserSkillRecorderLlmSettings";
const GENERATED_SKILL_KEY = "browserSkillRecorderGeneratedSkill";
const GENERATION_ERROR_KEY = "browserSkillRecorderGenerationError";
const MAX_TEXT_LENGTH = 300;
const SKILL_SCHEMA_VERSION = "2.0";
const ZIP_TEXT_ENCODER = new TextEncoder();
const CRC32_TABLE = buildCrc32Table();
const DEFAULT_LLM_MODEL = "gpt-4.1-mini";
const DEFAULT_SAFE_MODE = true;
const LLM_REQUEST_TIMEOUT_MS = 90000;

const {
  normalizeUserText,
  sanitizeFileNameComponent,
  truncateText,
} = globalThis.BSRCommon;
const {
  buildPromptPreviewText,
} = globalThis.BSRPromptPrivacy;
const {
  buildLlmPromptContext,
  buildSkillPackage,
} = globalThis.BSRSkillPackage;
const {
  parseModelJson,
  renderGeneratedSkillMarkdown,
  validateGeneratedSkill,
} = globalThis.BSRGenerationUtils;

let systemPromptCache = null;

let state = {
  session: null,
  persistTimer: null,
  pendingDownloadFilename: null,
  llmSettings: {
    baseUrl: "",
    apiKey: "",
    model: DEFAULT_LLM_MODEL,
    safeMode: DEFAULT_SAFE_MODE,
  },
  generatedSkill: null,
  generationError: null,
  generationInProgress: false,
  generationStartedAt: null,
};

initialize().catch((error) => {
  console.error("Failed to initialize recorder", error);
});

chrome.runtime.onInstalled.addListener(() => {
  void restoreState();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("Message handling failed", error);
      sendResponse({
        ok: false,
        error: error.message,
      });
    });

  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  void handleDebuggerEvent(source, method, params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  void handleDebuggerDetach(source, reason);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void handleTabActivated(activeInfo);
});

chrome.tabs.onCreated.addListener((tab) => {
  void handleTabCreated(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void handleTabRemoved(tabId, removeInfo);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void handleWindowFocusChanged(windowId);
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  handleDeterminingFilename(item, suggest);
});

async function initialize() {
  await restoreState();
  void loadSystemPrompt();
}

async function restoreState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY,
    LLM_SETTINGS_KEY,
    GENERATED_SKILL_KEY,
    GENERATION_ERROR_KEY,
  ]);

  if (stored[STORAGE_KEY]) {
    state.session = stored[STORAGE_KEY];
  }

  if (stored[LLM_SETTINGS_KEY]) {
    state.llmSettings = {
      baseUrl: stored[LLM_SETTINGS_KEY].baseUrl || "",
      apiKey: stored[LLM_SETTINGS_KEY].apiKey || "",
      model: stored[LLM_SETTINGS_KEY].model || DEFAULT_LLM_MODEL,
      safeMode: stored[LLM_SETTINGS_KEY].safeMode !== false,
    };
  }

  if (stored[GENERATED_SKILL_KEY]) {
    state.generatedSkill = stored[GENERATED_SKILL_KEY];
  }

  if (stored[GENERATION_ERROR_KEY]) {
    state.generationError = stored[GENERATION_ERROR_KEY];
  }
}

function schedulePersist() {
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
  }

  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    void chrome.storage.local.set({
      [STORAGE_KEY]: state.session,
    });
  }, 250);
}

function assertSession() {
  if (!state.session) {
    throw new Error("No recording session exists.");
  }

  return state.session;
}

function isRecording() {
  return Boolean(state.session && state.session.status === "recording");
}

function nowIso() {
  return new Date().toISOString();
}

function createEmptySession() {
  return {
    id: crypto.randomUUID(),
    status: "recording",
    startedAt: nowIso(),
    stoppedAt: null,
    metadata: {
      schemaVersion: SKILL_SCHEMA_VERSION,
      recorderVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      skillName: "",
      skillDescription: "",
      startUrl: "",
      startTitle: "",
      startTabId: null,
      startWindowId: null,
    },
    tabs: {},
    events: [],
  };
}

function ensureTabRecord(tab) {
  const session = assertSession();
  const tabId = String(tab.id);

  if (!session.tabs[tabId]) {
    session.tabs[tabId] = {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      openerTabId: tab.openerTabId ?? null,
      attached: false,
      createdAt: nowIso(),
      lastKnownUrl: tab.url ?? "",
      lastKnownTitle: tab.title ?? "",
    };
  }

  return session.tabs[tabId];
}

function maybeSeedStartContextFromTab(tab) {
  if (!state.session || !tab?.id) {
    return;
  }

  const metadata = state.session.metadata;
  if (!metadata.startTabId) {
    metadata.startTabId = tab.id;
    metadata.startWindowId = tab.windowId ?? null;
  }

  if (!metadata.startUrl && tab.url) {
    metadata.startUrl = tab.url;
  }

  if (!metadata.startTitle && tab.title) {
    metadata.startTitle = truncateText(tab.title);
  }
}

function addEvent(type, payload = {}) {
  if (!state.session) {
    return;
  }

  state.session.events.push({
    type,
    timestamp: nowIso(),
    ...payload,
  });

  schedulePersist();
}

function getSessionSummary() {
  reconcileGenerationState();

  return {
    recording: isRecording(),
    sessionId: state.session?.id ?? null,
    startedAt: state.session?.startedAt ?? null,
    stoppedAt: state.session?.stoppedAt ?? null,
    eventCount: state.session?.events.length ?? 0,
    tabCount: state.session ? Object.keys(state.session.tabs).length : 0,
    generationInProgress: state.generationInProgress,
    hasGeneratedSkill: Boolean(state.generatedSkill),
  };
}

function buildPopupState() {
  return {
    summary: getSessionSummary(),
    llmSettings: {
      baseUrl: state.llmSettings.baseUrl,
      apiKey: state.llmSettings.apiKey,
      model: state.llmSettings.model || DEFAULT_LLM_MODEL,
      safeMode: state.llmSettings.safeMode !== false,
    },
    generatedSkill: state.generatedSkill
      ? {
          name: state.generatedSkill.name,
          generatedAt: state.generatedSkill.generatedAt,
          model: state.generatedSkill.model,
          markdown: state.generatedSkill.markdown,
        }
      : null,
    generationError: state.generationError,
  };
}

function reconcileGenerationState() {
  if (!state.generationInProgress || !state.generationStartedAt) {
    return;
  }

  const startedAtMs = Date.parse(state.generationStartedAt);
  if (!Number.isFinite(startedAtMs)) {
    state.generationInProgress = false;
    state.generationStartedAt = null;
    return;
  }

  if (Date.now() - startedAtMs > LLM_REQUEST_TIMEOUT_MS + 15000) {
    state.generationInProgress = false;
    state.generationStartedAt = null;
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_RECORDING":
      await startRecording(message.payload);
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "STOP_RECORDING":
      await stopRecording();
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "EXPORT_RECORDING":
      await exportRecording();
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "GENERATE_SKILL":
      await generateSkill(message.payload);
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "DOWNLOAD_GENERATED_SKILL_JSON":
      await downloadGeneratedSkillJson();
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "DOWNLOAD_GENERATED_SKILL_MARKDOWN":
      await downloadGeneratedSkillMarkdown();
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "GET_PROMPT_PREVIEW":
      return {
        ok: true,
        promptPreview: buildPromptPreview(message.payload),
      };
    case "CLEAR_RECORDING":
      await clearRecording();
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "GET_STATUS":
      return {
        ok: true,
        ...buildPopupState(),
      };
    case "RECORDER_DOM_EVENT":
      await recordDomEvent(message.payload, sender);
      return {
        ok: true,
      };
    default:
      return {
        ok: false,
        error: `Unsupported message type: ${message?.type ?? "unknown"}`,
      };
  }
}

async function startRecording(payload = {}) {
  if (isRecording()) {
    return;
  }

  state.session = createEmptySession();
  state.generatedSkill = null;
  state.generationError = null;
  state.session.metadata.skillName = normalizeUserText(payload.skillName, 120);
  state.session.metadata.skillDescription = normalizeUserText(payload.skillDescription, 400);
  await chrome.storage.local.remove([GENERATED_SKILL_KEY, GENERATION_ERROR_KEY]);

  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (activeTab?.id) {
    maybeSeedStartContextFromTab(activeTab);
    ensureTabRecord(activeTab);
  }

  addEvent("session_started", {
    skillName: state.session.metadata.skillName,
    skillDescription: state.session.metadata.skillDescription,
    startUrl: state.session.metadata.startUrl,
    startTitle: state.session.metadata.startTitle,
  });

  if (activeTab?.id) {
    await trackTab(activeTab.id, {
      reason: "initial_active_tab",
    });
  }

  schedulePersist();
}

async function stopRecording() {
  if (!isRecording()) {
    return;
  }

  const session = assertSession();
  session.status = "stopped";
  session.stoppedAt = nowIso();
  addEvent("session_stopped", {});

  const attachedTabs = Object.values(session.tabs)
    .filter((tab) => tab.attached)
    .map((tab) => tab.tabId);

  await Promise.all(attachedTabs.map((tabId) => detachDebugger(tabId)));
  schedulePersist();
}

async function clearRecording() {
  if (isRecording()) {
    await stopRecording();
  }

  state.session = null;
  state.generatedSkill = null;
  state.generationError = null;
  state.generationInProgress = false;
  state.generationStartedAt = null;
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }

  await chrome.storage.local.remove([STORAGE_KEY, GENERATED_SKILL_KEY, GENERATION_ERROR_KEY]);
}

async function exportRecording() {
  const session = assertSession();
  const skillPackage = buildSkillPackage(session, {
    schemaVersion: SKILL_SCHEMA_VERSION,
  });
  const zipBlob = createZipBlob(skillPackage.files);
  const dataUrl = await blobToDataUrl(zipBlob);
  const downloadFileName = `${sanitizeFileNameComponent(skillPackage.meta.name || skillPackage.rootFolder)}.zip`;

  state.pendingDownloadFilename = downloadFileName;

  await chrome.downloads.download({
    url: dataUrl,
    filename: downloadFileName,
    saveAs: true,
    conflictAction: "uniquify",
  });
}

async function generateSkill(payload = {}) {
  const session = assertSession();
  const llmSettings = {
    baseUrl: normalizeUserText(payload.baseUrl, 500),
    apiKey: normalizeUserText(payload.apiKey, 500),
    model: normalizeUserText(payload.model, 120) || DEFAULT_LLM_MODEL,
    safeMode: payload.safeMode !== false,
  };

  if (!llmSettings.baseUrl || !llmSettings.apiKey) {
    throw new Error("Base URL and API Key are required to generate a skill.");
  }

  state.llmSettings = llmSettings;
  state.generationError = null;
  state.generationInProgress = true;
  state.generationStartedAt = nowIso();
  await chrome.storage.local.set({
    [LLM_SETTINGS_KEY]: state.llmSettings,
  });

  try {
    const promptContext = buildLlmPromptContext(session, {
      schemaVersion: SKILL_SCHEMA_VERSION,
      safeMode: llmSettings.safeMode,
      rawSelection: {
        limit: 30,
      },
    });
    const responseText = await requestGeneratedSkill(llmSettings, promptContext);
    const skillJson = parseModelJson(responseText);
    validateGeneratedSkill(skillJson);
    const markdown = renderGeneratedSkillMarkdown(skillJson);

    state.generatedSkill = {
      name: skillJson.name,
      model: llmSettings.model,
      generatedAt: nowIso(),
      json: skillJson,
      markdown,
      rawResponse: responseText,
    };

    await chrome.storage.local.set({
      [GENERATED_SKILL_KEY]: state.generatedSkill,
      [GENERATION_ERROR_KEY]: null,
    });
  } catch (error) {
    state.generationError = {
      message: error.message,
      at: nowIso(),
      hint: buildGenerationErrorHint(error.message),
    };
    await chrome.storage.local.set({
      [GENERATION_ERROR_KEY]: state.generationError,
    });
    throw error;
  } finally {
    state.generationInProgress = false;
    state.generationStartedAt = null;
  }
}

async function downloadGeneratedSkillJson() {
  if (!state.generatedSkill?.json) {
    throw new Error("No generated skill is available.");
  }

  const fileName = `${sanitizeFileNameComponent(state.generatedSkill.name || "generated-skill")}.json`;
  await downloadTextFile(JSON.stringify(state.generatedSkill.json, null, 2), fileName, "application/json");
}

async function downloadGeneratedSkillMarkdown() {
  if (!state.generatedSkill?.markdown) {
    throw new Error("No generated skill is available.");
  }

  const fileName = `${sanitizeFileNameComponent(state.generatedSkill.name || "generated-skill")}.md`;
  await downloadTextFile(state.generatedSkill.markdown, fileName, "text/markdown");
}

function buildPromptPreview(payload = {}) {
  if (!state.session) {
    return {
      safeMode: payload.safeMode !== false,
      rawCount: 0,
      stepCount: 0,
      previewText: "No recording session yet.",
    };
  }

  const promptContext = buildLlmPromptContext(state.session, {
    schemaVersion: SKILL_SCHEMA_VERSION,
    safeMode: payload.safeMode !== false,
    rawSelection: {
      limit: 30,
    },
  });

  return {
    safeMode: payload.safeMode !== false,
    rawCount: promptContext.raw.length,
    stepCount: Array.isArray(promptContext.steps) ? promptContext.steps.length : 0,
    previewText: buildPromptPreviewText(promptContext),
  };
}

async function trackTab(tabId, context = {}) {
  if (!isRecording()) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    ensureTabRecord(tab);
    maybeSeedStartContextFromTab(tab);
    addEvent("tab_tracked", {
      tabId,
      windowId: tab.windowId ?? null,
      url: tab.url ?? "",
      title: truncateText(tab.title),
      reason: context.reason ?? null,
    });

    await ensureContentScript(tabId);
    await ensureDebugger(tab);
  } catch (error) {
    addEvent("tab_tracking_failed", {
      tabId,
      reason: context.reason ?? null,
      error: error.message,
    });
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: {
        tabId,
        allFrames: true,
      },
      files: ["content-script.js"],
    });
  } catch (error) {
    addEvent("content_script_injection_failed", {
      tabId,
      error: error.message,
    });
  }
}

async function ensureDebugger(tab) {
  const tabRecord = ensureTabRecord(tab);
  if (tabRecord.attached) {
    return;
  }

  try {
    await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_VERSION);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");
    tabRecord.attached = true;
    tabRecord.attachedAt = nowIso();

    addEvent("debugger_attached", {
      tabId: tab.id,
      url: tab.url ?? "",
      title: truncateText(tab.title),
    });
  } catch (error) {
    addEvent("debugger_attach_failed", {
      tabId: tab.id,
      url: tab.url ?? "",
      error: error.message,
    });
  }
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    addEvent("debugger_detach_failed", {
      tabId,
      error: error.message,
    });
  }

  if (state.session?.tabs[String(tabId)]) {
    state.session.tabs[String(tabId)].attached = false;
    state.session.tabs[String(tabId)].detachedAt = nowIso();
    schedulePersist();
  }
}

async function recordDomEvent(payload, sender) {
  if (!isRecording()) {
    return;
  }

  const tabId = sender.tab?.id ?? null;
  if (tabId) {
    ensureTabRecord(sender.tab);
    maybeSeedStartContextFromTab(sender.tab);
  }

  addEvent(payload.eventType, {
    source: "dom",
    tabId,
    frameId: sender.frameId ?? 0,
    url: sender.tab?.url ?? payload.pageUrl ?? "",
    title: truncateText(sender.tab?.title ?? ""),
    element: payload.element ?? null,
    value: truncateText(payload.value),
    checked: payload.checked ?? null,
    extra: payload.extra ?? null,
  });
}

async function handleDebuggerEvent(source, method, params) {
  if (!isRecording() || !source.tabId) {
    return;
  }

  switch (method) {
    case "Network.requestWillBeSent":
      addEvent("network_request", {
        source: "cdp",
        tabId: source.tabId,
        requestId: params.requestId,
        frameId: params.frameId ?? null,
        loaderId: params.loaderId ?? null,
        request: {
          url: params.request?.url ?? "",
          method: params.request?.method ?? "",
          resourceType: params.type ?? "",
          headers: simplifyHeaders(params.request?.headers),
          hasPostData: Boolean(params.request?.postData),
          postDataPreview: truncateText(params.request?.postData, 500),
        },
        documentUrl: params.documentURL ?? "",
        initiator: {
          type: params.initiator?.type ?? null,
          url: params.initiator?.url ?? null,
        },
      });
      break;
    case "Network.responseReceived":
      addEvent("network_response", {
        source: "cdp",
        tabId: source.tabId,
        requestId: params.requestId,
        frameId: params.frameId ?? null,
        response: {
          url: params.response?.url ?? "",
          status: params.response?.status ?? null,
          statusText: params.response?.statusText ?? "",
          mimeType: params.response?.mimeType ?? "",
          protocol: params.response?.protocol ?? "",
          fromDiskCache: params.response?.fromDiskCache ?? false,
          fromServiceWorker: params.response?.fromServiceWorker ?? false,
        },
        resourceType: params.type ?? "",
      });
      break;
    case "Network.loadingFinished":
      addEvent("network_loading_finished", {
        source: "cdp",
        tabId: source.tabId,
        requestId: params.requestId,
        encodedDataLength: params.encodedDataLength ?? 0,
      });
      break;
    case "Network.loadingFailed":
      addEvent("network_loading_failed", {
        source: "cdp",
        tabId: source.tabId,
        requestId: params.requestId,
        errorText: params.errorText ?? "",
        canceled: params.canceled ?? false,
        blockedReason: params.blockedReason ?? null,
      });
      break;
    case "Page.frameNavigated":
      addEvent("page_frame_navigated", {
        source: "cdp",
        tabId: source.tabId,
        frame: {
          id: params.frame?.id ?? null,
          parentId: params.frame?.parentId ?? null,
          url: params.frame?.url ?? "",
          name: params.frame?.name ?? "",
          loaderId: params.frame?.loaderId ?? null,
        },
      });
      break;
    case "Page.loadEventFired":
      addEvent("page_loaded", {
        source: "cdp",
        tabId: source.tabId,
      });
      break;
    default:
      break;
  }
}

async function handleDebuggerDetach(source, reason) {
  if (!source.tabId || !state.session?.tabs[String(source.tabId)]) {
    return;
  }

  state.session.tabs[String(source.tabId)].attached = false;
  state.session.tabs[String(source.tabId)].detachedAt = nowIso();
  addEvent("debugger_detached", {
    tabId: source.tabId,
    reason,
  });
}

async function handleTabActivated(activeInfo) {
  if (!isRecording()) {
    return;
  }

  addEvent("tab_activated", {
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
  });

  await trackTab(activeInfo.tabId, {
    reason: "tab_activated",
  });
}

async function handleTabCreated(tab) {
  if (!isRecording() || !tab?.id) {
    return;
  }

  ensureTabRecord(tab);
  addEvent("tab_created", {
    tabId: tab.id,
    windowId: tab.windowId ?? null,
    openerTabId: tab.openerTabId ?? null,
    url: tab.url ?? "",
    title: truncateText(tab.title),
  });
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!isRecording()) {
    return;
  }

  if (!changeInfo.url && !changeInfo.status && !changeInfo.title) {
    return;
  }

  ensureTabRecord(tab);
  maybeSeedStartContextFromTab(tab);

  if (changeInfo.url) {
    state.session.tabs[String(tabId)].lastKnownUrl = changeInfo.url;
    if (state.session.metadata.startTabId === tabId && !state.session.metadata.startUrl) {
      state.session.metadata.startUrl = changeInfo.url;
    }
  }

  if (changeInfo.title) {
    state.session.tabs[String(tabId)].lastKnownTitle = changeInfo.title;
    if (state.session.metadata.startTabId === tabId && !state.session.metadata.startTitle) {
      state.session.metadata.startTitle = truncateText(changeInfo.title);
    }
  }

  addEvent("tab_updated", {
    tabId,
    changeInfo: {
      status: changeInfo.status ?? null,
      url: changeInfo.url ?? null,
      title: truncateText(changeInfo.title ?? null),
    },
    url: tab.url ?? "",
    title: truncateText(tab.title),
  });

  if (changeInfo.status === "loading" || changeInfo.url) {
    await trackTab(tabId, {
      reason: "tab_updated",
    });
  }
}

async function handleTabRemoved(tabId, removeInfo) {
  if (!isRecording()) {
    return;
  }

  addEvent("tab_removed", {
    tabId,
    windowId: removeInfo.windowId ?? null,
    isWindowClosing: removeInfo.isWindowClosing ?? false,
  });

  if (state.session?.tabs[String(tabId)]) {
    state.session.tabs[String(tabId)].removedAt = nowIso();
    state.session.tabs[String(tabId)].attached = false;
    schedulePersist();
  }
}

async function handleWindowFocusChanged(windowId) {
  if (!isRecording()) {
    return;
  }

  addEvent("window_focus_changed", {
    windowId,
  });
}

function handleDeterminingFilename(item, suggest) {
  if (!state.pendingDownloadFilename) {
    return;
  }

  if (item.byExtensionId !== chrome.runtime.id) {
    return;
  }

  suggest({
    filename: state.pendingDownloadFilename,
    conflictAction: "uniquify",
  });
  state.pendingDownloadFilename = null;
}

async function requestGeneratedSkill(llmSettings, promptContext) {
  const systemPrompt = await loadSystemPrompt();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`LLM request timed out after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)} seconds.`));
  }, LLM_REQUEST_TIMEOUT_MS);

  let response;

  try {
    response = await fetch(buildChatCompletionsUrl(llmSettings.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmSettings.apiKey}`,
      },
      body: JSON.stringify({
        model: llmSettings.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: JSON.stringify(promptContext, null, 2),
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`LLM request timed out after ${Math.round(LLM_REQUEST_TIMEOUT_MS / 1000)} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM response did not contain message content.");
  }

  return content;
}

async function loadSystemPrompt() {
  if (systemPromptCache) {
    return systemPromptCache;
  }

  const response = await fetch(chrome.runtime.getURL("prompts/skill-generator.md"));
  if (!response.ok) {
    throw new Error(`Failed to load prompt template (${response.status}).`);
  }

  systemPromptCache = await response.text();
  return systemPromptCache;
}

function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function buildGenerationErrorHint(message) {
  const text = String(message || "").toLowerCase();

  if (text.includes("timed out")) {
    return "The model endpoint did not respond in time. Check network reachability, model latency, or try a faster model.";
  }

  if (text.includes("(401)") || text.includes("(403)") || text.includes("unauthorized")) {
    return "Authentication failed. Verify the API key and whether the provider expects a different auth header or project scope.";
  }

  if (text.includes("(404)")) {
    return "The endpoint path may be wrong. Verify the Base URL and whether /chat/completions is supported by this provider.";
  }

  if (text.includes("(400)")) {
    return "The provider rejected the request format. Check model name, endpoint compatibility, and whether the API is OpenAI-compatible.";
  }

  if (text.includes("failed to fetch") || text.includes("network")) {
    return "The request could not reach the provider. Check the Base URL, network access, and provider availability.";
  }

  if (text.includes("could not parse json") || text.includes("did not contain message content")) {
    return "The provider returned an unexpected response shape. It may not be fully compatible with OpenAI chat completions.";
  }

  return "Check the Base URL, API key, model name, and whether the provider supports OpenAI-style chat completions.";
}

function simplifyHeaders(headers) {
  if (!headers || typeof headers !== "object") {
    return {};
  }

  const allowed = ["content-type", "accept", "referer", "origin", "user-agent"];
  const result = {};

  for (const [key, value] of Object.entries(headers)) {
    if (allowed.includes(key.toLowerCase())) {
      result[key] = truncateText(String(value), 200);
    }
  }

  return result;
}

function createZipBlob(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const utf8Flag = 0x0800;

  for (const file of files) {
    const nameBytes = ZIP_TEXT_ENCODER.encode(file.name);
    const dataBytes = typeof file.content === "string" ? ZIP_TEXT_ENCODER.encode(file.content) : file.content;
    const crc = computeCrc32(dataBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, utf8Flag, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, utf8Flag, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectorySize = centralParts.reduce((size, part) => size + part.length, 0);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralDirectorySize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, endRecord], {
    type: "application/zip",
  });
}

function buildCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 1) === 1) {
        crc = 0xedb88320 ^ (crc >>> 1);
      } else {
        crc >>>= 1;
      }
    }
    table[index] = crc >>> 0;
  }

  return table;
}

function computeCrc32(bytes) {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

async function downloadTextFile(content, fileName, mimeType) {
  const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  state.pendingDownloadFilename = fileName;

  await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    saveAs: true,
    conflictAction: "uniquify",
  });
}
