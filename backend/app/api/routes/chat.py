"""智能助手对话接口。"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.chat_service import (
    ask_teacher,
    chat_with_context,
    explain_again,
    quiz_feedback,
    teacher_cue,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    subject: str = "通用课程"
    note_context: str | None = None


class AskTeacherRequest(BaseModel):
    user_question: str
    context: str | None = None
    subject: str = "通用课程"


class ExplainAgainRequest(BaseModel):
    board_content: str = ""
    step_speech: str = ""
    subject: str = "通用课程"


class QuizFeedbackRequest(BaseModel):
    question: str
    options: list[str]
    correct_answer: str
    chosen_answer: str = ""
    kind: str
    subject: str = "通用课程"


class TeacherCueRequest(BaseModel):
    event: str
    context: str | None = None
    subject: str = "通用课程"


@router.post("/chat")
def chat(payload: ChatRequest) -> dict[str, str]:
    message = payload.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    if len(message) > 2000:
        raise HTTPException(
            status_code=400,
            detail="单条消息不能超过 2000 个字符",
        )

    try:
        reply = chat_with_context(
            message=message,
            subject=payload.subject.strip() or "通用课程",
            note_context=payload.note_context,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 对话服务异常统一返回 502
        logger.exception("对话服务调用失败")
        raise HTTPException(
            status_code=502,
            detail="对话服务暂时不可用，请稍后再试",
        ) from exc

    return {"reply": reply}


@router.post("/ask_teacher")
def ask_teacher_route(payload: AskTeacherRequest) -> dict[str, str]:
    """直播间举手打断：识别意图并生成简短语音回答。"""
    question = payload.user_question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="问题内容不能为空")

    if len(question) > 1000:
        raise HTTPException(
            status_code=400,
            detail="单次提问不能超过 1000 个字符",
        )

    try:
        result = ask_teacher(
            user_question=question,
            context=(payload.context or "").strip(),
            subject=payload.subject.strip() or "通用课程",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 答疑服务异常统一返回 502
        logger.exception("直播间答疑服务调用失败")
        raise HTTPException(
            status_code=502,
            detail="答疑服务暂时不可用，请稍后再试",
        ) from exc

    return result


@router.post("/explain_again")
def explain_again_route(payload: ExplainAgainRequest) -> dict[str, str]:
    """学生点「没听懂，再讲讲」：换一种更通俗的讲法重新解释当前步骤。"""
    board_content = payload.board_content.strip()
    step_speech = payload.step_speech.strip()
    if not board_content and not step_speech:
        raise HTTPException(
            status_code=400,
            detail="缺少当前板书或讲解内容，无法重新解释",
        )

    try:
        explanation = explain_again(
            board_content=board_content,
            step_speech=step_speech,
            subject=payload.subject.strip() or "通用课程",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 重讲服务异常统一返回 502
        logger.exception("重新解释服务调用失败")
        raise HTTPException(
            status_code=502,
            detail="重新解释服务暂时不可用，请稍后再试",
        ) from exc

    return {"explanation": explanation}


@router.post("/quiz_feedback")
def quiz_feedback_route(payload: QuizFeedbackRequest) -> dict[str, str]:
    """随堂小测作答后的现场反馈，由大模型根据答题情况动态生成。"""
    kind = payload.kind.strip().lower()
    if kind not in {"correct", "wrong", "guess"}:
        raise HTTPException(status_code=400, detail="答题情况不合法")

    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="题目不能为空")

    try:
        reply = quiz_feedback(
            question=question,
            options=[option.strip() for option in payload.options if option.strip()],
            correct_answer=payload.correct_answer.strip().upper(),
            chosen_answer=payload.chosen_answer.strip().upper(),
            kind=kind,
            subject=payload.subject.strip() or "通用课程",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 反馈服务异常统一返回 502
        logger.exception("随堂小测反馈生成失败")
        raise HTTPException(
            status_code=502,
            detail="随堂小测反馈暂时不可用，请稍后再试",
        ) from exc

    return {"reply": reply}


@router.post("/teacher_cue")
def teacher_cue_route(payload: TeacherCueRequest) -> dict[str, str]:
    """直播现场串场语（举手问候 / 继续确认），每次由大模型换着说。"""
    event = payload.event.strip().lower()
    if event not in {"interrupt", "resume"}:
        raise HTTPException(status_code=400, detail="串场事件类型不合法")

    try:
        text = teacher_cue(
            event=event,
            context=(payload.context or "").strip(),
            subject=payload.subject.strip() or "通用课程",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"text": text}
