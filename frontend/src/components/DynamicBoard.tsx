import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'

export interface BoardTrigger {
  key: number
  trigger: string
  highlightLines?: number[]
}

export interface DynamicBoardProps {
  htmlCode: string
  trigger: BoardTrigger | null
  segmentIndex: number
  focusLabel?: string
  isActive?: boolean
  label?: string
  pptPage?: number | null
  highlightLines?: number[]
  fallbackText?: string
  onAnimationComplete?: (triggerKey: number) => void
  onRenderFallback?: (reason: string) => void
}

interface ValidationResult {
  valid: boolean
  reason: string
  plainLines: string[]
}

const BASE_STYLE = `
  html, body {
    margin: 0;
    min-height: 100%;
    background: transparent;
    color: #e4e4e7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  * { box-sizing: border-box; }
  body { padding: 26px 30px; overflow: auto; }
  pre, code {
    font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  }
  .board-code-line-highlight {
    background: rgba(243, 201, 105, 0.16) !important;
    border-left: 3px solid #f3c969 !important;
    padding-left: 8px !important;
    border-radius: 4px;
    transition: background 240ms ease;
  }
  ::selection { background: rgba(243, 201, 105, 0.25); }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
    border-radius: 999px;
  }
`

function extractPlainLines(htmlCode: string, fallbackText?: string): string[] {
  const withoutStyleAndScript = htmlCode
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '\n')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '\n')
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

  const lines = withoutStyleAndScript
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)

  if (lines.length > 0) return lines

  const fallback = (fallbackText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return fallback.length > 0 ? fallback : ['板书内容已转为文本模式展示。']
}

function hasBalancedCssBraces(css: string): boolean {
  let depth = 0
  let inSingle = false
  let inDouble = false
  let inComment = false

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    const next = css[i + 1]
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false
        i += 1
      }
      continue
    }
    if (!inSingle && !inDouble && ch === '/' && next === '*') {
      inComment = true
      i += 1
      continue
    }
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 1
      continue
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle
      continue
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0 && !inSingle && !inDouble && !inComment
}

/** 渲染前静态防御校验：拦截未闭合 style、严重 CSS 语法错乱或无可视内容的坏 HTML。 */
export function validateBoardHtml(
  htmlCode: string,
  fallbackText?: string,
): ValidationResult {
  const plainLines = extractPlainLines(htmlCode, fallbackText)
  const raw = (htmlCode || '').trim()
  if (!raw) {
    return { valid: false, reason: '板书 HTML 内容为空', plainLines }
  }

  const styleOpens = (raw.match(/<style\b[^>]*>/gi) ?? []).length
  const styleCloses = (raw.match(/<\/style\s*>/gi) ?? []).length
  if (styleOpens !== styleCloses) {
    return {
      valid: false,
      reason: '检测到未闭合的 <style> 标签',
      plainLines,
    }
  }

  const styleBlocks = raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)
  for (const match of styleBlocks) {
    if (!hasBalancedCssBraces(match[1] ?? '')) {
      return {
        valid: false,
        reason: '检测到板书 CSS 样式括号或注释语法异常',
        plainLines,
      }
    }
  }

  if (typeof DOMParser !== 'undefined') {
    try {
      const parser = new DOMParser()
      const doc = parser.parseFromString(raw, 'text/html')
      const body = doc.body
      const hasSvg = Boolean(body?.querySelector('svg'))
      const textContent = (body?.textContent ?? '').replace(/\s+/g, '').trim()
      if (!hasSvg && textContent.length === 0) {
        return {
          valid: false,
          reason: '解析后未发现可视文本或图形节点',
          plainLines,
        }
      }
    } catch {
      return {
        valid: false,
        reason: '浏览器 DOM 解析异常',
        plainLines,
      }
    }
  }

  return { valid: true, reason: '', plainLines }
}

function buildRuntime(boardId: string): string {
  const escapedId = JSON.stringify(boardId)
  return `
  (function () {
    var BOARD_ID = ${escapedId};
    var doneTimer = 0;

    function notify(type, extra) {
      try {
        var payload = { type: type, boardId: BOARD_ID };
        if (extra) {
          for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) {
              payload[key] = extra[key];
            }
          }
        }
        window.parent.postMessage(payload, '*');
      } catch (e) {}
    }

    window.onerror = function (msg) {
      notify('board:error', { reason: String(msg || '板书脚本运行异常') });
      return true;
    };
    window.addEventListener('unhandledrejection', function () {
      notify('board:error', { reason: '板书异步渲染异常' });
    });

    function reveal(node) {
      if (!node || !node.style) return;
      node.style.setProperty('opacity', '1', 'important');
      node.style.setProperty('transform', 'none', 'important');
      node.style.setProperty('filter', 'none', 'important');
      node.style.setProperty('clip-path', 'none', 'important');
      node.style.setProperty('visibility', 'visible', 'important');
      node.style.strokeDashoffset = '0';
      if (window.getComputedStyle(node).display === 'none') {
        node.style.setProperty('display', 'block', 'important');
      }
    }

    function activate(node) {
      node.classList.add('is-active');
      if (node.hasAttribute && node.hasAttribute('stroke-dasharray')) {
        node.style.strokeDashoffset = '0';
      }
    }

    function applyHighlightLines(lines) {
      Array.prototype.forEach.call(
        document.querySelectorAll('.board-code-line-highlight'),
        function (el) { el.classList.remove('board-code-line-highlight'); }
      );
      if (!Array.isArray(lines) || !lines.length) return;
      var set = {};
      lines.forEach(function (n) {
        var num = Number(n);
        if (Number.isFinite(num) && num > 0) set[num] = true;
      });
      var matched = 0;
      Array.prototype.forEach.call(
        document.querySelectorAll('[data-line]'),
        function (el) {
          var lineNo = Number(el.getAttribute('data-line'));
          if (set[lineNo]) {
            el.classList.add('board-code-line-highlight');
            matched += 1;
          }
        }
      );
      if (matched > 0) return;
      var codeLines = document.querySelectorAll('.code-line, pre code > span, pre > div');
      if (codeLines.length > 0) {
        Array.prototype.forEach.call(codeLines, function (el, idx) {
          if (set[idx + 1]) el.classList.add('board-code-line-highlight');
        });
      }
    }

    function hasVisibleContent() {
      var text = (document.body && document.body.innerText || '').trim();
      var svgs = document.querySelectorAll('svg');
      if (svgs.length > 0) {
        for (var i = 0; i < svgs.length; i += 1) {
          var rect = svgs[i].getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return true;
        }
      }
      if (!text) return false;
      var rect = document.body.getBoundingClientRect();
      return rect.height > 0;
    }

    function revealAll() {
      document.body.classList.add('is-active');
      Array.prototype.forEach.call(
        document.querySelectorAll('body *'),
        reveal
      );
    }

    function play(raw, triggerKey, highlightLines) {
      if (doneTimer) {
        window.clearTimeout(doneTimer);
        doneTimer = 0;
      }
      applyHighlightLines(highlightLines);

      var name = String(raw || 'reveal-1').replace(/[^A-Za-z0-9_-]/g, '');
      if (!name) name = 'reveal-1';
      var nodes = [];
      try {
        nodes = Array.prototype.slice.call(document.querySelectorAll('.' + name));
      } catch (error) {}
      if (!nodes.length) {
        nodes = Array.prototype.slice.call(
          document.querySelectorAll('[data-reveal]')
        );
      }
      if (!nodes.length) {
        revealAll();
        if (!hasVisibleContent()) {
          notify('board:error', { reason: '板书未渲染出可见内容' });
          return;
        }
        doneTimer = window.setTimeout(function () {
          notify('board:done', { triggerKey: triggerKey || 0 });
        }, 300);
        return;
      }

      nodes.forEach(function (node, index) {
        window.setTimeout(function () {
          activate(node);
        }, index * 120);
      });

      var settleMs = Math.min(2400, Math.max(900, nodes.length * 120 + 480));
      doneTimer = window.setTimeout(function () {
        var stuck = 0;
        nodes.forEach(function (node) {
          var style = window.getComputedStyle(node);
          if (
            style.opacity === '0' ||
            style.visibility === 'hidden' ||
            style.display === 'none'
          ) {
            stuck += 1;
            reveal(node);
          }
        });
        if (stuck === nodes.length) {
          document.body.classList.add('is-active');
        }
        if (!hasVisibleContent()) {
          notify('board:error', { reason: '板书动画执行后仍无可见内容' });
          return;
        }
        notify('board:done', { triggerKey: triggerKey || 0 });
      }, settleMs);
    }

    window.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type === 'board:play') {
        play(data.trigger, data.triggerKey, data.highlightLines);
      }
    });

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      notify('board:ready');
    } else {
      window.addEventListener('DOMContentLoaded', function () {
        notify('board:ready');
      });
    }
  })();
`
}

function buildSrcDoc(htmlCode: string, boardId: string) {
  const safeHtml = htmlCode
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]+Content-Security-Policy[^>]*>/gi, '')
  const csp =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    "style-src 'unsafe-inline'; img-src data:; font-src data:; " +
    'script-src \'unsafe-inline\';">'
  const head = `<meta charset="utf-8">${csp}<style>${BASE_STYLE}</style>`
  const runtime = `<script>${buildRuntime(boardId)}</script>`

  if (/<html[\s>]/i.test(safeHtml)) {
    let doc = safeHtml
    if (/<head[^>]*>/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1>${head}`)
    } else {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`)
    }
    if (/<\/body>/i.test(doc)) {
      doc = doc.replace(/<\/body>/i, `${runtime}</body>`)
    } else {
      doc += runtime
    }
    return doc
  }

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `${head}</head><body>${safeHtml}${runtime}</body></html>`
  )
}

interface BoardBoundaryProps {
  plainLines: string[]
  children: ReactNode
}

interface BoardBoundaryState {
  hasError: boolean
}

class BoardErrorBoundary extends Component<
  BoardBoundaryProps,
  BoardBoundaryState
> {
  state: BoardBoundaryState = { hasError: false }

  static getDerivedStateFromError(): BoardBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DynamicBoard] 渲染异常，已自动降级为纯文本板书', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[440px] space-y-2.5 bg-[#0f1114] p-6 text-sm leading-7 text-slate-200 lg:min-h-[500px]">
          <div className="mb-3 inline-flex items-center gap-2 rounded-lg border border-amber-200/20 bg-amber-200/10 px-3 py-1.5 text-xs text-amber-100">
            板书组件出现渲染异常，已自动切换为纯文本展示
          </div>
          {this.props.plainLines.map((line, index) => (
            <p key={`err-line-${index}`} className="whitespace-pre-wrap">
              {line}
            </p>
          ))}
        </div>
      )
    }
    return this.props.children
  }
}

export default function DynamicBoard({
  htmlCode,
  trigger,
  segmentIndex,
  focusLabel,
  isActive = false,
  label,
  pptPage,
  highlightLines,
  fallbackText,
  onAnimationComplete,
  onRenderFallback,
}: DynamicBoardProps) {
  const boardId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [runtimeFallbackReason, setRuntimeFallbackReason] = useState('')
  const [retrySeed, setRetrySeed] = useState(0)

  const validation = useMemo(
    () => validateBoardHtml(htmlCode, fallbackText),
    [htmlCode, fallbackText],
  )
  const srcDoc = useMemo(
    () => (validation.valid ? buildSrcDoc(htmlCode, boardId) : ''),
    [htmlCode, boardId, validation.valid],
  )

  const effectiveFallbackReason = !validation.valid
    ? validation.reason
    : runtimeFallbackReason

  const activeHighlightLines = useMemo(() => {
    const source =
      trigger?.highlightLines && trigger.highlightLines.length > 0
        ? trigger.highlightLines
        : highlightLines ?? []
    return source.filter((line) => Number.isFinite(line) && line > 0)
  }, [trigger, highlightLines])

  useEffect(() => {
    setReady(false)
    setRuntimeFallbackReason('')
  }, [srcDoc, retrySeed])

  useEffect(() => {
    if (!validation.valid) {
      onRenderFallback?.(validation.reason)
      if (trigger) {
        onAnimationComplete?.(trigger.key)
      }
    }
  }, [validation.valid, validation.reason, trigger, onRenderFallback, onAnimationComplete])

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      const data = event.data as
        | {
            type?: string
            boardId?: string
            triggerKey?: number
            reason?: string
          }
        | undefined
      if (!data || data.boardId !== boardId) return

      if (data.type === 'board:ready') {
        setReady(true)
      } else if (data.type === 'board:done') {
        if (typeof data.triggerKey === 'number' && data.triggerKey > 0) {
          onAnimationComplete?.(data.triggerKey)
        }
      } else if (data.type === 'board:error') {
        const reason = data.reason || '板书渲染异常'
        setRuntimeFallbackReason(reason)
        onRenderFallback?.(reason)
        if (trigger) {
          onAnimationComplete?.(trigger.key)
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [boardId, trigger, onAnimationComplete, onRenderFallback])

  useEffect(() => {
    if (effectiveFallbackReason) {
      if (trigger) {
        onAnimationComplete?.(trigger.key)
      }
      return
    }
    if (!ready || !trigger) return
    const frame = iframeRef.current
    if (!frame?.contentWindow) return

    frame.contentWindow.postMessage(
      {
        type: 'board:play',
        trigger: trigger.trigger,
        triggerKey: trigger.key,
        highlightLines: activeHighlightLines,
      },
      '*',
    )
  }, [
    ready,
    trigger,
    effectiveFallbackReason,
    activeHighlightLines,
    onAnimationComplete,
  ])

  return (
    <div
      className={`lecture-board overflow-hidden rounded-2xl border transition-colors duration-300 ${
        isActive ? 'border-white/25' : 'border-white/10'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/[0.02] px-4 py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isActive ? 'animate-pulse bg-slate-200' : 'bg-slate-500'
            }`}
          />
          Board · 动态板书
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {typeof pptPage === 'number' && pptPage > 0 && (
            <span className="rounded-full border border-amber-200/20 bg-amber-200/10 px-2 py-0.5 text-[11px] text-amber-100">
              PPT 第 {pptPage} 页
            </span>
          )}
          {activeHighlightLines.length > 0 && (
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
              高亮第 {activeHighlightLines.join(', ')} 行
            </span>
          )}
          {focusLabel && (
            <span className="max-w-[220px] truncate rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
              {focusLabel}
            </span>
          )}
          <span className="text-[11px] text-slate-500">
            {label ?? `第 ${segmentIndex + 1} 段`}
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
            {effectiveFallbackReason ? '纯文本兜底' : 'HTML 动画'}
          </span>
        </div>
      </div>

      <BoardErrorBoundary plainLines={validation.plainLines}>
        {effectiveFallbackReason ? (
          <div className="h-[440px] overflow-y-auto bg-[#0f1114] p-6 lg:h-[500px]">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200/20 bg-amber-200/[0.06] px-3.5 py-2 text-xs text-amber-100/90">
              <span>
                板书 HTML 渲染容错触发（{effectiveFallbackReason}
                ），已自动降级为纯文本板书
              </span>
              {validation.valid && (
                <button
                  type="button"
                  onClick={() => {
                    setRuntimeFallbackReason('')
                    setRetrySeed((prev) => prev + 1)
                  }}
                  className="rounded-full border border-amber-200/30 px-2.5 py-0.5 text-[11px] text-amber-100 transition hover:bg-amber-200/10"
                >
                  重试渲染
                </button>
              )}
            </div>
            <div className="space-y-3 text-base leading-8 text-slate-200">
              {validation.plainLines.map((line, index) => (
                <p
                  key={`fallback-line-${index}`}
                  className={`whitespace-pre-wrap rounded px-2 py-0.5 ${
                    activeHighlightLines.includes(index + 1)
                      ? 'border-l-2 border-[#f3c969] bg-[#f3c969]/10'
                      : ''
                  }`}
                >
                  {line}
                </p>
              ))}
            </div>
          </div>
        ) : (
          <iframe
            key={`${boardId}-${retrySeed}`}
            ref={iframeRef}
            title="李老师的动态板书"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            onLoad={() => setReady(true)}
            className="h-[440px] w-full border-0 bg-[#0f1114] lg:h-[500px]"
          />
        )}
      </BoardErrorBoundary>
    </div>
  )
}
