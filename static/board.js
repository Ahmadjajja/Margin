const WIDTH = 1200;
const HEIGHT = 900;
const INK = '#1a2a6c';

const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const id = () => globalThis.crypto?.randomUUID?.() || `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function bounds(stroke) {
  if (stroke.kind === 'text') return { x: stroke.x, y: stroke.y - 46, width: stroke.width, height: 58 };
  const xs = stroke.points.map(p => p.x), ys = stroke.points.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

// Geometry stays in board coordinates. The same normalized boxes are sent to
// the reader and used by the UI, so model guesses never position underlines.
export function groupStrokesIntoLines(strokes) {
  const entries = strokes.filter(s => s.kind === 'text' || s.points?.length).map((s, index) => ({s, index, b: bounds(s)}));
  entries.sort((a, b) => a.b.y + a.b.height / 2 - b.b.y - b.b.height / 2);
  const groups = [];
  for (const entry of entries) {
    const center = entry.b.y + entry.b.height / 2;
    let match = null, best = Infinity;
    for (const group of groups) {
      const gap = Math.max(group.top - entry.b.y - entry.b.height, entry.b.y - group.bottom, 0);
      const distance = Math.abs(center - (group.top + group.bottom) / 2);
      const tall = Math.max(group.bottom - group.top, entry.b.height);
      if (gap <= 19 && distance <= Math.max(37, tall * .67) && distance < best) { match = group; best = distance; }
    }
    if (!match) {
      match = { items: [], top: entry.b.y, bottom: entry.b.y + entry.b.height, left: entry.b.x, right: entry.b.x + entry.b.width };
      groups.push(match);
    }
    match.items.push(entry);
    match.top = Math.min(match.top, entry.b.y);
    match.bottom = Math.max(match.bottom, entry.b.y + entry.b.height);
    match.left = Math.min(match.left, entry.b.x);
    match.right = Math.max(match.right, entry.b.x + entry.b.width);
  }
  return groups.sort((a, b) => a.top - b.top).map((group, index) => {
    const oldest = [...group.items].sort((a, b) => a.index - b.index)[0].s;
    const onlyText = group.items.every(item => item.s.kind === 'text');
    const box = {
      x: clamp((group.left - 6) / WIDTH, 0, 1),
      y: clamp((group.top - 6) / HEIGHT, 0, 1),
      width: clamp((group.right - group.left + 12) / WIDTH, .015, 1),
      height: clamp((group.bottom - group.top + 12) / HEIGHT, .018, 1),
    };
    return { id: oldest.id, number: index + 1, ...(onlyText ? {text: group.items.sort((a,b) => a.b.x - b.b.x).map(item => item.s.text).join(' ')} : {}), bbox: box, y: (group.top + group.bottom) / 2 / HEIGHT };
  });
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export class Whiteboard {
  constructor(canvas, {onChange = () => {}} = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.strokes = [];
    this.history = [];
    this.tool = 'pen';
    this.active = null;
    this.pointer = null;
    this.pointerType = null;
    this._drawing = false;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.style.touchAction = 'none';
    canvas.setAttribute('aria-label', 'Math whiteboard. Draw with a pen, finger, or mouse. Use Type a step for keyboard input.');
    this.handlers = {
      pointerdown: e => this.start(e), pointermove: e => this.move(e),
      pointerup: e => this.end(e), pointercancel: e => this.end(e),
      lostpointercapture: e => this.end(e),
      contextmenu: e => e.preventDefault(),
    };
    for (const [name, fn] of Object.entries(this.handlers)) canvas.addEventListener(name, fn);
    this.render();
  }
  get isDrawing() { return this._drawing; }
  get width() { return WIDTH; }
  get height() { return HEIGHT; }
  isEmpty() { return this.strokes.length === 0; }
  getState() { return JSON.parse(JSON.stringify(this.strokes)); }
  setState(state) {
    const input = Array.isArray(state) ? state : state?.strokes;
    if (!Array.isArray(input)) return;
    this.strokes = input.slice(0, 2000).filter(s => s && typeof s.id === 'string' &&
      (s.kind === 'text' ? typeof s.text === 'string' && [s.x,s.y,s.width].every(Number.isFinite) :
      Array.isArray(s.points) && s.points.length && s.points.length < 15000 && s.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))));
    this.strokes = JSON.parse(JSON.stringify(this.strokes));
    this.history = [];
    this.render();
  }
  snapshot() {
    this.history.push(this.getState());
    if (this.history.length > 60) this.history.shift();
  }
  setTool(tool) {
    this.tool = tool === 'eraser' ? 'eraser' : 'pen';
    this.canvas.style.cursor = this.tool === 'eraser' ? 'cell' : 'crosshair';
  }
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width * WIDTH, 0, WIDTH), y: clamp((e.clientY - r.top) / r.height * HEIGHT, 0, HEIGHT), p: e.pointerType === 'pen' ? clamp(e.pressure || .5, .15, 1) : .5 };
  }
  start(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this._drawing) {
      if (e.pointerType !== 'pen' || this.pointerType !== 'touch') return;
      // A palm may land before the stylus. Roll back that whole touch
      // interaction, including accidental erasing, before giving the pen control.
      this.strokes = this.history.pop() || [];
      const touchPointer = this.pointer;
      this._drawing = false;
      this.active = null;
      this.pointer = null;
      this.pointerType = null;
      if (this.canvas.hasPointerCapture(touchPointer)) this.canvas.releasePointerCapture(touchPointer);
    }
    e.preventDefault();
    this.pointer = e.pointerId;
    this.pointerType = e.pointerType;
    this._drawing = true;
    this.snapshot();
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.dispatchEvent(new CustomEvent('boardactivity', {detail: {drawing: true}}));
    const p = this.point(e);
    // Pen barrel erasers are recognized without changing the selected toolbar tool.
    this.erasing = this.tool === 'eraser' || e.button === 5 || (e.buttons & 32) !== 0;
    if (this.erasing) this.erase(p);
    else {
      this.active = {id: id(), kind: 'stroke', points: [p]};
      this.strokes.push(this.active);
    }
    this.render();
  }
  move(e) {
    if (!this._drawing || e.pointerId !== this.pointer) return;
    e.preventDefault();
    const events = e.getCoalescedEvents?.() || [e];
    for (const event of events.length ? events : [e]) {
      const p = this.point(event);
      if (this.erasing) this.erase(p);
      else if (this.active) {
        const last = this.active.points.at(-1);
        if (Math.hypot(last.x - p.x, last.y - p.y) > .7) this.active.points.push(p);
      }
    }
    this.render();
  }
  end(e) {
    if (!this._drawing || e.pointerId !== this.pointer) return;
    this._drawing = false;
    this.active = null;
    this.pointer = null;
    this.pointerType = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.render();
    this.canvas.dispatchEvent(new CustomEvent('boardactivity', {detail: {drawing: false}}));
    this.onChange(this.getState());
  }
  erase(p) {
    const radius = 19;
    this.strokes = this.strokes.filter(stroke => {
      const b = bounds(stroke);
      if (p.x < b.x - radius || p.x > b.x + b.width + radius || p.y < b.y - radius || p.y > b.y + b.height + radius) return true;
      if (stroke.kind === 'text') return false;
      if (stroke.points.length === 1) return Math.hypot(p.x - stroke.points[0].x, p.y - stroke.points[0].y) > radius;
      return !stroke.points.some((point, index) => index && distanceToSegment(p, stroke.points[index - 1], point) < radius);
    });
  }
  undo() {
    if (this._drawing) return;
    const previous = this.history.pop();
    if (!previous) return;
    this.strokes = previous;
    this.render();
    this.onChange(this.getState());
  }
  clear() {
    if (this._drawing) return;
    this.snapshot();
    this.strokes = [];
    this.render();
    this.onChange(this.getState());
  }
  addText(value) {
    const text = String(value).trim().slice(0, 180);
    if (!text || this._drawing) return false;
    this.snapshot();
    const lines = this.getLines();
    const lastBottom = lines.length ? Math.max(...lines.map(line => (line.bbox.y + line.bbox.height) * HEIGHT)) : 35;
    const y = Math.max(100, lastBottom + 80);
    if (y > HEIGHT - 35) { this.history.pop(); return false; }
    this.ctx.font = '48px "Caveat", "Segoe Print", cursive';
    this.strokes.push({id: id(), kind: 'text', text, x: 82, y, width: Math.min(WIDTH - 120, this.ctx.measureText(text).width)});
    this.render();
    this.onChange(this.getState());
    return true;
  }
  getLines() { return groupStrokesIntoLines(this.strokes); }
  draw(context) {
    context.strokeStyle = INK;
    context.fillStyle = INK;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const stroke of this.strokes) {
      if (stroke.kind === 'text') {
        context.font = '48px "Caveat", "Segoe Print", cursive';
        context.fillText(stroke.text, stroke.x, stroke.y, WIDTH - 120);
        continue;
      }
      const points = stroke.points;
      if (points.length === 1) {
        context.beginPath(); context.arc(points[0].x, points[0].y, 2.2, 0, Math.PI * 2); context.fill(); continue;
      }
      context.beginPath();
      context.lineWidth = 3.5;
      context.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length - 1; i++) {
        const next = points[i + 1];
        context.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + next.x) / 2, (points[i].y + next.y) / 2);
      }
      context.lineTo(points.at(-1).x, points.at(-1).y);
      context.stroke();
    }
  }
  render() {
    this.ctx.clearRect(0, 0, WIDTH, HEIGHT);
    this.draw(this.ctx);
  }
  toDataURL() {
    const output = document.createElement('canvas');
    output.width = WIDTH; output.height = HEIGHT;
    const context = output.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, WIDTH, HEIGHT);
    this.draw(context);
    return output.toDataURL('image/png');
  }
  destroy() {
    for (const [name, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener(name, fn);
  }
}
