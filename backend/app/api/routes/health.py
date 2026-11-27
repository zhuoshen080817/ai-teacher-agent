"""健康检查路由。"""

from fastapi import APIRouter

from app.services.llm_service import (
    get_active_gemini_model,
    get_active_provider_name,
    get_active_vision_provider_name,
)

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, str]:
    try:
        llm_provider = get_active_provider_name()
    except Exception:  # noqa: BLE001 配置异常时健康检查仍需响应
        llm_provider = "invalid"

    try:
        vision_provider = get_active_vision_provider_name()
    except Exception:  # noqa: BLE001
        vision_provider = "invalid"

    return {
        "status": "ok",
        "llm_provider": llm_provider,
        "vision_provider": vision_provider,
        "gemini_model": get_active_gemini_model(),
    }
