window.__ModuleLoader__.load({
  id: '@local/dsh-choice',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-choice'
    const CSS =
      '@keyframes dsh-choice-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
      '.dsh-choice-dock{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 16px 0;' +
      'animation:dsh-choice-in .16s ease-out}' +
      '@media (prefers-reduced-motion:reduce){.dsh-choice-dock{animation:none}}' +
      '.dsh-choice-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:2px}' +
      '.dsh-choice-chip{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);' +
      'color:var(--dsw-alias-label-primary);border-radius:999px;padding:6px 12px;font-size:13px;line-height:18px;' +
      'font-family:inherit;cursor:pointer;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'transition:background-color .1s,border-color .1s}' +
      '.dsh-choice-chip:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}' +
      '.dsh-choice-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.dsh-choice-later{border-style:dashed;background:transparent;color:var(--dsw-alias-label-secondary)}'

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshChoice = '1'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function ChoiceDock(props) {
      const sessionId = props.sessionId
      const t = props.t
      const [snapshot, setSnapshot] = React.useState(null)

      React.useEffect(() => {
        let disposed = false
        let timer = 0
        const load = async () => {
          try {
            const response = await fetch(
              '/dsh-choice/state?session=' + encodeURIComponent(String(sessionId)),
              { cache: 'no-store' },
            )
            if (!response.ok) return
            const next = await response.json()
            if (disposed) return
            setSnapshot((previous) =>
              previous !== null && previous.revision === next.revision ? previous : next,
            )
          } catch (error) {
            console.error('[dsh-choice] state read failed', error)
          }
        }
        load()
        timer = setInterval(load, 1200)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [sessionId])

      const options = snapshot !== null && Array.isArray(snapshot.options) ? snapshot.options : []
      if (options.length === 0) return null

      const hide = () => setSnapshot((previous) => ({ ...(previous || {}), options: [] }))

      const pick = async (option) => {
        hide()
        try {
          await fetch('/dsh-choice/pick', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: String(sessionId), optionId: option.id }),
          })
        } catch (error) {
          console.error('[dsh-choice] pick failed', error)
        }
      }

      const later = async () => {
        hide()
        try {
          await fetch('/dsh-choice/dismiss', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: String(sessionId) }),
          })
        } catch (error) {
          console.error('[dsh-choice] dismiss failed', error)
        }
      }

      return h(
        'div',
        { className: 'dsh-choice-dock', role: 'group', 'aria-label': t('title') },
        h('span', { className: 'dsh-choice-label' }, t('title')),
        options.map((option) =>
          h(
            'button',
            {
              key: option.id,
              type: 'button',
              className: 'dsh-choice-chip',
              title: option.label,
              onClick: () => pick(option),
            },
            option.label,
          ),
        ),
        h(
          'button',
          { type: 'button', className: 'dsh-choice-chip dsh-choice-later', onClick: later },
          t('later'),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'dsh-choice: styles')
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: { title: '选一个：', later: '先看看，待会再做' },
              en: { title: 'Pick one:', later: 'Later, revisit this' },
            }),
          'dsh-choice: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'choice', order: 30 }, (props) =>
            h(ChoiceDock, { ...props, t }),
          ),
        )
      },
    }
  },
})
