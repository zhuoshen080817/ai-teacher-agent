import { useEffect, useMemo, useRef, useState } from 'react'

interface BoardTrigger {
  key: number
  trigger: string
}

interface DynamicBoardProps {
  htmlCode: string
  trigger: BoardTrigger | null
  segmentIndex: number
  focusLabel?: string
  isActive?: boolean
  label?: string
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
  ::selection { background: rgba(243, 201, 105, 0.25); }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.12);
    border-radius: 999px;
  }
`

const RUNTIME = `
  (function () {
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
      // 线段动画兜底：模型常忘写 is-active 时的 dashoffset: 0
      if (node.hasAttribute && node.hasAttribute('stroke-dasharray')) {
        node.style.strokeDashoffset = '0';
      }
    }
    function revealAll() {
      document.body.classList.add('is-active');
      Array.prototype.forEach.call(
        document.querySelectorAll('body *'),
        reveal
      );
    }
    function play(raw) {
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
        return;
      }
      nodes.forEach(function (node, index) {
        window.setTimeout(function () {
          activate(node);
        }, index * 120);
      });
      // 模型偶尔漏写 .is-active 动画样式，动画后兜底展开，避免板书空白
      window.setTimeout(function () {
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
      }, 1500);
    }
    window.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type === 'board:play') play(data.trigger);
    });
  })();
`

function buildSrcDoc(htmlCode: string) {
  const safeHtml = htmlCode
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]+Content-Security-Policy[^>]*>/gi, '')
  const csp =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'style-src \'unsafe-inline\'; img-src data:; font-src data:; ' +
    'script-src \'unsafe-inline\';">'
  const head = `<meta charset="utf-8">${csp}<style>${BASE_STYLE}</style>`
  const runtime = `<script>${RUNTIME}</script>`

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

export default function DynamicBoard({
  htmlCode,
  trigger,
  segmentIndex,
  focusLabel,
  isActive = false,
  label,
}: DynamicBoardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const srcDoc = useMemo(() => buildSrcDoc(htmlCode), [htmlCode])

  useEffect(() => {
    setReady(false)
  }, [srcDoc])

  useEffect(() => {
    if (!ready || !trigger) return
    const frame = iframeRef.current
    if (!frame?.contentWindow) return

    frame.contentWindow.postMessage(
      { type: 'board:play', trigger: trigger.trigger },
      '*',
    )
  }, [ready, trigger])

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
            {label ?? `第 ${segmentIndex + 1} 段`}
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] text-slate-300">
            HTML 动画
          </span>
        </div>
      </div>

      <iframe
        ref={iframeRef}
        title="李老师的动态板书"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        onLoad={() => setReady(true)}
        className="h-[440px] w-full border-0 bg-[#0f1114] lg:h-[500px]"
      />
    </div>
  )
}
