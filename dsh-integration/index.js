/**
 * DSH（DeepSeek Harness）插件入口：把课堂笔记后端的两个核心能力暴露为 Agent 工具。
 *
 * - analyze_lecture_audio：上传录音（可选 PPT）→ 轮询任务 → 返回 Markdown 笔记
 * - ask_ai_teacher：把问题与课堂上下文转给后端对话接口，返回李老师的解答
 *
 * 本文件不包含任何业务逻辑，只负责 DSH 工具声明；HTTP 细节见 ./lib/backend.js。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { analyzeLecture, askTeacher } from './lib/backend.js'

export const name = 'lecture-agent'

// 等待工具注册表就绪后再注册，DSH 会自动清理注册项
export const inject = ['tools']

const lectureNoteSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'number', required: true },
    subject: { type: 'string', required: true },
    filename: { type: 'string', required: true },
    note_markdown: { type: 'string', required: true },
    storyboard_segments: { type: 'number', required: true },
    audio_file: { type: 'string', required: true },
    ppt_file: { type: 'string', required: true },
  },
}

const teacherAnswerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string', required: true },
    subject: { type: 'string', required: true },
  },
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'analyze_lecture_audio',
      description:
        '将本地课堂录音（可选 PPT 课件）交给课堂笔记后端，自动完成上传、转码、' +
        '语音识别与 LLM 整理，等待任务结束后返回整理好的 Markdown 复习笔记。' +
        '当用户给出录音文件路径并要求整理、总结课堂内容时使用。' +
        '文件必须位于 DSH 进程可访问的本地磁盘；1 小时录音通常需要数分钟，' +
        '工具会阻塞等待，可用 timeout_seconds 控制上限。',
      parameters: {
        audio_path: {
          type: 'string',
          required: true,
          description:
            '课堂录音的本地路径，支持 mp3 / wav / m4a，绝对路径或相对当前工作目录',
        },
        ppt_path: {
          type: 'string',
          description: '可选：配套 PPT 课件路径（.pptx），用于提升代词消解与笔记质量',
        },
        subject: {
          type: 'string',
          description:
            '可选：课程名称，例如「数据结构」。不传时由后端根据 PPT / 转写自动识别',
        },
        timeout_seconds: {
          type: 'number',
          description:
            '可选：等待任务完成的上限秒数，默认 1800，允许范围 60–7200',
        },
      },
      output: {
        schema: lectureNoteSchema,
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `${value.note_markdown}\n\n---\n` +
              `> 任务 #${value.task_id}｜${value.subject}｜${value.filename}｜` +
              `分镜 ${value.storyboard_segments} 段`,
          },
        ],
      },
      async execute(args, exec) {
        return analyzeLecture({
          audioPath: args.audio_path,
          pptPath: args.ppt_path,
          subject: args.subject,
          timeoutSeconds: args.timeout_seconds,
          signal: exec.signal,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'ask_ai_teacher',
      description:
        '向 AI 私教「李老师」提问。适合询问课程概念、解释笔记内容、追问某个知识点，' +
        '或让老师结合当前课堂上下文答疑。回答由后端 DeepSeek 对话接口生成。' +
        '如果用户提供了正在学的步骤或笔记，请一并传入 context / note_context，' +
        '回答会更贴合当前课堂。',
      parameters: {
        question: {
          type: 'string',
          required: true,
          description: '学生的问题，例如「快速排序为什么要随机选基准值？」',
        },
        context: {
          type: 'string',
          description: '可选：当前课堂上下文，例如老师正在讲的这一步内容',
        },
        note_context: {
          type: 'string',
          description: '可选：当前复习笔记的 Markdown 内容，作为回答依据',
        },
        subject: {
          type: 'string',
          description: '可选：课程名称，默认「通用课程」',
        },
      },
      output: {
        schema: teacherAnswerSchema,
        render: (_args, value) => [{ type: 'text', text: value.answer }],
      },
      async execute(args, exec) {
        return askTeacher({
          question: args.question,
          context: args.context,
          noteContext: args.note_context,
          subject: args.subject,
          signal: exec.signal,
        })
      },
    }),
  )
}
