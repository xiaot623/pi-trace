# E2E Tests

真实调用 `pi` CLI，加载本仓库的 trace extension，并使用模型 `openai-codex/gpt-5.4-mini` 做冒烟测试。

> 注意：这是会真实请求模型的测试。这里显式指定 provider，避免裸 `gpt-5.4-mini` 被解析到其它 provider。

## 目录结构

```text
e2e/
  helpers/
    pi-runner.mjs          # spawn 封装、prompts、formatFailure
    setup.mjs              # 公共路径常量、enableAllConsumers、cleanupArtifacts、combineOutput
  consumers/
    console/
      assertions.mjs       # console consumer 断言函数
    markdown/
      assertions.mjs       # markdown consumer 断言函数（含 findMarkdownFiles）
    lark/
      assertions.mjs       # lark consumer 断言函数（含 asset map 验证）
  trace-default.e2e.mjs    # 骨架测试用例，调用各 consumer assertions
```

E2E 使用默认开发配置路径，测试会显式写入启用所有 Consumer 的配置。覆盖单轮真实 pi run，以及同一次 `pi -p` 传入多条 message 触发的多轮 run。

## Consumer 配置默认值

当前默认不启用 Consumer。E2E 会写入配置启用 Console、Markdown 和 Lark。Markdown Consumer 写入固定资产目录并按月份分目录：

- markdown 目录：`<当前目录>/dev_assets/markdown/YYYY-MM/`
- session 资产映射：`<当前目录>/dev_assets/pi-trace.assets.json`

首次启动会在固定资产目录创建配置文件：`<当前目录>/dev_assets/pi-trace.config.json`。后续只通过配置文件控制 Consumer 是否开启及相关参数，不再使用环境变量覆盖：

```json
{
  "consumers": {
    "console": {
      "enabled": true,
      "filter": { "kinds": ["both"] }
    },
    "markdown": {
      "enabled": true
    },
    "lark": {
      "enabled": true,
      "wiki_space_id": ""
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
- markdown output: `dev_assets/markdown/YYYY-MM/*.md`
- asset map: `dev_assets/pi-trace.assets.json`

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
- 多轮场景额外验证：`turn.record turn=0` 和 `turn.record turn=1`

Markdown Consumer：

- 默认写入 `dev_assets/markdown/YYYY-MM/`
- 验证 Markdown 文档包含二级标题：`User`, `Thinking`, `Assistant`, `Tool Call`, `Summary`
- 验证单轮工具执行结果包含：`trace-ok`
- 验证多轮工具执行结果包含：`trace-turn-0` 和 `trace-turn-1`

Asset Map：

- 验证 `pi-trace.assets.json` 只有一个 session entry
- 验证该 entry 关联 markdown 路径、Lark document token 和月份归档信息
