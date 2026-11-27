import type { BoardTrigger } from '../components/DynamicBoard'

export type LiveState =
  | 'idle'
  | 'playing'
  | 'waiting'
  | 'quiz'
  | 'quiz-feedback'
  | 'paused'
  | 'explaining'
  | 'interrupting'
  | 'listening'
  | 'awaiting-input'
  | 'thinking'
  | 'resuming'
  | 'ended'

export type RemedialMode = 'companion' | 'quiz'

export interface RemedialSegment {
  speech_intro: string
  html_code: string
  animation_trigger: string
}

/** 伴读子智能体与主讲李老师之间的结构化系统指令。 */
export interface AgentCommand {
  id: string
  type: 'ESCALATE_REMEDIAL' | 'QUIZ_REMEDIAL' | 'RESUME_FROM_REMEDIAL'
  source: 'companion' | 'quiz' | 'teacher'
  target: 'teacher' | 'companion'
  focus: string
  reason?: string
  question?: string
  issuedAt: number
}

export interface LiveMachineState {
  liveState: LiveState
  liveIndex: number
  liveStepIndex: number
  liveCaption: string
  liveError: string
  liveFocus: string
  liveHighlightLines: number[]
  boardTrigger: BoardTrigger | null
  isPreparing: boolean
  prepareLine: string
  showInterruptInput: boolean
  quizChoice: string | null
  quizVerdict: 'correct' | 'wrong' | null
  isEscalating: boolean
  companionRaised: boolean
  companionFocus: string
  remedialBoard: RemedialSegment | null
  remedialActive: boolean
  remedialKey: number
  remedialMode: RemedialMode
  lastCommand: AgentCommand | null
}

export const initialLiveState: LiveMachineState = {
  liveState: 'idle',
  liveIndex: 0,
  liveStepIndex: -1,
  liveCaption: '',
  liveError: '',
  liveFocus: '',
  liveHighlightLines: [],
  boardTrigger: null,
  isPreparing: false,
  prepareLine: '',
  showInterruptInput: false,
  quizChoice: null,
  quizVerdict: null,
  isEscalating: false,
  companionRaised: false,
  companionFocus: '',
  remedialBoard: null,
  remedialActive: false,
  remedialKey: 0,
  remedialMode: 'companion',
  lastCommand: null,
}

export type LiveAction =
  | { type: 'SET_STATE'; liveState: LiveState }
  | { type: 'SET_POSITION'; index: number; step: number }
  | { type: 'SET_CAPTION'; caption: string }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'SET_FOCUS'; focus: string }
  | { type: 'SET_HIGHLIGHT_LINES'; lines: number[] }
  | { type: 'SET_BOARD_TRIGGER'; trigger: BoardTrigger | null }
  | { type: 'SET_PREPARING'; isPreparing: boolean; prepareLine?: string }
  | {
      type: 'SET_QUIZ_STATE'
      choice: string | null
      verdict: 'correct' | 'wrong' | null
    }
  | { type: 'SET_SHOW_INTERRUPT_INPUT'; show: boolean }
  | { type: 'BEGIN_INTERRUPT'; cancelEscalating?: boolean }
  | { type: 'INTERRUPT_FALLBACK_INPUT'; caption: string; error?: string }
  | { type: 'DISMISS_INTERRUPT_INPUT' }
  | {
      type: 'START_ESCALATION'
      mode: RemedialMode
      focus: string
      prepareLine: string
      command?: AgentCommand
    }
  | { type: 'ENTER_REMEDIAL'; segment: RemedialSegment }
  | { type: 'END_ESCALATION_LOADING' }
  | {
      type: 'FAIL_ESCALATION'
      error: string
      nextLiveState: LiveState
      resetMode?: boolean
    }
  | { type: 'EXIT_REMEDIAL'; nextLiveState: LiveState; command?: AgentCommand }
  | { type: 'START_CLASS'; prepareLine: string }
  | { type: 'STOP_CLASS' }
  | { type: 'RESET_SESSION'; nextIndex: number }
  | { type: 'JUMP_SEGMENT'; index: number }
  | { type: 'DISPATCH_AGENT_COMMAND'; command: AgentCommand }

export function isLiveBusyState(liveState: LiveState): boolean {
  return (
    liveState === 'playing' ||
    liveState === 'quiz-feedback' ||
    liveState === 'explaining' ||
    liveState === 'interrupting' ||
    liveState === 'listening' ||
    liveState === 'thinking' ||
    liveState === 'resuming'
  )
}

export function isLiveActiveState(liveState: LiveState): boolean {
  return liveState !== 'idle' && liveState !== 'ended'
}

export function liveReducer(
  state: LiveMachineState,
  action: LiveAction,
): LiveMachineState {
  switch (action.type) {
    case 'SET_STATE':
      return {
        ...state,
        liveState: action.liveState,
        showInterruptInput:
          action.liveState === 'awaiting-input'
            ? state.showInterruptInput
            : false,
      }
    case 'SET_POSITION':
      return {
        ...state,
        liveIndex: action.index,
        liveStepIndex: action.step,
      }
    case 'SET_CAPTION':
      return { ...state, liveCaption: action.caption }
    case 'SET_ERROR':
      return { ...state, liveError: action.error }
    case 'SET_FOCUS':
      return { ...state, liveFocus: action.focus }
    case 'SET_HIGHLIGHT_LINES':
      return { ...state, liveHighlightLines: action.lines }
    case 'SET_BOARD_TRIGGER':
      return { ...state, boardTrigger: action.trigger }
    case 'SET_PREPARING':
      return {
        ...state,
        isPreparing: action.isPreparing,
        prepareLine:
          action.prepareLine !== undefined
            ? action.prepareLine
            : state.prepareLine,
      }
    case 'SET_QUIZ_STATE':
      return {
        ...state,
        quizChoice: action.choice,
        quizVerdict: action.verdict,
      }
    case 'SET_SHOW_INTERRUPT_INPUT':
      return {
        ...state,
        showInterruptInput: action.show,
      }
    case 'BEGIN_INTERRUPT':
      return {
        ...state,
        liveState: 'interrupting',
        liveError: '',
        showInterruptInput: false,
        isPreparing: false,
        ...(action.cancelEscalating
          ? {
              isEscalating: false,
              companionRaised: false,
              companionFocus: '',
              remedialMode: 'companion' as RemedialMode,
            }
          : {}),
      }
    case 'INTERRUPT_FALLBACK_INPUT':
      // 麦克风失败或未听到语音时从 listening 切入 awaiting-input，防止状态卡死
      return {
        ...state,
        liveState: 'awaiting-input',
        showInterruptInput: true,
        liveCaption: action.caption,
        liveError: action.error ?? state.liveError,
      }
    case 'DISMISS_INTERRUPT_INPUT':
      return {
        ...state,
        showInterruptInput: false,
        liveState: 'paused',
      }
    case 'START_ESCALATION':
      return {
        ...state,
        remedialMode: action.mode,
        companionRaised: true,
        companionFocus: action.focus,
        liveError: '',
        quizChoice: null,
        quizVerdict: null,
        boardTrigger: null,
        showInterruptInput: false,
        liveState: 'playing',
        prepareLine: action.prepareLine,
        isPreparing: true,
        isEscalating: true,
        lastCommand: action.command ?? state.lastCommand,
      }
    case 'ENTER_REMEDIAL':
      return {
        ...state,
        remedialBoard: action.segment,
        remedialActive: true,
        remedialKey: state.remedialKey + 1,
      }
    case 'END_ESCALATION_LOADING':
      return {
        ...state,
        isEscalating: false,
        isPreparing: false,
      }
    case 'FAIL_ESCALATION':
      return {
        ...state,
        companionRaised: false,
        isEscalating: false,
        isPreparing: false,
        liveError: action.error,
        liveState: action.nextLiveState,
        ...(action.resetMode ? { remedialMode: 'companion' as RemedialMode } : {}),
      }
    case 'EXIT_REMEDIAL':
      return {
        ...state,
        remedialMode: 'companion',
        remedialBoard: null,
        remedialActive: false,
        companionRaised: false,
        companionFocus: '',
        boardTrigger: null,
        quizChoice: null,
        quizVerdict: null,
        showInterruptInput: false,
        liveState: action.nextLiveState,
        lastCommand: action.command ?? state.lastCommand,
      }
    case 'START_CLASS':
      return {
        ...state,
        liveError: '',
        quizChoice: null,
        quizVerdict: null,
        boardTrigger: null,
        showInterruptInput: false,
        prepareLine: action.prepareLine,
        isPreparing: true,
        liveState: 'playing',
      }
    case 'STOP_CLASS':
      return {
        ...state,
        isPreparing: false,
        boardTrigger: null,
        showInterruptInput: false,
        isEscalating: false,
        remedialMode: 'companion',
        remedialBoard: null,
        remedialActive: false,
        companionRaised: false,
        companionFocus: '',
        liveState: 'idle',
      }
    case 'RESET_SESSION':
      return {
        ...initialLiveState,
        liveIndex: action.nextIndex,
        liveStepIndex: -1,
      }
    case 'JUMP_SEGMENT':
      return {
        ...initialLiveState,
        liveIndex: action.index,
        liveStepIndex: -1,
      }
    case 'DISPATCH_AGENT_COMMAND':
      return {
        ...state,
        lastCommand: action.command,
      }
    default:
      return state
  }
}
