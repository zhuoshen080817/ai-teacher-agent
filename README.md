# 课堂录音智能整理 Agent 工作台

面向课堂录音的智能整理工具：上传一段课堂录音，系统自动完成**语音识别（ASR）**，再由大模型提炼为**结构化 Markdown 知识框架**，并支持历史任务回看。

项目采用前后端分离架构，当前已完成「上传 → 异步处理 → 结果展示 → 历史记录」的完整闭环。

## 核心功能

- 拖拽 / 点击多选上传音频，支持 `mp3`、`wav`、`m4a`，单文件最大 1.5GB，上传过程显示真实进度
- 无需填写课程名称，后端根据 PPT 或录音转写自动识别科目，并动态生成对应学科的复习笔记
- 可选上传 `.pptx` 课件，自动提取 PPT 大纲并作为上下文辅助理解录音中的代词与知识点
- 多个音频合并为一个任务，依次完成转码、切片、ASR，最后生成一份完整复习笔记
- 后端异步处理：上传立即返回任务 ID，处理过程不阻塞页面
- 阿里云百炼 DashScope `paraformer-realtime-v2` 完成真实语音识别
- 通过 `subprocess` 调用 `backend/bin/ffmpeg.exe`，一步完成转码（16kHz / 单声道 / 16bit）与 5 分钟切片
- DeepSeek `deepseek-chat` 生成层级化 Markdown 知识框架
- 前端每 2 秒轮询任务状态，实时展示真实进度条、百分比与当前处理阶段
- 左右分栏智能工作台：左侧 AI 对话助手，右侧上传、进度与笔记工作区
- 右侧为动态板书画布：Mermaid 图表 / 高亮代码块 / 大字要点，按分镜切换并高亮当前内容
- 顶部「加载测试数据（免上传）」通过 `/api/mock_task` 直接载入固定分镜，方便快速测试直播间、打断与语速
- 接入阿里云百炼 CosyVoice 真实 TTS（`POST /api/tts`），前端使用 `Audio` 播放；左侧聊天回答会自动语音播报并显示「老师正在语音解答…」小喇叭
- 语速通过后端 CosyVoice 原生 `speech_rate` 合成（慢速 0.8x / 正常 1.0x / 快速 1.2x），不使用 `audio.playbackRate`，音质不失真
- 全局「李老师」人设：所有 DeepSeek 请求共享一套金牌讲师 System Prompt（耐心鼓励、幽默、爱打比方、严禁重复开场白），回复不再像读说明书
- 举手打断升级为右下角常驻按钮：立即停止所有 TTS，语音或文字提问后先做意图识别——「去上厕所 / 等我一下」进入等待，知识性问题正常解答，说「讲慢点 / 讲快点」会在回应后自动切换语速继续
- 语速按钮是双向开关：默认【老师讲慢点】切到原生 0.8x 后立即变为【讲快点吧老师】，再点一下恢复 1.0x；每次切换都会用新语速重播当前这一句
- 直播间所有现场反馈都由大模型即时生成：答题表扬 / 安慰 / 调侃、举手问候、继续确认，均走 `/api/quiz_feedback`、`/api/teacher_cue`、`/api/ask_teacher`，前端只保留状态旁白与兜底文案
- 启发式「步步为营」教学：每段先出题 / 给板书，再按 `step_by_step` 一步步推导，每步停下等待【听懂了，下一步】或【没听懂，再讲讲】
- 每个分镜讲完弹出「随堂小测」：4 选项作答，答对可选【我真懂了】/【我是蒙的】，答错直接耐心讲解，解析由 TTS 播报后再进入下一段
- 「生成讲解视频」为预留能力（类似 Seedance），当前灰置未启用
- 结果支持一键复制、Markdown 排版与历史任务回看
- 完善的错误提示：文件格式、大小、上传、ASR、LLM 调用失败均有明确反馈
- 前端 ErrorBoundary 防止意外渲染异常导致白屏

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | React 19、Vite 8、TypeScript、Tailwind CSS v4、react-markdown + remark-gfm + remark-math + rehype-katex |
| 后端 | Python 3.13、FastAPI、Uvicorn |
| 数据库 | SQLite + SQLAlchemy 2.x |
| 语音识别 | 阿里云百炼 DashScope `paraformer-realtime-v2` + ffmpeg 转码切片 |
| 语音合成 | 阿里云百炼 DashScope CosyVoice `cosyvoice-v3-flash` / `longanhuan_v3` |
| PPT 解析 | python-pptx（提取文本框、表格与备注） |
| 大模型 | DeepSeek `deepseek-chat` |
| 文档 / 架构 | Markdown、Mermaid |

## 目录结构

```text
.
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── __init__.py          # 路由汇总
│   │   │   └── routes/
│   │   │       ├── health.py        # GET /api/health
│   │   │       ├── upload.py        # POST /api/upload
│   │   │       └── task.py          # 任务详情 / 历史列表
│   │   ├── models/
│   │   │   ├── app_meta.py
│   │   │   └── task.py              # Task 表：文件名、路径、状态、结果
│   │   ├── services/
│   │   │   ├── audio_processing.py  # ffmpeg + ASR + DeepSeek 处理逻辑
│   │   │   └── ppt_parser.py        # PPTX 文本提取
│   │   ├── config.py                # 配置、CORS、上传目录
│   │   ├── database.py              # engine / SessionLocal / get_db
│   │   ├── main.py                  # FastAPI 入口、异常处理
│   │   └── uploads/                 # 音频存储目录（内容不入库）
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ErrorBoundary.tsx    # 全局异常兜底
│   │   │   └── MarkdownView.tsx     # 轻量 Markdown 渲染
│   │   ├── App.tsx                  # 上传、轮询、结果、历史
│   │   ├── index.css
│   │   └── main.tsx
│   ├── .env.example
│   └── package.json
├── docs/
│   ├── system-architecture.md       # 系统架构图（Mermaid）
│   └── task-state-machine.md        # 任务状态流转图（Mermaid）
├── dsh-integration/                 # DSH 插件：把后端封装为 Agent 工具
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── index.js                     # analyze_lecture_audio / ask_ai_teacher
│   ├── lib/backend.js               # FastAPI 适配层
│   └── README.md                    # 加载到 DSH Workspace 的步骤
├── DESIGN.md                        # 架构设计与 DSH Agent Loop 规划
└── README.md
```

## 环境要求

- Windows 10/11（PowerShell）
- Python 3.11+（开发验证版本 3.13）
- Node.js 20+（开发验证版本 24）
- **ffmpeg.exe**（用于音频转码与切片）
- 可访问 DeepSeek 与阿里云百炼的网络环境
- 两个平台的有效 API Key

### ffmpeg 放置方式（任选其一）

1. **推荐**：把 `ffmpeg.exe` 放到 `backend/bin/ffmpeg.exe`，无需配置环境变量，也不需要 `ffprobe`。
2. 或安装 ffmpeg 并加入系统 PATH：

```powershell
winget install --id Gyan.FFmpeg -e
# 或使用 Chocolatey
choco install ffmpeg
```

验证（项目内置方式）：

```powershell
cd C:\Users\zhuoshen\Documents\Trae-CN\temp_20261104_01\backend
.\bin\ffmpeg.exe -version
```

> 后端通过 `subprocess` 直接调用 ffmpeg 的 `segment` 复用器，不使用 pydub，因此不依赖 ffprobe。找不到 ffmpeg 时任务会 `failed` 并提示应放置的路径。

## 快速开始

### 1. 配置后端环境变量

```powershell
cd C:\Users\zhuoshen\Documents\Trae-CN\temp_20261104_01\backend
Copy-Item .env.example .env
notepad .env
```

填写：

```dotenv
DEEPSEEK_API_KEY=sk-你的DeepSeek密钥
DASHSCOPE_API_KEY=sk-你的阿里云百炼密钥
```

> `.env` 已被 `.gitignore` 忽略，请勿提交到版本库。

### 2. 启动后端（8080 端口）

```powershell
cd C:\Users\zhuoshen\Documents\Trae-CN\temp_20261104_01\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

若 PowerShell 禁止执行激活脚本，可改用：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

或直接使用虚拟环境内的解释器：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8080
```

启动后可访问：

- 健康检查：<http://127.0.0.1:8080/api/health>
- 接口文档：<http://127.0.0.1:8080/docs>

### 3. 启动前端（5173 端口）

```powershell
cd C:\Users\zhuoshen\Documents\Trae-CN\temp_20261104_01\frontend
npm install
npm run dev
```

打开 <http://localhost:5173> 即可使用工作台。

### 4. 前端自定义后端地址（可选）

前端默认请求 `http://127.0.0.1:8080`。如需修改，在 `frontend/.env` 中写入：

```dotenv
VITE_API_BASE_URL=http://127.0.0.1:8080
```

修改后需重启 Vite。后端 CORS 默认只允许 `http://localhost:5173` 与 `http://127.0.0.1:5173`，若前端换端口，请同步修改 `backend/app/config.py` 的 `CORS_ORIGINS`。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回 `{"status":"ok"}` |
| POST | `/api/upload_ppt` | 上传 `.pptx`，提取文字并创建任务，返回 `task_id` |
| POST | `/api/upload` | 上传一个或多个音频，字段 `files`、可选 `subject`、可选 `task_id`，返回合并任务 |
| POST | `/api/chat` | 智能助手对话；接收 `message`、`subject`、可选 `note_context`，返回 `reply` |
| POST | `/api/ask_teacher` | 举手打断答疑；接收 `user_question`、`context`、`subject`，返回 `intent`（`pause` / `slow_down` / `question`）与现场生成的口语 `answer` |
| POST | `/api/explain_again` | 没听懂重讲；接收 `board_content`、`step_speech`、`subject`，返回换过比喻的 `explanation` |
| POST | `/api/quiz_feedback` | 随堂小测反馈；接收题目、选项、正确答案、学生选择与 `kind`（`correct` / `wrong` / `guess`），返回即兴点评 `reply` |
| POST | `/api/teacher_cue` | 现场串场语；接收 `event`（`interrupt` / `resume`）、`context`、`subject`，返回每次不同的短句 `text` |
| POST | `/api/tts` | CosyVoice 语音合成，接收 `text`、可选 `voice`、可选 `speed`（0.5~2.0，映射为原生 `speech_rate`），返回 `audio/wav` 音频流 |
| GET | `/api/tts/info` | 返回当前 TTS 模型、音色与显示名 |
| GET | `/api/mock_task` | 免上传测试数据，直接返回 `mock_data.json` 且状态为 `completed` |
| GET | `/api/task/{task_id}` | 查询单个任务，包含 `status`、`progress`、`status_message`、`result` 与 `storyboard` |
| GET | `/api/tasks?limit=20` | 按时间倒序返回最近任务，供历史记录使用 |

提交顺序：

```text
可选：POST /api/upload_ppt（返回 task_id）
  → POST /api/upload（files + 可选 task_id）
  → 后端自动识别科目并异步处理
```

上传成功响应示例：

```json
{
  "task_id": 7,
  "filename": "lecture.mp3 等 2 个文件",
  "status": "pending",
  "file_count": 2
}
```

任务完成响应示例：

```json
{
  "task_id": 7,
  "filename": "lecture.mp3 等 2 个文件",
  "status": "completed",
  "result": "# 微积分核心概念\n\n## 一、导数\n- ..."
}
```

## 处理流程

```text
可选：上传 .pptx，python-pptx 提取文字并创建任务，返回 task_id
  → 上传一个或多个音频（files + 可选 task_id）
  → 逐个校验格式与大小
  → 时间戳 + 序号重命名并保存到 app/uploads
  → 写入/更新单条 Task(status=pending)，保存 filepaths、ppt_context
  → 立即返回 task_id
  → BackgroundTasks 执行合并处理
       → 依次处理每个音频：subprocess 调用 ffmpeg.exe 转码并切片
       → 输出 16kHz / 单声道 / 16bit 的 chunk_000.wav、chunk_001.wav ...
       → ThreadPoolExecutor 并发（默认 4）调用 paraformer-realtime-v2
       → 单个音频/切片失败时记录日志并跳过
       → 按上传顺序拼接为 final_transcribed_text
       → DeepSeek 自动识别课程科目
       → 按 subject + ppt_context + 录音文本动态拼接 Prompt
       → DeepSeek 一次性生成 Markdown 学科复习笔记
       → DeepSeek 生成「讲概念 → 出例题 → 分步推导」分镜脚本
       → 写入 Task.status/result
  → 前端每 2 秒轮询任务状态
  → completed 展示结果；failed 展示红色错误
```

详细设计见 [DESIGN.md](./DESIGN.md)，图示见 [docs/system-architecture.md](./docs/system-architecture.md) 与 [docs/task-state-machine.md](./docs/task-state-machine.md)。

## 已知限制

- 课程名称由后端自动识别（PPT 优先，其次录音转写），失败时回退为「通用课程」；不同学科会生成不同口吻与结构侧重的笔记。
- PPT 仅支持 `.pptx`，只提取文本框、表格与备注中的文字，不解析图片内容。
- PPT 上传会先创建一条 `pending` 任务；若之后未继续上传音频，该任务会停留在历史列表中。
- 一次可上传多个音频，后端只创建一条 Task 记录，按上传顺序合并处理与结果。
- 单个音频或切片识别失败会被跳过并记录日志；只有所有音频都无有效文本时才判定任务失败。
- ASR 并发数由 `ASR_MAX_WORKERS` 控制，默认 4；过高可能触发 DashScope 限流。
- 大于 500MB 的非 MP3 文件会提示先转 MP3，因为 WAV / M4A 解码与切片更慢。
- 长音频由 ffmpeg 按 5 分钟切片；切片保存在临时目录，任务结束后自动清理。
- 后端不使用 pydub，也不需要 ffprobe；只需 `backend/bin/ffmpeg.exe`（或 PATH 中的 ffmpeg）。
- 后台任务使用 FastAPI `BackgroundTasks`，服务重启会中断正在处理的任务，任务状态可能停留在 `pending`。
- 直播讲解使用 CosyVoice 真实合成，依赖 `DASHSCOPE_API_KEY` 与对应音色权限；模型与音色在代码中固定为 `cosyvoice-v3-flash` / `longanhuan_v3`，请求里传入其他音色会被忽略。
- 服务不会再回退到 `cosyvoice-v2` / `longxiaochun_v2`，避免模型与音色不匹配触发 418。
- 合成前会经 `clean_text_for_tts()` 清洗：剔除 `$$...$$` / `$...$` LaTeX、代码块、Markdown 标记，并丢弃纯 `--`、纯符号和清洗后无文字的行；如果清洗后为空或极短，后端返回 `204`，前端直接显示文字、不再调用 TTS，避免 418 中断课堂。
- 前端使用 react-markdown + remark-gfm + remark-math + rehype-katex 渲染正文与板书，`$...$` / `$$...$$` 会显示为数学公式，GFM 表格会渲染为真正的 HTML 表格。
- 举手打断依赖浏览器 `webkitSpeechRecognition`，需在 `localhost` 或 HTTPS 环境运行并允许麦克风权限，Chrome / Edge 体验最佳。
- 「生成讲解视频」按钮为 Seedance 类接口预留位，当前禁用。
- 当前无用户体系与鉴权，适合本地开发与课程演示，不建议直接暴露到公网。
- SQLite 适合单机演示；多实例部署需改用 PostgreSQL 等数据库。
- 历史记录接口保留最近任务，默认 20 条，可通过 `limit` 调整（最大 100）。

## 故障排查

| 现象 | 排查方向 |
|---|---|
| 页面提示「后端服务连接失败」 | 确认后端已启动在 8080，且前端 API 基址一致 |
| 浏览器控制台出现 CORS 错误 | 检查 `backend/app/config.py` 中 `CORS_ORIGINS` 是否包含当前前端地址 |
| 任务状态为 `failed` | 查看红色错误详情，并在后端日志中检索 `[AUDIO]` / `[ASR]` / `[TASK` / `处理失败` |
| 大文件上传返回 413 | 后端默认单文件上限 1.5GB，可用 `MAX_UPLOAD_SIZE_MB` 调整；若经过 Nginx，需同步设置 `client_max_body_size` |
| 提示「未找到 ffmpeg.exe」 | 将 ffmpeg.exe 放到 `backend/bin/ffmpeg.exe`，或把 ffmpeg 加入 PATH 后重启后端 |
| 修改 `.env` 后未生效 | `dotenv` 在启动时加载，需要重启后端 |
| 端口被占用 | 更换 `--port` 或关闭占用进程，并同步修改前端 API 基址 |

## 文档索引

- [DESIGN.md](./DESIGN.md) — 架构选型、技术决策与 DSH Agent Loop 演进方案
- [dsh-integration/README.md](./dsh-integration/README.md) — DSH 插件安装与工具调用说明
- [docs/system-architecture.md](./docs/system-architecture.md) — 系统架构图
- [docs/task-state-machine.md](./docs/task-state-machine.md) — 任务状态流转图
