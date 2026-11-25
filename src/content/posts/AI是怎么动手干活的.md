---
title: 'AI 是怎么动手干活的？从 Function Call 到 MCP 全链路拆解'
published: 2026-11-19
tags: [Agent, Function Call, MCP]
category: AI 工程
image: ../../assets/images/music-cover.avif
draft: false
---

# AI 是怎么动手干活的？

大模型只会一件事：输出文字。

它不能读你的文件，不能搜网页，不能发消息，不能跑代码。就是生成一段文本。

但你用的 AI 助手明明能帮你改代码、查天气、发消息。怎么回事？

答案是：有人接住了它输出的文字，把文字变成了动作。这篇文章讲这条链路——从模型「说了一句话」到事情「真的被做了」，中间经过几层，每层干什么。

我用一个开源 AI 工作台（DeepSeek Harness，下称 DSH）的源码做例子，不讲虚构的 `get_weather`。

## 一、一次调用怎么落地

### Function Call：模型发出指令

Function Call 这个名字有误导性。模型并没有真的调了什么函数。它做的事跟写文章一样——生成了一段结构化文本。长这样：

```json
{
  "name": "read",
  "arguments": {
    "file_path": "/home/user/project/notes/todo.md"
  }
}
```

翻译成人话：「我想让你帮我读一下这个文件。」

注意：它只是说了这句话。文件有没有被读、怎么读、读不读得到——跟模型无关。它的工作到输出这段 JSON 就结束了。

**模型怎么知道该说什么？** 你在 API 请求里带了一个 `tools` 数组（看不懂代码没关系，只需注意 `tools` 这个词）：

```json
{
  "model": "your-model-name",
  "messages": [...],
  "tools": [
    {
      "name": "read",
      "description": "读取一个文本文件，返回带行号的内容",
      "parameters": {
        "file_path": { "type": "string", "description": "要读的文件路径" },
        "offset": { "type": "number", "description": "从第几行开始读" }
      }
    }
  ]
}
```

这就是模型的「菜单」。它看到菜单上有 `read`，知道参数怎么填，于是在需要的时候生成对应的 JSON。

`description` 字段是写给模型看的使用说明书。你写得越清楚，它填得越准。餐厅菜单上每道菜后面写着「微辣 / 含花生 / 约 15 分钟」——顾客（模型）看了才知道该点什么、怎么点。

一条典型的会话日志（示意）：

```json
{
  "type": "tool-call",
  "id": "call_a1b2c3d4e5f6",
  "name": "read",
  "arguments": "{\"file_path\":\"/home/user/project/notes/todo.md\"}"
}
```

模型输出了这个。然后它的工作就完了。剩下的事，交给下一层。

### Tool：宿主接住指令

模型说完「我要读文件」，谁来真的读？

宿主程序。就是跑在你电脑上的那个应用（DSH、Cursor、Claude Desktop……）。

DSH 内部维护了一个 Map：

```typescript
// 简化后的核心结构
Map<string, ToolRegistration> {
  "read"  → { definition, execute: 读文件的函数 },
  "write" → { definition, execute: 写文件的函数 },
  "grep"  → { definition, execute: 跑全文搜索的函数 },
  ...
}
```

模型说调 `read`，宿主就做一件事：

```typescript
const tool = toolMap.get("read");   // 查表
const result = tool.execute(args);  // 调函数
```

没了。核心就是查表，一个 `Map.get()`。不需要为每个工具写一套分发逻辑。

找不到？返回 `UNKNOWN_TOOL` 错误给模型，让它换个名字重试。

**工具是怎么进 Map 的？** 每个工具插件启动时，调一次 `register`：

```typescript
ctx.tools.register(defineTool({
  name: 'read',
  description: '读取一个 UTF-8 文本文件...',
  parameters: {
    file_path: { type: 'string', required: true, description: '文件路径' },
    offset:    { type: 'number', description: '起始行号' },
    limit:     { type: 'number', description: '最多读几行' },
  },
  output: { schema: ..., render: ... },
  execute(args, exec) {
    // 真的去读文件
    return fs.readFileSync(args.file_path, 'utf-8');
  }
}));
```

`parameters` 会被转换成标准 JSON Schema 格式（就是「参数格式说明书」的标准写法），随 API 请求发给模型——就是上一节你看到的那个菜单。

`execute` 函数永远不会发给模型。模型只看到 name + description + parameters。执行逻辑是宿主的私事。

**结果怎么回去？** 执行完，宿主把结果包成一条消息塞回对话：

```json
{
  "role": "tool",
  "toolCallId": "call_a1b2c3d4e5f6",
  "content": [{ "type": "text", "text": "1: # TODO\n2: - 买牛奶\n3: ..." }]
}
```

模型看到这条消息，就知道文件内容了，接着往下推理。它可能觉得不够——比如文件里提到另一个文件，于是再发一次 Function Call。这个「说→做→看→再说」的圈转起来，才叫 Agent。

### MCP：手伸到另一个程序里

前面讲的 `read`、`grep` 都是宿主自己进程内的函数。但有些能力不在宿主里——比如搜索网页、查地图。它们在另一个程序里。

问题变成：怎么跨进程调工具？

MCP（Model Context Protocol）是一个标准协议，规定了「跨进程调工具」的消息格式和交互流程。底层就是 JSON-RPC——用 JSON 写远程函数调用的规矩。三种消息：

```json
// 请求：我要调你的方法
{"jsonrpc":"2.0", "id":1, "method":"tools/call", "params":{"name":"search","arguments":{"query":"北京天气"}}}

// 响应：给你结果
{"jsonrpc":"2.0", "id":1, "result":{"content":[{"type":"text","text":"18°C 晴"}]}}

// 通知：告诉你一声，不用回
{"jsonrpc":"2.0", "method":"notifications/tools/list_changed"}
```

打个比方：JSON-RPC 是一张标准格式的工单。上面写着「编号 1 / 请帮我查北京天气 / 参数：城市=北京」。对方干完活，在同一张工单背面写上结果递回来。格式统一，谁都能看懂，不需要事先认识。

**三个角色：**

```
┌─── DSH 主进程 ──────────────────────────────┐
│                                             │
│  Host（整个应用）                            │
│    ├── Client A（搜索服务专用连接器）        │
│    └── Client B（地图服务专用连接器）        │
│                                             │
└──────────┬──────────────────┬───────────────┘
           │ 管道             │ 管道
     ┌─────▼─────┐     ┌─────▼─────┐
     │ search    │     │ map       │
     │ 子进程    │     │ 子进程    │
     └───────────┘     └───────────┘
```

- **Host** = 整个应用进程。管权限、管会话、管模型调用。
- **Client** = Host 内部的一个对象，不是独立程序。是 Host 的「手」，专门负责跟某一个 Server 传话。
- **Server** = 外部独立进程。真正干活的。

用一家公司来类比：
- **Host** = 公司本身。管预算、管权限、决定接什么活。
- **Client** = 公司里的采购员，不是独立公司。是公司内部的人，专门负责跟某一家供应商对接。
- **Server** = 外部供应商。独立经营，真正干活出货的。

一家公司可以有多个采购员，每个对接不同供应商。但对外签合同、付钱、担责的，永远是公司（Host）。

**关键设计：没有路由。** MCP 工具在启动时就被注册进了同一个 Map：

```typescript
// DSH 源码 dsh-mcp-client/src/tools.ts
const publicName = `mcp__${serverName}__${rawName}`;
// 例：mcp__search__web_search

ctx.tools.register({
  name: publicName,
  description: tool.description,
  parameters: tool.inputSchema,
  execute: async (args) => {
    // 内部发 JSON-RPC 到子进程
    return client.callTool({ name: rawName, arguments: args });
  }
});
```

注册完之后，Map 里长这样：

```
"read"                       → execute: 读文件
"grep"                       → execute: 跑全文搜索
"mcp__search__web_search" → execute: 发 JSON-RPC 到 search 进程
```

模型调 `mcp__search__web_search` 时，宿主做的事跟调 `read` 完全一样：`Map.get(name).execute(args)`。不需要判断「这是本地还是远程」。区别只在 execute 内部——一个是读文件，一个是发消息。对模型来说完全一样：它只管说「我要用这个工具」，至于工具在哪、怎么跑，它不知道也不需要知道。

**工具发现：** 启动时 Client 问 Server：「你有哪些工具？」

```json
→ {"method": "tools/list"}
← {"result": {"tools": [
     {"name": "web_search", "description": "搜索网页", "inputSchema": {...}},
     {"name": "extract_page", "description": "提取网页正文", "inputSchema": {...}}
   ]}}
```

Client 拿到列表，逐个注册进 Map。模型就能看到这些工具了。

**两种错误：**

| 协议错误 | 执行错误 |
|---|---|
| 工具不存在、参数格式错 | 工具跑了但业务失败（API 超时、日期不合法） |
| JSON-RPC `error: {code: -32602}` | `result: {isError: true, content: [{text: "日期必须在未来"}]}` |
| 模型难自愈 | 模型能自愈——看到错误信息会改参数重试 |

执行错误故意放在 result 里而不是 error 里，让模型看到并自我修正。

### 消息怎么传：stdio 与 HTTP

MCP 规定了消息格式（JSON-RPC），但没规定消息通过什么管道传。两种标准方式：

**stdio：启动子进程，对着管道喊话。** 每个程序天生有三根管子：stdin 是耳朵（听输入）、stdout 是嘴巴（说结果）、stderr 是悄悄话通道（说日志）。stdio 传输利用这三根管子：

```
DSH 往子进程的 stdin 写一行 JSON → 子进程收到了
子进程往 stdout 写一行 JSON → DSH 读到了
```

规则极简：
- 一行 = 一条完整 JSON 消息，`\n` 分隔
- stdout 只能写协议消息（不能 console.log，否则对面解析炸了）
- 日志走 stderr
- 关 stdin = 通知退出；Server 崩了？重启就行（新版规范下无状态，不怕断）

一个典型的 MCP Server 配置：

```yaml
transport: stdio
command: "node"
args: ["./mcp-servers/search-server.js"]
```

启动时就是启动一个子进程。然后往 stdin 写 JSON、从 stdout 读 JSON。

**Streamable HTTP：往一个网址发请求。** 就是你平时用浏览器提交表单、用 App 刷新数据时背后发生的事——往一个网址发一段数据，等对方回一段数据：

```
POST https://example.com/mcp
Body: {"jsonrpc":"2.0","method":"tools/call","params":{...}}

← 200 application/json（快结果，直接回）
← 200 text/event-stream（慢结果，一边做一边推进度）
```

Server 独立运行，不依赖任何 Client。可以放云上、多人共享。

怎么选？工具跑在本机、跟宿主同生共死 → stdio。工具在远程/云端/多人共享 → Streamable HTTP。业务语义完全一样。换管道不影响消息内容。顺丰换中通，包裹里的东西不变。

**2026 新版的核心变化：** MCP 最新版（2026-07-28）做了一个大改动：从有状态变成无状态。旧版有 `initialize` 握手、有 session、Server 崩了要恢复会话。新版全删了。每条请求自带版本号和能力声明，Server 不需要记住你是谁。

进化方向：越来越像普通的网页接口。可以放云上、多人共用、挂了重启就行，不用恢复什么「会话状态」。需要跨调用记住的事，改由模型拿着编号传回来，Server 本身不存。

## 二、多步任务怎么编排：Skill

前面解决的是「一次调用怎么落地」。但现实中一件事往往需要十几步。每一步都让模型自己想办法，它经常搞砸。Skill 就是写给模型看的操作手册。

比如一个地图查询 skill，核心内容就是一个 markdown：

```markdown
## 什么时候用
用户问「附近有什么」「怎么走」「天气」时触发。

## 怎么用
1. 先调 geocode 接口拿坐标
2. 再调 around 接口搜周边
3. API key 从环境变量 MAP_API_KEY 读取

## 注意
- 坐标格式是 经度,纬度（不是纬度,经度！）
- 免费额度每天 5000 次
```

没有 execute 函数。没有注册进 Map。模型读到这份文档，照着做——调一堆已有的 tool，按顺序来。

跟 Tool/MCP 的关系：

| | Tool / MCP | Skill |
|---|---|---|
| 是什么 | 一个动作 | 一套流程 |
| 谁执行 | 程序 | 模型自己照着做 |
| 有没有代码 | 有 | 没有，就是文字 |
| 类比 | 一个电器（微波炉、洗衣机） | 一份菜谱（教你按顺序用这些电器做一桌菜） |

Skill 不是新工具。它是教模型怎么组合已有工具的说明书——把「老手带新人的经验」写成文档，让模型照着做。

## 三、没有现成工具怎么办：CLI

有些功能没人包成 MCP Server，也没有现成 Tool。但它有个命令行工具。比如 ffmpeg——没有「ffmpeg MCP Server」，但可以在终端敲：

```bash
ffmpeg -i input.mp4 -vf scale=1080:1920 output.mp4
```

模型怎么做？直接用 shell 工具敲命令。跟你自己在终端打命令一模一样。

为什么不全用 CLI？因为 CLI 的输出是一坨纯文本，模型得自己解析。MCP 返回结构化 JSON，字段清清楚楚。

```python
# MCP = 拿到结构化数据，直接用
result = mcp_call("weather", city="北京")
result["temperature"]  # 18，清清楚楚

# CLI = 拿到一坨文字，自己想办法抠
raw = shell("curl wttr.in/北京")
# raw = "北京: ☀️ +18°C 湿度32% 风速..."
# 得自己写规则从这堆文字里把 18 抠出来
```

CLI 万能但粗糙。最后手段，不是首选。

**为什么平台都在出 CLI？** 2025-2026 年，平台密集出 CLI：飞书 CLI、GitHub CLI、Vercel CLI、Supabase CLI、Cloudflare Wrangler……

这不是巧合。CLI 是给 AI agent 修的路。模型最天然的操作方式就是敲命令——输入一行字符串，输出一段文本。不需要安装额外的库，不需要配置连接，打开终端就能用。

但 CLI 不是终态。进化路径：

```
平台先出 CLI（快，成本低，马上能用）
  → 有人把 CLI 包成 MCP Server（加 schema、加结构化输出）
  → 模型从「敲命令猜参数」升级到「看菜单填表单」
```

CLI 是先锋，MCP 是正规军。现在很多 MCP Server 内部就是在调 CLI，外面包了一层结构化壳。

## 四、什么时候用什么

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 宿主自带的能力（读文件、跑命令、搜索代码） | Tool | 最快，零网络开销，进程内直接调 |
| 第三方服务（搜网页、查地图、操作数据库） | MCP | 标准协议，独立进程，可复用可共享 |
| 一件事需要十几步、有固定套路 | Skill | 把经验写成文档，模型照着走不跑偏 |
| 以上都没有，但有个命令行工具 | CLI | 万能兜底，粗糙但能用 |

它们不是互斥的。一个 Skill 里面会调 Tool 和 MCP；一个 MCP Server 内部可能在调 CLI。层次不同，各管各的事。

## 全景图

下面这张图是一次完整干活的过程——从你开口说话，到事情真的被做完：

![AI 干活全流程](/images/ai-agent-flow.png)

另外两个角色不在主线上，但随时参与：

- **Skill**（操作手册）：告诉模型「遇到这类事，按 1→2→3 的顺序调工具」。不是新通道，是指挥模型怎么走上面这条路的说明书。
- **CLI**（兜底）：某个功能既没有 Tool 也没有 MCP Server？模型直接在终端敲命令。万能但粗糙，最后手段。

一句话：FC → Tool → MCP → Transport 是一次调用的纵深，Skill 是多次调用的编排，CLI 是前面都没有时的替代。不是六个并列的东西，是不同维度的解法。

## 写在最后

这条链路不复杂。拆开看每一层都是日常能理解的东西：填表单、查电话簿、寄快递、照着菜谱做菜。难的不是某一层，是把它们串起来的那根线——模型输出文字 → 文字变动作 → 动作结果变文字 → 模型接着想。这个循环跑起来，就是 Agent。

下一篇打算写「大脑」那半边：上下文窗口、Agent Loop、规划与记忆。手知道了怎么动，还得知道脑子怎么指挥。

---

*代码示例基于 DeepSeek Harness 开源实现简化改写，会话日志为脱敏示意。MCP 规范版本 2026-07-28。*