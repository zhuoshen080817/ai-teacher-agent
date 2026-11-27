"""统一大模型调度与多模态路由服务（策略模式 + 工厂路由 + 重试与自动降级）。"""

from __future__ import annotations

import logging
import mimetypes
import os
import time
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import TypeVar

import httpx
from dashscope import MultiModalConversation
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from openai import APIStatusError, APITimeoutError, OpenAI

from app.config import settings  # noqa: F401 确保 .env 已加载

logger = logging.getLogger(__name__)

T = TypeVar("T")

SUPPORTED_LLM_PROVIDERS = {"gemini", "deepseek"}
SUPPORTED_VISION_PROVIDERS = {"gemini", "dashscope"}
RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
NON_RETRYABLE_STATUS_CODES = {400, 401, 403, 404}
DEFAULT_VISION_MODELS = [
    "qwen3-vl-plus",
    "qwen-vl-plus-latest",
    "qwen-vl-max-latest",
]
IMAGE_MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
}


class LLMConfigError(RuntimeError):
    """缺少 API Key 或模型提供方配置无效等不可重试的配置错误。"""


def get_active_provider_name() -> str:
    """动态读取当前启用的文本大模型提供方（gemini / deepseek）。"""
    raw = os.getenv("LLM_PROVIDER", settings.LLM_PROVIDER).strip().lower()
    if raw in SUPPORTED_LLM_PROVIDERS:
        return raw
    if not raw:
        return "gemini"
    raise LLMConfigError(
        f"不支持的 LLM_PROVIDER={raw}，请配置为 gemini 或 deepseek"
    )


def get_active_vision_provider_name() -> str:
    """动态读取当前启用的视觉解析提供方（默认 gemini，支持配置为 dashscope）。"""
    raw = os.getenv("VISION_PROVIDER", settings.VISION_PROVIDER).strip().lower()
    if not raw:
        return "gemini"
    if raw in SUPPORTED_VISION_PROVIDERS:
        return raw
    raise LLMConfigError(
        f"不支持的 VISION_PROVIDER={raw}，请配置为 gemini 或 dashscope"
    )


def _is_fallback_enabled() -> bool:
    raw = os.getenv("LLM_FALLBACK_ENABLED", "").strip().lower()
    if not raw:
        return settings.LLM_FALLBACK_ENABLED
    return raw not in {"0", "false", "no", "off"}


def _get_max_retries() -> int:
    raw = os.getenv("LLM_MAX_RETRIES", "").strip()
    if not raw:
        return settings.LLM_MAX_RETRIES
    try:
        return max(1, int(raw))
    except ValueError:
        return settings.LLM_MAX_RETRIES


def _get_default_timeout() -> float:
    raw = os.getenv("LLM_TIMEOUT", "").strip()
    if not raw:
        return settings.LLM_TIMEOUT
    try:
        return max(5.0, float(raw))
    except ValueError:
        return settings.LLM_TIMEOUT


def get_active_gemini_model() -> str:
    """动态读取当前配置的 Gemini 模型名称（默认 gemini-4-hydrogen）。"""
    return (
        os.getenv("GEMINI_MODEL", settings.GEMINI_MODEL).strip()
        or "gemini-4-hydrogen"
    )


def _get_gemini_model() -> str:
    return get_active_gemini_model()


def _get_deepseek_model() -> str:
    return (
        os.getenv("DEEPSEEK_MODEL", settings.DEEPSEEK_MODEL).strip()
        or "deepseek-chat"
    )


def _get_deepseek_base_url() -> str:
    return (
        os.getenv("DEEPSEEK_BASE_URL", settings.DEEPSEEK_BASE_URL).strip()
        or "https://api.deepseek.com"
    )


def _get_vision_models() -> list[str]:
    custom = os.getenv("VISION_MODEL", "").strip()
    models = list(dict.fromkeys([custom, *DEFAULT_VISION_MODELS]))
    return [model for model in models if model]


def _extract_status_code(exc: Exception) -> int | None:
    for attr in ("status_code", "code"):
        val = getattr(exc, attr, None)
        if isinstance(val, int):
            return val
    response = getattr(exc, "response", None)
    if response is not None:
        status = getattr(response, "status_code", None)
        if isinstance(status, int):
            return status
    return None


def _is_retryable_error(exc: Exception) -> bool:
    """判断异常是否属于网络抖动、超时或服务端瞬时错误。"""
    if isinstance(exc, LLMConfigError):
        return False

    status_code = _extract_status_code(exc)
    if status_code is not None:
        if status_code in NON_RETRYABLE_STATUS_CODES:
            return False
        if status_code in RETRYABLE_STATUS_CODES or status_code >= 500:
            return True

    if isinstance(
        exc,
        (
            TimeoutError,
            ConnectionError,
            OSError,
            httpx.TimeoutException,
            httpx.TransportError,
            APITimeoutError,
        ),
    ):
        return True

    if isinstance(exc, APIStatusError):
        return exc.status_code in RETRYABLE_STATUS_CODES or exc.status_code >= 500

    if isinstance(exc, genai_errors.ServerError):
        return True
    if isinstance(exc, genai_errors.ClientError):
        return _extract_status_code(exc) in RETRYABLE_STATUS_CODES

    message = str(exc).lower()
    transient_keywords = (
        "timeout",
        "timed out",
        "connection",
        "connect",
        "reset",
        "eof",
        "temporarily",
        "rate limit",
        "429",
        "502",
        "503",
        "504",
        "unavailable",
    )
    return any(keyword in message for keyword in transient_keywords)


def _run_with_retry(
    fn: Callable[[], T],
    *,
    provider_name: str,
    scene: str,
    max_retries: int,
) -> T:
    """指数退避重试，遇到配置错误或 4xx 非限流错误立即停止。"""
    last_exc: Exception | None = None
    attempts = max(1, max_retries)

    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 统一判断重试与降级
            last_exc = exc
            if attempt >= attempts or not _is_retryable_error(exc):
                raise

            delay = min(8.0, 1.0 * (2 ** (attempt - 1)))
            logger.warning(
                "[LLM] provider=%s scene=%s 第 %d/%d 次调用失败（%s），%.1fs 后重试",
                provider_name,
                scene,
                attempt,
                attempts,
                exc,
                delay,
            )
            time.sleep(delay)

    assert last_exc is not None
    raise last_exc


class BaseLLMProvider(ABC):
    """大模型提供方统一抽象策略。"""

    name: str

    @abstractmethod
    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float = 90.0,
        expect_json: bool = False,
        json_root: str = "object",
    ) -> str:
        """同步生成完整文本。"""

    @abstractmethod
    def stream(
        self,
        messages: list[dict[str, str]],
        *,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float = 90.0,
    ) -> Iterator[str]:
        """流式生成文本片段。"""


def _extract_gemini_text(response: object) -> str:
    """从 Gemini 响应对象提取纯文本，兼容思考片段过滤。"""
    try:
        text = getattr(response, "text", None)
    except ValueError:
        text = None

    if isinstance(text, str) and text.strip():
        return text.strip()

    candidates = getattr(response, "candidates", None) or []
    parts_text: list[str] = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            if getattr(part, "thought", False):
                continue
            part_text = getattr(part, "text", None)
            if isinstance(part_text, str) and part_text:
                parts_text.append(part_text)
        if parts_text:
            break

    return "".join(parts_text).strip()


def _extract_gemini_stream_chunk(chunk: object) -> str:
    """从 Gemini 流式分片中提取非思考文本。"""
    candidates = getattr(chunk, "candidates", None) or []
    if candidates:
        parts_text: list[str] = []
        content = getattr(candidates[0], "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            if getattr(part, "thought", False):
                continue
            part_text = getattr(part, "text", None)
            if isinstance(part_text, str) and part_text:
                parts_text.append(part_text)
        if parts_text:
            return "".join(parts_text)

    try:
        text = getattr(chunk, "text", None)
    except ValueError:
        text = None
    return text if isinstance(text, str) else ""


class GeminiProvider(BaseLLMProvider):
    """基于官方新版 google-genai SDK 的 Gemini 策略实现。"""

    name = "gemini"

    def _create_client(self, timeout: float) -> genai.Client:
        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            raise LLMConfigError(
                "未配置 GEMINI_API_KEY，请在 backend/.env 中设置后重试"
            )
        # google-genai HttpOptions.timeout 单位为毫秒
        timeout_ms = int(max(1.0, timeout) * 1000)
        return genai.Client(
            api_key=api_key,
            http_options=genai_types.HttpOptions(timeout=timeout_ms),
        )

    @staticmethod
    def _prepare_payload(
        messages: list[dict[str, str]],
        system_prompt: str | None,
    ) -> tuple[str | None, list[genai_types.Content]]:
        system_chunks: list[str] = []
        if system_prompt and system_prompt.strip():
            system_chunks.append(system_prompt.strip())

        contents: list[genai_types.Content] = []
        for item in messages:
            role = str(item.get("role") or "user").strip().lower()
            text = str(item.get("content") or "")
            if not text.strip():
                continue
            if role == "system":
                system_chunks.append(text.strip())
                continue

            gemini_role = "model" if role in {"assistant", "model"} else "user"
            contents.append(
                genai_types.Content(
                    role=gemini_role,
                    parts=[genai_types.Part.from_text(text=text)],
                )
            )

        if not contents:
            raise LLMConfigError("消息内容不能为空")

        merged_system = "\n\n".join(system_chunks) if system_chunks else None
        return merged_system, contents

    @staticmethod
    def _build_config(
        *,
        model: str,
        system_instruction: str | None,
        temperature: float,
        max_tokens: int | None,
        expect_json: bool,
    ) -> genai_types.GenerateContentConfig:
        kwargs: dict[str, object] = {
            "temperature": temperature,
        }
        if system_instruction:
            kwargs["system_instruction"] = system_instruction
        if max_tokens is not None:
            kwargs["max_output_tokens"] = max_tokens
        if expect_json:
            kwargs["response_mime_type"] = "application/json"

        # 避免默认思考模式在低 max_tokens 时耗尽输出预算导致空响应
        budget_env = os.getenv("GEMINI_THINKING_BUDGET", "").strip()
        if budget_env:
            try:
                kwargs["thinking_config"] = genai_types.ThinkingConfig(
                    thinking_budget=int(budget_env)
                )
            except ValueError:
                pass
        elif "2.5-flash" in model and max_tokens is not None and max_tokens < 1024:
            kwargs["thinking_config"] = genai_types.ThinkingConfig(
                thinking_budget=0
            )
        elif max_tokens is not None and max_tokens < 1024:
            # 为 gemini-4-hydrogen 等带思考能力的模型预留思考 token 预算，防止输出被截断为空
            kwargs["max_output_tokens"] = 1024

        return genai_types.GenerateContentConfig(**kwargs)

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float = 90.0,
        expect_json: bool = False,
        json_root: str = "object",
    ) -> str:
        del json_root  # Gemini application/json 同时支持 object 与 array
        model = _get_gemini_model()
        client = self._create_client(timeout)
        merged_system, contents = self._prepare_payload(messages, system_prompt)
        config = self._build_config(
            model=model,
            system_instruction=merged_system,
            temperature=temperature,
            max_tokens=max_tokens,
            expect_json=expect_json,
        )

        response = client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )
        text = _extract_gemini_text(response)
        if not text:
            raise RuntimeError("Gemini 返回内容为空")
        return text

    def stream(
        self,
        messages: list[dict[str, str]],
        *,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float = 90.0,
    ) -> Iterator[str]:
        model = _get_gemini_model()
        client = self._create_client(timeout)
        merged_system, contents = self._prepare_payload(messages, system_prompt)
        config = self._build_config(
            model=model,
            system_instruction=merged_system,
            temperature=temperature,
            max_tokens=max_tokens,
            expect_json=False,
        )

        for chunk in client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        ):
            piece = _extract_gemini_stream_chunk(chunk)
            if piece:
                yield piece

    def analyze_image(
        self,
        image_path: Path,
        prompt: str,
        *,
        timeout: float = 120.0,
    ) -> str:
        """使用 Gemini 多模态接口读取图片字节并解析内容。"""
        if not image_path.is_file():
            raise LLMConfigError(f"图片文件不存在：{image_path}")

        suffix = image_path.suffix.lower()
        mime_type = IMAGE_MIME_MAP.get(suffix)
        if not mime_type:
            guessed, _ = mimetypes.guess_type(str(image_path))
            mime_type = guessed or "image/jpeg"

        image_bytes = image_path.read_bytes()
        if not image_bytes:
            raise LLMConfigError(f"图片文件为空：{image_path.name}")

        model = _get_gemini_model()
        client = self._create_client(timeout)
        image_part = genai_types.Part.from_bytes(
            data=image_bytes,
            mime_type=mime_type,
        )
        response = client.models.generate_content(
            model=model,
            contents=[prompt, image_part],
            config=genai_types.GenerateContentConfig(temperature=0.2),
        )
        text = _extract_gemini_text(response)
        if not text:
            raise RuntimeError("Gemini 图片解析未返回有效文字")
        return text


class DeepSeekProvider(BaseLLMProvider):
    """基于 OpenAI 兼容接口的 DeepSeek 策略实现。"""

    name = "deepseek"

    def _create_client(self, timeout: float) -> OpenAI:
        api_key = (
            os.getenv("DEEPSEEK_API_KEY", "").strip()
            or os.getenv("OPENAI_API_KEY", "").strip()
        )
        if not api_key:
            raise LLMConfigError(
                "未配置 DEEPSEEK_API_KEY，请在 backend/.env 中设置后重试"
            )
        return OpenAI(
            api_key=api_key,
            base_url=_get_deepseek_base_url(),
            timeout=timeout,
            max_retries=0,
        )

    @staticmethod
    def _prepare_messages(
        messages: list[dict[str, str]],
        system_prompt: str | None,
    ) -> list[dict[str, str]]:
        payload: list[dict[str, str]] = []
        if system_prompt and system_prompt.strip():
            payload.append({"role": "system", "content": system_prompt.strip()})

        for item in messages:
            role = str(item.get("role") or "user").strip().lower()
            content = str(item.get("content") or "")
            if not content.strip():
                continue
            payload.append({"role": role, "content": content})

        if not payload:
            raise LLMConfigError("消息内容不能为空")
        return payload

    def complete(
        self,
        messages: list[dict[str, str]],
        *,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float = 90.0,
        expect_json: bool = False,
        json_root: str = "object",
    ) -> str:
        client = self._create_client(timeout)
        payload_messages = self._prepare_messages(messages, system_prompt)
        kwargs: dict[str, object] = {
            "model": _get_deepseek_model(),
            "messages": payload_messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        # DeepSeek json_object 模式仅支持顶层为 JSON Object，数组输出保持纯文本解析
        if expect_json and json_root == "object":
            kwargs["response_format"] = {"type": "json_object"}

        completion = client.chat.completions.create(**kwargs)
        content = completion.choices[0].message.content or ""
        if not content.strip():
            raise RuntimeError("DeepSeek 返回内容为空")
        return content.strip()

    def stream(
        self,
        messages: list[dict[str, str]],
        *,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float = 90.0,
    ) -> Iterator[str]:
        client = self._create_client(timeout)
        payload_messages = self._prepare_messages(messages, system_prompt)
        kwargs: dict[str, object] = {
            "model": _get_deepseek_model(),
            "messages": payload_messages,
            "temperature": temperature,
            "stream": True,
        }
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens

        for chunk in client.chat.completions.create(**kwargs):
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta = getattr(choices[0], "delta", None)
            piece = getattr(delta, "content", None)
            if isinstance(piece, str) and piece:
                yield piece


class DashScopeVisionProvider:
    """阿里云百炼 qwen-vl 视觉解析策略（兼作 Gemini 视觉降级通道）。"""

    name = "dashscope"

    @staticmethod
    def _extract_text(response: object) -> str:
        """兼容 DashScope SDK 返回对象/字典两种结构，提取纯文本。"""
        output = getattr(response, "output", None)
        if output is None and isinstance(response, dict):
            output = response.get("output")
        if output is None:
            return ""

        choices = getattr(output, "choices", None)
        if choices is None and isinstance(output, dict):
            choices = output.get("choices")
        if not isinstance(choices, list) or not choices:
            return ""

        message = choices[0]
        if not isinstance(message, dict):
            message = getattr(message, "message", None)
        elif "message" in message:
            message = message["message"]
        if message is None:
            return ""

        content = getattr(message, "content", None)
        if content is None and isinstance(message, dict):
            content = message.get("content")

        if isinstance(content, str):
            return content.strip()

        if isinstance(content, list):
            texts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    texts.append(item)
                elif isinstance(item, dict) and "text" in item:
                    texts.append(str(item["text"]))
                elif getattr(item, "text", None):
                    texts.append(str(item.text))
            return "\n".join(texts).strip()

        return ""

    def analyze_image(
        self,
        image_path: Path,
        prompt: str,
        *,
        timeout: float = 120.0,
    ) -> str:
        del timeout  # DashScope MultiModalConversation 内部无独立 timeout 参数
        api_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
        if not api_key:
            raise LLMConfigError(
                "未配置 DASHSCOPE_API_KEY，请在 backend/.env 中设置后重试"
            )

        image_uri = f"file://{image_path.resolve()}"
        messages = [
            {
                "role": "user",
                "content": [
                    {"image": image_uri},
                    {"text": prompt},
                ],
            }
        ]

        last_error = "视觉模型调用失败"
        for model in _get_vision_models():
            response = MultiModalConversation.call(
                model=model,
                messages=messages,
                api_key=api_key,
            )
            status_code = getattr(response, "status_code", 200)
            if status_code == 200:
                text = self._extract_text(response)
                if text:
                    return text
                last_error = "视觉模型未返回有效文字"
                break

            message = getattr(response, "message", "") or "视觉模型调用失败"
            last_error = f"{message}（HTTP {status_code}，model={model}）"
            if status_code not in (403, 404):
                break

        raise RuntimeError(last_error)


def get_llm_provider(provider_name: str | None = None) -> BaseLLMProvider:
    """工厂路由：按名称或环境变量返回具体大模型策略实例。"""
    resolved = (
        provider_name.strip().lower()
        if provider_name and provider_name.strip()
        else get_active_provider_name()
    )
    if resolved == "gemini":
        return GeminiProvider()
    if resolved == "deepseek":
        return DeepSeekProvider()
    raise LLMConfigError(
        f"不支持的 LLM_PROVIDER={resolved}，请配置为 gemini 或 deepseek"
    )


def _normalize_messages(
    messages: list[dict[str, str]] | None,
    prompt: str | None,
) -> list[dict[str, str]]:
    if messages:
        return messages
    if prompt is not None and prompt.strip():
        return [{"role": "user", "content": prompt}]
    raise LLMConfigError("必须提供有效的 messages 或 prompt")


def _has_deepseek_key() -> bool:
    return bool(
        os.getenv("DEEPSEEK_API_KEY", "").strip()
        or os.getenv("OPENAI_API_KEY", "").strip()
    )


def _has_dashscope_key() -> bool:
    return bool(os.getenv("DASHSCOPE_API_KEY", "").strip())


def llm_complete(
    messages: list[dict[str, str]] | None = None,
    *,
    prompt: str | None = None,
    system_prompt: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    timeout: float | None = None,
    expect_json: bool = False,
    json_root: str = "object",
    provider: str | None = None,
    scene: str = "llm",
) -> str:
    """统一文本/JSON 生成入口，内置重试与 Gemini -> DeepSeek 自动降级。"""
    normalized_messages = _normalize_messages(messages, prompt)
    resolved_timeout = (
        timeout if timeout is not None else _get_default_timeout()
    )
    max_retries = _get_max_retries()
    primary = get_llm_provider(provider)

    try:
        return _run_with_retry(
            lambda: primary.complete(
                normalized_messages,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=resolved_timeout,
                expect_json=expect_json,
                json_root=json_root,
            ),
            provider_name=primary.name,
            scene=scene,
            max_retries=max_retries,
        )
    except Exception as primary_exc:  # noqa: BLE001 判断是否可降级到 DeepSeek
        if (
            primary.name == "gemini"
            and _is_fallback_enabled()
            and _has_deepseek_key()
        ):
            logger.warning(
                "[LLM] Gemini 调用失败（scene=%s, err=%s），自动降级到 DeepSeek",
                scene,
                primary_exc,
            )
            fallback = DeepSeekProvider()
            return _run_with_retry(
                lambda: fallback.complete(
                    normalized_messages,
                    system_prompt=system_prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    timeout=resolved_timeout,
                    expect_json=expect_json,
                    json_root=json_root,
                ),
                provider_name=fallback.name,
                scene=f"{scene}_fallback",
                max_retries=min(2, max_retries),
            )
        raise


def llm_stream(
    messages: list[dict[str, str]] | None = None,
    *,
    prompt: str | None = None,
    system_prompt: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    timeout: float | None = None,
    provider: str | None = None,
    scene: str = "llm_stream",
) -> Iterator[str]:
    """统一流式文本生成入口；仅在首个分片输出前允许自动降级。"""
    normalized_messages = _normalize_messages(messages, prompt)
    resolved_timeout = (
        timeout if timeout is not None else _get_default_timeout()
    )
    primary = get_llm_provider(provider)
    yielded_any = False

    try:
        for chunk in primary.stream(
            normalized_messages,
            system_prompt=system_prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=resolved_timeout,
        ):
            yielded_any = True
            yield chunk
        return
    except Exception as primary_exc:  # noqa: BLE001 首片前允许降级
        if (
            not yielded_any
            and primary.name == "gemini"
            and _is_fallback_enabled()
            and _has_deepseek_key()
        ):
            logger.warning(
                "[LLM] Gemini 流式调用失败（scene=%s, err=%s），自动降级到 DeepSeek",
                scene,
                primary_exc,
            )
            fallback = DeepSeekProvider()
            yield from fallback.stream(
                normalized_messages,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=resolved_timeout,
            )
            return
        raise


def llm_analyze_image(
    image_path: Path,
    prompt: str,
    *,
    timeout: float = 120.0,
    provider: str | None = None,
) -> str:
    """统一多模态图片解析入口：默认 Gemini，失败自动降级阿里云 qwen-vl。"""
    resolved = (
        provider.strip().lower()
        if provider and provider.strip()
        else get_active_vision_provider_name()
    )
    if resolved not in SUPPORTED_VISION_PROVIDERS:
        raise LLMConfigError(
            f"不支持的 VISION_PROVIDER={resolved}，请配置为 gemini 或 dashscope"
        )

    max_retries = _get_max_retries()
    if resolved == "gemini":
        gemini = GeminiProvider()
        try:
            return _run_with_retry(
                lambda: gemini.analyze_image(
                    image_path,
                    prompt,
                    timeout=timeout,
                ),
                provider_name="gemini_vision",
                scene="vision",
                max_retries=max_retries,
            )
        except Exception as exc:  # noqa: BLE001 视觉主通道失败后降级至 qwen-vl
            if _is_fallback_enabled() and _has_dashscope_key():
                logger.warning(
                    "[VISION] Gemini 图片解析失败（%s），已自动降级至阿里云 qwen-vl",
                    exc,
                )
                dashscope_vision = DashScopeVisionProvider()
                return _run_with_retry(
                    lambda: dashscope_vision.analyze_image(
                        image_path,
                        prompt,
                        timeout=timeout,
                    ),
                    provider_name="dashscope_vision",
                    scene="vision_fallback",
                    max_retries=min(2, max_retries),
                )
            raise

    dashscope_vision = DashScopeVisionProvider()
    return _run_with_retry(
        lambda: dashscope_vision.analyze_image(
            image_path,
            prompt,
            timeout=timeout,
        ),
        provider_name="dashscope_vision",
        scene="vision",
        max_retries=max_retries,
    )
