import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Components } from 'react-markdown'

interface MarkdownViewProps {
  content: string
  /** dark 用于深色板书，light 用于笔记与聊天 */
  variant?: 'light' | 'dark'
}

export default function MarkdownView({
  content,
  variant = 'light',
}: MarkdownViewProps) {
  const dark = variant === 'dark'

  const bodyText = dark ? 'text-slate-100' : 'text-slate-700'
  const strongText = dark ? 'text-white' : 'text-slate-900'
  const headingText = dark ? 'text-white' : 'text-slate-900'
  const codeInline = dark
    ? 'bg-white/10 text-slate-100'
    : 'bg-slate-200/80 text-slate-800'
  const preBg = dark ? 'bg-black/50 text-slate-100' : 'bg-slate-800 text-slate-100'
  const quoteStyle = dark
    ? 'border-sky-400/50 bg-white/5 text-slate-300'
    : 'border-sky-300 bg-sky-50 text-slate-600'
  const hrColor = dark ? 'border-white/10' : 'border-slate-200'

  const components: Components = {
    h1: ({ children }) => (
      <h3 className={`mt-5 mb-3 text-xl font-semibold first:mt-0 ${headingText}`}>
        {children}
      </h3>
    ),
    h2: ({ children }) => (
      <h4 className={`mt-5 mb-2 text-lg font-semibold first:mt-0 ${headingText}`}>
        {children}
      </h4>
    ),
    h3: ({ children }) => (
      <h5 className={`mt-4 mb-1.5 text-base font-semibold first:mt-0 ${headingText}`}>
        {children}
      </h5>
    ),
    h4: ({ children }) => (
      <h6 className={`mt-3 mb-1 text-sm font-semibold first:mt-0 ${headingText}`}>
        {children}
      </h6>
    ),
    p: ({ children }) => (
      <p className={`my-2 text-sm leading-7 ${bodyText}`}>{children}</p>
    ),
    ul: ({ children }) => (
      <ul className={`my-3 list-disc space-y-1 pl-6 ${bodyText}`}>{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className={`my-3 list-decimal space-y-1 pl-6 ${bodyText}`}>
        {children}
      </ol>
    ),
    li: ({ children }) => (
      <li className={`text-sm leading-7 ${bodyText}`}>{children}</li>
    ),
    strong: ({ children }) => (
      <strong className={`font-semibold ${strongText}`}>{children}</strong>
    ),
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-sky-500 underline underline-offset-2"
      >
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={`my-3 border-l-4 px-4 py-2 text-sm leading-7 ${quoteStyle}`}
      >
        {children}
      </blockquote>
    ),
    hr: () => <hr className={`my-4 border-t ${hrColor}`} />,
    pre: ({ children }) => (
      <pre
        className={`my-3 overflow-x-auto rounded-lg p-3 text-xs leading-6 ${preBg}`}
      >
        {children}
      </pre>
    ),
    code: ({ className, children }) => {
      const isBlock =
        typeof className === 'string' && className.includes('language-')

      if (isBlock) {
        return <code className="font-mono">{children}</code>
      }

      return (
        <code
          className={`rounded px-1.5 py-0.5 font-mono text-[0.85em] ${codeInline}`}
        >
          {children}
        </code>
      )
    },
  }

  if (!content.trim()) {
    return <p className="text-sm text-slate-500">暂无内容</p>
  }

  return (
    <div className={dark ? 'text-slate-100' : 'text-slate-700'}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
