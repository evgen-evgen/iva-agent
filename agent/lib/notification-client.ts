// Tiny framework-independent enhancement loaded by LibreChat's stock index.html.
// It deliberately uses only DOM APIs so a LibreChat image update cannot couple it
// to private React component names or hashed bundles.
const notificationCss = String.raw`
  #iva-notification-button{position:fixed;right:76px;top:10px;z-index:10001;width:38px;height:38px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;background:color-mix(in srgb,Canvas 94%,transparent);color:CanvasText;display:grid;place-items:center;cursor:pointer;box-shadow:0 4px 16px #0002;font:20px system-ui}
  #iva-notification-button:hover{background:color-mix(in srgb,CanvasText 8%,Canvas)}
  #iva-notification-badge{position:absolute;right:-5px;top:-5px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#dc2626;color:white;font:700 11px/18px system-ui;text-align:center;display:none}
  #iva-notification-panel{position:fixed;right:12px;top:58px;z-index:10000;width:min(390px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 76px));overflow:hidden;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:16px;background:Canvas;color:CanvasText;box-shadow:0 18px 50px #0005;display:none;font:14px system-ui}
  #iva-notification-panel[data-open=true]{display:flex;flex-direction:column}
  #iva-notification-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent)}
  #iva-notification-head strong{font-size:15px}
  #iva-notification-readall{border:0;background:transparent;color:#3b82f6;cursor:pointer;font:inherit}
  #iva-notification-list{overflow:auto;padding:8px}
  .iva-notification{width:100%;text-align:left;border:0;border-radius:12px;background:transparent;color:inherit;padding:11px 12px;cursor:pointer;display:block}
  .iva-notification:hover{background:color-mix(in srgb,CanvasText 7%,Canvas)}
  .iva-notification[data-unread=true]{background:color-mix(in srgb,#3b82f6 12%,Canvas)}
  .iva-notification-title{display:flex;gap:8px;align-items:flex-start;font-weight:650}
  .iva-notification-dot{width:7px;height:7px;margin-top:6px;border-radius:50%;background:#3b82f6;flex:0 0 auto}
  .iva-notification-body{margin-top:5px;white-space:pre-wrap;overflow-wrap:anywhere;color:color-mix(in srgb,CanvasText 78%,transparent);line-height:1.35}
  .iva-notification-time{margin-top:7px;color:color-mix(in srgb,CanvasText 52%,transparent);font-size:12px}
  #iva-notification-empty{padding:30px 18px;text-align:center;color:color-mix(in srgb,CanvasText 58%,transparent)}
  @media(max-width:640px){#iva-notification-button{right:58px;top:9px}}
`;

export const notificationClientScript = String.raw`
(() => {
  if (window.__ivaNotificationsLoaded) return;
  window.__ivaNotificationsLoaded = true;
  const api = location.origin + '/api/iva/notifications';
  const seenKey = 'iva-notifications-last-seen';
  let items = [];
  let unreadCount = 0;
  let hasMore = false;
  const expandedBodies = new Map();
  let open = false;
  let authorization = '';

  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(notificationCss)};
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.id = 'iva-notification-button';
  button.type = 'button';
  button.title = 'Уведомления Ивы';
  button.setAttribute('aria-label', 'Уведомления Ивы');
  button.hidden = false;
  button.innerHTML = '<span aria-hidden="true">🔔</span><span id="iva-notification-badge"></span>';
  const panel = document.createElement('section');
  panel.id = 'iva-notification-panel';
  panel.setAttribute('aria-label', 'Уведомления Ивы');
  panel.innerHTML = '<div id="iva-notification-head"><strong>Уведомления Ивы</strong><button id="iva-notification-readall" type="button">Прочитать все</button></div><div id="iva-notification-list"></div>';
  document.body.append(button, panel);

  const badge = button.querySelector('#iva-notification-badge');
  const list = panel.querySelector('#iva-notification-list');
  const readAll = panel.querySelector('#iva-notification-readall');

  const urlReport = () => new URL(location.href).searchParams.get('iva_report') || '';
  // Keep the Telegram destination through LibreChat's sign-in redirect.
  if (urlReport()) sessionStorage.setItem('iva-report-to-open', urlReport());
  const requestedReport = () => urlReport() || sessionStorage.getItem('iva-report-to-open') || '';

  const rememberAuthorization = (value) => {
    if (typeof value !== "string" || !/^Bearer\s+\S+$/i.test(value)) return;
    const changed = authorization !== value;
    authorization = value;
    button.hidden = false;
    if (changed) { void refresh(false); if (requestedReport() && !openingReport) void openReport(requestedReport()); }
  };
  window.addEventListener("tokenUpdated", (event) => {
    if (event && typeof event.detail === "string") {
      rememberAuthorization("Bearer " + event.detail);
    } else {
      authorization = ''; items = []; unreadCount = 0; expandedBodies.clear(); render();
    }
  });
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ivaRequestUrl = String(url);
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === "authorization") {
      try {
        const target = new URL(this.__ivaRequestUrl || "/", location.href);
        if (target.origin === location.origin && target.pathname.startsWith("/api/")) {
          rememberAuthorization(String(value));
        }
      } catch {}
    }
    return xhrSetRequestHeader.apply(this, arguments);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    try {
      const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (target.origin === location.origin && target.pathname.startsWith('/api/') && !target.pathname.startsWith('/api/iva/notifications')) {
        const headers = new Headers(options && options.headers || (input instanceof Request ? input.headers : undefined));
        rememberAuthorization(headers.get('Authorization'));
      }
    } catch {}
    return originalFetch(input, options);
  };
  const bootstrapAuthorization = async () => {
    if (authorization) return;
    try {
      const response = await originalFetch(location.origin + '/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      if (!response.ok) return;
      const session = await response.json();
      if (!authorization && typeof session.token === 'string') rememberAuthorization('Bearer ' + session.token);
    } catch {}
  };

  const request = async (path = "", options) => {
    if (!authorization) throw new Error("Войди в LibreChat, чтобы открыть входящие Ивы.");
    const response = await fetch(api + path, {
      cache: "no-store",
      ...options,
      headers: { ...(options && options.headers), Authorization: authorization },
    });
    if (response.status === 401 || response.status === 403) { items = []; unreadCount = 0; render(); }
    if (!response.ok) throw new Error(response.status === 403 ? 'Для этой учётной записи входящие Ивы не разрешены. Обратись к администратору.' : response.status === 410 ? 'Этот чат отчёта был удалён.' : 'Не удалось загрузить данные. Попробуй ещё раз.');
    return response.json();
  };
  const formatTime = (value) => {
    try { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
    catch { return value; }
  };
  const render = () => {
    const unread = unreadCount;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.style.display = unread ? 'block' : 'none';
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.id = 'iva-notification-empty';
      empty.textContent = 'Новых уведомлений нет';
      list.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'iva-notification';
      row.dataset.unread = String(!item.readAt);
      row.dataset.id = item.id;
      const heading = document.createElement('div');
      heading.className = 'iva-notification-title';
      if (!item.readAt) {
        const dot = document.createElement('span');
        dot.className = 'iva-notification-dot';
        heading.appendChild(dot);
      }
      const title = document.createElement('span');
      title.textContent = item.title;
      heading.appendChild(title);
      const body = document.createElement('div');
      body.className = 'iva-notification-body';
      body.textContent = expandedBodies.get(item.id) || item.body;
      const time = document.createElement('div');
      time.className = 'iva-notification-time';
      time.textContent = formatTime(item.createdAt);
      row.append(heading, body, time);
      row.addEventListener('click', () => void openNotification(item));
      list.appendChild(row);
    }
    if (hasMore) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'iva-notification';
      more.textContent = 'Показать ещё';
      more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const page = await request('?offset=' + items.length);
          const existing = new Set(items.map((item) => item.id));
          items.push(...page.notifications.filter((item) => !existing.has(item.id)));
          hasMore = page.hasMore;
          render();
        } catch (error) { more.textContent = error.message; more.disabled = false; }
      });
      list.appendChild(more);
    }
  };

  let openingReport = false;
  const showError = (error) => {
    open = true; panel.dataset.open = 'true';
    const failure = document.createElement('div');
    failure.id = 'iva-notification-empty'; failure.textContent = error.message;
    list.prepend(failure);
  };
  const openReport = async (id) => {
    if (openingReport) return;
    openingReport = true;
    try {
      const chat = await request('/' + encodeURIComponent(id) + '/chat');
      await request('/' + encodeURIComponent(id) + '/read', { method: 'POST' });
      sessionStorage.removeItem('iva-report-to-open');
      location.assign('/c/' + encodeURIComponent(chat.conversationId));
    } catch (error) { showError(error); }
    finally { openingReport = false; }
  };
  const openNotification = async (item) => {
    if (item.kind === 'report') return openReport(item.id);
    try {
      const data = await request('/' + encodeURIComponent(item.id));
      expandedBodies.set(item.id, data.notification.body);
      // Reminders and alerts stay here as full plain text, without another composer.
      const selected = list.querySelector('[data-id="' + item.id + '"]');
      if (selected) selected.querySelector('.iva-notification-body').textContent = data.notification.body;
      await request('/' + encodeURIComponent(item.id) + '/read', { method: 'POST' });
      if (!item.readAt) unreadCount = Math.max(0, unreadCount - 1);
      item.readAt = new Date().toISOString();
      badge.textContent = String(unreadCount); badge.style.display = unreadCount ? 'block' : 'none';
      if (selected) selected.dataset.unread = 'false';
    } catch (error) { showError(error); }
  };
  const refresh = async (announce = true) => {
    try {
      const payload = await request();
      const fresh = Array.isArray(payload.notifications) ? payload.notifications : [];
      // Keep older loaded pages when polling for new arrivals.
      const freshIds = new Set(fresh.map((item) => item.id));
      items = [...fresh, ...items.filter((item) => !freshIds.has(item.id))];
      unreadCount = payload.unread || 0;
      hasMore = payload.hasMore && (items.length <= fresh.length || hasMore);
      const previous = localStorage.getItem(seenKey) || '';
      const newest = items.reduce((max, item) => item.createdAt > max ? item.createdAt : max, previous);
      if (announce && previous && 'Notification' in window && Notification.permission === 'granted') {
        for (const item of items.filter((entry) => !entry.readAt && entry.createdAt > previous).reverse()) {
          new Notification(item.title || 'Iva', { body: item.body, tag: 'iva-' + item.id });
        }
      }
      if (newest) localStorage.setItem(seenKey, newest);
      render();
    } catch (error) {
      console.warn('[iva-notifications]', error);
      list.replaceChildren();
      const failure = document.createElement('div');
      failure.id = 'iva-notification-empty';
      failure.textContent = error.message;
      list.appendChild(failure);
    }
  };

  button.addEventListener('click', async () => {
    open = !open;
    panel.dataset.open = String(open);
    if (open && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
    await refresh(false);
  });
  readAll.addEventListener('click', async () => {
    await request('/read-all', { method: 'POST' });
    const at = new Date().toISOString();
    for (const item of items) item.readAt ||= at;
    unreadCount = 0;
    render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  void refresh(false);
  setTimeout(() => void bootstrapAuthorization(), 1000);
  setInterval(() => void refresh(), 15000);
})();
`;
