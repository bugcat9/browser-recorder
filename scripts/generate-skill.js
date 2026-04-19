#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const inputDir = path.resolve(args.input);
  const outputDir = path.resolve(args.output || path.join(inputDir, "generated"));
  const baseUrl = args.baseUrl || process.env.LLM_BASE_URL || "";
  const apiKey = args.apiKey || process.env.LLM_API_KEY || "";
  const model = args.model || process.env.LLM_MODEL || "gpt-4.1-mini";
  const includeRaw = Number.parseInt(args.includeRaw || "0", 10);
  const temperature = Number.parseFloat(args.temperature || "0.2");
  const dryRun = Boolean(args.dryRun);

  ensureDir(inputDir);
  ensureFile(path.join(inputDir, "meta.json"));
  ensureFile(path.join(inputDir, "index.json"));
  ensureFile(path.join(inputDir, "step.llm.md"));

  const meta = readJson(path.join(inputDir, "meta.json"));
  const index = readJson(path.join(inputDir, "index.json"));
  const stepMarkdown = readTextFile(path.join(inputDir, "step.llm.md"));
  const stepFiles = Array.isArray(index.steps) ? index.steps.map((step) => path.join(inputDir, step.stepFile)) : [];
  const steps = stepFiles.filter((filePath) => fs.existsSync(filePath)).map(readJson);
  const raw = includeRaw > 0 ? readIndexedFiles(path.join(inputDir, "raw"), includeRaw) : [];
  const promptTemplate = fs.readFileSync(path.resolve(__dirname, "..", "prompts", "skill-generator.md"), "utf8");

  const requestContext = {
    meta,
    index,
    stepMarkdown,
    steps,
    raw,
  };

  fs.mkdirSync(outputDir, { recursive: true });

  if (dryRun) {
    fs.writeFileSync(path.join(outputDir, "prompt-system.txt"), promptTemplate);
    fs.writeFileSync(path.join(outputDir, "prompt-user.json"), JSON.stringify(requestContext, null, 2));
    console.log(`Dry run complete. Prompt files written to ${outputDir}`);
    return;
  }

  if (!baseUrl || !apiKey) {
    throw new Error("Missing LLM_BASE_URL or LLM_API_KEY. Set env vars or pass --base-url and --api-key.");
  }

  const responseText = await callChatCompletions({
    baseUrl,
    apiKey,
    model,
    temperature,
    systemPrompt: promptTemplate,
    userContent: JSON.stringify(requestContext, null, 2),
  });

  const skill = parseModelJson(responseText);
  validateSkill(skill);

  fs.writeFileSync(path.join(outputDir, "skill.json"), `${JSON.stringify(skill, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "skill.md"), `${renderSkillMarkdown(skill)}\n`);
  fs.writeFileSync(path.join(outputDir, "llm-response.txt"), `${responseText}\n`);

  console.log(`Generated skill files in ${outputDir}`);
}

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[toCamelCase(key)] = true;
      continue;
    }

    result[toCamelCase(key)] = next;
    index += 1;
  }

  return result;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  node scripts/generate-skill.js --input <skill-dir> [options]

Options:
  --output <dir>          Output directory. Default: <input>/generated
  --base-url <url>        OpenAI-compatible base URL. Default: env LLM_BASE_URL
  --api-key <key>         API key. Default: env LLM_API_KEY
  --model <name>          Model name. Default: env LLM_MODEL or gpt-4.1-mini
  --include-raw <count>   Include first N raw events in the prompt. Default: 0
  --temperature <value>   Sampling temperature. Default: 0.2
  --dry-run               Write prompt files only, do not call the API
  --help                  Show this help
`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Directory not found: ${dirPath}`);
  }
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`File not found: ${filePath}`);
  }
}

function readJson(filePath) {
  return JSON.parse(readTextFile(filePath));
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readIndexedFiles(dirPath, limit) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(0, limit)
    .map((name) => readJson(path.join(dirPath, name)));
}

async function callChatCompletions({
  baseUrl,
  apiKey,
  model,
  temperature,
  systemPrompt,
  userContent,
}) {
  const url = buildChatCompletionsUrl(baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userContent,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new Error("LLM response did not contain message content.");
  }

  return content;
}

function buildChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

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

function validateSkill(skill) {
  const requiredStringKeys = ["name", "description", "goal", "startUrl"];
  for (const key of requiredStringKeys) {
    if (typeof skill?.[key] !== "string") {
      throw new Error(`Generated skill is missing required string field: ${key}`);
    }
  }

  const requiredArrayKeys = ["prerequisites", "steps", "assertions", "fallback", "notes"];
  for (const key of requiredArrayKeys) {
    if (!Array.isArray(skill?.[key])) {
      throw new Error(`Generated skill is missing required array field: ${key}`);
    }
  }
}

function renderSkillMarkdown(skill) {
  const lines = [
    `# ${skill.name}`,
    "",
    skill.description,
    "",
    `Goal: ${skill.goal}`,
    `Start URL: ${skill.startUrl || "N/A"}`,
    "",
    "## Prerequisites",
    ...renderList(skill.prerequisites),
    "",
    "## Steps",
    ...renderSteps(skill.steps),
    "",
    "## Assertions",
    ...renderList(skill.assertions),
    "",
    "## Fallback",
    ...renderList(skill.fallback),
    "",
    "## Notes",
    ...renderList(skill.notes),
  ];

  return lines.join("\n");
}

function renderList(items) {
  if (!items || items.length === 0) {
    return ["- None"];
  }

  return items.map((item) => `- ${String(item)}`);
}

function renderSteps(steps) {
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

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
