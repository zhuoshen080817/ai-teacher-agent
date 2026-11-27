const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080'

export type UploadPhase = 'uploading' | 'merging' | 'finalizing'

export interface UploadProgress {
  loaded: number
  total: number
  speed?: number
  phase?: UploadPhase
  chunksDone?: number
  chunksTotal?: number
}

interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void
}

interface ChunkedUploadOptions extends UploadOptions {
  concurrency?: number
  maxRetries?: number
}

interface ErrorPayload {
  detail?: string
}

export interface ChunkedFileResult {
  uploadId: string
  filename: string
  size: number
}

interface ChunkInitResponse {
  upload_id: string
  chunk_size: number
  total_chunks: number
  filename: string
  size: number
  kind: 'audio' | 'ppt'
  detail?: string
}

interface ChunkTask {
  sessionIndex: number
  index: number
  blob: Blob
  loaded: number
  done: boolean
}

interface UploadSession {
  file: File
  uploadId: string
  chunkSize: number
  totalChunks: number
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function errorDetail(data: unknown, fallback: string) {
  if (data && typeof data === 'object' && 'detail' in data) {
    const detail = (data as ErrorPayload).detail
    if (typeof detail === 'string' && detail.trim()) return detail
  }
  return fallback
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    throw new Error(errorDetail(data, `HTTP ${response.status}`))
  }
  return data as T
}

export function uploadApiJson<T>(path: string, body: unknown): Promise<T> {
  return postJson<T>(path, body)
}

async function initUploadSession(file: File): Promise<UploadSession> {
  const data = await postJson<ChunkInitResponse>('/api/upload/chunk/init', {
    filename: file.name,
    size: file.size,
  })

  if (
    typeof data.upload_id !== 'string' ||
    typeof data.chunk_size !== 'number' ||
    typeof data.total_chunks !== 'number'
  ) {
    throw new Error('分片上传初始化返回数据异常')
  }

  return {
    file,
    uploadId: data.upload_id,
    chunkSize: data.chunk_size,
    totalChunks: data.total_chunks,
  }
}

function uploadChunkOnce(
  session: UploadSession,
  task: ChunkTask,
  onChunkProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(
      'POST',
      `${API_BASE_URL}/api/upload/chunk/${session.uploadId}/part/${task.index}`,
    )
    xhr.timeout = 180000
    xhr.responseType = 'text'

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      onChunkProgress(event.loaded)
    }

    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = null
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        onChunkProgress(task.blob.size)
        resolve()
        return
      }

      reject(new Error(errorDetail(data, `分片上传失败（HTTP ${xhr.status}）`)))
    }

    xhr.onerror = () => reject(new Error('网络异常，分片上传失败'))
    xhr.ontimeout = () => reject(new Error('分片上传超时'))
    xhr.onabort = () => reject(new Error('分片上传已取消'))

    xhr.send(task.blob)
  })
}

async function uploadChunkWithRetry(
  session: UploadSession,
  task: ChunkTask,
  onChunkProgress: (loaded: number) => void,
  maxRetries: number,
): Promise<void> {
  let lastError: unknown = null

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      if (attempt > 0) {
        task.loaded = 0
        onChunkProgress(0)
        await delay(300 * attempt)
      }
      await uploadChunkOnce(session, task, onChunkProgress)
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('分片上传失败，请重试')
}

/**
 * 分片并行上传多个文件：
 * - 所有文件先建立上传会话，再统一排队上传分片
 * - 分片并发数默认 4，失败自动重试
 * - 进度按所有文件总字节数聚合，并附带实时平均速度
 */
export async function uploadFilesInChunks(
  files: File[],
  options: ChunkedUploadOptions = {},
): Promise<ChunkedFileResult[]> {
  if (!files.length) return []

  const concurrency = Math.max(1, options.concurrency ?? 4)
  const maxRetries = Math.max(0, options.maxRetries ?? 2)
  const report = options.onProgress

  const sessions = await Promise.all(files.map(initUploadSession))
  const total = sessions.reduce((sum, session) => sum + session.file.size, 0)

  const tasks: ChunkTask[] = []
  sessions.forEach((session, sessionIndex) => {
    for (let index = 0; index < session.totalChunks; index += 1) {
      const start = index * session.chunkSize
      const end = Math.min(start + session.chunkSize, session.file.size)
      tasks.push({
        sessionIndex,
        index,
        blob: session.file.slice(start, end),
        loaded: 0,
        done: false,
      })
    }
  })

  const startedAt = performance.now()
  let lastReportAt = 0

  const emitProgress = (phase: UploadPhase, force = false) => {
    const now = performance.now()
    if (!force && now - lastReportAt < 80) return
    lastReportAt = now

    const loaded = tasks.reduce((sum, task) => sum + task.loaded, 0)
    const elapsed = Math.max((now - startedAt) / 1000, 0.1)
    report?.({
      loaded: Math.min(loaded, total),
      total,
      speed: loaded / elapsed,
      phase,
      chunksDone: tasks.filter((task) => task.done).length,
      chunksTotal: tasks.length,
    })
  }

  emitProgress('uploading', true)

  let cursor = 0

  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor]
      cursor += 1

      const session = sessions[task.sessionIndex]
      await uploadChunkWithRetry(
        session,
        task,
        (loaded) => {
          task.loaded = Math.min(loaded, task.blob.size)
          emitProgress('uploading')
        },
        maxRetries,
      )

      task.done = true
      task.loaded = task.blob.size
      emitProgress('uploading')
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, tasks.length) },
      () => worker(),
    ),
  )

  emitProgress('merging', true)

  await Promise.all(
    sessions.map((session) =>
      postJson(`/api/upload/chunk/${session.uploadId}/complete`),
    ),
  )

  report?.({
    loaded: total,
    total,
    phase: 'finalizing',
    chunksDone: tasks.length,
    chunksTotal: tasks.length,
  })

  return sessions.map((session) => ({
    uploadId: session.uploadId,
    filename: session.file.name,
    size: session.file.size,
  }))
}

/**
 * 使用 XMLHttpRequest 上传 FormData：
 * - 支持真实上传进度（fetch 无法获取 upload progress）
 * - timeout = 0，大文件上传不设超时
 */
export function uploadFormData<T>(
  path: string,
  formData: FormData,
  options: UploadOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE_URL}${path}`)
    xhr.timeout = 0
    xhr.responseType = 'text'

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      options.onProgress?.({ loaded: event.loaded, total: event.total })
    }

    xhr.onload = () => {
      let data: unknown = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        data = null
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T)
        return
      }

      reject(new Error(errorDetail(data, `HTTP ${xhr.status}`)))
    }

    xhr.onerror = () => reject(new Error('网络异常，上传失败，请检查后端是否在运行'))
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'))
    xhr.onabort = () => reject(new Error('上传已取消'))

    xhr.send(formData)
  })
}
