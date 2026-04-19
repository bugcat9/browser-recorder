const statusValue = document.getElementById("statusValue");
const sessionValue = document.getElementById("sessionValue");
const eventValue = document.getElementById("eventValue");
const tabValue = document.getElementById("tabValue");
const message = document.getElementById("message");
const skillNameInput = document.getElementById("skillNameInput");
const skillDescriptionInput = document.getElementById("skillDescriptionInput");

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const exportButton = document.getElementById("exportButton");
const clearButton = document.getElementById("clearButton");

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

document.addEventListener("DOMContentLoaded", () => {
  void refreshStatus();
});

async function execute(type, successMessage, payload = undefined) {
  setMessage("");

  try {
    const response = await chrome.runtime.sendMessage({ type, payload });
    if (!response?.ok) {
      throw new Error(response?.error || "Unknown extension error.");
    }

    setMessage(successMessage);
    renderSummary(response.summary);
  } catch (error) {
    setMessage(error.message);
  }
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to read recorder status.");
    }

    renderSummary(response.summary);
  } catch (error) {
    setMessage(error.message);
  }
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

function setMessage(value) {
  message.textContent = value;
}
