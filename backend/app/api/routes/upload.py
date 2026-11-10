"""上传接口：PPT 课件解析、多音频上传与合并任务创建。"""

import json
import logging
import re
from datetime import datetime
from pathlib import Path

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.task import Task
from app.services.audio_processing import process_audio_task
from app.services.ppt_parser import extract_ppt_text

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a"}
PPT_EXTENSION = ".pptx"
SUBJECT_MAX_LENGTH = 128
CHUNK_SIZE = 1024 * 1024

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
