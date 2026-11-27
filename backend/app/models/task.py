"""课堂录音处理任务。"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    filepath: Mapped[str] = mapped_column(String(512), nullable=False)
    filepaths: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        default="通用课程",
        server_default="通用课程",
    )
    ppt_context: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_context: Mapped[str | None] = mapped_column(Text, nullable=True)
    storyboard: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending", server_default="pending"
    )
    progress: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    status_message: Mapped[str | None] = mapped_column(
        String(255), nullable=True
    )
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    favorites: Mapped[str | None] = mapped_column(Text, nullable=True)
    wrong_questions: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
