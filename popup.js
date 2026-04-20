const statusValue = document.getElementById("statusValue");
const sessionValue = document.getElementById("sessionValue");
const eventValue = document.getElementById("eventValue");
const tabValue = document.getElementById("tabValue");
const message = document.getElementById("message");
const skillNameInput = document.getElementById("skillNameInput");
const skillDescriptionInput = document.getElementById("skillDescriptionInput");
const llmBaseUrlInput = document.getElementById("llmBaseUrlInput");
const llmApiKeyInput = document.getElementById("llmApiKeyInput");
const llmModelInput = document.getElementById("llmModelInput");
const safeModeInput = document.getElementById("safeModeInput");
const generatedOutput = document.getElementById("generatedOutput");
const promptPreviewOutput = document.getElementById("promptPreviewOutput");
const promptPreviewMeta = document.getElementById("promptPreviewMeta");
const generationStatus = document.getElementById("generationStatus");
const generationStatusText = document.getElementById("generationStatusText");
const generationError = document.getElementById("generationError");
const generationErrorMessage = document.getElementById("generationErrorMessage");
const generationErrorHint = document.getElementById("generationErrorHint");
const POPUP_DRAFT_KEY = "browserSkillRecorderPopupDraft";

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const exportButton = document.getElementById("exportButton");
const clearButton = document.getElementById("clearButton");
const generateButton = document.getElementById("generateButton");
const downloadJsonButton = document.getElementById("downloadJsonButton");
const downloadMarkdownButton = document.getElementById("downloadMarkdownButton");

startButton.addEventListener("click", () =>
  void execute(
    "START_RECORDING",
    "Recording started.",
    {
      skillName: skillNameInput.value.trim(),
      skillDescription: skillDescriptionInput.value.trim(),
    }
  )
);
stopButton.addEventListener("click", () => void execute("STOP_RECORDING", "Recording stopped."));
exportButton.addEventListener("click", () => void execute("EXPORT_RECORDING", "Skill package exported."));
clearButton.addEventListener("click", () => void execute("CLEAR_RECORDING", "Recording cleared."));
generateButton.addEventListener("click", () =>
  void execute(
    "GENERATE_SKILL",
    "Generated skill successfully.",
    {
      baseUrl: llmBaseUrlInput.value.trim(),
      apiKey: llmApiKeyInput.value.trim(),
      model: llmModelInput.value.trim(),
      safeMode: safeModeInput.checked,
    }
  )
);
downloadJsonButton.addEventListener("click", () => void execute("DOWNLOAD_GENERATED_SKILL_JSON", "Downloaded generated JSON."));
downloadMarkdownButton.addEventListener("click", () =>
  void execute("DOWNLOAD_GENERATED_SKILL_MARKDOWN", "Downloaded generated Markdown.")
);

[skillNameInput, skillDescriptionInput, llmBaseUrlInput, llmApiKeyInput, llmModelInput].forEach((input) => {
  input.addEventListener("input", () => {
    void persistDraft();
    updateActionAvailability(lastResponse);
  });
});

safeModeInput.addEventListener("input", () => {
  void persistDraft();
  updateActionAvailability(lastResponse);
  void refreshPromptPreview();
});

let lastResponse = null;
let localGenerationInProgress = false;
let allowGenerationIndicator = false;
let promptPreviewRequestId = 0;

document.addEventListener("DOMContentLoaded", () => {
  void initializePopup();
});

async function initializePopup() {
  await refreshStatus();
  await loadDraft();
  updateActionAvailability(lastResponse);
  await refreshPromptPreview();
}

async function execute(type, successMessage, payload = undefined) {
  setMessage("");
  const isGenerateAction = type === "GENERATE_SKILL";

  if (isGenerateAction) {
    allowGenerationIndicator = true;
    localGenerationInProgress = true;
    renderGenerationState(true);
    updateActionAvailability(lastResponse);
    setMessage("Generating skill...");
  }

  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (!response?.ok) {
      throw new Error(response?.error || "Unknown extension error.");
    }

    lastResponse = response;
    setMessage(successMessage);
    renderState(response);
    await persistDraft();
  } catch (error) {
    setMessage(error.message);
  } finally {
    if (isGenerateAction) {
      localGenerationInProgress = false;
      renderGenerationState(Boolean(lastResponse?.summary?.generationInProgress));
      updateActionAvailability(lastResponse);
    }
  }
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to read recorder status.");
    }

    lastResponse = response;
    renderState(response);
  } catch (error) {
    setMessage(error.message);
  }
}

function renderState(response) {
  renderSummary(response.summary);
  renderLlmState(response.llmSettings, response.generatedSkill, response.generationError);
  renderGenerationState(Boolean(response.summary?.generationInProgress));
  updateActionAvailability(response);
  void refreshPromptPreview();
}

function renderSummary(summary) {
  const recording = Boolean(summary?.recording);

  statusValue.textContent = recording ? "Recording" : "Idle";
  sessionValue.textContent = summary?.sessionId ? summary.sessionId.slice(0, 8) : "None";
  eventValue.textContent = String(summary?.eventCount ?? 0);
  tabValue.textContent = String(summary?.tabCount ?? 0);

  startButton.disabled = recording;
  stopButton.disabled = !recording;
  exportButton.disabled = !summary?.sessionId;
  clearButton.disabled = !summary?.sessionId;
  skillNameInput.disabled = recording;
  skillDescriptionInput.disabled = recording;
}

function renderLlmState(llmSettings, generatedSkill, lastGenerationError) {
  if (document.activeElement !== llmBaseUrlInput) {
    llmBaseUrlInput.value = llmSettings?.baseUrl || "";
  }

  if (document.activeElement !== llmApiKeyInput) {
    llmApiKeyInput.value = llmSettings?.apiKey || "";
  }

  if (document.activeElement !== llmModelInput) {
    llmModelInput.value = llmSettings?.model || "gpt-4.1-mini";
  }

  if (document.activeElement !== safeModeInput) {
    safeModeInput.checked = llmSettings?.safeMode !== false;
  }

  generatedOutput.value = generatedSkill?.markdown || "";
  renderGenerationError(lastGenerationError);
}

function updateActionAvailability(response) {
  const summary = response?.summary || {};
  const hasSession = Boolean(summary.sessionId);
  const recording = Boolean(summary.recording);
  const generationInProgress = Boolean(summary.generationInProgress) || localGenerationInProgress;
  const visualGenerationInProgress = localGenerationInProgress || (allowGenerationIndicator && Boolean(summary.generationInProgress));
  const hasConfig = Boolean(llmBaseUrlInput.value.trim() && llmApiKeyInput.value.trim());
  const hasGeneratedSkill = Boolean(response?.generatedSkill?.markdown);

  generateButton.disabled = !hasSession || recording || visualGenerationInProgress || !hasConfig;
  generateButton.textContent = visualGenerationInProgress ? "Generating..." : "Generate Skill";
  downloadJsonButton.disabled = !hasGeneratedSkill || visualGenerationInProgress;
  downloadMarkdownButton.disabled = !hasGeneratedSkill || visualGenerationInProgress;
  llmBaseUrlInput.disabled = visualGenerationInProgress;
  llmApiKeyInput.disabled = visualGenerationInProgress;
  llmModelInput.disabled = visualGenerationInProgress;
  safeModeInput.disabled = visualGenerationInProgress;
}

function renderGenerationState(isGenerating) {
  const shouldShow = allowGenerationIndicator && isGenerating;
  generationStatus.hidden = !shouldShow;
  generationStatus.style.display = shouldShow ? "flex" : "none";
  generationStatusText.textContent = shouldShow ? "Generating skill with LLM. This may take a little while." : "";
}

function renderGenerationError(errorState) {
  const shouldShow = Boolean(errorState?.message);
  generationError.hidden = !shouldShow;
  generationErrorMessage.textContent = shouldShow ? errorState.message : "";
  generationErrorHint.textContent = shouldShow ? errorState.hint || "" : "";
}

function setMessage(value) {
  message.textContent = value;
}

async function refreshPromptPreview() {
  const requestId = ++promptPreviewRequestId;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_PROMPT_PREVIEW",
      payload: {
        safeMode: safeModeInput.checked,
      },
    });

    if (requestId !== promptPreviewRequestId) {
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to build prompt preview.");
    }

    renderPromptPreview(response.promptPreview);
  } catch (error) {
    if (requestId !== promptPreviewRequestId) {
      return;
    }

    renderPromptPreview({
      rawCount: 0,
      stepCount: 0,
      previewText: error.message,
      safeMode: safeModeInput.checked,
    });
  }
}

function renderPromptPreview(promptPreview) {
  promptPreviewOutput.value = promptPreview?.previewText || "";
  promptPreviewMeta.textContent = promptPreview
    ? `${promptPreview.stepCount || 0} steps, ${promptPreview.rawCount || 0} raw events, ${promptPreview.safeMode ? "safe mode on" : "safe mode off"}`
    : "Preview unavailable.";
}

async function loadDraft() {
  const stored = await chrome.storage.local.get(POPUP_DRAFT_KEY);
  const draft = stored?.[POPUP_DRAFT_KEY];
  if (!draft) {
    return;
  }

  skillNameInput.value = draft.skillName || "";
  skillDescriptionInput.value = draft.skillDescription || "";
  llmBaseUrlInput.value = draft.baseUrl || "";
  llmApiKeyInput.value = draft.apiKey || "";
  llmModelInput.value = draft.model || "";
  safeModeInput.checked = draft.safeMode !== false;
}

async function persistDraft() {
  await chrome.storage.local.set({
    [POPUP_DRAFT_KEY]: {
      skillName: skillNameInput.value,
      skillDescription: skillDescriptionInput.value,
      baseUrl: llmBaseUrlInput.value,
      apiKey: llmApiKeyInput.value,
      model: llmModelInput.value,
      safeMode: safeModeInput.checked,
    },
  });
}
