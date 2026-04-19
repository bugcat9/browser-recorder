(() => {
  if (window.__browserSkillRecorderInjected) {
    return;
  }

  window.__browserSkillRecorderInjected = true;

  const pendingInputs = new Map();
  const INPUT_DEBOUNCE_MS = 400;
  const MAX_TEXT_LENGTH = 200;

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }

      emit({
        eventType: "dom_click",
        pageUrl: location.href,
        element: describeElement(target),
        extra: {
          x: event.clientX,
          y: event.clientY,
        },
      });
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }

      queueInput(target, "dom_input");
    },
    true
  );

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }

      flushInput(target, "dom_change");
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }

      emit({
        eventType: "dom_submit",
        pageUrl: location.href,
        element: describeElement(target),
      });
    },
    true
  );

  window.addEventListener(
    "beforeunload",
    () => {
      emit({
        eventType: "page_beforeunload",
        pageUrl: location.href,
        element: null,
      });
    },
    true
  );

  function queueInput(target, eventType) {
    const key = buildElementKey(target);
    const existing = pendingInputs.get(key);
    if (existing) {
      clearTimeout(existing.timerId);
    }

    const timerId = window.setTimeout(() => {
      flushInput(target, eventType);
    }, INPUT_DEBOUNCE_MS);

    pendingInputs.set(key, { timerId });
  }

  function flushInput(target, eventType) {
    const key = buildElementKey(target);
    const pending = pendingInputs.get(key);
    if (pending) {
      clearTimeout(pending.timerId);
      pendingInputs.delete(key);
    }

    emit({
      eventType,
      pageUrl: location.href,
      element: describeElement(target),
      value: extractValue(target),
      checked: extractChecked(target),
    });
  }

  function emit(payload) {
    try {
      const result = chrome.runtime.sendMessage({
        type: "RECORDER_DOM_EVENT",
        payload,
      });

      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          if (!isIgnorableSendMessageError(error)) {
            console.warn("Browser Skill Recorder emit failed", error);
          }
        });
      }
    } catch (error) {
      if (!isIgnorableSendMessageError(error)) {
        console.warn("Browser Skill Recorder emit failed", error);
      }
    }
  }

  function buildElementKey(element) {
    const descriptor = describeElement(element);
    return [
      descriptor.tagName,
      descriptor.id,
      descriptor.name,
      descriptor.selector,
    ].join("|");
  }

  function describeElement(element) {
    const text = element instanceof HTMLElement ? element.innerText || element.textContent || "" : "";

    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      name: element.getAttribute("name"),
      type: element.getAttribute("type"),
      role: element.getAttribute("role"),
      placeholder: element.getAttribute("placeholder"),
      ariaLabel: element.getAttribute("aria-label"),
      selector: buildSelector(element),
      text: truncate(text),
    };
  }

  function buildSelector(element) {
    if (element.id) {
      return `#${escapeSelectorPart(element.id)}`;
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();

      const name = current.getAttribute("name");
      if (name) {
        part += `[name="${escapeAttributeValue(name)}"]`;
      } else if (current.classList.length > 0) {
        part += `.${Array.from(current.classList).slice(0, 2).map(escapeSelectorPart).join(".")}`;
      } else {
        const siblingIndex = getSiblingIndex(current);
        part += `:nth-of-type(${siblingIndex})`;
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function getSiblingIndex(element) {
    let index = 1;
    let sibling = element;

    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === element.tagName) {
        index += 1;
      }
    }

    return index;
  }

  function extractValue(target) {
    if (target instanceof HTMLInputElement && target.type === "password") {
      return "[REDACTED]";
    }

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return truncate(target.value);
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
      return truncate(target.innerText || target.textContent || "");
    }

    return null;
  }

  function extractChecked(target) {
    if (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type)) {
      return target.checked;
    }

    return null;
  }

  function truncate(value) {
    if (typeof value !== "string") {
      return value ?? null;
    }

    if (value.length <= MAX_TEXT_LENGTH) {
      return value;
    }

    return `${value.slice(0, MAX_TEXT_LENGTH)}...`;
  }

  function escapeSelectorPart(value) {
    return CSS.escape(value);
  }

  function escapeAttributeValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function isIgnorableSendMessageError(error) {
    const message = String(error?.message || error || "");

    return (
      message.includes("Receiving end does not exist") ||
      message.includes("Extension context invalidated") ||
      message.includes("The message port closed before a response was received")
    );
  }
})();
