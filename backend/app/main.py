"""FastAPI 应用入口。

启动方式（在 backend 目录下）：
    uvicorn app.main:app --reload
"""

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.api import api_router
from app.config import settings
from app.database import Base, engine, ensure_task_columns
from app import models  # noqa: F401  确保模型已注册到 Base.metadata

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    ensure_task_columns()
    yield


app = FastAPI(title=settings.PROJECT_NAME, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(SQLAlchemyError)
async def handle_database_error(
    request: Request,
    exc: SQLAlchemyError,
) -> JSONResponse:
    logger.exception("数据库操作失败: %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500, content={"detail": "数据库操作失败，请稍后重试"}
    )


@app.exception_handler(Exception)
async def handle_unexpected_error(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    logger.exception("未处理的服务异常: %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500, content={"detail": "服务内部错误，请稍后重试"}
    )


app.include_router(api_router, prefix=settings.API_PREFIX)
