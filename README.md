# dsh-gpt-agent-preset

为 **OpenAI GPT-6 系列**（`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-6.1-sol`）在
[DeepSeek Harness](https://github.com/Starlight-bananice/awesome-dsh-plugin) 下调优的 Agent 预设。

An Agent preset for DeepSeek Harness, tuned for the OpenAI GPT-6 family.

> **实验性 / Experimental.** 这个预设仍在实测调参中。它的拦截规则是"识别无进展"，不是"限制调用次数"，
> 但阈值仍可能误伤某些正常流程。请把 [配置项](#配置与调参) 当成起始点而非定论；发现问题欢迎提 issue。

---

## 它解决什么 / What it addresses

两类问题，一类是实测出来的，一类是 OpenAI 文档写明的：

**1. 循环、shell 优先、上下文失控（本仓库实测）**

- 某会话整个 4.5 小时窗口里调了 300 次 `todo_write` + 164 次 `get_goal`，没有产出任何实现
- 另一会话 207 次调用里 171 次是 `bash`（连读文件都用 bash），`read` 只有 12 次、`glob` 7 次
- 第三个会话在 37 步里把两个文件分别重读了 36 次和 35 次，上下文涨到 355K token，
  直到 provider 中断流（`STREAM_ERROR`）

**2. 停下来问、而不是动手（OpenAI 官方文档记载）**

[Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model) 明确指出该系列
"更可能在额外输入会实质性改变结果时向用户提问，这会导致用户期待它做合理假设并坚持时它却停下"，
"默认喜欢在工作过程中提非阻塞问题"，且"skill 文件里含糊或冲突的指引可能让它提早停下并阻塞工作"。

> **本预设不主张**官方预设与 GPT-6 "天生冲突"。实测只支持"日志里确实存在这种形状的空转"和
> "本预设自己的第一版强制层从未激活"这两件事。消息序列化、工具反馈、上下文管理、重复注入
> 都可能是同一批症状的成因。

---

## 安装 / Install

### 关键前提：0.2.x 不再扫描预设目录

DSH **0.1.x** 通过扫描 `<dshHome>/.agent-presets/<id>/agent.cordis.yml` 发现预设。
**0.2.x 取消了这套机制** —— `@deepseek-ai/dsh-agent-presets` 这个包已不存在，
新的 `dsh-agent-preset-registry` 明确"既不扫描目录也不接受预设路径"。
预设现在是 **profile 的 bundle patch**：往 profile 的 `cordis.patch.yml` 里 `insert`
一行 `@deepseek-ai/dsh-agent-preset` 声明。

所以把本仓库的文件复制到 `~/.dsh/.agent-presets/` **不会有任何效果**。

### 安装

```bash
git clone https://github.com/Starlight-bananice/dsh-gpt-agent-preset.git
cd dsh-gpt-agent-preset

python3 install-preset.py --dry-run   # 先看会写入什么
python3 install-preset.py             # 写入 desktop profile
```

脚本做四件事，都是幂等的（重跑不会产生第二份）：

1. 读取 `agent.cordis.yml`，把它转换成一条 `insert` 补丁；
2. 把 `!!js` 平台条件**在本机解析成具体布尔值**（补丁载荷是纯 YAML，带 `!!js` 会导致整份补丁解析失败）；
3. 把 `./gpt-guardrails.mjs` 的相对路径改写为**绝对路径**（profile 补丁没有"预设目录"这个基准）；
4. 覆盖前先备份，写入前先重新解析全文 —— **补丁写坏会让整个应用无法启动**，所以解析不过就拒绝写入。

应用会实时发现这个声明（注册表的发现过程不做记忆化），在 **设置 → Agent 预设** 里即可看到
**GPT 执行优先**。

其他 profile：`python3 install-preset.py --profile <name>`。

---

## 它做什么 / What it does

三个部分，前两个是提示词，第三个是**可强制**的。

### 1. persona（稳定，位于系统提示开头）

- 用户指令**优先于**任何 skill、`AGENTS.md` 或约定文件；冲突时按用户说的做并说明搁置了哪个文件
- 明确授权：请求里带动作含义时，**做完**而不是停在计划、"要不要我继续"或一个查一下就能回答的问题

### 2. 运行契约（每个 agent 注入一次，附在首个 step 的批次后）

- **AUTHORIZATION** —— 动作型请求即授权；两件事覆盖它：用户选择的模式限制（**计划模式下只读探索**），
  以及真正属于用户的决定（改变结果的设计选择、不可逆操作）。其余取合理默认值，不要阻塞
- **TOOLS** —— 明确工具分工（`read`/`glob`/`grep`/`edit`/`write` 各管什么，shell 只留给进程、构建、测试、git）；
  优先复用上下文里已有的结果，**文件已变化或切片已不在上下文时应当重读**
- **DONE** —— 改文件的任务以"落盘并验证"为终点；**审查、诊断、解释在结论成立时即完成**，
  不要为了完成感去改文件；验证与改动成比例
- **STYLE** —— 先给结论；列表/表格只在内容确实并列或需要对比时使用

### 3. 强制层（`gpt-guardrails.mjs`，针对"无进展"而非"调用次数"）

| 机制 | 阈值 | 为什么 |
|---|---|---|
| `get_goal` 每轮限额 | 1 次 | 纯重读已有状态；目标就在上下文里 |
| `create_goal` 每轮限额 | 1 次 | 一次会话本质上只有一个目标 |
| **完全相同的** `todo_write` 清单 | 拒绝重发 | 列表是模型的工作状态，工具说明要求"完成即标记"；拦的是**重发同一份**，不是更新 |
| 同一 `(路径, 偏移, 上限)` 同轮重读 | 允许 2 次 | 实测循环里 91/129 次调用是重读；**跨轮重置**，且文件被写/编辑后立即释放 |
| 窗口内重复调用 | 同一签名在最近 12 次调用内出现 2 / 4 次 | 实测循环是 `bash → read A → read B` 交替，**连续**检测永远不触发 |

`update_goal` **不在**限额内：同一轮 `resume → complete` 是正常生命周期。

---

## 配置与调参

全部阈值在 `agent.cordis.yml` 的 `gpt-guardrails.config` 里：

```yaml
- id: gpt-guardrails
  name: ./gpt-guardrails.mjs
  config:
    budgets:
      get_goal: 1
      create_goal: 1
      # 设 todo_write: N 可重新启用"每轮 N 次"的硬限额（逃生舱）
    repeatThresholds: [2, 4]   # 窗口内出现次数；嫌吵可改 [3, 5]
    repeatWindow: 12           # 回看最近多少次调用
    readBudget: 2              # 同一区间每轮可读次数；0 关闭该限额
    injectContract: true       # 设为 false 则不注入运行契约
```

改完**重跑 `install-preset.py`** 即可（配置热生效）。改 `gpt-guardrails.mjs` 的**代码**
则需要重启应用 —— Node 会缓存模块。

`compaction-basic` 的阈值也在同一文件里，且**这是计价问题不是延迟问题**：

> GPT-6 全系列对**输入超过 272K token** 的请求按 2 倍输入/缓存价、1.5 倍输出价计费，且是**整个请求**。

Sol/Luna 的上下文窗口是 1,050,000，所以 `thresholdRatio: 0.25`（≈262K）是为了压在加价线之下。
**前提是模型声明了 `contextWindow`** —— 若你的 provider 没有声明，压缩阈值算不出来，需先在
provider 的模型配置里补上。

---

## 验证 / Verification

```bash
node tests/harness.mjs        # 53 项行为测试（假 Cordis 上下文，不需要应用/会话/模型）
node tests/check-config.mjs   # 组合里每个配置键对 shipped schema 校验（离线，自包含）
```

两个脚本都路径无关、无外部依赖（配置校验自带 `tests/schemas.json`），clone 下来即可运行。

行为测试覆盖几条**刻意**的语义，改代码时别破坏它们：

- 交错循环（复用实测形状）必须在第 2 轮内触发；旧版连续检测在此为 0 次
- 12 次各不相同的调用零误报；把某签名挤出窗口后再发一次也零误报
- `todo_write`：建清单 / 改状态 / 标完成全部放行，只有重发同一份被拒
- **被拒的提交不构成状态** —— 未落盘的重发仍放行，否则一次基于陈旧状态的拒绝会连锁误伤
- `agent/created` **不派发**时，限额与契约注入仍必须生效（第一版就是死在这里）

---

## 排障 / Troubleshooting

**预设不出现在设置页**
先确认它真的在 profile 补丁里：`grep -c preset-gpt ~/.dsh/profiles/desktop/cordis.patch.yml`
应为 1。为 0 说明脚本没跑成功。

**预设出现了但拦截不起作用**
插件每次激活会往 `~/.dsh/gpt-guardrails-activations.log` 写一行，并在**每次拒绝**时记录
工具名与原因。这个文件为空说明插件的 `apply()` 从未执行（多半是没重启应用）；
有 `activated` 但没有 `DENIED` 说明拦截没触发（阈值未达到，或代码未重新加载）。

**模型报 `STREAM_ERROR` 且无细节**
与预设无关。该错误来自上游发来一个不带 `code`/`message` 的 `error` 事件；
本仓库实测与推理档位、模型组合有关，换一档再试通常可恢复。

---

## 已知限制 / Known limitations

- **仍在实测调参**，阈值可能误伤正常流程
- 强制层是**可见性/引导**，不是安全边界：拒绝是一次普通工具结果，模型可以读
- 只在 macOS 桌面版 + `chatgpt` provider 上验证过
- `agent.cordis.yml` 中的 `!!js` 平台条件在安装时被解析为**本机**取值，
  因此生成出的 profile 补丁不可跨平台直接复制

## License

MIT
