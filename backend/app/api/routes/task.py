"""任务查询接口。"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.task import Task

logger = logging.getLogger(__name__)

router = APIRouter(tags=["task"])

MOCK_DATA_PATH = settings.BASE_DIR.parent / "mock_data.json"


def _parse_storyboard(raw: str | None) -> list[dict[str, object]]:
    """把数据库里的分镜 JSON 解析为数组；旧任务返回空数组。"""
    if not raw:
        return []

    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []

    return data if isinstance(data, list) else []


@router.get("/mock_task")
def get_mock_task() -> dict[str, object]:
    """免上传测试数据：直接返回项目根目录的 mock_data.json。"""
    if not MOCK_DATA_PATH.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"未找到测试数据文件：{MOCK_DATA_PATH}",
        )

    try:
        data = json.loads(MOCK_DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("读取 mock_data.json 失败")
        raise HTTPException(
            status_code=500,
            detail="mock_data.json 读取失败，请检查 JSON 格式",
        ) from exc

    if not isinstance(data, dict):
        raise HTTPException(
            status_code=500,
            detail="mock_data.json 顶层必须是对象",
        )

    storyboard = data.get("storyboard")
    if not isinstance(storyboard, list):
        raise HTTPException(
            status_code=500,
            detail="mock_data.json 缺少 storyboard 数组",
        )

    return {
        "task_id": data.get("task_id", 0),
        "filename": data.get("filename", "测试数据"),
        "subject": data.get("subject", "通用课程"),
        "status": "completed",
        "result": data.get("result", ""),
        "storyboard": storyboard,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }


@router.get("/tasks")
def list_tasks(
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    """按创建时间倒序返回最近的任务，用于前端历史记录。"""
    tasks = db.scalars(
        select(Task).order_by(Task.id.desc()).limit(limit)
    ).all()

    return [
        {
            "task_id": task.id,
            "filename": task.filename,
            "status": task.status,
            "created_at": task.created_at.isoformat(),
        }
        for task in tasks
    ]


@router.get("/task/{task_id}")
def get_task(task_id: int, db: Session = Depends(get_db)) -> dict[str, object]:
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")

    return {
        "task_id": task.id,
        "filename": task.filename,
        "filepath": task.filepath,
        "status": task.status,
        "subject": task.subject,
        "progress": task.progress,
        "status_message": task.status_message,
        "result": task.result,
        "storyboard": _parse_storyboard(task.storyboard),
        "created_at": task.created_at.isoformat(),
    }
