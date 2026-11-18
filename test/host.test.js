import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, choiceQuestion, extractChoices } from '../index.js'

/** Minimal Cordis-shaped host context with a controllable userQuestions.ask. */
function makeCtx(agent = { id: 's1', status: 'idle', calls: [] }) {
  const listeners = new Map()
  const sections = []
  const agents = new Map([['s1', agent]])
  const asks = []
  let resolveAsk = null
  const ctx = {
    sections,
    agents: { get: (id) => agents.get(id) },
    asks,
    effect(fn) {
      return fn()
    },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    userQuestions: {
      ask(request) {
        asks.push(request)
        return new Promise((resolve, reject) => {
          resolveAsk = resolve
          request.signal?.addEventListener('abort', () => reject(new Error('ASK_ABORTED')))
        })
      },
    },
    emit(name, payload) {
      for (const handler of listeners.get(name) ?? []) handler(...payload)
    },
  }
  return { ctx, answer: (value) => resolveAsk?.(value) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const CHOICE = '两条路，你定。\n\n- 装 dsh-steer\n- 保留 dsh-guide'

function session(id = 's1') {
  return { id }
}

function assistant(text, extra = {}) {
  return {
    type: 'assistant/message',
    seq: 10,
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra },
  }
}

function user(text) {
  return {
    type: 'user/message',
    seq: 9,
    data: { source: { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text }] } },
  }
}

const completed = { type: 'turn/end', seq: 11, data: { turn: 1, reason: { kind: 'completed' } } }

test('the option-list prompt only exists on decision turns', () => {
  const { ctx } = makeCtx()
  apply(ctx)
  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.name, 'dsh-choice/offer-options')
  assert.equal(section.text({ agent: { id: 's1' } }), '')

  ctx.emit('session/event', [session(), user('帮我修一下这个 bug')])
  assert.equal(section.text({ agent: { id: 's1' } }), '')

  ctx.emit('session/event', [session(), user('这两个方案选哪个？')])
  assert.match(section.text({ agent: { id: 's1' } }), /2–4 个候选/)

  assert.equal(section.text({ agent: { id: 'other' } }), '')
})

test('a next-steps list without a choice cue asks nothing', async () => {
  const { ctx } = makeCtx()
  apply(ctx)
  ctx.emit('session/event', [session(), assistant('下一步：\n1. 装 dsh-steer\n2. 保留现在的插件\n3. 先不动，我再想想')])
  ctx.emit('session/event', [session(), completed])
  await tick()
  assert.equal(ctx.asks.length, 0)
})

test('a completed turn ending in a list asks the native question', async () => {
  const { ctx } = makeCtx()
  apply(ctx)
  ctx.emit('session/event', [session(), assistant(CHOICE)])
  ctx.emit('session/event', [session(), completed])
  await tick()

  assert.equal(ctx.asks.length, 1)
  const question = ctx.asks[0].questions[0]
  assert.equal(question.id, 'choice')
  assert.deepEqual(
    question.options.map((option) => option.label),
    ['装 dsh-steer', '保留 dsh-guide', '先看看，待会再做'],
  )
})

test('choosing an option delivers it as a user message', async () => {
  const agent = { id: 's1', status: 'idle', calls: [], followup: (m) => agent.calls.push(m), steer: (m) => agent.calls.push(m) }
  const { ctx, answer } = makeCtx(agent)
  apply(ctx)
  ctx.emit('session/event', [session(), assistant(CHOICE)])
  ctx.emit('session/event', [session(), completed])
  await tick()

  answer({ answers: [{ id: 'choice', selected: ['装 dsh-steer'] }] })
  await tick()

  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0].role, 'user')
  assert.equal(agent.calls[0].content[0].text, '装 dsh-steer')
  assert.equal(agent.calls[0].source.kind, 'user')
})

test('the decline option sends nothing', async () => {
  const agent = { id: 's1', status: 'idle', calls: [], followup: (m) => agent.calls.push(m), steer: (m) => agent.calls.push(m) }
  const { ctx, answer } = makeCtx(agent)
  apply(ctx)
  ctx.emit('session/event', [session(), assistant(CHOICE)])
  ctx.emit('session/event', [session(), completed])
  await tick()

  answer({ answers: [{ id: 'choice', selected: ['先看看，待会再做'] }] })
  await tick()

  assert.equal(agent.calls.length, 0)
})

test('a free-text answer is delivered verbatim', async () => {
  const agent = { id: 's1', status: 'idle', calls: [], followup: (m) => agent.calls.push(m), steer: (m) => agent.calls.push(m) }
  const { ctx, answer } = makeCtx(agent)
  apply(ctx)
  ctx.emit('session/event', [session(), assistant(CHOICE)])
  ctx.emit('session/event', [session(), completed])
  await tick()

  answer({ answers: [{ id: 'choice', selected: [], custom: '两个都先别动，我来定' }] })
  await tick()

  assert.equal(agent.calls[0].content[0].text, '两个都先别动，我来定')
})

test('a tool-calling assistant message never offers a choice', async () => {
  const { ctx } = makeCtx()
  apply(ctx)
  ctx.emit('session/event', [
    session(),
    {
      type: 'assistant/message',
      seq: 12,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: CHOICE },
            { type: 'tool-call', id: 't1', name: 'pwsh', arguments: '{}' },
          ],
        },
      },
    },
  ])
  ctx.emit('session/event', [session(), completed])
  await tick()
  assert.equal(ctx.asks.length, 0)
})

test('an unfinished turn never asks', async () => {
  const { ctx } = makeCtx()
  apply(ctx)
  ctx.emit('session/event', [session(), assistant(CHOICE)])
  ctx.emit('session/event', [session(), { type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'aborted' } } }])
  await tick()
  assert.equal(ctx.asks.length, 0)
})

test('a new turn cancels a question still waiting for an answer', async () => {
  const agent = { id: 's1', status: 'idle', calls: [], followup: (m) => agent.calls.push(m), steer: (m) => agent.calls.push(m) }
  const { ctx } = makeCtx(agent)
  apply(ctx)
  ctx.emit('session/event', [session(), assistant(CHOICE)])
  ctx.emit('session/event', [session(), completed])
  await tick()
  assert.equal(ctx.asks.length, 1)

  ctx.emit('session/event', [session(), { type: 'turn/start', seq: 14, data: { turn: 2 } }])
  await tick()
  assert.equal(agent.calls.length, 0)
})

test('the English question keeps an English decline', () => {
  const question = choiceQuestion(['install dsh-steer', 'keep dsh-guide']).questions[0]
  assert.equal(question.options.at(-1).label, 'Later, revisit this')
})

test('the detector still rejects prose without a list or an explicit pair', () => {
  assert.deepEqual(extractChoices('我建议直接上现成的方案，这样最省事。'), [])
})
