"""DashScope CosyVoice 语音合成服务。"""

import hashlib
import logging
import os
import re
import threading
from collections import OrderedDict

import dashscope
from dotenv import load_dotenv
from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer

from app.config import settings

load_dotenv(settings.BASE_DIR / ".env")

logger = logging.getLogger(__name__)

# 固定使用 v3-flash + longanhuan_v3（龙安欢），不再回退到 v2。
# 实测 cosyvoice-v2 / longxiaochun_v2 在当前文本上会触发 418，因此彻底移除回退。
DEFAULT_MODEL = "cosyvoice-v3-flash"
DEFAULT_VOICE = "longanhuan_v3"

# 音色显示名，供前端展示；未收录的音色直接显示 voice id
VOICE_DISPLAY_NAMES = {
    "longanhuan_v3": "龙安欢",
    "longanhuan_v2": "龙安欢",
    "longxiaochun_v2": "龙小淳",
    "longxiaoxia_v2": "龙小夏",
    "longxiaocheng_v2": "龙小诚",
    "longyuan_v2": "龙媛",
}

TTS_FORMAT = AudioFormat.WAV_16000HZ_MONO_16BIT
TTS_MAX_CHARS = 1000
TTS_MIN_MEANINGFUL_CHARS = 2
TTS_CACHE_LIMIT = 40
TTS_SPEED_MIN = 0.5
TTS_SPEED_MAX = 2.0

_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_lock = threading.Lock()

CODE_FENCE_PATTERN = re.compile(r"```[\s\S]*?```")
BLOCK_MATH_PATTERN = re.compile(r"\$\$[\s\S]*?\$\$")
INLINE_MATH_PATTERN = re.compile(r"\$[^$\n]{1,300}\$")
LATEX_COMMAND_PATTERN = re.compile(r"\\[A-Za-z]+")
LATEX_RESIDUE_PATTERN = re.compile(r"[\\{}$^_~]")
MARKDOWN_MARK_PATTERN = re.compile(r"[*_`#>~]")
MEANINGFUL_CHAR_PATTERN = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]")
SYMBOL_ONLY_LINE_PATTERN = re.compile(
    r"^[\s\-—–_=+*#.,，。;；:：!！?？、|/\\()（）\[\]【】<>《》\"'“”‘’…·`~]+$"
)


def clean_text_for_tts(text: str) -> str:
    """清洗朗读文本：剔除 LaTeX、Markdown 与纯符号行，避免 CosyVoice 418。"""
    if not text:
        return ""

    cleaned = CODE_FENCE_PATTERN.sub("，请看屏幕上的代码。", text)
    cleaned = BLOCK_MATH_PATTERN.sub("，请看屏幕上的公式。", cleaned)
    cleaned = INLINE_MATH_PATTERN.sub("这个表达式", cleaned)

    cleaned = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", cleaned)
    cleaned = re.sub(
        r"^\s{0,3}#{1,6}\s*", "", cleaned, flags=re.MULTILINE
    )
    cleaned = re.sub(r"^\s*[-*+]\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*\d+\.\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*>\s?", "", cleaned, flags=re.MULTILINE)

    # 表格竖线改为停顿，避免朗读成一串「竖线」（只处理行内空白，保留换行）
    cleaned = re.sub(r"[ \t]*\|[ \t]*", "，", cleaned)

    # 残留的 LaTeX 命令与符号，例如 \int、\alpha、\frac{}{}
    cleaned = LATEX_COMMAND_PATTERN.sub("", cleaned)
    cleaned = LATEX_RESIDUE_PATTERN.sub("", cleaned)
    cleaned = MARKDOWN_MARK_PATTERN.sub("", cleaned)

    # 丢弃纯符号行、空行，以及清洗后没有任何文字/数字的行
    lines: list[str] = []
    for line in cleaned.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if SYMBOL_ONLY_LINE_PATTERN.fullmatch(stripped):
            continue
        if not MEANINGFUL_CHAR_PATTERN.search(stripped):
            continue
        lines.append(stripped)

    cleaned = "\n".join(lines)
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{2,}", "\n", cleaned)
    return cleaned.strip()


def is_tts_text_usable(text: str) -> bool:
    """清洗后是否仍值得调用 TTS：纯符号或极短文本直接跳过，避免 418。"""
    normalized = " ".join(clean_text_for_tts(text).split())
    if not normalized:
        return False
    return (
        len(MEANINGFUL_CHAR_PATTERN.findall(normalized))
        >= TTS_MIN_MEANINGFUL_CHARS
    )


def _patch_wav_header(audio: bytes) -> bytes:
    """CosyVoice 流式 WAV 的长度字段是占位值，修正后浏览器才能正确识别时长。"""
    if len(audio) <= 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return audio
    if audio[36:40] != b"data":
        return audio

    fixed = bytearray(audio)
    fixed[4:8] = (len(audio) - 8).to_bytes(4, "little")
    fixed[40:44] = (len(audio) - 44).to_bytes(4, "little")
    return bytes(fixed)


def _voice_display_name(voice: str) -> str:
    return VOICE_DISPLAY_NAMES.get(voice, voice)


def resolve_tts_config(voice_override: str | None = None) -> tuple[str, str]:
    """固定返回 v3-flash + longanhuan_v3，彻底避免回退到 v2 触发 418。"""
    if voice_override and voice_override.strip() not in {"", DEFAULT_VOICE}:
        logger.warning(
            "[TTS] 忽略请求音色 %s，强制使用 %s",
            voice_override,
            DEFAULT_VOICE,
        )
    return DEFAULT_MODEL, DEFAULT_VOICE


def get_tts_info() -> dict[str, str]:
    """前端展示用的当前音色信息。"""
    model, voice = resolve_tts_config()
    return {
        "model": model,
        "voice": voice,
        "display_name": _voice_display_name(voice),
    }


def _get_cache(key: str) -> bytes | None:
    with _cache_lock:
        value = _cache.get(key)
        if value is not None:
            _cache.move_to_end(key)
        return value


def _set_cache(key: str, audio: bytes) -> None:
    with _cache_lock:
        _cache[key] = audio
        _cache.move_to_end(key)
        while len(_cache) > TTS_CACHE_LIMIT:
            _cache.popitem(last=False)


def _call_cosyvoice(
    model: str,
    voice: str,
    text: str,
    api_key: str,
    speed: float = 1.0,
) -> bytes:
    dashscope.api_key = api_key
    synthesizer = SpeechSynthesizer(
        model=model,
        voice=voice,
        format=TTS_FORMAT,
        speech_rate=speed,
    )
    return synthesizer.call(text)


def _friendly_error(model: str, voice: str, error: Exception) -> str:
    message = str(error)
    hint = ""
    if "418" in message or "InvalidParameter" in message:
        hint = (
            "；当前固定使用 cosyvoice-v3-flash / longanhuan_v3，"
            "请确认文本清洗后仍包含有效的中文或英文内容"
        )
    return (
        f"语音合成失败（model={model}, voice={voice}）：{message}{hint}"
    )


def synthesize_speech(
    text: str,
    voice: str | None = None,
    speed: float = 1.0,
) -> bytes:
    """把文本合成为 16kHz 单声道 WAV，支持原生语速，并在进程内做 LRU 缓存。"""
    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "未配置 DASHSCOPE_API_KEY，请在 backend/.env 中设置后重试"
        )

    try:
        speech_rate = float(speed)
    except (TypeError, ValueError):
        speech_rate = 1.0
    speech_rate = min(TTS_SPEED_MAX, max(TTS_SPEED_MIN, speech_rate))

    normalized = " ".join(clean_text_for_tts(text).split())
    if not normalized:
        raise ValueError("文本清洗后没有可朗读内容")
    if len(normalized) > TTS_MAX_CHARS:
        raise ValueError(f"单段合成文本不能超过 {TTS_MAX_CHARS} 个字符")

    model, selected_voice = resolve_tts_config(voice)

    cache_key = hashlib.sha256(
        f"{model}|{selected_voice}|{speech_rate:.2f}|{normalized}".encode("utf-8")
    ).hexdigest()
    cached = _get_cache(cache_key)
    if cached is not None:
        print(f"[TTS] 命中缓存：{len(normalized)} 个字符")
        return cached

    print(
        f"[TTS] 开始合成：model={model}, voice={selected_voice}, "
        f"speed={speech_rate:.2f}, chars={len(normalized)}（原始 {len(text)}）"
    )

    try:
        audio = _call_cosyvoice(
            model, selected_voice, normalized, api_key, speech_rate
        )
    except Exception as exc:  # noqa: BLE001 固定 v3 合成失败直接报错，不再回退 v2
        logger.warning(
            "[TTS] CosyVoice 合成失败：model=%s, voice=%s, chars=%s, error=%s",
            model,
            selected_voice,
            len(normalized),
            exc,
        )
        print(
            f"[TTS] 合成失败：model={model}, voice={selected_voice}, "
            f"error={exc}"
        )
        raise RuntimeError(
            _friendly_error(model, selected_voice, exc)
        ) from exc

    if not audio:
        logger.error(
            "[TTS] CosyVoice 未返回音频：model=%s, voice=%s, chars=%s",
            model,
            selected_voice,
            len(normalized),
        )
        raise RuntimeError(
            f"CosyVoice 未返回音频数据（model={model}, voice={selected_voice}）"
        )

    audio = _patch_wav_header(audio)
    _set_cache(cache_key, audio)

    print(
        f"[TTS] 合成完成：model={model}, voice={selected_voice}, "
        f"{len(audio)} 字节"
    )
    return audio
