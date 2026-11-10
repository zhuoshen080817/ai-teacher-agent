"""PPTX 文本提取。"""

from io import BytesIO

from pptx import Presentation


def extract_ppt_text(content: bytes) -> str:
    """提取 PPT 每页文本框、表格与备注中的文字。"""
    presentation = Presentation(BytesIO(content))
    sections: list[str] = []

    for index, slide in enumerate(presentation.slides, start=1):
        lines: list[str] = []

        for shape in slide.shapes:
            if shape.has_text_frame:
                text = shape.text_frame.text.strip()
                if text:
                    lines.append(text)

            if shape.has_table:
                for row in shape.table.rows:
                    cells = [
                        cell.text.strip()
                        for cell in row.cells
                    ]
                    if any(cells):
                        lines.append(" | ".join(cells))

        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                lines.append(f"[备注] {notes}")

        if lines:
            sections.append(
                f"## 第 {index} 页\n" + "\n".join(lines)
            )

    return "\n\n".join(sections).strip()
