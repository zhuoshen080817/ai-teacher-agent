"""左侧智能助手与直播间答疑的 DeepSeek 对话服务。"""

import json
import os
import random

from dotenv import load_dotenv
from openai import OpenAI

from app.config import settings
from app.services.persona import TEACHER_PERSONA

load_dotenv(settings.BASE_DIR / ".env")

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"
REQUEST_TIMEOUT = 60.0

# 兜底只在模型调用失败时使用，正常情况全部由大模型现场生成
CUE_FALLBACKS = {
    "interrupt": [
        "同学，怎么啦？李老师在这儿呢。",
        "哎，先停一下，有什么想说的？",
        "怎么啦？来，慢慢说，李老师听着。",
        "是不是哪儿卡住了？跟李老师说说。",
        "举手啦，那咱们先聊聊你的事。",
    ],
    "resume": [
        "要继续刚才的内容吗？",
        "那咱们接着刚才的往下讲？",
        "准备好继续了吗？",
        "要不要回到刚才那块硬骨头？",
        "歇好了咱们就接着来，行吗？",
    ],
}


def _client() -> OpenAI:
    api_key = os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "未配置 DEEPSEEK_API_KEY，请在 backend/.env 中设置后重试"
        )
    return OpenAI(
        api_key=api_key,
        base_url=DEEPSEEK_BASE_URL,
        timeout=REQUEST_TIMEOUT,
    )


def _complete(
    system_prompt: str,
    user_parts: list[str],
    temperature: float,
    max_tokens: int | None = None,
) -> str:
    completion = _client().chat.completions.create(
        model=DEEPSEEK_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "\n\n".join(user_parts)},
        ],
        temperature=temperature,
        **({"max_tokens": max_tokens} if max_tokens else {}),
    )
    content = completion.choices[0].message.content or ""
    if not content.strip():
        raise RuntimeError("大模型返回内容为空")
    return content.strip()


def chat_with_context(
    message: str,
    subject: str = "通用课程",
    note_context: str | None = None,
) -> str:
    system_prompt = (
        f"{TEACHER_PERSONA}\n\n"
        f"现在你在课后答疑区和学生复习 {subject} 的课堂内容。"
        "回答要准确、有温度，像面对面聊天一样自然；必要时可以用 Markdown 排版，"
        "但开场白要根据问题本身现场组织，不要使用固定套话。\n"
        "特别注意：如果学生问的是基础概念、定义，或者明显理解偏了，"
        "先温和地点出小误区再解释，不要无脑夸奖；"
        "只有当问题确实有深度、问到难点时，才可以真诚地肯定。"
        "如果提供了当前复习笔记，请优先基于笔记回答；"
        "笔记中没有的信息不要编造，可以明确说明。"
    )

    user_parts: list[str] = []
    if note_context and note_context.strip():
        user_parts.append(f"## 当前复习笔记\n{note_context.strip()}")
    user_parts.append(f"## 用户问题\n{message.strip()}")

    return _complete(system_prompt, user_parts, temperature=0.85)


def ask_teacher(
    user_question: str,
    context: str = "",
    subject: str = "通用课程",
) -> dict[str, str]:
    """直播间举手打断：先识别意图，再由大模型生成现场口语回应。"""
    system_prompt = (
        f"{TEACHER_PERSONA}\n\n"
        f"你正在 1v1 直播讲授 {subject}，学生刚刚举手打断了你。"
        "请先判断他的意图，再给出回应。\n"
        "意图只有四种：\n"
        "- pause：学生要离开、休息、等你、稍后再继续，"
        "例如「我要去上厕所」「等我一下」「先停一下」；\n"
        "- slow_down：学生希望你放慢语速或讲细一点；\n"
        "- speed_up：学生希望你讲快一点、恢复正常语速；\n"
        "- question：学生在问与课程内容有关的问题。\n"
        "只输出一个 JSON 对象，不要使用代码围栏，格式如下：\n"
        '{"intent": "pause 或 slow_down 或 speed_up 或 question", "answer": "你的回应"}\n'
        "回答要求：\n"
        "1. pause：用你自己的话回应，20 到 50 个字，可以幽默一点，"
        "比如让他快去快回、你正好喝口水，并明确你会在原地等他，"
        "准备好随时继续；不要只说「好的」；\n"
        "2. slow_down / speed_up：用你自己的话答应他，20 到 50 个字，"
        "slow_down 要安抚他别急、你会跟着他的节奏讲，"
        "speed_up 要表示明白、会把节奏提起来；\n"
        "3. question：先判断问题类型，再决定开场反应：\n"
        "   · 如果问的是基础概念、定义，或者明显理解偏了："
        "先用轻松的语气点出小误区，例如「哈哈，这里可能有个小误区，"
        "其实不是这样的哦，咱们换个角度想」，再温和纠正；"
        "严禁说「问到了关键点」「这个问题很有深度」；\n"
        "   · 如果确实问到难点、易错点或深层原因：才可以真诚肯定，"
        "例如「这个问题很有深度」「哎，你问到了核心痛点」；\n"
        "   · 无论哪种，开场反应都必须结合问题内容，句式每次不同，"
        "严禁无脑夸奖，也严禁对所有问题都用同一句开场白；"
        "然后只讲 2 到 3 句话给出结论或类比，"
        "必须优先依据【你刚才正在讲的内容】；"
        "问题超出当前内容时，用一句话说明稍后展开；\n"
        "4. 四种意图的回答都必须像真人现场说话，不要 Markdown、"
        "代码块、列表符号、括号注释或表情。"
    )

    user_parts: list[str] = []
    if context.strip():
        user_parts.append(f"## 你刚才正在讲的内容\n{context.strip()}")
    user_parts.append(f"## 学生说的话\n{user_question.strip()}")

    raw = _complete(system_prompt, user_parts, temperature=0.9)

    intent = "question"
    answer = raw

    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            data = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            data = None

        if isinstance(data, dict):
            raw_intent = str(data.get("intent") or "").strip().lower()
            if raw_intent in {"pause", "slow_down", "speed_up", "question"}:
                intent = raw_intent
            candidate = str(data.get("answer") or "").strip()
            if candidate:
                answer = candidate

    return {"intent": intent, "answer": answer}


def explain_again(
    board_content: str,
    step_speech: str,
    subject: str = "通用课程",
) -> str:
    """学生点「没听懂」时，换一种比喻或切入角度重新解释。"""
    system_prompt = (
        f"{TEACHER_PERSONA}\n\n"
        f"你正在 1v1 直播讲授 {subject}。学生刚刚说没听懂你讲的这一步。"
        "要求：\n"
        "1. 开头先主动把责任揽过来，表达「是我的锅，我没讲清楚」的意思，"
        "但不要每次都用一模一样的句子；\n"
        "2. 必须换一种全新的比喻或切入角度，绝对不能重复原来的说法；"
        "如果原来的讲法比较抽象，就换一个更具体、更生活化的例子；\n"
        "3. 举一反三，只讲 3 到 5 句话，适合直接朗读；\n"
        "4. 不要 Markdown、代码块、列表符号、括号注释或表情。"
    )

    user_parts: list[str] = []
    if board_content.strip():
        user_parts.append(f"## 屏幕上的板书\n{board_content.strip()[:1500]}")
    if step_speech.strip():
        user_parts.append(f"## 你刚才的讲法（这次必须换掉）\n{step_speech.strip()}")
    user_parts.append("## 学生的反馈\n没听懂，请再讲讲。")

    return _complete(system_prompt, user_parts, temperature=0.95)


QUIZ_KIND_LABELS = {
    "correct": "答对了",
    "wrong": "答错了",
    "guess": "蒙对了",
}


def quiz_feedback(
    question: str,
    options: list[str],
    correct_answer: str,
    chosen_answer: str,
    kind: str,
    subject: str = "通用课程",
) -> str:
    """随堂小测的现场反馈：表扬、安慰或调侃，全部由大模型生成。"""
    option_lines = "\n".join(
        f"{chr(65 + index)}. {option}" for index, option in enumerate(options)
    )
    kind_label = QUIZ_KIND_LABELS.get(kind, "答对了")

    system_prompt = (
        f"{TEACHER_PERSONA}\n\n"
        f"你正在 1v1 直播讲授 {subject}，学生刚做完一道随堂小测。"
        "请根据答题情况现场生成一段口语反馈，只输出这段话本身。\n"
        "要求：\n"
        "- 答对：先给一个夸张但真诚的表扬，力度参考「漂亮！这题直接拿捏！」，"
        "但每次都要换新说法，再用一句话点出为什么对，2 到 3 句；\n"
        "- 答错：先安慰学生，明确告诉他这题确实有坑、当年你也错过，"
        "再指出错误原因并讲清正确思路，3 到 5 句，绝不责备；\n"
        "- 蒙对：先幽默调侃他运气好，比如运气也是实力的一部分，"
        "再补讲原理，2 到 4 句；\n"
        "开场白必须和这次答题情况相关，禁止套话；"
        "不要 Markdown、列表符号、括号注释或表情，适合直接朗读。"
    )

    user_parts = [
        f"## 题目\n{question.strip()}",
        f"## 选项\n{option_lines}",
        f"## 正确答案\n{correct_answer}",
        f"## 学生的选择\n{chosen_answer or '未作答'}",
        f"## 答题情况\n{kind_label}",
    ]

    return _complete(system_prompt, user_parts, temperature=0.95)


def teacher_cue(
    event: str,
    context: str = "",
    subject: str = "通用课程",
) -> str:
    """生成直播间现场串场语，例如「同学，怎么啦？」「要继续吗？」。"""
    if event == "interrupt":
        scene = (
            "学生刚刚举手打断，你要用一句自然、亲切的话问他怎么了，"
            "可以带一点幽默，15 到 40 个字，每次说法都必须不同。"
        )
    else:
        scene = (
            "你刚回答完学生的问题，要用一句自然的问话确认他要不要继续刚才的内容，"
            "15 到 40 个字，可以换着花样说，每次都必须不同。"
        )

    system_prompt = (
        f"{TEACHER_PERSONA}\n\n"
        f"你正在 1v1 直播讲授 {subject}。{scene}"
        "只输出这句话本身，不要解释，不要引号。"
    )

    user_parts: list[str] = []
    if context.strip():
        user_parts.append(f"## 你刚才正在讲的内容\n{context.strip()[:600]}")
    user_parts.append("## 任务\n请生成这一句现场串场语。")

    try:
        text = _complete(system_prompt, user_parts, temperature=1.15, max_tokens=120)
        text = text.strip().strip("「」\"'“”")
        if text:
            return text
    except Exception:  # noqa: BLE001 串场语失败不能让打断流程中断
        pass

    return random.choice(CUE_FALLBACKS.get(event, CUE_FALLBACKS["resume"]))
