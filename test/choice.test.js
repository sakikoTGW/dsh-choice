import { test } from 'node:test'
import assert from 'node:assert/strict'

import { choiceCue, extractChoices } from '../index.js'

test('a trailing bullet list becomes options when the lead-in asks to decide', () => {
  const text = '两种都行，看你想要哪种。\n\n- 装 dsh-steer，用现成的\n- 保留 dsh-guide，接管主对话框'
  assert.deepEqual(extractChoices(text), ['装 dsh-steer，用现成的', '保留 dsh-guide，接管主对话框'])
})

test('a numbered list keeps its items and strips inline markup', () => {
  const text = '用哪个：\n1. **装** `dsh-steer`\n2. 保留现在的插件\n3. 先不动，我再想想'
  assert.deepEqual(extractChoices(text), ['装 dsh-steer', '保留现在的插件', '先不动，我再想想'])
})

test('a next-steps list without a choice cue is NOT a choice', () => {
  const text = '下一步：\n1. 装 dsh-steer\n2. 保留现在的插件\n3. 先不动，我再想想'
  assert.deepEqual(extractChoices(text), [])
})

test('a bullet list after a plain conclusion is NOT a choice', () => {
  const text = '已经装好了，收尾那两处改动重启后生效。\n\n- 重启一下\n- 看看日志'
  assert.deepEqual(extractChoices(text), [])
})

test('a list in the middle of the message is not a choice ending', () => {
  const text = '- 装 dsh-steer\n- 保留 dsh-guide\n\n就这两条路，你决定。'
  assert.deepEqual(extractChoices(text), [])
})

test('a single-item list is not a choice', () => {
  assert.deepEqual(extractChoices('可以：\n- 装 dsh-steer'), [])
})

test('more than four items is not treated as a choice', () => {
  const text = '选哪个？\n- 一\n- 二\n- 三\n- 四\n- 五'
  assert.deepEqual(extractChoices(text), [])
})

test('要么 A，要么 B', () => {
  assert.deepEqual(extractChoices('要么装 dsh-steer，要么保留现在的插件'), ['装 dsh-steer', '保留现在的插件'])
})

test('A 也行；B 也行', () => {
  assert.deepEqual(extractChoices('直接装 dsh-steer 也行；保留现在的插件也行'), ['直接装 dsh-steer', '保留现在的插件'])
})

test('A 还是 B？', () => {
  assert.deepEqual(extractChoices('你想用现成的还是自己维护这套？'), ['你想用现成的', '自己维护这套'])
})

test('a plain statement is not a choice', () => {
  assert.deepEqual(extractChoices('已经装好了，收尾那两处改动重启后生效。'), [])
})

test('a conclusion that happens to contain 还是 without a question is ignored', () => {
  assert.deepEqual(extractChoices('我还是保留了原来的写法，没有动它。'), [])
})

test('choiceCue only fires on genuine decision phrasing', () => {
  assert.equal(choiceCue('这两个方案选哪个？'), true)
  assert.equal(choiceCue('下一步：'), false)
  assert.equal(choiceCue('已经装好了。'), false)
  assert.equal(choiceCue('帮我修一下这个 bug'), false)
})
