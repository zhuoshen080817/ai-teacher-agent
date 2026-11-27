"""上传接口：PPT 课件解析、多音频上传与合并任务创建。"""

import json
import logging
import math
import re
import shutil
import time
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.database import get_db
from app.models.task import Task
from app.services.audio_processing import process_audio_task
from app.services.ppt_parser import extract_ppt_text
from app.services.vision_service import parse_images

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
PPT_EXTENSION = ".pptx"
SUBJECT_MAX_LENGTH = 128
IMAGE_MAX_SIZE = 20 * 1024 * 1024
IMAGE_MAX_COUNT = 12
CHUNK_SIZE = 1024 * 1024
UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024
CHUNK_ROOT = settings.UPLOAD_DIR / ".chunks"
CHUNK_SESSION_MAX_AGE = 24 * 60 * 60
UPLOAD_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")

logger = logging.getLogger(__name__)

router = APIRouter(tags=["upload"])


def _max_upload_label() -> str:
    """把单文件上限格式化为 1.5GB / 800MB 这样的展示文案。"""
    size_gb = settings.MAX_UPLOAD_SIZE / (1024 * 1024 * 1024)
    if size_gb >= 1:
        return f"{size_gb:g}GB"
    return f"{settings.MAX_UPLOAD_SIZE // (1024 * 1024)}MB"


def _cleanup_files(paths: list[Path]) -> None:
    for path in paths:
        path.unlink(missing_ok=True)


def _normalize_subject(subject: str | None) -> str:
    normalized = (subject or "").strip()
    if not normalized:
        return "通用课程"
    return normalized[:SUBJECT_MAX_LENGTH]


def _build_task_filename(original_names: list[str]) -> str:
    if not original_names:
        return "未命名音频"

    if len(original_names) == 1:
        return original_names[0][:255]

    first = original_names[0][:200]
    return f"{first} 等 {len(original_names)} 个文件"


@router.post("/upload_ppt")
async def upload_ppt(
    file: UploadFile = File(...),
    subject: str = Form("通用课程"),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    original_name = file.filename or ""
    if Path(original_name).suffix.lower() != PPT_EXTENSION:
        await file.close()
        raise HTTPException(
            status_code=400,
            detail="仅支持 .pptx 格式的 PPT 课件",
        )

    try:
        content = await file.read(settings.MAX_UPLOAD_SIZE + 1)
    finally:
        await file.close()

    if len(content) > settings.MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"PPT 文件大小不能超过 {_max_upload_label()}",
        )

    try:
        ppt_text = extract_ppt_text(content)
    except Exception as exc:  # noqa: BLE001 PPT 解析异常需转为 400
        logger.exception("PPT 解析失败：%s", original_name)
        raise HTTPException(
            status_code=400,
            detail=f"PPT 解析失败：{exc}",
        ) from exc

    if not ppt_text:
        raise HTTPException(
            status_code=400,
            detail="PPT 中没有提取到文字内容，请检查文件",
        )

    normalized_subject = _normalize_subject(subject)
    task = Task(
        filename=f"PPT 课件：{original_name}"[:255],
        filepath="",
        filepaths=json.dumps([], ensure_ascii=False),
        subject=normalized_subject,
        ppt_context=ppt_text,
        status="pending",
        progress=0,
        status_message="PPT 已解析，等待上传音频…",
    )

    try:
        db.add(task)
        db.commit()
        db.refresh(task)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("PPT 任务记录保存失败：%s", original_name)
        raise HTTPException(
            status_code=500,
            detail="PPT 任务保存失败，请稍后重试",
        ) from exc

    print(
        f"[PPT] 已解析课件 {original_name}："
        f"{len(ppt_text)} 个字符，task_id={task.id}"
    )

    return {
        "task_id": task.id,
        "filename": task.filename,
        "subject": task.subject,
        "status": task.status,
        "ppt_chars": len(ppt_text),
    }


@router.post("/upload")
async def upload_audio(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    task_id: int | None = Form(default=None),
    subject: str = Form(default="通用课程"),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if not files:
        raise HTTPException(
            status_code=400,
            detail="请至少上传一个音频文件",
        )

    upload_dir = settings.UPLOAD_DIR
    upload_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    saved_paths: list[Path] = []
    original_names: list[str] = []
    relative_paths: list[str] = []

    try:
        for index, file in enumerate(files, start=1):
            original_name = file.filename or f"audio_{index}"
            suffix = Path(original_name).suffix.lower()

            if suffix not in ALLOWED_EXTENSIONS:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"第 {index} 个文件（{original_name}）格式不支持，"
                        "仅支持 mp3、wav、m4a"
                    ),
                )

            stem = re.sub(r"[^\w\-]", "_", Path(original_name).stem) or "audio"
            stored_name = f"{timestamp}_{index:02d}_{stem}{suffix}"
            dest_path = upload_dir / stored_name
            saved_paths.append(dest_path)

            total_size = 0
            try:
                with dest_path.open("wb") as buffer:
                    while chunk := await file.read(CHUNK_SIZE):
                        total_size += len(chunk)
                        if total_size > settings.MAX_UPLOAD_SIZE:
                            raise HTTPException(
                                status_code=413,
                                detail=(
                                    f"第 {index} 个文件（{original_name}）"
                                    f"大小不能超过 {_max_upload_label()}"
                                ),
                            )
                        buffer.write(chunk)
            except HTTPException:
                raise
            except OSError as exc:
                logger.exception("音频文件保存失败：%s", dest_path)
                raise HTTPException(
                    status_code=500,
                    detail=f"第 {index} 个文件保存失败，请稍后重试",
                ) from exc
            finally:
                await file.close()

            original_names.append(original_name)
            relative_paths.append(
                dest_path.relative_to(settings.BASE_DIR).as_posix()
            )
    except HTTPException:
        _cleanup_files(saved_paths)
        raise
    except Exception as exc:  # noqa: BLE001 上传过程异常时清理已保存文件
        _cleanup_files(saved_paths)
        logger.exception("批量音频上传失败")
        raise HTTPException(
            status_code=500,
            detail="音频上传失败，请稍后重试",
        ) from exc

    normalized_subject = _normalize_subject(subject)
    task_filename = _build_task_filename(original_names)
    filepaths_json = json.dumps(relative_paths, ensure_ascii=False)

    if task_id is not None:
        task = db.get(Task, task_id)
        if task is None:
            _cleanup_files(saved_paths)
            raise HTTPException(
                status_code=404,
                detail=f"任务 {task_id} 不存在，无法关联 PPT 上下文",
            )

        task.filename = task_filename
        task.filepath = relative_paths[0]
        task.filepaths = filepaths_json
        task.subject = normalized_subject
        task.status = "pending"
        task.progress = 0
        task.status_message = "音频已上传，等待开始处理…"
        task.result = None
        print(
            f"[UPLOAD] 关联已有任务 {task.id}："
            f"subject={normalized_subject}, "
            f"ppt={'有' if task.ppt_context else '无'}"
        )
    else:
        task = Task(
            filename=task_filename,
            filepath=relative_paths[0],
            filepaths=filepaths_json,
            subject=normalized_subject,
            status="pending",
            progress=0,
            status_message="音频已上传，等待开始处理…",
        )

    try:
        db.add(task)
        db.commit()
        db.refresh(task)
    except SQLAlchemyError as exc:
        db.rollback()
        _cleanup_files(saved_paths)
        logger.exception("任务记录保存失败：%s", task_filename)
        raise HTTPException(
            status_code=500,
            detail="任务记录保存失败，请稍后重试",
        ) from exc

    background_tasks.add_task(process_audio_task, task.id)

    return {
        "task_id": task.id,
        "filename": task.filename,
        "subject": task.subject,
        "status": task.status,
        "file_count": len(relative_paths),
    }


class ChunkInitRequest(BaseModel):
    filename: str
    size: int


class AudioFinalizeRequest(BaseModel):
    upload_ids: list[str]
    task_id: int | None = None
    subject: str = "通用课程"


class PptFinalizeRequest(BaseModel):
    upload_id: str
    subject: str = "通用课程"


class ImagesFinalizeRequest(BaseModel):
    upload_ids: list[str]
    task_id: int | None = None
    subject: str = "通用课程"


def _session_dir(upload_id: str) -> Path:
    if not UPLOAD_ID_PATTERN.match(upload_id or ""):
        raise HTTPException(status_code=404, detail="上传会话不存在")
    return CHUNK_ROOT / upload_id


def _meta_path(upload_id: str) -> Path:
    return _session_dir(upload_id) / "meta.json"


def _load_meta(upload_id: str) -> dict[str, object]:
    path = _meta_path(upload_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="上传会话不存在或已过期")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail="上传会话数据损坏，请重新上传",
        ) from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="上传会话数据损坏")
    return data


def _write_meta(upload_id: str, meta: dict[str, object]) -> None:
    path = _meta_path(upload_id)
    path.write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _cleanup_stale_sessions() -> None:
    if not CHUNK_ROOT.is_dir():
        return
    now = time.time()
    for item in CHUNK_ROOT.iterdir():
        try:
            if (
                item.is_dir()
                and now - item.stat().st_mtime > CHUNK_SESSION_MAX_AGE
            ):
                shutil.rmtree(item, ignore_errors=True)
        except OSError:
            continue


def _sanitize_stem(filename: str) -> str:
    return re.sub(r"[^\w\-]", "_", Path(filename).stem) or "upload"


def _received_chunks(session_dir: Path, total_chunks: int) -> list[int]:
    received: list[int] = []
    for index in range(total_chunks):
        path = session_dir / f"{index:05d}.part"
        if path.is_file():
            received.append(index)
    return received


def _merge_chunks(
    session_dir: Path,
    destination: Path,
    total_chunks: int,
) -> None:
    with destination.open("wb") as target:
        for index in range(total_chunks):
            chunk_path = session_dir / f"{index:05d}.part"
            with chunk_path.open("rb") as source:
                shutil.copyfileobj(source, target, length=1024 * 1024)


def _create_audio_task(
    db: Session,
    relative_paths: list[str],
    original_names: list[str],
    subject: str,
    task_id: int | None,
) -> Task:
    normalized_subject = _normalize_subject(subject)
    task_filename = _build_task_filename(original_names)
    filepaths_json = json.dumps(relative_paths, ensure_ascii=False)

    if task_id is not None:
        task = db.get(Task, task_id)
        if task is None:
            raise HTTPException(
                status_code=404,
                detail=f"任务 {task_id} 不存在，无法关联 PPT 上下文",
            )
        task.filename = task_filename
        task.filepath = relative_paths[0]
        task.filepaths = filepaths_json
        task.subject = normalized_subject
        task.status = "pending"
        task.progress = 0
        task.status_message = "音频已合并，等待后台预处理…"
        task.result = None
    else:
        task = Task(
            filename=task_filename,
            filepath=relative_paths[0],
            filepaths=filepaths_json,
            subject=normalized_subject,
            status="pending",
            progress=0,
            status_message="音频已合并，等待后台预处理…",
        )

    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.post("/upload/chunk/init")
def init_chunk_upload(payload: ChunkInitRequest) -> dict[str, object]:
    """创建一个分片上传会话，返回服务端分片大小。"""
    filename = payload.filename.strip()
    suffix = Path(filename).suffix.lower()
    if (
        suffix not in ALLOWED_EXTENSIONS
        and suffix not in IMAGE_EXTENSIONS
        and suffix != PPT_EXTENSION
    ):
        raise HTTPException(
            status_code=400,
            detail="仅支持 mp3、wav、m4a 音频、pptx 课件或常见图片格式",
        )
    if payload.size <= 0:
        raise HTTPException(status_code=400, detail="文件不能为空")

    max_size = (
        IMAGE_MAX_SIZE
        if suffix in IMAGE_EXTENSIONS
        else settings.MAX_UPLOAD_SIZE
    )
    if payload.size > max_size:
        detail = (
            "单张图片不能超过 20MB"
            if suffix in IMAGE_EXTENSIONS
            else f"文件大小不能超过 {_max_upload_label()}"
        )
        raise HTTPException(status_code=413, detail=detail)

    total_chunks = math.ceil(payload.size / UPLOAD_CHUNK_SIZE)
    if total_chunks > 4096:
        raise HTTPException(status_code=413, detail="文件分片数量过多")

    CHUNK_ROOT.mkdir(parents=True, exist_ok=True)
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    _cleanup_stale_sessions()

    upload_id = uuid4().hex
    session_dir = CHUNK_ROOT / upload_id
    session_dir.mkdir(parents=True, exist_ok=True)

    meta: dict[str, object] = {
        "upload_id": upload_id,
        "filename": filename[:255],
        "suffix": suffix,
        "size": payload.size,
        "chunk_size": UPLOAD_CHUNK_SIZE,
        "total_chunks": total_chunks,
        "completed": False,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    _write_meta(upload_id, meta)

    return {
        "upload_id": upload_id,
        "chunk_size": UPLOAD_CHUNK_SIZE,
        "total_chunks": total_chunks,
        "filename": meta["filename"],
        "size": payload.size,
        "kind": (
            "ppt"
            if suffix == PPT_EXTENSION
            else "image"
            if suffix in IMAGE_EXTENSIONS
            else "audio"
        ),
    }


@router.post("/upload/chunk/{upload_id}/part/{index}")
async def upload_chunk(
    upload_id: str,
    index: int,
    request: Request,
) -> dict[str, object]:
    """接收单个文件分片；同一分片重复上传会覆盖，支持安全重试。"""
    meta = _load_meta(upload_id)
    session_dir = _session_dir(upload_id)

    total_chunks = int(meta["total_chunks"])
    chunk_size = int(meta["chunk_size"])
    size = int(meta["size"])

    if meta.get("completed"):
        raise HTTPException(status_code=400, detail="该文件已上传完成")
    if index < 0 or index >= total_chunks:
        raise HTTPException(status_code=400, detail="分片序号不合法")

    expected = min(chunk_size, size - index * chunk_size)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError:
            declared_length = None
        if declared_length is not None and declared_length != expected:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"分片大小不正确：期望 {expected} 字节，"
                    f"实际 {declared_length} 字节"
                ),
            )

    body = await request.body()
    if len(body) != expected:
        raise HTTPException(
            status_code=413,
            detail=(
                f"分片大小不正确：期望 {expected} 字节，"
                f"实际 {len(body)} 字节"
            ),
        )

    chunk_path = session_dir / f"{index:05d}.part"
    try:
        await run_in_threadpool(chunk_path.write_bytes, body)
    except OSError as exc:
        logger.exception("分片写入失败：%s", chunk_path)
        raise HTTPException(
            status_code=500,
            detail="分片保存失败，请重试",
        ) from exc

    received = _received_chunks(session_dir, total_chunks)
    return {
        "upload_id": upload_id,
        "index": index,
        "received": len(body),
        "received_chunks": len(received),
        "total_chunks": total_chunks,
    }


@router.post("/upload/chunk/{upload_id}/complete")
async def complete_chunk_upload(upload_id: str) -> dict[str, object]:
    """校验所有分片并合并为最终文件。"""
    meta = _load_meta(upload_id)
    session_dir = _session_dir(upload_id)

    stored_path = str(meta.get("stored_path") or "")
    if meta.get("completed") and stored_path:
        return {
            "upload_id": upload_id,
            "filename": meta["filename"],
            "size": meta["size"],
            "completed": True,
            "stored_path": stored_path,
        }

    total_chunks = int(meta["total_chunks"])
    expected_size = int(meta["size"])
    received = _received_chunks(session_dir, total_chunks)
    received_set = set(received)
    missing = [
        index
        for index in range(total_chunks)
        if index not in received_set
    ]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"分片不完整，缺少 {len(missing)} 个分片",
        )

    actual_size = sum(
        (session_dir / f"{index:05d}.part").stat().st_size
        for index in range(total_chunks)
    )
    if actual_size != expected_size:
        raise HTTPException(
            status_code=400,
            detail=(
                f"文件大小校验失败：期望 {expected_size} 字节，"
                f"实际 {actual_size} 字节"
            ),
        )

    suffix = str(meta["suffix"])
    stem = _sanitize_stem(str(meta["filename"]))
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    stored_name = f"{timestamp}_{upload_id[:10]}_{stem}{suffix}"
    destination = settings.UPLOAD_DIR / stored_name

    try:
        await run_in_threadpool(
            _merge_chunks,
            session_dir,
            destination,
            total_chunks,
        )
    except OSError as exc:
        destination.unlink(missing_ok=True)
        logger.exception("分片合并失败：%s", upload_id)
        raise HTTPException(
            status_code=500,
            detail="文件合并失败，请重新上传",
        ) from exc

    relative_path = destination.relative_to(settings.BASE_DIR).as_posix()
    meta["completed"] = True
    meta["stored_path"] = relative_path
    meta["stored_name"] = stored_name
    meta["completed_at"] = datetime.now().isoformat(timespec="seconds")
    _write_meta(upload_id, meta)

    print(
        f"[CHUNK] 合并完成：{meta['filename']}，"
        f"{total_chunks} 个分片，{actual_size} 字节"
    )

    return {
        "upload_id": upload_id,
        "filename": meta["filename"],
        "size": actual_size,
        "completed": True,
        "stored_path": relative_path,
    }


@router.post("/upload/finalize")
def finalize_chunked_audio(
    payload: AudioFinalizeRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """音频分片全部合并后创建任务，并立即启动后台预处理。"""
    upload_ids = list(
        dict.fromkeys(item.strip() for item in payload.upload_ids if item.strip())
    )
    if not upload_ids:
        raise HTTPException(status_code=400, detail="缺少上传会话")

    relative_paths: list[str] = []
    original_names: list[str] = []

    for upload_id in upload_ids:
        meta = _load_meta(upload_id)
        if not meta.get("completed") or not meta.get("stored_path"):
            raise HTTPException(
                status_code=400,
                detail="存在尚未完成的分片上传",
            )
        if str(meta.get("suffix")) not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="上传会话不是音频文件",
            )
        relative_paths.append(str(meta["stored_path"]))
        original_names.append(str(meta["filename"]))

    try:
        task = _create_audio_task(
            db=db,
            relative_paths=relative_paths,
            original_names=original_names,
            subject=payload.subject,
            task_id=payload.task_id,
        )
    except HTTPException:
        db.rollback()
        _cleanup_files(
            [settings.BASE_DIR / path for path in relative_paths]
        )
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        _cleanup_files(
            [settings.BASE_DIR / path for path in relative_paths]
        )
        logger.exception("分片上传任务保存失败")
        raise HTTPException(
            status_code=500,
            detail="任务记录保存失败，请稍后重试",
        ) from exc

    background_tasks.add_task(process_audio_task, task.id)

    for upload_id in upload_ids:
        shutil.rmtree(_session_dir(upload_id), ignore_errors=True)

    print(
        f"[UPLOAD] 分片上传完成，任务 {task.id}，"
        f"{len(relative_paths)} 个音频，后台预处理已启动"
    )

    return {
        "task_id": task.id,
        "filename": task.filename,
        "subject": task.subject,
        "status": task.status,
        "file_count": len(relative_paths),
        "preprocess_started": True,
    }


@router.post("/upload_ppt/finalize")
async def finalize_chunked_ppt(
    payload: PptFinalizeRequest,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """PPT 分片合并后解析文字并创建待处理任务。"""
    meta = _load_meta(payload.upload_id)
    if str(meta.get("suffix")) != PPT_EXTENSION:
        raise HTTPException(status_code=400, detail="上传会话不是 PPT 文件")
    if not meta.get("completed") or not meta.get("stored_path"):
        raise HTTPException(status_code=400, detail="PPT 分片尚未上传完成")

    merged_path = settings.BASE_DIR / str(meta["stored_path"])
    try:
        content = await run_in_threadpool(merged_path.read_bytes)
    except OSError as exc:
        logger.exception("读取合并 PPT 失败：%s", merged_path)
        raise HTTPException(
            status_code=500,
            detail="PPT 文件读取失败，请重新上传",
        ) from exc

    original_name = str(meta["filename"])
    try:
        ppt_text = extract_ppt_text(content)
    except Exception as exc:  # noqa: BLE001 PPT 解析异常需转为 400
        merged_path.unlink(missing_ok=True)
        shutil.rmtree(_session_dir(payload.upload_id), ignore_errors=True)
        logger.exception("PPT 解析失败：%s", original_name)
        raise HTTPException(
            status_code=400,
            detail=f"PPT 解析失败：{exc}",
        ) from exc

    if not ppt_text:
        merged_path.unlink(missing_ok=True)
        shutil.rmtree(_session_dir(payload.upload_id), ignore_errors=True)
        raise HTTPException(
            status_code=400,
            detail="PPT 中没有提取到文字内容，请检查文件",
        )

    normalized_subject = _normalize_subject(payload.subject)
    task = Task(
        filename=f"PPT 课件：{original_name}"[:255],
        filepath="",
        filepaths=json.dumps([], ensure_ascii=False),
        subject=normalized_subject,
        ppt_context=ppt_text,
        status="pending",
        progress=0,
        status_message="PPT 已解析，等待上传音频…",
    )

    try:
        db.add(task)
        db.commit()
        db.refresh(task)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("PPT 任务记录保存失败：%s", original_name)
        raise HTTPException(
            status_code=500,
            detail="PPT 任务保存失败，请稍后重试",
        ) from exc
    finally:
        merged_path.unlink(missing_ok=True)
        shutil.rmtree(_session_dir(payload.upload_id), ignore_errors=True)

    print(
        f"[PPT] 分片上传完成 {original_name}："
        f"{len(ppt_text)} 个字符，task_id={task.id}"
    )

    return {
        "task_id": task.id,
        "filename": task.filename,
        "subject": task.subject,
        "status": task.status,
        "ppt_chars": len(ppt_text),
    }


@router.post("/upload_images/finalize")
async def finalize_chunked_images(
    payload: ImagesFinalizeRequest,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """图片分片合并后调用视觉模型，生成 image_context 并写入任务。"""
    upload_ids = list(
        dict.fromkeys(item.strip() for item in payload.upload_ids if item.strip())
    )
    if not upload_ids:
        raise HTTPException(status_code=400, detail="缺少图片上传会话")
    if len(upload_ids) > IMAGE_MAX_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"一次最多上传 {IMAGE_MAX_COUNT} 张图片",
        )

    images: list[tuple[Path, str]] = []
    for upload_id in upload_ids:
        meta = _load_meta(upload_id)
        suffix = str(meta.get("suffix"))
        if suffix not in IMAGE_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="上传会话不是支持的图片格式",
            )
        if not meta.get("completed") or not meta.get("stored_path"):
            raise HTTPException(
                status_code=400,
                detail="存在尚未完成的图片分片上传",
            )
        images.append(
            (
                settings.BASE_DIR / str(meta["stored_path"]),
                str(meta["filename"]),
            )
        )

    try:
        image_context = await run_in_threadpool(parse_images, images)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 视觉解析异常统一返回 502
        logger.exception("图片视觉解析失败")
        raise HTTPException(
            status_code=502,
            detail="图片解析服务暂时不可用，请稍后重试",
        ) from exc

    if not image_context.strip():
        raise HTTPException(
            status_code=400,
            detail="图片中没有提取到有效内容",
        )

    normalized_subject = _normalize_subject(payload.subject)

    if payload.task_id is not None:
        task = db.get(Task, payload.task_id)
        if task is None:
            raise HTTPException(
                status_code=404,
                detail=f"任务 {payload.task_id} 不存在，无法关联图片上下文",
            )
        existing = (task.image_context or "").strip()
        task.image_context = (
            f"{existing}\n\n{image_context}"[:30000]
            if existing
            else image_context
        )
        if not task.subject or task.subject == "通用课程":
            task.subject = normalized_subject
        if task.status == "pending":
            task.status_message = "图片已解析，等待上传音频…"
    else:
        task = Task(
            filename=f"补充图片：{len(images)} 张"[:255],
            filepath="",
            filepaths=json.dumps([], ensure_ascii=False),
            subject=normalized_subject,
            image_context=image_context,
            status="pending",
            progress=0,
            status_message="图片已解析，等待上传音频…",
        )
        db.add(task)

    try:
        db.commit()
        db.refresh(task)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("图片上下文保存失败")
        raise HTTPException(
            status_code=500,
            detail="图片解析结果保存失败，请稍后重试",
        ) from exc

    for path, _ in images:
        path.unlink(missing_ok=True)
    for upload_id in upload_ids:
        shutil.rmtree(_session_dir(upload_id), ignore_errors=True)

    print(
        f"[VISION] 图片解析完成：{len(images)} 张，"
        f"{len(image_context)} 字符，task_id={task.id}"
    )

    return {
        "task_id": task.id,
        "filename": task.filename,
        "subject": task.subject,
        "status": task.status,
        "image_count": len(images),
        "image_chars": len(image_context),
    }
