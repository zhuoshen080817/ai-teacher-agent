"""板书收藏与错题记录接口。"""

import json
import logging
from datetime import datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.task import Task
from app.services.audio_processing import (
    _normalize_trigger,
    _sanitize_board_html,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["favorites"])

MOCK_TASK_FILENAME = "演示课程 · 板书收藏"


class FavoriteCreateRequest(BaseModel):
    segment_id: int = 0
    title: str = ""
    subject: str = "通用课程"
    speech_intro: str = ""
    html_code: str = ""
    animation_trigger: str = "reveal-1"
    board_content: str = ""
    source: str = "segment"


class WrongQuestionRequest(BaseModel):
    segment_id: int = 0
    question: str
    options: list[str] = []
    correct_answer: str = ""
    chosen_answer: str = ""
    topic: str = ""
    subject: str = "通用课程"


def _parse_list(raw: str | None) -> list[dict[str, object]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _ensure_task(
    db: Session,
    task_id: int,
    subject: str,
    filename: str,
) -> Task:
    """真实任务直接返回；task_id=0 时创建演示收藏专用任务。"""
    task = db.get(Task, task_id)
    if task is not None:
        return task

    if task_id != 0:
        raise HTTPException(status_code=404, detail="任务不存在")

    task = Task(
        id=0,
        filename=MOCK_TASK_FILENAME,
        filepath="",
        subject=subject or "通用课程",
        status="completed",
        progress=100,
        result="",
        favorites="[]",
        wrong_questions="[]",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _clean_subject(value: str) -> str:
    return value.strip() or "通用课程"


@router.post("/tasks/{task_id}/favorites")
def create_favorite(
    task_id: int,
    payload: FavoriteCreateRequest,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """收藏当前板书：保存 HTML、动画触发器与口播，支持后续动态回放。"""
    subject = _clean_subject(payload.subject)
    html_code = _sanitize_board_html(payload.html_code)
    board_content = payload.board_content.strip()[:2000]

    if not html_code and not board_content:
        raise HTTPException(
            status_code=400,
            detail="当前板书没有可收藏的内容",
        )

    task = _ensure_task(db, task_id, subject, MOCK_TASK_FILENAME)
    favorites = _parse_list(task.favorites)

    title = payload.title.strip()[:80]
    if not title:
        title = (
            f"板书片段 {payload.segment_id}"
            if payload.segment_id
            else "课堂板书"
        )

    trigger = (
        _normalize_trigger(payload.animation_trigger, html_code)
        if html_code
        else ""
    )

    saved_at = datetime.now().isoformat(timespec="seconds")
    favorite_id = f"{task.id}-{uuid4().hex[:12]}"

    # 同一屏重复收藏时只更新快照，避免列表里出现完全相同的两条
    existing = next(
        (
            item
            for item in favorites
            if item.get("segment_id") == payload.segment_id
            and item.get("html_code") == html_code
            and item.get("source") == payload.source
        ),
        None,
    )

    if existing is not None:
        existing.update(
            {
                "title": title,
                "subject": subject,
                "speech_intro": payload.speech_intro.strip()[:800],
                "board_content": board_content,
                "saved_at": saved_at,
            }
        )
        favorite = existing
    else:
        favorite = {
            "favorite_id": favorite_id,
            "task_id": task.id,
            "segment_id": payload.segment_id,
            "title": title,
            "subject": subject,
            "speech_intro": payload.speech_intro.strip()[:800],
            "html_code": html_code[:12000],
            "animation_trigger": trigger,
            "board_content": board_content,
            "source": payload.source.strip()[:24] or "segment",
            "saved_at": saved_at,
        }
        favorites.append(favorite)

    favorites = favorites[-80:]
    task.favorites = json.dumps(favorites, ensure_ascii=False)
    if not task.subject or task.subject == "通用课程":
        task.subject = subject
    db.commit()

    return {
        "favorite": favorite,
        "count": len(favorites),
        "task_id": task.id,
    }


@router.get("/favorites")
def list_favorites(
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    """返回所有收藏的板书快照，按收藏时间倒序。"""
    tasks = db.scalars(
        select(Task)
        .where(Task.favorites.is_not(None))
        .order_by(Task.id.desc())
        .limit(100)
    ).all()

    items: list[dict[str, object]] = []
    for task in tasks:
        for favorite in _parse_list(task.favorites):
            items.append(
                {
                    **favorite,
                    "task_id": task.id,
                    "filename": task.filename,
                    "task_subject": task.subject,
                }
            )

    items.sort(
        key=lambda item: str(item.get("saved_at") or ""),
        reverse=True,
    )
    return items[:100]


@router.delete("/favorites/{favorite_id}")
def delete_favorite(
    favorite_id: str,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """删除一条收藏。"""
    tasks = db.scalars(
        select(Task).where(Task.favorites.is_not(None))
    ).all()

    for task in tasks:
        favorites = _parse_list(task.favorites)
        remaining = [
            item
            for item in favorites
            if str(item.get("favorite_id") or "") != favorite_id
        ]
        if len(remaining) != len(favorites):
            task.favorites = json.dumps(remaining, ensure_ascii=False)
            db.commit()
            return {"deleted": True, "favorite_id": favorite_id}

    raise HTTPException(status_code=404, detail="收藏不存在")


@router.post("/tasks/{task_id}/wrong_questions")
def record_wrong_question(
    task_id: int,
    payload: WrongQuestionRequest,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    """记录一道错题，供下次生成课件时做个性化薄弱点引入。"""
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="题目不能为空")

    subject = _clean_subject(payload.subject)
    task = _ensure_task(db, task_id, subject, MOCK_TASK_FILENAME)
    wrong_questions = _parse_list(task.wrong_questions)

    existing = next(
        (
            item
            for item in wrong_questions
            if item.get("question") == question
            and item.get("segment_id") == payload.segment_id
        ),
        None,
    )

    item = {
        "question": question[:300],
        "options": [
            str(option).strip()[:160]
            for option in payload.options
            if str(option).strip()
        ][:4],
        "correct_answer": payload.correct_answer.strip().upper()[:1],
        "chosen_answer": payload.chosen_answer.strip().upper()[:1],
        "topic": payload.topic.strip()[:120],
        "segment_id": payload.segment_id,
        "subject": subject,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }

    if existing is not None:
        existing.update(item)
    else:
        wrong_questions.append(item)

    wrong_questions = wrong_questions[-100:]
    task.wrong_questions = json.dumps(
        wrong_questions, ensure_ascii=False
    )
    db.commit()

    return {
        "saved": True,
        "count": len(wrong_questions),
        "weak_point": item,
    }
