import test from 'node:test';
import assert from 'node:assert/strict';
import { groupStrokesIntoLines, Whiteboard } from '../static/board.js';

const stroke = (id, x, y, width = 20, height = 30) => ({id, kind: 'stroke', points: [{x,y},{x:x+width,y:y+height}]});

test('groups separate handwritten symbols into correctly positioned lines', () => {
  const lines = groupStrokesIntoLines([stroke('a', 60, 100), stroke('b', 100, 102), stroke('c', 70, 200), stroke('d',110,205)]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id,'a');
  assert.equal(lines[1].id,'c');
  assert.ok(lines[0].bbox.y < lines[1].bbox.y);
  assert.ok(lines[0].bbox.height > 0 && lines[0].bbox.height < .1);
});

test('line identity survives adding a later stroke to an earlier line', () => {
  const existing = [stroke('a',60,100),stroke('b',60,200)];
  assert.deepEqual(groupStrokesIntoLines([...existing,stroke('c',100,103)]).map(l=>l.id),['a','b']);
});

test('typed text cannot masquerade as all the content of a mixed handwritten line', () => {
  const text = {id:'t',kind:'text',text:'2x = 10',x:70,y:150,width:150};
  assert.equal(groupStrokesIntoLines([text])[0].text,'2x = 10');
  assert.equal(groupStrokesIntoLines([text,stroke('a',230,112)])[0].text,undefined);
});

test('empty board produces no lines', () => assert.deepEqual(groupStrokesIntoLines([]), []));

function mockCanvas() {
  const captures = new Set();
  const listeners = new Map();
  const context = {
    clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {},
    quadraticCurveTo() {}, lineTo() {}, stroke() {}, fillText() {},
    measureText(text) { return {width: text.length * 20}; },
  };
  return {
    style: {},
    getContext() { return context; },
    setAttribute() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); return true; },
    getBoundingClientRect() { return {left: 0, top: 0, width: 1200, height: 900}; },
    setPointerCapture(pointerId) { captures.add(pointerId); },
    hasPointerCapture(pointerId) { return captures.has(pointerId); },
    releasePointerCapture(pointerId) {
      captures.delete(pointerId);
      listeners.get('lostpointercapture')?.({pointerId});
    },
  };
}
const pointer = (pointerId, pointerType, x = 100, y = 100) => ({
  pointerId, pointerType, clientX: x, clientY: y, pressure: .5, button: 0, buttons: 1,
  preventDefault() {},
});

test('pen replaces an unfinished palm stroke and preserves one undo step', () => {
  const canvas = mockCanvas();
  let changes = 0;
  const board = new Whiteboard(canvas, {onChange: () => changes++});
  const original = [stroke('existing', 200, 200)];
  board.setState(original);
  board.start(pointer(1, 'touch', 400, 400));
  board.move(pointer(1, 'touch', 440, 420));
  assert.equal(board.strokes.length, 2);

  board.start(pointer(2, 'pen', 100, 100));
  assert.equal(board.pointer, 2);
  assert.equal(canvas.hasPointerCapture(1), false);
  assert.equal(canvas.hasPointerCapture(2), true);
  assert.equal(board.history.length, 1);
  assert.equal(changes, 0, 'preempting touch must not submit an intermediate board');
  assert.equal(board.strokes.length, 2, 'the palm mark was discarded');
  assert.equal(board.strokes[1].points[0].x, 100);

  board.end(pointer(1, 'touch'));
  assert.equal(board.isDrawing, true, 'the late palm release cannot end the pen stroke');
  board.move(pointer(2, 'pen', 140, 120));
  board.end(pointer(2, 'pen', 140, 120));
  assert.equal(changes, 1);
  board.undo();
  assert.deepEqual(board.getState(), original);
  assert.equal(board.history.length, 0);
});

test('secondary touch cannot change or end an active pen stroke', () => {
  const canvas = mockCanvas();
  let changes = 0;
  const board = new Whiteboard(canvas, {onChange: () => changes++});
  board.start(pointer(10, 'pen'));
  board.start(pointer(11, 'touch', 400, 400));
  board.move(pointer(11, 'touch', 450, 450));
  board.end(pointer(11, 'touch'));
  assert.equal(board.pointer, 10);
  assert.equal(board.isDrawing, true);
  assert.equal(board.strokes.length, 1);
  assert.equal(board.history.length, 1);
  assert.equal(canvas.hasPointerCapture(11), false);
  assert.equal(changes, 0);
  board.move(pointer(10, 'pen', 130, 120));
  board.end(pointer(10, 'pen', 130, 120));
  assert.equal(changes, 1);
  assert.equal(board.strokes[0].points.length, 2);
  board.undo();
  assert.equal(board.isEmpty(), true);
});

test('pen preemption restores work accidentally erased by a palm', () => {
  const board = new Whiteboard(mockCanvas());
  const original = [stroke('existing', 200, 200)];
  board.setState(original);
  board.setTool('eraser');
  board.start(pointer(1, 'touch', 210, 210));
  assert.equal(board.isEmpty(), true);
  board.setTool('pen');
  board.start(pointer(2, 'pen', 100, 100));
  board.end(pointer(2, 'pen', 100, 100));
  assert.equal(board.strokes.length, 2);
  assert.deepEqual(board.strokes[0], original[0]);
  board.undo();
  assert.deepEqual(board.getState(), original);
});
