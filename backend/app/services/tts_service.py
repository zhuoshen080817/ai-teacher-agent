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

# 默认使用 v3-flash + longanhuan_v3（龙安欢）。
# 注意：实测 cosyvoice-v2 搭配 longanhuan_v2 会返回 418（模型与音色版本不匹配）；
# 如果确实要回退到 v2，请改用官方 v2 音色 longxiaochun_v2（龙小淳）。
DEFAULT_MODEL = "cosyvoice-v3-flash"
DEFAULT_VOICE = "longanhuan_v3"

# v2 模型下经过验证可用的回退组合
FALLBACK_MODEL = "cosyvoice-v2"
FALLBACK_VOICE = "longxiaochun_v2"

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
MARKDOWN_MARK_PATTERN = re.compile(r"[*_`#>|~]")


def clean_text_for_tts(text: str) -> str:
    """清洗朗读文本：剔除 LaTeX 与 Markdown，避免 CosyVoice 返回 418。"""
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

    # 残留的 LaTeX 命令与符号，例如 \int、\alpha、\frac{}{}
    cleaned = LATEX_COMMAND_PATTERN.sub("", cleaned)
    cleaned = LATEX_RESIDUE_PATTERN.sub("", cleaned)
    cleaned = MARKDOWN_MARK_PATTERN.sub("", cleaned)

    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r"\n{2,}", "\n", cleaned)
    return cleaned.strip()


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


def _adjust_voice_for_model(model: str, voice: str) -> str:
    """按模型版本校正音色后缀，并处理已知不兼容的 longanhuan_v2。"""
    if model.startswith("cosyvoice-v3"):
        if voice.startswith("longanhuan") and voice != "longanhuan_v3":
            logger.warning(
                "[TTS] v3 模型不支持音色 %s，自动切换为 longanhuan_v3",
                voice,
            )
            return "longanhuan_v3"
        if voice.endswith("_v2"):
            aligned = f"{voice[:-3]}_v3"
            logger.warning(
                "[TTS] 模型 %s 需要 v3 音色，音色 %s 自动对齐为 %s",
                model,
                voice,
                aligned,
            )
            return aligned
        return voice

    if model == "cosyvoice-v2":
        # longanhuan_v2 虽带 _v2 后缀，但 v2 引擎不支持，实测返回 418
        if voice.startswith("longanhuan"):
            logger.warning(
                "[TTS] cosyvoice-v2 不支持 %s（DashScope 418），"
                "自动回退到 %s",
                voice,
                FALLBACK_VOICE,
            )
            return FALLBACK_VOICE
        if voice.endswith("_v3"):
            aligned = f"{voice[:-3]}_v2"
            logger.warning(
                "[TTS] 模型 %s 需要 v2 音色，音色 %s 自动对齐为 %s",
                model,
                voice,
                aligned,
            )
            return aligned
        return voice

    return voice


def resolve_tts_config(voice_override: str | None = None) -> tuple[str, str]:
    """返回实际用于合成的 (model, voice)，保证模型与音色版本匹配。"""
    model = (os.getenv("COSYVOICE_MODEL") or DEFAULT_MODEL).strip()
    raw_voice = (
        voice_override
        or os.getenv("COSYVOICE_VOICE")
        or DEFAULT_VOICE
    ).strip()

    return model, _adjust_voice_for_model(model, raw_voice)


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


def _fallback_config(model: str) -> tuple[str, str] | None:
    """当前组合失败时，换另一组已验证可用的组合。"""
    if model.startswith("cosyvoice-v3"):
        return FALLBACK_MODEL, FALLBACK_VOICE
    if model == FALLBACK_MODEL:
        return DEFAULT_MODEL, DEFAULT_VOICE
    return None


def _friendly_error(model: str, voice: str, error: Exception) -> str:
    message = str(error)
    hint = ""
    if "418" in message or "InvalidParameter" in message:
        hint = (
            "；请检查模型与音色版本是否匹配：cosyvoice-v2 使用 longxiaochun_v2 等 "
            "v2 官方音色，cosyvoice-v3-flash 使用 longanhuan_v3 等 _v3 音色"
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
    except Exception as exc:  # noqa: BLE001 首次合成失败时尝试回退组合
        logger.warning(
            "[TTS] CosyVoice 首次合成失败：model=%s, voice=%s, chars=%s, error=%s",
            model,
            selected_voice,
            len(normalized),
            exc,
        )
        print(f"[TTS] 合成失败：model={model}, voice={selected_voice}, error={exc}")

        fallback = _fallback_config(model)
        if fallback is None:
            raise RuntimeError(
                _friendly_error(model, selected_voice, exc)
            ) from exc

        fb_model, fb_voice = fallback
        if (fb_model, fb_voice) == (model, selected_voice):
            raise RuntimeError(
                _friendly_error(model, selected_voice, exc)
            ) from exc

        logger.warning(
            "[TTS] 尝试回退组合：%s/%s -> %s/%s",
            model,
            selected_voice,
            fb_model,
            fb_voice,
        )
        print(
            f"[TTS] 回退合成：model={fb_model}, voice={fb_voice}, "
            f"speed={speech_rate:.2f}"
        )

        try:
            audio = _call_cosyvoice(
                fb_model,
                fb_voice,
                normalized,
                api_key,
                speech_rate,
            )
        except Exception as fb_exc:  # noqa: BLE001 回退仍失败
            logger.exception(
                "[TTS] 回退组合仍失败：model=%s, voice=%s",
                fb_model,
                fb_voice,
            )
            print(
                f"[TTS] 回退失败：model={fb_model}, voice={fb_voice}, "
                f"error={fb_exc}"
            )
            raise RuntimeError(
                _friendly_error(fb_model, fb_voice, fb_exc)
            ) from fb_exc

        model, selected_voice = fb_model, fb_voice
        cache_key = hashlib.sha256(
            f"{model}|{selected_voice}|{normalized}".encode("utf-8")
        ).hexdigest()

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
