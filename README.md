# Lazy — 产品总监 Agent

本机运行的 AI 产品总监。定位是**产品经理的思考搭档**，不是 coding agent，也不是执行器。

- 服务端：Node.js + TypeScript
- 前端：React + Vite（`assistant-ui`）
- 模型：DeepSeek V4.1 Flash / V4 Pro、Claude Fable 5.1 / Opus 5、GPT-6。每个会话由第一条消息锁定模型；.env 里有哪家的 Key，哪家的模型就可选
- 交互入口：浏览器 `http://127.0.0.1:7878`

## 快速开始

```bash
cp .env.example .env      # 填入 DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY，至少一个
```

macOS 双击 `打开 Lazy.command`；Windows 双击 `start-web.bat`。Windows 若弹出防火墙提示，只需允许“专用网络”；服务仅监听本机 `127.0.0.1`。

启动器会自动在项目内下载专用 Node.js（落到 `.lazy-runtime/`）、按 `package-lock.json` 安装依赖、构建前端并打开浏览器。**不依赖全局 Node 环境**，也不会污染系统。

首次启动需要联网下载 Node.js 与 npm 依赖，时间取决于网络；之后双击会复用已有环境，只在 lockfile 或前端源码变化时重新安装/构建。运行窗口需保持开启，关闭窗口或按 `Ctrl+C` 即停止；也可运行 `stop-web.bat`。

## 目录结构

```
src/
  core/          Agent 循环、上下文组装、会话、语义索引、权限
  model/         DeepSeek / Claude / OpenAI provider、模型目录、消息映射、本地 embedding（BGE-small-zh）
  tools/         内置只读工具
  skills/        Skill 加载（渐进披露：先注入名称+简介，用时才读全文）
  permissions/   权限判定
  dev/           验证脚本（verify:*，均不消耗 API）
  web/           HTTP/SSE 服务端 + React 客户端

workspace/
  DIRECTOR.md    Agent 人设与行为准则，逐字进入系统上下文
  settings.json  模型选择、推理强度、权限
  memory/        长期记忆。MEMORY.md 是入口，正文按需 read
  skills/        5 个 Skill（kk-skill、critical-review、problem-framing、
                 project-progress、project-retrospective）
  projects/
    <项目>/
      files/     对话上传的原件及 PDF 本地解析结果
      sessions/  当前项目的会话记录；每个新会话默认空白
  .runtime/      附件、索引、进度与嵌入模型缓存
```

## 工作区

代码和工作区在同一个目录下，职责不同：`src/` 是程序，`workspace/` 是使用者本人的内容——人设、长期记忆、能力包、项目资料和会话。

目录与 `settings.json` 由 `ensureWorkspace()` 在首次运行时创建，无需手动准备。`DIRECTOR.md` 是使用者自己写的，缺失时按空处理。

设置 `PRODUCT_DIRECTOR_WORKSPACE` 指向任意绝对路径即可换一个工作区；不设置时默认用同目录下的 `workspace/`。

## 架构要点

参照 Claude Code 的方法论，核心是四件事：

**1. 上下文工程。** 逼近容量的 90% 才压缩；压缩前先只裁旧的工具结果以保住对话原文；压缩后有防抖，不会把刚生成的摘要反复重压。assistant 的工具调用与 tool result 严格成对，不会串。

**2. 对话优先。** 图片、PDF、Markdown 和 TXT 直接随消息上传。附件按消息标成“图1 / 文件1”，同一消息内输入 `@` 即可引用；即使不写 `@`，本轮上传的附件也都会发送给模型。

**3. Project 管存储，Session 管上下文。** Project 的 `files` 被动保存原件并按内容去重；新 Session 不会自动加载旧附件。对话分支共享分叉点之前的文件引用，不复制原件。

**4. PDF 本地预处理。** PDF 在本机抽取全文并渲染页面图，结果与原件放在同一个文件目录；不依赖外部 PDF 软件，也不会因此调用模型 API。

## 开发约定

```bash
npm run typecheck         # 服务端 + 前端类型检查
npm run build             # tsc + vite build
npm run verify:tools      # 工具契约
npm run verify:session    # 会话持久化、压缩、停止/续接
npm run verify:projects   # 项目切换
npm run verify:attachments # 附件去重、标签、PDF 本地处理
npm run verify:streaming  # 流式回答
npm run verify:semantic   # 语义检索（会加载本地 BGE 模型，不调 API）
npm run verify:codeblock  # 代码块预览判定
npm run smoke:permissions # 权限
npm run verify:vision     # 使用 mock 验证多模态消息，不调用真实 API
```

**改动后至少跑 `typecheck` + `build` + 相关 verify。** 验证脚本使用本地文件与 mock provider，不调用真实 DeepSeek API。

### 边界（重要）

- **不要引入 todo / plan / 任务清单机制。** 那是 coding agent 的需求，与"思考搭档"定位冲突。历史上的 `working-set` 便签已被移除。
- **工具保持只读。** 新增工具前先确认是否真的需要写入能力。
- `DIRECTOR.md` 与 Skills 负责 Agent 的长期行为；业务上下文优先通过当轮对话和附件提供。

## 不纳入版本控制的内容

`.env`（密钥）、`node_modules/`、`dist/`、`src/web/static/`（前端构建产物，首次启动自动生成）、`.lazy-runtime/`（机器专属 Node 与日志）、`workspace/.runtime/`（索引、进度与模型缓存）、`workspace/memory/用户偏好.md`（个人偏好），以及 `workspace/projects/` 下的会话和附件。

这些都是可再生的、机器绑定的，或属于个人隐私数据。克隆后首次启动会自动重建。
