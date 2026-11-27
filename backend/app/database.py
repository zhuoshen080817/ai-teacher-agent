"""数据库连接与会话管理。"""

from collections.abc import Generator

from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

connect_args = (
    {"check_same_thread": False}
    if settings.DATABASE_URL.startswith("sqlite")
    else {}
)

engine = create_engine(settings.DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：提供请求级数据库会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_task_columns() -> None:
    """为已存在的 SQLite 数据库补齐新增列（create_all 不会修改旧表）。"""
    inspector = inspect(engine)
    if "tasks" not in inspector.get_table_names():
        return

    existing = {column["name"] for column in inspector.get_columns("tasks")}
    additions = {
        "favorites": "TEXT",
        "wrong_questions": "TEXT",
        "image_context": "TEXT",
    }

    with engine.begin() as connection:
        for name, column_type in additions.items():
            if name not in existing:
                connection.exec_driver_sql(
                    f"ALTER TABLE tasks ADD COLUMN {name} {column_type}"
                )
