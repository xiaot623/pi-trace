# Plan: Telegram Consumer for pi-trace

## 1. Goal

为 pi-trace 增加一个 Telegram consumer，通过 Telegram Bot 将 agent run 的进展和结果发送到一个或多个指定 chat，支持 bot 私聊、群聊。

本 consumer 不做 token 级实时流式输出，只消费 batch events。它的目标是在 agent 执行过程中提供低噪声的阶段可见性，并在 run 结束后保留完整摘要。

对支持 Telegram topic 的 chat，consumer 应为每个会话创建独立 topic，并将该会话的所有消息发送到对应 topic 中，避免多个会话在同一个消息流里混杂。

## 2. Message Model

Telegram 中展示四类消息：

| 类别 | 来源 | 生命周期 |
|------|------|----------|
| Thinking | assistant message 中的 thinking block | 当前 turn 内展示，turn 结束删除 |
| Tool | `tool.record` | 当前 turn 内展示，turn 结束删除 |
| Assistant | assistant message 中的 text block | 当前 turn 内展示，turn 结束删除 |
| Stage Summary | 当前 turn 最后一条 assistant text | turn 结束发送，不删除 |
| Run Summary | `agent.run` 统计信息 | run 结束发送，不删除 |

说明：

- “展示”指 batch event 到达后更新 Telegram 消息，不表示 token 级流式刷新。
- 当配置多个 chat 时，同一份 trace 内容广播到所有 chat。
- 如果某个 chat 支持 topic 隔离，该 chat 内的所有消息发送到本会话对应 topic。
- Thinking、Tool、Assistant 是临时消息，帮助用户看到当前 turn 的进展。
- Stage Summary 和 Run Summary 是最终保留内容。

## 3. Topic Isolation

Telegram consumer 在每个 run 第一次需要发送消息时，为支持 topic 的 chat 创建一个 topic。

规则：

- 每个 run/session 在每个 chat 中最多创建一个 topic。
- topic 创建成功后，该 chat 后续 `sendMessage` 使用返回的 `message_thread_id`。
- private chat、group 和 supergroup 都可能支持 topic；consumer 不应按 chat 类型提前排除。
- chat 不支持 topic 或当前 bot 无权创建 topic 时，应退化为直接向 chat 发送消息。
- 创建 topic 失败不应中断 trace；该 chat 退化为无 topic 发送，并记录错误日志。
- topic 信息需要按 `chatId` 保存，因为不同 chat 的 `message_thread_id` 不可复用。

Topic 名称参考 markdown consumer 的文件名生成规则：

1. 使用 `deriveTraceTitleSubject(payload)` 选择标题主体。
2. 使用 `buildTraceTitle(timestamp, subject)` 生成标题。
3. 使用 `sanitizeTraceFileName(title)` 做与 markdown 文件名一致的清理。
4. Telegram topic 名称在清理后截断到最多 9 个字符。

## 4. Turn Lifecycle

一个 turn 内可能出现多条 assistant message 和多次 tool call。

处理规则：

1. 收到 assistant `message.record` 时，读取其中的 thinking/text blocks。
2. Thinking 消息采用覆盖策略：新的 thinking 内容替换旧 thinking 临时消息。
3. Assistant 消息采用覆盖策略：新的 assistant text 替换旧 assistant 临时消息。
4. Tool 消息采用追加策略：每个 `tool.record` 增加一行。
5. 收到 `turn.record` 时，删除当前 turn 的临时消息，并发送 Stage Summary。
6. 收到 `agent.run` 时，发送 Run Summary。

Stage Summary 的主体是当前 turn 最后一条 assistant text。它对齐 Lark consumer 在 `turn.record` 时 flush 当前内容的行为，不额外追加 turn 元信息。

Run Summary 负责展示 tokens、cost、总 turn 数、总 tool 数、总耗时等 run 级统计。

## 5. Message Content

### Thinking

来源：assistant `message.record` 的 `thinking` block。

格式：

```text
Thinking

<thinking text>
```

多个 thinking block 的处理方式：

- 同一条 assistant message 内的多个 thinking block 拼接。
- 同一 turn 内后续 assistant message 的 thinking 覆盖前一次 thinking 临时消息。

### Tool

来源：`tool.record`。

每行一条 tool call：

```text
[toolName] input
```

规则：

- `toolName` 来自 `tool.record.toolName`。
- `input` 来自 `tool.record.input`，按可读文本渲染。
- `isError` 为 true 时，在该行标记失败。
- Tool 临时消息只展示最近一批调用；过长时允许从当前 tool call 重新开始展示。
- 当前 turn 的 tool 数量必须单独统计，不能依赖临时消息中仍保留的行数。

### Assistant

来源：assistant `message.record` 的 `text` block。

规则：

- 同一条 assistant message 内的多个 text block 拼接。
- 同一 turn 内后续 assistant message 的 text 覆盖前一次 assistant 临时消息。
- Stage Summary 使用当前 turn 最后一条非空 assistant text。

### Stage Summary

触发时机：`turn.record`。

内容：

```text
<last assistant text>
```

Stage Summary 不展示 turnIndex、tool count、duration、token 或 cost。run 级元信息统一由 Run Summary 展示，以对齐 Lark consumer 的 `agent.run` usage 输出。

### Run Summary

触发时机：`agent.run`。

内容包含：

- Run ID
- Session Name（如事件中存在）
- Session ID（如事件中存在）
- Model（如事件中存在）
- Workspace（如事件中存在）
- Tokens、In、Out、Cost（如事件中存在）
- 总 turn 数、message 数、tool 数、error 数、总耗时

其中 token/cost 的文本格式应与 Lark consumer 的 usage callout 保持一致：`Tokens: N | In: N (cached N) | Out: N | Cost: $N.NNNN`。

## 6. Telegram Constraints

Telegram message 有长度限制。consumer 需要支持长文本分块：

- 每个分块不能超过 Telegram 单条消息上限。
- 优先在段落、标题或行边界分块。
- 如果单行超过硬限制，允许硬切分；这是 Telegram API 限制。
- Stage Summary 不追加额外元信息。Run Summary 如果分块，元信息应保持在同一组 summary 消息中。

如果使用 Telegram HTML parse mode，必须对用户内容和模型内容做 HTML escaping，避免 `<`, `>`, `&` 等字符导致发送失败。也可以选择不使用 parse mode，以降低复杂度。

## 7. Ordering and Reliability

Telegram API 调用是异步的，而 TraceCore 不等待 consumer 完成。Telegram consumer 必须在内部串行处理事件，保证同一 run 内的 delete/send/edit 顺序稳定。

当配置多个 chat 时，Telegram message id 只在单个 chat 内有效。consumer 必须按 `chatId` 分别追踪临时消息 ID，删除和编辑消息时使用对应 chat 的 message id。

如果某个 chat 使用 topic，consumer 还必须按 `chatId` 记录对应的 `message_thread_id`，并在该 chat 的所有发送请求中携带它。

需要容忍以下 Telegram API 错误：

- 删除已不存在的消息
- 编辑内容未变化
- 消息过长
- chatId 或 bot 权限错误
- topic 创建失败、chat 不支持 topic 或 bot 无创建权限
- rate limit

这些错误不应中断 pi agent 执行。

## 8. Configuration

新增 consumer 配置：

```json
{
  "consumers": {
    "telegram": {
      "enabled": true,
      "botToken": "123456:ABC-DEF1234",
      "chatIds": ["123456789", "-1001234567890"]
    }
  }
}
```

`chatIds` 是 Telegram Bot API 的统一 chat 标识列表。单聊和群聊都通过该字段配置。

建议支持环境变量覆盖 `botToken`，避免将 bot token 写入配置文件。

## 9. Files to Change

预计修改：

| 文件 | 目的 |
|------|------|
| `src/trace/config/types.ts` | 增加 Telegram 配置类型 |
| `src/trace/config/default-config.ts` | 增加默认配置 |
| `src/trace/config/resolve-config.ts` | 合并和写入 Telegram 配置 |
| `src/trace/consumers/telegram/index.ts` | 新增 Telegram consumer |
| `src/index.ts` | 注册和导出 Telegram consumer |

可选修改：

| 文件 | 目的 |
|------|------|
| `src/trace/assets/session-asset-map.ts` | 记录 Telegram chat/topic 列表信息 |

## 10. Open Questions

- 是否必须使用 Telegram HTML parse mode；如果不是，优先用纯文本降低 escaping 和分块复杂度。
- `botToken` 是否只允许环境变量，还是同时允许配置文件字段。
- 是否需要配置开关禁用 topic 创建。
