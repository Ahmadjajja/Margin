import test from 'node:test';
import assert from 'node:assert/strict';
import {SolutionBoard} from '../static/solution-board.js';
import {summarizeStrokes} from '../static/board.js';

const stroke = (id, points) => ({id, kind: 'stroke', points: points.map(([x, y]) => ({x, y}))});

class MockElement {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.captures = new Set();
    this.className = '';
    this.classList = {toggle: (name, enabled) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    }};
    this.context = {
      calls: [], clearRect() {}, beginPath() {}, arc() {}, fill() {},
      moveTo(...values) { this.calls.push(['moveTo', ...values]); },
      lineTo(...values) { this.calls.push(['lineTo', ...values]); },
      quadraticCurveTo(...values) { this.calls.push(['quadraticCurveTo', ...values]); },
      stroke() { this.calls.push(['stroke', this.lineWidth]); },
      fillText(...values) { this.calls.push(['fillText', this.font, ...values]); },
      fillRect(...values) { this.calls.push(['fillRect', this.fillStyle, ...values]); },
      save() {}, restore() {}, translate(...values) { this.calls.push(['translate', ...values]); },
      measureText(value) { return {width: value.length * (parseFloat(this.font) || 27) * .5}; },
    };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) { listener(event); if (event._stopped) break; } return true; }
  focus() { this.dispatchEvent({type: 'focus'}); }
  scrollIntoView() {}
  get clientWidth() { return this.getBoundingClientRect().width; }
  getBoundingClientRect() {
    const width = this._width || this.parentElement?.getBoundingClientRect().width || 800;
    const height = parseFloat(this.style.height) || (this.tagName === 'canvas' ? 160 : 600);
    return {left: 0, top: 0, width, height, bottom: height, right: width};
  }
  getContext() { return this.context; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); this.dispatchEvent({type: 'lostpointercapture', pointerId: id}); }
  toDataURL() { return 'data:image/png;base64,test'; }
}

function setup(run, width = 800) {
  const oldDocument = globalThis.document;
  const document = {created: [], createElement(tag) { const node = new MockElement(tag, this); this.created.push(node); return node; }};
  globalThis.document = document;
  const container = document.createElement('div');
  container._width = width;
  let changes = 0;
  const board = new SolutionBoard(container, {onChange: () => changes++});
  try { run({board, container, document, changes: () => changes}); }
  finally {
    board.destroy();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
}

const pointer = (type, x, y, pointerId = 1) => ({
  type, clientX: x, clientY: y, pointerId, pointerType: 'pen', button: 0, buttons: 1, pressure: .5,
  preventDefault() {}, stopImmediatePropagation() { this._stopped = true; },
});

test('all nested fraction and long division strokes stay in their explicit row', () => setup(({board}) => {
  const row = board.rows[0];
  row.board.setState([
    stroke('numerator', [[100, 30], [120, 55]]),
    stroke('outer-bar', [[70, 95], [230, 95]]),
    stroke('inner-top', [[110, 140], [130, 160]]),
    stroke('inner-bar', [[90, 190], [160, 190]]),
    stroke('denominator', [[110, 230], [130, 260]]),
    stroke('division-bracket', [[320, 25], [300, 270], [460, 270]]),
    stroke('working-far-below', [[350, 340], [420, 365]]),
  ]);
  board.expandActiveRow();
  const lines = board.getLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, row.id);
  assert.equal(lines[0].text, undefined);
  assert.ok(lines[0].bbox.height > .7);
  assert.equal(summarizeStrokes(row.board.strokes, {height: row.board.height}).bounds.bottom, 365);
}));

test('division dots and bar form one API line without any geometric grouping', () => setup(({board}) => {
  board.rows[0].board.setState([
    stroke('top-dot', [[200, 20]]), stroke('division-bar', [[170, 100], [240, 100]]),
    stroke('bottom-dot', [[200, 200]]), stroke('left-number', [[50, 80], [75, 120]]),
  ]);
  assert.equal(board.getLines().length, 1);
  board.addRow();
  assert.equal(board.getLines().length, 1, 'empty rows are not sent to the provider');
  board.activeRow.board.setState([stroke('next', [[100, 30], [130, 60]])]);
  assert.equal(board.getLines().length, 2);
  assert.deepEqual(board.getLines().map(row => row.number), [1, 2]);
}));

test('More space and next row preserve the earlier fingerprint and physical ink position', () => setup(({board}) => {
  const row = board.rows[0];
  row.board.setState([stroke('ink', [[100, 60], [180, 120]])]);
  const before = board.getLines()[0];
  const points = row.board.getState()[0].points;
  const screenY = points[1].y * row.canvas.getBoundingClientRect().height / row.board.height;
  board.expandActiveRow();
  const grown = board.getLines()[0];
  assert.equal(grown.id, before.id);
  assert.equal(grown.fingerprint, before.fingerprint);
  assert.deepEqual(row.board.getState()[0].points, points);
  assert.ok(Math.abs(points[1].y * row.canvas.getBoundingClientRect().height / row.board.height - screenY) < 1e-8);
  board.addRow();
  board.addText('x = 8');
  assert.equal(board.getLines()[0].fingerprint, before.fingerprint);
}));

test('growing while drawing preserves the continuous stroke and one undo action', () => setup(({board, container, changes}) => {
  const row = board.rows[0];
  const activity = [];
  container.addEventListener('boardactivity', event => activity.push(event.detail.drawing));
  row.canvas.dispatchEvent(pointer('pointerdown', 100, 80));
  const initial = row.board.strokes[0].points[0];
  const oldHeight = row.canvas.getBoundingClientRect().height;
  row.canvas.dispatchEvent(pointer('pointermove', 120, 145));
  assert.ok(row.canvas.getBoundingClientRect().height > oldHeight);
  const current = row.board.strokes[0].points.at(-1);
  assert.ok(Math.abs(initial.y * row.canvas.getBoundingClientRect().height / row.board.height - 80) < 1e-8);
  assert.ok(Math.abs(current.y * row.canvas.getBoundingClientRect().height / row.board.height - 145) < 1e-8);
  row.canvas.dispatchEvent(pointer('pointerup', 120, 145));
  assert.equal(changes(), 1);
  assert.deepEqual(activity, [true, false]);
  board.undo();
  assert.equal(board.isEmpty(), true);
  assert.equal(board.rows[0].canvas.getBoundingClientRect().height, oldHeight);
}));

test('editing an earlier typed row preserves later rows and can be undone', () => setup(({board}) => {
  board.addText('2x - 3 = 10');
  board.addText('2x = 13');
  const before = board.getLines();
  assert.equal(board.updateText(before[0].id, '2x - 6 = 10'), true);
  const after = board.getLines();
  assert.equal(after[0].text, '2x - 6 = 10');
  assert.notEqual(after[0].fingerprint, before[0].fingerprint);
  assert.equal(after[1].fingerprint, before[1].fingerprint);
  board.undo();
  assert.deepEqual(board.getLines().map(row => row.text), ['2x - 3 = 10', '2x = 13']);
}));

test('row creation and manual growth have independent undo actions', () => setup(({board}) => {
  board.addText('x/2 = 3');
  const initialHeight = board.rows[0].board.height;
  board.expandActiveRow();
  board.addRow();
  assert.equal(board.rows.length, 2);
  board.undo();
  assert.equal(board.rows.length, 1);
  assert.ok(board.rows[0].board.height > initialHeight);
  board.undo();
  assert.equal(board.rows[0].board.height, initialHeight);
  assert.equal(board.getLines()[0].text, 'x/2 = 3');
}));

test('versioned row state round trips and a legacy flat board migrates once', () => setup(({board}) => {
  board.setState([
    {id: 'old-1', kind: 'text', text: 'x/2 = 3', x: 80, y: 110, width: 220},
    {id: 'old-2', kind: 'text', text: 'x = 6', x: 80, y: 300, width: 150},
  ]);
  assert.deepEqual(board.getLines().map(row => row.text), ['x/2 = 3', 'x = 6']);
  const state = board.getState();
  assert.equal(state.version, 2);
  board.setState(state);
  assert.deepEqual(board.getState(), state);
  assert.deepEqual(board.getLines().map(row => row.id), ['old-1', 'old-2']);
}));

test('composite export contains both full rows and normalized boxes match image offsets', () => setup(({board, document}) => {
  board.addText('x/2 = 3');
  board.addText('x = 6');
  const lines = board.getLines();
  const layout = board._exportLayout();
  board.toDataURL();
  const image = document.created.at(-1);
  assert.ok(image.width <= 1400 && image.height <= 3200);
  assert.equal(image.context.calls.filter(call => call[0] === 'fillText').length, 2);
  assert.deepEqual(image.context.calls[0], ['fillRect', '#ffffff', 0, 0, image.width, image.height]);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], row = layout.rows[index];
    assert.ok(line.bbox.x >= 0 && line.bbox.x + line.bbox.width <= 1);
    assert.ok(line.bbox.y >= 0 && line.bbox.y + line.bbox.height <= 1);
    assert.ok(Math.abs(line.bbox.y - (row.y + row.summary.bbox.y * row.height) / layout.height) < 1e-9);
  }
  assert.ok(lines[1].bbox.y > lines[0].bbox.y + lines[0].bbox.height);
}));

test('clearing all rows is undoable and a narrow explicit row still fits typed math', () => setup(({board}) => {
  board.addText('2(x - 3) = 10');
  const fingerprint = board.getLines()[0].fingerprint;
  board.expandActiveRow();
  assert.equal(board.getLines()[0].fingerprint, fingerprint);
  board.clear();
  assert.equal(board.isEmpty(), true);
  assert.equal(board.rows.length, 1);
  board.undo();
  assert.equal(board.getLines()[0].text, '2(x - 3) = 10');
}, 305));

test('transient padding-only layout cannot inflate typed demo rows after reset or resize', () => setup(({board, container}) => {
  board.addText('2(x - 3) = 10');
  board.addText('2x - 3 = 10');
  const secondId = board.getLines()[1].id;
  container._width = 8;
  board.render();
  board.updateText(secondId, '2x - 6 = 10');
  board.addText('2x = 16');
  container._width = 850.667;
  board.render();
  board.addText('x = 8');
  for (let i = 0; i < 20; i++) board.render();
  assert.deepEqual(board.getLines().map(line => line.text), ['2(x - 3) = 10', '2x - 6 = 10', '2x = 16', 'x = 8']);
  for (const row of board.rows) {
    assert.ok(row.canvas.getBoundingClientRect().height >= 160);
    assert.ok(row.canvas.getBoundingClientRect().height < 200, 'typed rows must not grow from a transient8px layout measurement');
    assert.ok(row.board.height < 350);
  }
}));

test('initializing in an8px temporary container stays bounded when full layout arrives', () => setup(({board, container}) => {
  board.addText('x/2 = 3');
  container._width = 850.667;
  board.render();
  assert.ok(board.rows[0].canvas.getBoundingClientRect().height < 200);
  assert.equal(board.getLines()[0].text, 'x/2 = 3');
}, 8));

test('oversized saved typed rows recover readable height and text without deleting work', () => setup(({board}) => {
  const texts = ['2(x - 3) = 10', '2x - 6 = 10', '2x = 16', 'x = 8'];
  board.setState({version: 2, activeRowId: 'row-3', rows: texts.map((text, index) => ({
    id: `row-${index}`, height: 24000,
    strokes: [{id: `typed-${index}`, kind: 'text', text, x: 82, y: index % 2 ? 6110 : 115, width: 300}],
  }))});
  board.render();
  assert.deepEqual(board.getLines().map(line => line.text), texts);
  assert.deepEqual(board.getLines().map(line => line.id), ['row-0', 'row-1', 'row-2', 'row-3']);
  assert.equal(board.activeRowId, 'row-3');
  for (const row of board.rows) {
    assert.equal(row.canvas.getBoundingClientRect().height, 160);
    const textCall = row.canvas.context.calls.filter(call => call[0] === 'fillText').at(-1);
    assert.ok(textCall[4] > 30 && textCall[4] < 120, 'recovered text stays visibly inside the row');
  }
}, 850.667));
