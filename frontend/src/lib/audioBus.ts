import { playTts, type TtsPlayback } from './tts'

export type AudioChannel = 'teacher' | 'companion' | 'system'

export interface AudioBusSnapshot {
  isPlaying: boolean
  activeChannel: AudioChannel | null
  speakingMessageId: string | null
  generation: number
}

export interface AudioBusPlayOptions {
  channel: AudioChannel
  speed?: number
  messageId?: string | null
  onStarted?: () => void
}

type AudioBusListener = (snapshot: AudioBusSnapshot) => void

/**
 * 全局单一音频总线（AudioBus）：
 * 通过严格单调递增的 generation 代际令牌，确保同一时刻最多只有一路 TTS 音频播放，
 * 任何新播放或中断都会原子停止前序音频与在途请求，从根源杜绝叠音。
 */
export class AudioBus {
  private generation = 0
  private currentPlayback: TtsPlayback | null = null
  private activeChannel: AudioChannel | null = null
  private speakingMessageId: string | null = null
  private listeners = new Set<AudioBusListener>()

  getSnapshot(): AudioBusSnapshot {
    return {
      isPlaying: this.currentPlayback !== null,
      activeChannel: this.activeChannel,
      speakingMessageId: this.speakingMessageId,
      generation: this.generation,
    }
  }

  subscribe(listener: AudioBusListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    const snapshot = this.getSnapshot()
    this.listeners.forEach((listener) => listener(snapshot))
  }

  isChannelPlaying(channel: AudioChannel): boolean {
    return this.currentPlayback !== null && this.activeChannel === channel
  }

  /** 停止当前正在播放或待播的音频，并推进代际号使所有旧回调失效。 */
  stopAll(channelFilter?: AudioChannel): number {
    if (channelFilter && this.activeChannel !== channelFilter) {
      return this.generation
    }
    this.generation += 1
    const playback = this.currentPlayback
    this.currentPlayback = null
    this.activeChannel = null
    this.speakingMessageId = null
    if (playback) {
      try {
        playback.stop()
      } catch {
        // 停止异常不影响总线状态清理
      }
    }
    this.emit()
    return this.generation
  }

  /** 独占通道播报一段文本，自动停止任何已有音频，返回本次播报是否正常完成。 */
  async play(
    text: string,
    options: AudioBusPlayOptions,
  ): Promise<{ completed: boolean; generation: number }> {
    const trimmed = text.trim()
    if (!trimmed) {
      return { completed: true, generation: this.generation }
    }

    const token = this.stopAll()
    const playback = playTts(trimmed, { speed: options.speed })

    // 二次校验：防止同步阶段被更高优先级中断抢占
    if (this.generation !== token) {
      playback.stop()
      return { completed: false, generation: token }
    }

    this.currentPlayback = playback
    this.activeChannel = options.channel
    this.speakingMessageId = options.messageId ?? null
    this.emit()

    void playback.started.then(() => {
      if (this.generation !== token) {
        playback.stop()
        return
      }
      options.onStarted?.()
    })

    try {
      await playback.finished
      const completed = this.generation === token
      return { completed, generation: token }
    } finally {
      if (this.currentPlayback === playback) {
        this.currentPlayback = null
        this.activeChannel = null
        this.speakingMessageId = null
        this.emit()
      }
    }
  }
}

export const audioBus = new AudioBus()
