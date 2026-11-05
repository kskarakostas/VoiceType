// End-to-end command mode: select text in a field, press the edit chord, say how to change it, and
// the selection is replaced. The stub answers the speech and the text model.
// Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, focusField, pillQuery, pillStatus, waitForPill, clickPill, indicatorShown,
  startWithHotkey, dictateWithHotkey, PORT, TRANSCRIPT, DUMMY_KEY, STOP, STATUS, MINI, RECORD_MS, REFINE_URL,
} from './helpers.js';
import { EDIT_INSTRUCTIONS } from '../../src/background/edit-prompt.js';

const EDITED = 'edited text';
const TWO_LINES = 'edited one\nedited two';
const EDIT_HOTKEY = 'Control+Shift+KeyE';
const SAY = 'Say how to change the selection.';
const SELECT_FIRST = 'Select the text to edit first.';
const NOT_EDITABLE = 'Copied to clipboard. The field could not be edited.';
const CHANGED = 'Selection changed. Result copied to clipboard.';
const EDIT_FAILED = 'Could not edit the selection. Click here to copy what you said.';
const SENTINEL = 'clipboard before the copy';
const FRAME_URL = `http://127.0.0.1:${PORT}/frame.html`;
/**
 * Tall enough for the whole fixture page, so no click scrolls: right after a scroll, Chromium can
 * route a click by the old position of an out-of-process frame.
 */
const VIEWPORT = { width: 1280, height: 2000 };
const HIDE_ONLY = Object.freeze({ hidePill: true, mode: null });

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
/** @type {{ instructions: string, input: string }[]} */
let refineCalls = [];
/** @type {{ method: string, auth: string|null }[]} */
let providerCalls = [];
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, refineCalls, providerCalls, close } = await launchExtension({ refineText: EDITED }));
  // The page reads the clipboard, and seeds it so that a copy is visible.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
});

test.afterAll(async () => {
  await close?.();
});

test.beforeEach(async () => {
  refineCalls.length = 0;
  providerCalls.length = 0;
  await seedSettings(serviceWorker, DUMMY_KEY);
});

test.afterEach(async () => {
  // Closing the tab also cancels a session a failed test left behind.
  for (const page of context.pages()) {
    if (page.url().startsWith('http')) await page.close();
  }
});

/** The fixture page with real focus and nothing below the fold. */
async function openPage() {
  const page = await openFields(context, { focusEmulation: false });
  await page.setViewportSize(VIEWPORT);
  return page;
}

/** @param {import('@playwright/test').Page} page */
async function crossOriginFrame(page) {
  await expect.poll(() => page.frames().some((f) => f.url() === FRAME_URL), { message: 'cross-origin frame' }).toBe(true);
  return page.frames().find((f) => f.url() === FRAME_URL);
}

/**
 * Selects text offsets in a field: a form field by its API, a contenteditable with one text node
 * by a range, seen through its shadow root when it has one.
 * @param {import('@playwright/test').Locator} field
 * @param {number} start
 * @param {number} end
 */
function select(field, start, end) {
  return field.evaluate((el, [from, to]) => {
    if ('setSelectionRange' in el) {
      el.setSelectionRange(from, to);
      return;
    }
    const root = el.getRootNode();
    const selection = root.getSelection ? root.getSelection() : document.getSelection();
    const range = document.createRange();
    range.setStart(el.firstChild, from);
    range.setEnd(el.firstChild, to);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [start, end]);
}

/** @param {import('@playwright/test').Locator} field */
const fieldText = (field) => field.evaluate((el) => ('value' in el ? el.value : el.textContent));

/** @param {import('@playwright/test').Locator} field */
const selectionOf = (field) => field.evaluate((el) => [el.selectionStart, el.selectionEnd]);

/**
 * The field with text in it, focused, and start to end selected.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {import('@playwright/test').Locator} field
 */
async function prepare(target, field, text, start, end) {
  await focusField(target, field);
  await field.fill(text);
  await select(field, start, end);
}

/**
 * The edit chord, a recording long enough, the chord again.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} [target]
 * @param {() => Promise<void>} [during] what happens while the recording runs
 */
async function editByVoice(page, target = page, during = async () => {}) {
  await page.keyboard.press(EDIT_HOTKEY);
  await waitForPill(target, STOP);
  await during();
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(EDIT_HOTKEY);
}

/**
 * Runs body with the text model answering text.
 * @param {string} text
 * @param {() => Promise<void>} body
 */
async function withRefine(text, body) {
  const answer = (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 5 } }),
  });
  await context.route(REFINE_URL, answer);
  try {
    await body();
  } finally {
    await context.unroute(REFINE_URL, answer);
  }
}

const FIELDS = [
  ['a textarea', '#ta'],
  ['an input', '#text'],
  ['a contenteditable', '#ce'],
  ['an input in a shadow root', '#shadow-input'],
  ['a contenteditable in a shadow root', '#shadow-ce'],
];

for (const [name, selector] of FIELDS) {
  test(`an edit replaces the selection in ${name}`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await prepare(page, field, 'keep this word', 5, 9);

    await editByVoice(page);

    await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(refineCalls).toHaveLength(1);
    expect(JSON.parse(refineCalls[0].input)).toEqual({ instruction: TRANSCRIPT, selected_text: 'this' });
    expect(refineCalls[0].instructions).toBe(EDIT_INSTRUCTIONS);
  });
}

test('an edit replaces the selection in a field in a cross-origin frame', async () => {
  const page = await openPage();
  const frame = await crossOriginFrame(page);
  const field = frame.locator('#frame-ta');
  await prepare(frame, field, 'keep this word', 5, 9);

  await editByVoice(page, frame);

  await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
  await expect.poll(() => pillStatus(frame)).toMatch(/^Done /);
  expect(JSON.parse(refineCalls[0].input).selected_text).toBe('this');
});

for (const [name, selector] of [FIELDS[0], FIELDS[1], FIELDS[2]]) {
  test(`a selected trailing space stays in ${name}`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await prepare(page, field, 'keep this word', 5, 10);

    await editByVoice(page);

    // An editor may hold the space as a no-break space.
    await expect.poll(async () => (await fieldText(field)).replace(/\u00A0/g, ' ')).toBe(`keep ${EDITED} word`);
    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(JSON.parse(refineCalls[0].input).selected_text).toBe('this ');
  });

  test(`Ctrl+Z restores ${name}`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await prepare(page, field, 'keep this word', 5, 9);
    await editByVoice(page);
    await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);

    await page.keyboard.press('Control+z');

    await expect.poll(() => fieldText(field)).toBe('keep this word');
  });
}

for (const [name, selector] of [FIELDS[0], FIELDS[2]]) {
  test(`one Ctrl+Z restores ${name} after a two-line replacement`, async () => {
    await withRefine(TWO_LINES, async () => {
      const page = await openPage();
      const field = page.locator(selector);
      await prepare(page, field, 'keep this word', 5, 9);
      await editByVoice(page);
      await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
      const placed = await fieldText(field);
      expect(placed.startsWith('keep edited one')).toBe(true);
      expect(placed.endsWith('edited two word')).toBe(true);

      await page.keyboard.press('Control+z');

      await expect.poll(() => fieldText(field)).toBe('keep this word');
    });
  });

  test(`a replacement inside the selection reads as placed, in ${name}`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await prepare(page, field, `keep this ${EDITED} now`, 5, `keep this ${EDITED} now`.length);

    await editByVoice(page);

    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(await fieldText(field)).toBe(`keep ${EDITED}`);
  });

  test(`a replacement repeating text of the field reads as placed, in ${name}`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    const start = `${EDITED} and `.length;
    await prepare(page, field, `${EDITED} and more`, start, start + 'more'.length);

    await editByVoice(page);

    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(await fieldText(field)).toBe(`${EDITED} and ${EDITED}`);
  });
}

for (const [name, selector] of [FIELDS[0], FIELDS[2]]) {
  test(`a stop on the pill leaves the selection in ${name}, so the edit lands`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await prepare(page, field, 'keep this word', 5, 9);

    await page.keyboard.press(EDIT_HOTKEY);
    await waitForPill(page, STOP);
    await page.waitForTimeout(RECORD_MS);
    await clickPill(page, STOP);

    await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
  });
}

test('holding the chord records until its release', async () => {
  const page = await openPage();
  const field = page.locator('#ta');
  await prepare(page, field, 'keep this word', 5, 9);

  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.down('KeyE');
  await waitForPill(page, STOP);
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.up('KeyE');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');

  await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
});

test('a selection across paragraphs goes with its line breaks and is replaced whole', async () => {
  const page = await openPage();
  const field = page.locator('#ce');
  await focusField(page, field);
  await field.evaluate((el) => {
    el.replaceChildren(...['first line', 'second line'].map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }));
    const selection = document.getSelection();
    const range = document.createRange();
    range.setStart(el.firstChild.firstChild, 6);
    range.setEnd(el.lastChild.firstChild, 6);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await editByVoice(page);

  await expect.poll(() => fieldText(field)).toBe(`first ${EDITED} line`);
  expect(JSON.parse(refineCalls[0].input).selected_text).toMatch(/^line\n+second$/);
});

test('a triple click on a paragraph goes without the line breaks the selection adds and leaves no blank paragraph', async () => {
  const page = await openPage();
  const field = page.locator('#ce');
  await focusField(page, field);
  await field.evaluate((el) => {
    el.replaceChildren(...['first line', 'second line'].map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }));
  });
  await field.locator('p').first().click({ clickCount: 3 });

  await editByVoice(page);

  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
  expect(JSON.parse(refineCalls[0].input).selected_text).toBe('first line');
  expect(await fieldText(field)).toBe(`${EDITED}second line`);
  expect(await field.locator('p').allTextContents()).toEqual([EDITED, 'second line']);

  await page.keyboard.press('Control+z');

  await expect.poll(() => field.locator('p').allTextContents()).toEqual(['first line', 'second line']);
});

for (const [name, html, block] of [
  ['a list with blank text between its items', '<ul>\n  <li>first line</li>\n  <li>second line</li>\n</ul>', 'li'],
  ['paragraphs with a line break and a tab between them', '<p>first line</p>\n\t<p>second line</p>', 'p'],
]) {
  test(`a triple click on the first block of ${name} leaves the blocks apart, and Ctrl+Z restores`, async () => {
    const page = await openPage();
    const field = page.locator('#ce');
    await focusField(page, field);
    await field.evaluate((el, source) => { el.innerHTML = source; }, html);
    const blocks = field.locator(block);
    await blocks.first().click({ clickCount: 3 });

    await editByVoice(page);

    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(JSON.parse(refineCalls[0].input).selected_text).toBe('first line');
    expect(await blocks.allTextContents()).toEqual([EDITED, 'second line']);

    await page.keyboard.press('Control+z');

    await expect.poll(() => blocks.allTextContents()).toEqual(['first line', 'second line']);
  });
}

for (const [name, select] of [
  ['a triple click', (first) => first.click({ clickCount: 3 })],
  ['Shift+Down from the start of its line', async (first, page) => {
    await first.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowDown');
  }],
  // No gesture tried on Chromium 153 or Chrome 140 ends here: a page's script has to set this end.
  ['a selection a script ends in the next item\'s leading whitespace', (first) => first.evaluate((item) => {
    const selection = document.getSelection();
    const range = document.createRange();
    range.setStart(item.firstChild, 5);
    range.setEnd(item.nextElementSibling.firstChild, 3);
    selection.removeAllRanges();
    selection.addRange(range);
  })],
]) {
  test(`${name} on a list item that source formatting indents leaves the items apart, and Ctrl+Z restores`, async () => {
    const page = await openPage();
    const field = page.locator('#ce');
    await focusField(page, field);
    await field.evaluate((el) => {
      el.innerHTML = '<ul>\n  <li>\n    first line\n  </li>\n  <li>\n    second line\n  </li>\n</ul>';
    });
    const before = await field.evaluate((el) => el.innerHTML);
    const items = field.locator('li');
    await select(items.first(), page);

    await editByVoice(page);

    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(JSON.parse(refineCalls[0].input).selected_text).toBe('first line');
    expect((await items.allTextContents()).map((text) => text.trim())).toEqual([EDITED, 'second line']);

    await page.keyboard.press('Control+z');

    await expect.poll(() => field.evaluate((el) => el.innerHTML)).toBe(before);
  });
}

test('a triple click on a line of a preformatted contenteditable keeps the line break the field holds', async () => {
  const page = await openPage();
  const field = page.locator('#ce');
  await focusField(page, field);
  await field.evaluate((el) => {
    el.style.whiteSpace = 'pre-wrap';
    el.textContent = 'first line\nsecond line';
  });
  await field.click({ clickCount: 3, position: { x: 30, y: 16 } });

  await editByVoice(page);

  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
  expect(JSON.parse(refineCalls[0].input).selected_text).toBe('first line\n');
  expect((await fieldText(field)).replace(/\n/g, '')).toBe(`${EDITED}second line`);
});

for (const [name, selector] of [FIELDS[0], FIELDS[2]]) {
  test(`right-to-left text in ${name} goes as selected and is replaced in place`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await field.evaluate((el) => { el.dir = 'rtl'; });
    await prepare(page, field, 'שלום עולם יפה', 5, 9);

    await editByVoice(page);

    await expect.poll(() => fieldText(field)).toBe(`שלום ${EDITED} יפה`);
    expect(JSON.parse(refineCalls[0].input).selected_text).toBe('עולם');
  });
}

test('a selection across inline nodes goes whole and is replaced whole', async () => {
  const page = await openPage();
  const field = page.locator('#ce');
  await focusField(page, field);
  await field.evaluate((el) => {
    el.replaceChildren();
    const bold = document.createElement('b');
    bold.textContent = 'this';
    const italic = document.createElement('i');
    italic.textContent = 'word';
    el.append('keep ', bold, ' middle ', italic, ' now');
    const selection = document.getSelection();
    const range = document.createRange();
    range.setStart(bold.firstChild, 1);
    range.setEnd(italic.firstChild, 2);
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await editByVoice(page);

  await expect.poll(() => fieldText(field)).toBe(`keep t${EDITED}rd now`);
  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
  expect(JSON.parse(refineCalls[0].input).selected_text).toBe('his middle wo');
});

test('the active mode and a site mode do not apply to an edit', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { activeMode: 'email', siteRules: { localhost: { hidePill: false, mode: 'email' } } });
  const page = await openPage();
  const field = page.locator('#ta');
  await prepare(page, field, 'keep this word', 5, 9);

  await editByVoice(page);

  await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
  expect(refineCalls.map((call) => call.instructions)).toEqual([EDIT_INSTRUCTIONS]);
});

test('a failed refine leaves the field, its click copies the instruction, and the next press records', async () => {
  const refuse = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  await context.route(REFINE_URL, refuse);
  try {
    const page = await openPage();
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
    const field = page.locator('#ta');
    await prepare(page, field, 'keep this word', 5, 9);

    await editByVoice(page);

    await expect.poll(() => pillStatus(page)).toBe(EDIT_FAILED);
    expect(await fieldText(field)).toBe('keep this word');
    expect(await selectionOf(field)).toEqual([5, 9]);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SENTINEL);

    const status = await pillQuery(page, STATUS);
    await page.mouse.click(status.x, status.y);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(TRANSCRIPT);

    await field.focus();
    await page.keyboard.press(EDIT_HOTKEY);
    await waitForPill(page, STOP);
    expect(await pillStatus(page)).toBe(SAY);
  } finally {
    await context.unroute(REFINE_URL, refuse);
  }
});

test('a moved selection copies and leaves the field', async () => {
  const page = await openPage();
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
  const field = page.locator('#ta');
  await prepare(page, field, 'word and word', 0, 4);

  await editByVoice(page, page, () => select(field, 9, 13));

  await expect.poll(() => pillStatus(page)).toBe(CHANGED);
  expect(await fieldText(field)).toBe('word and word');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EDITED);
});

test('the same word elsewhere in a contenteditable is not the selection', async () => {
  const page = await openPage();
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
  const field = page.locator('#ce');
  await prepare(page, field, 'word and word', 0, 4);

  await editByVoice(page, page, () => select(field, 9, 13));

  await expect.poll(() => pillStatus(page)).toBe(CHANGED);
  expect(await fieldText(field)).toBe('word and word');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EDITED);
});

test('a selection the page moves between rungs ends at the clipboard and the field stays', async () => {
  await withRefine(TWO_LINES, async () => {
    const page = await openPage();
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
    const field = page.locator('#ce');
    const text = 'keep this word and more';
    await prepare(page, field, text, 5, 9);
    // The synthetic paste is the first rung of a multi-line text; this page answers it late.
    await field.evaluate((el, from) => {
      el.addEventListener('paste', () => {
        setTimeout(() => {
          const range = document.createRange();
          range.setStart(el.firstChild, from);
          range.setEnd(el.firstChild, from + 'more'.length);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }, 20);
      });
    }, text.indexOf('more'));

    await editByVoice(page);

    await expect.poll(() => pillStatus(page)).toBe(NOT_EDITABLE);
    expect(await fieldText(field)).toBe(text);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TWO_LINES);
  });
});

test('text the page rewrites at the same offsets is copied over, not replaced', async () => {
  const page = await openPage();
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
  const field = page.locator('#ta');
  await prepare(page, field, 'keep this word', 5, 9);

  await editByVoice(page, page, () => field.evaluate((el) => {
    el.value = 'keep that word';
    el.setSelectionRange(5, 9);
  }));

  await expect.poll(() => pillStatus(page)).toBe(CHANGED);
  expect(await fieldText(field)).toBe('keep that word');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EDITED);
});

for (const [name, selector] of [FIELDS[0], FIELDS[2]]) {
  test(`the dictation hotkey over a selection in ${name} replaces it with the transcript and sends no selected text`, async () => {
    const page = await openPage();
    const field = page.locator(selector);
    await prepare(page, field, 'keep this word', 5, 9);

    await dictateWithHotkey(page, page);

    await expect.poll(() => fieldText(field)).toBe(`keep ${TRANSCRIPT} word`);
    expect(providerCalls).toHaveLength(1);
    expect(refineCalls).toEqual([]);
  });
}

test('a dictation with a refining mode over a selection sends the transcript alone', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { activeMode: 'email' });
  const page = await openPage();
  const field = page.locator('#ta');
  await prepare(page, field, 'keep this word', 5, 9);

  await dictateWithHotkey(page, page);

  await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
  expect(refineCalls.map((call) => call.input)).toEqual([TRANSCRIPT]);
});

/** Records every keydown of the chord's main key the page gets to see, at document level. */
function listenForKeys(page) {
  return page.evaluate(() => {
    window.seenKeys = [];
    document.addEventListener('keydown', (event) => {
      if (event.code === 'KeyE') window.seenKeys.push({ repeat: event.repeat, prevented: event.defaultPrevented });
    });
  });
}

/**
 * The chord held down: one press and two auto-repeats.
 * @param {import('@playwright/test').Page} page
 */
async function holdChord(page) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i += 1) await page.keyboard.down('KeyE');
  await page.keyboard.up('KeyE');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}

const EVERY_KEYDOWN = [{ repeat: false, prevented: false }, { repeat: true, prevented: false }, { repeat: true, prevented: false }];

test('Ctrl+Shift+E held with no selection reaches the page on every keydown', async () => {
  const page = await openPage();
  await prepare(page, page.locator('#ta'), 'keep this word', 5, 5);
  await listenForKeys(page);

  await holdChord(page);

  expect(await page.evaluate(() => window.seenKeys)).toEqual(EVERY_KEYDOWN);
  await expect.poll(() => pillStatus(page)).toBe(SELECT_FIRST);
  expect(providerCalls).toEqual([]);
});

test('Ctrl+Shift+E held outside a field reaches the page on every keydown, with no status', async () => {
  const page = await openPage();
  await focusField(page, page.locator('#ta'));
  await page.locator('h1').click();
  await listenForKeys(page);

  await holdChord(page);

  expect(await page.evaluate(() => window.seenKeys)).toEqual(EVERY_KEYDOWN);
  expect(await pillStatus(page)).toBe('');
});

test('Ctrl+Shift+E with a selection is kept from the page, repeats included', async () => {
  const page = await openPage();
  await prepare(page, page.locator('#ta'), 'keep this word', 5, 9);
  await listenForKeys(page);

  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i += 1) await page.keyboard.down('KeyE');
  await waitForPill(page, STOP);

  expect(await page.evaluate(() => window.seenKeys)).toEqual([]);
  await page.keyboard.up('KeyE');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
});

for (const [name, overrides] of [
  ['a hidden site', { siteRules: { localhost: HIDE_ONLY } }],
  ['Minimal', { pillStyle: 'minimal' }],
]) {
  test(`an edit on ${name} shows the indicator and the start status`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, overrides);
    const page = await openPage();
    const field = page.locator('#ta');
    await field.fill('keep this word');
    await field.click();
    await select(field, 5, 9);

    await startWithHotkey(page, page, { indicator: MINI, chord: EDIT_HOTKEY });

    expect(await indicatorShown(page)).toBe(true);
    await expect.poll(() => pillStatus(page)).toBe(SAY);
    await page.waitForTimeout(RECORD_MS);
    await page.keyboard.press(EDIT_HOTKEY);
    await expect.poll(() => fieldText(field)).toBe(`keep ${EDITED} word`);
  });
}
