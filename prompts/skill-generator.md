You are generating a reusable browser automation skill from a recorded browser session.

Return JSON only. Do not use Markdown fences. Do not add commentary.

The JSON must follow this shape exactly:

{
  "name": "string",
  "description": "string",
  "goal": "string",
  "startUrl": "string",
  "prerequisites": ["string"],
  "steps": [
    {
      "id": "s0001",
      "title": "short step title",
      "action": "clear imperative instruction",
      "target": "optional target description",
      "value": "optional input value",
      "expected": "optional expected result"
    }
  ],
  "assertions": ["string"],
  "fallback": ["string"],
  "notes": ["string"]
}

Rules:

- Use the recorded skill name and description when they are present.
- Keep steps concise, deterministic, and directly actionable.
- Prefer business-level actions over raw browser noise.
- Use the normalized steps as the primary source of truth.
- Use raw events only if they materially clarify an action or expected result.
- Do not invent credentials, secrets, or internal data.
- If a field is unknown, use an empty string or empty array instead of guessing.
