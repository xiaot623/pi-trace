# E2E Tests

真实调用 `pi` CLI，加载本仓库的 trace extension，并使用模型 `openai-codex/gpt-5.4-mini` 做冒烟测试。

> 注意：这是会真实请求模型的测试。这里显式指定 provider，避免裸 `gpt-5.4-mini` 被解析到其它 provider。

## 目录结构

按 Consumer 分目录维护验证脚本：

```text
e2e/
  helpers/
    pi-runner.mjs
  consumers/
    console/
      trace-console.e2e.mjs
    markdown/
      trace-markdown.e2e.mjs
```

## 运行

运行全部 E2E：

```bash
npm run test:e2e
```

运行单个 Consumer：

```bash
node --test e2e/consumers/console/*.e2e.mjs
node --test e2e/consumers/markdown/*.e2e.mjs
```

默认配置：

- extension: `src/index.ts`
- model: `openai-codex/gpt-5.4-mini`
- timeout: `180000ms`
- trace kinds: `both`

可通过环境变量覆盖：

```bash
PI_E2E_MODEL=openai-codex/gpt-5.4-mini \
PI_E2E_TIMEOUT_MS=180000 \
PI_TRACE_KINDS=both \
npm run test:e2e
```

## Consumer 验证点

Console Consumer：

- realtime: `turn.started`, `message.started`, `tool.started`, `tool.result`, `tool.ended`
- batch: `message.record`, `tool.record`, `turn.record`, `agent.run`
- bash 输出：`trace-ok`

Markdown Consumer：

- 通过 `PI_TRACE_MARKDOWN_PATH` 指定输出文件
- 验证 Markdown 文档包含二级标题：`User`, `Thinking`, `Assistant`, `Tool Call`, `Summary`
- 验证工具执行结果包含：`trace-ok`
