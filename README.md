# Browser Skill Recorder

一个基于 Chrome Manifest V3 的浏览器扩展原型，用于录制浏览操作，并导出为适合 LLM 消费的 skill package。

## 当前导出结构

导出结果是一个 `.zip`，解压后结构如下：

```text
skill-name-1a2b3c4d/
  meta.json
  index.json
  step.llm.md
  steps/
    s0001.json
    s0002.json
  raw/
    e0001.json
    e0002.json
```

### `meta.json`

保存 skill 的基础元信息：

- `name`
- `description`
- `startUrl`
- `startTitle`
- `createdAt`
- `startedAt`
- `stoppedAt`

### `index.json`

机器可读索引，作为唯一权威索引，保存：

- skill 基本信息
- `counts`
- 每个归一化步骤的 `id`、`type`、`tip`、`stepFile`、`rawEventIds`、`timestamp`

### `step.llm.md`

给 LLM 读取的纯文本步骤列表，只保留高层步骤描述，不直接暴露全部底层 CDP 噪音。

### `steps/*.json`

归一化后的技能步骤，例如：

- `navigate`
- `click`
- `input`
- `select`
- `check`
- `uncheck`
- `submit`
- `open_tab`
- `switch_tab`
- `close_tab`

### `raw/*.json`

原始事件明细，保留完整低层录制数据，便于回溯：

- DOM 事件
- 网络请求与响应
- tab 生命周期事件
- 页面导航事件

## 当前能力

- 通过 `chrome.debugger` 接入 CDP，采集网络请求与页面导航相关事件
- 通过 `content script` 采集 DOM 交互事件
  - `click`
  - `input`
  - `change`
  - `submit`
  - `beforeunload`
- 通过 `tabs` / `windows` API 采集标签页相关事件
  - tab 激活切换
  - tab 创建
  - tab 更新
  - tab 关闭
  - window focus 切换
- 导出为分层 skill package，而不是单个大 JSON

## 安装方式

1. 打开 Chrome，进入 `chrome://extensions`
2. 打开右上角 `Developer mode`
3. 点击 `Load unpacked`
4. 选择当前目录 `browser-recorder`

## 使用方式

1. 点击扩展图标，打开 popup
2. 在 popup 里填写 `Skill Name` 和 `Skill Purpose`
3. 点击 `Start`
4. 在浏览器里执行你的操作
5. 点击 `Stop`
6. 点击 `Export Skill`
7. 下载 `.zip` 文件并解压

## LLM 消费建议

推荐按下面顺序读取导出结果：

1. `meta.json`
2. `index.json`
3. `step.llm.md`
4. 仅在需要追溯具体细节时，再读取 `steps/*.json` 或 `raw/*.json`

这样可以显著减少上下文噪音，避免把大量底层网络和 DOM 事件直接塞给 LLM。

## LLM 生成 Skill

仓库现在支持两种方式生成 skill：

1. 在扩展 popup 里直接生成
2. 用本地 CLI 处理解压后的录制目录

### 在 Popup 中直接生成

在录制完成后：

1. 打开扩展 popup
2. 在 `LLM Generation` 区域填写：
   - `Base URL`
   - `API Key`
   - `Model`
3. 点击 `Generate Skill`
4. 生成结果会显示在 popup 的 `Generated Preview`
5. 也可以直接下载：
   - `Download JSON`
   - `Download Markdown`

说明：

- `Base URL` 采用 OpenAI 风格接口，脚本会自动补成 `/chat/completions`
- `API Key` 和 `Model` 会保存在扩展本地存储中，方便下次继续使用

### 使用本地 CLI

先设置环境变量：

```powershell
$env:LLM_BASE_URL="https://your-api-host/v1"
$env:LLM_API_KEY="your-key"
$env:LLM_MODEL="gpt-4.1-mini"
```

然后执行：

```powershell
node scripts/generate-skill.js --input .\path\to\exported-skill-folder
```

生成结果会写到录制目录下的 `generated/`：

- `generated/skill.json`
- `generated/skill.md`
- `generated/llm-response.txt`

如果你只想先看 prompt，不真正调用接口：

```powershell
node scripts/generate-skill.js --input .\path\to\exported-skill-folder --dry-run
```

## 已知限制

- 无法录制 `chrome://`、Chrome Web Store、扩展页等受限页面
- 当前仍会保留完整原始事件，长会话会生成较多 `raw/*.json`
- 当前 `name` 和 `description` 由起始页面信息自动推断，后续可以再补手动编辑能力
- 如果在开始录制前填写了 `Skill Name` 和 `Skill Purpose`，导出时会优先使用你的输入
- 当前未实现“网络事件和步骤”的强关联，只是把网络细节保存在 `raw/`
- 当前对密码输入会写入 `[REDACTED]`

## 下一步建议

如果继续往“录制即 skill”的方向推进，建议下一步实现：

1. 在 popup 中允许手动填写 `name` / `description`
2. 增加更强的步骤归一化规则
3. 把 click + network_request 组合成更稳定的业务动作
4. 增加回放器，把 `steps/*.json` 转回自动化执行计划
