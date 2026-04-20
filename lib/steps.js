(function(root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./common.js"));
    return;
  }

  root.BSRSteps = factory(root.BSRCommon);
})(typeof globalThis !== "undefined" ? globalThis : this, function(common) {
  const {
    cloneSerializable,
    formatUrlForTip,
    truncateText,
    unique,
  } = common;

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
    const initialSteps = buildInitialSteps(session, rawEvents);
    const mergedSteps = mergeStepOutcomes(session, dedupeNavigateSteps(initialSteps), rawEvents);
    return renumberSteps(mergedSteps);
  }

  function buildInitialSteps(session, rawEvents) {
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
                resultNavigationUrl: null,
                resultStatus: null,
                resultTitle: session.metadata.startTitle || null,
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
              resultNavigationUrl: rawEvent.frame.url ?? null,
              resultStatus: null,
              resultTitle: findTitleForTab(session, rawEvent.tabId) || null,
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
              resultNavigationUrl: null,
              resultStatus: null,
              resultTitle: null,
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
              resultNavigationUrl: null,
              resultStatus: null,
              resultTitle: null,
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
              resultNavigationUrl: rawEvent.url ?? null,
              resultStatus: null,
              resultTitle: rawEvent.title || null,
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
                resultNavigationUrl: findUrlForTab(session, rawEvent.tabId) || null,
                resultStatus: null,
                resultTitle: findTitleForTab(session, rawEvent.tabId) || null,
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
              resultNavigationUrl: null,
              resultStatus: null,
              resultTitle: null,
            },
          });
          break;
        default:
          break;
      }
    }

    return renumberSteps(steps);
  }

  function pushInputStep(steps, rawEvent) {
    const inputMode = inferInputMode(rawEvent);
    const elementLabel = describeElementForTip(rawEvent.element);
    const detail = {
      element: rawEvent.element ?? null,
      value: rawEvent.value ?? null,
      checked: rawEvent.checked ?? null,
      resultNavigationUrl: null,
      resultStatus: null,
      resultTitle: null,
    };

    let type = "input";
    let tip = `Enter text into ${elementLabel}`;

    if (inputMode === "select") {
      type = "select";
      tip = rawEvent.value ? `Choose "${rawEvent.value}" in ${elementLabel}` : `Choose an option in ${elementLabel}`;
    } else if (inputMode === "check") {
      const isRadio = rawEvent.element?.type === "radio";
      type = rawEvent.checked ? "check" : "uncheck";
      tip = isRadio
        ? `Select ${elementLabel}`
        : `${rawEvent.checked ? "Check" : "Uncheck"} ${elementLabel}`;
    } else if (rawEvent.value) {
      tip = `Enter "${truncateText(rawEvent.value, 80)}" into ${elementLabel}`;
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

  function mergeStepOutcomes(session, steps, rawEvents) {
    const merged = [];

    for (let index = 0; index < steps.length; index += 1) {
      const current = cloneSerializable(steps[index]);
      const next = steps[index + 1] ? cloneSerializable(steps[index + 1]) : null;

      current.detail = ensureResultDetail(current.detail);
      attachStatusOutcome(current, rawEvents);

      if (canMergeNavigationOutcome(current, next)) {
        const mergedStep = mergeNavigationOutcome(session, current, next, rawEvents);
        merged.push(mergedStep);
        index += 1;
        continue;
      }

      merged.push(current);
    }

    return merged;
  }

  function canMergeNavigationOutcome(current, next) {
    if (!current || !next) {
      return false;
    }

    if (!["click", "submit"].includes(current.type) || next.type !== "navigate") {
      return false;
    }

    if (current.tabId !== next.tabId) {
      return false;
    }

    const currentTime = Date.parse(current.timestamp);
    const nextTime = Date.parse(next.timestamp);
    if (!Number.isFinite(currentTime) || !Number.isFinite(nextTime)) {
      return false;
    }

    return nextTime >= currentTime && nextTime - currentTime <= 5000;
  }

  function mergeNavigationOutcome(session, current, next, rawEvents) {
    current.rawEventIds = unique([...(current.rawEventIds || []), ...(next.rawEventIds || [])]);
    current.detail = ensureResultDetail(current.detail);
    current.detail.resultNavigationUrl = next.url || null;
    current.detail.resultTitle = next.title || findTitleForTab(session, next.tabId) || null;
    if (current.url !== next.url) {
      current.url = next.url || current.url;
    }
    if (!current.title && next.title) {
      current.title = next.title;
    }

    attachStatusOutcome(current, rawEvents, next);

    const target = formatUrlForTip(next.url);
    if (current.type === "submit") {
      current.tip = `${buildSubmitTip(current.detail.element)} and navigate to ${target}`;
    } else {
      current.tip = `${buildClickTip(current.detail.element)} and navigate to ${target}`;
    }

    return current;
  }

  function attachStatusOutcome(step, rawEvents, navigateStep) {
    const result = findResultOutcome(step, rawEvents, navigateStep);
    if (!result) {
      return;
    }

    step.detail = ensureResultDetail(step.detail);
    if (result.status !== null && result.status !== undefined) {
      step.detail.resultStatus = result.status;
    }
    if (!step.detail.resultNavigationUrl && result.navigationUrl) {
      step.detail.resultNavigationUrl = result.navigationUrl;
    }
    if (!step.detail.resultTitle && result.title) {
      step.detail.resultTitle = result.title;
    }
  }

  function findResultOutcome(step, rawEvents, navigateStep) {
    if (!step.rawEventIds?.length) {
      return null;
    }

    const rawById = new Map(rawEvents.map((event) => [event.id, event]));
    const anchors = step.rawEventIds
      .map((rawEventId) => rawById.get(rawEventId))
      .filter(Boolean)
      .sort((left, right) => left.order - right.order);

    if (anchors.length === 0) {
      return null;
    }

    const lastAnchor = anchors[anchors.length - 1];
    const anchorIndex = Math.max(0, lastAnchor.order - 1);
    const anchorTime = Date.parse(lastAnchor.timestamp);
    const maxWindowMs = 5000;
    const seenRequestIds = new Set();
    let bestResponse = null;
    let bestNavigation = navigateStep
      ? {
          navigationUrl: navigateStep.url || null,
          title: navigateStep.title || null,
        }
      : null;

    for (let index = anchorIndex; index < rawEvents.length && index <= anchorIndex + 12; index += 1) {
      const rawEvent = rawEvents[index];
      if (step.tabId !== null && rawEvent.tabId !== undefined && rawEvent.tabId !== step.tabId) {
        continue;
      }

      const rawTime = Date.parse(rawEvent.timestamp);
      if (Number.isFinite(anchorTime) && Number.isFinite(rawTime) && rawTime - anchorTime > maxWindowMs) {
        break;
      }

      if (rawEvent.type === "network_request") {
        seenRequestIds.add(rawEvent.requestId);
      } else if (rawEvent.type === "network_response") {
        const isMatchingRequest = seenRequestIds.has(rawEvent.requestId);
        const isUsefulType = ["Document", "Fetch", "XHR"].includes(rawEvent.resourceType);
        if (!bestResponse && (isMatchingRequest || isUsefulType)) {
          bestResponse = rawEvent;
        }
      } else if (rawEvent.type === "page_frame_navigated" && rawEvent.frame && !rawEvent.frame.parentId) {
        bestNavigation = {
          navigationUrl: rawEvent.frame.url || null,
          title: navigateStep?.title || null,
        };
      }
    }

    if (!bestResponse && !bestNavigation) {
      return null;
    }

    return {
      status: bestResponse?.response?.status ?? null,
      navigationUrl: bestNavigation?.navigationUrl ?? null,
      title: bestNavigation?.title ?? null,
    };
  }

  function pushStep(steps, step) {
    const lastStep = steps[steps.length - 1];
    if (lastStep && isDuplicateStep(lastStep, step)) {
      lastStep.rawEventIds = unique([...(lastStep.rawEventIds || []), ...(step.rawEventIds || [])]);
      if (step.detail) {
        lastStep.detail = {
          ...lastStep.detail,
          ...step.detail,
        };
      }
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
        previous.rawEventIds = unique([...(previous.rawEventIds || []), ...(step.rawEventIds || [])]);
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

  function buildClickTip(element) {
    return `Click ${describeElementForTip(element)}`;
  }

  function buildSubmitTip(element) {
    return `Submit ${describeElementForTip(element)}`;
  }

  function ensureResultDetail(detail) {
    return {
      ...(detail || {}),
      resultNavigationUrl: detail?.resultNavigationUrl ?? null,
      resultStatus: detail?.resultStatus ?? null,
      resultTitle: detail?.resultTitle ?? null,
    };
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

  return {
    buildRawEvents,
    describeElementForTip,
    describeTabForTip,
    findTitleForTab,
    findUrlForTab,
    normalizeSteps,
  };
});
