(function(root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./common.js"),
      require("./steps.js"),
      require("./prompt-privacy.js")
    );
    return;
  }

  root.BSRSkillPackage = factory(root.BSRCommon, root.BSRSteps, root.BSRPromptPrivacy);
})(typeof globalThis !== "undefined" ? globalThis : this, function(common, stepsApi, privacyApi) {
  const {
    cloneSerializable,
    formatUrlForTip,
    sanitizeFileNameComponent,
    truncateText,
  } = common;
  const {
    buildRawEvents,
    normalizeSteps,
  } = stepsApi;
  const {
    sanitizePromptContext,
  } = privacyApi;

  function buildSkillPackage(session, options = {}) {
    const rawEvents = buildRawEvents(session.events);
    const steps = normalizeSteps(session, rawEvents);
    const meta = buildSkillMeta(session, steps, options.schemaVersion);
    const index = buildSkillIndex(session, meta, steps, rawEvents, options.schemaVersion);
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
      stepMarkdown,
    };
  }

  function buildLlmPromptContext(session, options = {}) {
    const artifacts = buildSkillPackage(session, options);
    const promptContext = {
      meta: artifacts.meta,
      index: artifacts.index,
      stepMarkdown: artifacts.stepMarkdown,
      steps: artifacts.steps,
      raw: selectPromptRawEvents(artifacts.rawEvents, artifacts.steps, options.rawSelection),
    };

    return sanitizePromptContext(promptContext, {
      safeMode: options.safeMode !== false,
    });
  }

  function selectPromptRawEvents(rawEvents, steps, options = {}) {
    const limit = Number.isFinite(options.limit) ? options.limit : 30;
    const rawById = new Map(rawEvents.map((rawEvent) => [rawEvent.id, rawEvent]));
    const priorityById = new Map();

    steps.forEach((step, stepIndex) => {
      const stepWeight = Math.max(1, 80 - stepIndex);
      for (const rawEventId of step.rawEventIds || []) {
        boost(priorityById, rawById.get(rawEventId), 900 + stepWeight, stepIndex);
      }

      const anchorOrders = (step.rawEventIds || [])
        .map((rawEventId) => rawById.get(rawEventId)?.order)
        .filter((value) => Number.isFinite(value));

      for (const anchorOrder of anchorOrders) {
        const anchorIndex = anchorOrder - 1;
        for (let offset = -3; offset <= 5; offset += 1) {
          const rawEvent = rawEvents[anchorIndex + offset];
          if (!rawEvent) {
            continue;
          }

          if (step.tabId !== null && rawEvent.tabId !== undefined && rawEvent.tabId !== step.tabId) {
            continue;
          }

          const score = scoreSupportingRawEvent(step, rawEvent, Math.abs(offset));
          if (score > 0) {
            boost(priorityById, rawEvent, score + stepWeight, stepIndex);
          }
        }
      }
    });

    for (const rawEvent of rawEvents) {
      if (isCriticalRawEvent(rawEvent)) {
        boost(priorityById, rawEvent, 700, Number.MAX_SAFE_INTEGER);
      }
    }

    return Array.from(priorityById.values())
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.stepIndex !== right.stepIndex) {
          return left.stepIndex - right.stepIndex;
        }
        return left.order - right.order;
      })
      .slice(0, limit)
      .sort((left, right) => left.order - right.order)
      .map((entry) => cloneSerializable(rawById.get(entry.id)));
  }

  function boost(priorityById, rawEvent, score, stepIndex) {
    if (!rawEvent?.id) {
      return;
    }

    const existing = priorityById.get(rawEvent.id);
    if (!existing || score > existing.score) {
      priorityById.set(rawEvent.id, {
        id: rawEvent.id,
        score,
        stepIndex,
        order: rawEvent.order,
      });
    }

    const target = priorityById.get(rawEvent.id);
    if (stepIndex < target.stepIndex) {
      target.stepIndex = stepIndex;
    }
  }

  function scoreSupportingRawEvent(step, rawEvent, distance) {
    const distancePenalty = distance * 18;

    switch (rawEvent.type) {
      case "page_frame_navigated":
        return 560 - distancePenalty;
      case "page_loaded":
        return 440 - distancePenalty;
      case "network_loading_failed":
        return 600 - distancePenalty;
      case "network_response":
        return (step.type === "submit" ? 520 : 420) - distancePenalty;
      case "network_request":
        return (step.type === "submit" ? 500 : 380) - distancePenalty;
      case "tab_created":
      case "tab_activated":
      case "tab_removed":
        return 360 - distancePenalty;
      default:
        return 0;
    }
  }

  function isCriticalRawEvent(rawEvent) {
    return [
      "network_loading_failed",
      "debugger_attach_failed",
      "debugger_detach_failed",
      "tab_tracking_failed",
      "content_script_injection_failed",
    ].includes(rawEvent.type);
  }

  function buildSkillMeta(session, steps, schemaVersion = "2.0") {
    const startUrl = session.metadata.startUrl || steps.find((step) => step.url)?.url || "";
    const startTitle = session.metadata.startTitle || steps.find((step) => step.title)?.title || "";
    const inferredName = buildSkillName(startTitle, startUrl, session.id);
    const name = session.metadata.skillName || inferredName;
    const description =
      session.metadata.skillDescription || buildSkillDescription(startTitle, startUrl, steps);

    return {
      schemaVersion,
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

  function buildSkillIndex(session, meta, steps, rawEvents, schemaVersion = "2.0") {
    return {
      schemaVersion,
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
    return sanitizeFileNameComponent(meta.name || `Browser Skill ${sessionId.slice(0, 8)}`);
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

  return {
    buildLlmPromptContext,
    buildSkillPackage,
    selectPromptRawEvents,
  };
});
