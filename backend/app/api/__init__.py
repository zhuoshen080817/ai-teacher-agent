"""API 路由汇总。"""

from fastapi import APIRouter

from app.api.routes import chat, favorites, health, task, tts, upload

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(upload.router)
api_router.include_router(task.router)
api_router.include_router(favorites.router)
api_router.include_router(chat.router)
api_router.include_router(tts.router)
