"""语音合成接口。"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from starlette.responses import Response

from app.services.tts_service import get_tts_info, synthesize_speech

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tts"])


class TtsRequest(BaseModel):
    text: str
    voice: str | None = None
    speed: float = 1.0


@router.get("/tts/info")
def tts_info() -> dict[str, str]:
    """返回当前实际使用的模型、音色与显示名，供前端展示。"""
    return get_tts_info()


@router.post("/tts")
def tts(payload: TtsRequest) -> Response:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="合成文本不能为空")

    if not 0.5 <= payload.speed <= 2.0:
        raise HTTPException(
            status_code=400,
            detail="语速必须在 0.5 到 2.0 之间",
        )

    try:
        audio = synthesize_speech(text, payload.voice, payload.speed)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.error("[TTS] 合成失败：%s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 合成服务异常统一返回 502
        logger.exception("[TTS] 未预期的合成异常")
        raise HTTPException(
            status_code=502,
            detail="语音合成服务暂时不可用，请稍后再试",
        ) from exc

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "Content-Length": str(len(audio)),
        },
    )
