import { useEffect, useMemo, useState } from 'react'
import mermaid from 'mermaid'
import MarkdownView from './MarkdownView'

const MERMAID_STARTERS = [
  'flowchart',
  'graph',
  'mindmap',
  'sequenceDiagram',
  'classDiagram',
  'stateDiagram',
  'erDiagram',
  'gantt',
  'pie',
  'journey',
  'timeline',
  'gitGraph',
  'quadrantChart',
  'requirementDiagram',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'architecture-beta',
  'packet-beta',
  'C4Context',
]

const C_KEYWORDS = [
  'int',
  'float',
  'double',
  'char',
  'void',
  'long',
  'short',
  'unsigned',
  'signed',
  'const',
  'static',
  'struct',
  'union',
  'typedef',
  'enum',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'sizeof',
  'include',
  'define',
  'printf',
  'scanf',
  'malloc',
  'free',
  'NULL',
  'true',
  'false',
  'class',
  'public',
  'private',
  'protected',
  'new',
  'delete',
  'using',
  'namespace',
  'std',
]

const PYTHON_KEYWORDS = [
  'def',
  'class',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'in',
  'not',
  'and',
  'or',
  'import',
  'from',
  'as',
  'try',
  'except',
  'finally',
  'with',
  'lambda',
  'yield',
  'global',
  'nonlocal',
  'pass',
  'break',
  'continue',
  'None',
  'True',
  'False',
  'self',
  'print',
  'len',
  'range',
  'list',
  'dict',
  'set',
  'tuple',
]

const LANGUAGE_LABELS: Record<string, string> = {
  c: 'C',
  cpp: 'C++',
  'c++': 'C++',
  python: 'Python',
  py: 'Python',
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  java: 'Java',
  sql: 'SQL',
  bash: 'Bash',
  shell: 'Shell',
  go: 'Go',
  rust: 'Rust',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
}

let mermaidInitialized = false

function ensureMermaid() {
  if (mermaidInitialized) return

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'dark',
    fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    themeVariables: {
      background: 'transparent',
      primaryColor: '#1a1c20',
      primaryTextColor: '#e4e4e7',
      primaryBorderColor: '#4b5563',
      lineColor: '#6b7280',
      secondaryColor: '#16181c',
      tertiaryColor: '#141619',
      mainBkg: '#1a1c20',
      nodeBorder: '#4b5563',
      clusterBkg: '#16181c',
      clusterBorder: '#2b2f36',
      edgeLabelBackground: '#16181c',
      titleColor: '#e4e4e7',
    },
    flowchart: { curve: 'basis', padding: 12 },
    mindmap: { padding: 8 },
  })

  mermaidInitialized = true
}

type BoardContent =
  | { kind: 'mermaid'; code: string }
  | { kind: 'code'; code: string; language: string }
  | { kind: 'text'; lines: string[] }

function looksLikeMermaid(code: string) {
  const firstLine = code
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'))

  if (!firstLine) return false
  return MERMAID_STARTERS.some((starter) => firstLine.startsWith(starter))
}

function quoteMermaidLabel(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return '""'
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed
  return `"${trimmed.replace(/"/g, "'").replace(/\r?\n/g, ' ')}"`
}

/** 给 flowchart / graph 中未加引号的节点文本补上双引号。 */
function sanitizeFlowchartLabels(code: string) {
  let result = code

  // 长形状优先处理，避免被后面的简单括号规则误匹配
  result = result.replace(
    /([A-Za-z0-9_]+)\[\(([^()\n]*?)\)\]/g,
    (_, id: string, text: string) => `${id}([${quoteMermaidLabel(text)}])`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\[\(([^\[\]\n]*?)\)\]/g,
    (_, id: string, text: string) => `${id}[(${quoteMermaidLabel(text)})]`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\[\[([^\[\]\n]*?)\]\]/g,
    (_, id: string, text: string) => `${id}[[${quoteMermaidLabel(text)}]]`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\(\(([^()\n]*?)\)\)/g,
    (_, id: string, text: string) => `${id}((${quoteMermaidLabel(text)}))`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\{\{([^{}\n]*?)\}\}/g,
    (_, id: string, text: string) => `${id}{{${quoteMermaidLabel(text)}}}`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\[([^\[\]\n]*?)\]/g,
    (_, id: string, text: string) => `${id}[${quoteMermaidLabel(text)}]`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\(([^()\n]*?)\)/g,
    (_, id: string, text: string) => `${id}(${quoteMermaidLabel(text)})`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)\{([^{}\n]*?)\}/g,
    (_, id: string, text: string) => `${id}{${quoteMermaidLabel(text)}}`,
  )
  result = result.replace(
    /([A-Za-z0-9_]+)>([^\]\n]*?)\]/g,
    (_, id: string, text: string) => `${id}>${quoteMermaidLabel(text)}]`,
  )

  // 边标签 |文本| 也补引号
  result = result.replace(/\|([^|\n]+?)\|/g, (match, text: string) => {
    const trimmed = text.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return match
    return `|${quoteMermaidLabel(trimmed)}|`
  })

  return result
}

/** mindmap 中裸露的方括号/花括号改成全角字符，避免被解析成形状语法。 */
function sanitizeMindmap(code: string) {
  return code
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)(.*)$/)
      if (!match) return line

      const indent = match[1]
      const body = match[2]
      const trimmed = body.trim()
      if (
        !trimmed ||
        /^(mindmap|%%|classDef|style|direction)\b/i.test(trimmed) ||
        /^(\(\(|\(|\[\[|\[|\)\)|\{\{|>)/.test(trimmed)
      ) {
        return line
      }

      return `${indent}${body
        .replace(/\[/g, '［')
        .replace(/\]/g, '］')
        .replace(/\{/g, '｛')
        .replace(/\}/g, '｝')}`
    })
    .join('\n')
}

function sanitizeMermaid(code: string) {
  const trimmed = code.trim()
  if (/^mindmap\b/i.test(trimmed)) {
    return sanitizeMindmap(trimmed)
  }
  if (/^(flowchart|graph)\b/i.test(trimmed)) {
    return sanitizeFlowchartLabels(trimmed)
  }
  return trimmed
}

function guessCodeLanguage(code: string) {
  if (/^#include|int\s+main\s*\(|printf\s*\(/m.test(code)) return 'c'
  if (/^(def|class)\s+\w+|print\s*\(/m.test(code)) return 'python'
  return ''
}

function detectBoardContent(raw: string): BoardContent {
  const content = raw.trim()
  if (!content) return { kind: 'text', lines: [] }

  const fence = content.match(
    /```([A-Za-z0-9_+#.-]*)[ \t]*\r?\n([\s\S]*?)```/,
  )

  if (fence) {
    const language = fence[1].toLowerCase()
    const code = fence[2].trim()

    if (language === 'mermaid' || language === 'mmd' || looksLikeMermaid(code)) {
      return { kind: 'mermaid', code }
    }

    return { kind: 'code', code, language: language || 'text' }
  }

  if (looksLikeMermaid(content)) {
    return { kind: 'mermaid', code: content }
  }

  const guessed = guessCodeLanguage(content)
  if (guessed) {
    return { kind: 'code', code: content, language: guessed }
  }

  return {
    kind: 'text',
    lines: content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  }
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function highlightCode(raw: string, language: string) {
  const escaped = escapeHtml(raw)
  const isPython = language === 'python' || language === 'py'
  const keywords = isPython ? PYTHON_KEYWORDS : C_KEYWORDS
  const keywordPattern = keywords.join('|')

  const commentPattern = isPython
    ? String.raw`#[^\n]*`
    : String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`
  const stringPattern = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`

  const pattern = new RegExp(
    `(${commentPattern})|(${stringPattern})|(\\b(?:${keywordPattern})\\b)|(\\b\\d+(?:\\.\\d+)?\\b)`,
    'g',
  )

  return escaped.replace(
    pattern,
    (match, comment, string, keyword, number) => {
      if (comment) return `<span class="tok-comment">${comment}</span>`
      if (string) return `<span class="tok-string">${string}</span>`
      if (keyword) return `<span class="tok-keyword">${keyword}</span>`
      if (number) return `<span class="tok-number">${number}</span>`
      return match
    },
  )
}

function highlightMermaidSource(raw: string) {
  return escapeHtml(raw)
    .replace(
      /(--&gt;|--&gt;|-->|-\.-&gt;|==&gt;|--x|--o)/g,
      '<span class="tok-arrow">$1</span>',
    )
    .replace(
      /\b(flowchart|graph|mindmap|sequenceDiagram|classDiagram|stateDiagram|erDiagram|subgraph|end)\b/g,
      '<span class="tok-keyword">$1</span>',
    )
    .replace(/(\|[^|\n]*\|)/g, '<span class="tok-string">$1</span>')
}

function languageLabel(language: string) {
  return LANGUAGE_LABELS[language.toLowerCase()] ?? (language || '代码')
}

interface LectureBoardProps {
  content: string
  segmentIndex: number
  isActive?: boolean
  highlightLines?: number[]
  focusLabel?: string
}

function LectureBoard({
  content,
  segmentIndex,
  isActive = false,
  highlightLines,
  focusLabel,
}: LectureBoardProps) {
  const parsed = useMemo(() => detectBoardContent(content), [content])
  const [svg, setSvg] = useState('')
  const [renderError, setRenderError] = useState('')
  const highlightedLines = useMemo(
    () =>
      new Set(
        (highlightLines ?? []).filter(
          (line) => Number.isFinite(line) && line > 0,
        ),
      ),
    [highlightLines],
  )

  useEffect(() => {
    if (parsed.kind !== 'mermaid') return

    let alive = true
    const idBase = `lecture-mermaid-${Math.random().toString(36).slice(2, 10)}`

    ensureMermaid()
    setSvg('')
    setRenderError('')

    const candidates = [parsed.code, sanitizeMermaid(parsed.code)].filter(
      (code, index, list) => list.indexOf(code) === index,
    )

    async function renderMermaid() {
      for (let index = 0; index < candidates.length; index += 1) {
        if (!alive) return

        const id = `${idBase}-${index}`
        try {
          const result = await mermaid.render(id, candidates[index])
          if (!alive) return
          setSvg(result.svg)
          setRenderError('')
          return
        } catch {
          document.getElementById(id)?.remove()
          document.getElementById(`d${id}`)?.remove()
        }
      }

      if (!alive) return
      setSvg('')
      setRenderError('图表语法无法自动修复，已为你优化为源码板书')
    }

    void renderMermaid()

    return () => {
      alive = false
    }
  }, [parsed])

  const badge =
    parsed.kind === 'mermaid'
      ? 'Mermaid 图表'
      : parsed.kind === 'code'
        ? `${languageLabel(parsed.language)} 代码`
        : '板书要点'

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
        <div className="flex items-center gap-2">
          {focusLabel && (
            <span className="max-w-[220px] truncate rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
              {focusLabel}
            </span>
          )}
          <span className="text-[11px] text-slate-500">
            第 {segmentIndex + 1} 段
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
            {badge}
          </span>
        </div>
      </div>

      <div className="max-h-[560px] min-h-[420px] overflow-auto p-5 lg:p-6">
        {parsed.kind === 'mermaid' &&
          (svg ? (
            <div
              className="board-mermaid flex min-h-[340px] items-center justify-center"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div>
              {renderError ? (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-200/15 bg-amber-200/[0.04] px-3 py-2 text-xs text-amber-100/80">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-200/70" />
                  {renderError}
                </div>
              ) : (
                <p className="mb-3 text-xs text-slate-500">正在渲染图表…</p>
              )}
              <pre className="board-code rounded-xl border border-white/10 bg-black/20 p-3">
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlightMermaidSource(
                      sanitizeMermaid(parsed.code),
                    ),
                  }}
                />
              </pre>
            </div>
          ))}

        {parsed.kind === 'code' && (
          <div className="board-code">
            {parsed.code.split('\n').map((line, index) => {
              const isHighlighted = highlightedLines.has(index + 1)

              return (
                <div
                  key={`code-line-${index}`}
                  className={`flex gap-3 rounded px-2 py-0.5 transition-colors ${
                    isHighlighted ? 'board-line-highlight' : ''
                  }`}
                >
                  <span
                    className={`w-7 shrink-0 select-none text-right ${
                      isHighlighted ? 'text-slate-200' : 'text-slate-600'
                    }`}
                  >
                    {index + 1}
                  </span>
                  <code
                    className="min-w-0 whitespace-pre"
                    dangerouslySetInnerHTML={{
                      __html:
                        highlightCode(line, parsed.language) || '&nbsp;',
                    }}
                  />
                </div>
              )
            })}
          </div>
        )}

        {parsed.kind === 'text' &&
          (parsed.lines.length > 0 ? (
            <div className="board-markdown">
              <MarkdownView content={content} variant="dark" />
            </div>
          ) : (
            <p className="text-sm text-slate-500">等待讲师书写板书…</p>
          ))}
      </div>
    </div>
  )
}

export default LectureBoard
