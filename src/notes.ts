// Talking points + voice commands. Kyle-only panel, never drawn on the canvas. Persisted in localStorage.

const KEY = 'onair.notes.v2'

export const DEFAULT_NOTES = {
  beats: [
    '[1 Hook] To camera, first second: "I told my laptop, take me somewhere tranquil. Watch."',
    '[3 Tall PiP] Say the wish live: "Take me somewhere tranquil. I want to relax." Let the lake build. I never asked for a dock or fireflies.',
    '[3 Tall PiP → 5 World] "Make it night, and fill the sky with floating lanterns." Cut to full world as they rise; hold 3 s. The holy-shit beat.',
    '[2 Stack] Three waves that happened separately: personalization (feeds rank a catalog), immersion (VR, but someone builds every world by hand), generative AI (understands intent and makes things, so there is no catalog).',
    '[4 Bubble] Put them together: a world that knows what you want, builds it on the spot, and puts you inside it. North star: it should feel like you have a genie.',
    '[2 Stack, S to swap] The missing piece is you. It does not know you yet, but your assistant does. One paragraph of who you are, and "somewhere I\'d love" has something real to work from.',
    '[1 Hook] Get it right: learn who you are on a good day, not what you click at 1 a.m. Otherwise it is a casino with good lighting.',
    '[1 Hook → 4 Bubble] The ask: open Voice World in desktop Chrome and ask it to take you somewhere tranquil. Tell me where it took you.',
  ],
  commands: [
    'Take me somewhere tranquil. I want to relax.',
    'Make it night, and fill the sky with floating lanterns.',
    'Take me to a medieval castle courtyard.',
    'A whale swimming through the sky.',
    'Make it night with the northern lights and two moons.',
    'A dragon circling the mountain. → Make it a stormy evening with lightning.',
    'Put a baker right in front of me. → Hello, who are you?',
    'Make me a giant. / Shrink me to the size of an ant.',
    'A vintage hot air balloon floating in front of me.',
    'Take me to a neon city street at night.',
  ],
}
type Notes = typeof DEFAULT_NOTES

function load(): Notes {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_NOTES, ...JSON.parse(raw) }
  } catch {}
  return structuredClone(DEFAULT_NOTES)
}

export function mountNotes(root: HTMLElement) {
  let notes = load()
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(notes)) } catch {} }

  const renderList = (key: keyof Notes, title: string, ordered: boolean) => {
    const sec = document.createElement('section')
    sec.className = 'notes-sec'
    sec.innerHTML = `<h3>${title}</h3>`
    const list = document.createElement(ordered ? 'ol' : 'ul')
    notes[key].forEach((text, i) => {
      const li = document.createElement('li')
      const body = document.createElement('div')
      body.className = 'note'
      body.contentEditable = 'plaintext-only'
      body.textContent = text
      body.addEventListener('input', () => { notes[key][i] = body.textContent ?? ''; save() })
      body.addEventListener('blur', () => { if (!body.textContent?.trim()) { notes[key].splice(i, 1); save(); draw() } })
      const del = document.createElement('button')
      del.className = 'icon'
      del.title = 'Remove'
      del.textContent = '×'
      del.onclick = () => { notes[key].splice(i, 1); save(); draw() }
      li.append(body, del)
      list.append(li)
    })
    const add = document.createElement('button')
    add.className = 'ghost small'
    add.textContent = '+ Add'
    add.onclick = () => {
      notes[key].push('New item')
      save()
      draw()
      const items = root.querySelectorAll<HTMLElement>(`[data-k="${key}"] .note`)
      const last = items[items.length - 1]
      last?.focus()
      if (last) getSelection()?.selectAllChildren(last)
    }
    sec.dataset.k = key
    sec.append(list, add)
    return sec
  }

  const draw = () => {
    root.replaceChildren(
      renderList('beats', 'Talking points', true),
      renderList('commands', 'Voice commands to try', false),
    )
    const reset = document.createElement('button')
    reset.className = 'ghost small'
    reset.textContent = 'Reset to defaults'
    reset.onclick = () => { if (confirm('Replace your notes with the defaults?')) { notes = structuredClone(DEFAULT_NOTES); save(); draw() } }
    root.append(reset)
  }
  draw()
}
