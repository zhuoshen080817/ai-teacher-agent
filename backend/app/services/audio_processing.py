"""音频处理任务：ffmpeg 转码切片 → 分段 ASR → 合并 → 大模型生成知识框架与分镜。"""

import html
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path

import dashscope
from sqlalchemy import select

from app.config import settings
from app.database import SessionLocal
from app.models.task import Task
from app.services.llm_service import llm_complete
from app.services.persona import TEACHER_AUTHOR, TEACHER_PROFILE
from app.services.tts_service import clean_text_for_tts

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
# 全局 ASR 并发分片池：默认 8 路并发，可通过 ASR_MAX_WORKERS 调整
ASR_MAX_WORKERS = settings.ASR_MAX_WORKERS
ASR_CHUNK_MAX_RETRIES = settings.ASR_CHUNK_MAX_RETRIES
_ASR_POOL_LOCK = threading.Lock()
_ASR_POOL: ThreadPoolExecutor | None = None
_ASR_DB_LOCK = threading.Lock()
DEFAULT_SUBJECT = "通用课程"
STORYBOARD_SEGMENT_LIMIT = 12
STORYBOARD_MIN_SEGMENTS = 8
STORYBOARD_MAX_SEGMENTS = 10
STORYBOARD_MIN_CHARS = 1500
STORYBOARD_TARGET_CHARS = (1600, 2600)
STORYBOARD_TIMEOUT = 180.0
STORYBOARD_MAX_TOKENS = 8192
CODE_BLOCK_PATTERN = re.compile(r"```([A-Za-z0-9_+-]*)\n(.*?)```", re.DOTALL)
SCRIPT_TAG_PATTERN = re.compile(
    r"<script\b[^>]*>[\s\S]*?</script>", re.IGNORECASE
)
EVENT_HANDLER_PATTERN = re.compile(
    r"\son[a-z]+\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)", re.IGNORECASE
)
JAVASCRIPT_URL_PATTERN = re.compile(r"javascript:", re.IGNORECASE)
TRIGGER_UNSAFE_PATTERN = re.compile(r"[^A-Za-z0-9_-]")
ACTIVE_CLASS_PATTERN = re.compile(
    r"\.([A-Za-z][A-Za-z0-9_-]*)\.is-active\b"
)
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")

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
    image_context: str = "",
) -> str:
    """根据 PPT、补充图片或转写文本自动推断课程名称，失败时返回通用课程。"""
    sample = (ppt_context or "").strip()
    if not sample:
        sample = (image_context or "").strip()
    if not sample:
        sample = transcribed_text.strip()
    if not sample:
        return DEFAULT_SUBJECT

    sample = sample[:2000]

    try:
        raw = llm_complete(
            prompt=(
                f"{TEACHER_PROFILE}\n\n"
                "现在请你判断下面的课堂内容属于哪门课程。"
                "只输出课程名称本身，4 到 12 个中文字符，"
                "不要输出解释、标点或引号。"
                "例如：C语言、高等数学、大学英语、数据结构、线性代数。\n\n"
                f"{sample}"
            ),
            temperature=0.1,
            max_tokens=24,
            timeout=settings.LLM_TIMEOUT,
            scene="infer_subject",
        ).strip()

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
    image_context: str = "",
) -> str:
    ppt_text = ppt_context.strip() if ppt_context else "（未提供 PPT 课件）"
    image_text = (
        image_context.strip()
        if image_context
        else "（未提供补充图片）"
    )
    return (
        f"{TEACHER_AUTHOR}\n\n"
        f"你是一位专业的大学 {subject} 讲师，正在整理自己的课堂笔记。\n"
        f"这是 PPT 内容：{ppt_text}。\n"
        f"这是学生上传的补充图片内容：{image_text}。\n"
        f"这是老师上课的录音转写：{transcribed_text}。\n"
        "请结合这些信息进行讲解：PPT 用于把握课程大纲，"
        "图片用于补充黑板、练习题和图表细节，录音用于还原课堂原话。\n"
        "推测录音中“这里”、“这个函数”等代词的具体含义。"
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


def get_asr_pool() -> ThreadPoolExecutor:
    """获取全局共享的 8 路 ASR 分片识别线程池。"""
    global _ASR_POOL
    with _ASR_POOL_LOCK:
        if _ASR_POOL is None:
            _ASR_POOL = ThreadPoolExecutor(
                max_workers=max(1, ASR_MAX_WORKERS),
                thread_name_prefix="asr-pool",
            )
        return _ASR_POOL


def shutdown_asr_pool() -> None:
    """应用退出时优雅关闭全局 ASR 线程池。"""
    global _ASR_POOL
    with _ASR_POOL_LOCK:
        if _ASR_POOL is not None:
            _ASR_POOL.shutdown(wait=False, cancel_futures=False)
            _ASR_POOL = None


def _compose_transcript_from_chunks(
    chunks_map: dict[str, dict[str, object]],
) -> str:
    """按文件号与切片序号稳定拼接已识别成功的文本。"""
    grouped: dict[int, list[tuple[int, str]]] = {}
    for item in chunks_map.values():
        if not isinstance(item, dict):
            continue
        if item.get("status") != "done":
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        file_index = int(item.get("file_index") or 0)
        chunk_index = int(item.get("chunk_index") or 0)
        grouped.setdefault(file_index, []).append((chunk_index, text))

    file_sections: list[str] = []
    for file_index in sorted(grouped):
        parts = [
            text
            for _, text in sorted(grouped[file_index], key=lambda pair: pair[0])
        ]
        joined = "\n".join(parts).strip()
        if joined:
            file_sections.append(joined)
    return "\n\n".join(file_sections).strip()


def _load_asr_checkpoint(
    task_id: int,
) -> tuple[str, dict[str, dict[str, object]], bool]:
    """读取任务已落库的 ASR 断点信息，支持失败后跳过已识别分片。"""
    try:
        with SessionLocal() as db:
            task = db.get(Task, task_id)
            if task is None:
                return "", {}, False
            saved_text = (task.transcribed_text or "").strip()
            raw_chunks = task.asr_chunks
    except Exception:  # noqa: BLE001 读取断点失败时从头识别
        logger.warning("任务 %s 读取 ASR 断点失败", task_id, exc_info=True)
        return "", {}, False

    if not raw_chunks:
        return saved_text, {}, False

    try:
        payload = json.loads(raw_chunks)
    except (json.JSONDecodeError, TypeError):
        return saved_text, {}, False

    if not isinstance(payload, dict):
        return saved_text, {}, False

    raw_map = payload.get("chunks")
    chunks_map: dict[str, dict[str, object]] = {}
    if isinstance(raw_map, dict):
        for key, value in raw_map.items():
            if isinstance(key, str) and isinstance(value, dict):
                chunks_map[key] = dict(value)

    completed = bool(payload.get("completed"))
    return saved_text, chunks_map, completed


def _persist_asr_checkpoint(
    task_id: int,
    *,
    chunks_map: dict[str, dict[str, object]],
    total_chunks: int,
    completed: bool = False,
    progress: int | None = None,
    status_message: str | None = None,
) -> str:
    """将最新分片转写结果实时落库（线程安全短事务），防止单点故障丢进度。"""
    merged_text = _compose_transcript_from_chunks(chunks_map)
    done_count = sum(
        1 for item in chunks_map.values() if item.get("status") == "done"
    )
    failed_count = sum(
        1 for item in chunks_map.values() if item.get("status") == "failed"
    )
    payload = {
        "version": 1,
        "completed": completed,
        "total_chunks": total_chunks,
        "done_chunks": done_count,
        "failed_chunks": failed_count,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "chunks": chunks_map,
    }

    with _ASR_DB_LOCK:
        try:
            with SessionLocal() as db:
                task = db.get(Task, task_id)
                if task is None:
                    return merged_text
                task.asr_chunks = json.dumps(payload, ensure_ascii=False)
                if merged_text:
                    task.transcribed_text = merged_text
                if progress is not None:
                    task.progress = max(0, min(100, int(progress)))
                if status_message is not None:
                    task.status_message = status_message[:255]
                db.commit()
        except Exception:  # noqa: BLE001 落库异常记录日志不中断正在进行的识别
            logger.warning("任务 %s 实时写入 ASR 分片失败", task_id, exc_info=True)

    return merged_text


def _transcribe_chunk(
    chunk_path: Path,
    api_key: str,
    index: int,
    total: int,
) -> str:
    """对单个 16kHz WAV 切片调用 paraformer-realtime-v2，失败自动退避重试。"""
    attempts = max(1, ASR_CHUNK_MAX_RETRIES)
    last_exc: Exception | None = None

    for attempt in range(1, attempts + 1):
        print(
            f"[ASR] 第 {index}/{total} 段开始识别（第 {attempt}/{attempts} 次）："
            f"{chunk_path.name}"
        )

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
        except Exception as exc:  # noqa: BLE001 瞬时错误按次数重试
            last_exc = exc
            if attempt < attempts:
                delay = min(4.0, 1.0 * (2 ** (attempt - 1)))
                logger.warning(
                    "[ASR] 第 %s/%s 段识别失败（%s），%.1fs 后重试",
                    index,
                    total,
                    exc,
                    delay,
                )
                time.sleep(delay)
                continue
            raise RuntimeError(
                f"第 {index}/{total} 段语音识别失败：{exc}"
            ) from exc

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

    assert last_exc is not None
    raise RuntimeError(f"第 {index}/{total} 段语音识别失败：{last_exc}") from last_exc


def _transcribe_chunks(
    chunks: list[Path],
    api_key: str,
    on_progress: Callable[[int, int], None] | None = None,
) -> str:
    """兼容辅助函数：使用全局 8 路分片池并发识别切片并按顺序合并。"""
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

    pool = get_asr_pool()
    print(f"[ASR] 共 {total} 个切片，提交全局 {ASR_MAX_WORKERS} 路分片池并发识别")

    results: dict[int, str] = {}
    done = 0
    future_map = {
        pool.submit(
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
            logger.exception("[ASR] 第 %s/%s 段识别失败，已跳过", index, total)
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
    """完整单文件音频管道：ffmpeg 转码切片 → 全局分片池识别。"""
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
    """跨文件展平切片 + 全局 8 路并发识别 + 实时落库断点续传。"""
    saved_text, chunks_map, already_completed = _load_asr_checkpoint(task_id)
    if already_completed and saved_text:
        print(
            f"[ASR] 任务 {task_id} 命中已落库完整转写（{len(saved_text)} 字符），"
            "跳过转码与识别直接进入下一阶段"
        )
        _update_task_progress(
            task_id,
            50,
            "已复用落库转写文本，跳过重复识别…",
        )
        return saved_text

    total_files = len(audio_paths)
    errors: list[str] = []
    print(f"[BATCH] 任务 {task_id} 开始处理，共 {total_files} 个音频文件")

    with ExitStack() as stack:
        # 先对所有音频完成切片，再统一投入全局 8 路分片池实现跨文件并发
        chunk_specs: list[tuple[str, int, int, str, Path]] = []
        for file_index, audio_path in enumerate(audio_paths, start=1):
            label = (
                f"第 {file_index}/{total_files} 个文件 · "
                if total_files > 1
                else ""
            )
            _update_task_progress(
                task_id,
                6 + int(6 * (file_index - 1) / max(1, total_files)),
                f"{label}正在转码并切片：{audio_path.name}",
            )
            try:
                temp_dir = stack.enter_context(
                    tempfile.TemporaryDirectory(
                        prefix=f"classroom_task_{task_id}_f{file_index}_"
                    )
                )
                chunks = _split_with_ffmpeg(audio_path, Path(temp_dir))
            except Exception as exc:  # noqa: BLE001 单文件转码失败不影响其余音频
                errors.append(str(exc))
                logger.exception(
                    "[BATCH] 第 %s/%s 个音频切片失败，已跳过",
                    file_index,
                    total_files,
                )
                print(
                    f"[BATCH] 第 {file_index}/{total_files} 个音频切片失败，已跳过：{exc}"
                )
                continue

            for chunk_index, chunk_path in enumerate(chunks, start=1):
                chunk_key = f"{file_index:03d}_{chunk_index:04d}"
                chunk_specs.append(
                    (
                        chunk_key,
                        file_index,
                        chunk_index,
                        audio_path.name,
                        chunk_path,
                    )
                )

        total_chunks = len(chunk_specs)
        if total_chunks == 0:
            if errors:
                raise RuntimeError(
                    "所有音频文件均未能完成转码切片，任务失败；"
                    f"首个错误：{errors[0]}"
                )
            raise RuntimeError("音频切分后没有可识别的片段")

        # 初始化或复用断点记录
        pending_specs: list[tuple[int, str, int, int, str, Path]] = []
        completed_count = 0
        for seq, (
            chunk_key,
            file_index,
            chunk_index,
            filename,
            chunk_path,
        ) in enumerate(chunk_specs, start=1):
            existing = chunks_map.get(chunk_key)
            if (
                existing
                and existing.get("status") == "done"
                and str(existing.get("text") or "").strip()
            ):
                completed_count += 1
                continue

            chunks_map[chunk_key] = {
                "file_index": file_index,
                "chunk_index": chunk_index,
                "filename": filename,
                "status": "pending",
                "text": "",
                "error": "",
                "updated_at": datetime.now().isoformat(timespec="seconds"),
            }
            pending_specs.append(
                (seq, chunk_key, file_index, chunk_index, filename, chunk_path)
            )

        resumed_note = (
            f"（复用断点 {completed_count} 段）" if completed_count > 0 else ""
        )
        _persist_asr_checkpoint(
            task_id,
            chunks_map=chunks_map,
            total_chunks=total_chunks,
            completed=False,
            progress=12 + int(38 * completed_count / total_chunks),
            status_message=(
                f"共 {total_chunks} 个音频分片{resumed_note}，"
                f"启动 {min(ASR_MAX_WORKERS, max(1, len(pending_specs)))} 路并发识别…"
            ),
        )

        if pending_specs:
            pool = get_asr_pool()
            print(
                f"[ASR] 任务 {task_id} 提交 {len(pending_specs)}/{total_chunks} 个分片"
                f"至全局 {ASR_MAX_WORKERS} 路并发池{resumed_note}"
            )
            future_map = {
                pool.submit(
                    _transcribe_chunk,
                    chunk_path,
                    api_key,
                    seq,
                    total_chunks,
                ): (chunk_key, file_index, chunk_index, filename)
                for (
                    seq,
                    chunk_key,
                    file_index,
                    chunk_index,
                    filename,
                    chunk_path,
                ) in pending_specs
            }

            processed_count = completed_count
            for future in as_completed(future_map):
                chunk_key, file_index, chunk_index, filename = future_map[
                    future
                ]
                processed_count += 1
                now_iso = datetime.now().isoformat(timespec="seconds")

                try:
                    text = future.result()
                    if text.strip():
                        chunks_map[chunk_key] = {
                            "file_index": file_index,
                            "chunk_index": chunk_index,
                            "filename": filename,
                            "status": "done",
                            "text": text.strip(),
                            "error": "",
                            "updated_at": now_iso,
                        }
                    else:
                        chunks_map[chunk_key] = {
                            "file_index": file_index,
                            "chunk_index": chunk_index,
                            "filename": filename,
                            "status": "done",
                            "text": "",
                            "error": "",
                            "updated_at": now_iso,
                        }
                except Exception as exc:  # noqa: BLE001 单片失败落库标记，保留断点
                    errors.append(str(exc))
                    logger.exception(
                        "[ASR] 分片 %s 识别失败，已落库标记待重试", chunk_key
                    )
                    chunks_map[chunk_key] = {
                        "file_index": file_index,
                        "chunk_index": chunk_index,
                        "filename": filename,
                        "status": "failed",
                        "text": "",
                        "error": str(exc)[:300],
                        "updated_at": now_iso,
                    }

                percent = 12 + int(38 * processed_count / total_chunks)
                _persist_asr_checkpoint(
                    task_id,
                    chunks_map=chunks_map,
                    total_chunks=total_chunks,
                    completed=False,
                    progress=percent,
                    status_message=(
                        f"正在并发识别音频（{processed_count}/{total_chunks} 段，已实时存档）…"
                    ),
                )

    final_text = _compose_transcript_from_chunks(chunks_map)
    if not final_text:
        if errors:
            raise RuntimeError(
                "所有音频分片均未识别出有效文本，任务失败；"
                f"首个错误：{errors[0]}"
            )
        raise RuntimeError("所有音频分片均未识别出有效文本，任务失败")

    has_failed = any(
        item.get("status") == "failed" for item in chunks_map.values()
    )
    _persist_asr_checkpoint(
        task_id,
        chunks_map=chunks_map,
        total_chunks=total_chunks,
        completed=not has_failed,
        progress=50,
        status_message="音频识别完成并已持久化存档",
    )

    done_with_text = sum(
        1
        for item in chunks_map.values()
        if item.get("status") == "done" and str(item.get("text") or "").strip()
    )
    print(
        f"[BATCH] 音频并发识别合并完成：有效分片 {done_with_text}/{total_chunks}，"
        f"总计 {len(final_text)} 个字符"
    )
    return final_text


def _call_llm(
    transcribed_text: str,
    subject: str,
    ppt_context: str,
    image_context: str = "",
) -> str:
    print(
        f"[LLM] 开始生成知识框架：subject={subject}, "
        f"ppt_chars={len(ppt_context)}, "
        f"transcript_chars={len(transcribed_text)}"
    )

    content = llm_complete(
        prompt=_build_prompt(
            subject,
            ppt_context,
            transcribed_text,
            image_context,
        ),
        temperature=0.3,
        timeout=settings.LLM_TIMEOUT,
        scene="generate_note",
    )

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
    weak_points: list[dict[str, object]] | None = None,
    image_context: str = "",
) -> str:
    ppt_text = (ppt_context or "（未提供 PPT 课件）").strip()[:2500]
    transcript_text = transcribed_text.strip()[:6000]
    note_text = note_markdown.strip()[:10000]
    image_text = (
        image_context.strip()[:8000]
        if image_context
        else "（未提供补充图片）"
    )
    retry_part = f"\n{retry_note}\n" if retry_note else ""

    weak_text = ""
    if weak_points:
        lines = []
        for index, item in enumerate(weak_points[:6], start=1):
            question = str(item.get("question") or "").strip()
            topic = str(item.get("topic") or "").strip()
            if not question:
                continue
            suffix = f"（薄弱点：{topic}）" if topic else ""
            lines.append(f"{index}. {question}{suffix}")
        if lines:
            weak_text = (
                "\n## 学生历史薄弱点\n"
                + "\n".join(lines)
                + "\n要求：如果这些薄弱点与本次课程内容相关，"
                "第一段 speech_intro 必须自然地做一句复习引入，"
                "例如「上次你对递归还有些疑惑，我们今天先把这一块补上」，"
                "不要生硬罗列，也不要虚构无关内容；"
                "如果完全不相关，不要强行提及。\n\n"
            )

    return (
        f"{TEACHER_AUTHOR}\n\n"
        "你是耐心的李老师。直接讲知识点，不要念章节标题。"
        "每次回答换开场白，严禁重复「这个问题问得不错」。\n"
        f"现在为大学 {subject} 准备 1v1 直播授课。"
        "请把下面的课堂笔记改写成一套「启发式步步为营」教学分镜，"
        "用于李老师边讲边板书，并支持学生随时喊停确认。\n"
        f"{retry_part}"
        "教学模式必须严格遵循：讲概念 → 出例题 → 一步步推导，"
        "绝对不要直接罗列知识点或一次性给出全部答案。"
        "如果学生补充图片里有黑板题、练习题或图表，"
        "优先围绕这些题目和图表信息设计讲解与例题，"
        "把题干、已知条件和图形关系讲清楚，不要把图片当装饰。\n"
        "输出要求：\n"
        "1. 只输出一个 JSON 数组，不要输出解释文字，"
        "不要使用 ```json 代码围栏。\n"
        f"2. 数组包含 {STORYBOARD_MIN_SEGMENTS} 到 "
        f"{STORYBOARD_MAX_SEGMENTS} 个分镜，按讲解顺序排列；"
        "所有 speech_intro 加起来必须达到 "
        f"{STORYBOARD_TARGET_CHARS[0]} 到 "
        f"{STORYBOARD_TARGET_CHARS[1]} 个中文字符。\n"
        "3. 每个分镜是一个对象，只包含以下字段：\n"
        '   - "segment_id"：整数，从 1 开始递增；\n'
        '   - "speech_intro"：李老师这一步的口播，150 到 300 个中文字符。'
        "用自然过渡开场，直接讲知识点、推导或题目，不要念标题；"
        "每段开头必须不一样，严禁「这个问题问得不错」；"
        "不要出现 Markdown、代码符号、LaTeX、括号注释和表情；\n"
        '   - "html_code"：这一屏的动态板书，一段自包含的 HTML+CSS 字符串，'
        "具体要求见第 5 条；\n"
        '   - "animation_trigger"：一个 CSS 类名，只允许字母、数字和连字符，'
        "例如 reveal-line-1。它必须出现在 html_code 中；"
        "前端会在 speech_intro 播完后给这个类加上 is-active；\n"
        '   - "quiz"：可选，每 2 到 3 个分镜配一道随堂小测，'
        "必须是对象，字段如下：\n"
        '       · "question"：紧扣本分镜的单选题，30 到 120 个字；\n'
        '       · "options"：4 个选项的纯文本数组，不要带 A、B、C、D 前缀；\n'
        '       · "correct_answer"：正确选项字母，只能是 "A"、"B"、"C"、"D"；\n'
        '       · "explanation_correct"：答对时的表扬与原理说明，60 到 150 字；\n'
        '       · "explanation_wrong"：答错时的安慰与重讲，80 到 180 字；\n'
        '       · "explanation_guess"：蒙对时的幽默回应，60 到 150 字。\n'
        "4. 教学节奏必须「先说话，后写字」：speech_intro 是口播，"
        "html_code 是这句话播完后才出现的板书。每个分镜只讲一个推导动作，"
        "不要提前展示后续步骤，也不要把整页内容一次性铺满。\n"
        "5. html_code 的视觉与动画要求（重要）：\n"
        "   - 深色极简风：背景 #0f1114 或透明，正文 #e4e4e7，"
        "强调色 #f3c969，代码使用 Cascadia Code 或 monospace；"
        "禁止紫色、蓝色霓虹发光。\n"
        "   - 用 grid 或 flex 做成 16:9 的三尺讲台：左边代码或公式，"
        "右边要点，或居中推导；字号不小于 18px，留白充足。\n"
        "   - 所有本步内容初始隐藏（opacity: 0、transform、clip-path 均可），"
        "目标元素加上 animation_trigger 指定的类；"
        "CSS 中写 .trigger.is-active 的动画，并使用 forwards 保持终态。"
        "必须把 trigger 类加在每一行代码、每一条要点上（多个元素共用同一个类），"
        "用 --i 或 transition-delay: calc(var(--i) * 100ms) 让它们逐行写出；"
        "严禁只给覆盖整屏的大容器加 trigger 类，否则整页会同时出现。\n"
        "   - 结构图的连接线用 stroke-dasharray 与 stroke-dashoffset 在 "
        ".trigger.is-active 时画出来（必须写 stroke-dashoffset: 0），"
        "形成「线段动画」；"
        "重点词用黄色左侧竖线、下划线或淡黄底色标出。\n"
        "   - 输出前必须自查：animation_trigger 同时出现在元素 class 和 "
        ".trigger.is-active 规则中；缺少 is-active 规则会导致板书永远不出现。\n"
        "   - 代码高亮用不同颜色的 span，重点用左侧竖线、下划线或淡黄底色；"
        "不要使用刺眼的霓虹色。\n"
        "   - 只允许内联 CSS 和内联 SVG；禁止 script、iframe、外链、"
        "图片 URL、Google Fonts；HTML 控制在 50 行以内，CSS 精简。\n"
        "   - 板上文字要精简，不要把 speech_intro 全文抄上去；"
        "只放关键词、公式、代码、箭头和结论。\n"
        "6. 严禁出现大标题、章节名、课程名、目录、课堂总结或"
        "「整理自课堂录音」这类说明文字；如果笔记里有，直接跳过。\n"
        "7. 每段开场白必须自然且彼此不同，可以参考「好，我们来看下一个核心概念」"
        "「大家注意，这里有个易错点」「来，咱们接着看这段代码」，"
        "但不要每段都用同一种句式。\n"
        "8. 每道 quiz 必须能只靠本分镜讲过的内容解答，"
        "错误选项要设计成学生容易混淆的典型错误，不要出现多个正确答案。\n"
        "9. 至少 2 个分镜用内联 SVG 或 CSS 结构图梳理关系；"
        "涉及代码时至少 2 个分镜展示带高亮的代码，"
        "并用动画让代码行依次出现。\n"
        "10. 如果某段内容只有标题、符号或空话，不要为它生成分镜；"
        "宁可少一段，也不要凑数。\n\n"
        f"{weak_text}"
        f"## 课堂笔记\n{note_text}\n\n"
        f"## PPT 大纲\n{ppt_text}\n\n"
        f"## 学生补充图片内容\n{image_text}\n\n"
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


def _sanitize_board_html(raw: str) -> str:
    """移除脚本与事件处理器，保证 iframe 只渲染静态 HTML+CSS。"""
    cleaned = SCRIPT_TAG_PATTERN.sub("", raw or "")
    cleaned = EVENT_HANDLER_PATTERN.sub("", cleaned)
    cleaned = JAVASCRIPT_URL_PATTERN.sub("", cleaned).strip()

    if not cleaned:
        return ""
    if "<" not in cleaned:
        cleaned = (
            '<div style="font-size:20px;line-height:1.8;">'
            f"{html.escape(cleaned)}</div>"
        )
    return cleaned[:12000]


def _normalize_trigger(raw: object, html_code: str) -> str:
    """把动画触发器收敛成安全的 CSS 类名，并尽量修正模型的不一致输出。"""
    trigger = TRIGGER_UNSAFE_PATTERN.sub("", str(raw or "")).strip("-_")[:60]
    if not trigger:
        trigger = "reveal-1"

    if trigger in html_code:
        return trigger

    # 模型偶尔写错类名：优先复用 HTML 里已经定义 .xxx.is-active 的类
    candidates = ACTIVE_CLASS_PATTERN.findall(html_code)
    if candidates:
        counts = {name: html_code.count(name) for name in set(candidates)}
        best = max(counts, key=counts.get)
        logger.warning(
            "[STORYBOARD] animation_trigger=%s 未出现在 HTML 中，"
            "改用 HTML 已有的动画类 %s",
            trigger,
            best,
        )
        return best

    logger.warning(
        "[STORYBOARD] animation_trigger=%s 未出现在 HTML 中，"
        "前端将强制展开板书",
        trigger,
    )
    return trigger


def _normalize_storyboard(items: list[object]) -> list[dict[str, object]]:
    """清洗分镜字段：优先解析 speech_intro + html_code 新结构，并兼容旧结构。"""
    storyboard: list[dict[str, object]] = []

    for item in items:
        if not isinstance(item, dict):
            continue

        speech_source = HTML_TAG_PATTERN.sub(
            " ", str(item.get("speech_intro") or "")
        )
        speech_intro = _strip_markdown(speech_source)
        html_code = _sanitize_board_html(str(item.get("html_code") or ""))

        if html_code and speech_intro and _is_meaningful_speech(speech_intro):
            storyboard.append(
                {
                    "segment_id": len(storyboard) + 1,
                    "speech_intro": speech_intro[:800],
                    "html_code": html_code,
                    "animation_trigger": _normalize_trigger(
                        item.get("animation_trigger"), html_code
                    ),
                    "quiz": _normalize_quiz(item.get("quiz")),
                }
            )
            if len(storyboard) >= STORYBOARD_SEGMENT_LIMIT:
                break
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
                "speech_intro": "",
                "html_code": "",
                "animation_trigger": "",
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


def _storyboard_speech_chars(segment: dict[str, object]) -> int:
    """统计一个分镜的口播字数，兼容新 HTML 结构与旧 step 结构。"""
    if segment.get("html_code"):
        return len(str(segment.get("speech_intro") or ""))

    return len(str(segment.get("speech_text") or "")) + sum(
        len(str(step.get("speech_text") or ""))
        for step in segment.get("step_by_step") or []
    )


def _load_recent_weak_points(
    subject: str,
    exclude_task_id: int | None = None,
    limit: int = 6,
) -> list[dict[str, object]]:
    """读取历史错题，供下一次课件生成时做个性化复习引入。"""
    try:
        with SessionLocal() as db:
            tasks = db.scalars(
                select(Task)
                .where(Task.wrong_questions.is_not(None))
                .order_by(Task.id.desc())
                .limit(50)
            ).all()
    except Exception:  # noqa: BLE001 错题读取失败不应影响主流程
        logger.exception("读取历史薄弱点失败")
        return []

    points: list[dict[str, object]] = []
    seen: set[str] = set()

    for task in tasks:
        if exclude_task_id is not None and task.id == exclude_task_id:
            continue

        try:
            items = json.loads(task.wrong_questions or "[]")
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(items, list):
            continue

        for item in reversed(items):
            if not isinstance(item, dict):
                continue
            question = str(item.get("question") or "").strip()
            if not question or question in seen:
                continue

            item_subject = str(
                item.get("subject") or task.subject or ""
            ).strip()
            if (
                subject
                and subject != DEFAULT_SUBJECT
                and item_subject
                and item_subject != subject
            ):
                continue

            seen.add(question)
            points.append(
                {
                    "question": question[:300],
                    "topic": str(item.get("topic") or "").strip()[:120],
                    "correct_answer": str(
                        item.get("correct_answer") or ""
                    ).strip()[:8],
                    "chosen_answer": str(
                        item.get("chosen_answer") or ""
                    ).strip()[:8],
                    "subject": item_subject or subject,
                }
            )
            if len(points) >= limit:
                return points

    return points


def _generate_storyboard(
    subject: str,
    ppt_context: str,
    transcribed_text: str,
    note_markdown: str,
    weak_points: list[dict[str, object]] | None = None,
    image_context: str = "",
) -> list[dict[str, object]]:
    """调用大模型生成结构化分镜脚本，字数不足时自动重试一次。"""
    print(f"[STORYBOARD] 开始生成分镜脚本：subject={subject}")

    base_prompt = _build_storyboard_prompt(
        subject,
        ppt_context,
        transcribed_text,
        note_markdown,
        weak_points=weak_points,
        image_context=image_context,
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

        raw = llm_complete(
            prompt=prompt,
            temperature=0.65,
            max_tokens=STORYBOARD_MAX_TOKENS,
            timeout=max(STORYBOARD_TIMEOUT, settings.LLM_STORYBOARD_TIMEOUT),
            expect_json=True,
            json_root="array",
            scene="generate_storyboard",
        )
        if not raw.strip():
            raise RuntimeError("大模型未返回分镜脚本")

        storyboard = _normalize_storyboard(_extract_json_array(raw))
        total_chars = sum(
            _storyboard_speech_chars(segment) for segment in storyboard
        )
        total_steps = sum(
            1
            if segment.get("html_code")
            else len(segment.get("step_by_step") or [])
            for segment in storyboard
        )

        print(
            f"[STORYBOARD] 本次生成 {len(storyboard)} 段 / "
            f"{total_steps} 个讲解步骤，口播共 {total_chars} 字"
        )

        if total_chars >= STORYBOARD_MIN_CHARS:
            return storyboard

        last_storyboard = storyboard
        retry_note = (
            f"注意：上一次只生成了 {total_chars} 个中文字符，远低于要求的 "
            f"{STORYBOARD_TARGET_CHARS[0]}-{STORYBOARD_TARGET_CHARS[1]} 字。"
            f"请严格重新生成 {STORYBOARD_MIN_SEGMENTS} 到 "
            f"{STORYBOARD_MAX_SEGMENTS} 个分镜，每个分镜都包含 "
            "speech_intro、html_code、animation_trigger，"
            "把推导过程拆碎讲透，确保 speech_intro 总字数不少于 "
            f"{STORYBOARD_TARGET_CHARS[0]} 字。"
        )

    if last_storyboard is not None:
        logger.warning("分镜脚本字数仍不足，返回最后一次生成结果")
        return last_storyboard

    raise RuntimeError("分镜脚本生成失败")


def _extract_json_object(raw: str) -> dict[str, object]:
    """从模型输出中提取 JSON 对象，兼容代码围栏与前后解释文字。"""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("模型输出中未找到 JSON 对象")

    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("模型输出不是 JSON 对象")
    return data


def _build_remedial_prompt(
    subject: str,
    question: str,
    focus: str,
    lecture_context: str,
    note_context: str,
    retry_note: str = "",
    source: str = "companion",
) -> str:
    retry_part = f"\n{retry_note}\n" if retry_note else ""
    if source == "quiz":
        scene = (
            "学生刚做错了一道随堂小测，心里可能有点受挫。请先安抚，"
            "再用比刚才更耐心、更拆解的方式，把这道题从头讲一遍。"
        )
        question_title = "## 学生做错的题目"
        speech_lead = (
            "先用一句轻松的话安抚学生，明确告诉他这道题确实有坑，"
            "再一步步拆开，不要责备"
        )
    else:
        scene = (
            "伴读小助手把学生的问题递给你了，学生在这个点上卡住了。"
            "请暂停原来的进度，专门补一页动态板书，"
            "用更基础、更具体的方式把这个薄弱点讲透。"
        )
        question_title = "## 学生的问题"
        speech_lead = (
            "自然承接伴读的举手，例如「好，伴读把这个点递给我了，"
            "咱们单独捋一遍」"
        )

    return (
        f"{TEACHER_AUTHOR}\n\n"
        f"你正在 1v1 直播讲授 {subject}。{scene}\n"
        "教学模式：先用一句生活化类比或具体例子破题，再一步步拆开，"
        "最后点出易错点；不要直接堆结论。\n"
        f"{retry_part}"
        "只输出一个 JSON 对象，不要输出解释文字，不要使用代码围栏，"
        "格式如下：\n"
        '{"speech_intro": "这一页的口播", "html_code": "这一页的 HTML+CSS", '
        '"animation_trigger": "触发动画的类名"}\n'
        "字段要求：\n"
        '1. "speech_intro"：180 到 300 个中文字符，'
        f"{speech_lead}，然后直接讲这个点；"
        "不要念标题、章节名或课程名；"
        "不要出现 Markdown、代码符号、LaTeX、括号注释和表情。\n"
        '2. "html_code"：一屏自包含的 HTML+CSS，视觉要求如下：\n'
        "   - 深色极简风：背景 #0f1114 或透明，正文 #e4e4e7，"
        "强调色 #f3c969，代码使用 Cascadia Code 或 monospace；"
        "禁止紫色、蓝色霓虹发光。\n"
        "   - 用 grid 或 flex 做成 16:9 的三尺讲台，字号不小于 18px，留白充足；"
        "只围绕这一个薄弱点，不要重复整节课。\n"
        "   - 目标元素初始隐藏（opacity: 0 等），把 animation_trigger "
        "指定的类加在每一行代码、每一条要点上；"
        "CSS 中写 .trigger.is-active 的动画并保持终态，"
        "用 --i 或 transition-delay 让多行依次写出；"
        "严禁只给整屏大容器加 trigger 类。\n"
        "   - 如有连接线，用 stroke-dasharray 与 stroke-dashoffset，"
        "并在 .trigger.is-active 中写 stroke-dashoffset: 0。\n"
        "   - 只允许内联 CSS 和内联 SVG；禁止 script、iframe、外链、"
        "图片 URL、Google Fonts；HTML 控制在 50 行以内。\n"
        '3. "animation_trigger"：只允许字母、数字和连字符，'
        "必须同时出现在 html_code 的元素 class 和 .trigger.is-active 规则中。\n\n"
        f"## 学生的问题\n{question.strip()[:800]}\n\n"
        f"## 伴读判断的薄弱点\n{focus.strip()[:300] or '学生刚才卡住的知识点'}\n\n"
        f"## 你刚才讲到的内容\n{lecture_context.strip()[:1500] or '（无）'}\n\n"
        f"## 课程笔记节选\n{note_context.strip()[:3000] or '（无）'}\n"
        f"{question_title}\n{question.strip()[:1200]}\n"
    )


def generate_remedial_segment(
    question: str,
    focus: str,
    subject: str,
    lecture_context: str = "",
    note_context: str = "",
    source: str = "companion",
) -> dict[str, str]:
    """主讲李老师针对薄弱点或错题，生成一页补救板书与口播。"""
    retry_note = ""
    for attempt in range(2):
        prompt = _build_remedial_prompt(
            subject=subject,
            question=question,
            focus=focus,
            lecture_context=lecture_context,
            note_context=note_context,
            retry_note=retry_note,
            source=source,
        )
        raw = llm_complete(
            prompt=prompt,
            temperature=0.7,
            max_tokens=STORYBOARD_MAX_TOKENS,
            timeout=max(STORYBOARD_TIMEOUT, settings.LLM_STORYBOARD_TIMEOUT),
            expect_json=True,
            json_root="object",
            scene="generate_remedial",
        )
        if not raw.strip():
            retry_note = "上一次没有返回内容，请严格按 JSON 对象重新输出。"
            continue

        try:
            data = _extract_json_object(raw)
        except (ValueError, json.JSONDecodeError):
            retry_note = (
                "上一次输出不是合法 JSON 对象，请只输出 "
                '{"speech_intro": "...", "html_code": "...", '
                '"animation_trigger": "..."}，不要任何多余文字。'
            )
            continue

        speech_source = HTML_TAG_PATTERN.sub(
            " ", str(data.get("speech_intro") or "")
        )
        speech_intro = _strip_markdown(speech_source)
        html_code = _sanitize_board_html(str(data.get("html_code") or ""))

        if not html_code or not speech_intro or not _is_meaningful_speech(
            speech_intro
        ):
            retry_note = (
                "上一次缺少有效的 speech_intro 或 html_code，"
                "请重新生成完整的一页板书。"
            )
            continue

        trigger = _normalize_trigger(
            data.get("animation_trigger"), html_code
        )
        print(
            f"[REMEDIAL] 生成补救板书：重点={focus[:40]}，"
            f"口播 {len(speech_intro)} 字，HTML {len(html_code)} 字符"
        )
        return {
            "speech_intro": speech_intro[:800],
            "html_code": html_code,
            "animation_trigger": trigger,
        }

    raise RuntimeError("主讲老师暂时没能生成补救板书，请稍后再试")


def process_audio_task(task_id: int) -> None:
    """后台任务：依次处理多个音频，合并文本后交给大模型生成知识框架与分镜。"""
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
            task_image_context = task.image_context or ""
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
            f"课程={task_subject}，PPT 文本 {len(task_ppt_context)} 字符，"
            f"图片上下文 {len(task_image_context)} 字符"
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
                task_image_context,
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
                task_image_context,
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
            weak_points = _load_recent_weak_points(
                task_subject,
                exclude_task_id=task_id,
            )
            if weak_points:
                print(
                    f"[STORYBOARD] 注入 {len(weak_points)} 条历史薄弱点，"
                    "用于第一段复习引入"
                )
            storyboard = _generate_storyboard(
                task_subject,
                task_ppt_context,
                transcribed_text,
                result,
                weak_points=weak_points,
                image_context=task_image_context,
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
