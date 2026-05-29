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

- 开发模式：`<当前目录>/dev_assets/markdown/trace-<timestamp>.md`
- 正式环境：`~/.pi-trace/markdown/trace-<timestamp>.md`

模式判断：

- `PI_TRACE_MODE=production` 或 `NODE_ENV=production` => 正式环境
- 其它情况 => 开发模式

常用覆盖项：

```bash
PI_TRACE_ASSET_DIR=/tmp/pi-trace-assets       # 覆盖资产根目录
PI_TRACE_CONSOLE_ENABLED=false                # 禁用 Console Consumer
PI_TRACE_MARKDOWN_PATH=/tmp/trace.md          # 覆盖 Markdown 文件路径
PI_TRACE_MARKDOWN_ENABLED=false               # 禁用 Markdown Consumer
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
