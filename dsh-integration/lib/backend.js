/**
 * FastAPI 适配层：把课堂笔记后端的 HTTP 接口包装成可供 DSH 工具调用的函数。
 *
 * 后端接口约定（见项目 README）：
 *   POST /api/upload_ppt   multipart: file, subject       -> { task_id }
 *   POST /api/upload       multipart: files[], subject, task_id -> { task_id }
 *   GET  /api/task/{id}                                   -> { status, result, storyboard, ... }
 *   POST /api/chat         JSON: { message, subject, note_context } -> { reply }
 */

import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'
const MAX_AUDIO_BYTES = 1536 * 1024 * 1024
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a'])
const PPT_EXTENSIONS = new Set(['.pptx'])
const DEFAULT_TIMEOUT_SECONDS = 1800
const MIN_TIMEOUT_SECONDS = 60
const MAX_TIMEOUT_SECONDS = 7200
const POLL_INTERVAL_MS = 2000

/** 当前后端地址；每次调用时读取，便于在不重载插件的情况下切换环境。 */
export function getBaseUrl() {
  const raw = process.env.LECTURE_API_BASE_URL?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_SECONDS
  }
  return Math.min(
    MAX_TIMEOUT_SECONDS,
    Math.max(MIN_TIMEOUT_SECONDS, Math.round(value)),
  )
}

async function resolveInputFile(filePath, extensions, label) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error(`${label}路径不能为空`)
  }

  const absolute = resolve(filePath.trim())

  let info
  try {
    info = await stat(absolute)
  } catch {
    throw new Error(`${label}不存在：${absolute}`)
  }

  if (!info.isFile()) {
    throw new Error(`${label}不是文件：${absolute}`)
  }

  const extension = extname(absolute).toLowerCase()
  if (!extensions.has(extension)) {
    throw new Error(
      `${label}格式不支持（${extension || '无扩展名'}）：${absolute}`,
    )
  }

  return { absolute, name: basename(absolute), size: info.size }
}

async function readJson(response) {
  const text = await response.text()
  let data = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const detail =
      data && typeof data.detail === 'string'
        ? data.detail
        : text.slice(0, 500) || `HTTP ${response.status}`
    throw new Error(`后端请求失败（${response.status}）：${detail}`)
  }

  if (data === null) {
    throw new Error('后端返回了空响应或非法 JSON')
  }

  return data
}

async function toBlob(absolutePath) {
  // openAsBlob 直接以文件为后端，避免把 1.5GB 音频读进内存。
  return openAsBlob(absolutePath)
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  return new Error('操作已被取消')
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(abortReason(signal))
      return
    }

    const timer = setTimeout(() => {
      cleanup()
      resolvePromise()
    }, ms)

    const onAbort = () => {
      cleanup()
      rejectPromise(abortReason(signal))
    }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }

    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

async function uploadPpt(baseUrl, file, subject, signal) {
  const form = new FormData()
  form.append('file', await toBlob(file.absolute), file.name)
  if (subject) form.append('subject', subject)

  const response = await fetch(`${baseUrl}/api/upload_ppt`, {
    method: 'POST',
    body: form,
    signal,
  })
  return readJson(response)
}

async function uploadAudio(baseUrl, file, subject, pptTaskId, signal) {
  const form = new FormData()
  form.append('files', await toBlob(file.absolute), file.name)
  if (subject) form.append('subject', subject)
  if (typeof pptTaskId === 'number') {
    form.append('task_id', String(pptTaskId))
  }

  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    body: form,
    signal,
  })
  return readJson(response)
}

async function waitForTask(baseUrl, taskId, timeoutSeconds, signal) {
  const deadline = Date.now() + timeoutSeconds * 1000

  while (true) {
    const response = await fetch(`${baseUrl}/api/task/${taskId}`, { signal })
    const task = await readJson(response)

    if (task.status === 'completed') return task

    if (task.status === 'failed') {
      const reason =
        typeof task.result === 'string' && task.result.trim()
          ? task.result.trim()
          : '后端未返回失败原因'
      throw new Error(`任务 #${taskId} 处理失败：${reason}`)
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `等待任务 #${taskId} 超时（${timeoutSeconds} 秒）。任务可能仍在后台处理，` +
          `可稍后用 GET /api/task/${taskId} 查询进度。`,
      )
    }

    await sleep(POLL_INTERVAL_MS, signal)
  }
}

/**
 * 上传可选 PPT 与音频，轮询到任务完成后返回整理好的 Markdown 笔记。
 *
 * @param {object} options
 * @param {string} options.audioPath 本地音频路径（mp3/wav/m4a）
 * @param {string} [options.pptPath] 本地 PPT 路径（.pptx）
 * @param {string} [options.subject] 课程名，不传则由后端自动识别
 * @param {number} [options.timeoutSeconds] 等待上限，默认 1800 秒
 * @param {AbortSignal} [options.signal] DSH 提供的取消信号
 */
export async function analyzeLecture({
  audioPath,
  pptPath,
  subject,
  timeoutSeconds,
  signal,
}) {
  const baseUrl = getBaseUrl()
  const timeout = clampTimeout(timeoutSeconds)
  const normalizedSubject =
    typeof subject === 'string' && subject.trim() ? subject.trim() : ''

  const audio = await resolveInputFile(
    audioPath,
    AUDIO_EXTENSIONS,
    '音频文件',
  )
  if (audio.size > MAX_AUDIO_BYTES) {
    throw new Error(
      `音频文件超过后端 1.5GB 上限：${audio.absolute}（${audio.size} 字节）`,
    )
  }

  const ppt = pptPath
    ? await resolveInputFile(pptPath, PPT_EXTENSIONS, 'PPT 文件')
    : null

  let pptTaskId = null
  if (ppt) {
    const pptResult = await uploadPpt(
      baseUrl,
      ppt,
      normalizedSubject,
      signal,
    )
    if (typeof pptResult.task_id !== 'number') {
      throw new Error('PPT 上传接口未返回有效的 task_id')
    }
    pptTaskId = pptResult.task_id
  }

  const audioResult = await uploadAudio(
    baseUrl,
    audio,
    normalizedSubject,
    pptTaskId,
    signal,
  )
  if (typeof audioResult.task_id !== 'number') {
    throw new Error('音频上传接口未返回有效的 task_id')
  }

  const taskId = audioResult.task_id
  const task = await waitForTask(baseUrl, taskId, timeout, signal)
  const note =
    typeof task.result === 'string' ? task.result.trim() : ''

  if (!note) {
    throw new Error(`任务 #${taskId} 已完成，但后端没有返回笔记内容`)
  }

  return {
    task_id: typeof task.task_id === 'number' ? task.task_id : taskId,
    subject:
      typeof task.subject === 'string' && task.subject.trim()
        ? task.subject.trim()
        : normalizedSubject || '通用课程',
    filename:
      typeof task.filename === 'string' && task.filename.trim()
        ? task.filename.trim()
        : audio.name,
    note_markdown: note,
    storyboard_segments: Array.isArray(task.storyboard)
      ? task.storyboard.length
      : 0,
    audio_file: audio.absolute,
    ppt_file: ppt ? ppt.absolute : '',
  }
}

/**
 * 调用后端的 /api/chat 对话接口，返回李老师的解答。
 *
 * @param {object} options
 * @param {string} options.question 学生的问题
 * @param {string} [options.context] 当前课堂上下文（讲到哪一步）
 * @param {string} [options.noteContext] 当前复习笔记
 * @param {string} [options.subject] 课程名
 * @param {AbortSignal} [options.signal] DSH 提供的取消信号
 */
export async function askTeacher({
  question,
  context,
  noteContext,
  subject,
  signal,
}) {
  if (typeof question !== 'string' || !question.trim()) {
    throw new Error('问题不能为空')
  }

  const baseUrl = getBaseUrl()
  const normalizedSubject =
    typeof subject === 'string' && subject.trim()
      ? subject.trim()
      : '通用课程'

  const trimmedContext =
    typeof context === 'string' ? context.trim() : ''
  const message = trimmedContext
    ? `【当前课堂上下文】\n${trimmedContext}\n\n【学生问题】\n${question.trim()}`
    : question.trim()

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      subject: normalizedSubject,
      note_context:
        typeof noteContext === 'string' && noteContext.trim()
          ? noteContext.trim()
          : null,
    }),
    signal,
  })

  const data = await readJson(response)
  if (typeof data.reply !== 'string' || !data.reply.trim()) {
    throw new Error('对话接口返回内容为空')
  }

  return {
    answer: data.reply.trim(),
    subject: normalizedSubject,
  }
}
