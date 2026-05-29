# E2E Tests

真实调用 `pi` CLI，加载本仓库的 trace extension，并使用模型 `openai-codex/gpt-5.4-mini` 做冒烟测试。

> 注意：这是会真实请求模型的测试。这里显式指定 provider，避免裸 `gpt-5.4-mini` 被解析到其它 provider。

## 目录结构

```text
e2e/
  helpers/
    pi-runner.mjs
  trace-default.e2e.mjs
```

E2E 只跑默认开发配置：一次真实 pi run 会触发所有默认启用的 Consumer。

## Consumer 配置默认值

当前默认启用 Console 和 Markdown 两种 Consumer。Markdown Consumer 通过统一 Consumer 配置决定输出位置：

- 默认路径：`<当前目录>/dev_assets/markdown/trace-<timestamp>.md`

首次启动会在固定资产目录创建配置文件：`<当前目录>/dev_assets/pi-trace.config.json`。默认内容来自 `src/trace/config/default-config-template.ts` 中的 JSON 文本块，创建时会把 `markdown.outputPath` 写成绝对路径。

后续只通过配置文件控制 Consumer 是否开启及相关参数，不再使用环境变量覆盖：

```json
{
  "consumers": {
    "console": {
      "enabled": true,
      "filter": { "kinds": ["both"] }
    },
    "markdown": {
      "enabled": true,
      "outputPath": "/absolute/path/to/dev_assets/markdown/trace-{timestamp}.md"
    }
  }
}
```

## 运行

```bash
npm run test:e2e
```

默认配置：

- extension: `src/index.ts`
- model: `openai-codex/gpt-5.4-mini`
- timeout: `180000ms`
- trace kinds: `both`
- markdown output: `dev_assets/markdown/trace-<timestamp>.md`

可通过环境变量覆盖模型或超时：

```bash
PI_E2E_MODEL=openai-codex/gpt-5.4-mini \
PI_E2E_TIMEOUT_MS=180000 \
npm run test:e2e
```

## 验证点

Console Consumer：

- realtime: `turn.started`, `message.started`, `tool.started`, `tool.result`, `tool.ended`
- batch: `message.record`, `tool.record`, `turn.record`, `agent.run`
- bash 输出：`trace-ok`

Markdown Consumer：

- 默认写入 `dev_assets/markdown/`
- 验证 Markdown 文档包含二级标题：`User`, `Thinking`, `Assistant`, `Tool Call`, `Summary`
- 验证工具执行结果包含：`trace-ok`
