# Trace Core 设计

> 监听 pi extension hooks，生产两种事件：**Realtime**（流式，实时消费）和 **Batch**（稳定后，非实时消费）。

## 1. 两种事件，两种消费场景

```
pi extension hooks
        ↓
   Trace Producer
        ↓
   Trace Core ──┬── Realtime Event  → 实时消费（网页流式渲染、TUI 等）
                └── Batch Event     → 非实时消费（文档生成、落盘存储等）
```

Producer 只管把所有事件发出去。Consumer 通过 filter 声明自己关心什么：

```ts
filter: { kinds: ["realtime"] }   // 只收实时事件
filter: { kinds: ["batch"] }      // 只收批量事件
filter: { kinds: ["both"] }       // 两种都要
```

## 2. 从一条用户输入开始，发生了什么

用户在对话框输入 "帮我改一下文件"，pi 触发以下 hook 链：

```
input                     → 原始输入文本
before_agent_start        → prompt 展开后，system prompt 就绪
agent_start               → agent loop 开始

  ┌─ turn 0 ───────────────────────────
  │  turn_start             → 一轮开始
  │
  │  [LLM 调用，流式返回]
  │  message_start          → assistant 消息开始
  │  message_update × N     → 逐 token 流式数据（高频）
  │  message_end            → assistant 消息完成
  │
  │  [如果 LLM 决定调工具]
  │  tool_execution_start   → 工具开始执行
  │  tool_call              → 工具参数就绪
  │  tool_execution_update  → 工具执行中的部分结果
  │  tool_result            → 工具完成，有结果
  │  tool_execution_end     → 工具执行结束
  │
  │  [如果 LLM 继续说话，回到 message_start]
  │
  │  turn_end               → 一轮结束
  └────────────────────────────────────
  ┌─ turn 1 ───────────────────────────
  │  ...
  └────────────────────────────────────

agent_end                 → agent loop 结束
```

**关键发现**：pi 的 assistant message 的 `content` 是一个**结构化数组**，thinking 和 text 天然分开：

```ts
// pi 内部的 message 结构
{
  role: "assistant",
  content: [
    { type: "thinking", thinking: "嗯，用户想改文件，我需要先 read..." },
    { type: "text",     text: "好的，让我先看一下文件内容。" },
    { type: "toolCall", id: "xxx", name: "read", arguments: {...} },
    { type: "text",     text: "根据文件内容，我建议这样改..." },
  ]
}
```

这意味着 **Producer 不需要自己拆分 thinking 和 output**——pi 在事件里已经拆好了。

## 3. Realtime Event：流式消费

按时间顺序到达，描述"正在发生什么"。适用于网页流式渲染等场景。

| 事件 | 含义 | 关键字段 |
|------|------|---------|
| `turn.started` | 一轮开始 | `turnIndex` |
| `message.started` | 一条消息开始 | `role: "user" \| "assistant" \| "toolResult"` |
| `message.delta` | 流式文本增量 | `blockType: "thinking" \| "text"`, `text` |
| `message.ended` | 一条消息结束 | `role` |
| `tool.started` | 工具开始执行 | `toolName`, `toolCallId`, `args` |
| `tool.result` | 工具执行结果 | `toolName`, `contentPreview`, `isError` |
| `tool.ended` | 工具执行结束 | `toolName`, `toolCallId` |
| `turn.ended` | 一轮结束 | `turnIndex` |

**消费逻辑**：

```
收到 turn.started        → 新一轮
收到 message.started     → 开始一个新消息区块
收到 message.delta       → thinking 追加到折叠思考区，text 逐字追加到输出区
收到 tool.started        → 弹出一个工具调用卡片
收到 tool.result         → 卡片里显示结果摘要
收到 tool.ended          → 卡片标记完成
收到 message.ended       → 消息区块关闭
收到 turn.ended          → 本轮结束
```

不需要知道消息和工具的父子关系，**按时间顺序消费即可**。

## 4. Batch Event：非实时消费

内容稳定后产生，描述"最终发生了什么"。适用于生成回看文档、落盘存储等场景。

| 事件 | 含义 | 关键字段 |
|------|------|---------|
| `agent.run` | 一次 agent run 的容器 | `input`, `model`, `stats`, `eventIds` |
| `turn.record` | 一轮的边界标记 | `turnIndex`, `durationMs` |
| `message.record` | 一条完整消息 | `role`, `content`（结构化数组） |
| `tool.record` | 一次完整工具调用 | `toolName`, `input`, `resultContent`, `durationMs` |

**消费逻辑**（按 `eventIds` 顺序遍历，生成文档）：

```
agent.run              → 文档开头 + 用户输入的标题
turn.record(0)         → "## Turn 0"
message.record(user)   → 用户输入段落
message.record(assistant) → 遍历 content 数组：
  content[0]: type="thinking"  → 折叠段落：模型思考
  content[1]: type="text"      → 段落：模型输出
  content[2]: type="toolCall"  → 工具调用占位（下一条 tool.record 展开）
tool.record(read)       → 工具调用段落：参数 + 结果
message.record(assistant) → 继续遍历 content 数组：
  content[0]: type="text"      → 段落：模型输出
turn.record(1)         → "## Turn 1"
  ...
agent.run 结束         → 文档结尾附上统计摘要
```

`eventIds` 保证了事件的先后顺序，Consumer 不需要自己维护时序。

## 5. Producer 做什么

Producer 监听 pi hooks，在恰当时机发出 Realtime 或 Batch 事件。

| pi hook | → Realtime | → Batch |
|---------|-----------|---------|
| `turn_start` | `turn.started` | |
| `message_start` | `message.started` | |
| `message_update` | `message.delta`（blockType + text） | |
| `message_end` | `message.ended` | `message.record`（完整 content） |
| `tool_execution_start` | `tool.started` | |
| `tool_call` | | （input 暂存到 state） |
| `tool_result` | `tool.result` | （result 暂存到 state） |
| `tool_execution_end` | `tool.ended` | `tool.record`（完整 input + result） |
| `turn_end` | `turn.ended` | `turn.record` |
| `agent_start` | | （初始化 agent state） |
| `agent_end` | | `agent.run`（输入、统计、eventIds） |

**Producer 维护的极简状态**：

```
currentAgentRun {
  startedAt, turnCount, messageCount, toolCount, errorCount
  pendingTool: { toolCallId → { toolName, startedAt, input, resultContent, isError } }
  eventIds: []   // 按顺序记录发出的 batch event id
}
```

## 6. 两种事件的内容关系

同一件事，两种表达：

| 内容 | Realtime | Batch |
|------|----------|-------|
| 用户输入 | （不单独发） | `message.record`，`role: "user"` |
| 模型思考 | `message.delta(blockType: "thinking")` × N | `message.record` 里的 `{ type: "thinking", thinking: "..." }` |
| 模型输出 | `message.delta(blockType: "text")` × N | `message.record` 里的 `{ type: "text", text: "..." }` |
| 工具调用 | `tool.started` → `tool.result` → `tool.ended` | `tool.record`（完整 input + result） |
| 轮次 | `turn.started` → `turn.ended` | `turn.record`（turnIndex + duration） |

**Realtime 是"正在发生"的流，Batch 是"发生完了"的完整块。数据源是同一个 pi hook，Producer 在不同时机发出。**

## 7. Consumer 扩展

Consumer 插件化，所有新输出方式都通过 Consumer 接入：

```ts
interface TraceConsumer {
  name: string;
  filter?: { kinds?: ("realtime" | "batch")[] };
  consume(event: TraceEvent): void;
}
```

候选 Consumer：

| Consumer | kind | 用途 |
|----------|------|------|
| 网页渲染 | realtime | 流式渲染 |
| 文档生成 | batch | Markdown / 飞书文档 |
| JSONL 落盘 | both | 完整记录，可回放 |
| SQLite 存储 | batch | 结构化存储 |

**Producer 和事件模型不变，Consumer 只是事件的接收方。**
