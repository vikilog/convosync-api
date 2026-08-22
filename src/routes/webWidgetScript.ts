import type { FastifyInstance } from 'fastify';

/**
 * The embeddable chat bubble itself — plain JS, no build step, no framework,
 * so a customer site only pays for one small script tag. Served with open
 * CORS-equivalent semantics implicitly: `<script src>` isn't subject to CORS
 * at all, only the fetch() calls it makes are (handled in webWidgetPublic.ts).
 */
const WIDGET_JS = `(function () {
  var scriptEl = document.currentScript;
  if (!scriptEl) return;
  var token = scriptEl.getAttribute('data-token');
  if (!token) {
    console.error('[ConvoSync widget] missing data-token attribute');
    return;
  }
  var apiBase = new URL(scriptEl.src).origin + '/api/public/widget';

  var history = [];
  var config = { botName: 'Assistant', greeting: 'Hi! How can I help you today?', accentColor: '#16a34a' };
  var panelOpen = false;
  var sending = false;

  var root = document.createElement('div');
  root.id = 'convosync-widget-root';
  document.body.appendChild(root);

  var style = document.createElement('style');
  style.textContent =
    '#convosync-widget-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '.cw-bubble{width:56px;height:56px;border-radius:9999px;border:none;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;transition:transform .15s ease}' +
    '.cw-bubble:hover{transform:scale(1.06)}' +
    '.cw-panel{position:absolute;bottom:70px;right:0;width:340px;max-width:calc(100vw - 40px);height:480px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.2);display:none;flex-direction:column;overflow:hidden}' +
    '.cw-panel.open{display:flex}' +
    '.cw-header{padding:14px 16px;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:space-between}' +
    '.cw-header button{background:none;border:none;color:#fff;opacity:.85;cursor:pointer;font-size:18px;line-height:1;padding:2px}' +
    '.cw-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f7f8}' +
    '.cw-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
    '.cw-msg.user{align-self:flex-end;background:#e8f0fe;color:#0b3d91;border-bottom-right-radius:2px}' +
    '.cw-msg.bot{align-self:flex-start;background:#fff;color:#1a1a1a;border:1px solid #ececec;border-bottom-left-radius:2px}' +
    '.cw-msg.typing{color:#999;font-style:italic}' +
    '.cw-inputbar{display:flex;gap:8px;padding:10px;border-top:1px solid #ececec;background:#fff}' +
    '.cw-inputbar input{flex:1;border:1px solid #ddd;border-radius:20px;padding:8px 14px;font-size:13px;outline:none}' +
    '.cw-inputbar button{border:none;border-radius:9999px;width:34px;height:34px;color:#fff;cursor:pointer;flex-shrink:0}' +
    '.cw-inputbar button:disabled{opacity:.5;cursor:default}';
  document.head.appendChild(style);

  var bubble = document.createElement('button');
  bubble.className = 'cw-bubble';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h16v12H7l-3 3V4z" fill="white"/></svg>';
  root.appendChild(bubble);

  var panel = document.createElement('div');
  panel.className = 'cw-panel';
  root.appendChild(panel);

  var header = document.createElement('div');
  header.className = 'cw-header';
  var headerTitle = document.createElement('span');
  var closeBtn = document.createElement('button');
  closeBtn.textContent = '\\u2715';
  closeBtn.addEventListener('click', function () { togglePanel(false); });
  header.appendChild(headerTitle);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  var messagesEl = document.createElement('div');
  messagesEl.className = 'cw-messages';
  panel.appendChild(messagesEl);

  var inputBar = document.createElement('div');
  inputBar.className = 'cw-inputbar';
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a message...';
  var sendBtn = document.createElement('button');
  sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 20l18-8L3 4v6l12 2-12 2z" fill="white"/></svg>';
  inputBar.appendChild(input);
  inputBar.appendChild(sendBtn);
  panel.appendChild(inputBar);

  function applyColor(color) {
    bubble.style.background = color;
    header.style.background = color;
    sendBtn.style.background = color;
  }

  function addMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'cw-msg ' + (role === 'user' ? 'user' : 'bot');
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function togglePanel(open) {
    panelOpen = open === undefined ? !panelOpen : open;
    panel.classList.toggle('open', panelOpen);
  }
  bubble.addEventListener('click', function () { togglePanel(); });

  function send() {
    var text = input.value.trim();
    if (!text || sending) return;
    input.value = '';
    addMessage('user', text);
    history.push({ role: 'user', content: text });
    sending = true;
    sendBtn.disabled = true;
    var typingEl = addMessage('bot', 'Typing...');
    typingEl.classList.add('typing');

    fetch(apiBase + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, message: text, history: history.slice(0, -1) }),
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        typingEl.remove();
        if (!result.ok) {
          addMessage('bot', result.data && result.data.error ? result.data.error : 'Something went wrong.');
          return;
        }
        addMessage('bot', result.data.response);
        history.push({ role: 'assistant', content: result.data.response });
      })
      .catch(function () {
        typingEl.remove();
        addMessage('bot', 'Could not reach the assistant. Please try again.');
      })
      .finally(function () {
        sending = false;
        sendBtn.disabled = false;
      });
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

  fetch(apiBase + '/config?token=' + encodeURIComponent(token))
    .then(function (res) { if (!res.ok) throw new Error('bad config'); return res.json(); })
    .then(function (data) {
      config = data;
      headerTitle.textContent = config.botName;
      applyColor(config.accentColor);
      addMessage('bot', config.greeting);
    })
    .catch(function () {
      root.style.display = 'none';
      console.error('[ConvoSync widget] failed to load — check data-token');
    });
})();
`;

export default async function webWidgetScriptRoutes(fastify: FastifyInstance) {
  fastify.get('/widget.js', async (_request, reply) => {
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(WIDGET_JS);
  });
}
