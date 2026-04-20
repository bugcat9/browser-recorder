(function(root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./common.js"));
    return;
  }

  root.BSRPromptPrivacy = factory(root.BSRCommon);
})(typeof globalThis !== "undefined" ? globalThis : this, function(common) {
  const {
    cloneSerializable,
    truncateText,
  } = common;

  const SAFE_HEADER_ALLOWLIST = new Set([
    "accept",
    "accept-language",
    "content-type",
    "origin",
    "referer",
    "user-agent",
    "x-requested-with",
  ]);

  const SENSITIVE_QUERY_KEY_PATTERN = /(token|key|auth|session|password|pass|secret|signature|sig|code|email|phone|tel)/i;
  const TOKEN_LIKE_PATTERN = /\b[a-z0-9_\-]{24,}\b/i;
  const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/;

  function sanitizePromptContext(promptContext, options = {}) {
    if (!options.safeMode) {
      return cloneSerializable(promptContext);
    }

    return {
      meta: sanitizeMeta(promptContext.meta),
      index: sanitizeIndex(promptContext.index),
      stepMarkdown: String(promptContext.stepMarkdown || ""),
      steps: sanitizeSteps(promptContext.steps),
      raw: sanitizeRawEvents(promptContext.raw, options),
    };
  }

  function sanitizeMeta(meta) {
    if (!meta) {
      return null;
    }

    return {
      ...meta,
      startUrl: sanitizeUrl(meta.startUrl),
    };
  }

  function sanitizeIndex(index) {
    if (!index) {
      return null;
    }

    return {
      ...index,
      startUrl: sanitizeUrl(index.startUrl),
      steps: Array.isArray(index.steps)
        ? index.steps.map((step) => ({
            ...step,
            url: sanitizeUrl(step.url),
          }))
        : [],
    };
  }

  function sanitizeSteps(steps) {
    if (!Array.isArray(steps)) {
      return [];
    }

    return steps.map((step) => ({
      ...step,
      url: sanitizeUrl(step.url),
      title: step.title || "",
      detail: sanitizeStepDetail(step.detail),
    }));
  }

  function sanitizeStepDetail(detail) {
    if (!detail || typeof detail !== "object") {
      return detail ?? null;
    }

    const result = cloneSerializable(detail);
    if (typeof result.value === "string") {
      result.value = sanitizeSensitiveText(result.value);
    }
    if (result.targetUrl) {
      result.targetUrl = sanitizeUrl(result.targetUrl);
    }
    if (result.resultNavigationUrl) {
      result.resultNavigationUrl = sanitizeUrl(result.resultNavigationUrl);
    }
    if (result.element && typeof result.element === "object") {
      result.element = sanitizeElement(result.element);
    }

    return result;
  }

  function sanitizeRawEvents(rawEvents, options) {
    if (!Array.isArray(rawEvents)) {
      return [];
    }

    return rawEvents.map((rawEvent) => sanitizeRawEvent(rawEvent, options));
  }

  function sanitizeRawEvent(rawEvent, options) {
    const result = cloneSerializable(rawEvent);

    if (result.url) {
      result.url = sanitizeUrl(result.url);
    }
    if (result.documentUrl) {
      result.documentUrl = sanitizeUrl(result.documentUrl);
    }
    if (result.frame?.url) {
      result.frame.url = sanitizeUrl(result.frame.url);
    }
    if (result.initiator?.url) {
      result.initiator.url = sanitizeUrl(result.initiator.url);
    }
    if (result.element) {
      result.element = sanitizeElement(result.element);
    }
    if (typeof result.value === "string") {
      result.value = sanitizeSensitiveText(result.value);
    }
    if (result.request) {
      result.request = sanitizeRequest(result.request, options);
    }
    if (result.response?.url) {
      result.response.url = sanitizeUrl(result.response.url);
    }

    return result;
  }

  function sanitizeRequest(request, options) {
    const result = cloneSerializable(request);
    if (result.url) {
      result.url = sanitizeUrl(result.url);
    }

    const nextHeaders = {};
    for (const [key, value] of Object.entries(result.headers || {})) {
      if (SAFE_HEADER_ALLOWLIST.has(String(key).toLowerCase())) {
        nextHeaders[key] = truncateText(String(value), 200);
      }
    }
    result.headers = nextHeaders;

    if (options.safeMode) {
      result.postDataPreview = "";
    } else if (typeof result.postDataPreview === "string") {
      result.postDataPreview = truncateText(result.postDataPreview, 500);
    }

    return result;
  }

  function sanitizeElement(element) {
    return {
      ...element,
      text: typeof element.text === "string" ? sanitizeSensitiveText(element.text) : element.text ?? null,
      placeholder: typeof element.placeholder === "string" ? truncateText(element.placeholder, 120) : element.placeholder ?? null,
      ariaLabel: typeof element.ariaLabel === "string" ? truncateText(element.ariaLabel, 120) : element.ariaLabel ?? null,
    };
  }

  function sanitizeUrl(url) {
    if (!url) {
      return url ?? "";
    }

    try {
      const parsed = new URL(url);
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
          parsed.searchParams.set(key, "[REDACTED]");
        } else {
          parsed.searchParams.set(key, sanitizeSensitiveText(parsed.searchParams.get(key) || ""));
        }
      }
      return parsed.toString();
    } catch {
      return sanitizeSensitiveText(String(url));
    }
  }

  function sanitizeSensitiveText(value) {
    if (typeof value !== "string") {
      return value ?? null;
    }

    let next = value;
    next = next.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
    next = next.replace(PHONE_PATTERN, "[REDACTED_PHONE]");

    if (TOKEN_LIKE_PATTERN.test(next)) {
      next = next.replace(TOKEN_LIKE_PATTERN, "[REDACTED_TOKEN]");
    }

    return truncateText(next, 200);
  }

  function buildPromptPreviewText(promptContext) {
    if (!promptContext) {
      return "No recording session yet.";
    }

    const lines = [
      "## Meta",
      `Name: ${promptContext.meta?.name || "N/A"}`,
      `Description: ${promptContext.meta?.description || "N/A"}`,
      `Start URL: ${promptContext.meta?.startUrl || "N/A"}`,
      "",
      "## Steps",
      String(promptContext.stepMarkdown || "").trim() || "No steps available.",
      "",
      `## Raw Preview (${Array.isArray(promptContext.raw) ? promptContext.raw.length : 0} events)`,
    ];

    const rawPreview = Array.isArray(promptContext.raw) ? promptContext.raw.slice(0, 5) : [];
    if (rawPreview.length === 0) {
      lines.push("No raw events selected for the prompt.");
    } else {
      for (const rawEvent of rawPreview) {
        lines.push(`${rawEvent.order || "?"}. ${rawEvent.type}`);
        lines.push(JSON.stringify(rawEvent, null, 2));
      }
    }

    return lines.join("\n");
  }

  return {
    buildPromptPreviewText,
    sanitizePromptContext,
  };
});
