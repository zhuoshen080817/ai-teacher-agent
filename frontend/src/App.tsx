import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import LectureBoard from './components/LectureBoard'
import MarkdownView from './components/MarkdownView'
import {
  EXPLAINING_LINES,
  EXPLAIN_ERROR_LINES,
  FAILED_LINES,
  FINISHED_LINES,
  INTERRUPT_CUE_FALLBACKS,
  LISTENING_LINES,
  MIC_ERROR_LINES,
  NEED_NOTE_LINES,
  NO_SPEECH_LINES,
  PREPARE_LINES,
  QA_ERROR_LINES,
  READY_LINES,
  RESUME_CUE_FALLBACKS,
  THINKING_LINES,
  TTS_ERROR_LINES,
  pickLine,
} from './lib/teacherLines'
import { playTts, prefetchTts, setTtsSpeed } from './lib/tts'
import type { TtsPlayback } from './lib/tts'
import { uploadFormData } from './lib/upload'
import type { UploadProgress } from './lib/upload'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080'
const MAX_UPLOAD_SIZE = 1536 * 1024 * 1024
const MAX_UPLOAD_SIZE_LABEL = '1.5GB'
const LARGE_FILE_WARNING_SIZE = 500 * 1024 * 1024
const LARGE_FILE_WARNING =
  '文件过大处理缓慢，建议先转为 MP3 格式以提升速度。'
const ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a']
const POLL_INTERVAL = 2000
const RECOGNITION_TIMEOUT = 18000

type ConnectionStatus = 'loading' | 'connected' | 'error'
type Phase = 'idle' | 'uploading' | 'processing' | 'completed' | 'failed' | 'error'
type CopyState = 'idle' | 'copied' | 'error'
type LiveState =
  | 'idle'
  | 'playing'
  | 'waiting'
  | 'quiz'
  | 'quiz-feedback'
  | 'paused'
  | 'explaining'
  | 'interrupting'
  | 'listening'
  | 'thinking'
  | 'resuming'
  | 'ended'
type ChatRole = 'user' | 'assistant'

interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}

interface StoryboardStep {
  board_highlight: string
  highlight_lines: number[]
  speech_text: string
}

interface StoryboardQuiz {
  question: string
  options: string[]
  correct_answer: string
  explanation_correct: string
  explanation_wrong: string
  explanation_guess: string
}

interface StoryboardSegment {
  segment_id: number
  speech_text: string
  board_content: string
  highlight_lines: number[]
  step_by_step: StoryboardStep[]
  quiz?: StoryboardQuiz | null
}

interface UploadResponse {
  task_id?: number
  filename?: string
  status?: string
  file_count?: number
  subject?: string
  ppt_chars?: number
  detail?: string
}

interface ChatResponse {
  reply?: string
  detail?: string
}

interface AskTeacherResponse {
  answer?: string
  intent?: string
  detail?: string
}

interface ExplainAgainResponse {
  explanation?: string
  detail?: string
}

interface QuizFeedbackResponse {
  reply?: string
  detail?: string
}

interface TeacherCueResponse {
  text?: string
  detail?: string
}

interface TtsInfo {
  model?: string
  voice?: string
  display_name?: string
}

/** 浏览器语音识别（非标准 API，需自行声明类型） */
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionEventLike {
  resultIndex: number
  results: {
    length: number
    [index: number]: {
      isFinal: boolean
      0: { transcript: string }
    }
  }
}

interface TaskDetail {
  task_id: number
  filename: string
  status: string
  result: string | null
  subject?: string
  progress?: number
  status_message?: string | null
  storyboard?: StoryboardSegment[]
  created_at?: string
  detail?: string
}

interface TaskSummary {
  task_id: number
  filename: string
  status: string
  created_at: string
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDateTime(value: string) {
  if (!value) return '未知时间'
  return value.replace('T', ' ').slice(0, 16)
}

/** 音频去重键：文件名 + 大小相同即视为同一文件。 */
function audioFileKey(file: File) {
  return `${file.name}::${file.size}`
}

function fallbackCopy(text: string) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}

function splitNoteSegments(markdown: string) {
  return markdown
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function toSpeechText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[>#*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeHighlightLines(value: unknown): number[] {
  if (!Array.isArray(value)) return []

  return value
    .filter(
      (line): line is number =>
        typeof line === 'number' &&
        Number.isFinite(line) &&
        Number.isInteger(line) &&
        line > 0,
    )
    .slice(0, 20)
}

function normalizeSteps(value: unknown): StoryboardStep[] {
  if (!Array.isArray(value)) return []

  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .map((item) => ({
      board_highlight:
        typeof item.board_highlight === 'string'
          ? item.board_highlight.trim()
          : '',
      highlight_lines: normalizeHighlightLines(item.highlight_lines),
      speech_text:
        typeof item.speech_text === 'string' ? item.speech_text.trim() : '',
    }))
    .filter((step) => step.speech_text.length > 0)
    .slice(0, 8)
}

function normalizeQuiz(value: unknown): StoryboardQuiz | null {
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const question =
    typeof record.question === 'string' ? record.question.trim() : ''
  const rawOptions = Array.isArray(record.options) ? record.options : []
  const options = rawOptions
    .filter((option): option is string => typeof option === 'string')
    .map((option) => option.replace(/^[A-Da-d]\s*[.、):：]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)

  if (!question || options.length < 2) return null

  const rawAnswer =
    typeof record.correct_answer === 'string'
      ? record.correct_answer.toUpperCase().replace(/[^A-D]/g, '').slice(0, 1)
      : ''
  const letter =
    rawAnswer && rawAnswer.charCodeAt(0) - 65 < options.length
      ? rawAnswer
      : 'A'

  const explanation = (key: string, fallback: string) => {
    const text = typeof record[key] === 'string' ? record[key].trim() : ''
    return text || fallback
  }

  return {
    question,
    options,
    correct_answer: letter,
    explanation_correct: explanation(
      'explanation_correct',
      '回答正确，我们继续往下看。',
    ),
    explanation_wrong: explanation(
      'explanation_wrong',
      '没关系，我们重新梳理一下这个知识点。',
    ),
    explanation_guess: explanation(
      'explanation_guess',
      '被你说对了，不过原理还是要讲清楚。',
    ),
  }
}

function normalizeStoryboard(value: unknown): StoryboardSegment[] {
  if (!Array.isArray(value)) return []

  const segments: StoryboardSegment[] = []

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue

    const record = item as Record<string, unknown>
    const boardContent =
      typeof record.board_content === 'string'
        ? record.board_content.trim()
        : ''
    const opening =
      typeof record.speech_text === 'string' ? record.speech_text.trim() : ''
    const steps = normalizeSteps(record.step_by_step)

    if (steps.length > 0) {
      segments.push({
        segment_id: segments.length + 1,
        speech_text: opening,
        board_content: boardContent,
        highlight_lines: normalizeHighlightLines(record.highlight_lines),
        step_by_step: steps,
        quiz: normalizeQuiz(record.quiz),
      })
    } else if (opening) {
      // 兼容旧格式：没有 step_by_step 时把原讲稿作为唯一一步
      segments.push({
        segment_id: segments.length + 1,
        speech_text: '',
        board_content: boardContent,
        highlight_lines: normalizeHighlightLines(record.highlight_lines),
        step_by_step: [
          {
            board_highlight: '',
            highlight_lines: normalizeHighlightLines(
              record.highlight_lines,
            ),
            speech_text: opening,
          },
        ],
        quiz: normalizeQuiz(record.quiz),
      })
    }

    if (segments.length >= 30) break
  }

  return segments
}

function buildFallbackStoryboard(markdown: string): StoryboardSegment[] {
  const segments: StoryboardSegment[] = []

  splitNoteSegments(markdown)
    .slice(0, 10)
    .forEach((segment) => {
      const speech = toSpeechText(segment)
      if (!speech) return

      segments.push({
        segment_id: segments.length + 1,
        speech_text: '',
        board_content: segment,
        highlight_lines: [],
        step_by_step: [
          {
            board_highlight: '',
            highlight_lines: [],
            speech_text: speech,
          },
        ],
        quiz: null,
      })
    })

  return segments
}

interface WindowWithRecognition {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}

function getSpeechRecognitionCtor() {
  const scope = window as unknown as WindowWithRecognition
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
        已完成
      </span>
    )
  }

  if (status === 'failed') {
    return (
      <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600">
        失败
      </span>
    )
  }

  return (
    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600">
      处理中
    </span>
  )
}

function App() {
  const [status, setStatus] = useState<ConnectionStatus>('loading')
  const [errorMessage, setErrorMessage] = useState('')

  const [phase, setPhase] = useState<Phase>('idle')
  const [subject, setSubject] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [selectedPpt, setSelectedPpt] = useState<File | null>(null)
  const [pptTaskId, setPptTaskId] = useState<number | null>(null)
  const [batchCount, setBatchCount] = useState(0)
  const [taskId, setTaskId] = useState<number | null>(null)
  const [result, setResult] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [uploadStage, setUploadStage] = useState<'ppt' | 'audio' | null>(null)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  )
  const [processingProgress, setProcessingProgress] = useState(0)
  const [processingMessage, setProcessingMessage] = useState('')
  const [ttsInfo, setTtsInfo] = useState<TtsInfo | null>(null)
  const [ttsSpeed, setTtsSpeedState] = useState(1)
  const [isSlowMode, setIsSlowMode] = useState(false)
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(
    null,
  )
  const [interruptInput, setInterruptInput] = useState('')
  const [showInterruptInput, setShowInterruptInput] = useState(false)
  const [mockLoading, setMockLoading] = useState(false)

  const [history, setHistory] = useState<TaskSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '你好！我是你的课堂学习助手。上传录音后，我会帮你生成复习笔记；你也可以随时问我笔记中的概念。',
    },
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  const [storyboard, setStoryboard] = useState<StoryboardSegment[]>([])
  const [liveIndex, setLiveIndex] = useState(0)
  const [liveStepIndex, setLiveStepIndex] = useState(-1)
  const [liveState, setLiveState] = useState<LiveState>('idle')
  const [liveCaption, setLiveCaption] = useState('')
  const [liveError, setLiveError] = useState('')
  const [liveFocus, setLiveFocus] = useState('')
  const [liveHighlightLines, setLiveHighlightLines] = useState<number[]>([])
  const [isPreparing, setIsPreparing] = useState(false)
  const [prepareLine, setPrepareLine] = useState('')
  const [quizChoice, setQuizChoice] = useState<string | null>(null)
  const [quizVerdict, setQuizVerdict] = useState<'correct' | 'wrong' | null>(
    null,
  )
  const [referenceAudio, setReferenceAudio] = useState<File | null>(null)
  const [largeFileHint, setLargeFileHint] = useState('')
  const [dragTarget, setDragTarget] = useState<'ppt' | 'audio' | null>(null)

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const liveSessionRef = useRef(0)
  const livePlaybackRef = useRef<TtsPlayback | null>(null)
  const liveIndexRef = useRef(0)
  const liveStepRef = useRef(-1)
  const prepareStartedAtRef = useRef(0)
  const chatPlaybackRef = useRef<TtsPlayback | null>(null)
  const ttsSpeedRef = useRef(1)
  const resumePointRef = useRef<{ index: number; step: number } | null>(null)
  const interruptContextRef = useRef('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const noteSegments = splitNoteSegments(result)
  const liveStoryboard = useMemo(
    () =>
      storyboard.length > 0 ? storyboard : buildFallbackStoryboard(result),
    [storyboard, result],
  )
  const activeLiveSegment = liveStoryboard[liveIndex]
  const activeStep =
    liveStepIndex >= 0
      ? activeLiveSegment?.step_by_step[liveStepIndex]
      : undefined
  const totalSteps = activeLiveSegment?.step_by_step.length ?? 0
  const activeQuiz = activeLiveSegment?.quiz ?? null
  const isLiveBusy =
    liveState === 'playing' ||
    liveState === 'quiz-feedback' ||
    liveState === 'explaining' ||
    liveState === 'interrupting' ||
    liveState === 'listening' ||
    liveState === 'thinking' ||
    liveState === 'resuming'
  const isLiveActive = liveState !== 'idle' && liveState !== 'ended'

  useEffect(() => {
    const controller = new AbortController()

    async function checkHealth() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/health`, {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        const data: { status?: string } = await response.json()
        if (data.status !== 'ok') {
          throw new Error('健康检查返回异常')
        }

        setStatus('connected')
      } catch (error) {
        if (controller.signal.aborted) return
        setStatus('error')
        setErrorMessage(
          error instanceof Error ? error.message : '未知错误',
        )
      }
    }

    checkHealth()
    return () => controller.abort()
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadTtsInfo() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/tts/info`)
        if (!response.ok) return

        const data = (await response.json()) as TtsInfo
        if (cancelled) return
        if (data.display_name?.trim()) {
          setTtsInfo(data)
        }
      } catch {
        // 音色信息加载失败时使用界面兜底文案，不影响主流程
      }
    }

    void loadTtsInfo()
    return () => {
      cancelled = true
    }
  }, [])

  async function loadHistory() {
    setHistoryLoading(true)
    setHistoryError('')

    try {
      const response = await fetch(`${API_BASE_URL}/api/tasks?limit=20`)
      const data = (await response.json()) as
        | TaskSummary[]
        | { detail?: string }

      if (!response.ok) {
        const detail =
          !Array.isArray(data) && typeof data.detail === 'string'
            ? data.detail
            : `HTTP ${response.status}`
        throw new Error(detail)
      }

      if (!Array.isArray(data)) {
        throw new Error('历史任务数据格式异常')
      }

      setHistory(data)
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : '历史记录加载失败',
      )
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    void loadHistory()
  }, [])

  function appendMessage(role: ChatRole, content: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages((previous) => [...previous, { id, role, content }])
    return id
  }

  function truncateForTts(text: string, limit = 900) {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= limit) return normalized

    const slice = normalized.slice(0, limit)
    const lastStop = Math.max(
      slice.lastIndexOf('。'),
      slice.lastIndexOf('！'),
      slice.lastIndexOf('？'),
      slice.lastIndexOf('.'),
      slice.lastIndexOf('!'),
      slice.lastIndexOf('?'),
    )
    return lastStop > limit * 0.6 ? slice.slice(0, lastStop + 1) : slice
  }

  /** 左侧聊天回答自动语音播报；直播正在播放时先暂停直播。 */
  async function speakChatReply(text: string, messageId: string) {
    if (!text.trim()) return

    if (livePlaybackRef.current) {
      resumePointRef.current = {
        index: liveIndexRef.current,
        step: liveStepRef.current,
      }
      liveSessionRef.current += 1
      livePlaybackRef.current.stop()
      livePlaybackRef.current = null
      setLiveState('paused')
    }

    chatPlaybackRef.current?.stop()

    const playback = playTts(truncateForTts(text), {
      speed: ttsSpeedRef.current,
    })
    chatPlaybackRef.current = playback
    setSpeakingMessageId(messageId)

    try {
      await playback.finished
    } catch {
      // 语音失败不影响文字回答
    } finally {
      if (chatPlaybackRef.current === playback) {
        chatPlaybackRef.current = null
        setSpeakingMessageId(null)
      }
    }
  }

  useEffect(() => {
    const element = chatScrollRef.current
    if (element) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages, chatLoading])

  useEffect(() => {
    return () => {
      liveSessionRef.current += 1
      livePlaybackRef.current?.stop()
      recognitionRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return

      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return
      }

      // 空格：举手打断
      if (event.code === 'Space') {
        if (liveState !== 'playing' && liveState !== 'waiting') return
        event.preventDefault()
        void interruptClass()
        return
      }

      if (liveState !== 'waiting') return

      // 回车 / 右方向键：听懂了，下一步
      if (event.code === 'Enter' || event.code === 'ArrowRight') {
        event.preventDefault()
        handleUnderstood()
        return
      }

      // R 键：没听懂，再讲讲
      if (event.code === 'KeyR') {
        event.preventDefault()
        void handleNotUnderstood()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [liveState])

  useEffect(() => {
    if (phase !== 'processing' || taskId === null) return

    let cancelled = false

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`)
        const data = (await response.json()) as TaskDetail

        if (cancelled) return

        if (!response.ok) {
          throw new Error(data.detail ?? `HTTP ${response.status}`)
        }

        if (typeof data.progress === 'number') {
          setProcessingProgress(
            Math.max(0, Math.min(100, Math.round(data.progress))),
          )
        }
        if (typeof data.status_message === 'string') {
          setProcessingMessage(data.status_message)
        }

        if (data.status === 'completed') {
          clearInterval(timer)
          setResult(data.result ?? '')
          const segments = normalizeStoryboard(data.storyboard)
          setStoryboard(
            segments.length > 0
              ? segments
              : buildFallbackStoryboard(data.result ?? ''),
          )
          setLiveIndex(0)
          setPhase('completed')
          resetLiveSession(0)
          appendMessage('assistant', pickLine(READY_LINES))
          void loadHistory()
        } else if (data.status === 'failed') {
          clearInterval(timer)
          setUploadMessage(data.result ?? '音频处理失败，请重新上传')
          setPhase('failed')
          resetLiveSession(0)
          appendMessage('assistant', pickLine(FAILED_LINES))
          void loadHistory()
        }
      } catch (error) {
        if (cancelled) return
        clearInterval(timer)
        setPhase('error')
        setUploadMessage(
          error instanceof Error ? error.message : '查询任务状态失败',
        )
      }
    }, POLL_INTERVAL)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [phase, taskId])

  function setLivePosition(index: number, step = -1) {
    liveIndexRef.current = index
    liveStepRef.current = step
    setLiveIndex(index)
    setLiveStepIndex(step)
  }

  function resetLiveSession(nextIndex = 0) {
    liveSessionRef.current += 1
    livePlaybackRef.current?.stop()
    livePlaybackRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    setLiveState('idle')
    setLiveError('')
    setLiveCaption('')
    setLiveFocus('')
    setLiveHighlightLines([])
    setIsPreparing(false)
    setQuizChoice(null)
    setQuizVerdict(null)
    setLivePosition(nextIndex, -1)
  }

  function stopClass() {
    liveSessionRef.current += 1
    livePlaybackRef.current?.stop()
    livePlaybackRef.current = null
    recognitionRef.current?.abort()
    recognitionRef.current = null
    setIsPreparing(false)
    setLiveState('idle')
  }

  async function speakWithTts(text: string, session: number) {
    if (liveSessionRef.current !== session) return

    setLiveCaption(text)
    const playback = playTts(text, { speed: ttsSpeedRef.current })
    livePlaybackRef.current = playback

    // 音频真正开始播放后，隐藏“正在准备”提示；缓存命中时也至少展示 500ms
    void playback.started.then(() => {
      const elapsed = Date.now() - prepareStartedAtRef.current
      const delay = Math.max(0, 500 - elapsed)
      window.setTimeout(() => {
        if (liveSessionRef.current === session) {
          setIsPreparing(false)
        }
      }, delay)
    })

    try {
      await playback.finished
    } finally {
      if (livePlaybackRef.current === playback) {
        livePlaybackRef.current = null
      }
    }
  }

  async function playStep(
    segmentIndex: number,
    stepIndex: number,
    session: number,
  ) {
    if (liveSessionRef.current !== session) return

    const segment = liveStoryboard[segmentIndex]
    const step = segment?.step_by_step[stepIndex]
    if (!segment || !step) {
      setLiveState('ended')
      return
    }

    setLivePosition(segmentIndex, stepIndex)
    setLiveFocus(step.board_highlight)
    setLiveHighlightLines(step.highlight_lines)
    setLiveError('')

    const nextStep = segment.step_by_step[stepIndex + 1]
    if (nextStep) {
      prefetchTts(nextStep.speech_text)
    }

    try {
      await speakWithTts(step.speech_text, session)
    } catch (error) {
      if (liveSessionRef.current !== session) return
      setLiveError(
        error instanceof Error ? error.message : '语音播放失败',
      )
      setLiveState('idle')
      appendMessage('assistant', pickLine(TTS_ERROR_LINES))
      return
    }

    if (liveSessionRef.current !== session) return

    // 最后一步讲完后，如果本分镜配有随堂小测，先答题再继续
    const isLastStep = stepIndex >= segment.step_by_step.length - 1
    if (isLastStep && segment.quiz) {
      setQuizChoice(null)
      setQuizVerdict(null)
      setLiveState('quiz')
      prefetchTts(segment.quiz.explanation_correct)
      prefetchTts(segment.quiz.explanation_wrong)
      prefetchTts(segment.quiz.explanation_guess)
      return
    }

    // 每讲完一步就停下来，等待学生确认懂了或没懂
    setLiveState('waiting')
  }

  async function playSegmentIntro(segmentIndex: number, session: number) {
    if (liveSessionRef.current !== session) return

    const segment = liveStoryboard[segmentIndex]
    if (!segment) {
      setLiveState('ended')
      return
    }

    setLivePosition(segmentIndex, -1)
    setLiveFocus('')
    setLiveHighlightLines(segment.highlight_lines)
    setLiveError('')

    if (segment.step_by_step[0]) {
      prefetchTts(segment.step_by_step[0].speech_text)
    }

    if (segment.speech_text.trim()) {
      try {
        await speakWithTts(segment.speech_text, session)
      } catch (error) {
        if (liveSessionRef.current !== session) return
        setLiveError(
          error instanceof Error ? error.message : '语音播放失败',
        )
        setLiveState('idle')
        appendMessage('assistant', pickLine(TTS_ERROR_LINES))
        return
      }
      if (liveSessionRef.current !== session) return
    }

    void playStep(segmentIndex, 0, session)
  }

  function startClass() {
    if (isLiveActive) return
    if (!liveStoryboard.length) {
      setLiveError('当前笔记没有可讲解的分镜')
      return
    }

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    const startIndex = liveState === 'ended' ? 0 : liveIndexRef.current

    // 开始上课前停掉左侧聊天的语音，避免两个声音叠在一起
    chatPlaybackRef.current?.stop()
    chatPlaybackRef.current = null
    setSpeakingMessageId(null)

    setLiveError('')
    setQuizChoice(null)
    setQuizVerdict(null)
    setPrepareLine(pickLine(PREPARE_LINES))
    prepareStartedAtRef.current = Date.now()
    setIsPreparing(true)
    setLiveState('playing')
    void playSegmentIntro(startIndex, session)
  }

  function advanceAfterQuiz(segmentIndex: number, session: number) {
    if (liveSessionRef.current !== session) return

    if (segmentIndex + 1 < liveStoryboard.length) {
      setLiveState('playing')
      void playSegmentIntro(segmentIndex + 1, session)
      return
    }

    setLiveState('ended')
    appendMessage('assistant', pickLine(FINISHED_LINES))
  }

  function handleQuizSelect(letter: string) {
    if (liveState !== 'quiz' || quizChoice) return

    const segment = liveStoryboard[liveIndexRef.current]
    const quiz = segment?.quiz
    if (!quiz) return

    setQuizChoice(letter)

    if (letter === quiz.correct_answer) {
      setQuizVerdict('correct')
      return
    }

    setQuizVerdict('wrong')
    void playQuizFeedback('wrong', letter)
  }

  async function playQuizFeedback(
    kind: 'correct' | 'wrong' | 'guess',
    chosen = '',
  ) {
    const segmentIndex = liveIndexRef.current
    const segment = liveStoryboard[segmentIndex]
    const quiz = segment?.quiz
    if (!quiz) return

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    setLiveError('')
    setLiveState('quiz-feedback')
    setLiveCaption(pickLine(THINKING_LINES))

    let text = ''
    try {
      text = await requestQuizFeedback(quiz, kind, chosen)
    } catch {
      // 大模型反馈失败时，退回分镜里预生成的讲解，保证课堂不中断
      text =
        kind === 'correct'
          ? quiz.explanation_correct
          : kind === 'wrong'
            ? quiz.explanation_wrong
            : quiz.explanation_guess
    }

    if (liveSessionRef.current !== session) return

    try {
      await speakWithTts(text, session)
    } catch (error) {
      if (liveSessionRef.current !== session) return
      setLiveError(
        error instanceof Error ? error.message : '语音播放失败',
      )
      setLiveState('quiz')
      return
    }

    if (liveSessionRef.current !== session) return
    advanceAfterQuiz(segmentIndex, session)
  }

  function handleUnderstood() {
    if (liveState !== 'waiting') return

    const segmentIndex = liveIndexRef.current
    const stepIndex = liveStepRef.current
    const segment = liveStoryboard[segmentIndex]
    if (!segment) return

    const session = liveSessionRef.current
    setLiveError('')

    if (stepIndex + 1 < segment.step_by_step.length) {
      setLiveState('playing')
      void playStep(segmentIndex, stepIndex + 1, session)
      return
    }

    if (segmentIndex + 1 < liveStoryboard.length) {
      setLiveState('playing')
      void playSegmentIntro(segmentIndex + 1, session)
      return
    }

    setLiveState('ended')
    appendMessage('assistant', pickLine(FINISHED_LINES))
  }

  async function handleNotUnderstood() {
    if (liveState !== 'waiting') return

    const segmentIndex = liveIndexRef.current
    const stepIndex = liveStepRef.current
    const segment = liveStoryboard[segmentIndex]
    const step = segment?.step_by_step[stepIndex]
    if (!segment || !step) return

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    setLiveError('')
    setLiveState('explaining')
    setLiveCaption(pickLine(EXPLAINING_LINES))

    try {
      const response = await fetch(`${API_BASE_URL}/api/explain_again`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          board_content: segment.board_content,
          step_speech: step.speech_text,
          subject: subject.trim() || '通用课程',
        }),
      })

      const data = (await response.json()) as ExplainAgainResponse
      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }
      if (
        typeof data.explanation !== 'string' ||
        !data.explanation.trim()
      ) {
        throw new Error('重新解释接口返回内容为空')
      }
      if (liveSessionRef.current !== session) return

      await speakWithTts(data.explanation.trim().slice(0, 1000), session)
      if (liveSessionRef.current !== session) return

      // 重新解释完仍停留在当前步骤，等待学生再次确认
      setLiveState('waiting')
    } catch (error) {
      if (liveSessionRef.current !== session) return

      const message =
        error instanceof Error ? error.message : '重新解释失败'
      setLiveError(message)
      appendMessage('assistant', pickLine(EXPLAIN_ERROR_LINES))
      setLiveState('waiting')
    }
  }

  function listenOnce(): Promise<string> {
    return new Promise((resolve, reject) => {
      const RecognitionCtor = getSpeechRecognitionCtor()
      if (!RecognitionCtor) {
        reject(
          new Error('当前浏览器不支持麦克风识别，请使用 Chrome 或 Edge 浏览器'),
        )
        return
      }

      const recognition = new RecognitionCtor()
      recognition.lang = 'zh-CN'
      recognition.continuous = false
      recognition.interimResults = false
      recognition.maxAlternatives = 1

      let settled = false
      let timer = 0

      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null
        }
        action()
      }

      timer = window.setTimeout(() => {
        finish(() => {
          try {
            recognition.stop()
          } catch {
            // 已结束时 stop 可能抛错，忽略即可
          }
          resolve('')
        })
      }, RECOGNITION_TIMEOUT)

      recognition.onresult = (event) => {
        let transcript = ''
        for (let i = 0; i < event.results.length; i += 1) {
          const alternative = event.results[i]?.[0]
          if (alternative?.transcript) {
            transcript += alternative.transcript
          }
        }
        finish(() => resolve(transcript.trim()))
      }

      recognition.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') {
          finish(() => resolve(''))
          return
        }

        const message =
          event.error === 'not-allowed'
            ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试'
            : event.error === 'audio-capture'
              ? '未检测到可用的麦克风设备'
              : '语音识别失败，请稍后重试'
        finish(() => reject(new Error(message)))
      }

      recognition.onend = () => {
        finish(() => resolve(''))
      }

      recognitionRef.current = recognition
      try {
        recognition.start()
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  async function requestTeacherAnswer(question: string, context: string) {
    const response = await fetch(`${API_BASE_URL}/api/ask_teacher`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_question: question,
        context,
        subject: subject.trim() || '通用课程',
      }),
    })

    const data = (await response.json()) as AskTeacherResponse

    if (!response.ok) {
      throw new Error(data.detail ?? `HTTP ${response.status}`)
    }
    if (typeof data.answer !== 'string' || !data.answer.trim()) {
      throw new Error('答疑接口返回内容为空')
    }

    return {
      intent:
        data.intent === 'pause'
          ? 'pause'
          : data.intent === 'slow_down'
            ? 'slow_down'
            : data.intent === 'speed_up'
              ? 'speed_up'
              : 'question',
      answer: data.answer.trim(),
    }
  }

  /** 由大模型现场生成串场语；失败时才用本地文案兜底 */
  async function requestTeacherCue(
    event: 'interrupt' | 'resume',
    context = '',
  ) {
    const fallback =
      event === 'interrupt'
        ? pickLine(INTERRUPT_CUE_FALLBACKS)
        : pickLine(RESUME_CUE_FALLBACKS)

    try {
      const response = await fetch(`${API_BASE_URL}/api/teacher_cue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event,
          context,
          subject: subject.trim() || '通用课程',
        }),
      })

      const data = (await response.json()) as TeacherCueResponse
      if (
        !response.ok ||
        typeof data.text !== 'string' ||
        !data.text.trim()
      ) {
        return fallback
      }
      return data.text.trim()
    } catch {
      return fallback
    }
  }

  /** 随堂小测反馈：答对 / 答错 / 蒙对都由大模型现场生成 */
  async function requestQuizFeedback(
    quiz: StoryboardQuiz,
    kind: 'correct' | 'wrong' | 'guess',
    chosen: string,
  ) {
    const response = await fetch(`${API_BASE_URL}/api/quiz_feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: quiz.question,
        options: quiz.options,
        correct_answer: quiz.correct_answer,
        chosen_answer: chosen,
        kind,
        subject: subject.trim() || '通用课程',
      }),
    })

    const data = (await response.json()) as QuizFeedbackResponse
    if (!response.ok) {
      throw new Error(data.detail ?? `HTTP ${response.status}`)
    }
    if (typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new Error('随堂反馈接口返回内容为空')
    }
    return data.reply.trim()
  }

  /** 提交打断时的问题（语音或文字），走意图识别 + 语音回答 */
  async function handleInterruptQuestion(question: string) {
    const session = liveSessionRef.current
    const contextText = interruptContextRef.current ?? ''

    appendMessage('user', question)
    setShowInterruptInput(false)
    setInterruptInput('')
    setLiveState('thinking')
    setLiveCaption(pickLine(THINKING_LINES))

    try {
      const result = await requestTeacherAnswer(question, contextText)
      if (liveSessionRef.current !== session) return

      appendMessage('assistant', result.answer)
      setLiveState('interrupting')
      await speakWithTts(result.answer.slice(0, 1000), session)
      if (liveSessionRef.current !== session) return

      if (result.intent === 'slow_down' || result.intent === 'speed_up') {
        // 学生要求调整语速：切到对应原生语速，回应完直接接着讲
        changeTtsSpeed(result.intent === 'slow_down' ? 0.8 : 1.0)
        resumeAfterInterrupt()
        return
      }

      if (result.intent === 'question') {
        setLiveState('resuming')
        const cue = await requestTeacherCue('resume', contextText)
        if (liveSessionRef.current !== session) return
        await speakWithTts(cue, session)
        if (liveSessionRef.current !== session) return
      }

      // 不自动恢复，等待学生点击继续
      setLiveState('paused')
    } catch (error) {
      if (liveSessionRef.current !== session) return

      const message = error instanceof Error ? error.message : '答疑流程失败'
      setLiveError(message)
      appendMessage('assistant', pickLine(QA_ERROR_LINES))
      setLiveState('paused')
    }
  }

  async function interruptClass() {
    if (!isLiveActive) return

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    const interruptedIndex = liveIndexRef.current
    const interruptedStep = liveStepRef.current
    const interruptedSegment = liveStoryboard[interruptedIndex]
    const contextText =
      interruptedStep >= 0
        ? interruptedSegment?.step_by_step[interruptedStep]?.speech_text ?? ''
        : interruptedSegment?.speech_text ?? ''

    resumePointRef.current = {
      index: interruptedIndex,
      step: interruptedStep,
    }
    interruptContextRef.current = contextText

    // 立刻停止所有正在播放的语音
    livePlaybackRef.current?.stop()
    livePlaybackRef.current = null
    chatPlaybackRef.current?.stop()
    chatPlaybackRef.current = null
    setSpeakingMessageId(null)

    setLiveError('')
    setShowInterruptInput(false)
    setInterruptInput('')
    setLiveState('interrupting')

    try {
      const greeting = await requestTeacherCue('interrupt', contextText)
      if (liveSessionRef.current !== session) return
      await speakWithTts(greeting, session)
      if (liveSessionRef.current !== session) return

      setLiveState('listening')
      setLiveCaption(pickLine(LISTENING_LINES))
      const question = await listenOnce()
      if (liveSessionRef.current !== session) return

      if (!question) {
        setShowInterruptInput(true)
        setLiveCaption(pickLine(NO_SPEECH_LINES))
        return
      }

      await handleInterruptQuestion(question)
    } catch (error) {
      if (liveSessionRef.current !== session) return

      const message = error instanceof Error ? error.message : '打断流程失败'
      setLiveError(message)
      setShowInterruptInput(true)
      setLiveCaption(pickLine(MIC_ERROR_LINES))
    }
  }

  function resumeAfterInterrupt() {
    const point = resumePointRef.current
    const session = liveSessionRef.current + 1
    liveSessionRef.current = session

    setShowInterruptInput(false)
    setLiveError('')

    if (!point) {
      setLiveState('idle')
      return
    }

    setLiveState('playing')
    if (point.step >= 0) {
      void playStep(point.index, point.step, session)
    } else {
      void playSegmentIntro(point.index, session)
    }
  }

  function goToLiveSegment(index: number) {
    if (isLiveBusy) return
    if (index < 0 || index >= liveStoryboard.length) return

    livePlaybackRef.current?.stop()
    livePlaybackRef.current = null
    liveSessionRef.current += 1

    setLivePosition(index, -1)
    setLiveCaption('')
    setLiveFocus('')
    setLiveHighlightLines([])
    setLiveError('')
    setLiveState('idle')
  }

  function changeTtsSpeed(speed: number) {
    ttsSpeedRef.current = speed
    setTtsSpeedState(speed)
    setTtsSpeed(speed)
    setIsSlowMode(speed < 0.95)
  }

  /** 语速切换：慢速 0.8x ⇄ 正常 1.0x，切换后立刻用新语速重播当前这一句 */
  async function toggleSlowMode() {
    const nextSlow = !isSlowMode
    const nextSpeed = nextSlow ? 0.8 : 1.0
    changeTtsSpeed(nextSpeed)

    if (!isLiveActive) return
    if (
      liveState === 'quiz' ||
      liveState === 'quiz-feedback' ||
      liveState === 'interrupting' ||
      liveState === 'listening' ||
      liveState === 'thinking'
    ) {
      return
    }

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    const point = {
      index: liveIndexRef.current,
      step: liveStepRef.current,
    }
    const segment = liveStoryboard[point.index]
    const contextText =
      point.step >= 0
        ? segment?.step_by_step[point.step]?.speech_text ?? ''
        : segment?.speech_text ?? ''
    const wasPlaying =
      liveState === 'playing' ||
      liveState === 'explaining' ||
      liveState === 'resuming'
    const wasPaused = liveState === 'paused'

    livePlaybackRef.current?.stop()
    livePlaybackRef.current = null

    setLiveState('thinking')
    setLiveCaption(pickLine(THINKING_LINES))

    try {
      const result = await requestTeacherAnswer(
        nextSlow ? '老师，能讲慢一点吗？' : '老师，可以讲快一点吗？',
        contextText,
      )
      if (liveSessionRef.current !== session) return
      setLiveState('interrupting')
      await speakWithTts(result.answer.slice(0, 1000), session)
    } catch {
      // 语速已经切换成功，串场语失败不影响继续讲课
    }

    if (liveSessionRef.current !== session) return

    if (wasPlaying) {
      setLiveState('playing')
      if (point.step >= 0) {
        void playStep(point.index, point.step, session)
      } else {
        void playSegmentIntro(point.index, session)
      }
      return
    }

    setLiveState(wasPaused ? 'paused' : 'waiting')
  }

  async function uploadPptFile(subjectValue: string): Promise<number> {
    if (!selectedPpt) {
      throw new Error('未选择 PPT 文件')
    }

    const formData = new FormData()
    formData.append('file', selectedPpt)
    formData.append('subject', subjectValue)

    setUploadStage('ppt')
    setUploadProgress(null)

    const data = await uploadFormData<UploadResponse>(
      '/api/upload_ppt',
      formData,
      { onProgress: setUploadProgress },
    )

    if (typeof data.task_id !== 'number') {
      throw new Error('PPT 上传接口返回数据异常')
    }

    setPptTaskId(data.task_id)
    return data.task_id
  }

  async function uploadFiles() {
    if (!selectedFiles.length || phase === 'uploading') return

    const normalizedSubject = subject.trim()

    setBatchCount(selectedFiles.length)
    setTaskId(null)
    setResult('')
    setUploadMessage('')
    setCopyState('idle')
    setUploadStage(null)
    setUploadProgress(null)
    setStoryboard([])
    resetLiveSession(0)
    setPhase('uploading')

    try {
      const formData = new FormData()
      let currentTaskId = pptTaskId

      if (selectedPpt) {
        if (currentTaskId === null) {
          currentTaskId = await uploadPptFile(normalizedSubject)
        }
        formData.append('task_id', String(currentTaskId))
      }

      if (normalizedSubject) {
        formData.append('subject', normalizedSubject)
      }
      selectedFiles.forEach((file) => {
        formData.append('files', file)
      })

      setUploadStage('audio')
      setUploadProgress(null)

      const data = await uploadFormData<UploadResponse>(
        '/api/upload',
        formData,
        { onProgress: setUploadProgress },
      )

      if (typeof data.task_id !== 'number') {
        throw new Error('上传接口返回数据异常')
      }

      setUploadStage(null)
      setUploadProgress(null)
      setProcessingProgress(0)
      setProcessingMessage('任务已创建，正在排队处理…')
      setTaskId(data.task_id)
      setPhase('processing')
      void loadHistory()
    } catch (error) {
      setUploadStage(null)
      setUploadProgress(null)
      setPhase('error')
      setUploadMessage(
        error instanceof Error ? error.message : '上传失败，请稍后重试',
      )
    }
  }

  function handleAudioFiles(
    fileList: FileList | File[] | null | undefined,
  ) {
    if (!fileList || phase === 'uploading') return

    const incoming = Array.from(fileList)
    if (!incoming.length) return

    const invalid = incoming.find((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      return (
        !ALLOWED_AUDIO_EXTENSIONS.includes(extension) ||
        file.size > MAX_UPLOAD_SIZE
      )
    })

    if (invalid) {
      setPhase('error')
      setUploadMessage(
        invalid.size > MAX_UPLOAD_SIZE
          ? `文件「${invalid.name}」大小不能超过 ${MAX_UPLOAD_SIZE_LABEL}`
          : `文件「${invalid.name}」格式不支持，仅支持 MP3、WAV、M4A`,
      )
      return
    }

    // 追加而不是覆盖；同名同大小视为重复文件，自动忽略
    setSelectedFiles((previous) => {
      const keys = new Set(previous.map(audioFileKey))
      const unique = incoming.filter((file) => {
        const key = audioFileKey(file)
        if (keys.has(key)) return false
        keys.add(key)
        return true
      })
      return [...previous, ...unique]
    })

    const combined = [...selectedFiles, ...incoming]
    const needsConvert = combined.some((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      return file.size > LARGE_FILE_WARNING_SIZE && extension !== 'mp3'
    })

    setLargeFileHint(needsConvert ? LARGE_FILE_WARNING : '')
    setBatchCount(0)
    setTaskId(null)
    setPhase('idle')
    setUploadMessage('')
    setCopyState('idle')
    setUploadStage(null)
    setUploadProgress(null)
  }

  function removeAudioFile(index: number) {
    const next = selectedFiles.filter(
      (_, itemIndex) => itemIndex !== index,
    )
    setSelectedFiles(next)

    if (!next.length) {
      setLargeFileHint('')
      setBatchCount(0)
    }
    setUploadStage(null)
    setUploadProgress(null)
    if (phase === 'error') {
      setPhase('idle')
      setUploadMessage('')
    }
  }

  function handlePptFile(file: File | null | undefined) {
    if (!file || phase === 'uploading') return

    if (!file.name.toLowerCase().endsWith('.pptx')) {
      setSelectedPpt(null)
      setPptTaskId(null)
      setPhase('error')
      setUploadMessage('PPT 课件仅支持 .pptx 格式')
      return
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      setSelectedPpt(null)
      setPptTaskId(null)
      setPhase('error')
      setUploadMessage(
        `PPT 文件大小不能超过 ${MAX_UPLOAD_SIZE_LABEL}`,
      )
      return
    }

    setSelectedPpt(file)
    setPptTaskId(null)
    setUploadMessage('')
    setUploadStage(null)
    setUploadProgress(null)
    setPhase('idle')
  }

  /** 从拖拽事件里取文件；微信等客户端偶尔只写 items，不写 files。 */
  function extractDroppedFiles(event: DragEvent<HTMLElement>) {
    const transfer = event.dataTransfer
    if (!transfer) return []

    const files = Array.from(transfer.files ?? [])
    if (files.length > 0) return files

    const fromItems: File[] = []
    for (const item of Array.from(transfer.items ?? [])) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) fromItems.push(file)
    }
    return fromItems
  }

  function handleUploadDragOver(
    event: DragEvent<HTMLElement>,
    target: 'ppt' | 'audio',
  ) {
    if (phase === 'uploading') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragTarget(target)
  }

  function handleUploadDragLeave(
    event: DragEvent<HTMLElement>,
    target: 'ppt' | 'audio',
  ) {
    // 在子元素之间移动时也会触发 dragleave，用 relatedTarget 过滤掉
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setDragTarget((current) => (current === target ? null : current))
  }

  function handleUploadDrop(
    event: DragEvent<HTMLElement>,
    target: 'ppt' | 'audio',
  ) {
    event.preventDefault()
    event.stopPropagation()
    setDragTarget(null)

    if (phase === 'uploading') return

    const files = extractDroppedFiles(event)
    if (!files.length) {
      setPhase('error')
      setUploadMessage('没有识别到文件，请从微信聊天窗口重新拖拽一次')
      return
    }

    if (target === 'ppt') {
      const ppt = files.find((file) =>
        file.name.toLowerCase().endsWith('.pptx'),
      )
      if (!ppt) {
        setPhase('error')
        setUploadMessage('PPT 课件仅支持 .pptx 格式')
        return
      }
      handlePptFile(ppt)
      return
    }

    handleAudioFiles(files)
  }

  function resetFlow() {
    resetLiveSession(0)
    setPhase('idle')
    setSelectedFiles([])
    setSelectedPpt(null)
    setPptTaskId(null)
    setBatchCount(0)
    setTaskId(null)
    setResult('')
    setUploadMessage('')
    setCopyState('idle')
    setUploadStage(null)
    setUploadProgress(null)
    setProcessingProgress(0)
    setProcessingMessage('')
    setStoryboard([])
  }

  async function openHistoryTask(id: number) {
    resetLiveSession(0)
    setHistoryError('')
    setUploadMessage('')
    setResult('')
    setCopyState('idle')
    setSelectedFiles([])
    setSelectedPpt(null)
    setPptTaskId(null)
    setBatchCount(0)
    setStoryboard([])

    try {
      const response = await fetch(`${API_BASE_URL}/api/task/${id}`)
      const data = (await response.json()) as TaskDetail

      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }

      setTaskId(id)
      if (data.subject?.trim()) {
        setSubject(data.subject.trim())
      }

      if (data.status === 'completed') {
        const nextResult = data.result ?? ''
        const segments = normalizeStoryboard(data.storyboard)
        setResult(nextResult)
        setStoryboard(
          segments.length > 0
            ? segments
            : buildFallbackStoryboard(nextResult),
        )
        setPhase('completed')
      } else if (data.status === 'failed') {
        setUploadMessage(data.result ?? '该任务处理失败')
        setPhase('failed')
      } else {
        setProcessingProgress(
          typeof data.progress === 'number' ? data.progress : 0,
        )
        setProcessingMessage(
          data.status_message ?? '正在处理，请耐心等待…',
        )
        setPhase('processing')
      }
    } catch (error) {
      setPhase('error')
      setUploadMessage(
        error instanceof Error ? error.message : '加载历史任务失败',
      )
    }
  }

  async function loadMockTask() {
    if (mockLoading) return

    setMockLoading(true)

    try {
      const response = await fetch(`${API_BASE_URL}/api/mock_task`)
      const data = (await response.json()) as TaskDetail

      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }
      if (data.status !== 'completed') {
        throw new Error('测试数据状态异常')
      }

      const segments = normalizeStoryboard(data.storyboard)
      if (!segments.length) {
        throw new Error('测试数据缺少可用的分镜')
      }

      resetLiveSession(0)
      setPhase('completed')
      setTaskId(data.task_id ?? 0)
      setSubject(data.subject?.trim() || '测试课程')
      setResult(data.result ?? '')
      setStoryboard(segments)
      setSelectedFiles([])
      setSelectedPpt(null)
      setPptTaskId(null)
      setBatchCount(0)
      setUploadMessage('')
      setCopyState('idle')
      setHistoryError('')
      appendMessage(
        'assistant',
        '已加载测试数据，可直接点击「开始上课」验证直播间。',
      )
    } catch (error) {
      appendMessage(
        'assistant',
        `测试数据加载失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      )
    } finally {
      setMockLoading(false)
    }
  }

  async function copyResult() {
    if (!result) return

    let success = false

    try {
      await navigator.clipboard.writeText(result)
      success = true
    } catch {
      success = fallbackCopy(result)
    }

    setCopyState(success ? 'copied' : 'error')
    window.setTimeout(() => setCopyState('idle'), 2000)
  }

  async function sendChat(messageOverride?: string) {
    const text = (messageOverride ?? chatInput).trim()
    if (!text || chatLoading) return

    appendMessage('user', text)
    setChatInput('')
    setChatLoading(true)

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          subject: subject.trim() || '通用课程',
          note_context: result || null,
        }),
      })

      const data = (await response.json()) as ChatResponse

      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }

      if (typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new Error('对话接口返回内容为空')
      }

      const replyId = appendMessage('assistant', data.reply)
      void speakChatReply(data.reply, replyId)
    } catch (error) {
      appendMessage(
        'assistant',
        `抱歉，我暂时无法回答：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      )
    } finally {
      setChatLoading(false)
    }
  }

  function runQuickAction(action: 'summary' | 'explain') {
    if (chatLoading) return

    if (!result) {
      appendMessage('assistant', pickLine(NEED_NOTE_LINES))
      return
    }

    const prompt =
      action === 'summary'
        ? '请总结当前复习笔记的核心内容，并列出 3 个复习重点。'
        : '请从当前复习笔记中选择一个重要概念，并用通俗语言解释。'

    void sendChat(prompt)
  }

  const showUploadArea =
    phase !== 'processing' && phase !== 'completed' && phase !== 'failed'

  const canStart = selectedFiles.length > 0 && phase !== 'uploading'

  const uploadPercent =
    uploadProgress && uploadProgress.total > 0
      ? Math.min(
          100,
          Math.round((uploadProgress.loaded / uploadProgress.total) * 100),
        )
      : 0

  const liveStatusLabel =
    liveState === 'playing'
      ? '正在讲解'
      : liveState === 'waiting'
        ? '等待你确认'
        : liveState === 'quiz'
          ? '随堂小测'
          : liveState === 'quiz-feedback'
            ? '老师点评'
            : liveState === 'paused'
              ? '已暂停'
              : liveState === 'explaining'
              ? '换种讲法'
              : liveState === 'interrupting'
                ? '讲师回应'
                : liveState === 'listening'
                  ? '正在聆听'
                  : liveState === 'thinking'
                    ? '正在思考'
                    : liveState === 'resuming'
                      ? '继续讲课'
                      : liveState === 'ended'
                        ? '本节结束'
                        : '待开始'

  const liveStatusTone =
    liveState === 'playing'
      ? 'bg-sky-400/10 text-sky-300 border-sky-400/30'
      : liveState === 'waiting'
        ? 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30'
        : liveState === 'quiz'
          ? 'bg-indigo-400/10 text-indigo-300 border-indigo-400/30'
          : liveState === 'quiz-feedback'
            ? 'bg-violet-400/10 text-violet-300 border-violet-400/30'
            : liveState === 'paused'
              ? 'bg-amber-400/10 text-amber-300 border-amber-400/30'
              : liveState === 'explaining'
              ? 'bg-fuchsia-400/10 text-fuchsia-300 border-fuchsia-400/30'
              : liveState === 'listening'
                ? 'bg-amber-400/10 text-amber-300 border-amber-400/30'
                : liveState === 'thinking' || liveState === 'interrupting'
                  ? 'bg-violet-400/10 text-violet-300 border-violet-400/30'
                  : liveState === 'resuming'
                    ? 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30'
                    : 'bg-white/5 text-slate-400 border-white/15'

  return (
    <main className="min-h-screen bg-slate-100 lg:h-screen lg:overflow-hidden">
      <div className="flex min-h-screen flex-col lg:h-full lg:flex-row">
        <aside className="flex h-[65vh] min-h-[420px] shrink-0 flex-col border-b border-slate-200 bg-white lg:h-full lg:min-h-0 lg:w-2/5 lg:border-b-0 lg:border-r">
          <header className="border-b border-slate-100 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-900 text-sm font-semibold text-white">
                AI
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  课堂学习助手
                </p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-emerald-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  在线 · 结合当前笔记回答
                </p>
              </div>
            </div>
          </header>

          <div
            ref={chatScrollRef}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
          >
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${
                  message.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                {message.role === 'user' ? (
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-slate-900 px-4 py-2.5 text-sm leading-6 text-white">
                    {message.content}
                  </div>
                ) : (
                  <div className="chat-markdown max-w-[85%] rounded-2xl border border-slate-200 bg-white px-4 py-2.5">
                    {speakingMessageId === message.id && (
                      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-sky-600">
                        <svg
                          className="h-3.5 w-3.5 animate-pulse"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
                          />
                        </svg>
                        老师正在语音解答…
                      </div>
                    )}
                    <MarkdownView content={message.content} />
                  </div>
                )}
              </div>
            ))}

            {chatLoading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-slate-100 bg-white p-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => runQuickAction('summary')}
                disabled={!result || chatLoading}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 transition hover:border-sky-300 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                总结当前笔记
              </button>
              <button
                type="button"
                onClick={() => runQuickAction('explain')}
                disabled={!result || chatLoading}
                className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 transition hover:border-sky-300 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                解释某个概念
              </button>
            </div>

            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendChat()
                  }
                }}
                placeholder="问我任何关于这堂课的问题…"
                disabled={chatLoading}
                className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-sky-100 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void sendChat()}
                disabled={chatLoading || !chatInput.trim()}
                className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                发送
              </button>
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto bg-slate-100">
          <div className="mx-auto w-full max-w-4xl px-5 py-8 lg:px-8 lg:py-10">
            <header className="mb-6 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-sky-600">
                  Workspace
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                  课堂录音智能整理
                </h1>
                <p className="mt-1 text-sm text-slate-500">
                  上传课件与录音，生成笔记并进入动态板书画布
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => void loadMockTask()}
                  disabled={mockLoading || phase === 'uploading'}
                  title="跳过上传与 ASR/LLM 处理，直接加载固定分镜数据"
                  className="text-xs text-slate-400 underline decoration-dotted underline-offset-4 transition hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {mockLoading ? '加载中…' : '加载测试数据（免上传）'}
                </button>

                <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs">
                  {status === 'loading' && (
                    <span className="text-slate-500">连接中…</span>
                  )}
                  {status === 'connected' && (
                    <>
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-emerald-600">后端已连接</span>
                    </>
                  )}
                  {status === 'error' && (
                    <>
                      <span className="h-2 w-2 rounded-full bg-red-500" />
                      <span className="text-red-600" title={errorMessage}>
                        后端未连接
                      </span>
                    </>
                  )}
                </div>
              </div>
            </header>

            {showUploadArea && (
              <div
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:p-6"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => event.preventDefault()}
              >
                <p className="text-sm text-slate-500">
                  课程科目会自动识别，无需手动填写。上传课堂录音即可开始整理。
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label
                    htmlFor="ppt-upload"
                    onDragEnter={(event) => handleUploadDragOver(event, 'ppt')}
                    onDragOver={(event) => handleUploadDragOver(event, 'ppt')}
                    onDragLeave={(event) => handleUploadDragLeave(event, 'ppt')}
                    onDrop={(event) => handleUploadDrop(event, 'ppt')}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                      dragTarget === 'ppt'
                        ? 'border-sky-400 bg-sky-50 ring-2 ring-sky-200'
                        : 'border-slate-200 bg-slate-50 hover:border-sky-300 hover:bg-white'
                    } ${
                      phase === 'uploading'
                        ? 'pointer-events-none opacity-60'
                        : ''
                    }`}
                  >
                    <input
                      id="ppt-upload"
                      type="file"
                      accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                      className="hidden"
                      onChange={(event) => {
                        handlePptFile(event.target.files?.[0])
                        event.target.value = ''
                      }}
                    />
                    <svg
                      className="h-6 w-6 shrink-0 text-sky-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H4.5m6 6.75h3.75m-3.75 3h7.5m-7.5 3h4.5"
                      />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">
                        上传 PPT 课件
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {selectedPpt ? selectedPpt.name : '可选 · .pptx'}
                      </p>
                      <p className="mt-1 text-[11px] font-medium leading-4 text-sky-600">
                        💡 提示：您可以直接从微信聊天窗口将文件拖拽到此处上传
                      </p>
                    </div>
                  </label>

                  <label
                    htmlFor="audio-upload"
                    onDragEnter={(event) =>
                      handleUploadDragOver(event, 'audio')
                    }
                    onDragOver={(event) =>
                      handleUploadDragOver(event, 'audio')
                    }
                    onDragLeave={(event) =>
                      handleUploadDragLeave(event, 'audio')
                    }
                    onDrop={(event) => handleUploadDrop(event, 'audio')}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                      dragTarget === 'audio'
                        ? 'border-sky-400 bg-sky-50 ring-2 ring-sky-200'
                        : 'border-slate-200 bg-slate-50 hover:border-sky-300 hover:bg-white'
                    } ${
                      phase === 'uploading'
                        ? 'pointer-events-none opacity-60'
                        : ''
                    }`}
                  >
                    <input
                      id="audio-upload"
                      type="file"
                      multiple
                      accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
                      className="hidden"
                      onChange={(event) => {
                        handleAudioFiles(event.target.files)
                        event.target.value = ''
                      }}
                    />
                    <svg
                      className="h-6 w-6 shrink-0 text-sky-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75v-2.25M16.5 7.5 12 3m0 0-4.5 4.5M12 3v13.5"
                      />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">
                        上传音频
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {selectedFiles.length > 0
                          ? `已选择 ${selectedFiles.length} 个文件`
                          : `可多选 · MP3 / WAV / M4A · 单文件 ≤ ${MAX_UPLOAD_SIZE_LABEL}`}
                      </p>
                      <p className="mt-1 text-[11px] font-medium leading-4 text-sky-600">
                        💡 提示：您可以直接从微信聊天窗口将文件拖拽到此处上传
                      </p>
                    </div>
                  </label>
                </div>

                {selectedPpt && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                    <span className="truncate">
                      PPT：{selectedPpt.name}（{formatFileSize(selectedPpt.size)}）
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPpt(null)
                        setPptTaskId(null)
                      }}
                      className="shrink-0 text-emerald-600 transition hover:text-red-500"
                    >
                      移除
                    </button>
                  </div>
                )}

                {largeFileHint && (
                  <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    {largeFileHint}
                  </p>
                )}

                {selectedFiles.length > 0 && (
                  <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>已选择 {selectedFiles.length} 个音频</span>
                      <span>
                        共{' '}
                        {formatFileSize(
                          selectedFiles.reduce(
                            (total, file) => total + file.size,
                            0,
                          ),
                        )}
                      </span>
                    </div>
                    <ul className="mt-2 max-h-36 divide-y divide-slate-200 overflow-y-auto">
                      {selectedFiles.map((file, index) => (
                        <li
                          key={audioFileKey(file)}
                          className="flex items-center justify-between gap-3 py-1.5 text-xs"
                        >
                          <span className="truncate text-slate-600">
                            {index + 1}. {file.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-slate-400">
                              {formatFileSize(file.size)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeAudioFile(index)}
                              aria-label={`移除 ${file.name}`}
                              title="移除这个文件"
                              className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition hover:bg-red-50 hover:text-red-500"
                            >
                              ×
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void uploadFiles()}
                  disabled={!canStart}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {phase === 'uploading' && (
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  )}
                  {phase === 'uploading'
                    ? `正在上传${selectedPpt ? '课件与' : ''} ${selectedFiles.length} 个音频${
                        uploadProgress ? ` · ${uploadPercent}%` : '…'
                      }`
                    : '开始整理'}
                </button>

                {phase === 'uploading' && (
                  <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/70 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-600">
                        {uploadStage === 'ppt'
                          ? '正在上传并解析 PPT 课件…'
                          : uploadStage === 'audio'
                            ? uploadProgress && uploadPercent >= 100
                              ? '上传完成，服务器正在保存文件…'
                              : `正在上传 ${selectedFiles.length} 个音频到服务器…`
                            : '正在准备上传…'}
                      </span>
                      <span className="font-semibold tabular-nums text-sky-700">
                        {uploadProgress ? `${uploadPercent}%` : '—'}
                      </span>
                    </div>

                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r from-sky-400 to-blue-600 transition-[width] duration-200 ${
                          uploadProgress ? '' : 'w-1/4 animate-pulse'
                        }`}
                        style={
                          uploadProgress
                            ? { width: `${Math.max(uploadPercent, 2)}%` }
                            : undefined
                        }
                      />
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500">
                      <span className="tabular-nums">
                        {uploadProgress
                          ? `${formatFileSize(uploadProgress.loaded)} / ${formatFileSize(uploadProgress.total)}`
                          : '等待浏览器开始传输…'}
                      </span>
                      <span>大文件可能需要几分钟，请保持页面打开</span>
                    </div>
                  </div>
                )}

                {phase === 'error' && uploadMessage && (
                  <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                    {uploadMessage}
                  </div>
                )}
              </div>
            )}

            {phase === 'processing' && (
              <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm lg:px-8">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-[0.2em] text-sky-600">
                      Preparing
                    </p>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
                      AI 正在整理你的课堂
                    </h2>
                    <p className="mt-1.5 min-h-[1.25rem] text-sm text-slate-500">
                      {processingMessage || '正在准备处理…'}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-3xl font-semibold tabular-nums text-slate-900">
                      {processingProgress}
                      <span className="ml-0.5 text-base font-medium text-slate-400">
                        %
                      </span>
                    </p>
                  </div>
                </div>

                <div className="mt-5 h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-400 via-sky-500 to-blue-600 transition-[width] duration-700 ease-out"
                    style={{
                      width: `${Math.max(processingProgress, 2)}%`,
                    }}
                  />
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>
                    {batchCount > 0
                      ? `共 ${batchCount} 个音频${selectedPpt ? ' · 已结合 PPT' : ''}`
                      : '正在合并整理'}
                  </span>
                  <span>长音频处理较慢，请保持页面打开</span>
                </div>
              </div>
            )}

            {phase === 'completed' && (
              <div>
                {/* 全局举手打断：固定在页面右下角，任何滚动位置都能立刻暂停并提问 */}
                {isLiveActive && (
                  <button
                    type="button"
                    onClick={() => void interruptClass()}
                    className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-amber-400 px-4 py-3 text-sm font-semibold text-amber-950 shadow-2xl shadow-amber-500/40 transition hover:bg-amber-300 sm:bottom-7 sm:right-7"
                    title="随时暂停课程并提问（空格）"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 0 1 6 0v8.25a3 3 0 0 1-3 3Z"
                      />
                    </svg>
                    举手打断
                  </button>
                )}

                <div className="lecture-canvas relative overflow-hidden rounded-3xl border border-slate-800 shadow-2xl shadow-slate-900/25">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3 lg:px-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-red-400">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                        LIVE
                      </span>
                      <span className="text-sm font-medium text-slate-100">
                        动态板书画布
                      </span>
                      <span className="hidden text-xs text-slate-500 sm:inline">
                        · {subject.trim() || '通用课程'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${liveStatusTone}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            liveState === 'playing' ||
                            liveState === 'listening'
                              ? 'animate-pulse bg-current'
                              : 'bg-current opacity-60'
                          }`}
                        />
                        {liveStatusLabel}
                      </span>

                      <button
                        type="button"
                        onClick={() => goToLiveSegment(liveIndex - 1)}
                        disabled={isLiveBusy || liveIndex === 0}
                        aria-label="上一个分镜"
                        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm text-slate-300 transition hover:border-sky-400/40 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        onClick={() => goToLiveSegment(liveIndex + 1)}
                        disabled={
                          isLiveBusy || liveIndex >= liveStoryboard.length - 1
                        }
                        aria-label="下一个分镜"
                        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm text-slate-300 transition hover:border-sky-400/40 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        ›
                      </button>
                    </div>
                  </div>

                  <div className="relative px-4 pb-5 pt-5 lg:px-6">
                    <span className="lecture-canvas__number" aria-hidden="true">
                      {String(liveIndex + 1).padStart(2, '0')}
                    </span>

                    <div className="relative flex items-end justify-between gap-3">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-sky-300/70">
                        Segment {String(liveIndex + 1).padStart(2, '0')}
                        {liveStepIndex >= 0 && totalSteps > 0 && (
                          <span className="ml-2 normal-case tracking-normal text-sky-200/80">
                            步骤 {liveStepIndex + 1}/{totalSteps}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-500">
                        分镜 {liveIndex + 1} / {liveStoryboard.length || 1}
                      </span>
                    </div>

                    <div className="relative mt-4">
                      <LectureBoard
                        content={activeLiveSegment?.board_content ?? ''}
                        segmentIndex={liveIndex}
                        highlightLines={liveHighlightLines}
                        focusLabel={liveFocus}
                        isActive={
                          liveState === 'playing' ||
                          liveState === 'explaining' ||
                          liveState === 'interrupting' ||
                          liveState === 'resuming'
                        }
                      />

                      {isPreparing && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 rounded-2xl bg-[#040a14]/88 backdrop-blur-sm">
                          <span className="prep-breath" aria-hidden="true" />
                          <div className="text-center">
                            <p className="text-sm font-medium text-slate-100">
                              {prepareLine || '李老师正在准备讲稿与语音...'}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              首次合成需要几秒，请稍候
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="relative mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                        <span className="h-1.5 w-1.5 rounded-full bg-sky-400/70" />
                        实时字幕
                      </div>
                      <p
                        key={liveCaption}
                        className="caption-fade mt-1.5 min-h-[2.5rem] text-sm leading-6 text-slate-300"
                      >
                        {liveCaption ||
                          activeStep?.speech_text ||
                          activeLiveSegment?.speech_text ||
                          '点击「开始上课」，老师会一步步推导，每一步都会停下来等你确认'}
                      </p>

                      {liveFocus && (
                        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-sky-400/20 bg-sky-400/10 px-2.5 py-1 text-[11px] text-sky-200">
                          <span className="h-1 w-1 rounded-full bg-sky-300" />
                          正在聚焦：{liveFocus}
                        </p>
                      )}
                    </div>

                    {/* 举手打断：语音没听清或麦克风不可用时，改为文字提问 */}
                    {showInterruptInput && (
                      <div className="relative mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-amber-100">
                            同学，怎么啦？
                          </p>
                          <span className="text-[11px] text-slate-400">
                            说“等我一下”也可以
                          </span>
                        </div>

                        <div className="mt-2.5 flex gap-2">
                          <input
                            autoFocus
                            type="text"
                            value={interruptInput}
                            onChange={(event) =>
                              setInterruptInput(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault()
                                const question = interruptInput.trim()
                                if (question) {
                                  void handleInterruptQuestion(question)
                                }
                              }
                            }}
                            placeholder="例如：老师我去上厕所 / 等我一下 / 这里为什么这样推导？"
                            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/50 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const question = interruptInput.trim()
                              if (question) {
                                void handleInterruptQuestion(question)
                              }
                            }}
                            disabled={!interruptInput.trim()}
                            className="shrink-0 rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            发送
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setShowInterruptInput(false)
                            setLiveState('paused')
                          }}
                          className="mt-2 text-[11px] text-slate-400 underline decoration-dotted underline-offset-4 transition hover:text-slate-200"
                        >
                          先不问了
                        </button>
                      </div>
                    )}

                    {/* 暂停状态：等学生准备好再继续 */}
                    {liveState === 'paused' && !showInterruptInput && (
                      <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/[0.07] p-4">
                        <div>
                          <p className="text-sm font-medium text-amber-100">
                            要继续刚才的内容吗？
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            老师的语音已经暂停，等你准备好了再继续
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={resumeAfterInterrupt}
                            className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
                          >
                            继续刚才的内容
                          </button>
                          <button
                            type="button"
                            onClick={() => void interruptClass()}
                            className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3.5 py-2 text-xs font-medium text-amber-200 transition hover:bg-amber-400/20"
                          >
                            我还有问题
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 随堂小测：每个分镜讲完后作答，再继续下一段 */}
                    {(liveState === 'quiz' || liveState === 'quiz-feedback') &&
                      activeQuiz && (
                        <div className="relative mt-4 rounded-2xl border border-indigo-400/30 bg-indigo-400/[0.07] p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-400/15 px-2.5 py-1 text-[11px] font-semibold text-indigo-200">
                              <span className="h-1.5 w-1.5 rounded-full bg-indigo-300" />
                              随堂小测
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {liveState === 'quiz-feedback'
                                ? ''
                                : quizVerdict === 'correct'
                                  ? '答对了，是真懂还是蒙的？'
                                  : '选一个你认为正确的答案'}
                            </span>
                          </div>

                          <p className="mt-2.5 text-sm leading-7 text-slate-100">
                            {activeQuiz.question}
                          </p>

                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {activeQuiz.options.map((option, index) => {
                              const letter = String.fromCharCode(65 + index)
                              const isChosen = quizChoice === letter
                              const isAnswer =
                                letter === activeQuiz.correct_answer
                              const revealed = quizVerdict !== null

                              let tone =
                                'border-white/10 bg-white/5 text-slate-200 hover:border-indigo-400/40 hover:bg-white/10'
                              if (revealed && isAnswer) {
                                tone =
                                  'border-emerald-400/50 bg-emerald-400/15 text-emerald-100'
                              } else if (
                                revealed &&
                                isChosen &&
                                !isAnswer
                              ) {
                                tone =
                                  'border-red-400/50 bg-red-400/15 text-red-100'
                              } else if (isChosen) {
                                tone =
                                  'border-indigo-400/60 bg-indigo-400/15 text-white'
                              }

                              return (
                                <button
                                  key={letter}
                                  type="button"
                                  onClick={() => handleQuizSelect(letter)}
                                  disabled={quizChoice !== null}
                                  className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm leading-6 transition disabled:cursor-not-allowed ${tone}`}
                                >
                                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current/30 text-[11px] font-semibold">
                                    {letter}
                                  </span>
                                  <span>{option}</span>
                                </button>
                              )
                            })}
                          </div>

                          {quizVerdict === 'correct' && liveState === 'quiz' && (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  void playQuizFeedback(
                                    'correct',
                                    quizChoice ?? activeQuiz.correct_answer,
                                  )
                                }
                                className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
                              >
                                我真懂了
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  void playQuizFeedback(
                                    'guess',
                                    quizChoice ?? activeQuiz.correct_answer,
                                  )
                                }
                                className="rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20"
                              >
                                我是蒙的
                              </button>
                              <span className="text-[11px] text-slate-500">
                                答对也要听李老师讲清原理
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                    {/* 互动控制面板：懂 / 不懂 / 讲慢点 */}
                    <div className="relative mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
                          互动控制
                        </div>
                        <span className="text-[11px] text-slate-400">
                          {liveState === 'waiting' ? '听懂了吗？' : ''}
                        </span>
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleUnderstood}
                          disabled={liveState !== 'waiting'}
                          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500 disabled:shadow-none"
                        >
                          听懂了，下一步
                          <kbd className="rounded border border-emerald-900/20 bg-emerald-900/10 px-1.5 py-0.5 text-[10px] font-normal">
                            Enter
                          </kbd>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleNotUnderstood()}
                          disabled={liveState !== 'waiting'}
                          className="inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-500"
                        >
                          没听懂，再讲讲
                          <kbd className="rounded border border-amber-300/30 bg-amber-300/10 px-1.5 py-0.5 text-[10px] font-normal text-amber-300/80">
                            R
                          </kbd>
                        </button>

                        <button
                          type="button"
                          onClick={() => void toggleSlowMode()}
                          className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition ${
                            isSlowMode
                              ? 'border-sky-400/50 bg-sky-400/15 text-sky-200'
                              : 'border-white/15 bg-white/5 text-slate-300 hover:border-sky-400/40 hover:text-sky-200'
                          }`}
                          title={
                            isSlowMode
                              ? '恢复正常语速 1.0x'
                              : '切换到慢速 0.8x，音质不失真'
                          }
                        >
                          {isSlowMode ? '讲快点吧老师' : '老师讲慢点'}
                          <span className="text-[10px] text-slate-500">
                            {isSlowMode ? '0.8x' : '1.0x'}
                          </span>
                        </button>
                      </div>
                    </div>

                    {liveError && (
                      <p className="relative mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {liveError}
                      </p>
                    )}

                    {liveStoryboard.length > 0 && (
                      <div className="relative mt-4 flex flex-wrap items-center gap-2">
                        {liveStoryboard.map((segment, index) => (
                          <button
                            key={`live-dot-${segment.segment_id}-${index}`}
                            type="button"
                            onClick={() => goToLiveSegment(index)}
                            disabled={isLiveBusy}
                            aria-label={`切换到第 ${index + 1} 段分镜`}
                            className={`h-2 w-2 rounded-full transition ${
                              index === liveIndex
                                ? 'bg-sky-400 ring-2 ring-sky-400/30'
                                : 'bg-white/20 hover:bg-white/40'
                            } disabled:cursor-not-allowed`}
                          />
                        ))}
                        <span className="ml-auto text-[11px] text-slate-500">
                          点击圆点切换分镜
                        </span>
                      </div>
                    )}

                    <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-slate-300 transition hover:border-sky-400/40 hover:text-sky-200">
                          <input
                            type="file"
                            accept=".mp3,.wav,.m4a,audio/*"
                            className="hidden"
                            onChange={(event) => {
                              setReferenceAudio(
                                event.target.files?.[0] ?? null,
                              )
                              event.target.value = ''
                            }}
                          />
                          <svg
                            className="h-3.5 w-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 0 1 6 0v8.25a3 3 0 0 1-3 3Z"
                            />
                          </svg>
                          {referenceAudio?.name ?? '上传参考音频'}
                        </label>

                        {referenceAudio && (
                          <button
                            type="button"
                            onClick={() => setReferenceAudio(null)}
                            className="text-[11px] text-slate-500 transition hover:text-red-300"
                          >
                            移除
                          </button>
                        )}

                        <span
                          className="text-[11px] text-slate-500"
                          title={
                            ttsInfo?.model && ttsInfo?.voice
                              ? `${ttsInfo.model} / ${ttsInfo.voice}`
                              : undefined
                          }
                        >
                          音色：{ttsInfo?.display_name ?? '龙安欢'}
                          {ttsInfo?.model
                            ? ` · ${ttsInfo.model}`
                            : ' · CosyVoice'}
                          {' · 音色克隆即将开放'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <div
                          className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5"
                          title="语速由后端 CosyVoice 原生合成，从下一句开始生效，音质不失真"
                        >
                          <span className="text-[11px] text-slate-500">语速</span>
                          <select
                            value={ttsSpeed}
                            onChange={(event) =>
                              changeTtsSpeed(Number(event.target.value))
                            }
                            aria-label="语速调节"
                            className="cursor-pointer rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs font-medium text-slate-200 focus:border-sky-400/50 focus:outline-none"
                          >
                            <option value={0.8}>慢速 0.8x</option>
                            <option value={1}>正常 1.0x</option>
                            <option value={1.2}>快速 1.2x</option>
                          </select>
                        </div>

                        {liveState === 'playing' && (
                          <span className="text-[11px] text-slate-500">
                            正在讲解中，可随时举手打断
                          </span>
                        )}

                        {isLiveActive ? (
                          <button
                            type="button"
                            onClick={stopClass}
                            className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-red-400/40 hover:text-red-300"
                          >
                            结束上课
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={startClass}
                            className="rounded-full bg-sky-500 px-5 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-sky-500/30 transition hover:bg-sky-400"
                          >
                            {liveState === 'ended' ? '重新上课' : '开始上课'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-xl font-semibold tracking-tight text-slate-900">
                        复习笔记
                      </h2>
                      <p className="mt-1 text-xs text-slate-400">
                        {subject.trim()
                          ? `${subject.trim()} · 由 AI 自动识别`
                          : '由 AI 自动整理生成'}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void copyResult()}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                          copyState === 'copied'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                            : copyState === 'error'
                              ? 'border-red-200 bg-red-50 text-red-600'
                              : 'border-slate-200 text-slate-500 hover:border-sky-300 hover:text-sky-600'
                        }`}
                      >
                        {copyState === 'copied'
                          ? '已复制'
                          : copyState === 'error'
                            ? '复制失败'
                            : '复制结果'}
                      </button>

                      {/* 预留：后续可接入 Seedance 视频生成接口，
                          因视频生成延迟较高，当前版本暂不启用。 */}
                      <button
                        type="button"
                        disabled
                        title="预留 Seedance 视频生成接口，暂未启用"
                        className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-400"
                      >
                        生成讲解视频
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 space-y-1 rounded-xl bg-slate-50 p-3 lg:p-4">
                    {noteSegments.length > 0 ? (
                      noteSegments.map((segment, index) => (
                        <div
                          key={`segment-${index}`}
                          className="rounded-xl px-3 py-1"
                        >
                          <MarkdownView content={segment} />
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-slate-500">暂无笔记内容</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={resetFlow}
                    className="rounded-full bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700"
                  >
                    处理下一个
                  </button>

                  <p className="text-xs text-slate-400">
                    点击「开始上课」逐段播放，空格键或「举手打断」可随时提问
                  </p>
                </div>
              </div>
            )}

            {phase === 'failed' && (
              <div>
                <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
                  <div className="flex flex-wrap items-center gap-2 text-red-600">
                    <svg
                      className="h-5 w-5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                    <span className="text-sm font-medium">处理失败</span>
                  </div>

                  <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-red-600">
                    {uploadMessage}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={resetFlow}
                  className="mt-4 rounded-full bg-slate-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700"
                >
                  重新上传
                </button>
              </div>
            )}

            <section className="mt-8 pb-4">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    历史记录
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-400">
                    最近 20 条任务，点击可查看历史结果
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => void loadHistory()}
                  disabled={historyLoading}
                  className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 transition hover:border-sky-300 hover:text-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {historyLoading ? '刷新中…' : '刷新'}
                </button>
              </div>

              {historyError && (
                <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                  {historyError}
                </div>
              )}

              {historyLoading && history.length === 0 ? (
                <div className="mt-4 flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-8 text-sm text-slate-400">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
                  正在加载历史记录…
                </div>
              ) : history.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400">
                  暂无历史记录，上传一段录音开始体验吧
                </div>
              ) : (
                <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <ul className="divide-y divide-slate-100">
                    {history.map((item) => {
                      const isActive = item.task_id === taskId

                      return (
                        <li key={item.task_id}>
                          <button
                            type="button"
                            onClick={() => void openHistoryTask(item.task_id)}
                            className={`flex w-full items-center gap-3 px-4 py-3 text-left transition ${
                              isActive
                                ? 'bg-sky-50/80'
                                : 'hover:bg-slate-50'
                            }`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-slate-700">
                                  {item.filename}
                                </span>
                                <StatusBadge status={item.status} />
                              </div>
                              <div className="mt-1 flex items-center gap-3 text-xs text-slate-400">
                                <span>{formatDateTime(item.created_at)}</span>
                                <span>#{item.task_id}</span>
                              </div>
                            </div>

                            <svg
                              className="h-4 w-4 shrink-0 text-slate-300"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              aria-hidden="true"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="m8.25 4.5 7.5 7.5-7.5 7.5"
                              />
                            </svg>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </section>
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
