import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
} from 'react'
import LectureBoard from './components/LectureBoard'
import DynamicBoard from './components/DynamicBoard'
import MarkdownView from './components/MarkdownView'
import { audioBus } from './lib/audioBus'
import {
  initialLiveState,
  isLiveActiveState,
  isLiveBusyState,
  liveReducer,
  type AgentCommand,
  type LiveState,
  type RemedialMode,
  type RemedialSegment,
} from './lib/liveReducer'
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
import { prefetchTts, setTtsSpeed } from './lib/tts'
import { uploadApiJson, uploadFilesInChunks } from './lib/upload'
import type { UploadProgress } from './lib/upload'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8080'
const MAX_UPLOAD_SIZE = 1536 * 1024 * 1024
const MAX_UPLOAD_SIZE_LABEL = '1.5GB'
const LARGE_FILE_WARNING_SIZE = 500 * 1024 * 1024
const LARGE_FILE_WARNING =
  '文件过大处理缓慢，建议先转为 MP3 格式以提升速度。'
const ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a']
const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']
const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const MAX_IMAGE_COUNT = 12
const POLL_INTERVAL = 2000
const RECOGNITION_TIMEOUT = 18000

type ConnectionStatus = 'loading' | 'connected' | 'error'
type Phase = 'idle' | 'uploading' | 'processing' | 'completed' | 'failed' | 'error'
type CopyState = 'idle' | 'copied' | 'error'
type ChatRole = 'user' | 'assistant'
type ChatAgent = 'companion' | 'teacher' | 'system'

interface ChatMessage {
  id: string
  role: ChatRole
  agent: ChatAgent
  content: string
}

interface SelectedImage {
  key: string
  file: File
  url: string
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

interface StoryboardAction {
  type: 'speak' | 'animate'
  text?: string
  trigger?: string
  highlight_lines?: number[]
  ppt_page?: number | null
}

interface StoryboardSegment {
  segment_id: number
  speech_intro: string
  html_code: string
  animation_trigger: string
  ppt_page?: number | null
  actions?: StoryboardAction[]
  // 旧分镜兼容字段
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

interface CompanionChatResponse {
  agent?: string
  action?: 'answer' | 'escalate'
  reply?: string
  focus?: string
  reason?: string
  detail?: string
}

interface RemedialResponse {
  agent?: string
  speech_intro?: string
  html_code?: string
  animation_trigger?: string
  detail?: string
}

interface FavoriteItem {
  favorite_id: string
  task_id: number
  filename?: string
  segment_id: number
  title: string
  subject: string
  speech_intro: string
  html_code: string
  animation_trigger: string
  board_content: string
  source: string
  saved_at: string
}

interface FavoriteCreateResponse {
  favorite?: FavoriteItem
  count?: number
  task_id?: number
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

function formatSpeed(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return '计算中'
  }
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
  }
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
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

/** 从动态板书 HTML 中抽取纯文本，供「没听懂」重新讲解使用。 */
function htmlToPlainText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500)
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

function normalizePptPage(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 500) {
    return Math.floor(value)
  }
  if (typeof value === 'string') {
    const match = value.match(/\d+/)
    if (match) {
      const parsed = Number.parseInt(match[0], 10)
      if (parsed > 0 && parsed <= 500) return parsed
    }
  }
  return null
}

function normalizeTrigger(value: unknown) {
  if (typeof value !== 'string') return 'reveal-1'
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)
  return cleaned || 'reveal-1'
}

function normalizeStoryboard(value: unknown): StoryboardSegment[] {
  if (!Array.isArray(value)) return []

  const segments: StoryboardSegment[] = []

  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue

    const record = item as Record<string, unknown>
    const speechIntro =
      typeof record.speech_intro === 'string'
        ? record.speech_intro.trim()
        : ''
    const htmlCode =
      typeof record.html_code === 'string' ? record.html_code.trim() : ''
    const pptPage = normalizePptPage(record.ppt_page)

    if (speechIntro && htmlCode) {
      const trigger = normalizeTrigger(record.animation_trigger)
      const highlightLines = normalizeHighlightLines(record.highlight_lines)
      segments.push({
        segment_id: segments.length + 1,
        speech_intro: speechIntro,
        html_code: htmlCode,
        animation_trigger: trigger,
        ppt_page: pptPage,
        actions: [
          { type: 'speak', text: speechIntro, ppt_page: pptPage },
          {
            type: 'animate',
            trigger,
            highlight_lines: highlightLines,
            ppt_page: pptPage,
          },
        ],
        speech_text: '',
        board_content: '',
        highlight_lines: highlightLines,
        step_by_step: [],
        quiz: normalizeQuiz(record.quiz),
      })
      if (segments.length >= 30) break
      continue
    }

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
        speech_intro: '',
        html_code: '',
        animation_trigger: '',
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
        speech_intro: '',
        html_code: '',
        animation_trigger: '',
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
        speech_intro: '',
        html_code: '',
        animation_trigger: '',
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
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([])
  const [pptTaskId, setPptTaskId] = useState<number | null>(null)
  const [batchCount, setBatchCount] = useState(0)
  const [taskId, setTaskId] = useState<number | null>(null)
  const [result, setResult] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const [uploadStage, setUploadStage] = useState<
    'ppt' | 'image' | 'audio' | null
  >(null)
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
  const [mockLoading, setMockLoading] = useState(false)

  const [history, setHistory] = useState<TaskSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      agent: 'companion',
      content:
        '你好，我是伴读小助手。基础概念、刚才没听清的句子都可以先问我；遇到绕不过去的难点，我会替你把问题举手递给李老师。',
    },
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  // 课堂有限状态机（useReducer 统一管理授课/打断/补救/测验/字幕，消除分散状态竞争）
  const [live, dispatchLive] = useReducer(liveReducer, initialLiveState)
  const liveRef = useRef(live)
  liveRef.current = live

  const {
    liveState,
    liveIndex,
    liveStepIndex,
    liveCaption,
    liveError,
    liveFocus,
    liveHighlightLines,
    boardTrigger,
    isPreparing,
    prepareLine,
    showInterruptInput,
    quizChoice,
    quizVerdict,
    isEscalating,
    companionRaised,
    companionFocus,
    remedialBoard,
    remedialActive,
    remedialKey,
    remedialMode,
  } = live

  const setLiveState = (next: LiveState) =>
    dispatchLive({ type: 'SET_STATE', liveState: next })
  const setLiveCaption = (caption: string) =>
    dispatchLive({ type: 'SET_CAPTION', caption })
  const setLiveError = (error: string) =>
    dispatchLive({ type: 'SET_ERROR', error })
  const setLiveFocus = (focus: string) =>
    dispatchLive({ type: 'SET_FOCUS', focus })
  const setLiveHighlightLines = (lines: number[]) =>
    dispatchLive({ type: 'SET_HIGHLIGHT_LINES', lines })
  const setBoardTrigger = (
    trigger: { key: number; trigger: string; highlightLines?: number[] } | null,
  ) => dispatchLive({ type: 'SET_BOARD_TRIGGER', trigger })
  const setIsPreparing = (value: boolean) =>
    dispatchLive({ type: 'SET_PREPARING', isPreparing: value })
  const setQuizChoice = (choice: string | null) =>
    dispatchLive({
      type: 'SET_QUIZ_STATE',
      choice,
      verdict: liveRef.current.quizVerdict,
    })
  const setQuizVerdict = (verdict: 'correct' | 'wrong' | null) =>
    dispatchLive({
      type: 'SET_QUIZ_STATE',
      choice: liveRef.current.quizChoice,
      verdict,
    })
  const setShowInterruptInput = (show: boolean) =>
    dispatchLive({ type: 'SET_SHOW_INTERRUPT_INPUT', show })

  useEffect(() => {
    return audioBus.subscribe((snapshot) => {
      setSpeakingMessageId(snapshot.speakingMessageId)
    })
  }, [])

  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [favoritesOpen, setFavoritesOpen] = useState(false)
  const [favoritesLoading, setFavoritesLoading] = useState(false)
  const [favoritesError, setFavoritesError] = useState('')
  const [favoriteSaving, setFavoriteSaving] = useState(false)
  const [favoriteSaved, setFavoriteSaved] = useState(false)
  const [replayFavorite, setReplayFavorite] =
    useState<FavoriteItem | null>(null)
  const [replayRun, setReplayRun] = useState(0)
  const [replayTrigger, setReplayTrigger] = useState<{
    key: number
    trigger: string
  } | null>(null)

  const [storyboard, setStoryboard] = useState<StoryboardSegment[]>([])
  const [referenceAudio, setReferenceAudio] = useState<File | null>(null)
  const [largeFileHint, setLargeFileHint] = useState('')
  const [dragTarget, setDragTarget] = useState<
    'ppt' | 'image' | 'audio' | null
  >(null)

  const chatScrollRef = useRef<HTMLDivElement>(null)
  const imageUrlsRef = useRef<string[]>([])

  useEffect(() => {
    return () => {
      imageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      imageUrlsRef.current = []
    }
  }, [])
  const liveSessionRef = useRef(0)
  const liveIndexRef = useRef(0)
  const liveStepRef = useRef(-1)
  const prepareStartedAtRef = useRef(0)
  const ttsSpeedRef = useRef(1)
  const resumePointRef = useRef<{
    index: number
    step: number
    remedial?: boolean
  } | null>(null)
  const remedialRef = useRef<RemedialSegment | null>(null)
  const remedialResumeRef = useRef<{
    index: number
    step: number
  } | null>(null)
  const remedialModeRef = useRef<RemedialMode>('companion')
  const quizNextIndexRef = useRef<number | null>(null)
  const interruptContextRef = useRef('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const boardAnimWaiterRef = useRef<{
    key: number
    resolve: () => void
    timer: number
  } | null>(null)

  function clearBoardAnimWaiter() {
    const waiter = boardAnimWaiterRef.current
    if (!waiter) return
    window.clearTimeout(waiter.timer)
    boardAnimWaiterRef.current = null
    waiter.resolve()
  }

  function handleBoardAnimationComplete(triggerKey: number) {
    const waiter = boardAnimWaiterRef.current
    if (waiter && waiter.key === triggerKey) {
      clearBoardAnimWaiter()
    }
  }

  function triggerBoardAnimationAndWait(
    trigger: string,
    session: number,
    highlightLines?: number[],
    fallbackMs = 2600,
  ): Promise<void> {
    clearBoardAnimWaiter()
    return new Promise((resolve) => {
      if (liveSessionRef.current !== session) {
        resolve()
        return
      }
      const key = Date.now() + Math.floor(Math.random() * 1000)
      const timer = window.setTimeout(() => {
        if (boardAnimWaiterRef.current?.key === key) {
          boardAnimWaiterRef.current = null
        }
        resolve()
      }, fallbackMs)

      boardAnimWaiterRef.current = { key, resolve, timer }
      setBoardTrigger({
        key,
        trigger: trigger || 'reveal-1',
        highlightLines,
      })
    })
  }

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
  const totalSteps =
    remedialActive
      ? 1
      : activeLiveSegment?.html_code
        ? 1
        : (activeLiveSegment?.step_by_step.length ?? 0)
  const activeQuiz = remedialActive
    ? null
    : (activeLiveSegment?.quiz ?? null)
  const canFavorite = Boolean(
    remedialActive
      ? remedialBoard?.html_code
      : activeLiveSegment?.html_code,
  )
  const isLiveBusy = isLiveBusyState(liveState)
  const isLiveActive = isLiveActiveState(liveState)

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

  function appendMessage(
    role: ChatRole,
    content: string,
    agent: ChatAgent = 'companion',
  ) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setMessages((previous) => [
      ...previous,
      { id, role, agent, content },
    ])
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

  /** 左侧聊天回答自动语音播报；经由 AudioBus 单一总线独占通道，直播播放时先原子暂停。 */
  async function speakChatReply(text: string, messageId: string) {
    if (!text.trim()) return

    const currentState = liveRef.current.liveState
    const shouldPauseLive =
      audioBus.isChannelPlaying('teacher') ||
      currentState === 'playing' ||
      currentState === 'explaining' ||
      currentState === 'resuming'

    if (shouldPauseLive) {
      resumePointRef.current = {
        index: liveIndexRef.current,
        step: liveStepRef.current,
        remedial: liveRef.current.remedialActive,
      }
      liveSessionRef.current += 1
      clearBoardAnimWaiter()
      audioBus.stopAll()
      setLiveState('paused')
    }

    try {
      await audioBus.play(truncateForTts(text), {
        channel: 'companion',
        speed: ttsSpeedRef.current,
        messageId,
      })
    } catch {
      // 语音失败不影响文字回答
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
      clearBoardAnimWaiter()
      audioBus.stopAll()
      recognitionRef.current?.abort()
    }
  }, [])

  const keyHandlerRef = useRef({
    interruptClass: () => {},
    handleUnderstood: () => {},
    handleNotUnderstood: () => {},
  })
  keyHandlerRef.current = {
    interruptClass: () => {
      void interruptClass()
    },
    handleUnderstood: () => {
      handleUnderstood()
    },
    handleNotUnderstood: () => {
      void handleNotUnderstood()
    },
  }

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

      const currentState = liveRef.current.liveState

      // 空格：举手打断
      if (event.code === 'Space') {
        if (currentState !== 'playing' && currentState !== 'waiting') return
        event.preventDefault()
        keyHandlerRef.current.interruptClass()
        return
      }

      if (currentState !== 'waiting') return

      // 回车 / 右方向键：听懂了，下一步
      if (event.code === 'Enter' || event.code === 'ArrowRight') {
        event.preventDefault()
        keyHandlerRef.current.handleUnderstood()
        return
      }

      // R 键：没听懂，再讲讲
      if (event.code === 'KeyR') {
        event.preventDefault()
        keyHandlerRef.current.handleNotUnderstood()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
          setPhase('completed')
          resetLiveSession(0)
          appendMessage('assistant', pickLine(READY_LINES), 'system')
          void loadHistory()
        } else if (data.status === 'failed') {
          clearInterval(timer)
          setUploadMessage(data.result ?? '音频处理失败，请重新上传')
          setPhase('failed')
          resetLiveSession(0)
          appendMessage('assistant', pickLine(FAILED_LINES), 'system')
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
    dispatchLive({ type: 'SET_POSITION', index, step })
  }

  function resetLiveSession(nextIndex = 0) {
    liveSessionRef.current += 1
    clearBoardAnimWaiter()
    audioBus.stopAll()
    recognitionRef.current?.abort()
    recognitionRef.current = null
    remedialRef.current = null
    remedialResumeRef.current = null
    remedialModeRef.current = 'companion'
    quizNextIndexRef.current = null
    liveIndexRef.current = nextIndex
    liveStepRef.current = -1
    dispatchLive({ type: 'RESET_SESSION', nextIndex })
  }

  function stopClass() {
    liveSessionRef.current += 1
    clearBoardAnimWaiter()
    audioBus.stopAll()
    recognitionRef.current?.abort()
    recognitionRef.current = null
    remedialRef.current = null
    remedialResumeRef.current = null
    remedialModeRef.current = 'companion'
    quizNextIndexRef.current = null
    dispatchLive({ type: 'STOP_CLASS' })
  }

  async function speakWithTts(
    text: string,
    session: number,
    messageId?: string | null,
  ) {
    if (liveSessionRef.current !== session) return

    setLiveCaption(text)
    await audioBus.play(text, {
      channel: 'teacher',
      speed: ttsSpeedRef.current,
      messageId: messageId ?? null,
      onStarted: () => {
        const elapsed = Date.now() - prepareStartedAtRef.current
        const delay = Math.max(0, 500 - elapsed)
        window.setTimeout(() => {
          if (liveSessionRef.current === session) {
            setIsPreparing(false)
          }
        }, delay)
      },
    })
  }

  async function playDynamicSegment(
    segmentIndex: number,
    session: number,
  ) {
    if (liveSessionRef.current !== session) return

    const segment = liveStoryboard[segmentIndex]
    if (!segment) {
      setLiveState('ended')
      return
    }

    setLivePosition(segmentIndex, 0)
    setLiveFocus('')
    setLiveHighlightLines([])
    setLiveError('')
    setBoardTrigger(null)

    try {
      await speakWithTts(segment.speech_intro, session)
    } catch (error) {
      if (liveSessionRef.current !== session) return
      setLiveError(
        error instanceof Error ? error.message : '语音播放失败',
      )
      setLiveState('idle')
      appendMessage('assistant', pickLine(TTS_ERROR_LINES), 'system')
      return
    }

    if (liveSessionRef.current !== session) return

    // 严格同步：语音播完后再下发板书动画与高亮行指令，等待 iframe 动画完成握手后再切换状态
    await triggerBoardAnimationAndWait(
      segment.animation_trigger || 'reveal-1',
      session,
      segment.highlight_lines,
      2600,
    )
    if (liveSessionRef.current !== session) return
    if (liveIndexRef.current !== segmentIndex) return

    if (segment.quiz) {
      prefetchTts(segment.quiz.explanation_correct)
      prefetchTts(segment.quiz.explanation_wrong)
      prefetchTts(segment.quiz.explanation_guess)
      setQuizChoice(null)
      setQuizVerdict(null)
      setLiveState('quiz')
      return
    }

    setLiveState('waiting')
  }

  function buildLectureContext() {
    if (remedialActive && remedialRef.current) {
      return (
        `${remedialRef.current.speech_intro}\n` +
        `补充板书要点：${htmlToPlainText(
          remedialRef.current.html_code,
        ).slice(0, 1000)}`
      )
    }

    const segment = liveStoryboard[liveIndexRef.current]
    if (!segment) return ''

    if (segment.html_code) {
      return (
        `${segment.speech_intro}\n` +
        `板书要点：${htmlToPlainText(segment.html_code).slice(0, 1000)}`
      )
    }

    const step = segment.step_by_step[liveStepRef.current]
    const speech = step?.speech_text || segment.speech_text
    return `${speech}\n板书要点：${segment.board_content.slice(0, 1000)}`
  }

  function currentBoardSnapshot() {
    if (remedialActive && remedialBoard) {
      return {
        segment_id: liveIndexRef.current + 1,
        title: `补救：${companionFocus || '薄弱点'}`,
        speech_intro: remedialBoard.speech_intro,
        html_code: remedialBoard.html_code,
        animation_trigger: remedialBoard.animation_trigger,
        board_content: '',
        source: remedialMode === 'quiz' ? 'quiz' : 'remedial',
      }
    }

    const segment = liveStoryboard[liveIndexRef.current]
    if (!segment?.html_code) return null

    const title =
      liveFocus ||
      htmlToPlainText(segment.html_code).slice(0, 24) ||
      `第 ${liveIndexRef.current + 1} 段板书`

    return {
      segment_id: liveIndexRef.current + 1,
      title,
      speech_intro: segment.speech_intro,
      html_code: segment.html_code,
      animation_trigger: segment.animation_trigger,
      board_content: '',
      source: 'segment',
    }
  }

  async function saveCurrentBoard() {
    const snapshot = currentBoardSnapshot()
    if (!snapshot || favoriteSaving) return

    setFavoriteSaving(true)
    setLiveError('')
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/tasks/${taskId ?? 0}/favorites`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...snapshot,
            subject: subject.trim() || '通用课程',
          }),
        },
      )
      const data = (await response.json()) as FavoriteCreateResponse
      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }
      setFavoriteSaved(true)
      window.setTimeout(() => setFavoriteSaved(false), 2000)
    } catch (error) {
      setLiveError(
        `收藏失败：${
          error instanceof Error ? error.message : '未知错误'
        }`,
      )
    } finally {
      setFavoriteSaving(false)
    }
  }

  function chooseFavorite(item: FavoriteItem) {
    setReplayFavorite(item)
    setReplayRun((previous) => previous + 1)
    setReplayTrigger({
      key: Date.now(),
      trigger: item.animation_trigger || 'reveal-1',
    })
  }

  async function openFavorites() {
    setFavoritesOpen(true)
    setFavoritesLoading(true)
    setFavoritesError('')

    try {
      const response = await fetch(`${API_BASE_URL}/api/favorites`)
      const data = (await response.json()) as
        | FavoriteItem[]
        | { detail?: string }
      if (!response.ok) {
        throw new Error(
          'detail' in data
            ? (data.detail ?? `HTTP ${response.status}`)
            : `HTTP ${response.status}`,
        )
      }
      if (!Array.isArray(data)) {
        throw new Error('收藏接口返回格式不正确')
      }
      setFavorites(data)
      if (data.length > 0) {
        chooseFavorite(data[0])
      } else {
        setReplayFavorite(null)
        setReplayTrigger(null)
      }
    } catch (error) {
      setFavoritesError(
        error instanceof Error ? error.message : '收藏加载失败',
      )
    } finally {
      setFavoritesLoading(false)
    }
  }

  async function removeFavorite(favoriteId: string) {
    try {
      const response = await fetch(
        `${API_BASE_URL}/api/favorites/${favoriteId}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        const data = (await response.json()) as { detail?: string }
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }

      const remaining = favorites.filter(
        (item) => item.favorite_id !== favoriteId,
      )
      setFavorites(remaining)

      if (replayFavorite?.favorite_id === favoriteId) {
        if (remaining.length > 0) {
          chooseFavorite(remaining[0])
        } else {
          setReplayFavorite(null)
          setReplayTrigger(null)
        }
      }
    } catch (error) {
      setFavoritesError(
        error instanceof Error ? error.message : '删除收藏失败',
      )
    }
  }

  function replayFavoriteAgain() {
    if (!replayFavorite) return
    setReplayRun((previous) => previous + 1)
    setReplayTrigger({
      key: Date.now(),
      trigger: replayFavorite.animation_trigger || 'reveal-1',
    })
  }

  async function playRemedialSegment(
    segment: RemedialSegment,
    session: number,
    messageId?: string | null,
  ) {
    if (liveSessionRef.current !== session) return

    setLivePosition(liveIndexRef.current, 0)
    setLiveFocus('')
    setLiveHighlightLines([])
    setLiveError('')
    setBoardTrigger(null)
    setLiveState('playing')

    try {
      await speakWithTts(segment.speech_intro, session, messageId)
    } catch (error) {
      if (liveSessionRef.current !== session) return
      setLiveError(
        error instanceof Error ? error.message : '语音播放失败',
      )
    }

    if (liveSessionRef.current !== session) return

    await triggerBoardAnimationAndWait(
      segment.animation_trigger || 'reveal-1',
      session,
      undefined,
      2400,
    )
    if (liveSessionRef.current !== session) return
    setLiveState('waiting')
  }

  /** 伴读举手：向主讲发送结构化系统指令，暂停原课堂并生成补救板书。 */
  async function startRemedial(
    question: string,
    focus: string,
    command?: AgentCommand,
  ) {
    if (!liveStoryboard.length) {
      appendMessage(
        'assistant',
        '我先把这个问题记下来。等课程开始后，我再替你把问题举手递给李老师。',
        'companion',
      )
      return
    }

    const currentLive = liveRef.current
    const classWasActive = isLiveActiveState(currentLive.liveState)
    remedialModeRef.current = 'companion'
    quizNextIndexRef.current = null
    if (!currentLive.remedialActive && classWasActive) {
      remedialResumeRef.current = {
        index: liveIndexRef.current,
        step: liveStepRef.current,
      }
    }

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    clearBoardAnimWaiter()
    audioBus.stopAll()
    recognitionRef.current?.abort()
    recognitionRef.current = null

    prepareStartedAtRef.current = Date.now()
    dispatchLive({
      type: 'START_ESCALATION',
      mode: 'companion',
      focus,
      prepareLine: '李老师收到了伴读的系统指令，正在针对你的薄弱点重新备课…',
      command,
    })

    try {
      const response = await fetch(`${API_BASE_URL}/api/teacher_remedial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          focus,
          subject: subject.trim() || '通用课程',
          lecture_context: buildLectureContext(),
          note_context: result || null,
        }),
      })

      const data = (await response.json()) as RemedialResponse
      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }
      if (
        typeof data.speech_intro !== 'string' ||
        !data.speech_intro.trim() ||
        typeof data.html_code !== 'string' ||
        !data.html_code.trim()
      ) {
        throw new Error('主讲老师返回的补救板书为空')
      }

      if (liveSessionRef.current !== session) return

      const segment: RemedialSegment = {
        speech_intro: data.speech_intro.trim(),
        html_code: data.html_code,
        animation_trigger:
          typeof data.animation_trigger === 'string' &&
          data.animation_trigger.trim()
            ? data.animation_trigger.trim()
            : 'reveal-1',
      }

      remedialRef.current = segment
      dispatchLive({ type: 'ENTER_REMEDIAL', segment })
      const teacherMessageId = appendMessage(
        'assistant',
        segment.speech_intro,
        'teacher',
      )

      await playRemedialSegment(segment, session, teacherMessageId)
    } catch (error) {
      if (liveSessionRef.current !== session) return

      const message =
        error instanceof Error ? error.message : '补救讲解生成失败'
      appendMessage(
        'assistant',
        `李老师这边暂时没能生成补救板书：${message}`,
        'system',
      )

      const point = remedialResumeRef.current
      if (point) {
        resumePointRef.current = { ...point }
        dispatchLive({
          type: 'FAIL_ESCALATION',
          error: message,
          nextLiveState: 'paused',
        })
      } else {
        dispatchLive({
          type: 'FAIL_ESCALATION',
          error: message,
          nextLiveState: 'idle',
        })
      }
    } finally {
      dispatchLive({ type: 'END_ESCALATION_LOADING' })
    }
  }

  /** 答错后：请主讲老师用更耐心、更拆解的方式重讲这道题。 */
  async function startQuizRemedial(
    segmentIndex: number,
    quiz: StoryboardQuiz,
    chosen: string,
    session: number,
  ) {
    if (liveSessionRef.current !== session) return

    quizNextIndexRef.current =
      segmentIndex + 1 < liveStoryboard.length
        ? segmentIndex + 1
        : null
    remedialModeRef.current = 'quiz'
    prepareStartedAtRef.current = Date.now()
    dispatchLive({
      type: 'START_ESCALATION',
      mode: 'quiz',
      focus: `错题：${quiz.question.slice(0, 36)}`,
      prepareLine: '这道题错了没关系，李老师正在把它拆成更小的步骤…',
      command: {
        id: `cmd-${Date.now()}`,
        type: 'QUIZ_REMEDIAL',
        source: 'quiz',
        target: 'teacher',
        focus: quiz.question.slice(0, 60),
        issuedAt: Date.now(),
      },
    })

    try {
      const response = await fetch(`${API_BASE_URL}/api/quiz_remedial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: quiz.question,
          options: quiz.options,
          correct_answer: quiz.correct_answer,
          chosen_answer: chosen,
          subject: subject.trim() || '通用课程',
          lecture_context: buildLectureContext(),
          note_context: result || null,
        }),
      })

      const data = (await response.json()) as RemedialResponse
      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }
      if (
        typeof data.speech_intro !== 'string' ||
        !data.speech_intro.trim() ||
        typeof data.html_code !== 'string' ||
        !data.html_code.trim()
      ) {
        throw new Error('错题讲解板书为空')
      }

      if (liveSessionRef.current !== session) return

      const remedial: RemedialSegment = {
        speech_intro: data.speech_intro.trim(),
        html_code: data.html_code,
        animation_trigger:
          typeof data.animation_trigger === 'string' &&
          data.animation_trigger.trim()
            ? data.animation_trigger.trim()
            : 'reveal-1',
      }

      remedialRef.current = remedial
      dispatchLive({ type: 'ENTER_REMEDIAL', segment: remedial })
      const teacherMessageId = appendMessage(
        'assistant',
        remedial.speech_intro,
        'teacher',
      )

      await playRemedialSegment(remedial, session, teacherMessageId)
    } catch (error) {
      if (liveSessionRef.current !== session) return

      const message =
        error instanceof Error ? error.message : '错题讲解生成失败'
      appendMessage(
        'assistant',
        `李老师这边暂时没能拆解这道错题：${message}`,
        'system',
      )
      remedialModeRef.current = 'companion'
      quizNextIndexRef.current = null
      dispatchLive({
        type: 'FAIL_ESCALATION',
        error: message,
        nextLiveState: 'playing',
        resetMode: true,
      })
      advanceAfterQuiz(segmentIndex, session)
    } finally {
      dispatchLive({ type: 'END_ESCALATION_LOADING' })
    }
  }

  /** 补救讲解结束：错题模式继续下一段，伴读模式回到原课堂位置。 */
  function finishRemedial() {
    const point = remedialResumeRef.current
    const mode = remedialModeRef.current
    const quizNext = quizNextIndexRef.current
    remedialResumeRef.current = null
    remedialRef.current = null
    remedialModeRef.current = 'companion'
    quizNextIndexRef.current = null
    const resumeCmd: AgentCommand = {
      id: `cmd-${Date.now()}`,
      type: 'RESUME_FROM_REMEDIAL',
      source: 'teacher',
      target: 'companion',
      focus: liveRef.current.companionFocus,
      issuedAt: Date.now(),
    }

    if (mode === 'quiz') {
      if (
        quizNext !== null &&
        quizNext >= 0 &&
        quizNext < liveStoryboard.length
      ) {
        const session = liveSessionRef.current + 1
        liveSessionRef.current = session
        appendMessage(
          'assistant',
          '这道错题讲完了，我们继续下一段。',
          'system',
        )
        dispatchLive({
          type: 'EXIT_REMEDIAL',
          nextLiveState: 'playing',
          command: resumeCmd,
        })
        void playSegmentIntro(quizNext, session)
      } else {
        dispatchLive({
          type: 'EXIT_REMEDIAL',
          nextLiveState: 'ended',
          command: resumeCmd,
        })
        appendMessage('assistant', pickLine(FINISHED_LINES), 'system')
      }
      return
    }

    if (!point) {
      dispatchLive({
        type: 'EXIT_REMEDIAL',
        nextLiveState: 'idle',
        command: resumeCmd,
      })
      appendMessage(
        'assistant',
        '这页补充讲解就先到这儿，需要的话可以继续问我。',
        'system',
      )
      return
    }

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    appendMessage(
      'assistant',
      '补充讲解结束，李老师回到刚才的课堂进度。',
      'system',
    )
    dispatchLive({
      type: 'EXIT_REMEDIAL',
      nextLiveState: 'playing',
      command: resumeCmd,
    })
    if (point.step >= 0) {
      void playStep(point.index, point.step, session)
    } else {
      void playSegmentIntro(point.index, session)
    }
  }

  async function playStep(
    segmentIndex: number,
    stepIndex: number,
    session: number,
  ) {
    if (liveSessionRef.current !== session) return

    const segment = liveStoryboard[segmentIndex]
    if (!segment) {
      setLiveState('ended')
      return
    }

    // 新结构：一段一屏 HTML 板书，口播结束后触发动画
    if (segment.html_code && segment.speech_intro) {
      await playDynamicSegment(segmentIndex, session)
      return
    }

    const step = segment.step_by_step[stepIndex]
    if (!step) {
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
      appendMessage('assistant', pickLine(TTS_ERROR_LINES), 'system')
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
        appendMessage('assistant', pickLine(TTS_ERROR_LINES), 'system')
        return
      }
      if (liveSessionRef.current !== session) return
    }

    void playStep(segmentIndex, 0, session)
  }

  function startClass() {
    if (isLiveActiveState(liveRef.current.liveState)) return
    if (!liveStoryboard.length) {
      setLiveError('当前笔记没有可讲解的分镜')
      return
    }

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    const startIndex =
      liveRef.current.liveState === 'ended' ? 0 : liveIndexRef.current

    // 开始上课前经由 AudioBus 清场，杜绝伴读与主讲叠音
    clearBoardAnimWaiter()
    audioBus.stopAll()

    prepareStartedAtRef.current = Date.now()
    dispatchLive({ type: 'START_CLASS', prepareLine: pickLine(PREPARE_LINES) })
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
    appendMessage('assistant', pickLine(FINISHED_LINES), 'system')
  }

  async function recordWrongQuestion(
    segmentIndex: number,
    quiz: StoryboardQuiz,
    chosen: string,
  ) {
    try {
      await fetch(
        `${API_BASE_URL}/api/tasks/${taskId ?? 0}/wrong_questions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            segment_id: segmentIndex + 1,
            question: quiz.question,
            options: quiz.options,
            correct_answer: quiz.correct_answer,
            chosen_answer: chosen,
            topic: quiz.question.slice(0, 60),
            subject: subject.trim() || '通用课程',
          }),
        },
      )
    } catch {
      // 错题记录失败不影响课堂继续
    }
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
    void recordWrongQuestion(liveIndexRef.current, quiz, letter)
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
    clearBoardAnimWaiter()
    audioBus.stopAll()
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

    if (kind === 'wrong') {
      await startQuizRemedial(
        segmentIndex,
        quiz,
        chosen || '未作答',
        session,
      )
      return
    }

    advanceAfterQuiz(segmentIndex, session)
  }

  function handleUnderstood() {
    if (liveState !== 'waiting') return

    if (remedialActive) {
      finishRemedial()
      return
    }

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
    appendMessage('assistant', pickLine(FINISHED_LINES), 'system')
  }

  async function handleNotUnderstood() {
    if (liveState !== 'waiting') return

    const segmentIndex = liveIndexRef.current
    const stepIndex = liveStepRef.current
    const segment = liveStoryboard[segmentIndex]
    const remedial = remedialActive ? remedialRef.current : null
    const isDynamic = Boolean(remedial || segment?.html_code)
    const step = segment?.step_by_step[stepIndex]
    if (!remedial && (!segment || (!isDynamic && !step))) return

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
          board_content: remedial
            ? htmlToPlainText(remedial.html_code)
            : isDynamic
              ? htmlToPlainText(segment?.html_code ?? '')
              : segment?.board_content ?? '',
          step_speech: remedial
            ? remedial.speech_intro
            : isDynamic
              ? segment?.speech_intro ?? ''
              : step?.speech_text ?? '',
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
      appendMessage('assistant', pickLine(EXPLAIN_ERROR_LINES), 'teacher')
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

      appendMessage('assistant', result.answer, 'teacher')
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
      appendMessage('assistant', pickLine(QA_ERROR_LINES), 'system')
      setLiveState('paused')
    }
  }

  async function interruptClass() {
    const currentLive = liveRef.current
    if (!isLiveActiveState(currentLive.liveState)) return

    const wasEscalating = currentLive.isEscalating
    if (wasEscalating) {
      remedialModeRef.current = 'companion'
      quizNextIndexRef.current = null
    }

    const session = liveSessionRef.current + 1
    liveSessionRef.current = session
    const interruptedIndex = liveIndexRef.current
    const interruptedStep = liveStepRef.current
    const interruptedSegment = liveStoryboard[interruptedIndex]
    const contextText =
      currentLive.remedialActive && remedialRef.current
        ? remedialRef.current.speech_intro
        : interruptedSegment?.html_code
          ? interruptedSegment.speech_intro
          : interruptedStep >= 0
            ? interruptedSegment?.step_by_step[interruptedStep]?.speech_text ?? ''
            : interruptedSegment?.speech_text ?? ''

    resumePointRef.current = {
      index: interruptedIndex,
      step: interruptedStep,
      remedial: currentLive.remedialActive,
    }
    interruptContextRef.current = contextText

    // 经由 AudioBus 立刻停止所有正在播放的语音与板书动画等待器
    clearBoardAnimWaiter()
    audioBus.stopAll()
    recognitionRef.current?.abort()
    recognitionRef.current = null

    setInterruptInput('')
    dispatchLive({ type: 'BEGIN_INTERRUPT', cancelEscalating: wasEscalating })

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
        dispatchLive({
          type: 'INTERRUPT_FALLBACK_INPUT',
          caption: pickLine(NO_SPEECH_LINES),
        })
        return
      }

      await handleInterruptQuestion(question)
    } catch (error) {
      if (liveSessionRef.current !== session) return

      const message = error instanceof Error ? error.message : '打断流程失败'
      dispatchLive({
        type: 'INTERRUPT_FALLBACK_INPUT',
        caption: pickLine(MIC_ERROR_LINES),
        error: message,
      })
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
    if (point.remedial && remedialRef.current) {
      void playRemedialSegment(remedialRef.current, session)
      return
    }
    if (point.step >= 0) {
      void playStep(point.index, point.step, session)
    } else {
      void playSegmentIntro(point.index, session)
    }
  }

  function goToLiveSegment(index: number) {
    if (isLiveBusyState(liveRef.current.liveState)) return
    if (index < 0 || index >= liveStoryboard.length) return

    liveSessionRef.current += 1
    clearBoardAnimWaiter()
    audioBus.stopAll()
    recognitionRef.current?.abort()
    recognitionRef.current = null

    remedialRef.current = null
    remedialResumeRef.current = null
    remedialModeRef.current = 'companion'
    quizNextIndexRef.current = null
    liveIndexRef.current = index
    liveStepRef.current = -1
    dispatchLive({ type: 'JUMP_SEGMENT', index })
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
      remedialActive && remedialRef.current
        ? remedialRef.current.speech_intro
        : segment?.html_code
          ? segment.speech_intro
          : point.step >= 0
            ? segment?.step_by_step[point.step]?.speech_text ?? ''
            : segment?.speech_text ?? ''
    const wasPlaying =
      liveState === 'playing' ||
      liveState === 'explaining' ||
      liveState === 'resuming'
    const wasPaused = liveState === 'paused'

    clearBoardAnimWaiter()
    audioBus.stopAll()

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
      if (remedialActive && remedialRef.current) {
        void playRemedialSegment(remedialRef.current, session)
        return
      }
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

    setUploadStage('ppt')
    setUploadProgress(null)

    const [uploaded] = await uploadFilesInChunks([selectedPpt], {
      onProgress: setUploadProgress,
      concurrency: 3,
    })

    const data = await uploadApiJson<UploadResponse>(
      '/api/upload_ppt/finalize',
      {
        upload_id: uploaded.uploadId,
        subject: subjectValue,
      },
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
      let currentTaskId = pptTaskId

      if (selectedPpt && currentTaskId === null) {
        currentTaskId = await uploadPptFile(normalizedSubject)
      }

      if (selectedImages.length > 0) {
        setUploadStage('image')
        setUploadProgress(null)

        const uploadedImages = await uploadFilesInChunks(
          selectedImages.map((item) => item.file),
          {
            onProgress: setUploadProgress,
            concurrency: 3,
          },
        )

        setUploadProgress({
          loaded: uploadedImages.reduce(
            (sum, item) => sum + item.size,
            0,
          ),
          total: uploadedImages.reduce(
            (sum, item) => sum + item.size,
            0,
          ),
          phase: 'finalizing',
          chunksDone: uploadedImages.length,
          chunksTotal: uploadedImages.length,
        })

        const imageData = await uploadApiJson<UploadResponse>(
          '/api/upload_images/finalize',
          {
            upload_ids: uploadedImages.map((item) => item.uploadId),
            task_id: currentTaskId,
            subject: normalizedSubject || '通用课程',
          },
        )

        if (typeof imageData.task_id !== 'number') {
          throw new Error('图片解析接口返回数据异常')
        }
        currentTaskId = imageData.task_id
      }

      setUploadStage('audio')
      setUploadProgress(null)

      const uploaded = await uploadFilesInChunks(selectedFiles, {
        onProgress: setUploadProgress,
        concurrency: 4,
      })

      setUploadProgress({
        loaded: uploaded.reduce((sum, item) => sum + item.size, 0),
        total: uploaded.reduce((sum, item) => sum + item.size, 0),
        phase: 'finalizing',
        chunksDone: uploaded.length,
        chunksTotal: uploaded.length,
      })

      const data = await uploadApiJson<UploadResponse>(
        '/api/upload/finalize',
        {
          upload_ids: uploaded.map((item) => item.uploadId),
          task_id: currentTaskId,
          subject: normalizedSubject || '通用课程',
        },
      )

      if (typeof data.task_id !== 'number') {
        throw new Error('上传接口返回数据异常')
      }

      setUploadStage(null)
      setUploadProgress(null)
      setProcessingProgress(0)
      setProcessingMessage('文件已合并，后台预处理已启动，正在排队处理…')
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

  function handleImageFiles(
    fileList: FileList | File[] | null | undefined,
  ) {
    if (!fileList || phase === 'uploading') return

    const incoming = Array.from(fileList)
    if (!incoming.length) return

    if (selectedImages.length + incoming.length > MAX_IMAGE_COUNT) {
      setPhase('error')
      setUploadMessage(
        `一次最多上传 ${MAX_IMAGE_COUNT} 张图片，请分批补充`,
      )
      return
    }

    const invalid = incoming.find((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      return (
        !ALLOWED_IMAGE_EXTENSIONS.includes(extension) ||
        file.size > MAX_IMAGE_SIZE
      )
    })

    if (invalid) {
      setPhase('error')
      setUploadMessage(
        invalid.size > MAX_IMAGE_SIZE
          ? `图片「${invalid.name}」大小不能超过 20MB`
          : `图片「${invalid.name}」格式不支持，请使用 JPG、PNG、WEBP 等常见格式`,
      )
      return
    }

    const keys = new Set(
      selectedImages.map((item) => `${item.file.name}::${item.file.size}`),
    )
    const nextItems: SelectedImage[] = []
    for (const file of incoming) {
      const key = `${file.name}::${file.size}`
      if (keys.has(key)) continue
      keys.add(key)
      const url = URL.createObjectURL(file)
      imageUrlsRef.current.push(url)
      nextItems.push({
        key: `${key}::${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        file,
        url,
      })
    }

    if (nextItems.length === 0) return
    setSelectedImages((previous) => [...previous, ...nextItems])
    setPhase('idle')
    setUploadMessage('')
    setUploadStage(null)
    setUploadProgress(null)
  }

  function removeImage(key: string) {
    const target = selectedImages.find((item) => item.key === key)
    if (target) {
      URL.revokeObjectURL(target.url)
      imageUrlsRef.current = imageUrlsRef.current.filter(
        (url) => url !== target.url,
      )
    }
    const next = selectedImages.filter((item) => item.key !== key)
    setSelectedImages(next)
    setUploadStage(null)
    setUploadProgress(null)
    if (phase === 'error') {
      setPhase('idle')
      setUploadMessage('')
    }
  }

  function clearSelectedImages() {
    selectedImages.forEach((item) => URL.revokeObjectURL(item.url))
    imageUrlsRef.current = []
    setSelectedImages([])
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
    target: 'ppt' | 'image' | 'audio',
  ) {
    if (phase === 'uploading') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragTarget(target)
  }

  function handleUploadDragLeave(
    event: DragEvent<HTMLElement>,
    target: 'ppt' | 'image' | 'audio',
  ) {
    // 在子元素之间移动时也会触发 dragleave，用 relatedTarget 过滤掉
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) return
    setDragTarget((current) => (current === target ? null : current))
  }

  function handleUploadDrop(
    event: DragEvent<HTMLElement>,
    target: 'ppt' | 'image' | 'audio',
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

    if (target === 'image') {
      handleImageFiles(files)
      return
    }

    handleAudioFiles(files)
  }

  function resetFlow() {
    resetLiveSession(0)
    setPhase('idle')
    setSelectedFiles([])
    setSelectedPpt(null)
    clearSelectedImages()
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
    clearSelectedImages()
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
      clearSelectedImages()
      setPptTaskId(null)
      setBatchCount(0)
      setUploadMessage('')
      setCopyState('idle')
      setHistoryError('')
      appendMessage(
        'assistant',
        '已加载测试数据，可直接点击「开始上课」验证直播间。',
        'system',
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

  async function sendChat(messageOverride?: string, escalateEnabled = true) {
    const text = (messageOverride ?? chatInput).trim()
    if (!text || chatLoading || isEscalating) return

    appendMessage('user', text)
    setChatInput('')
    setChatLoading(true)

    const history = messages.slice(-8).map((message) => ({
      sender:
        message.role === 'user'
          ? 'student'
          : message.agent === 'teacher'
            ? 'teacher'
            : message.agent === 'system'
              ? 'system'
              : 'companion',
      content: message.content,
    }))

    try {
      const response = await fetch(`${API_BASE_URL}/api/companion_chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: text,
          subject: subject.trim() || '通用课程',
          note_context: result || null,
          lecture_context: buildLectureContext() || null,
          history,
          escalate_enabled: escalateEnabled,
        }),
      })

      const data = (await response.json()) as CompanionChatResponse

      if (!response.ok) {
        throw new Error(data.detail ?? `HTTP ${response.status}`)
      }

      if (typeof data.reply !== 'string' || !data.reply.trim()) {
        throw new Error('伴读接口返回内容为空')
      }

      const replyId = appendMessage('assistant', data.reply, 'companion')
      const focus = (data.focus ?? '').trim()

      if (data.action === 'escalate' && escalateEnabled) {
        if (!liveStoryboard.length) {
          appendMessage(
            'assistant',
            '伴读想替你举手，但课程还没开始。先加载课程内容，我才能把问题递给李老师。',
            'system',
          )
          void speakChatReply(data.reply, replyId)
          return
        }

        const command: AgentCommand = {
          id: `cmd-${Date.now()}`,
          type: 'ESCALATE_REMEDIAL',
          source: 'companion',
          target: 'teacher',
          focus: focus || text.slice(0, 40),
          reason: (data.reason ?? '').trim(),
          question: text,
          issuedAt: Date.now(),
        }
        dispatchLive({ type: 'DISPATCH_AGENT_COMMAND', command })
        appendMessage(
          'assistant',
          `[系统指令] 伴读向主讲李老师发送补救指令：针对「${command.focus}」暂停原进度并重讲`,
          'system',
        )
        setChatLoading(false)
        await startRemedial(text, command.focus, command)
        return
      }

      void speakChatReply(data.reply, replyId)
    } catch (error) {
      appendMessage(
        'assistant',
        `抱歉，伴读暂时无法回答：${
          error instanceof Error ? error.message : '未知错误'
        }`,
        'companion',
      )
    } finally {
      setChatLoading(false)
    }
  }

  function runQuickAction(action: 'summary' | 'explain') {
    if (chatLoading || isEscalating) return

    if (!result) {
      appendMessage('assistant', pickLine(NEED_NOTE_LINES), 'companion')
      return
    }

    const prompt =
      action === 'summary'
        ? '请总结当前复习笔记的核心内容，并列出 3 个复习重点。'
        : '请从当前复习笔记中选择一个重要概念，并用通俗语言解释。'

    void sendChat(prompt, false)
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

  const liveStatusLabel = isEscalating
    ? remedialMode === 'quiz'
      ? '错题拆解'
      : '伴读举手'
    : liveState === 'playing'
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
                  : liveState === 'awaiting-input'
                    ? '等待文字提问'
                    : liveState === 'thinking'
                    ? '正在思考'
                    : liveState === 'resuming'
                      ? '继续讲课'
                      : liveState === 'ended'
                        ? '本节结束'
                        : '待开始'

  const liveStatusTone = isEscalating
    ? 'bg-amber-200/[0.1] text-amber-100 border-amber-200/20'
    : liveState === 'playing'
      ? 'bg-white/[0.06] text-slate-300 border-white/10'
      : liveState === 'waiting'
        ? 'bg-white/[0.08] text-slate-200 border-white/15'
        : liveState === 'quiz'
          ? 'bg-white/[0.06] text-slate-300 border-white/10'
          : liveState === 'quiz-feedback'
            ? 'bg-white/[0.06] text-slate-300 border-white/10'
            : liveState === 'paused'
              ? 'bg-amber-200/[0.08] text-amber-100 border-amber-200/15'
              : liveState === 'explaining'
              ? 'bg-white/[0.04] text-slate-400 border-white/10'
              : liveState === 'listening' || liveState === 'awaiting-input'
                ? 'bg-amber-200/[0.08] text-amber-100 border-amber-200/15'
                : liveState === 'thinking' || liveState === 'interrupting'
                  ? 'bg-white/[0.04] text-slate-400 border-white/10'
                  : liveState === 'resuming'
                    ? 'bg-white/[0.08] text-slate-200 border-white/15'
                    : 'bg-white/[0.04] text-slate-500 border-white/10'

  return (
    <main className="min-h-screen bg-[#f7f7f5] lg:h-screen lg:overflow-hidden">
      <div className="flex min-h-screen flex-col lg:h-full lg:flex-row">
        <aside className="flex h-[65vh] min-h-[420px] shrink-0 flex-col border-b border-slate-200/70 bg-white/70 backdrop-blur-2xl lg:h-full lg:min-h-0 lg:w-2/5 lg:border-b-0 lg:border-r">
          <header className="border-b border-slate-200/60 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-600 text-sm font-semibold text-white">
                伴
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">
                    伴读小助手
                  </p>
                  <span className="rounded-full border border-emerald-200/70 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-emerald-700">
                    多智能体
                  </span>
                </div>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-emerald-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  基础问题我来答 · 难题替你举手找李老师
                </p>
              </div>
            </div>
          </header>

          <div
            ref={chatScrollRef}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
          >
            {messages.map((message) => {
              const isUser = message.role === 'user'
              const agent = message.agent ?? 'companion'

              if (!isUser && agent === 'system') {
                return (
                  <div key={message.id} className="flex justify-center">
                    <div className="inline-flex items-center gap-2 rounded-full border border-amber-200/70 bg-amber-50/80 px-3 py-1 text-[11px] font-medium text-amber-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                      {message.content}
                    </div>
                  </div>
                )
              }

              const isTeacher = agent === 'teacher'

              return (
                <div
                  key={message.id}
                  className={`flex items-start gap-2 ${
                    isUser ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {!isUser && (
                    <div
                      className={`mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${
                        isTeacher
                          ? 'bg-slate-900 text-[#f3c969]'
                          : 'bg-emerald-600 text-white'
                      }`}
                    >
                      {isTeacher ? '李' : '伴'}
                    </div>
                  )}

                  <div className="max-w-[82%]">
                    {!isUser && (
                      <div className="mb-1 flex items-center gap-1.5">
                        <span
                          className={`text-[11px] font-semibold ${
                            isTeacher ? 'text-slate-800' : 'text-emerald-700'
                          }`}
                        >
                          {isTeacher ? '主讲李老师' : '伴读小助手'}
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                            isTeacher
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {isTeacher ? '主讲' : '伴读'}
                        </span>
                      </div>
                    )}

                    {isUser ? (
                      <div className="whitespace-pre-wrap rounded-2xl rounded-tr-md bg-slate-900 px-4 py-2.5 text-sm leading-6 text-white">
                        {message.content}
                      </div>
                    ) : (
                      <div
                        className={`chat-markdown rounded-2xl border px-4 py-2.5 backdrop-blur-xl ${
                          isTeacher
                            ? 'border-amber-200/70 bg-amber-50/70'
                            : 'border-slate-200/70 bg-white/75'
                        }`}
                      >
                        {speakingMessageId === message.id && (
                          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
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
                            {isTeacher
                              ? '李老师正在讲解…'
                              : '伴读正在语音解答…'}
                          </div>
                        )}
                        <MarkdownView content={message.content} />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {chatLoading && (
              <div className="flex items-start gap-2">
                <div className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-[11px] font-semibold text-white">
                  伴
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-emerald-700">
                      伴读小助手
                    </span>
                    <span className="text-[10px] text-slate-400">正在思考</span>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-2xl border border-slate-200/70 bg-white/75 px-4 py-3 backdrop-blur-xl">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-slate-200/60 bg-white/60 p-4 backdrop-blur-xl">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => runQuickAction('summary')}
                disabled={!result || chatLoading || isEscalating}
                className="rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
              >
                总结当前笔记
              </button>
              <button
                type="button"
                onClick={() => runQuickAction('explain')}
                disabled={!result || chatLoading || isEscalating}
                className="rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
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
                placeholder="问伴读：老师刚才那句什么意思？"
                disabled={chatLoading || isEscalating}
                className="min-w-0 flex-1 rounded-xl border border-slate-200/80 bg-white/70 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-200/60 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void sendChat()}
                disabled={chatLoading || isEscalating || !chatInput.trim()}
                className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                发送
              </button>
            </div>
            <p className="mt-2 text-[10px] text-slate-400">
              基础问题伴读直接答；遇到难点，伴读会举手请李老师重新板书讲解。
            </p>
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto bg-[#f7f7f5]">
          <div className="mx-auto w-full max-w-4xl px-5 py-8 lg:px-8 lg:py-10">
            <header className="mb-6 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
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
                  onClick={() => void openFavorites()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs font-medium text-slate-600 backdrop-blur-xl transition hover:border-slate-300 hover:text-slate-900"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M17.25 3.75H6.75A1.5 1.5 0 0 0 5.25 5.25v15l6.75-4.5 6.75 4.5v-15a1.5 1.5 0 0 0-1.5-1.5Z"
                    />
                  </svg>
                  我的收藏
                </button>

                <button
                  type="button"
                  onClick={() => void loadMockTask()}
                  disabled={mockLoading || phase === 'uploading'}
                  title="跳过上传与 ASR/LLM 处理，直接加载固定分镜数据"
                  className="text-xs text-slate-400 underline decoration-dotted underline-offset-4 transition hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {mockLoading ? '加载中…' : '加载测试数据（免上传）'}
                </button>

                <div className="flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/70 px-3 py-1.5 text-xs backdrop-blur-xl">
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
                className="rounded-3xl border border-slate-200/70 bg-white/70 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-xl lg:p-6"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => event.preventDefault()}
              >
                <p className="text-sm text-slate-500">
                  课程科目会自动识别，无需手动填写。上传课堂录音即可开始整理。
                </p>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label
                    htmlFor="ppt-upload"
                    onDragEnter={(event) => handleUploadDragOver(event, 'ppt')}
                    onDragOver={(event) => handleUploadDragOver(event, 'ppt')}
                    onDragLeave={(event) => handleUploadDragLeave(event, 'ppt')}
                    onDrop={(event) => handleUploadDrop(event, 'ppt')}
                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                      dragTarget === 'ppt'
                        ? 'border-slate-400/70 bg-slate-100/80 ring-1 ring-slate-300/60'
                        : 'border-slate-200/80 bg-white/60 hover:border-slate-300 hover:bg-white'
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
                      className="h-6 w-6 shrink-0 text-slate-500"
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
                      <p className="mt-1 text-[11px] font-medium leading-4 text-slate-500">
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
                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                      dragTarget === 'audio'
                        ? 'border-slate-400/70 bg-slate-100/80 ring-1 ring-slate-300/60'
                        : 'border-slate-200/80 bg-white/60 hover:border-slate-300 hover:bg-white'
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
                      className="h-6 w-6 shrink-0 text-slate-500"
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
                      <p className="mt-1 text-[11px] font-medium leading-4 text-slate-500">
                        💡 提示：您可以直接从微信聊天窗口将文件拖拽到此处上传
                      </p>
                    </div>
                  </label>

                  <label
                    htmlFor="image-upload"
                    onDragEnter={(event) =>
                      handleUploadDragOver(event, 'image')
                    }
                    onDragOver={(event) =>
                      handleUploadDragOver(event, 'image')
                    }
                    onDragLeave={(event) =>
                      handleUploadDragLeave(event, 'image')
                    }
                    onDrop={(event) => handleUploadDrop(event, 'image')}
                    className={`flex cursor-pointer items-center gap-3 rounded-2xl border px-4 py-3 transition ${
                      dragTarget === 'image'
                        ? 'border-slate-400/70 bg-slate-100/80 ring-1 ring-slate-300/60'
                        : 'border-slate-200/80 bg-white/60 hover:border-slate-300 hover:bg-white'
                    } ${
                      phase === 'uploading'
                        ? 'pointer-events-none opacity-60'
                        : ''
                    }`}
                  >
                    <input
                      id="image-upload"
                      type="file"
                      multiple
                      accept=".jpg,.jpeg,.png,.webp,.bmp,.gif,image/*"
                      className="hidden"
                      onChange={(event) => {
                        handleImageFiles(event.target.files)
                        event.target.value = ''
                      }}
                    />
                    <svg
                      className="h-6 w-6 shrink-0 text-slate-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Z"
                      />
                    </svg>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">
                        上传补充图片
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {selectedImages.length > 0
                          ? `已选择 ${selectedImages.length} 张图片`
                          : '可选 · JPG / PNG / WEBP · 单张 ≤ 20MB'}
                      </p>
                      <p className="mt-1 text-[11px] font-medium leading-4 text-slate-500">
                        拍黑板、拍练习题，李老师会结合图片讲解
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

                {selectedImages.length > 0 && (
                  <div className="mt-3 rounded-xl border border-slate-200/70 bg-white/60 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-slate-600">
                        补充图片 {selectedImages.length} 张
                      </span>
                      <button
                        type="button"
                        onClick={clearSelectedImages}
                        className="text-[11px] text-slate-400 transition hover:text-red-500"
                      >
                        清空
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                      {selectedImages.map((item) => (
                        <div
                          key={item.key}
                          className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100"
                          title={item.file.name}
                        >
                          <img
                            src={item.url}
                            alt={item.file.name}
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => removeImage(item.key)}
                            aria-label={`移除图片 ${item.file.name}`}
                            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-xs text-white opacity-0 transition group-hover:opacity-100"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-400">
                      图片需要和课堂录音一起提交；会先由视觉模型提取文字与题目信息，再交给李老师备课。
                    </p>
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
                    ? `正在上传${selectedPpt ? '课件、' : ''}${
                        selectedImages.length ? '图片与' : ''
                      } ${selectedFiles.length} 个音频${
                        uploadProgress ? ` · ${uploadPercent}%` : '…'
                      }`
                    : '开始整理'}
                </button>

                {phase === 'uploading' && (
                  <div className="mt-3 rounded-2xl border border-slate-200/70 bg-white/60 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-600">
                        {uploadStage === 'ppt'
                          ? uploadProgress?.phase === 'merging'
                            ? 'PPT 分片已上传，服务器正在合并文件…'
                            : uploadProgress?.phase === 'finalizing'
                              ? 'PPT 已合并，正在解析课件内容…'
                              : 'PPT 正在分片并行上传…'
                          : uploadStage === 'image'
                            ? uploadProgress?.phase === 'merging'
                              ? '图片分片已上传，服务器正在合并文件…'
                              : uploadProgress?.phase === 'finalizing'
                                ? '图片已合并，AI 正在识别黑板与题目…'
                                : `正在分片并行上传 ${selectedImages.length} 张图片…`
                            : uploadStage === 'audio'
                              ? uploadProgress?.phase === 'merging'
                                ? '音频分片已上传，服务器正在合并文件…'
                                : uploadProgress?.phase === 'finalizing'
                                  ? '音频已合并，正在创建任务并启动后台预处理…'
                                  : uploadProgress && uploadPercent >= 100
                                    ? '分片上传完成，正在合并文件…'
                                    : `正在分片并行上传 ${selectedFiles.length} 个音频…`
                              : '正在准备上传…'}
                      </span>
                      <span className="font-semibold tabular-nums text-slate-700">
                        {uploadProgress ? `${uploadPercent}%` : '—'}
                      </span>
                    </div>

                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                      <div
                        className={`h-full rounded-full bg-slate-900 transition-[width] duration-200 ${
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
                        {uploadProgress?.phase === 'merging'
                          ? '分片已全部到达 · 服务器正在合并'
                          : uploadProgress?.phase === 'finalizing'
                            ? '文件已合并 · 后台预处理即将启动'
                            : uploadProgress
                              ? `${formatFileSize(
                                  uploadProgress.loaded,
                                )} / ${formatFileSize(
                                  uploadProgress.total,
                                )}${
                                  uploadProgress.speed
                                    ? ` · ${formatSpeed(uploadProgress.speed)}`
                                    : ''
                                }${
                                  typeof uploadProgress.chunksTotal ===
                                    'number' &&
                                  uploadProgress.chunksTotal > 0
                                    ? ` · 分片 ${
                                        uploadProgress.chunksDone ?? 0
                                      }/${uploadProgress.chunksTotal}`
                                    : ''
                                }`
                              : '等待浏览器开始传输…'}
                      </span>
                      <span>已启用 4 路分片并行上传，可保持页面打开</span>
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
              <div className="rounded-3xl border border-slate-200/70 bg-white/70 px-6 py-8 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-xl lg:px-8">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
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
                    className="h-full rounded-full bg-slate-900 transition-[width] duration-700 ease-out"
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
                    className="fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full bg-[#f3c969] px-4 py-3 text-sm font-semibold text-slate-900 shadow-[0_10px_30px_-12px_rgba(15,23,42,0.35)] transition hover:bg-[#f7d47d] sm:bottom-7 sm:right-7"
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

                <div className="lecture-canvas relative overflow-hidden rounded-[28px] border border-white/10 shadow-[0_24px_60px_-36px_rgba(15,23,42,0.55)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3 lg:px-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-400/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-red-300">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400/80" />
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
                      <button
                        type="button"
                        onClick={() => void saveCurrentBoard()}
                        disabled={
                          !canFavorite || favoriteSaving || isEscalating
                        }
                        title={
                          canFavorite
                            ? '保存当前板书快照，可在「我的收藏」中回放'
                            : '当前没有可收藏的 HTML 板书'
                        }
                        className="inline-flex items-center gap-1.5 rounded-full border border-[#f3c969]/25 bg-[#f3c969]/[0.08] px-2.5 py-1 text-[11px] font-medium text-[#f3c969] transition hover:bg-[#f3c969]/[0.14] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-500"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M17.25 3.75H6.75A1.5 1.5 0 0 0 5.25 5.25v15l6.75-4.5 6.75 4.5v-15a1.5 1.5 0 0 0-1.5-1.5Z"
                          />
                        </svg>
                        {favoriteSaved
                          ? '已收藏'
                          : favoriteSaving
                            ? '收藏中…'
                            : '收藏当前板书'}
                      </button>

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
                        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm text-slate-300 transition hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
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
                        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sm text-slate-300 transition hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        ›
                      </button>
                    </div>
                  </div>

                  {companionRaised && (
                    <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#f3c969]/25 bg-[#f3c969]/[0.06] px-4 py-3 lg:mx-6">
                      <div className="flex items-center gap-3">
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#f3c969]/60" />
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#f3c969]" />
                        </span>
                        <div>
                          <p className="text-xs font-semibold tracking-wide text-[#f3c969]">
                            {remedialMode === 'quiz'
                              ? '错题拆解中'
                              : '伴读向老师举手了'}
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-400">
                            {remedialMode === 'quiz'
                              ? remedialActive
                                ? `李老师正在拆解：${
                                    companionFocus || '这道错题'
                                  }`
                                : '李老师正在把这道题拆成更小的步骤…'
                              : remedialActive
                                ? `李老师正在单独讲解：${
                                    companionFocus || '你的薄弱点'
                                  }`
                                : '李老师已暂停原进度，正在重新备课…'}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-slate-400">
                        {remedialMode === 'quiz'
                          ? 'Quiz → Teacher'
                          : 'Companion → Teacher'}
                      </span>
                    </div>
                  )}

                  <div className="relative px-4 pb-5 pt-5 lg:px-6">
                    <span className="lecture-canvas__number" aria-hidden="true">
                      {String(liveIndex + 1).padStart(2, '0')}
                    </span>

                    <div className="relative flex items-end justify-between gap-3">
                      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400">
                        {remedialActive
                          ? 'Remedial · 补救板书'
                          : `Segment ${String(liveIndex + 1).padStart(2, '0')}`}
                        {liveStepIndex >= 0 && totalSteps > 0 && (
                          <span className="ml-2 normal-case tracking-normal text-slate-400">
                            步骤 {liveStepIndex + 1}/{totalSteps}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-500">
                        {remedialActive
                          ? '伴读举手后新增'
                          : `分镜 ${liveIndex + 1} / ${
                              liveStoryboard.length || 1
                            }`}
                      </span>
                    </div>

                    <div className="relative mt-4">
                      {remedialActive && remedialBoard ? (
                        <DynamicBoard
                          key={`remedial-${remedialKey}`}
                          htmlCode={remedialBoard.html_code}
                          trigger={boardTrigger}
                          segmentIndex={liveIndex}
                          focusLabel={
                            companionFocus
                              ? `补救：${companionFocus}`
                              : '补救板书'
                          }
                          label="补救板书"
                          fallbackText={remedialBoard.speech_intro}
                          onAnimationComplete={handleBoardAnimationComplete}
                          isActive={
                            liveState === 'playing' ||
                            liveState === 'explaining' ||
                            liveState === 'interrupting' ||
                            liveState === 'resuming'
                          }
                        />
                      ) : activeLiveSegment?.html_code ? (
                        <DynamicBoard
                          key={`dynamic-${liveIndex}`}
                          htmlCode={activeLiveSegment.html_code}
                          trigger={boardTrigger}
                          segmentIndex={liveIndex}
                          focusLabel={liveFocus}
                          pptPage={activeLiveSegment.ppt_page}
                          highlightLines={activeLiveSegment.highlight_lines}
                          fallbackText={activeLiveSegment.speech_intro}
                          onAnimationComplete={handleBoardAnimationComplete}
                          isActive={
                            liveState === 'playing' ||
                            liveState === 'explaining' ||
                            liveState === 'interrupting' ||
                            liveState === 'resuming'
                          }
                        />
                      ) : (
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
                      )}

                      {isPreparing && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 rounded-2xl bg-[#0f1114]/90 backdrop-blur-sm">
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
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-400/70" />
                        实时字幕
                      </div>
                      <p
                        key={liveCaption}
                        className="caption-fade mt-1.5 min-h-[2.5rem] text-sm leading-6 text-slate-300"
                      >
                        {liveCaption ||
                          activeStep?.speech_text ||
                          activeLiveSegment?.speech_intro ||
                          activeLiveSegment?.speech_text ||
                          '点击「开始上课」，老师会一步步推导，每一步都会停下来等你确认'}
                      </p>

                      {liveFocus && (
                        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-300">
                          <span className="h-1 w-1 rounded-full bg-slate-400" />
                          正在聚焦：{liveFocus}
                        </p>
                      )}
                    </div>

                    {/* 举手打断：语音没听清或麦克风不可用时，改为文字提问 */}
                    {showInterruptInput && (
                      <div className="relative mt-4 rounded-2xl border border-amber-200/15 bg-amber-100/[0.04] p-4 backdrop-blur-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-amber-50/90">
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
                            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#17181b] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-200/30 focus:outline-none"
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
                            className="shrink-0 rounded-xl bg-[#f3c969] px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-[#f7d47d] disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            发送
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            dispatchLive({ type: 'DISMISS_INTERRUPT_INPUT' })
                          }
                          className="mt-2 text-[11px] text-slate-400 underline decoration-dotted underline-offset-4 transition hover:text-slate-200"
                        >
                          先不问了
                        </button>
                      </div>
                    )}

                    {/* 暂停状态：等学生准备好再继续 */}
                    {liveState === 'paused' && !showInterruptInput && (
                      <div className="relative mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200/15 bg-amber-100/[0.04] p-4 backdrop-blur-sm">
                        <div>
                          <p className="text-sm font-medium text-amber-50/90">
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
                            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
                          >
                            继续刚才的内容
                          </button>
                          <button
                            type="button"
                            onClick={() => void interruptClass()}
                            className="rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
                          >
                            我还有问题
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 随堂小测：每个分镜讲完后作答，再继续下一段 */}
                    {(liveState === 'quiz' || liveState === 'quiz-feedback') &&
                      activeQuiz && (
                        <div className="relative mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-semibold text-slate-200">
                              <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
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
                                'border-white/10 bg-white/[0.03] text-slate-200 hover:border-white/25 hover:bg-white/[0.07]'
                              if (revealed && isAnswer) {
                                tone =
                                  'border-emerald-300/35 bg-emerald-300/[0.1] text-emerald-50'
                              } else if (
                                revealed &&
                                isChosen &&
                                !isAnswer
                              ) {
                                tone =
                                  'border-red-300/35 bg-red-300/[0.1] text-red-50'
                              } else if (isChosen) {
                                tone =
                                  'border-white/40 bg-white/[0.1] text-white'
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
                                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
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
                                className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
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
                          <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
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
                          className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
                        >
                          {remedialActive
                            ? remedialMode === 'quiz'
                              ? '听懂了，继续下一段'
                              : '听懂了，回到课堂'
                            : '听懂了，下一步'}
                          <kbd className="rounded border border-slate-900/10 bg-slate-900/5 px-1.5 py-0.5 text-[10px] font-normal text-slate-600">
                            Enter
                          </kbd>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleNotUnderstood()}
                          disabled={liveState !== 'waiting'}
                          className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-slate-500"
                        >
                          没听懂，再讲讲
                          <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-normal text-slate-400">
                            R
                          </kbd>
                        </button>

                        <button
                          type="button"
                          onClick={() => void toggleSlowMode()}
                          className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition ${
                            isSlowMode
                              ? 'border-white/30 bg-white/[0.12] text-white'
                              : 'border-white/15 bg-white/5 text-slate-300 hover:border-white/25 hover:text-white'
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
                                ? 'bg-white ring-2 ring-white/20'
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
                        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-slate-300 transition hover:border-white/25 hover:text-white">
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
                            className="cursor-pointer rounded-md border border-white/10 bg-[#17181b] px-2 py-1 text-xs font-medium text-slate-200 focus:border-white/30 focus:outline-none"
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
                            className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
                          >
                            {liveState === 'ended' ? '重新上课' : '开始上课'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-3xl border border-slate-200/70 bg-white/70 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-xl lg:p-6">
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
                              : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900'
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
                  className="shrink-0 rounded-full border border-slate-200 bg-white/70 px-3 py-1 text-xs font-medium text-slate-500 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
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
                <div className="mt-4 flex items-center justify-center gap-2 rounded-3xl border border-slate-200/70 bg-white/60 px-4 py-8 text-sm text-slate-400 backdrop-blur-xl">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-slate-500" />
                  正在加载历史记录…
                </div>
              ) : history.length === 0 ? (
                <div className="mt-4 rounded-3xl border border-dashed border-slate-300/80 bg-white/50 px-4 py-8 text-center text-sm text-slate-400 backdrop-blur-xl">
                  暂无历史记录，上传一段录音开始体验吧
                </div>
              ) : (
                <div className="mt-4 overflow-hidden rounded-3xl border border-slate-200/70 bg-white/70 backdrop-blur-xl">
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
                                ? 'bg-slate-100/70'
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

      {favoritesOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
          <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-[#f7f7f5] shadow-2xl md:flex-row">
            <aside className="flex max-h-[36vh] w-full shrink-0 flex-col border-b border-slate-200/70 bg-white/80 backdrop-blur-xl md:max-h-none md:w-80 md:border-b-0 md:border-r">
              <div className="flex items-center justify-between border-b border-slate-200/60 px-4 py-3.5">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    我的收藏
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    共 {favorites.length} 条板书快照
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setFavoritesOpen(false)}
                  aria-label="关闭收藏"
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900"
                >
                  ×
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {favoritesLoading && (
                  <p className="px-2 py-6 text-center text-xs text-slate-400">
                    正在加载收藏…
                  </p>
                )}

                {!favoritesLoading && favoritesError && (
                  <p className="rounded-xl border border-red-200/70 bg-red-50/80 px-3 py-2 text-xs text-red-600">
                    {favoritesError}
                  </p>
                )}

                {!favoritesLoading &&
                  !favoritesError &&
                  favorites.length === 0 && (
                    <div className="px-2 py-8 text-center">
                      <p className="text-sm text-slate-500">
                        还没有收藏的板书
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-slate-400">
                        上课时点击白板上方的「收藏当前板书」，
                        就能在这里回放当时的动态形成过程。
                      </p>
                    </div>
                  )}

                {favorites.map((item) => {
                  const active =
                    replayFavorite?.favorite_id === item.favorite_id
                  return (
                    <div
                      key={item.favorite_id}
                      className={`group flex items-start gap-2 rounded-2xl border px-3 py-2.5 transition ${
                        active
                          ? 'border-slate-900/20 bg-slate-900/[0.06]'
                          : 'border-slate-200/70 bg-white/70 hover:border-slate-300'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => chooseFavorite(item)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-xs font-semibold text-slate-800">
                          {item.title || '课堂板书'}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400">
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-slate-500">
                            {item.source === 'quiz'
                              ? '错题讲解'
                              : item.source === 'remedial'
                                ? '补救板书'
                                : '分镜板书'}
                          </span>
                          <span>{item.subject || '通用课程'}</span>
                          <span>{formatDateTime(item.saved_at)}</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeFavorite(item.favorite_id)}
                        aria-label="删除收藏"
                        className="mt-0.5 shrink-0 text-[10px] text-slate-300 transition hover:text-red-500"
                      >
                        删除
                      </button>
                    </div>
                  )
                })}
              </div>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {replayFavorite ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/60 bg-white/60 px-5 py-3.5 backdrop-blur-xl">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {replayFavorite.title || '课堂板书'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        {replayFavorite.subject || '通用课程'} ·{' '}
                        {formatDateTime(replayFavorite.saved_at)} ·{' '}
                        {replayFavorite.filename || '收藏快照'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={replayFavoriteAgain}
                      className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3.5 py-2 text-xs font-medium text-white transition hover:bg-slate-700"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M16.023 9.348h4.992V4.356M3.985 19.644v-4.992h4.992M4.985 9.348a7.5 7.5 0 0 1 12.366-2.75l3.664 3.75M19.015 14.652a7.5 7.5 0 0 1-12.366 2.75l-3.664-3.75"
                        />
                      </svg>
                      重新播放动画
                    </button>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {replayFavorite.html_code ? (
                      <DynamicBoard
                        key={`replay-${replayFavorite.favorite_id}-${replayRun}`}
                        htmlCode={replayFavorite.html_code}
                        trigger={replayTrigger}
                        segmentIndex={Math.max(
                          0,
                          replayFavorite.segment_id - 1,
                        )}
                        label="收藏回放"
                        focusLabel={replayFavorite.subject}
                      />
                    ) : (
                      <div className="rounded-2xl border border-white/10 bg-[#0f1114] p-6 text-sm leading-7 text-slate-200">
                        {replayFavorite.board_content ||
                          '这条收藏没有可回放的 HTML 板书。'}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-[#f3c969]">
                    <svg
                      className="h-5 w-5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M17.25 3.75H6.75A1.5 1.5 0 0 0 5.25 5.25v15l6.75-4.5 6.75 4.5v-15a1.5 1.5 0 0 0-1.5-1.5Z"
                      />
                    </svg>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-800">
                    选择一条收藏开始回放
                  </p>
                  <p className="mt-1 max-w-sm text-xs leading-6 text-slate-400">
                    回放会重新执行当时的板书动画，让你再看一遍知识是怎么一步步写出来的。
                  </p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
