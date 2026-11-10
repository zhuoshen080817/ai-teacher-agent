# DSH 插件：课堂录音智能整理 / AI 私教

把本项目现有的 FastAPI 后端封装成 **DeepSeek Harness（DSH）** 的 Agent 工具。插件本身不含业务逻辑，只做「DSH Tool → 后端 HTTP 接口」的适配，前后端代码无需改动。

## 提供的工具

| 工具名 | 作用 | 对应后端接口 |
|---|---|---|
| `analyze_lecture_audio` | 上传课堂录音（可选 PPT），轮询任务直到完成，返回 Markdown 复习笔记 | `POST /api/upload_ppt` → `POST /api/upload` → `GET /api/task/{id}` |
| `ask_ai_teacher` | 把学生问题与课堂上下文交给 AI 私教，返回老师的解答 | `POST /api/chat` |

## 目录结构

```
dsh-integration/
├── package.json        # DSH bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml    # 插件装配层：向 profile 插入 lecture-agent
├── index.js            # DSH 插件入口：defineTool 注册两个工具
├── lib/
│   └── backend.js      # FastAPI 适配层（上传 / 轮询 / 对话）
└── README.md
```

纯 ESM JavaScript，无构建步骤，Node `>=22.19.0`（DSH 自身要求）。

## 前置条件

1. 已安装 DSH（Developer Preview），并至少成功启动过一次 Web UI：

   ```powershell
   npx @deepseek-ai/dsh web
   ```

2. 本项目后端已启动（默认 `http://127.0.0.1:8080`）：

   ```powershell
   cd backend
   .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8080
   ```

3. `backend/.env` 中已配置 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY`（ASR / LLM / TTS 需要）。

## 安装到 DSH Workspace

DSH 的插件通过 **bundle** 安装进某个 profile。在**项目根目录**执行：

```powershell
# 安装到 web profile（本地路径安装，不会发布到 npm）
dsh plugin --profile web add ./dsh-integration

# 确认插件层已生效（输出中应出现 lecture-agent / dsh-lecture-agent）
dsh --profile web --dump-config
```

如果使用源码方式运行 DSH，把上面的 `dsh` 换成 `pnpm dsh`，并在 DSH 仓库根目录执行，路径写本插件的绝对路径。

启动 Web UI（`dsh web` 等价于 `dsh --profile web`）：

```powershell
dsh web
```

打开 `http://127.0.0.1:3080`，选择包含本项目的工作区，即可在对话中让 Agent 调用这两个工具。

### 开发调试：用 --patch 临时加载

不想安装 bundle 时，可以写一个 overlay 直接引用入口文件（路径必须是绝对路径）：

```yaml
# dsh-integration/dev.patch.yml
- insert:
    - id: lecture-agent-dev
      name: 'C:/Users/you/path/to/dsh-integration/index.js'
```

```powershell
dsh web --patch ./dsh-integration/dev.patch.yml
```

## 配置后端地址

插件默认请求 `http://127.0.0.1:8080`，可通过环境变量覆盖：

```powershell
# PowerShell
$env:LECTURE_API_BASE_URL = "http://127.0.0.1:8080"
dsh web
```

```bash
# Bash
export LECTURE_API_BASE_URL=http://127.0.0.1:8080
```

环境变量在每次工具调用时读取，修改后无需重装插件（需重启 DSH 进程以继承新的环境变量）。

## 使用示例

在 DSH 对话中直接描述任务即可，Agent 会自动选择工具：

- 整理录音：

  > 用 analyze_lecture_audio 帮我整理 `D:\recordings\lecture-01.m4a`，
  > 配套 PPT 在 `D:\slides\chapter3.pptx`，课程是数据结构。

- 只传音频（科目由后端自动识别）：

  > 用 analyze_lecture_audio 整理 `D:\recordings\lecture-01.m4a`。

- 向老师提问：

  > 用 ask_ai_teacher 回答：快速排序为什么要随机选基准值？
  > context 是「正在讲分区过程，基准值选最后一个元素」。

### 参数说明

`analyze_lecture_audio`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `audio_path` | string | 是 | 本地音频路径，支持 `.mp3` / `.wav` / `.m4a`，绝对路径或相对 DSH 工作目录 |
| `ppt_path` | string | 否 | `.pptx` 课件路径，用于代词消解与笔记质量 |
| `subject` | string | 否 | 课程名；不传时由后端自动识别 |
| `timeout_seconds` | number | 否 | 等待上限，默认 1800，范围 60–7200 |

返回值是一个结构化对象（`task_id` / `subject` / `filename` / `note_markdown` / `storyboard_segments` / 文件路径），模型看到的是渲染后的 Markdown 笔记 + 任务信息。

`ask_ai_teacher`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `question` | string | 是 | 学生问题 |
| `context` | string | 否 | 当前课堂上下文（老师正在讲的这一步） |
| `note_context` | string | 否 | 当前复习笔记 Markdown |
| `subject` | string | 否 | 课程名，默认「通用课程」 |

## 工作流程

```text
DSH Agent
  └─ analyze_lecture_audio
       ├─ 校验本地文件（存在性 / 扩展名 / 1.5GB 上限）
       ├─ 有 PPT → POST /api/upload_ppt  → ppt_task_id
       ├─ 上传音频 → POST /api/upload    → task_id
       ├─ 每 2s 轮询 GET /api/task/{id} 直到 completed / failed
       └─ 返回 task.result（Markdown 笔记）+ 分镜数量
```

`ask_ai_teacher` 会把 `context` 拼进消息（标记为「当前课堂上下文」），把 `note_context` 作为 `note_context` 字段传给 `/api/chat`。

## 已知限制

- **同机运行**：插件传的是本地文件路径，DSH、后端与音频文件必须在同一台机器（或可访问同一挂载盘）。
- **单文件**：一次只处理一个音频；多段录音请先合并，或分多次调用。
- **阻塞等待**：工具会一直等到任务结束；1 小时录音通常需要数分钟。取消 DSH 调用会中止 HTTP 请求与轮询，但后端任务可能继续运行，可用返回/日志中的 `task_id` 查询。
- **无鉴权**：后端当前没有登录与鉴权，仅建议在本机或可信内网使用。
- **上传上限**：单文件 1.5GB，与后端 `MAX_UPLOAD_SIZE_MB` 保持一致。

## 常见问题

| 现象 | 排查 |
|---|---|
| `Cannot find package '@deepseek-ai/dsh-tools'` | 插件需要作为 bundle 被 DSH 加载；不要单独 `npm install` 后直接 `node index.js` |
| `ECONNREFUSED 127.0.0.1:8080` | 后端未启动，或 `LECTURE_API_BASE_URL` 配错 |
| `任务 #N 处理失败：...` | 查看后端日志与 `backend/.env` 中的 ASR / LLM Key |
| 工具列表里没有这两个工具 | 执行 `dsh --profile web --dump-config` 确认 layer；重启 DSH |
| 路径含空格 | 在提示词中用引号包裹完整路径 |

## 卸载

```powershell
dsh plugin --profile web remove dsh-lecture-agent
```

## 参考

- DSH 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 插件开发文档：`docs/user/develop/basic/index.md`、`docs/user/develop/basic/tool.md`
- 本项目的后端接口说明：根目录 [README.md](../README.md)
