(function(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.BSRCommon = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  const DEFAULT_MAX_TEXT_LENGTH = 300;

  function truncateText(value, maxLength = DEFAULT_MAX_TEXT_LENGTH) {
    if (typeof value !== "string") {
      return value ?? null;
    }

    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}...`;
  }

  function cloneSerializable(value) {
    return JSON.parse(JSON.stringify(value));
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

  function sanitizeFileNameComponent(value) {
    const cleaned = String(value)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, 120);

    if (!cleaned) {
      return "Browser Skill";
    }

    const reservedNames = new Set([
      "CON",
      "PRN",
      "AUX",
      "NUL",
      "COM1",
      "COM2",
      "COM3",
      "COM4",
      "COM5",
      "COM6",
      "COM7",
      "COM8",
      "COM9",
      "LPT1",
      "LPT2",
      "LPT3",
      "LPT4",
      "LPT5",
      "LPT6",
      "LPT7",
      "LPT8",
      "LPT9",
    ]);

    if (reservedNames.has(cleaned.toUpperCase())) {
      return `Skill ${cleaned}`;
    }

    return cleaned;
  }

  function normalizeUserText(value, maxLength) {
    if (typeof value !== "string") {
      return "";
    }

    return truncateText(value.trim(), maxLength) || "";
  }

  function unique(items) {
    return Array.from(new Set(items));
  }

  return {
    cloneSerializable,
    formatUrlForTip,
    normalizeUserText,
    sanitizeFileNameComponent,
    truncateText,
    unique,
  };
});
