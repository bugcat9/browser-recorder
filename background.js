const DEBUGGER_VERSION = "1.3";
const STORAGE_KEY = "browserSkillRecorderState";
const MAX_TEXT_LENGTH = 300;
const SKILL_SCHEMA_VERSION = "2.0";
const ZIP_TEXT_ENCODER = new TextEncoder();
const CRC32_TABLE = buildCrc32Table();

let state = {
  session: null,
  persistTimer: null,
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

async function initialize() {
  await restoreState();
}

async function restoreState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) {
    state.session = stored[STORAGE_KEY];
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

function truncateText(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
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
  return {
    recording: isRecording(),
    sessionId: state.session?.id ?? null,
    startedAt: state.session?.startedAt ?? null,
    stoppedAt: state.session?.stoppedAt ?? null,
    eventCount: state.session?.events.length ?? 0,
    tabCount: state.session ? Object.keys(state.session.tabs).length : 0,
  };
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_RECORDING":
      await startRecording(message.payload);
      return {
        ok: true,
        summary: getSessionSummary(),
      };
    case "STOP_RECORDING":
      await stopRecording();
      return {
        ok: true,
        summary: getSessionSummary(),
      };
    case "EXPORT_RECORDING":
      await exportRecording();
      return {
        ok: true,
        summary: getSessionSummary(),
      };
    case "CLEAR_RECORDING":
      await clearRecording();
      return {
        ok: true,
        summary: getSessionSummary(),
      };
    case "GET_STATUS":
      return {
        ok: true,
        summary: getSessionSummary(),
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
  state.session.metadata.skillName = normalizeUserText(payload.skillName, 120);
  state.session.metadata.skillDescription = normalizeUserText(payload.skillDescription, 400);

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
  if (state.persistTimer) {
    clearTimeout(state.persistTimer);
    state.persistTimer = null;
  }

  await chrome.storage.local.remove(STORAGE_KEY);
}

async function exportRecording() {
  const session = assertSession();
  const skillPackage = buildSkillPackage(session);
  const zipBlob = createZipBlob(skillPackage.files);
  const dataUrl = await blobToDataUrl(zipBlob);

  await chrome.downloads.download({
    url: dataUrl,
    filename: `${skillPackage.rootFolder}.zip`,
    saveAs: true,
    conflictAction: "uniquify",
  });
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

function buildSkillPackage(session) {
  const rawEvents = buildRawEvents(session.events);
  const steps = normalizeSteps(session, rawEvents);
  const meta = buildSkillMeta(session, steps);
  const index = buildSkillIndex(session, meta, steps, rawEvents);
  const stepMarkdown = buildStepMarkdown(meta, steps);
  const folderName = buildSkillFolderName(meta, session.id);
  const files = [
    {
      name: `${folderName}/meta.json`,
      content: JSON.stringify(meta, null, 2),
    },
    {
      name: `${folderName}/index.json`,
      content: JSON.stringify(index, null, 2),
    },
    {
      name: `${folderName}/step.llm.md`,
      content: stepMarkdown,
    },
    ...steps.map((step) => ({
      name: `${folderName}/${step.stepFile}`,
      content: JSON.stringify(step, null, 2),
    })),
    ...rawEvents.map((rawEvent) => ({
      name: `${folderName}/${rawEvent.rawFile}`,
      content: JSON.stringify(rawEvent, null, 2),
    })),
  ];

  return {
    rootFolder: folderName,
    files,
    meta,
    index,
    steps,
    rawEvents,
  };
}

function buildRawEvents(events) {
  return events.map((event, index) => {
    const rawEventId = `e${String(index + 1).padStart(4, "0")}`;
    return {
      id: rawEventId,
      order: index + 1,
      rawFile: `raw/${rawEventId}.json`,
      ...cloneSerializable(event),
    };
  });
}
function normalizeSteps(session, rawEvents) {
  const steps = [];
  const lastMainFrameUrlByTab = new Map();
  let lastActiveTabId = null;

  for (let index = 0; index < rawEvents.length; index += 1) {
    const rawEvent = rawEvents[index];

    switch (rawEvent.type) {
      case "session_started":
        if (session.metadata.startUrl || session.metadata.startTitle) {
          pushStep(steps, {
            type: "navigate",
            timestamp: rawEvent.timestamp,
            tabId: session.metadata.startTabId,
            url: session.metadata.startUrl,
            title: session.metadata.startTitle,
            tip: `Open ${formatUrlForTip(session.metadata.startUrl)}`,
            rawEventIds: [rawEvent.id],
            detail: {
              title: session.metadata.startTitle || null,
              targetUrl: session.metadata.startUrl || null,
            },
          });
        }
        break;
      case "page_frame_navigated":
        if (!rawEvent.frame || rawEvent.frame.parentId || !rawEvent.frame.url) {
          break;
        }

        if (lastMainFrameUrlByTab.get(rawEvent.tabId) === rawEvent.frame.url) {
          break;
        }

        lastMainFrameUrlByTab.set(rawEvent.tabId, rawEvent.frame.url);
        pushStep(steps, {
          type: "navigate",
          timestamp: rawEvent.timestamp,
          tabId: rawEvent.tabId,
          url: rawEvent.frame.url,
          title: findTitleForTab(session, rawEvent.tabId),
          tip: `Navigate to ${formatUrlForTip(rawEvent.frame.url)}`,
          rawEventIds: [rawEvent.id],
          detail: {
            frameId: rawEvent.frame.id ?? null,
            loaderId: rawEvent.frame.loaderId ?? null,
          },
        });
        break;
      case "dom_click":
        pushStep(steps, {
          type: "click",
          timestamp: rawEvent.timestamp,
          tabId: rawEvent.tabId,
          url: rawEvent.url,
          title: rawEvent.title,
          tip: `Click ${describeElementForTip(rawEvent.element)}`,
          rawEventIds: [rawEvent.id],
          detail: {
            element: rawEvent.element ?? null,
            coordinates: rawEvent.extra ?? null,
          },
        });
        break;
      case "dom_input":
        if (!shouldSkipInputBecauseChangeExists(rawEvents, index)) {
          pushInputStep(steps, rawEvent);
        }
        break;
      case "dom_change":
        pushInputStep(steps, rawEvent);
        break;
      case "dom_submit":
        pushStep(steps, {
          type: "submit",
          timestamp: rawEvent.timestamp,
          tabId: rawEvent.tabId,
          url: rawEvent.url,
          title: rawEvent.title,
          tip: `Submit ${describeElementForTip(rawEvent.element)}`,
          rawEventIds: [rawEvent.id],
          detail: {
            element: rawEvent.element ?? null,
          },
        });
        break;
      case "tab_created":
        pushStep(steps, {
          type: "open_tab",
          timestamp: rawEvent.timestamp,
          tabId: rawEvent.tabId,
          url: rawEvent.url,
          title: rawEvent.title,
          tip: rawEvent.url ? `Open a new tab for ${formatUrlForTip(rawEvent.url)}` : "Open a new tab",
          rawEventIds: [rawEvent.id],
          detail: {
            openerTabId: rawEvent.openerTabId ?? null,
          },
        });
        break;
      case "tab_activated":
        if (lastActiveTabId !== rawEvent.tabId) {
          lastActiveTabId = rawEvent.tabId;
          pushStep(steps, {
            type: "switch_tab",
            timestamp: rawEvent.timestamp,
            tabId: rawEvent.tabId,
            url: findUrlForTab(session, rawEvent.tabId),
            title: findTitleForTab(session, rawEvent.tabId),
            tip: `Switch to tab ${describeTabForTip(session, rawEvent.tabId)}`,
            rawEventIds: [rawEvent.id],
            detail: {
              windowId: rawEvent.windowId ?? null,
            },
          });
        }
        break;
      case "tab_removed":
        pushStep(steps, {
          type: "close_tab",
          timestamp: rawEvent.timestamp,
          tabId: rawEvent.tabId,
          url: findUrlForTab(session, rawEvent.tabId),
          title: findTitleForTab(session, rawEvent.tabId),
          tip: `Close tab ${describeTabForTip(session, rawEvent.tabId)}`,
          rawEventIds: [rawEvent.id],
          detail: {
            windowId: rawEvent.windowId ?? null,
            isWindowClosing: rawEvent.isWindowClosing ?? false,
          },
        });
        break;
      default:
        break;
    }
  }

  return renumberSteps(dedupeNavigateSteps(steps));
}

function pushInputStep(steps, rawEvent) {
  const inputMode = inferInputMode(rawEvent);
  const elementLabel = describeElementForTip(rawEvent.element);
  const detail = {
    element: rawEvent.element ?? null,
    value: rawEvent.value ?? null,
    checked: rawEvent.checked ?? null,
  };

  let type = "input";
  let tip = `Type into ${elementLabel}`;

  if (inputMode === "select") {
    type = "select";
    tip = rawEvent.value ? `Select "${rawEvent.value}" in ${elementLabel}` : `Select an option in ${elementLabel}`;
  } else if (inputMode === "check") {
    type = rawEvent.checked ? "check" : "uncheck";
    tip = `${rawEvent.checked ? "Check" : "Uncheck"} ${elementLabel}`;
  } else if (rawEvent.value) {
    tip = `Type "${truncateText(rawEvent.value, 80)}" into ${elementLabel}`;
  }

  pushStep(steps, {
    type,
    timestamp: rawEvent.timestamp,
    tabId: rawEvent.tabId,
    url: rawEvent.url,
    title: rawEvent.title,
    tip,
    rawEventIds: [rawEvent.id],
    detail,
  });
}

function pushStep(steps, step) {
  const lastStep = steps[steps.length - 1];
  if (lastStep && isDuplicateStep(lastStep, step)) {
    lastStep.rawEventIds = Array.from(new Set([...lastStep.rawEventIds, ...step.rawEventIds]));
    return lastStep;
  }

  const stepId = `s${String(steps.length + 1).padStart(4, "0")}`;
  const fullStep = {
    id: stepId,
    stepFile: `steps/${stepId}.json`,
    ...step,
  };

  steps.push(fullStep);
  return fullStep;
}

function isDuplicateStep(previous, next) {
  return previous.type === next.type && previous.tabId === next.tabId && previous.url === next.url && previous.tip === next.tip;
}

function dedupeNavigateSteps(steps) {
  const result = [];

  for (const step of steps) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.type === "navigate" &&
      step.type === "navigate" &&
      previous.tabId === step.tabId &&
      previous.url === step.url
    ) {
      previous.rawEventIds = Array.from(new Set([...previous.rawEventIds, ...step.rawEventIds]));
      continue;
    }

    result.push(step);
  }

  return result;
}

function renumberSteps(steps) {
  return steps.map((step, index) => {
    const stepId = `s${String(index + 1).padStart(4, "0")}`;
    return {
      ...step,
      id: stepId,
      stepFile: `steps/${stepId}.json`,
    };
  });
}

function shouldSkipInputBecauseChangeExists(rawEvents, index) {
  const current = rawEvents[index];
  const currentTime = Date.parse(current.timestamp);

  for (let lookAhead = index + 1; lookAhead < rawEvents.length && lookAhead <= index + 5; lookAhead += 1) {
    const next = rawEvents[lookAhead];
    const nextTime = Date.parse(next.timestamp);
    if (Number.isFinite(currentTime) && Number.isFinite(nextTime) && nextTime - currentTime > 2000) {
      break;
    }

    if (
      next.type === "dom_change" &&
      next.tabId === current.tabId &&
      sameElementReference(next.element, current.element) &&
      next.value === current.value &&
      next.checked === current.checked
    ) {
      return true;
    }
  }

  return false;
}

function sameElementReference(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.selector === right.selector && left.id === right.id && left.name === right.name && left.tagName === right.tagName;
}

function inferInputMode(rawEvent) {
  const tagName = rawEvent.element?.tagName ?? "";
  const elementType = rawEvent.element?.type ?? "";

  if (tagName === "select") {
    return "select";
  }

  if (elementType === "checkbox" || elementType === "radio") {
    return "check";
  }

  return "input";
}
function buildSkillMeta(session, steps) {
  const startUrl = session.metadata.startUrl || steps.find((step) => step.url)?.url || "";
  const startTitle = session.metadata.startTitle || steps.find((step) => step.title)?.title || "";
  const inferredName = buildSkillName(startTitle, startUrl, session.id);
  const name = session.metadata.skillName || inferredName;
  const description =
    session.metadata.skillDescription || buildSkillDescription(startTitle, startUrl, steps);

  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    skillId: session.id,
    name,
    description,
    startUrl,
    startTitle,
    createdAt: session.startedAt,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    recorderVersion: session.metadata.recorderVersion,
    timezone: session.metadata.timezone,
    userAgent: session.metadata.userAgent,
    exportFormat: "skill-package",
  };
}

function buildSkillIndex(session, meta, steps, rawEvents) {
  return {
    schemaVersion: SKILL_SCHEMA_VERSION,
    skillId: session.id,
    name: meta.name,
    description: meta.description,
    startUrl: meta.startUrl,
    startTitle: meta.startTitle,
    counts: {
      tabs: Object.keys(session.tabs).length,
      rawEvents: rawEvents.length,
      steps: steps.length,
    },
    steps: steps.map((step) => ({
      id: step.id,
      type: step.type,
      tip: step.tip,
      stepFile: step.stepFile,
      rawEventIds: step.rawEventIds,
      timestamp: step.timestamp,
      tabId: step.tabId ?? null,
      url: step.url ?? "",
      title: step.title ?? "",
    })),
  };
}

function buildStepMarkdown(meta, steps) {
  const lines = [
    `# ${meta.name}`,
    "",
    `Description: ${meta.description}`,
    `Start URL: ${meta.startUrl || "N/A"}`,
    `Start Title: ${meta.startTitle || "N/A"}`,
    "",
    "## Steps",
  ];

  if (steps.length === 0) {
    lines.push("", "No normalized steps were generated from this recording.");
    return lines.join("\n");
  }

  for (const [index, step] of steps.entries()) {
    lines.push(`${index + 1}. [${step.id}] ${step.tip}`);
  }

  lines.push("", "Use index.json for machine-readable lookup and raw/ for low-level event details.");
  return lines.join("\n");
}

function buildSkillFolderName(meta, sessionId) {
  const slug = slugify(meta.name || "browser-skill");
  return `${slug}-${sessionId.slice(0, 8)}`;
}

function buildSkillName(startTitle, startUrl, sessionId) {
  if (startTitle) {
    return truncateText(startTitle, 80);
  }

  try {
    const url = new URL(startUrl);
    return `Skill for ${url.hostname}`;
  } catch {
    return `Browser Skill ${sessionId.slice(0, 8)}`;
  }
}

function buildSkillDescription(startTitle, startUrl, steps) {
  const subject = startTitle || startUrl || "the target website";
  return `Recorded browser skill for ${subject}, containing ${steps.length} normalized steps.`;
}

function describeElementForTip(element) {
  if (!element) {
    return "the current element";
  }

  const candidates = [element.ariaLabel, element.placeholder, element.name, element.text, element.selector].filter(Boolean);

  if (candidates.length > 0) {
    return `"${truncateText(candidates[0], 60)}"`;
  }

  return element.tagName ? `the ${element.tagName} element` : "the current element";
}

function describeTabForTip(session, tabId) {
  const tabRecord = session.tabs[String(tabId)];
  if (!tabRecord) {
    return `#${tabId}`;
  }

  return tabRecord.lastKnownTitle || formatUrlForTip(tabRecord.lastKnownUrl) || `#${tabId}`;
}

function findTitleForTab(session, tabId) {
  return session.tabs[String(tabId)]?.lastKnownTitle ?? "";
}

function findUrlForTab(session, tabId) {
  return session.tabs[String(tabId)]?.lastKnownUrl ?? "";
}

function formatUrlForTip(url) {
  if (!url) {
    return "the current page";
  }

  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return truncateText(url, 80);
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "browser-skill";
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUserText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return truncateText(value.trim(), maxLength) || "";
}
function createZipBlob(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = ZIP_TEXT_ENCODER.encode(file.name);
    const dataBytes = typeof file.content === "string" ? ZIP_TEXT_ENCODER.encode(file.content) : file.content;
    const crc = computeCrc32(dataBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
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
    centralView.setUint16(8, 0, true);
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
