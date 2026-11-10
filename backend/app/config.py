"""应用配置。

统一从环境变量读取，未设置时使用适合本地开发的默认值。
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings:
    PROJECT_NAME: str = "课堂录音智能整理 Agent"
    API_PREFIX: str = "/api"
    BASE_DIR: Path = BASE_DIR

    # 上传音频的存储目录
    UPLOAD_DIR: Path = BASE_DIR / "app" / "uploads"
    # 单文件上限，默认 1.5GB，可通过环境变量 MAX_UPLOAD_SIZE_MB 调整
    MAX_UPLOAD_SIZE: int = int(os.getenv("MAX_UPLOAD_SIZE_MB", "1536")) * 1024 * 1024

    # SQLite 数据库文件位于 backend 目录下
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        f"sqlite:///{(BASE_DIR / 'app.db').as_posix()}",
    )

    # 前端 Vite 开发服务器默认端口为 5173
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


settings = Settings()
