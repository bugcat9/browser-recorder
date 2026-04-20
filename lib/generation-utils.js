(function(root, factory) {
  const api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  root.BSRGenerationUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
  function parseModelJson(text) {
    const direct = tryParseJson(text);
    if (direct) {
      return direct;
    }

    const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch) {
      const parsed = tryParseJson(fencedMatch[1]);
      if (parsed) {
        return parsed;
      }
    }

    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const parsed = tryParseJson(text.slice(start, end + 1));
      if (parsed) {
        return parsed;
      }
    }

    throw new Error("Could not parse JSON from LLM response.");
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function validateGeneratedSkill(skill) {
    const requiredStrings = ["name", "description", "goal", "startUrl"];
    for (const key of requiredStrings) {
      if (typeof skill?.[key] !== "string") {
        throw new Error(`Generated skill is missing required string field: ${key}`);
      }
    }

    const requiredArrays = ["prerequisites", "steps", "assertions", "fallback", "notes"];
    for (const key of requiredArrays) {
      if (!Array.isArray(skill?.[key])) {
        throw new Error(`Generated skill is missing required array field: ${key}`);
      }
    }
  }

  function renderGeneratedSkillMarkdown(skill) {
    const lines = [
      `# ${skill.name}`,
      "",
      skill.description,
      "",
      `Goal: ${skill.goal}`,
      `Start URL: ${skill.startUrl || "N/A"}`,
      "",
      "## Prerequisites",
      ...renderMarkdownList(skill.prerequisites),
      "",
      "## Steps",
      ...renderGeneratedSkillSteps(skill.steps),
      "",
      "## Assertions",
      ...renderMarkdownList(skill.assertions),
      "",
      "## Fallback",
      ...renderMarkdownList(skill.fallback),
      "",
      "## Notes",
      ...renderMarkdownList(skill.notes),
    ];

    return lines.join("\n");
  }

  function renderMarkdownList(items) {
    if (!items || items.length === 0) {
      return ["- None"];
    }

    return items.map((item) => `- ${String(item)}`);
  }

  function renderGeneratedSkillSteps(steps) {
    if (!steps || steps.length === 0) {
      return ["1. No steps generated"];
    }

    return steps.map((step, index) => {
      const parts = [step.action || step.title || `Step ${index + 1}`];
      if (step.target) {
        parts.push(`Target: ${step.target}`);
      }
      if (step.value) {
        parts.push(`Value: ${step.value}`);
      }
      if (step.expected) {
        parts.push(`Expected: ${step.expected}`);
      }

      return `${index + 1}. ${parts.join(" | ")}`;
    });
  }

  return {
    parseModelJson,
    renderGeneratedSkillMarkdown,
    validateGeneratedSkill,
  };
});
