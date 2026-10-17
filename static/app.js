import { Whiteboard } from './board.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const storageKey = 'margin.workspace.v1';
const PAUSE_MS = 2000;
let problem = '';
let subject = 'Math';
let revision = 0;
let problemVersion = 0;
let analysis = null;
let messages = [];
let connection = { connected: false, provider: null };
let checkTimer;
let saveTimer;
let toastTimer;
let pendingRevision = null;
let checkInFlight = false;
let lastActivity = 0;
let chatInFlight = false;
let statusInFlight = false;
let authPending = false;
let authPoll;
let authTimeout;
let initializing = true;
let storageWarned = false;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function el(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function toast(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('The local server returned an unexpected response. Please try again.'); }
  if (!response.ok) {
    const error = data.detail || data.error || data.message;
    const text = typeof error === 'string' ? error : error?.message || 'Your tutor could not respond just now.';
    throw new Error(text);
  }
  return data;
}
function errorText(error) {
  if (error instanceof TypeError) return 'The local server is unavailable. Check that it is still running, then try again.';
  const text = String(error?.message || 'Something went wrong. Please try again.');
  if (/api.?key|not configured|not connected|sign.?in|unauthorized|credentials/i.test(text)) {
    return 'Your tutor needs a connection. Open the connection settings above to sign in or configure the Gemini fallback.';
  }
  if (/429|quota|rate.?limit/i.test(text)) return 'Your AI provider is at its usage limit. Give it a moment or check your provider’s available quota, then try again.';
  return text.length > 360 ? `${text.slice(0, 357)}…` : text;
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ problem, subject, board: board.getState(), messages: messages.slice(-24) })); }
    catch {
      $('.autosave').lastChild.textContent = 'Saving unavailable';
      if (!storageWarned) { toast('Browser storage is full or unavailable. Keep this tab open to preserve your board.'); storageWarned = true; }
    }
  }, 200);
}
function updateProblem() {
  $('#problem-title').textContent = problem || 'What are we working on?';
  $('#subject-tag').textContent = subject;
}
function setNote(text, checking = false) {
  $('#board-note').textContent = text;
  $('.board-top-note').classList.toggle('checking', checking);
}
function setFeedbackStatus(text, checking = false) {
  $('#feedback-status').textContent = text;
  $('#feedback-status').classList.toggle('checking', checking);
}
const welcomeTemplate = $('#feedback').innerHTML;
function welcome() {
  $('#feedback').innerHTML = welcomeTemplate;
  setFeedbackStatus('Waiting for your first step');
  setNote(problem ? 'Your space to work it out' : 'Start with a problem');
}
function setTool(tool) {
  board.setTool(tool);
  ['pen', 'eraser'].forEach((name) => {
    $(`#${name}-tool`).classList.toggle('active', name === tool);
    $(`#${name}-tool`).setAttribute('aria-pressed', String(name === tool));
  });
  $('#drawing-canvas').style.cursor = tool === 'eraser' ? 'cell' : 'crosshair';
}
function changed() {
  if (initializing) return;
  revision += 1;
  lastActivity = Date.now();
  pendingRevision = null;
  clearTimeout(checkTimer);
  analysis = null;
  $('#annotations').replaceChildren();
  $('#board-empty').hidden = !board.isEmpty();
  $('#recheck-button').disabled = !connection.connected || board.isEmpty() || checkInFlight || !problem;
  save();
  if (board.isEmpty()) { welcome(); return; }
  if (!problem) { setNote('Add a problem so your tutor can follow along'); return; }
  if (!connection.connected) { welcome(); setNote('Your work is saved. Connect your tutor for feedback.'); setFeedbackStatus('Tutor is offline'); return; }
  setNote('Take your time. I’ll check when you pause.');
  setFeedbackStatus('Following your work');
  renderUpdating();
  scheduleCheck();
}
const board = new Whiteboard($('#drawing-canvas'), { onChange: changed });
$('#drawing-canvas').addEventListener('boardactivity', (event) => {
  if (event.detail?.drawing) {
    revision += 1;
    lastActivity = Date.now();
    clearTimeout(checkTimer);
    pendingRevision = null;
    $('#annotations').replaceChildren();
    if (analysis) { analysis = null; renderUpdating(); }
    setNote('Your space to work it out');
  } else {
    lastActivity = Date.now();
    scheduleCheck();
  }
});
function renderUpdating() {
  if (!connection.connected) return;
  const card = el('div', 'feedback-card neutral');
  const title = el('div', 'feedback-title', 'Following your thinking');
  title.prepend(icon('pen'));
  card.append(title, el('p', '', 'Keep going. I’ll check your latest work after a short pause.'));
  $('#feedback').replaceChildren(card);
}
function scheduleCheck(immediate = false) {
  clearTimeout(checkTimer);
  if (!problem || board.isEmpty() || !connection.connected || board.isDrawing) return;
  const snapshot = revision;
  const wait = immediate ? 0 : Math.max(0, PAUSE_MS - (Date.now() - lastActivity));
  checkTimer = setTimeout(() => {
    if (snapshot !== revision || board.isDrawing) return;
    pendingRevision = snapshot;
    runPendingCheck();
  }, wait);
}
async function runPendingCheck() {
  if (checkInFlight || pendingRevision === null || board.isDrawing || board.isEmpty() || !connection.connected || !problem) return;
  const snapshot = pendingRevision;
  pendingRevision = null;
  if (snapshot !== revision) return;
  checkInFlight = true;
  $('#recheck-button').disabled = true;
  $('#recheck-button .icon').classList.add('spin');
  setFeedbackStatus('Checking your steps…', true);
  setNote('Looking over your latest work…', true);
  const sentLines = board.getLines();
  try {
    const result = await request('/api/analyze', {
      method: 'POST', body: JSON.stringify({ problem, image: board.toDataURL(), lines: sentLines, revision: snapshot }),
    });
    if (snapshot !== revision || board.isDrawing || (result.revision !== undefined && Number(result.revision) !== snapshot)) return;
    analysis = result;
    renderAnalysis(result, sentLines);
  } catch (error) {
    if (snapshot !== revision) return;
    setFeedbackStatus('Couldn’t check this time');
    setNote('Your writing is safe. Try checking again.');
    const card = el('div', 'feedback-card neutral feedback-failure');
    card.append(el('div', 'feedback-title', 'Let’s try that again'), el('p', '', errorText(error)));
    const retry = el('button', '', 'Retry this check →');
    retry.addEventListener('click', () => scheduleCheck(true));
    card.append(retry);
    $('#feedback').replaceChildren(card);
  } finally {
    checkInFlight = false;
    $('#recheck-button .icon').classList.remove('spin');
    $('#recheck-button').disabled = !connection.connected || board.isEmpty() || !problem;
    if (pendingRevision !== null) runPendingCheck();
  }
}
function createCard(type, title, body, iconName) {
  const card = el('div', `feedback-card ${type}`);
  const heading = el('div', 'feedback-title', title);
  if (iconName) heading.prepend(icon(iconName));
  card.append(heading);
  if (body) card.append(el('p', '', body));
  return card;
}
function renderAnalysis(result, sentLines) {
  const lines = Array.isArray(result.lines) ? result.lines : [];
  const firstError = lines.find((line) => String(line.id) === String(result.firstErrorLineId)) || lines.find((line) => line.status === 'incorrect');
  const uncertain = lines.find((line) => line.status === 'uncertain');
  const correct = lines.filter((line) => line.status === 'correct');
  const fragment = document.createDocumentFragment();
  if (result.solved && !firstError && !uncertain) {
    fragment.append(createCard('solved', 'You worked it out.', result.summary || 'Your steps check out. Take a moment to notice how you got here.', 'check'));
    setNote('A little guidance. You did the thinking.');
    setFeedbackStatus('Nicely done');
  } else if (firstError) {
    const index = lines.indexOf(firstError) + 1;
    const card = createCard('error', `Line ${index}: let’s take another look`, firstError.hint || 'Compare this line with the one before it. What changed?', 'info');
    if (firstError.text) card.append(el('code', 'read-equation', `I read: ${firstError.text}`));
    const actions = el('div', 'feedback-actions');
    const hint = el('button', '', 'Show hint 2');
    const why = el('button', '', 'Why?');
    const dismiss = el('button', '', 'Dismiss');
    function reveal(text, fallbackQuestion, button) {
      if (!text) { sendChat(fallbackQuestion); return; }
      const old = card.querySelector('.feedback-detail');
      if (old) old.remove();
      card.append(el('p', 'feedback-detail', text));
    }
    hint.addEventListener('click', () => reveal(firstError.hint2, `Give me a stronger hint for line ${index}, without revealing the full answer.`, hint));
    why.addEventListener('click', () => reveal(firstError.explanation, `Why is line ${index} incorrect? Explain the underlying idea without solving the problem for me.`, why));
    dismiss.addEventListener('click', () => { card.remove(); toast('Hint dismissed. Your tutor will check again when you write.'); });
    actions.append(hint, why, dismiss); card.append(actions); fragment.append(card);
    setNote(`Take another look at line ${index}`);
    setFeedbackStatus('A small nudge');
  } else if (uncertain) {
    const index = lines.indexOf(uncertain) + 1;
    const card = createCard('uncertain', `Let’s clarify line ${index}`, uncertain.hint || 'I’m not quite sure I read this correctly. Could you rewrite it a little more clearly?', 'info');
    if (uncertain.text) card.append(el('code', 'read-equation', `I read: ${uncertain.text}`));
    fragment.append(card);
    setNote('A clearer line will help your tutor follow along');
    setFeedbackStatus('A quick clarification');
  } else {
    setNote(correct.length ? 'Looking good. Keep thinking it through.' : 'Ready for your next step');
    setFeedbackStatus(correct.length ? `${correct.length} ${correct.length === 1 ? 'step' : 'steps'} checked` : 'Keep going');
  }
  if (correct.length && !result.solved) {
    const last = correct[correct.length - 1];
    const index = lines.indexOf(last) + 1;
    const card = createCard('success', correct.length > 1 ? `${correct.length} steps look good` : `Line ${index} looks good`, last.hint || (firstError ? 'You’ve got a solid start. Focus on the first step that changed.' : result.summary || 'Your reasoning is on track. What comes next?'), 'check');
    if (correct.some((line) => line.verifiedBy === 'sympy')) {
      const verified = el('div', 'verified-label', 'Checked with symbolic math');
      verified.prepend(icon('check')); card.append(verified);
    }
    fragment.append(card);
  }
  if (!fragment.childNodes.length) fragment.append(createCard('neutral', 'Ready for your next step', result.summary || 'Add a complete step on the board, and I’ll take a look.', 'pen'));
  $('#feedback').replaceChildren(fragment);
  renderAnnotations(lines, firstError, sentLines);
}
function renderAnnotations(lines, firstError, sentLines) {
  $('#annotations').replaceChildren();
  lines.forEach((line, index) => {
    const source = sentLines.find((item) => String(item.id) === String(line.id));
    const box = line.bbox || source?.bbox;
    if (!box) return;
    let { x = .08, y = .1 + index * .1, width = .35, height = .07 } = box;
    if (width > 1 || height > 1 || x > 1 || y > 1) { x /= 1200; width /= 1200; y /= 900; height /= 900; }
    if (![x, y, width, height].every(Number.isFinite)) return;
    x = Math.max(0, Math.min(.94, x)); y = Math.max(0, Math.min(.96, y));
    width = Math.max(.03, Math.min(1 - x, width)); height = Math.max(.025, Math.min(1 - y, height));
    const number = el('span', 'line-number', String(index + 1));
    Object.assign(number.style, { left: `${Math.max(.025, x) * 100}%`, top: `${y * 100}%` });
    $('#annotations').append(number);
    if (line.status === 'correct') {
      const mark = el('div', 'line-check'); mark.append(icon('check'));
      Object.assign(mark.style, { left: `${Math.min(.94, x + width) * 100}%`, top: `${(y + height / 2) * 100}%` });
      $('#annotations').append(mark);
    } else if (line.status === 'incorrect' || line.status === 'uncertain') {
      const highlight = el('div', `line-highlight ${line.status === 'uncertain' ? 'uncertain' : ''}`);
      Object.assign(highlight.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` });
      $('#annotations').append(highlight);
      if (line === firstError) {
        const badge = el('span', 'line-warning', 'Check this line');
        const fitsRight = x + width < .7;
        Object.assign(badge.style, { left: `${(fitsRight ? x + width : x) * 100}%`, top: `${(fitsRight ? y + height / 2 : y + height) * 100}%` });
        $('#annotations').append(badge);
      }
    }
  });
}
function appendMessage(role, content, extraClass = '') {
  $('#chat-empty')?.remove();
  const message = el('div', `message ${role} ${extraClass}`, content);
  $('#messages').append(message);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return message;
}
function renderMessages() {
  if (!messages.length) return;
  $('#messages').replaceChildren();
  messages.forEach((message) => appendMessage(message.role, message.content));
}
async function sendChat(value) {
  const text = String(value || '').trim();
  if (!text || chatInFlight) return;
  if (!problem) { openProblem(); toast('Add your problem first so your tutor knows the context.'); return; }
  if (!connection.connected) { openConnection(); return; }
  const currentProblem = problem;
  const currentProblemVersion = problemVersion;
  chatInFlight = true;
  $('#chat-send').disabled = true;
  messages.push({ role: 'user', content: text });
  appendMessage('user', text);
  $('#chat-input').value = '';
  $('#chat-input').style.height = 'auto';
  const thinking = appendMessage('assistant', '', 'thinking');
  for (let i = 0; i < 3; i++) thinking.append(el('span', 'thinking-dot'));
  try {
    const result = await request('/api/chat', { method: 'POST', body: JSON.stringify({ problem, image: board.toDataURL(), lines: analysis?.lines || board.getLines(), messages: messages.slice(-20) }) });
    if (problem !== currentProblem || problemVersion !== currentProblemVersion) return;
    if (!result.reply) throw new Error('Your tutor sent an empty reply. Please try again.');
    messages.push({ role: 'assistant', content: result.reply });
    appendMessage('assistant', result.reply);
    save();
  } catch (error) {
    if (problem === currentProblem && problemVersion === currentProblemVersion) appendMessage('assistant', errorText(error), 'error-message');
  } finally {
    thinking.remove(); chatInFlight = false; $('#chat-send').disabled = false;
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
}
function openProblem() {
  $('#problem-input').value = problem;
  $$('.problem-presets button').forEach((button) => button.classList.remove('selected'));
  $('#problem-dialog').showModal();
  setTimeout(() => $('#problem-input').focus(), 70);
}
function beginProblem(text, nextSubject = 'Math') {
  problem = text.trim(); subject = nextSubject;
  problemVersion += 1;
  revision += 1;
  analysis = null; messages = []; pendingRevision = null;
  clearTimeout(checkTimer);
  $('#messages').innerHTML = '<div class="chat-empty" id="chat-empty"><p>Stuck on a step?<br>Let’s think it through together.</p><div class="chat-suggestions"><button data-question="Can you give me a hint for my next step?">Give me a hint <span>↗</span></button><button data-question="Can you explain the last step on my board?">Explain my last step <span>↗</span></button></div></div>';
  board.clear();
  board.setState([]); // A new problem must not inherit the previous board's undo history.
  updateProblem(); welcome(); save();
  $('#board-empty').hidden = false;
  $('#annotations').replaceChildren();
  $('#problem-dialog').close(); $('#type-form').hidden = true;
  setTool('pen');
}
function toggleTyping(show = $('#type-form').hidden) {
  if (!problem) { openProblem(); return; }
  $('#type-form').hidden = !show;
  $('#type-tool').classList.toggle('typing', show);
  if (show) $('#typed-step').focus();
}
function openConnection() { updateConnectionUI(); $('#connection-dialog').showModal(); }
function updateConnectionUI() {
  const connected = !!connection.connected;
  const provider = connection.provider === 'chatgpt' ? 'ChatGPT' : connection.provider === 'gemini' ? 'Gemini' : 'AI';
  $('#connection-button').classList.toggle('connected', connected);
  $('#connection-button').classList.toggle('busy', authPending && !connected);
  const verified = connection.connectionState === 'verified';
  $('#connection-label').textContent = connected ? `${provider} ${verified ? 'connected' : connection.provider === 'chatgpt' ? 'signed in' : 'configured'}` : authPending ? 'Waiting for sign-in' : 'Connect your tutor';
  $('#connection-card').hidden = connected;
  $('#tutor-live').textContent = connected ? 'LIVE' : 'READY';
  $('#tutor-live').classList.toggle('online', connected);
  $('#verification-label').textContent = connection.sympy ? 'Symbolic math + AI' : 'AI can make mistakes.';
  $('#recheck-button').disabled = !connected || board.isEmpty() || checkInFlight || !problem;
  $('#connection-modal-title').textContent = connected ? 'Your tutor is ready.' : 'A tutor, right beside you.';
  $('#connection-description').textContent = connected ? `Your whiteboard is connected to ${provider}. Pause after writing a step, and your tutor will take a look.` : 'Connect your ChatGPT account to get live feedback. You can keep writing while you connect.';
  $('#sign-in-button').hidden = false;
  $('#sign-in-button').firstChild.textContent = authPending ? 'Open ChatGPT sign-in again ' : connected && connection.provider === 'chatgpt' ? 'Reconnect ChatGPT ' : 'Continue with ChatGPT ';
  $('#connection-footnote').textContent = authPending ? 'Finish signing in in the other window. This page will reconnect automatically.' : location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? 'If you’re using a tablet, complete sign-in on the laptop running Margin.' : 'Sign-in opens in a separate window. Your writing stays here.';
  $('#connection-details').hidden = !connected;
  if (connected) {
    $('#connection-details').replaceChildren(el('div', '', `Provider: ${provider}`));
    if (connection.model) $('#connection-details').append(el('div', '', `Model: ${connection.model}`));
    $('#connection-details').append(el('div', '', connection.sympy ? 'Symbolic math verification is available.' : 'Steps will be checked by your AI tutor.'));
  }
  if (connection.authError) {
    $('#connection-details').hidden = false;
    if (!connected) $('#connection-details').replaceChildren();
    $('#connection-details').append(el('div', 'connection-error', String(connection.authError).slice(0, 350)));
  }
}
async function refreshStatus() {
  if (statusInFlight) return;
  statusInFlight = true;
  try {
    const before = connection.connected;
    connection = await request('/api/status');
    if (connection.connected) {
      if (authPending && connection.provider === 'chatgpt') {
        authPending = false; clearInterval(authPoll); clearTimeout(authTimeout);
        $('#connection-dialog').close(); toast('Your ChatGPT tutor is connected. Let’s work it out.');
      }
      if (!before && !board.isEmpty()) { lastActivity = Date.now(); scheduleCheck(); }
    }
    updateConnectionUI();
  } catch {
    connection = { connected: false, provider: null };
    updateConnectionUI();
    $('#connection-label').textContent = 'Server unavailable';
  } finally { statusInFlight = false; }
}
function signIn() {
  const authWindow = window.open('/auth/start', 'margin-provider-signin', 'popup=yes,width=560,height=740');
  // Embedded browsers can open a tab without returning a WindowProxy. Polling
  // must still begin; a null return does not prove that sign-in was blocked.
  authPending = true;
  updateConnectionUI();
  $('#connection-dialog').close();
  toast(authWindow ? 'Complete sign-in in the other window. Your board is ready to use.' : 'Sign-in opens in another tab. If it doesn’t appear, allow pop-ups and try again.');
  clearInterval(authPoll);
  clearTimeout(authTimeout);
  authPoll = setInterval(refreshStatus, 2500);
  authTimeout = setTimeout(() => { clearInterval(authPoll); authPending = false; updateConnectionUI(); }, 300000);
}

$('#pen-tool').addEventListener('click', () => setTool('pen'));
$('#eraser-tool').addEventListener('click', () => setTool('eraser'));
$('#undo-tool').addEventListener('click', () => board.undo());
$('#clear-tool').addEventListener('click', () => { if (!board.isEmpty()) $('#clear-dialog').showModal(); });
$('#confirm-clear').addEventListener('click', () => { board.clear(); $('#clear-dialog').close(); });
$('#new-problem').addEventListener('click', openProblem);
$('#edit-problem').addEventListener('click', openProblem);
$('#type-tool').addEventListener('click', () => toggleTyping());
$('#empty-type').addEventListener('click', () => toggleTyping(true));
$('#close-type').addEventListener('click', () => toggleTyping(false));
$('#recheck-button').addEventListener('click', () => scheduleCheck(true));
$('#type-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('#typed-step').value.trim();
  if (!text) return;
  if (!board.addText(text)) { toast('This board is full. Clear some space or start a new problem.'); return; }
  $('#typed-step').value = ''; $('#typed-step').focus();
});
$('#try-example').addEventListener('click', () => {
  if (!problem) { openProblem(); return; }
  const isDemo = /2\s*\(\s*x\s*[-−]\s*3\s*\)\s*=\s*10/.test(problem);
  if (isDemo) {
    board.addText('2(x − 3) = 10');
    board.addText('2x − 3 = 10');
    toast('Example added with a distribution mistake. Try correcting the second line.');
  } else {
    board.addText(problem.replace(/^(solve|find|simplify|calculate|evaluate)\s*:?[\s]*/i, ''));
    toast('Your problem is on the board. Add the next step.');
  }
});
$('#problem-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('#problem-input').value.trim();
  if (!text) return;
  const preset = $$('.problem-presets button').find((button) => button.dataset.problem === text);
  beginProblem(text, preset?.dataset.subject || 'Math');
});
$$('.problem-presets button').forEach((button) => button.addEventListener('click', () => {
  $('#problem-input').value = button.dataset.problem;
  $$('.problem-presets button').forEach((item) => item.classList.toggle('selected', item === button));
}));
$$('[data-close]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
}));
$('#connection-button').addEventListener('click', openConnection);
$('#inline-connect').addEventListener('click', openConnection);
$('#sign-in-button').addEventListener('click', signIn);
$('#refresh-connection').addEventListener('click', async () => {
  await refreshStatus(); toast(connection.connected ? 'Your tutor is connected.' : 'No connection yet. Complete sign-in or configure the Gemini fallback.');
});
$('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); sendChat($('#chat-input').value); });
$('#messages').addEventListener('click', (event) => {
  const question = event.target.closest('[data-question]');
  if (question) sendChat(question.dataset.question);
});
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat($('#chat-input').value); }
});
$('#chat-input').addEventListener('input', () => { $('#chat-input').style.height = 'auto'; $('#chat-input').style.height = `${Math.min(90, $('#chat-input').scrollHeight)}px`; });
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input,textarea,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); board.undo(); }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'p') setTool('pen');
  if (event.key.toLowerCase() === 'e') setTool('eraser');
  if (event.key.toLowerCase() === 't') { event.preventDefault(); toggleTyping(true); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
window.addEventListener('message', (event) => { if (event.origin === location.origin && ['margin-auth-complete', 'margin-auth'].includes(event.data?.type)) refreshStatus(); });

// Keep upcoming features visibly separate from this demo's working tutor.
const patterns = el('section', 'patterns-section');
patterns.setAttribute('aria-label', 'Your patterns this session, coming later');
const patternsHeading = el('div', 'section-label');
patternsHeading.append(el('h3', '', 'YOUR PATTERNS THIS SESSION'), el('span', 'future-badge', 'COMING LATER'));
patterns.append(patternsHeading, el('p', '', 'Personalized practice, built around how you learn.'));
$('.chat-section').insertBefore(patterns, $('#chat-form'));
$('.api-help summary').textContent = 'Using Gemini as a fallback?';
$('.api-help p').innerHTML = 'Add your Gemini key as <code>LLM_API_KEY</code> in the local server’s <code>.env</code> file, then check the connection again. Provider billing is separate from ChatGPT. Never paste a key into the whiteboard or chat.';

try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (stored && typeof stored.problem === 'string') {
    problem = stored.problem; subject = stored.subject || 'Math';
    if (stored.board) board.setState(stored.board);
    messages = Array.isArray(stored.messages) ? stored.messages.filter((message) => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').slice(-24) : [];
    renderMessages();
  }
} catch { /* A damaged browser save should never stop a fresh workspace. */ }
initializing = false;
updateProblem();
$('#board-empty').hidden = !board.isEmpty();
setTool('pen');
document.fonts?.load('48px Caveat').then(() => board.render()).catch(() => {});
refreshStatus();
setInterval(refreshStatus, 20000);
if (!problem) setTimeout(openProblem, 180);
