const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080'
const CACHE_LIMIT = 60
const MIN_SPEED = 0.5
const MAX_SPEED = 2.0

const SPEAKABLE_PATTERN = /[\p{L}\p{N}]/gu

/** 清洗后没有任何文字/数字（纯符号）或极短时不调用 TTS，直接显示文字。 */
export function hasSpeakableText(text: string) {
  const matches = text.match(SPEAKABLE_PATTERN)
  return (matches?.length ?? 0) >= 2
}

const blobCache = new Map<string, Promise<Blob | null>>()

let defaultSpeed = 1

export function clampTtsSpeed(speed: number) {
  if (!Number.isFinite(speed)) return 1
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
}

/** 设置默认语速；由后端 CosyVoice 原生合成，不使用 audio.playbackRate。 */
export function setTtsSpeed(speed: number) {
  defaultSpeed = clampTtsSpeed(speed)
}

export function getTtsSpeed() {
  return defaultSpeed
}

function cacheKey(text: string, speed: number) {
  return `${speed.toFixed(2)}::${text}`
}

async function readErrorDetail(response: Response) {
  try {
    const data = (await response.json()) as { detail?: string }
    return typeof data.detail === 'string' ? data.detail : ''
  } catch {
    return ''
  }
}

function requestTtsBlob(
  text: string,
  speed: number,
): Promise<Blob | null> {
  const key = cacheKey(text, speed)
  const cached = blobCache.get(key)
  if (cached) return cached

  const request = fetch(`${API_BASE_URL}/api/tts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text, speed }),
  }).then(async (response) => {
    // 后端判断文本无需朗读时返回 204，前端直接跳过播放
    if (response.status === 204) return null
    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new Error(detail || `语音合成失败（HTTP ${response.status}）`)
    }
    return response.blob()
  })

  blobCache.set(key, request)
  if (blobCache.size > CACHE_LIMIT) {
    const oldest = blobCache.keys().next().value
    if (typeof oldest === 'string') blobCache.delete(oldest)
  }
  request.catch(() => blobCache.delete(key))

  return request
}

/** 提前合成下一段音频，减少自动连播时的等待。 */
export function prefetchTts(text: string, speed?: number) {
  void requestTtsBlob(text, clampTtsSpeed(speed ?? defaultSpeed)).catch(
    () => undefined,
  )
}

export interface TtsPlayback {
  /** 音频真正开始播放时 resolve */
  started: Promise<void>
  finished: Promise<void>
  stop: () => void
}

interface PlayTtsOptions {
  speed?: number
}

/** 请求 /api/tts 并用 Audio 播放，返回可中止的播放句柄。 */
export function playTts(text: string, options: PlayTtsOptions = {}): TtsPlayback {
  const speed = clampTtsSpeed(options.speed ?? defaultSpeed)

  let stopped = false
  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null

  let resolveFinished: () => void = () => {}
  let rejectFinished: (reason: unknown) => void = () => {}
  let resolvedStarted = false
  let resolveStarted: () => void = () => {}

  const started = new Promise<void>((resolve) => {
    resolveStarted = () => {
      if (resolvedStarted) return
      resolvedStarted = true
      resolve()
    }
  })

  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })

  function cleanup() {
    if (audio) {
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.src = ''
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
    audio = null
  }

  function complete() {
    if (stopped) return
    stopped = true
    resolveStarted()
    cleanup()
    resolveFinished()
  }

  function fail(error: unknown) {
    if (stopped) return
    stopped = true
    resolveStarted()
    cleanup()
    rejectFinished(error)
  }

  function stop() {
    if (stopped) return
    stopped = true
    resolveStarted()
    cleanup()
    resolveFinished()
  }

  if (!hasSpeakableText(text)) {
    // 纯符号/纯空文本：不请求 TTS，文字仍然由界面直接展示
    complete()
    return { started, finished, stop }
  }

  void requestTtsBlob(text, speed)
    .then(async (blob) => {
      if (stopped) return
      if (!blob) {
        complete()
        return
      }

      objectUrl = URL.createObjectURL(blob)
      audio = new Audio(objectUrl)
      audio.preload = 'auto'
      audio.onended = complete
      audio.onerror = () => fail(new Error('音频播放失败'))

      await audio.play()
      resolveStarted()
    })
    .catch(fail)

  return { started, finished, stop }
}
