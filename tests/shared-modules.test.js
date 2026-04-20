const test = require("node:test");
const assert = require("node:assert/strict");

const { buildLlmPromptContext, buildSkillPackage } = require("../lib/skill-package.js");
const { parseModelJson, validateGeneratedSkill } = require("../lib/generation-utils.js");

function createBaseSession(events) {
  return {
    id: "session-1234",
    startedAt: "2026-04-20T10:00:00.000Z",
    stoppedAt: "2026-04-20T10:05:00.000Z",
    metadata: {
      recorderVersion: "0.2.0",
      timezone: "Asia/Shanghai",
      userAgent: "test-agent",
      skillName: "Login flow",
      skillDescription: "Record login flow.",
      startUrl: "https://example.com/login?token=secret-token",
      startTitle: "Login",
      startTabId: 1,
      startWindowId: 1,
    },
    tabs: {
      "1": {
        tabId: 1,
        windowId: 1,
        openerTabId: null,
        attached: false,
        createdAt: "2026-04-20T10:00:00.000Z",
        lastKnownUrl: "https://example.com/dashboard",
        lastKnownTitle: "Dashboard",
      },
    },
    events,
  };
}

test("normalizeSteps merges click results into a single outcome-aware step", () => {
  const session = createBaseSession([
    {
      type: "session_started",
      timestamp: "2026-04-20T10:00:00.000Z",
      skillName: "Login flow",
      skillDescription: "Record login flow.",
      startUrl: "https://example.com/login",
      startTitle: "Login",
    },
    {
      type: "dom_click",
      timestamp: "2026-04-20T10:00:01.000Z",
      tabId: 1,
      url: "https://example.com/login",
      title: "Login",
      element: {
        tagName: "button",
        text: "Sign in",
        selector: "#submit",
      },
    },
    {
      type: "network_request",
      timestamp: "2026-04-20T10:00:01.200Z",
      tabId: 1,
      requestId: "req-1",
      request: {
        url: "https://example.com/api/login",
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      },
    },
    {
      type: "network_response",
      timestamp: "2026-04-20T10:00:01.400Z",
      tabId: 1,
      requestId: "req-1",
      resourceType: "Document",
      response: {
        url: "https://example.com/dashboard",
        status: 302,
      },
    },
    {
      type: "page_frame_navigated",
      timestamp: "2026-04-20T10:00:02.000Z",
      tabId: 1,
      frame: {
        id: "frame-1",
        parentId: null,
        url: "https://example.com/dashboard",
        loaderId: "loader-1",
      },
    },
  ]);

  const skillPackage = buildSkillPackage(session, {
    schemaVersion: "2.0",
  });

  assert.equal(skillPackage.steps.length, 2);
  assert.equal(skillPackage.steps[1].type, "click");
  assert.match(skillPackage.steps[1].tip, /navigate to example\.com\/dashboard/i);
  assert.equal(skillPackage.steps[1].detail.resultNavigationUrl, "https://example.com/dashboard");
  assert.equal(skillPackage.steps[1].detail.resultStatus, 302);
});

test("prompt raw selection keeps step-related evidence from later in the session", () => {
  const noiseEvents = Array.from({ length: 24 }, (_, index) => ({
    type: "network_request",
    timestamp: `2026-04-20T10:00:${String(index).padStart(2, "0")}.000Z`,
    tabId: 1,
    requestId: `noise-${index}`,
    request: {
      url: `https://example.com/assets/${index}.js`,
      method: "GET",
      headers: {
        accept: "*/*",
      },
    },
  }));

  const session = createBaseSession([
    {
      type: "session_started",
      timestamp: "2026-04-20T10:00:00.000Z",
      skillName: "Late click flow",
      skillDescription: "Late click flow.",
      startUrl: "https://example.com/start",
      startTitle: "Start",
    },
    ...noiseEvents,
    {
      type: "dom_click",
      timestamp: "2026-04-20T10:00:30.000Z",
      tabId: 1,
      url: "https://example.com/start",
      title: "Start",
      element: {
        tagName: "a",
        text: "Continue",
        selector: ".continue",
      },
    },
    {
      type: "page_frame_navigated",
      timestamp: "2026-04-20T10:00:31.000Z",
      tabId: 1,
      frame: {
        id: "frame-2",
        parentId: null,
        url: "https://example.com/next",
        loaderId: "loader-2",
      },
    },
  ]);

  const promptContext = buildLlmPromptContext(session, {
    schemaVersion: "2.0",
    safeMode: true,
    rawSelection: {
      limit: 5,
    },
  });

  assert.ok(promptContext.raw.length <= 5);
  assert.ok(promptContext.raw.some((rawEvent) => rawEvent.order > 20));
  assert.ok(promptContext.raw.some((rawEvent) => rawEvent.type === "dom_click"));
});

test("safe mode redacts sensitive prompt data without changing structure", () => {
  const session = createBaseSession([
    {
      type: "session_started",
      timestamp: "2026-04-20T10:00:00.000Z",
      skillName: "Sensitive flow",
      skillDescription: "Sensitive flow.",
      startUrl: "https://example.com/login?token=abcd1234secret",
      startTitle: "Login",
    },
    {
      type: "dom_input",
      timestamp: "2026-04-20T10:00:01.000Z",
      tabId: 1,
      url: "https://example.com/login?email=user@example.com",
      title: "Login",
      element: {
        tagName: "input",
        name: "email",
        selector: "#email",
      },
      value: "user@example.com",
      checked: null,
    },
    {
      type: "network_request",
      timestamp: "2026-04-20T10:00:01.200Z",
      tabId: 1,
      requestId: "req-sensitive",
      request: {
        url: "https://example.com/api/login?api_key=secret",
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        postDataPreview: "{\"email\":\"user@example.com\"}",
      },
    },
  ]);

  const promptContext = buildLlmPromptContext(session, {
    schemaVersion: "2.0",
    safeMode: true,
    rawSelection: {
      limit: 10,
    },
  });
  const networkRequest = promptContext.raw.find((rawEvent) => rawEvent.type === "network_request");

  assert.match(promptContext.meta.startUrl, /%5BREDACTED%5D/);
  assert.match(promptContext.steps[1].detail.value, /\[REDACTED_EMAIL\]/);
  assert.ok(networkRequest);
  assert.equal(networkRequest.request.postDataPreview, "");
  assert.deepEqual(networkRequest.request.headers, {
    "content-type": "application/json",
  });
});

test("generation utils parse fenced json and validate shape", () => {
  const parsed = parseModelJson("```json\n{\"name\":\"Skill\",\"description\":\"Desc\",\"goal\":\"Goal\",\"startUrl\":\"https://example.com\",\"prerequisites\":[],\"steps\":[],\"assertions\":[],\"fallback\":[],\"notes\":[]}\n```");

  assert.equal(parsed.name, "Skill");
  assert.doesNotThrow(() => {
    validateGeneratedSkill(parsed);
  });
  assert.throws(() => {
    validateGeneratedSkill({
      name: "bad",
      description: "bad",
      goal: "bad",
      startUrl: "https://example.com",
      prerequisites: [],
      steps: [],
      assertions: [],
      fallback: [],
    });
  }, /notes/);
});
