"""音频处理任务：ffmpeg 转码切片 → 分段 ASR → 合并 → DeepSeek 生成知识框架。"""

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import dashscope
from dotenv import load_dotenv
from openai import OpenAI

from app.config import settings
from app.database import SessionLocal
from app.models.task import Task
from app.services.persona import TEACHER_AUTHOR, TEACHER_PROFILE
from app.services.tts_service import clean_text_for_tts

load_dotenv(settings.BASE_DIR / ".env")

logger = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent
# 默认使用 backend/bin/ffmpeg.exe；兼容放在 backend/app/bin 的情况
FFMPEG_CANDIDATES = [
    settings.BASE_DIR / "bin" / "ffmpeg.exe",
    APP_DIR / ".." / "bin" / "ffmpeg.exe",
]

ASR_MODEL = "paraformer-realtime-v2"
TARGET_SAMPLE_RATE = 16000
CHUNK_SECONDS = 5 * 60  # 每段 5 分钟
FFMPEG_TIMEOUT = 30 * 60  # 单个文件转码切片最长 30 分钟
# ASR 并发数：控制在 3-5，兼顾吞吐与 DashScope 限流
ASR_MAX_WORKERS = 4
DEFAULT_SUBJECT = "通用课程"

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"
REQUEST_TIMEOUT = 60.0
STORYBOARD_SEGMENT_LIMIT = 30
STORYBOARD_MIN_CHARS = 3000
STORYBOARD_TARGET_CHARS = (3500, 5000)
STORYBOARD_TIMEOUT = 180.0
STORYBOARD_MAX_TOKENS = 8192
CODE_BLOCK_PATTERN = re.compile(r"```([A-Za-z0-9_+-]*)\n(.*?)```", re.DOTALL)

FFMPEG_MISSING_MESSAGE = (
    "未找到 ffmpeg.exe。请将 ffmpeg.exe 放到 "
    f"{settings.BASE_DIR / 'bin' / 'ffmpeg.exe'}，"
    "或安装 ffmpeg 并加入系统 PATH。"
)


def _update_task_progress(task_id: int, progress: int, message: str) -> None:
    """把当前进度写入数据库；失败只记日志，不影响主流程。"""
    try:
        with SessionLocal() as db:
            task = db.get(Task, task_id)
            if task is None:
                return
            task.progress = max(0, min(100, int(progress)))
            task.status_message = message[:255]
            db.commit()
    except Exception:  # noqa: BLE001 进度写入失败不应中断处理
        logger.warning("任务 %s 进度写入失败", task_id, exc_info=True)


def _infer_subject(
    transcribed_text: str,
    ppt_context: str,
) -> str:
    """根据 PPT 或转写文本自动推断课程名称，失败时返回通用课程。"""
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        return DEFAULT_SUBJECT

    sample = (ppt_context or "").strip()
    if not sample:
        sample = transcribed_text.strip()
    if not sample:
        return DEFAULT_SUBJECT

    sample = sample[:2000]

    try:
        client = OpenAI(
            api_key=api_key,
            base_url=DEEPSEEK_BASE_URL,
            timeout=REQUEST_TIMEOUT,
        )
        completion = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"{TEACHER_PROFILE}\n\n"
                        "现在请你判断下面的课堂内容属于哪门课程。"
                        "只输出课程名称本身，4 到 12 个中文字符，"
                        "不要输出解释、标点或引号。"
                        "例如：C语言、高等数学、大学英语、数据结构、线性代数。\n\n"
                        f"{sample}"
                    ),
                }
            ],
            temperature=0.1,
            max_tokens=24,
        )

        raw = (completion.choices[0].message.content or "").strip()
        # 只取第一行，去掉“课程名称：”这类前缀与引号
        name = raw.splitlines()[0].strip() if raw else ""
        name = re.sub(r"^(课程名称|科目|课程)\s*[:：]\s*", "", name)
        name = name.strip("`*\"'“”《》 \t")
        if not name:
            return DEFAULT_SUBJECT

        print(f"[SUBJECT] 自动识别课程名称：{name}")
        return name[:32]
    except Exception as exc:  # noqa: BLE001 推断失败不影响主流程
        logger.warning("[SUBJECT] 课程名称推断失败：%s", exc)
        return DEFAULT_SUBJECT


def _build_prompt(
    subject: str,
    ppt_context: str,
    transcribed_text: str,
) -> str:
    ppt_text = ppt_context.strip() if ppt_context else "（未提供 PPT 课件）"
    return (
        f"{TEACHER_AUTHOR}\n\n"
        f"你是一位专业的大学 {subject} 讲师，正在整理自己的课堂笔记。\n"
        f"这是老师的 PPT 大纲：{ppt_text}。\n"
        f"这是老师上课的录音转写：{transcribed_text}。\n"
        "请结合 PPT 内容，推测录音中“这里”、“这个函数”等代词的具体含义。"
        "去除无意义的语气词，提炼核心知识点，以 Markdown 输出层级分明的 "
        f"{subject} 复习笔记（注意保留该学科的专业专有名词）。"
        "排版要求：尽量使用有序或无序列表代替复杂表格，保持版面简洁；"
        "如果确实需要表格，请使用标准 GFM 表格语法，确保表头与分隔行完整。"
    )


def _get_field(obj: object, key: str) -> object:
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _resolve_ffmpeg() -> str:
    """返回可用的 ffmpeg 可执行文件路径。"""
    for candidate in FFMPEG_CANDIDATES:
        resolved = candidate.resolve()
        if resolved.is_file():
            return str(resolved)

    in_path = shutil.which("ffmpeg")
    if in_path:
        return in_path

    raise RuntimeError(FFMPEG_MISSING_MESSAGE)


def _run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess[str]:
    """执行 ffmpeg 子进程，返回完整结果并打印关键日志。"""
    command = [args[0], "-y", "-hide_banner", *args[1:]]
    print(f"[FFMPEG] 执行命令：{' '.join(command)}")

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=FFMPEG_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"ffmpeg 处理超时（超过 {FFMPEG_TIMEOUT} 秒）"
        ) from exc
    except OSError as exc:
        raise RuntimeError(f"ffmpeg 启动失败：{exc}") from exc

    if result.returncode != 0:
        stderr_tail = (result.stderr or "").strip().splitlines()[-5:]
        detail = " | ".join(stderr_tail) or "无错误输出"
        print(f"[FFMPEG] 处理失败，退出码={result.returncode}")
        print(f"[FFMPEG] 错误摘要：{detail}")
        raise RuntimeError(
            f"ffmpeg 处理失败（退出码 {result.returncode}）：{detail}"
        )

    if result.stderr and result.stderr.strip():
        print(f"[FFMPEG] stderr 摘要：{result.stderr.strip()[-500:]}")

    print("[FFMPEG] 处理成功")
    return result


def _split_with_ffmpeg(audio_path: Path, work_dir: Path) -> list[Path]:
    """一步完成转码与切片：16kHz / 单声道 / 16bit，每 5 分钟一段。"""
    if not audio_path.exists():
        raise RuntimeError(f"音频文件不存在：{audio_path}")

    ffmpeg_path = _resolve_ffmpeg()
    output_pattern = work_dir / "chunk_%03d.wav"

    print(
        f"[AUDIO] 开始转码切片：{audio_path.name}，"
        f"每段 {CHUNK_SECONDS} 秒，输出目录={work_dir}"
    )

    _run_ffmpeg(
        [
            ffmpeg_path,
            "-i",
            str(audio_path),
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "-f",
            "segment",
            "-segment_time",
            str(CHUNK_SECONDS),
            "-reset_timestamps",
            "1",
            str(output_pattern),
        ]
    )

    chunks = sorted(work_dir.glob("chunk_*.wav"))
    chunks = [chunk for chunk in chunks if chunk.stat().st_size > 0]

    if not chunks:
        raise RuntimeError("ffmpeg 未生成任何音频切片")

    print(
        f"[AUDIO] 转码切片完成：共 {len(chunks)} 段 "
        f"（{TARGET_SAMPLE_RATE}Hz / 单声道 / 16bit WAV）"
    )
    return chunks


def _transcribe_chunk(
    chunk_path: Path,
    api_key: str,
    index: int,
    total: int,
) -> str:
    """对单个 16kHz WAV 切片调用 paraformer-realtime-v2。"""
    print(f"[ASR] 第 {index}/{total} 段开始识别：{chunk_path.name}")

    client = dashscope.Client(api_key=api_key)
    sentences: list[str] = []
    last_partial = ""

    try:
        for event in client.audio.asr.recognize_file(
            str(chunk_path.resolve()),
            model=ASR_MODEL,
            format="wav",
            sample_rate=TARGET_SAMPLE_RATE,
            parameters={"language_hints": ["zh", "en"]},
        ):
            payload = event.get("payload") or {}
            sentence = (payload.get("output") or {}).get("sentence") or {}

            text = (sentence.get("text") or "").strip()
            if not text or sentence.get("heartbeat"):
                continue

            if sentence.get("sentence_end"):
                sentences.append(text)
                last_partial = ""
            else:
                last_partial = text
    except Exception as exc:
        raise RuntimeError(f"第 {index}/{total} 段语音识别失败：{exc}") from exc

    if not sentences and last_partial:
        sentences.append(last_partial)

    transcribed_text = " ".join(sentences).strip()
    if not transcribed_text:
        print(f"[ASR] 第 {index}/{total} 段未识别到有效文本，跳过")
        return ""

    print(
        f"[ASR] 第 {index}/{total} 段识别完成："
        f"{len(transcribed_text)} 个字符"
    )
    return transcribed_text


def _transcribe_chunks(
    chunks: list[Path],
    api_key: str,
    on_progress: Callable[[int, int], None] | None = None,
) -> str:
    """并发识别切片（最多 ASR_MAX_WORKERS 个），按原始顺序合并文本。"""
    total = len(chunks)
    if total == 0:
        raise RuntimeError("音频切分后没有可识别的片段")

    if total == 1:
        text = _transcribe_chunk(chunks[0], api_key, 1, 1)
        if on_progress:
            on_progress(1, 1)
        if not text:
            raise RuntimeError("该音频的所有分段均未识别出有效文本")
        return text

    workers = min(ASR_MAX_WORKERS, total)
    print(
        f"[ASR] 共 {total} 个切片，启用 {workers} 个并发识别"
    )

    results: dict[int, str] = {}
    done = 0

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(
                _transcribe_chunk, chunk_path, api_key, index, total
            ): index
            for index, chunk_path in enumerate(chunks, start=1)
        }

        for future in as_completed(future_map):
            index = future_map[future]
            done += 1
            if on_progress:
                on_progress(done, total)
            try:
                text = future.result()
            except Exception as exc:  # noqa: BLE001 单段失败不影响其他片段
                logger.exception(
                    "[ASR] 第 %s/%s 段识别失败，已跳过", index, total
                )
                print(f"[ASR] 第 {index}/{total} 段识别失败，已跳过：{exc}")
                continue

            if text:
                results[index] = text

    parts = [results[index] for index in sorted(results)]
    transcribed_text = "\n".join(parts).strip()
    if not transcribed_text:
        raise RuntimeError("该音频的所有分段均未识别出有效文本")

    print(
        f"[ASR] 全部分段识别完成：{total} 段，"
        f"成功 {len(parts)} 段，总计 {len(transcribed_text)} 个字符"
    )
    return transcribed_text


def _transcribe(
    audio_path: Path,
    api_key: str,
    task_id: int,
    on_progress: Callable[[int, int], None] | None = None,
    file_label: str = "",
) -> str:
    """完整音频管道：ffmpeg 转码切片 → 逐段识别。"""
    if not audio_path.exists():
        raise RuntimeError(f"音频文件不存在：{audio_path}")

    prefix = f"{file_label} · " if file_label else ""
    _update_task_progress(
        task_id, 8, f"{prefix}正在转码并切片：{audio_path.name}"
    )

    with tempfile.TemporaryDirectory(
        prefix=f"classroom_task_{task_id}_"
    ) as temp_dir:
        work_dir = Path(temp_dir)
        chunks = _split_with_ffmpeg(audio_path, work_dir)
        _update_task_progress(
            task_id,
            12,
            f"{prefix}已切成 {len(chunks)} 段，开始识别音频…",
        )
        return _transcribe_chunks(chunks, api_key, on_progress)


def _transcribe_files(
    audio_paths: list[Path],
    api_key: str,
    task_id: int,
) -> str:
    """依次处理每个音频文件，单个文件失败时跳过，最后合并文本。"""
    total = len(audio_paths)
    file_texts: list[str] = []
    errors: list[str] = []

    print(f"[BATCH] 任务 {task_id} 开始处理，共 {total} 个音频文件")

    for index, audio_path in enumerate(audio_paths, start=1):
        print(
            f"[BATCH] 第 {index}/{total} 个音频开始处理："
            f"{audio_path.name}"
        )

        # 识别阶段整体映射到 12% - 50%
        file_base = 12 + (index - 1) * (38 / total)
        file_span = 38 / total
        file_label = f"第 {index}/{total} 个文件" if total > 1 else ""

        def on_progress(
            done: int,
            chunk_total: int,
            base: float = file_base,
            span: float = file_span,
            label: str = file_label,
        ) -> None:
            percent = int(base + span * done / max(1, chunk_total))
            prefix = f"{label} · " if label else ""
            _update_task_progress(
                task_id,
                percent,
                f"{prefix}正在识别音频（{done}/{chunk_total} 段）…",
            )

        try:
            text = _transcribe(
                audio_path,
                api_key,
                task_id,
                on_progress=on_progress,
                file_label=file_label,
            )
        except Exception as exc:  # noqa: BLE001 单个音频失败不影响其他音频
            errors.append(str(exc))
            logger.exception(
                "[BATCH] 第 %s/%s 个音频处理失败，已跳过",
                index,
                total,
            )
            print(f"[BATCH] 第 {index}/{total} 个音频处理失败，已跳过：{exc}")
            continue

        if not text.strip():
            print(f"[BATCH] 第 {index}/{total} 个音频无有效文本，跳过")
            continue

        file_texts.append(text.strip())
        print(
            f"[BATCH] 第 {index}/{total} 个音频处理完成："
            f"{len(text.strip())} 个字符"
        )

    if not file_texts:
        if errors:
            raise RuntimeError(
                "所有音频文件均未识别出有效文本，任务失败；"
                f"首个错误：{errors[0]}"
            )
        raise RuntimeError("所有音频文件均未识别出有效文本，任务失败")

    final_text = "\n\n".join(file_texts)
    print(
        f"[BATCH] 音频合并完成：有效 {len(file_texts)}/{total} 个，"
        f"总计 {len(final_text)} 个字符"
    )
    return final_text


def _call_llm(
    transcribed_text: str,
    subject: str,
    ppt_context: str,
) -> str:
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "未配置 DEEPSEEK_API_KEY，请在 backend/.env 中设置后重试"
        )

    print(
        f"[LLM] 开始生成知识框架：subject={subject}, "
        f"ppt_chars={len(ppt_context)}, "
        f"transcript_chars={len(transcribed_text)}"
    )

    client = OpenAI(
        api_key=api_key,
        base_url=DEEPSEEK_BASE_URL,
        timeout=REQUEST_TIMEOUT,
    )
    completion = client.chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=[
            {
                "role": "user",
                "content": _build_prompt(
                    subject,
                    ppt_context,
                    transcribed_text,
                ),
            }
        ],
        temperature=0.3,
    )

    content = completion.choices[0].message.content or ""
    if not content.strip():
        raise RuntimeError("大模型返回内容为空")

    print(f"[LLM] 知识框架生成完成：{len(content)} 个字符")
    return content


def _strip_markdown(markdown: str) -> str:
    """把 Markdown / LaTeX 片段转成适合 TTS 朗读的纯文本。"""
    return clean_text_for_tts(markdown)


SPEECH_MIN_MEANINGFUL_CHARS = 8
MEANINGFUL_CHAR_PATTERN = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]")
TITLE_ONLY_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9\u4e00-\u9fff·\-—\s]{0,24})?"
    r"(?:复习笔记|课堂笔记|学习笔记|课程总结|课堂总结|内容总结|本节小结|本章小结|"
    r"课程介绍|章节介绍|知识框架|学习目标|目录|大纲)"
    r"(?:[：:\-—\s]*[A-Za-z0-9\u4e00-\u9fff·\-—\s]{0,24})?$"
)
META_ONLY_PATTERN = re.compile(
    r"^.{0,8}(?:整理自|整理于|来源[:：]|本文档由|本笔记由|"
    r"根据.{0,6}录音).{0,50}$"
)


def _is_meaningful_speech(text: str) -> bool:
    """过滤纯符号、纯标题、整理说明等不能作为讲解内容的文本。"""
    compact = re.sub(r"\s+", "", text or "")
    if (
        len(MEANINGFUL_CHAR_PATTERN.findall(compact))
        < SPEECH_MIN_MEANINGFUL_CHARS
    ):
        return False

    probe = compact.strip("`#*-—_·:：")
    if not probe:
        return False

    return not (
        TITLE_ONLY_PATTERN.match(probe) or META_ONLY_PATTERN.match(probe)
    )


def _fallback_storyboard(note_markdown: str) -> list[dict[str, object]]:
    """分镜生成失败时，按笔记自然段切分兜底，保证直播仍可播放。"""
    raw_segments = [
        segment.strip()
        for segment in re.split(r"\n{2,}", note_markdown.strip())
        if segment.strip()
    ]

    storyboard: list[dict[str, object]] = []
    for segment in raw_segments[:STORYBOARD_SEGMENT_LIMIT]:
        speech_text = _strip_markdown(segment)
        if not speech_text or not _is_meaningful_speech(speech_text):
            continue
        storyboard.append(
            {
                "segment_id": len(storyboard) + 1,
                "speech_text": "",
                "board_content": segment,
                "highlight_lines": [],
                "step_by_step": [
                    {
                        "board_highlight": "",
                        "highlight_lines": [],
                        "speech_text": speech_text,
                    }
                ],
                "quiz": None,
            }
        )
    return storyboard


def _build_storyboard_prompt(
    subject: str,
    ppt_context: str,
    transcribed_text: str,
    note_markdown: str,
    retry_note: str = "",
) -> str:
    ppt_text = (ppt_context or "（未提供 PPT 课件）").strip()[:2500]
    transcript_text = transcribed_text.strip()[:6000]
    note_text = note_markdown.strip()[:10000]
    retry_part = f"\n{retry_note}\n" if retry_note else ""

    return (
        f"{TEACHER_AUTHOR}\n\n"
        f"你正在为大学 {subject} 准备 1v1 直播授课。"
        "请把下面的课堂笔记改写成一套「启发式步步为营」教学分镜，"
        "用于李老师边讲边板书，并支持学生随时喊停确认。\n"
        f"{retry_part}"
        "教学模式必须严格遵循：讲概念 → 出例题 → 一步步推导，"
        "绝对不要直接罗列知识点或一次性给出全部答案。\n"
        "输出要求：\n"
        "1. 只输出一个 JSON 数组，不要输出解释文字，"
        "不要使用 ```json 代码围栏。\n"
        f"2. 数组包含 8 到 {STORYBOARD_SEGMENT_LIMIT} 个分镜，"
        "按讲解顺序排列；所有 speech_text 和 step_by_step 里的讲稿加起来，"
        f"总字数必须达到 {STORYBOARD_TARGET_CHARS[0]} 到 "
        f"{STORYBOARD_TARGET_CHARS[1]} 个中文字符。\n"
        "3. 每个分镜是一个对象，字段如下：\n"
        '   - "segment_id"：整数，从 1 开始递增；\n'
        '   - "board_content"：这一屏的完整板书，先整体展示给学生看，'
        "只能选以下一种形式：\n"
        "     a) Mermaid 图表代码，直接以 flowchart TD、flowchart LR 或 mindmap "
        "开头，不要加代码围栏；\n"
        "     b) 带语言标注的代码块，用 ```c 或 ```python 包裹，保留缩进；\n"
        "     c) 3 到 5 行精炼的题目或板书要点，每行以 - 开头；\n"
        '   - "speech_text"：本分镜的开场白，40 到 120 个中文字符，'
        "必须是自然的课堂过渡，像真人老师顺口说出来的一句话。"
        "每个分镜的开场句式都不能重复，可以参考「好，我们来看下一个核心概念」"
        "「大家注意，这里有个容易踩坑的地方」「来，咱们接着看这段代码」。"
        "严禁使用「先别急着记结论」「先看这张结构图」这类写死的模板句；"
        "不要在这一段就公布答案；\n"
        '   - "step_by_step"：数组，包含 2 到 5 个步骤，'
        "按推导顺序排列，每一步包含：\n"
        '       · "board_highlight"：一句话说明这一步聚焦板书的哪一部分，'
        "不超过 30 个字，例如「高亮第 3 行，取地址操作」；\n"
        '       · "highlight_lines"：整数数组，表示要高亮的代码行号'
        "（从 1 开始）；非代码板书填 []；\n"
        '       · "speech_text"：这一步的讲解，100 到 180 个中文字符，'
        "只讲一个推导动作，讲完留出让学生思考的空间，"
        "不要一次把后面的步骤也讲完；\n"
        '   - "quiz"：随堂小测，该分镜讲完后用来检验学生是否真的听懂，'
        "必须是对象，字段如下：\n"
        '       · "question"：一道紧扣本分镜的单选题，30 到 120 个字；\n'
        '       · "options"：4 个选项的纯文本数组，不要带 A、B、C、D 前缀；\n'
        '       · "correct_answer"：正确选项字母，只能是 "A"、"B"、"C"、"D"；\n'
        '       · "explanation_correct"：学生答对时的表扬与原理说明，'
        "60 到 150 个字，口语化；\n"
        '       · "explanation_wrong"：学生答错时的鼓励与重新讲解，'
        "80 到 180 个字，先安慰再点出错误原因，不要责备；\n"
        '       · "explanation_guess"：学生承认是蒙对时的回应，'
        "60 到 150 个字，先幽默认可再补讲原理。\n"
        "4. 每个分镜的 step_by_step 必须体现真正的推导过程："
        "第一步读题或给出已知条件，中间步骤逐行分析、代入数值或修改代码，"
        "最后一步才给出结论或运行结果。\n"
        "5. 讲解要口语化、适合 TTS 朗读，"
        "不要出现 Markdown 符号、代码符号、LaTeX 公式、括号注释和表情。\n"
        "6. 每个分镜的第一句话必须是自然过渡，并且所有分镜的开场句式必须彼此不同："
        "可以承接上一段，也可以直接点出本段要解决的问题，"
        "例如「好，我们来看下一个核心概念」「大家注意，这里有个易错点」"
        "「来，咱们接着看这段代码」。"
        "严禁使用「先别急着记结论」「先看这张结构图」这类模板句，"
        "也不要每段都用「同学们，我们来看……」开头；"
        "不要朗读课程名、章节编号、目录或笔记标题。\n"
        "7. 每道 quiz 必须能只靠本分镜讲过的内容解答，"
        "错误选项要设计成学生容易混淆的典型错误，不要出现多个正确答案。\n"
        "8. 至少 2 个分镜用 Mermaid 图梳理结构；"
        "如果内容涉及代码，至少 2 个分镜用代码块，"
        "并在 step_by_step 中用 highlight_lines 逐步高亮不同行。\n"
        '9. Mermaid 语法强约束：所有节点文本必须用双引号包裹，'
        '例如 A["这是文本"]、B{"是否继续"}；'
        "节点文本中不要出现未转义的双引号，不要使用 HTML 标签；"
        "mindmap 中如含方括号、圆括号等特殊字符，"
        "请改用全角符号或双引号包裹。保证语法绝对正确。\n"
        "10. 【禁止标题与废话】严禁生成任何大标题、章节名、课程名、目录、"
        "课堂总结或说明性文字（例如「C语言 复习笔记：函数与递归」"
        "「整理自课堂录音」「本节小结」「课程介绍」）。"
        "如果课堂笔记或转写里出现这类标题、目录、说明，直接跳过，"
        "从正文的第一个知识点或题目开始讲。"
        "每一段 speech_text（包括每个 step）都必须是可以直接朗读的"
        "干货知识点、推导过程或题目讲解，不能只是标题、日期或一句空话。"
        "如果某段内容只包含换行符、破折号、星号等无意义符号，"
        "不要为它生成分镜；宁可少一个分镜，也不要凑数。\n\n"
        f"## 课堂笔记\n{note_text}\n\n"
        f"## PPT 大纲\n{ppt_text}\n\n"
        f"## 录音转写节选\n{transcript_text}\n"
    )


def _extract_json_array(raw: str) -> list[object]:
    """从模型输出中提取 JSON 数组，兼容代码围栏和前后解释文字。"""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)

    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("模型输出中未找到 JSON 数组")

    data = json.loads(text[start : end + 1])
    if not isinstance(data, list):
        raise ValueError("分镜脚本不是 JSON 数组")
    return data


def _parse_highlight_lines(raw: object) -> list[int]:
    """解析行号数组，过滤非法值并去重。"""
    if not isinstance(raw, list):
        return []

    lines: list[int] = []
    for value in raw:
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            line = value
        elif isinstance(value, str) and value.strip().isdigit():
            line = int(value.strip())
        else:
            continue
        if 0 < line <= 200:
            lines.append(line)

    return sorted(set(lines))[:20]


def _normalize_steps(raw_steps: object) -> list[dict[str, object]]:
    """清洗 step_by_step，保证每一步都有可朗读的讲稿。"""
    if not isinstance(raw_steps, list):
        return []

    steps: list[dict[str, object]] = []
    for item in raw_steps:
        if not isinstance(item, dict):
            continue

        speech_text = _strip_markdown(str(item.get("speech_text") or ""))
        if not speech_text or not _is_meaningful_speech(speech_text):
            continue

        steps.append(
            {
                "board_highlight": str(
                    item.get("board_highlight") or ""
                ).strip()[:120],
                "highlight_lines": _parse_highlight_lines(
                    item.get("highlight_lines")
                ),
                "speech_text": speech_text[:800],
            }
        )

    return steps


def _normalize_quiz(raw: object) -> dict[str, object] | None:
    """清洗随堂测验，缺少题目或选项时返回 None。"""
    if not isinstance(raw, dict):
        return None

    question = _strip_markdown(str(raw.get("question") or ""))
    if not question:
        return None

    raw_options = raw.get("options")
    if not isinstance(raw_options, list):
        return None

    options: list[str] = []
    for option in raw_options:
        text = _strip_markdown(str(option or ""))
        text = re.sub(r"^[A-Da-d]\s*[\.\、\):：]\s*", "", text)
        if text:
            options.append(text[:160])
        if len(options) >= 4:
            break

    if len(options) < 2:
        return None

    answer = re.sub(r"[^A-D]", "", str(raw.get("correct_answer") or "").upper())
    letter = answer[:1] or "A"
    if ord(letter) - ord("A") >= len(options):
        letter = "A"

    def explanation(key: str, fallback: str) -> str:
        text = _strip_markdown(str(raw.get(key) or ""))
        return (text or fallback)[:400]

    return {
        "question": question[:300],
        "options": options,
        "correct_answer": letter,
        "explanation_correct": explanation(
            "explanation_correct", "回答正确，我们继续往下看。"
        ),
        "explanation_wrong": explanation(
            "explanation_wrong", "没关系，我们重新梳理一下这个知识点。"
        ),
        "explanation_guess": explanation(
            "explanation_guess", "被你说对了，不过原理还是要讲清楚。"
        ),
    }


def _normalize_storyboard(items: list[object]) -> list[dict[str, object]]:
    """清洗分镜字段；兼容旧的单段结构，统一转换成 step_by_step。"""
    storyboard: list[dict[str, object]] = []

    for item in items:
        if not isinstance(item, dict):
            continue

        board_content = str(item.get("board_content") or "").strip()
        if not board_content or not MEANINGFUL_CHAR_PATTERN.search(
            board_content
        ):
            continue

        opening = _strip_markdown(str(item.get("speech_text") or ""))
        if opening and not _is_meaningful_speech(opening):
            opening = ""
        steps = _normalize_steps(item.get("step_by_step"))

        if steps:
            if not opening and len(steps) > 1:
                opening = steps[0]["speech_text"]
                steps = steps[1:]
        else:
            # 旧格式只有一段讲稿：把它放进第一步，避免开场白重复朗读
            if not opening:
                continue
            steps = [
                {
                    "board_highlight": "",
                    "highlight_lines": _parse_highlight_lines(
                        item.get("highlight_lines")
                    ),
                    "speech_text": opening,
                }
            ]
            opening = ""

        storyboard.append(
            {
                "segment_id": len(storyboard) + 1,
                "speech_text": opening[:800],
                "board_content": board_content[:2000],
                "highlight_lines": _parse_highlight_lines(
                    item.get("highlight_lines")
                ),
                "step_by_step": steps,
                "quiz": _normalize_quiz(item.get("quiz")),
            }
        )
        if len(storyboard) >= STORYBOARD_SEGMENT_LIMIT:
            break

    if not storyboard:
        raise ValueError("分镜脚本没有有效片段")
    return storyboard


def _generate_storyboard(
    subject: str,
    ppt_context: str,
    transcribed_text: str,
    note_markdown: str,
) -> list[dict[str, object]]:
    """调用 DeepSeek 生成结构化分镜脚本，字数不足时自动重试一次。"""
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "未配置 DEEPSEEK_API_KEY，请在 backend/.env 中设置后重试"
        )

    print(f"[STORYBOARD] 开始生成分镜脚本：subject={subject}")

    client = OpenAI(
        api_key=api_key,
        base_url=DEEPSEEK_BASE_URL,
        timeout=STORYBOARD_TIMEOUT,
    )
    base_prompt = _build_storyboard_prompt(
        subject,
        ppt_context,
        transcribed_text,
        note_markdown,
    )
    retry_note = ""
    last_storyboard: list[dict[str, object]] | None = None

    for attempt in range(1, 3):
        prompt = base_prompt
        if retry_note:
            prompt = f"{prompt}\n\n{retry_note}\n"

        print(
            f"[STORYBOARD] 第 {attempt}/2 次生成，目标 "
            f"{STORYBOARD_TARGET_CHARS[0]}-{STORYBOARD_TARGET_CHARS[1]} 字"
        )

        completion = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
            temperature=0.65,
            max_tokens=STORYBOARD_MAX_TOKENS,
        )

        raw = completion.choices[0].message.content or ""
        if not raw.strip():
            raise RuntimeError("大模型未返回分镜脚本")

        storyboard = _normalize_storyboard(_extract_json_array(raw))
        total_chars = sum(
            len(str(segment["speech_text"]))
            + sum(
                len(str(step["speech_text"]))
                for step in segment["step_by_step"]
            )
            for segment in storyboard
        )
        total_steps = sum(
            len(segment["step_by_step"]) for segment in storyboard
        )

        print(
            f"[STORYBOARD] 本次生成 {len(storyboard)} 段 / "
            f"{total_steps} 个推导步骤，讲稿共 {total_chars} 字"
        )

        if total_chars >= STORYBOARD_MIN_CHARS:
            return storyboard

        last_storyboard = storyboard
        retry_note = (
            f"注意：上一次只生成了 {total_chars} 个中文字符，远低于要求的 "
            f"{STORYBOARD_TARGET_CHARS[0]}-{STORYBOARD_TARGET_CHARS[1]} 字。"
            "请严格重新生成 8 到 15 个分镜，每个分镜包含 3 到 5 个 "
            "step_by_step，把推导过程拆碎讲透，确保总字数不少于 "
            f"{STORYBOARD_TARGET_CHARS[0]} 字。"
        )

    if last_storyboard is not None:
        logger.warning("分镜脚本字数仍不足，返回最后一次生成结果")
        return last_storyboard

    raise RuntimeError("分镜脚本生成失败")


def process_audio_task(task_id: int) -> None:
    """后台任务：依次处理多个音频，合并文本后交给 DeepSeek 生成知识框架。"""
    print(f"[TASK {task_id}] 开始处理")

    try:
        with SessionLocal() as db:
            task = db.get(Task, task_id)
            if task is None:
                print(f"[TASK {task_id}] 任务不存在，跳过")
                logger.warning("任务 %s 不存在，跳过处理", task_id)
                return

            if task.filepaths:
                try:
                    raw_paths = json.loads(task.filepaths)
                    if not isinstance(raw_paths, list):
                        raise ValueError("filepaths 不是数组")
                    filepaths = [
                        item for item in raw_paths if isinstance(item, str)
                    ]
                except (json.JSONDecodeError, ValueError) as exc:
                    logger.warning(
                        "任务 %s 的 filepaths 解析失败，回退到 filepath：%s",
                        task_id,
                        exc,
                    )
                    filepaths = [task.filepath]
            else:
                filepaths = [task.filepath]

            audio_paths = [
                settings.BASE_DIR / filepath for filepath in filepaths
            ]
            task_subject = task.subject or DEFAULT_SUBJECT
            task_ppt_context = task.ppt_context or ""
    except Exception:  # noqa: BLE001 读取任务失败时仅记录日志
        logger.exception("读取任务 %s 失败", task_id)
        print(f"[TASK {task_id}] 读取任务失败")
        return

    try:
        dashscope_api_key = os.getenv("DASHSCOPE_API_KEY")
        if not dashscope_api_key:
            raise RuntimeError(
                "未配置 DASHSCOPE_API_KEY，请在 backend/.env 中设置后重试"
            )

        if not audio_paths:
            raise RuntimeError("任务没有可处理的音频文件")

        print(
            f"[TASK {task_id}] 任务包含 {len(audio_paths)} 个音频文件，"
            f"课程={task_subject}，PPT 文本 {len(task_ppt_context)} 字符"
        )

        _update_task_progress(
            task_id,
            5,
            f"开始处理 {len(audio_paths)} 个音频文件…",
        )

        try:
            transcribed_text = _transcribe_files(
                audio_paths, dashscope_api_key, task_id
            )
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"音频预处理或识别失败：{exc}") from exc

        # 用户不再手填课程名，这里根据 PPT 或转写内容自动识别
        if task_subject.strip() in ("", DEFAULT_SUBJECT):
            _update_task_progress(
                task_id, 55, "音频识别完成，AI 正在识别课程科目…"
            )
            task_subject = _infer_subject(
                transcribed_text,
                task_ppt_context,
            )
            print(f"[TASK {task_id}] 使用自动识别课程：{task_subject}")
        else:
            _update_task_progress(
                task_id, 55, "音频识别完成，准备生成笔记…"
            )

        _update_task_progress(
            task_id,
            62,
            "AI 正在深度备课，生成启发式讲稿与笔记…",
        )

        try:
            result = _call_llm(
                transcribed_text,
                task_subject,
                task_ppt_context,
            )
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"知识框架生成失败：{exc}") from exc

        _update_task_progress(
            task_id,
            80,
            "笔记已生成，正在编排分步讲解脚本与板书…",
        )

        # 分镜脚本属于增强能力：生成失败不影响笔记落库，用笔记分段兜底
        try:
            storyboard = _generate_storyboard(
                task_subject,
                task_ppt_context,
                transcribed_text,
                result,
            )
            print(
                f"[STORYBOARD] 分镜脚本生成完成：{len(storyboard)} 个片段"
            )
        except Exception as exc:  # noqa: BLE001 兜底保证直播可播放
            logger.exception("任务 %s 分镜脚本生成失败，使用兜底分镜", task_id)
            print(f"[STORYBOARD] 分镜生成失败，改用兜底方案：{exc}")
            storyboard = _fallback_storyboard(result)

        _update_task_progress(task_id, 96, "正在保存结果…")

        storyboard_json = json.dumps(storyboard, ensure_ascii=False)
        status = "completed"
        status_message = "处理完成"
    except Exception as exc:  # noqa: BLE001 失败时需记录任意错误
        logger.exception("任务 %s 处理失败", task_id)
        print(f"[TASK {task_id}] 处理失败：{exc}")
        status = "failed"
        result = f"处理失败：{exc}"
        storyboard_json = None
        status_message = f"处理失败：{exc}"[:255]

    try:
        with SessionLocal() as db:
            task = db.get(Task, task_id)
            if task is None:
                logger.warning("任务 %s 已不存在，结果未写入", task_id)
                return

            task.status = status
            task.result = result
            task.storyboard = storyboard_json
            task.subject = task_subject
            task.status_message = status_message
            if status == "completed":
                task.progress = 100
            db.commit()
    except Exception:  # noqa: BLE001 数据库写入失败时记录日志
        logger.exception("任务 %s 结果写入失败", task_id)
        print(f"[TASK {task_id}] 结果写入失败")
        return

    print(f"[TASK {task_id}] 处理结束，状态={status}")
