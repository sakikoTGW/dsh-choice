/**
 * dsh-choice — 把「给用户留选择」的收尾变成 DSH 原生的选择卡。
 *
 * 识别：助手一条消息的最后是一个 2–4 项的 Markdown 列表时，认为它在让用户
 * 做选择（也识别「要么 A，要么 B」「A 也行；B 也行」「A 还是 B？」这类短句）。
 *
 * 呈现：回合正常结束后，插件调用 `ctx.userQuestions.ask()`，由 DSH 自带的
 * 提问卡接管输入框，把选项渲染成可点按钮，并额外给一个「先看看，待会再做」。
 * 用户选中后，选项原文作为一条用户消息发出；选「先看看」或关掉卡片则什么都不发。
 *
 * 不写任何客户端代码：弹卡是宿主能力，插件只负责“识别 + 提问 + 投递”。
 *
 * @module @local/dsh-choice
 */

import { randomUUID } from 'node:crypto'

export const name = 'dsh-choice'
export const inject = ['systemPrompt', 'userQuestions', 'agents']

const MAX_OPTIONS = 4
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/

const DECLINE_ZH = '先看看，待会再做'
const DECLINE_EN = 'Later, revisit this'

/**
 * Choice cues: a trailing list only becomes a card when the paragraph before it
 * reads like asking the user to decide. Without this, every "下一步 1/2/3" list
 * popped a card — the plugin was choosing for the model instead of the reverse.
 */
const CHOICE_CUE =
  /(要不要|是不是|是否|选哪|哪一?个|哪一?种|哪一?套|哪条|哪一边|二选一|选一个|挑一个|你来定|你定|怎么定|定一下|你选|由你选|你挑|两条路|三条路|几种走法|几个方向|选项)/
const QUESTION_END = /[？?]\s*$/

const PROMPT_SECTION = [
  '只在用户这条消息确实是在让你拍板时（他在问选哪个 / 要不要继续 / 用哪种），才在消息最后用一个 Markdown 列表列出 2–4 个候选：',
  '每项一行、不超过约 20 字、写成用户口吻的可执行请求（例如「装 dsh-steer」「保留现在的插件」「先不动，我再想想」）。',
  '普通总结、下一步建议、步骤清单一律不要用这种候选列表收尾；没有真正需要用户选择的时候不要加。',
  'When the user is genuinely asking you to decide something this turn, finish with a 2–4 item Markdown list phrased as the user\'s own request;',
  'never use that list shape for summaries, next steps, or plans when there is no real choice.',
].join(' ')

const LIST_ITEM = /^\s*(?:[-*+•·]|\d{1,2}\s*[.)、:]|[（(]\d{1,2}[)）]|[①②③④⑤⑥])\s+(.+?)\s*$/

/**
 * Whether a piece of text reads like a request for the user to decide.
 * @param {string} text - a user message or the paragraph before a trailing list.
 * @returns {boolean} true when it carries a choice cue or ends with a question.
 */
export function choiceCue(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  const line = text.replace(/\s+/g, ' ').trim()
  return CHOICE_CUE.test(line) || QUESTION_END.test(line)
}


/** Strip inline Markdown so a choice reads as plain text. */
function plain(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function acceptable(label) {
  return label.length >= 2 && label.length <= 60
}

/**
 * Read the trailing Markdown list of one assistant message, if it is a choice.
 * The list only counts when the paragraph right before it asks the user to decide;
 * a bare "下一步 1/2/3" list must stay a plain list.
 * @param {readonly string[]} lines - message lines.
 * @returns {string[]} 2–4 option labels, or an empty array.
 */
function trailingList(lines) {
  let end = lines.length - 1
  while (end >= 0 && lines[end].trim() === '') end--
  const items = []
  let index = end
  for (; index >= 0; index--) {
    const line = lines[index]
    if (line.trim() === '') break
    const match = LIST_ITEM.exec(line)
    if (match === null) break
    items.unshift(plain(match[1]))
  }
  if (items.length < 2 || items.length > MAX_OPTIONS || !items.every(acceptable)) return []
  // Walk back over blank lines to the paragraph that introduced the list.
  let cursor = index
  while (cursor >= 0 && lines[cursor].trim() === '') cursor--
  if (cursor < 0) return []
  const paragraph = []
  while (cursor >= 0 && lines[cursor].trim() !== '') {
    paragraph.unshift(lines[cursor].trim())
    cursor--
  }
  return choiceCue(paragraph.join(' ')) ? items : []
}

/**
 * Read an explicit two-way alternative from the last paragraph.
 * @param {string} text - complete assistant message text.
 * @returns {string[]} two option labels, or an empty array.
 */
function inlinePair(text) {
  const paragraph = text.trim().split(/\n{2,}/).pop() ?? ''
  const line = paragraph.replace(/\s+/g, ' ').trim()
  const shapes = [
    /要么\s*(.+?)\s*[，,；;]\s*要么\s*(.+?)\s*[。.?？]?$/,
    /(.+?)\s*也行\s*[，,；;]\s*(.+?)\s*也行\s*[。.?？]?$/,
  ]
  for (const shape of shapes) {
    const match = shape.exec(line)
    if (match === null) continue
    const pair = [plain(match[1]), plain(match[2])]
    if (pair.every(acceptable)) return pair
  }
  if (/[？?]\s*$/.test(line) && /(你|您)/.test(line)) {
    const match = /(.{2,60}?)\s*还是\s*(.{2,60}?)\s*[？?]\s*$/.exec(line)
    if (match !== null) {
      const pair = [plain(match[1]), plain(match[2])]
      if (pair.every(acceptable)) return pair
    }
  }
  return []
}

/**
 * Extract user-selectable options from one assistant message.
 * @param {string} text - concatenated text blocks of the assistant message.
 * @returns {string[]} 0, 2, 3, or 4 option labels.
 */
export function extractChoices(text) {
  if (typeof text !== 'string' || text.trim() === '') return []
  const lines = text.replace(/\r/g, '').split('\n')
  const listed = trailingList(lines)
  if (listed.length > 0) return listed
  return inlinePair(text)
}

/** Concatenate the text blocks of one assistant message; empty when it carries a tool call. */
function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  if (content.some((block) => block?.type === 'tool-call')) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** Concatenate the text blocks of one user message; empty when it carries none. */
function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * Build the native question for one choice ending.
 * @param {readonly string[]} labels - extracted option labels.
 * @returns {{ questions: object[] }} request payload for `ctx.userQuestions.ask`.
 */
export function choiceQuestion(labels) {
  const cjk = CJK.test(labels.join(' '))
  const decline = cjk ? DECLINE_ZH : DECLINE_EN
  return {
    questions: [
      {
        id: 'choice',
        header: cjk ? '选择' : 'Choose',
        question: cjk ? '接下来怎么做？' : 'What next?',
        options: [
          ...labels.map((label) => ({ label })),
          {
            label: decline,
            description: cjk ? '不发消息，只收起这张卡。' : 'Sends nothing; just closes this card.',
          },
        ],
      },
    ],
  }
}

/**
 * Register the choice behavior.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  /** Session id → labels extracted from this turn's final assistant message. */
  const offers = new Map()
  /** Session id → the abort controller of a question still waiting for an answer. */
  const pending = new Map()
  /** Session id → whether the user's latest message asks this agent to decide something. */
  const wantsChoice = new Map()

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'dsh-choice/offer-options',
      order: 9100,
      // Only remind the model about the option-list shape on turns where the user
      // actually asks for a decision. A standing every-turn reminder made the model
      // end every reply with a list, which then popped a card every turn.
      text: (context) => {
        const id = context?.agent?.id
        return id !== undefined && wantsChoice.get(id) === true ? PROMPT_SECTION : ''
      },
    }),
  )

  const cancel = (sessionId) => {
    offers.delete(sessionId)
    const controller = pending.get(sessionId)
    if (controller !== undefined) {
      pending.delete(sessionId)
      controller.abort()
    }
  }

  const deliver = (agent, text) => {
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: `dsh-choice-${randomUUID()}` },
    }
    if (agent.status === 'running') agent.steer(message)
    else agent.followup(message)
  }

  const offer = async (sessionId, labels) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    const controller = new AbortController()
    pending.set(sessionId, controller)
    const request = choiceQuestion(labels)
    const decline = request.questions[0].options.at(-1).label
    try {
      const answer = await ctx.userQuestions.ask({ ...request, agent, signal: controller.signal })
      if (pending.get(sessionId) === controller) pending.delete(sessionId)
      if (controller.signal.aborted) return
      const item = answer?.answers?.find((entry) => entry.id === 'choice')
      const selected = item?.custom?.trim() || item?.selected?.[0]
      if (selected === undefined || selected === '' || selected === decline) return
      deliver(agent, selected)
    } catch {
      if (pending.get(sessionId) === controller) pending.delete(sessionId)
    }
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session.id
    if (event.type === 'assistant/message') {
      if (event.data?.interrupted === true) return
      const labels = extractChoices(assistantText(event.data?.message))
      if (labels.length >= 2) offers.set(sessionId, labels)
      else offers.delete(sessionId)
      return
    }
    if (event.type === 'turn/end') {
      if (event.data?.reason?.kind !== 'completed') {
        offers.delete(sessionId)
        return
      }
      const labels = offers.get(sessionId)
      offers.delete(sessionId)
      if (labels !== undefined) void offer(sessionId, labels)
      return
    }
    if (event.type === 'turn/start') {
      cancel(sessionId)
      return
    }
    if (event.type === 'user/message') {
      const text = messageText(event.data?.message ?? event.data)
      if (text.trim() !== '') wantsChoice.set(sessionId, choiceCue(text))
      if (event.data?.source?.kind === 'user') cancel(sessionId)
      return
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    wantsChoice.delete(agent.id)
    cancel(agent.id)
  })
}
