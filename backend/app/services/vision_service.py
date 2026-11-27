"""学生补充图片解析：默认走 Gemini 多模态，失败时自动降级阿里云 qwen-vl。"""

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from app.services.llm_service import llm_analyze_image

logger = logging.getLogger(__name__)

VISION_TIMEOUT = 120.0
IMAGE_PARSE_MAX_WORKERS = 3
IMAGE_CONTEXT_LIMIT = 30000

IMAGE_PROMPT = (
    "请提取这张图片中的所有文字信息，并描述图片的核心内容"
    "（如果是题目，请把题干和图表信息描述清楚）。"
)


def _parse_one(image_path: Path) -> str:
    return llm_analyze_image(
        image_path,
        IMAGE_PROMPT,
        timeout=VISION_TIMEOUT,
    )


def parse_images(
    images: list[tuple[Path, str]],
) -> str:
    """并发解析多张图片，按上传顺序拼接为 image_context。"""
    if not images:
        return ""

    results: dict[int, str] = {}
    errors: dict[int, str] = {}

    workers = min(IMAGE_PARSE_MAX_WORKERS, len(images))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {
            executor.submit(_parse_one, path): index
            for index, (path, _) in enumerate(images)
        }
        for future in as_completed(future_map):
            index = future_map[future]
            filename = images[index][1]
            try:
                results[index] = future.result()
                print(f"[VISION] 图片解析完成：{filename}")
            except Exception as exc:  # noqa: BLE001 单张失败不影响其他图片
                errors[index] = str(exc)
                logger.warning("图片解析失败：%s，%s", filename, exc)

    if not results:
        first_error = next(iter(errors.values()), "未知错误")
        raise RuntimeError(f"图片解析失败：{first_error}")

    sections: list[str] = []
    for index, (_, filename) in enumerate(images):
        text = results.get(index)
        if text:
            sections.append(f"【图片 {index + 1}｜{filename}】\n{text}")
        else:
            reason = errors.get(index, "解析失败")
            sections.append(
                f"【图片 {index + 1}｜{filename}】\n"
                f"（该图片解析失败：{reason}）"
            )

    return "\n\n".join(sections)[:IMAGE_CONTEXT_LIMIT]
