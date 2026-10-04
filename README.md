# dsh-gpt-agent-preset

为 **OpenAI GPT-6 系列**（`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-6.1-sol`）在
[DeepSeek Harness](https://github.com/Starlight-bananice/awesome-dsh-plugin) 下调优的 Agent 预设。

An Agent preset for DeepSeek Harness, tuned for the OpenAI GPT-6 family.

> **实验性。** 阈值是实测得出的起始点，不是定论。如果你发现它误伤了正常流程，
> 下面的[配置与调参](#配置与调参)都是一行就能改的。

## 它做什么

Harness 自带的标准预设是为 DeepSeek 的推理模型写的。GPT-6 系列在三个地方和它配合不好：

**重复空转。** 实测：一个会话在 4.5 小时里调了 300 次 `todo_write` + 164 次 `get_goal`，
没有产出任何实现；另一个在 37 步里把两个文件分别重读了 36 次和 35 次，上下文涨到 355K token
直到 provider 中断流。

**工具选择偏差。** 同一批会话里 207 次调用有 171 次是 `bash` —— 连读文件都用 bash ——
而 `read` 只有 12 次。没有任何地方告诉模型哪个工具该干哪种活。

**逐步骤的进度播报。** 每个 step 前先说一句"我会…"。这条同时也是 OpenAI 的 GPT-6 文档写明的
已知行为：它"倾向于详细、结构化的回复"，且在长工具链里会为每一步加一句前言。实测一个会话里
连续五步的开场白互相 68%–80% 相似，内容都是同一份计划的复述。

**以及官方要求补的那一半：** GPT-6"更可能在额外输入会改变结果时向用户提问，
这会导致用户期待它做合理假设并坚持时它却停下"。本预设据此明确授权它去执行。

## 安装

### 关键前提：0.2.x 不再扫描预设目录

**把文件复制到 `~/.dsh/.agent-presets/` 不会有任何效果。** 0.1.x 那样发现预设，
0.2.x 已取消：`@deepseek-ai/dsh-agent-presets` 这个包不存在了，新的 `dsh-agent-preset-registry`
明确"既不扫描目录也不接受预设路径"。预设现在是 **profile 的 bundle patch**。

```bash
git clone https://github.com/Starlight-bananice/dsh-gpt-agent-preset.git
cd dsh-gpt-agent-preset

python3 install-preset.py --dry-run   # 先看会写入什么
python3 install-preset.py             # 写入 desktop profile
```

装完在 **设置 → Agent 预设** 里选「GPT 执行优先」即可（其他 profile 用 `--profile <name>`）。

安装脚本幂等，重跑不会产生第二份。它会把 `!!js` 平台条件解析为**本机**取值、把插件文件的相对
路径改写为绝对路径（profile 补丁没有"预设目录"这个基准），并在写入前先重新解析全文 ——
补丁写坏会让整个应用无法启动，所以解析不过就拒绝写入。

## 它加了什么

三段提示词 + 一层强制。前两段是行为引导，第三层是可强制的。

**persona**（系统提示开头，稳定）

- 用户指令**优先于**任何 skill、`AGENTS.md` 或约定文件；冲突时按用户说的做并说明搁置了哪个
- 明确授权：动作型请求就是授权，做完它，不要停在计划或"要不要我继续"

**运行契约**（每个 agent 注入一次）

| 段 | 内容 |
| --- | --- |
| AUTHORIZATION | 动作型请求即授权；两点例外：用户选的模式限制（**计划模式下只读探索**），以及真正属于用户的决定（改变结果的设计选择、不可逆操作） |
| SILENCE | 不复述请求、不播报"我要去读/搜/跑/验证了"——工具调用本身就看得见。只在有真正新信息时说话：需要用户拍板的决定、阻塞、或答案本身 |
| TOOLS | 明确工具分工，shell 只留给进程、构建、测试、git；优先复用上下文里已有的结果 |
| DONE | 改文件的任务以"落盘并验证"为终点；**审查、诊断、解释在结论成立时即完成**，不要为了完成感去改文件 |
| STYLE | 先给结论；列表/表格只在内容确实并列或需要对比时使用 |

**强制层**（针对"无进展"，不是"限制调用次数"）

| 机制 | 阈值 | 为什么 |
| --- | --- | --- |
| `get_goal` | 每轮 1 次 | 纯重读已有状态，目标就在上下文里 |
| `create_goal` | 每轮 1 次 | 一次会话本质上只有一个目标 |
| **完全相同的** `todo_write` | 拒绝重发 | 列表是模型的工作状态，工具说明要求"完成即标记"；拦的是**重发同一份**，不是更新 |
| 同一 `(路径, 偏移, 上限)` 重读 | 每轮允许 2 次 | 实测循环里 91/129 次调用是重读。**跨轮重置**，且文件被写/编辑后立即释放 |
| 窗口内重复调用 | 同一签名在最近 12 次调用内出现 2 / 4 次 | 实测循环是 `bash → read A → read B` 交替，**连续**检测永远不触发 |

`update_goal` **不在**限额内 —— 同一轮 `resume → complete` 是正常生命周期。

## 配置与调参

全部阈值在 `agent.cordis.yml` 的 `gpt-guardrails.config` 里：

```yaml
- id: gpt-guardrails
  name: ./gpt-guardrails.mjs
  config:
    budgets:
      get_goal: 1
      create_goal: 1
      # 加 todo_write: N 可改成"每轮 N 次"的硬限额
    repeatThresholds: [2, 4]   # 窗口内出现次数；嫌吵可改 [3, 5]
    repeatWindow: 12           # 回看最近多少次调用
    readBudget: 2              # 同一区间每轮可读次数；0 关闭
    injectContract: true       # false 则完全不注入运行契约
```

改完**重跑 `install-preset.py`**（配置热生效）。改 `gpt-guardrails.mjs` 的**代码**需要
**重启应用** —— Node 会缓存模块。

### 上下文压缩阈值

同一文件里的 `compaction-basic` 是**计价设置，不是延迟设置**：

> GPT-6 全系列对输入超过 **272K token** 的请求按 2 倍输入/缓存价、1.5 倍输出价计费，
> 且是**整个请求**。

Sol/Luna 的上下文窗口是 1,050,000，所以本预设用 `thresholdRatio: 0.25`（≈262K）压在加价线之下。

**前提是你的模型声明了 `contextWindow`。** 若 provider 不报窗口，压缩触发点算不出来 ——
对 ChatGPT provider 可以在模型条目里加 `contextWindow: 1050000`，见
[dsh-chatgpt-plugin](https://github.com/Starlight-bananice/dsh-chatgpt-plugin#模型)。

## 验证

```bash
node tests/harness.mjs        # 61 项行为检查（假 Cordis 上下文，不需要应用/会话/模型）
node tests/check-config.mjs   # 每个配置键对 shipped schema 校验（离线，自包含）
```

两个脚本都路径无关、无外部依赖，clone 下来即可运行；CI 每次 push 都会跑。

行为检查覆盖几条**刻意**的语义，改代码时别破坏它们：

- 交错循环（复用实测形状）必须在第 2 轮内触发 —— 旧版连续检测在此为 **0 次**
- 12 次各不相同的调用零误报；把某签名挤出窗口后再发一次也零误报
- `todo_write`：建清单 / 改状态 / 标完成全部放行，只有重发同一份被拒
- **被拒的提交不构成状态** —— 未落盘的重发仍放行，否则一次基于陈旧状态的拒绝会连锁误伤
- `agent/created` **不派发**时，限额与契约注入仍必须生效（第一版正是死在这里）
- 契约必须抑制逐步骤播报，且授权段不再要求"用一行说出计划"

## 排障

**预设不出现在设置页** —— 确认它真的在 profile 补丁里：

```bash
grep -c preset-gpt ~/.dsh/profiles/desktop/cordis.patch.yml   # 应为 1
```

为 0 说明脚本没跑成功。

**预设出现了但拦截不起作用** —— 插件每次激活会往 `~/.dsh/gpt-guardrails-activations.log`
写一行，并在**每次拒绝**时记录工具名与原因：

- 文件为空 → 插件的 `apply()` 从未执行，多半是没重启应用
- 有 `activated` 但没有 `DENIED` → 拦截没触发（阈值未达到，或代码未重新加载）

**模型报 `STREAM_ERROR` 且无细节** —— 与预设无关。该错误来自上游发来一个不带 `code`/`message`
的 `error` 事件；实测与推理档位、模型组合有关，换一档再试通常可恢复。

**模型话太多或太少** —— `SILENCE` 段控制逐步骤播报。想让它多说，把 `injectContract` 设为
`false` 会移除整个契约（含授权与工具分工）；或者直接改 `gpt-guardrails.mjs` 里 `CONTRACT`
的措辞，然后重启。

## 已知限制

- **仍在实测调参**，阈值可能误伤正常流程
- 强制层是**可见性/引导**，不是安全边界：拒绝是一次普通工具调用结果，模型可以读
- 只在 macOS 桌面版 + `chatgpt` provider 上验证过
- `agent.cordis.yml` 里的 `!!js` 平台条件在**安装时**解析为本机取值，
  因此生成的 profile 补丁不可跨平台直接复制
- **不主张**官方预设与 GPT-6"天生冲突"。日志能证实的只有"确实存在这种形状的空转"，
  以及本预设自己的第一版强制层从未激活这两件事

## License

MIT
