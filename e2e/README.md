# E2E Tests

真实调用 `pi` CLI，加载本仓库的 trace extension，并使用模型 `openai-codex/gpt-5.4-mini` 做冒烟测试。

> 注意：这是会真实请求模型的测试。这里显式指定 provider，避免裸 `gpt-5.4-mini` 被解析到其它 provider。

运行：

```bash
npm run test:e2e
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

测试会断言终端输出里包含：

- realtime: `turn.started`, `message.started`, `tool.started`, `tool.result`, `tool.ended`
- batch: `message.record`, `tool.record`, `turn.record`, `agent.run`
- bash 输出：`trace-ok`
