/* ===================================================================
   massa — интерфейс демо-мессенджера.
   Данные берутся только через window.MassaApi (см. api.js).
   =================================================================== */
(function () {
  'use strict';

  var API = window.MassaApi;
  var DEMO = API.DEMO;

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z\u0400-\u04FF]{2,}$/;

  var PALETTE = [
    ['#c9743c', '#8f4a2a'],
    ['#d98b4a', '#a8552b'],
    ['#7f9a5c', '#4d6a38'],
    ['#a8703f', '#74441f'],
    ['#9b6bb3', '#6d4389'],
    ['#4f8a8b', '#2d5f60'],
    ['#c25c5c', '#8c3737'],
    ['#8c7a5e', '#5c4f3a']
  ];

  var THEME_KEY = 'massa.theme';

  var UI = { me: null, chats: [], favCount: 0, activeId: null, active: null, cache: { chats: {}, favorites: null }, pollTimer: null, presenceTimer: null, presence: {}, syncSig: '' };

  var authMode = 'login';
  var theme = 'light';
  var toastTimer = null;
  var searchSeq = 0;
  var searchOpen = false;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
  }

  function avatarHtml(name, color, extraClass, avatarUrl) {
    var c = PALETTE[Math.abs(color || 0) % PALETTE.length];
    var cls = 'avatar ' + (extraClass || '') + (avatarUrl ? ' has-img' : '');
    var style = '--a1:' + c[0] + ';--a2:' + c[1];

    if (avatarUrl) {
      return '<span class="' + cls + '" style="' + style + '">' +
        '<img class="avatar__img" src="' + esc(avatarUrl) + '" alt="">' +
        '</span>';
    }

    return '<span class="' + cls + '" style="' + style + '">' + esc(initials(name)) + '</span>';
  }

  function toast(text) {
    var el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
  }

  function shake() {
    var card = $('.auth__card');
    if (!card) return;
    card.classList.remove('is-shake');
    void card.offsetWidth;
    card.classList.add('is-shake');
    setTimeout(function () { card.classList.remove('is-shake'); }, 400);
  }

  /* ----------------------------- тема ------------------------------- */

  function applyTheme(t) {
    theme = t;
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  }

  function initTheme() {
    try { theme = localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { theme = 'light'; }
    applyTheme(theme === 'light' ? 'light' : 'dark');
  }

  /* ------------------------- акцентный цвет ------------------------- */

  var ACCENT_KEY = 'massa.accent.v2';

  var ACCENTS = [
    { id: 'graphite', name: 'Графит',  color: '#6e7b8b' },
    { id: 'copper',   name: 'Медь',    color: '#c9743c' },
    { id: 'amber',    name: 'Янтарь',  color: '#d99a3f' },
    { id: 'olive',    name: 'Олива',   color: '#8a9a4b' },
    { id: 'teal',     name: 'Бирюза',  color: '#3f9a92' },
    { id: 'indigo',   name: 'Индиго',  color: '#5b6ee0' },
    { id: 'violet',   name: 'Сирень',  color: '#9068c9' },
    { id: 'rose',     name: 'Роза',    color: '#d2648a' }
  ];

  var accentId = 'graphite';
  try { accentId = localStorage.getItem(ACCENT_KEY) || 'graphite'; } catch (e) { /* ignore */ }

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      var n = Math.round(Math.max(0, Math.min(255, v)));
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join('');
  }

  function hexToHsl(hex) {
    var c = hexToRgb(hex);
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0;
    var l = (max + min) / 2;
    var d = max - min;

    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }

    return { h: h, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;

    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;

    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }

    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }

  function rgbTriplet(hex) {
    var c = hexToRgb(hex);
    return c[0] + ', ' + c[1] + ', ' + c[2];
  }

  // палитра интерфейса выводится из оттенка акцента
  function paletteFor(accentHex, dark) {
    var a = hexToHsl(accentHex);
    var h = a.h;
    var ts = Math.min(26, Math.max(10, a.s * 0.45));

    if (dark) {
      return {
        bg: hslToHex(h, ts * 0.9, 6.7),
        bg2: hslToHex(h, ts * 0.9, 7.8),
        panel: hslToHex(h, ts * 0.88, 9),
        elev: hslToHex(h, ts * 0.84, 11.8),
        elev2: hslToHex(h, ts * 0.84, 14.5),
        bubbleIn: hslToHex(h, ts * 0.8, 13.5),
        text: hslToHex(h, 22, 93),
        textDim: hslToHex(h, 18, 71),
        textMute: hslToHex(h, 18, 54)
      };
    }

    return {
      bg: hslToHex(h, 32, 95.5),
      bg2: hslToHex(h, 34, 97.5),
      panel: hslToHex(h, 40, 99),
      elev: hslToHex(h, 28, 92.5),
      elev2: hslToHex(h, 26, 88),
      bubbleIn: '#ffffff',
      text: hslToHex(h, 30, 12),
      textDim: hslToHex(h, 22, 35),
      textMute: hslToHex(h, 18, 52)
    };
  }

  function mixColor(hex, target, amount) {
    var c = hexToRgb(hex);
    return rgbToHex(
      c[0] + (target[0] - c[0]) * amount,
      c[1] + (target[1] - c[1]) * amount,
      c[2] + (target[2] - c[2]) * amount
    );
  }

  function lighten(hex, k) { return mixColor(hex, [255, 245, 234], k); }
  function darken(hex, k) { return mixColor(hex, [12, 7, 4], k); }

  function luminance(hex) {
    var c = hexToRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function rgba(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  function accentPreset(id) {
    return ACCENTS.filter(function (a) { return a.id === id; })[0] || ACCENTS[0];
  }

  function applyAccent(id, persist) {
    var preset = accentPreset(id);
    accentId = preset.id;

    var dark = theme === 'dark';
    var a1 = dark ? preset.color : darken(preset.color, 0.08);
    var a2 = dark ? lighten(preset.color, 0.17) : lighten(preset.color, 0.06);
    var b1 = dark ? preset.color : darken(preset.color, 0.15);
    var b2 = dark ? darken(lighten(preset.color, 0.1), 0.16) : darken(preset.color, 0.02);

    var palette = paletteFor(preset.color, dark);
    var rootStyle = document.documentElement.style;

    rootStyle.setProperty('--bg', palette.bg);
    rootStyle.setProperty('--bg-2', palette.bg2);
    rootStyle.setProperty('--panel', palette.panel);
    rootStyle.setProperty('--elev', palette.elev);
    rootStyle.setProperty('--elev-2', palette.elev2);
    rootStyle.setProperty('--bubble-in', palette.bubbleIn);
    rootStyle.setProperty('--text', palette.text);
    rootStyle.setProperty('--text-dim', palette.textDim);
    rootStyle.setProperty('--text-mute', palette.textMute);
    rootStyle.setProperty('--text-rgb', rgbTriplet(palette.text));
    rootStyle.setProperty('--accent-rgb', rgbTriplet(a1));

    rootStyle.setProperty('--accent', a1);
    rootStyle.setProperty('--accent-2', a2);
    rootStyle.setProperty('--accent-soft', rgba(a1, dark ? 0.16 : 0.1));
    rootStyle.setProperty('--bubble-out-1', b1);
    rootStyle.setProperty('--bubble-out-2', b2);
    rootStyle.setProperty('--on-accent', luminance(a1) > 0.34 ? '#20140a' : '#ffffff');

    if (persist) {
      try { localStorage.setItem(ACCENT_KEY, preset.id); } catch (e) { /* ignore */ }
    }

    var label = $('#accent-name');
    if (label) label.textContent = preset.name;

    markActiveSwatch();
  }

  function buildSwatches() {
    var box = $('#swatches');
    if (!box) return;

    box.innerHTML = ACCENTS.map(function (a) {
      var mark = luminance(a.color) > 0.34 ? ' swatch--dark-mark' : '';
      return '<button class="swatch' + mark + '" type="button" role="radio" aria-checked="false"' +
        ' data-accent="' + a.id + '" title="' + a.name + '"' +
        ' style="--c1:' + a.color + ';--c2:' + lighten(a.color, 0.24) + '"></button>';
    }).join('');
  }

  function markActiveSwatch() {
    $$('#swatches .swatch').forEach(function (s) {
      var on = s.getAttribute('data-accent') === accentId;
      s.classList.toggle('is-active', on);
      s.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /* ---------------------------- настройки --------------------------- */

  var settingsOpen = false;

  function renderSettings() {
    if (!UI.me) return;

    $('#settings-name').textContent = UI.me.name;
    $('#settings-email').textContent = UI.me.email;
    $('#settings-role').hidden = UI.me.role !== 'admin';

    var av = $('#settings-avatar');
    if (UI.me.avatar) {
      av.innerHTML = '<img class="avatar__img" src="' + UI.me.avatar + '" alt="Аватар">';
      av.classList.add('has-img');
    } else {
      av.textContent = initials(UI.me.name);
      av.classList.remove('has-img');
    }

    buildSwatches();
    markActiveSwatch();

    $$('#theme-seg button').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-theme-opt') === theme);
    });
  }

  function openSettings() {
    if (!UI.me) return;

    renderSettings();
    settingsOpen = true;
    openSheet(document.getElementById('settings-screen'), 'is-settings-open');

    if (!(history.state && history.state.massaSettings)) {
      try {
        if (history.state && history.state.massaChat) history.replaceState({ massaSettings: true }, '');
        else history.pushState({ massaSettings: true }, '');
      } catch (e) { /* ignore */ }
    }
  }

  function closeSettingsUI() {
    if (!settingsOpen) return;
    settingsOpen = false;
    $('#app').classList.remove('is-settings-open');
    setTimeout(function () {
      if (!settingsOpen) $('#settings-screen').hidden = true;
    }, 540);
  }

  function closeSettings() {
    if (!settingsOpen) return;
    if (history.state && history.state.massaSettings) history.back();
    else closeSettingsUI();
  }

  /* ---------------------------- auth -------------------------------- */

  function setTab(mode) {
    authMode = mode;

    $$('.tab').forEach(function (t) {
      var on = t.getAttribute('data-tab') === mode;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    $('#password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    $('#password2-field').hidden = mode !== 'register';

    clearError('email');
    clearError('password');
    clearError('password2');
    syncAuthButton();
  }

  function setError(field, message) {
    var map = {
      email: { input: '#email', error: '#email-error' },
      password: { input: '#password', error: '#password-error' },
      password2: { input: '#password2', error: '#password2-error' }
    };
    var refs = map[field];
    if (!refs) return;

    var input = $(refs.input);
    var error = $(refs.error);
    var wrap = input ? input.closest('.input-wrap') : null;

    if (error) {
      error.textContent = message || '';
      error.classList.toggle('is-shown', !!message);
    }
    if (wrap) {
      wrap.classList.toggle('is-invalid', !!message);
      if (message) wrap.classList.remove('is-valid');
    }
  }

  function clearError(field) { setError(field, ''); }

  function emailProblem(value) {
    if (!value) return 'Введите почту';
    if (/\s/.test(value)) return 'В почте не должно быть пробелов';
    if (value.indexOf('@') === -1) return 'Нужен вид name@mail.com — без @ не почта';
    if (!EMAIL_RE.test(value)) return 'Не похоже на почту. Нужен вид: name@mail.com';
    if (value.length > 254) return 'Слишком длинная почта';
    return '';
  }

  function passwordProblem(value) {
    if (!value) return 'Введите пароль';
    if (value.length < 6) return 'Пароль должен быть не короче 6 символов';
    return '';
  }

  function password2Problem(pass, repeat) {
    if (!repeat) return 'Повторите пароль';
    if (pass !== repeat) return 'Пароли не совпадают';
    return '';
  }

  function markValid(inputSel, valid) {
    var input = $(inputSel);
    var wrap = input ? input.closest('.input-wrap') : null;
    if (wrap) wrap.classList.toggle('is-valid', !!valid);
  }

  function authFormReady() {
    var email = $('#email').value.trim();
    var pass = $('#password').value;

    if (emailProblem(email) || passwordProblem(pass)) return false;
    if (authMode === 'register' && password2Problem(pass, $('#password2').value)) return false;
    return true;
  }

  // кнопка входа приглушена, пока поля не заполнены правильно
  function syncAuthButton() {
    var btn = $('#auth-submit');
    if (btn) btn.classList.toggle('is-ready', authFormReady());
  }

  async function submitAuth(ev) {
    if (ev) ev.preventDefault();

    var email = $('#email').value.trim();
    var password = $('#password').value;
    var repeat = authMode === 'register' ? $('#password2').value : '';

    var eProblem = emailProblem(email);
    var pProblem = passwordProblem(password);
    var p2Problem = authMode === 'register' ? password2Problem(password, repeat) : '';

    setError('email', eProblem);
    setError('password', pProblem);
    if (authMode === 'register') setError('password2', p2Problem);

    markValid('#email', !eProblem && !!email);
    markValid('#password2', authMode === 'register' && !p2Problem && !!repeat);

    if (eProblem || pProblem || p2Problem) {
      shake();
      if (eProblem) $('#email').focus();
      else if (pProblem) $('#password').focus();
      else $('#password2').focus();
      return;
    }

    var btn = $('#auth-submit');
    btn.disabled = true;

    try {
      var user = authMode === 'login'
        ? await API.signIn(email, password)
        : await API.signUp(email, password);

      $('#password').value = '';
      $('#password2').value = '';

      await enterApp();
      toast(authMode === 'login' ? 'С возвращением, ' + user.name : 'Аккаунт создан — можно писать');
    } catch (err) {
      if (err && err.retryAfter) {
        startLoginCooldown(err.retryAfter);
      } else if (err && err.field) {
        setError(err.field, err.message);
      } else {
        toast((err && err.message) || 'Не получилось войти');
      }
      shake();
    } finally {
      if (!cooldownTimer) btn.disabled = false;
    }
  }

  var cooldownTimer = null;

  function startLoginCooldown(seconds) {
    var until = Date.now() + seconds * 1000;
    var btn = $('#auth-submit');
    var note = document.getElementById('auth-cooldown');

    if (!note) {
      note = document.createElement('p');
      note.id = 'auth-cooldown';
      note.className = 'auth__cooldown';
      $('#password-error').parentNode.insertBefore(note, $('#password-error'));
    }

    function tick() {
      var left = Math.max(0, Math.ceil((until - Date.now()) / 1000));

      if (left <= 0) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        note.textContent = '';
        note.hidden = true;
        btn.disabled = false;
        syncAuthButton();
        return;
      }

      var mm = Math.floor(left / 60);
      var ss = left % 60;
      note.hidden = false;
      note.textContent = 'Слишком много попыток. Попробуйте ещё раз через ' +
        mm + ':' + (ss < 10 ? '0' + ss : ss);

      btn.disabled = true;
    }

    clearInterval(cooldownTimer);
    tick();
    cooldownTimer = setInterval(tick, 1000);
  }

  /* --------------------------- приложение --------------------------- */

  function renderMe() {
    if (!UI.me) return;
    $('#me-name').textContent = UI.me.name;
    $('#me-email').textContent = UI.me.email;

    var av = $('#me-avatar');
    if (UI.me.avatar) {
      av.innerHTML = '<img class="avatar__img" src="' + UI.me.avatar + '" alt="Аватар">';
      av.classList.add('has-img');
    } else {
      av.textContent = initials(UI.me.name);
      av.classList.remove('has-img');
    }
  }

  async function refreshChats() {
    try {
      UI.chats = await API.listChats();
      UI.favCount = await API.favoritesCount();
      sortChats();
    } catch (e) {
      UI.chats = UI.chats || [];
      UI.favCount = UI.favCount || 0;
    }
    renderChatList();
  }

  function chatRow(chat) {
    var last = chat.lastMessage;
    var preview = last ? last.text : (chat.type === 'group' ? 'Группа создана — напишите первым' : 'Нет сообщений');
    var time = last ? (fmtTime(last.ts) || last.time || '') : '';

    // «печатает…» прямо в списке чатов
    var p = UI.presence[chat.id] || null;
    if (p) {
      if (chat.type === 'group' && p.typingName) preview = p.typingName + ' печатает…';
      else if (chat.type !== 'group' && p.peerTyping) preview = 'печатает…';
    }

    // админ видит чужие чаты — подписываем, чьи они
    var prefix = '';
    if (chat.owned === false) {
      prefix = '<span class="you">' + esc(chat.ownerName || 'чужой чат') + ': </span>';
    } else if (last && last.mine) {
      prefix = '<span class="you">Вы: </span>';
    }

    var dot = p && (chat.type === 'group' ? p.online > 0 : p.peerOnline)
      ? '<span class="chat-item__dot" title="в сети"></span>'
      : '';

    return '<button class="chat-item' + (chat.id === UI.activeId ? ' is-active' : '') + '" type="button" role="listitem" data-chat="' + chat.id + '">' +
      avatarHtml(chat.name, chat.color, '', chat.peerAvatar || chat.avatar) +
      '<span class="chat-item__main">' +
        '<span class="chat-item__top">' +
          '<span class="chat-item__name">' + esc(chat.name) + dot + '</span>' +
          '<span class="chat-item__time">' + esc(time) + '</span>' +
        '</span>' +
        '<span class="chat-item__bottom">' +
          '<span class="chat-item__preview' + (p && (p.peerTyping || p.typingName) ? ' is-typing' : '') + '">' +
            prefix + esc(preview) +
          '</span>' +
          (chat.unread ? '<span class="badge">' + chat.unread + '</span>' : '') +
        '</span>' +
      '</span>' +
    '</button>';
  }

  function renderChatList() {
    var list = $('#chat-list');
    var empty = $('#list-empty');
    var isEmpty = UI.chats.length === 0;

    list.innerHTML = isEmpty ? '' : UI.chats.map(chatRow).join('');
    list.hidden = isEmpty;
    empty.hidden = !isEmpty;

    $('#chat-count').textContent = UI.chats.length;
    $('#fav-count').textContent = UI.favCount;
    $('#fav-row').classList.toggle('is-active',
      UI.activeId === 'fav' || !!(UI.active && UI.active.type === 'saved'));
  }

  // «в сети», «не в сети» и «печатает…» — из последнего ответа сервера
  function presenceOf(chat) {
    if (!chat) return null;
    return UI.presence[chat.id] || null;
  }

  function statusText(chat) {
    if (chat.type === 'saved') return 'только вы · заметки и ссылки';

    var p = presenceOf(chat);

    if (chat.type === 'group') {
      if (p && p.typingName) return p.typingName + ' печатает…';

      var online = p ? p.online : 0;
      var base = 'группа · ' + (chat.members || 0) + ' участников';
      return online > 0 ? base + ' · ' + online + ' в сети' : base;
    }

    if (p && p.peerTyping) return 'печатает…';
    if (p && p.peerOnline) return 'в сети';
    return 'не в сети';
  }

  /* -------------------------- участники группы ---------------------- */

  var membersOpen = false;

  var membersData = null;

  function renderMembers(data) {
    membersData = data;
    var av = $('#members-avatar');
    var c = PALETTE[Math.abs(data.color || 0) % PALETTE.length];
    av.style.setProperty('--a1', c[0]);
    av.style.setProperty('--a2', c[1]);

    if (data.avatar) {
      av.className = 'avatar avatar--lg has-img';
      av.innerHTML = '<img class="avatar__img" src="' + esc(data.avatar) + '" alt="">';
    } else {
      av.className = 'avatar avatar--lg avatar--color';
      av.textContent = initials(data.name);
    }

    $('#members-name').textContent = data.name;
    $('#members-count').textContent = data.count + ' участников' +
      (data.handle ? ' · ' + data.handle : '');

    $('#members-list').innerHTML = data.members.map(function (m, idx) {
      var status = '';

      if (m.isMe) status = 'это вы';
      else if (m.typing) status = 'печатает…';
      else if (m.online) status = 'в сети';
      else status = 'не в сети';

      return '<div class="member" data-member="' + idx + '">' +
        '<span class="member__avatar">' +
          avatarHtml(m.name, m.color, 'avatar--xs', m.avatar) +
          '<span class="member__dot' + (m.online && !m.isMe ? ' is-online' : '') + '"></span>' +
        '</span>' +
        '<span class="member__main">' +
          '<span class="member__name">' + esc(m.name) +
            (m.isMe ? '<span class="you">вы</span>' : '') +
          '</span>' +
          '<span class="member__sub' + (m.typing ? ' is-typing' : (m.online && !m.isMe ? ' is-online' : '')) + '">' +
            esc(status) + (m.email ? ' · ' + esc(m.email) : '') +
          '</span>' +
        '</span>' +
        (m.role ? '<span class="member__role">' + esc(m.role) + '</span>' : '') +
      '</div>';
    }).join('');
  }

  async function openMembers() {
    if (!UI.activeId) return;

    // открываем сразу, чтобы анимация начиналась по нажатию, а не после загрузки
    membersOpen = true;
    $('#members-screen').hidden = false;

    var membersName = document.getElementById('members-name');
    var membersListEl = document.getElementById('members-list');
    if (membersName) membersName.textContent = (UI.active && UI.active.name) || '';
    if (membersListEl) membersListEl.innerHTML = '<div class="readers__empty">Загрузка…</div>';

    openSheet(document.getElementById('members-screen'), 'is-members-open');

    if (!(history.state && history.state.massaMembers)) {
      try { history.pushState({ massaMembers: UI.activeId }, ''); } catch (e) { /* ignore */ }
    }

    var data = await API.getMembers(UI.activeId);
    if (data && membersOpen) renderMembers(data);
  }

  function closeMembersUI() {
    if (!membersOpen) return;
    membersOpen = false;
    $('#app').classList.remove('is-members-open');
    setTimeout(function () {
      if (!membersOpen) $('#members-screen').hidden = true;
    }, 460);
  }

  function closeMembers() {
    if (!membersOpen) return;
    if (history.state && history.state.massaMembers) history.back();
    else closeMembersUI();
  }

  /* --------------------------- новая группа ------------------------- */

  var ngOpen = false;
  var ngSelected = {};
  var ngAvatar = null;
  var ngPeople = [];

  function selectedIds() {
    return Object.keys(ngSelected).filter(function (id) { return ngSelected[id]; });
  }

  function renderNewGroupAvatar() {
    var av = document.getElementById('newgroup-avatar');
    if (!av) return;

    if (ngAvatar) {
      av.className = 'avatar avatar--lg has-img';
      av.innerHTML = '<img class="avatar__img" src="' + ngAvatar + '" alt="">';
    } else {
      av.className = 'avatar avatar--lg avatar--color';
      av.textContent = 'Г';
    }
  }

  function updateNewGroupButton() {
    var name = $('#newgroup-name').value.trim();
    var count = selectedIds().length;

    $('#newgroup-create').disabled = !name || !count;
    $('#newgroup-selected').textContent = count ? 'Выбрано: ' + count : 'Никого не выбрали';
    $('#newgroup-avatar').textContent = name ? initials(name) : 'Г';
  }

  function renderNewGroupList(filter) {
    var q = String(filter || '').trim().toLowerCase();

    var list = ngPeople.filter(function (p) {
      if (!q) return true;
      var hay = [p.name, p.handle, p.email].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    $('#newgroup-list').innerHTML = list.map(function (p) {
      return '<button class="pick' + (ngSelected[p.id] ? ' is-on' : '') + '" type="button" data-pick="' + esc(p.id) + '">' +
        avatarHtml(p.name, p.color, 'avatar--xs', p.avatar) +
        '<span class="pick__main">' +
          '<b>' + esc(p.name) + '</b>' +
          '<small>' + esc(p.handle || p.email || '') + '</small>' +
        '</span>' +
        '<span class="pick__check">' + CHECK_ICON + '</span>' +
      '</button>';
    }).join('') || '<div class="search-empty">Никого не нашли</div>';
  }

  async function openNewGroup() {
    if (!UI.me) return;

    closeSearch();
    ngSelected = {};
    ngAvatar = null;
    renderNewGroupAvatar();

    var res = await API.listDirectory();
    ngPeople = res || [];

    $('#newgroup-name').value = '';
    $('#newgroup-filter').value = '';
    renderNewGroupList('');
    updateNewGroupButton();

    ngOpen = true;
    $('#newgroup-screen').hidden = false;

    openSheet(document.getElementById('newgroup-screen'), 'is-newgroup-open');

    if (!(history.state && history.state.massaNewGroup)) {
      try { history.pushState({ massaNewGroup: true }, ''); } catch (e) { /* ignore */ }
    }

    setTimeout(function () {
      if (!ngOpen) return;
      var field = $('#newgroup-name');
      if (field && typeof field.focus === 'function') {
        try { field.focus({ preventScroll: true }); } catch (e) { field.focus(); }
      }
      $('#app').scrollLeft = 0;
    }, 320);
  }

  function closeNewGroupUI() {
    if (!ngOpen) return;
    ngOpen = false;
    $('#app').classList.remove('is-newgroup-open');
    setTimeout(function () {
      if (!ngOpen) $('#newgroup-screen').hidden = true;
    }, 460);
  }

  function closeNewGroup() {
    if (!ngOpen) return;
    if (history.state && history.state.massaNewGroup) history.back();
    else closeNewGroupUI();
  }

  async function submitNewGroup() {
    var name = $('#newgroup-name').value.trim();
    var ids = selectedIds();
    if (!name || !ids.length) return;

    var btn = $('#newgroup-create');
    btn.disabled = true;

    try {
      var chatId = await API.createGroup(name, ids);

      if (ngAvatar) {
        try { await API.setChatAvatar(chatId, ngAvatar); } catch (e) { /* фото не критично */ }
      }

      closeNewGroupUI();
      await syncAll();
      await openChat(chatId);
      toast('Группа «' + name + '» создана');
    } catch (e) {
      toast((e && e.message) || 'Не получилось создать группу');
      updateNewGroupButton();
    }
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',') + ' МБ';
  }

  // время берём из серверного ts и показываем в часовой зоне устройства
  function fmtTime(ts) {
    if (!ts) return '';
    try {
      // всегда 24 часа и двузначные минуты — независимо от локали устройства
      return new Date(ts).toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch (e) {
      return '';
    }
  }

  function dayLabel(ts) {
    if (!ts) return '';
    var date = new Date(ts);
    var now = new Date();
    var startOf = function (d) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    var diff = Math.round((startOf(now) - startOf(date)) / 86400000);

    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Вчера';

    try {
      return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    } catch (e) {
      return '';
    }
  }

  var FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"></path>' +
    '<path d="M14 3v5h5"></path></svg>';

  var FAV_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<path d="M6 3.5h12a1 1 0 0 1 1 1v16l-7-4.4-7 4.4v-16a1 1 0 0 1 1-1Z"></path></svg>';

  var replyTarget = null;

  function setReply(msg) {
    replyTarget = msg;
    var bar = document.getElementById('reply-bar');
    var label = document.getElementById('reply-bar-text');
    if (!bar || !label) return;

    var who = msg.mine ? 'Вы' : (msg.author || 'Собеседник');
    label.textContent = who + ': ' + (msg.text || 'вложение');
    bar.hidden = false;
  }

  function clearReply() {
    replyTarget = null;
    var bar = document.getElementById('reply-bar');
    if (bar) bar.hidden = true;
  }

  function quoteHtml(reply) {
    if (!reply) return '';
    var who = reply.mine ? 'Вы' : (reply.author || '');
    return '<button type="button" class="bubble__quote" data-quote="' + esc(reply.id) + '">' +
      '<span class="bubble__quote-author">' + esc(who) + '</span>' +
      '<span class="bubble__quote-text">' + esc(String(reply.text || 'вложение').slice(0, 90)) + '</span>' +
    '</button>';
  }

  function messageHtml(m, readState) {
    var author = (!m.mine && m.author) ? '<div class="bubble__author">' + esc(m.author) + '</div>' : '';
    var quote = quoteHtml(m.reply);
    var mark = readState === 'read' ? 'прочитано' : (readState === 'sent' ? 'отправлено' : '');
    var stamp = '<span class="bubble__foot">' +
      (mark ? '<span class="bubble__read">' + mark + '</span>' : '') +
      '<span class="bubble__time">' + esc(fmtTime(m.ts) || m.time || '') + '</span>' +
      '</span>';
    var time = stamp;
    var caption = m.text ? '<div class="bubble__caption">' + esc(m.text) + '</div>' : '';

    if (!m.file) {
      return '<div class="msg ' + (m.mine ? 'msg--out' : 'msg--in') + '" data-id="' + esc(m.id) + '">' +
        '<div class="bubble">' + author + quote + '<span class="bubble__text">' + esc(m.text) + '</span>' + time + '</div>' +
      '</div>';
    }

    if (m.file.kind === 'image') {
      return '<div class="msg ' + (m.mine ? 'msg--out' : 'msg--in') + '" data-id="' + esc(m.id) + '">' +
        '<div class="bubble bubble--media">' + author + quote +
          '<img draggable="false" class="bubble__img" data-file="' + esc(m.file.id) + '" alt="' + esc(m.file.name) + '">' +
          caption + time +
        '</div>' +
      '</div>';
    }

    if (m.file.kind === 'video') {
      return '<div class="msg ' + (m.mine ? 'msg--out' : 'msg--in') + '" data-id="' + esc(m.id) + '">' +
        '<div class="bubble bubble--media">' + author + quote +
          '<video class="bubble__video" data-file="' + esc(m.file.id) + '" controls controlslist="nodownload nofullscreen" preload="metadata" playsinline>' +
          '</video>' +
          '<button class="bubble__expand" type="button" data-expand="' + esc(m.file.id) + '"' +
            ' data-src="files/' + esc(m.file.id) + '" aria-label="Развернуть видео">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"></path>' +
            '</svg>' +
          '</button>' +
          caption + time +
        '</div>' +
      '</div>';
    }

    return '<div class="msg ' + (m.mine ? 'msg--out' : 'msg--in') + '" data-id="' + esc(m.id) + '">' +
      '<div class="bubble bubble--file">' + author + quote +
        '<a class="file" data-file="' + esc(m.file.id) + '" download="' + esc(m.file.name) + '">' +
          '<span class="file__icon">' + FILE_ICON + '</span>' +
          '<span class="file__meta">' +
            '<b>' + esc(m.file.name) + '</b>' +
            '<small>' + esc(formatSize(m.file.size)) + '</small>' +
          '</span>' +
        '</a>' +
        caption + time +
      '</div>' +
    '</div>';
  }

  // подставляет настоящие ссылки на вложения (из IndexedDB / localStorage)
  function hydrateFiles(root) {
    $$('[data-file]', root || $('#messages')).forEach(function (node) {
      if (node.getAttribute('data-hydrated')) return;
      var id = node.getAttribute('data-file');

      API.fileUrl(id).then(function (url) {
        if (!url) { node.classList.add('is-missing'); return; }
        node.setAttribute('data-hydrated', '1');
        if (node.tagName === 'IMG') {
          node.src = url;
          node.classList.add('is-ready');
        } else if (node.tagName === 'VIDEO') {
          node.src = url;
          node.classList.add('is-ready');
        } else if (node.tagName === 'A') {
          node.href = url;
        }
      });
    });
  }

  function messagesHtml(chat) {
    if (!chat.messages.length) {
      return '<div class="conv-empty"><b>Сообщений пока нет</b></div>';
    }

    var html = '';
    var prevDate = null;

    chat.messages.forEach(function (m) {
      var label = dayLabel(m.ts) || m.date;
      if (label && label !== prevDate) {
        html += '<div class="divider"><span>' + esc(label) + '</span></div>';
        prevDate = label;
      }
      html += messageHtml(m, m.mine ? (isMessageRead(chat, m) ? 'read' : 'sent') : null);
    });

    return html;
  }

  // подсвечиваем появление только у свежего сообщения
  function markFreshMessage(id) {
    if (!id) return;
    var node = document.querySelector('#messages .msg[data-id="' + id + '"]');
    if (node) node.classList.add('is-fresh');
  }

  function isScrolledToBottom() {
    var body = document.getElementById('messages');
    if (!body) return true;
    return body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  }

  function scrollMessagesToBottom() {
    var body = document.getElementById('messages');
    if (body) body.scrollTop = body.scrollHeight;
  }

  // прочитано: в личном чате — когда прочитал собеседник,
  // в группе больше двух человек — когда прочитали хотя бы двое
  function isMessageRead(chat, msg) {
    if (!msg || !msg.mine) return false;

    var reads = chat.reads || {};
    var count = 0;

    Object.keys(reads).forEach(function (uid) {
      if (UI.me && uid === UI.me.id) return;
      if (Number(reads[uid] || 0) >= msg.ts) count++;
    });

    var need = (chat.type === 'group' && (chat.members || 0) > 2) ? 2 : 1;
    return count >= need;
  }

  function renderConversation(scrollToId) {
    var chat = UI.active;

    $('#conversation').hidden = !chat;
    if (!chat) return;

    var avatar = $('#conv-avatar');

    if (chat.type === 'saved') {
      // в «Избранном» та же иконка закладки, что и в списке чатов
      avatar.className = 'avatar avatar--fav';
      avatar.textContent = '';
      avatar.innerHTML = FAV_ICON;
    } else if (chat.peerAvatar || chat.avatar) {
      avatar.className = 'avatar has-img';
      avatar.textContent = '';
      avatar.innerHTML = '<img class="avatar__img" src="' + esc(chat.peerAvatar || chat.avatar) + '" alt="">';
    } else {
      avatar.className = 'avatar';
      avatar.textContent = initials(chat.name);
      var c = PALETTE[Math.abs(chat.color || 0) % PALETTE.length];
      avatar.style.setProperty('--a1', c[0]);
      avatar.style.setProperty('--a2', c[1]);
    }

    $('#conv-name').textContent = chat.name;

    var status = $('#conv-status');
    status.textContent = statusText(chat);

    var pNow = presenceOf(chat);
    var typingNow = !!(pNow && (pNow.peerTyping || pNow.typingName));
    var onlineNow = !!(pNow && (chat.type === 'group' ? pNow.online > 0 : pNow.peerOnline));

    status.classList.toggle('is-online', chat.type !== 'saved' && onlineNow && !typingNow);
    status.classList.toggle('is-typing', typingNow);

    var isGroup = chat.type === 'group';
    $('#conv-head').classList.toggle('is-clickable', isGroup || !!chat.peerEmail);
    $('#conv-chev').hidden = !isGroup;

    var body = $('#messages');
    body.innerHTML = messagesHtml(chat);
    hydrateFiles(body);

    if (scrollToId) {
      var node = body.querySelector('[data-id="' + scrollToId + '"]');
      if (node) {
        node.scrollIntoView({ block: 'center' });
        node.classList.add('flash');
        setTimeout(function () { node.classList.remove('flash'); }, 1600);
        return;
      }
    }
    body.scrollTop = body.scrollHeight;
    if (window.syncDownArrow) window.syncDownArrow();
  }

  /* --------- открытие/закрытие чата: история + свайп --------------- */

  function rememberChat(id) {
    try {
      if (history.state && history.state.massaChat) {
        history.replaceState({ massaChat: id }, '');
      } else {
        history.pushState({ massaChat: id }, '');
      }
    } catch (e) { /* file:// в некоторых браузерах запрещает pushState */ }
  }

  function resetDrag() {
    var panel = $('#chat-panel');
    if (!panel) return;
    panel.classList.remove('is-dragging');
    panel.style.transform = '';
  }

  function closeChatUI() {
    freezeBackdrop();
    clearTimeout(freezeTimer);
    freezeTimer = setTimeout(unfreezeBackdrop, 520);
    if (window.closeMsgMenu) window.closeMsgMenu();
    UI.activeId = null;
    UI.active = null;
    typingState = { chatId: null, value: false, sentAt: 0 };
    sendPresence();
    stopReadLoop();
    resetDrag();
    $('#app').classList.remove('is-chat-open');
    renderChatList();
  }

  // Закрыть чат: сначала пробуем «назад» по истории (так работает
  // системный жест Android), иначе закрываем напрямую.
  function closeChat() {
    if (!UI.activeId) return;
    if (history.state && history.state.massaChat) history.back();
    else closeChatUI();
  }

  // свайп вверх закрывает панель: чат, участники группы, новая группа.
  // На телефоне используем touch-события, иначе браузер забирает жест под скролл.
  function bindSheetSwipe(element, onClose, handleSelector) {
    if (!element) return;

    var drag = null;

    function closeTransform() {
      element.classList.remove('is-dragging');
      element.style.transform = '';
    }

    function canStart(target) {
      if (target.closest('input, textarea, .composer')) return false;

      if (handleSelector && target.closest(handleSelector)) return true;

      // у чата можно тянуть и по переписке, но только когда она
      // прокручена в самый низ — тогда вверх уже нечего листать
      var list = element.querySelector('.conv__body');
      if (!list) return true;
      return list.scrollHeight - list.scrollTop - list.clientHeight < 8;
    }

    function applyDrag(dy) {
      var offset = Math.min(0, dy);
      drag.dy = offset;
      element.style.transform = 'translateY(' + offset + 'px)';
    }

    function finish() {
      if (!drag) return;

      var offset = drag.dy;
      var active = drag.active;
      drag = null;

      closeTransform();
      if (active && offset < -80) onClose();
    }

    // --- телефоны ---
    element.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) return;
      if (!canStart(ev.target)) return;
      drag = { y: ev.touches[0].clientY, dy: 0, active: false };
    }, { passive: true });

    element.addEventListener('touchmove', function (ev) {
      if (!drag || ev.touches.length !== 1) return;

      var dy = ev.touches[0].clientY - drag.y;

      if (!drag.active) {
        if (dy > -12) return;
        drag.active = true;
        element.classList.add('is-dragging');
      }

      ev.preventDefault();
      applyDrag(dy);
    }, { passive: false });

    element.addEventListener('touchend', finish);
    element.addEventListener('touchcancel', finish);

    // --- мышь на компьютере ---
    element.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
      if (!canStart(ev.target)) return;
      drag = { y: ev.clientY, dy: 0, active: false };
    });

    element.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerType !== 'mouse') return;

      var dy = ev.clientY - drag.y;

      if (!drag.active) {
        if (dy > -12) return;
        drag.active = true;
        element.classList.add('is-dragging');
      }

      applyDrag(dy);
    });

    element.addEventListener('pointerup', function (ev) {
      if (ev.pointerType === 'mouse') finish();
    });
    element.addEventListener('pointercancel', function (ev) {
      if (ev.pointerType === 'mouse') finish();
    });
  }

  // если браузер не поджимает макет под клавиатуру — поджимаем сами
  function syncKeyboard() {
    var vv = window.visualViewport;
    var app = document.getElementById('app');
    if (!vv || !app) return;

    var cover = Math.round(window.innerHeight - vv.height - vv.offsetTop);
    var wasKeyboard = app.classList.contains('is-keyboard');

    if (cover > 120) {
      app.classList.add('is-keyboard');
      app.style.setProperty('--kb-cover', cover + 'px');
    } else {
      app.classList.remove('is-keyboard');
      app.style.setProperty('--kb-cover', '0px');
    }

    // держим последнее сообщение у строки ввода
    var nowKeyboard = app.classList.contains('is-keyboard');
    if (wasKeyboard !== nowKeyboard && UI.activeId) {
      var box = document.getElementById('messages');
      if (box) box.scrollTop = box.scrollHeight;
    }
  }

  // перезапускает анимацию выезда, даже если панель уже открывалась
  var freezeTimer = null;

  // замораживает фон на время анимации: копия списка поверх,
  // оригинал скрыт — сзади ничего не перерисовывается
  var frozenBackdrop = null;

  function freezeBackdrop() {
    if (frozenBackdrop) return;

    var side = document.querySelector('.sidebar');
    var messenger = document.querySelector('.messenger');
    if (!side || !messenger) return;

    var clone = side.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('is-frozen');

    Array.prototype.forEach.call(clone.querySelectorAll('[id]'), function (node) {
      node.removeAttribute('id');
    });

    clone.style.position = 'absolute';
    clone.style.inset = '0';
    clone.style.zIndex = '5';
    clone.style.pointerEvents = 'none';

    messenger.insertBefore(clone, document.getElementById('chat-panel'));
    side.style.visibility = 'hidden';

    frozenBackdrop = { clone: clone, side: side };
  }

  function unfreezeBackdrop() {
    if (!frozenBackdrop) return;

    if (frozenBackdrop.clone.parentNode) frozenBackdrop.clone.parentNode.removeChild(frozenBackdrop.clone);
    frozenBackdrop.side.style.visibility = '';
    frozenBackdrop = null;
  }

  // показывает панель так, чтобы она гарантированно выехала сверху без мигания
  function openSheet(el, appClass) {
    if (!el) return;

    el.style.transition = 'none';
    el.style.transform = 'translateY(-100%)';
    el.hidden = false;
    void el.offsetHeight;

    el.style.transition = '';
    el.style.transform = '';

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.getElementById('app').classList.add(appClass);
      });
    });
  }

  function bindSwipe() {
    bindSheetSwipe($('#chat-panel'), closeChat, '#conv-head');
    bindSheetSwipe($('#members-screen'), closeMembers, '.settings__head, .members__group');
    bindSheetSwipe($('#newgroup-screen'), closeNewGroup, '.settings__head');
  }
  /* ------------------------- локальный кэш -------------------------- */

  function lastPreviewOf(msg) {
    if (!msg) return null;
    var text;
    if (msg.file) {
      if (msg.file.kind === 'image') text = 'Фото';
      else if (msg.file.kind === 'video') text = 'Видео';
      else text = msg.file.name;
    } else {
      text = msg.text;
    }
    // ts обязателен: иначе список чатов покажет серверное время вместо местного
    return { text: text, mine: !!msg.mine, time: msg.time, ts: msg.ts };
  }

  function favoritesFromCache() {
    var fav = UI.cache.favorites;
    if (!fav) return null;
    var messages = fav.messages || [];
    return {
      id: fav.id,
      name: 'Избранное',
      handle: 'только вы',
      type: 'saved',
      color: 3,
      unread: 0,
      online: false,
      members: 0,
      messages: messages,
      lastMessage: lastPreviewOf(messages[messages.length - 1])
    };
  }

  function chatFromCache(id) {
    if (id === 'fav') return favoritesFromCache();
    return UI.cache.chats[id] || null;
  }

  function pushToCache(chatId, message) {
    if (chatId === 'fav') {
      if (UI.cache.favorites) {
        UI.cache.favorites.messages.push(message);
        UI.cache.favorites.count = UI.cache.favorites.messages.length;
      }
    } else if (UI.cache.chats[chatId]) {
      UI.cache.chats[chatId].messages.push(message);
      UI.cache.chats[chatId].lastMessage = lastPreviewOf(message);
    }

    var row = UI.chats.filter(function (c) { return c.id === chatId; })[0];
    if (row) row.lastMessage = lastPreviewOf(message);
  }

  // картинки прогреваем сразу, чтобы чат открывался без «догрузки»
  function prefetchFiles(files) {
    Object.keys(files || {}).forEach(function (id) {
      var meta = files[id];
      if (!meta || meta.kind !== 'image') return;
      API.fileUrl(id).then(function (url) {
        if (!url) return;
        var img = new Image();
        img.src = url;
      }).catch(function () { /* ignore */ });
    });
  }

  // всё разом: чаты, сообщения, файлы
  function applySync(data) {
    UI.cache = { chats: {}, favorites: null };

    (data.chats || []).forEach(function (chat) {
      UI.cache.chats[chat.id] = chat;
    });
    UI.cache.favorites = data.favorites || null;

    UI.chats = (data.chats || []).map(function (chat) {
      return {
        id: chat.id,
        name: chat.name,
        handle: chat.handle,
        type: chat.type,
        color: chat.color,
        owned: chat.owned,
        ownerName: chat.ownerName,
        unread: chat.unread,
        online: chat.online,
        members: chat.members,
        lastMessage: chat.lastMessage,
        avatar: chat.avatar,
        peerAvatar: chat.peerAvatar,
        peerEmail: chat.peerEmail,
        peerName: chat.peerName
      };
    });
    UI.favCount = data.favorites ? data.favorites.count : 0;
    sortChats();

    prefetchFiles(data.files);
  }

  function sortChats() {
    UI.chats.sort(function (a, b) {
      var ua = a.unread ? 1 : 0;
      var ub = b.unread ? 1 : 0;
      if (ua !== ub) return ub - ua;

      var ta = (a.lastMessage && a.lastMessage.ts) || 0;
      var tb = (b.lastMessage && b.lastMessage.ts) || 0;
      return tb - ta;
    });
  }

  function syncSignature(data) {
    var chats = (data.chats || []).map(function (c) {
      var last = c.messages[c.messages.length - 1];
      return c.id + ':' + c.messages.length + ':' + (last ? last.id : '') + ':' + (c.unread || 0) +
        ':' + (c.reads ? JSON.stringify(c.reads) : '');
    });
    return chats.join('|') + '#' + (data.favorites ? data.favorites.count : 0);
  }

  async function syncAll() {
    try {
      var data = await API.sync();
      applySync(data);
      UI.syncSig = syncSignature(data);
      renderChatList();
    } catch (e) {
      await refreshChats();
    }
  }

  // опрос сервера: новые сообщения и чаты появляются сами
  var pollBusy = false;

  async function pollUpdates() {
    if (pollBusy || !UI.me || document.hidden) return;
    pollBusy = true;
    try {
      var data = await API.sync();
      var sig = syncSignature(data);
      if (sig === UI.syncSig) return;

      applySync(data);
      UI.syncSig = sig;
      renderChatList();

      if (UI.activeId && UI.active) {
        var fresh = chatFromCache(UI.activeId);
        if (fresh) {
          var wasBottom = isScrolledToBottom();
          UI.active = fresh;
          renderConversation();
          if (wasBottom) scrollMessagesToBottom();
        }
      }

      // открытый чат считается прочитанным сразу, даже если новые
      // сообщения пришли, пока он открыт
      if (readChatId && readChatId === UI.activeId) markReadNow();
    } catch (e) {
      /* сеть пропала — попробуем на следующем тике */
    } finally {
      pollBusy = false;
    }
  }

  // пока чат открыт — раз в 3,5 секунды отправляем отметку «прочитано»,
  // чтобы «отправлено» превращалось в «прочитано» без обновления страницы
  var readTimer = null;
  var readChatId = null;
  var readBusy = false;

  function startReadLoop(chatId) {
    stopReadLoop();

    if (!chatId || chatId === 'fav') return;
    if (UI.active && UI.active.type === 'saved') return;

    readChatId = chatId;
    markReadNow();

    readTimer = setInterval(markReadNow, 3500);
  }

  function stopReadLoop() {
    if (readTimer) clearInterval(readTimer);
    readTimer = null;
    readChatId = null;
  }

  async function markReadNow() {
    if (readBusy || !readChatId) return;

    var chatId = readChatId;
    readBusy = true;

    try {
      await API.markRead(chatId);

      var chat = chatFromCache(chatId);
      if (chat) chat.unread = 0;

      var row = UI.chats.filter(function (c) { return c.id === chatId; })[0];
      if (row) row.unread = 0;

      renderChatList();
    } catch (e) {
      /* попробуем на следующем тике */
    } finally {
      readBusy = false;
    }
  }

  function startPolling() {
    if (UI.pollTimer) return;
    UI.pollTimer = setInterval(pollUpdates, 3000);
    document.addEventListener('visibilitychange', onVisibility);
    startPresence();
  }

  /* ------------------- «в сети» и «печатает…» ----------------------- */

  var typingState = { chatId: null, value: false, sentAt: 0 };

  function activePresenceChat() {
    if (!UI.activeId || UI.activeId === 'fav') return null;
    if (UI.active && UI.active.type === 'saved') return null;
    return UI.activeId;
  }

  function inputHasText() {
    var input = document.getElementById('message-input');
    return !!(input && input.value.trim());
  }

  async function sendPresence() {
    if (!UI.me) return;

    var chatId = activePresenceChat();
    var typing = !!(chatId && typingState.chatId === chatId && typingState.value && inputHasText());

    try {
      var res = await API.presence(chatId, typing);
      applyPresence(res && res.chats);
    } catch (e) {
      /* тихо: следующий тик попробует снова */
    }
  }

  function applyPresence(chats) {
    if (!chats) return;
    UI.presence = chats;
    updatePresenceUI();
  }

  var membersPresenceAt = 0;

  function updatePresenceUI() {
    if (!UI.active) return;

    var status = document.getElementById('conv-status');
    if (status) status.textContent = statusText(UI.active);

    // панель участников обновляем не чаще раза в 6 секунд
    if (membersOpen && UI.activeId && Date.now() - membersPresenceAt > 6000) {
      membersPresenceAt = Date.now();
      API.getMembers(UI.activeId).then(function (data) {
        if (data && membersOpen) renderMembers(data);
      }).catch(function () { /* ignore */ });
    }

    reorderChatListPresence();
  }

  function reorderChatListPresence() {
    if (!UI.chats.length) return;

    var changed = false;
    UI.chats.forEach(function (chat) {
      var p = UI.presence[chat.id];
      if (!p) return;
      var online = chat.type === 'group' ? p.online > 0 : p.peerOnline;
      if (chat.presenceOnline !== online) {
        chat.presenceOnline = online;
        changed = true;
      }
    });

    if (changed) renderChatList();
  }

  function startPresence() {
    if (UI.presenceTimer) return;

    sendPresence();
    UI.presenceTimer = setInterval(sendPresence, 4000);
    document.addEventListener('visibilitychange', onPresenceVisibility);
  }

  function stopPresence() {
    if (UI.presenceTimer) clearInterval(UI.presenceTimer);
    UI.presenceTimer = null;
    document.removeEventListener('visibilitychange', onPresenceVisibility);
    typingState = { chatId: null, value: false, sentAt: 0 };
  }

  function onPresenceVisibility() {
    if (document.hidden) {
      typingState.value = false;
      sendPresence();
    } else {
      sendPresence();
    }
  }

  function markTyping(value) {
    var chatId = activePresenceChat();
    if (!chatId) return;

    var wasValue = typingState.value;
    typingState.chatId = chatId;
    typingState.value = !!value;

    var now = Date.now();
    var changed = wasValue !== typingState.value;

    // при начале и конце печати отправляем сразу, дальше — не чаще раза в 2 секунды
    if (changed || now - typingState.sentAt > 2000) {
      typingState.sentAt = now;
      sendPresence();
    }
  }

  function onVisibility() {
    if (!document.hidden) {
      pollUpdates();
      if (readChatId && readChatId === UI.activeId) markReadNow();
    }
  }

  function stopPolling() {
    if (UI.pollTimer) clearInterval(UI.pollTimer);
    UI.pollTimer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    stopPresence();
    stopReadLoop();
  }

  async function openChat(id, scrollToId) {
    if (!id) return;
    if (window.closeMsgMenu) window.closeMsgMenu();

    var wasOpen = !!UI.activeId;
    UI.activeId = id;

    var chat = chatFromCache(id);
    if (!chat) {
      chat = await API.getChat(id);
      if (id !== 'fav') UI.cache.chats[id] = chat;
    }
    UI.active = chat;

    if (!wasOpen) freezeBackdrop();

    openSheet(document.getElementById('chat-panel'), 'is-chat-open');
    clearTimeout(freezeTimer);
    freezeTimer = setTimeout(unfreezeBackdrop, 520);

    if (!wasOpen) rememberChat(id);

    // сообщаем, что открыли чат (и что пока не печатаем)
    typingState = { chatId: id, value: false, sentAt: 0 };
    sendPresence();

    // пока чат открыт — раз в 3,5 секунды отправляем «прочитано»
    startReadLoop(id);

    if (chat.unread) {
      chat.unread = 0;
      var row = UI.chats.filter(function (c) { return c.id === id; })[0];
      if (row) row.unread = 0;
      API.markRead(id).catch(function () { /* ignore */ });
    }

    renderChatList();
    renderConversation(scrollToId);

    var input = $('#message-input');
    // клавиатура не открывается сама — только по нажатию на поле
  }

  async function sendMessage(ev) {
    if (ev) ev.preventDefault();
    if (!UI.activeId) return;

    var input = $('#message-input');
    var text = input.value.trim();
    if (!text) return;

    var chatId = UI.activeId;
    var replyTo = replyTarget ? replyTarget.id : null;

    var message = await API.sendMessage(chatId, text, replyTo);
    input.value = '';
    clearReply();

    pushToCache(chatId, message);
    UI.active = chatFromCache(chatId) || UI.active;

    renderConversation();
    markFreshMessage(message.id);
    renderChatList();
    input.focus({ preventScroll: true });
  }

  /* --------------------------- вложения ----------------------------- */

  var MAX_FILE = 50 * 1024 * 1024;

  // большие картинки сжимаем, чтобы они умещались в браузерное хранилище
  function prepareFile(file) {
    var isImage = /^image\//.test(file.type || '');
    var isVideo = /^video\//.test(file.type || '');

    if (!isImage || file.size <= 700 * 1024) {
      return Promise.resolve({
        blob: file, name: file.name, size: file.size,
        type: file.type, kind: isImage ? 'image' : (isVideo ? 'video' : 'file')
      });
    }

    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      function fallback() {
        URL.revokeObjectURL(url);
        resolve({ blob: file, name: file.name, size: file.size, type: file.type, kind: 'image' });
      }

      img.onload = function () {
        var max = 1400;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));

        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;

        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);

        canvas.toBlob(function (blob) {
          if (!blob) return fallback();
          resolve({ blob: blob, name: file.name, size: blob.size, type: 'image/jpeg', kind: 'image' });
        }, 'image/jpeg', 0.82);
      };

      img.onerror = fallback;
      img.src = url;
    });
  }

  var pendingFiles = null;
  var pendingUrls = [];

  // сначала показываем предпросмотр, отправка — по кнопке
  function sendFiles(files) {
    if (!UI.activeId) { toast('Сначала откройте чат'); return; }

    pendingFiles = files;
    pendingUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    pendingUrls = [];

    var body = document.getElementById('preview-body');
    body.innerHTML = files.map(function (file, idx) {
      var isImage = /^image\//.test(file.type || '');
      var isVideo = /^video\//.test(file.type || '');

      if (isImage || isVideo) {
        var url = URL.createObjectURL(file);
        pendingUrls.push(url);
        return '<div class="preview__item">' +
          (isImage
            ? '<img src="' + url + '" alt="">'
            : '<video src="' + url + '" controls playsinline></video>') +
        '</div>';
      }

      return '<div class="preview__item preview__item--file">' + esc(file.name) + '</div>';
    }).join('');

    document.getElementById('preview-screen').hidden = false;
  }

  function closePreview() {
    document.getElementById('preview-screen').hidden = true;
    pendingUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    pendingUrls = [];
    pendingFiles = null;
  }

  async function uploadFiles(files) {
    if (!UI.activeId) { toast('Сначала откройте чат'); return; }

    var chatId = UI.activeId;
    var warned = false;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (file.size > MAX_FILE) {
        toast('«' + file.name + '» больше 50 МБ — пропустил');
        continue;
      }
      var prepared = await prepareFile(file);
      var result = await API.sendFile(chatId, prepared);
      if (result && result.message) pushToCache(chatId, result.message);
      if (!result.persisted && !warned) {
        warned = true;
        toast('Файл отправлен, но после перезагрузки страницы не сохранится');
      }
    }

    UI.active = chatFromCache(chatId) || UI.active;
    renderConversation();
    renderChatList();
  }

  /* ---------------------------- аватар ------------------------------ */

  function makeAvatar(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        var size = 256;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        var ctx = canvas.getContext('2d');
        var scale = Math.max(size / img.width, size / img.height);
        var w = img.width * scale;
        var h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('не удалось прочитать картинку'));
      };

      img.src = url;
    });
  }

  async function pickAvatar(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { toast('Нужна картинка'); return; }

    try {
      var dataUrl = await makeAvatar(file);
      UI.me = await API.setAvatar(dataUrl);
      renderMe();
      if (settingsOpen) renderSettings();
      toast('Аватар обновлён');
    } catch (e) {
      toast('Не получилось: ' + (e.message || 'ошибка'));
    }
  }

  /* --------------------------- просмотр фото ------------------------ */

  function openLightbox(src) {
    if (!src) return;
    $('#lightbox-img').src = src;
    $('#lightbox').hidden = false;
  }

  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lightbox-img').removeAttribute('src');
  }

  async function enterApp() {
    UI.me = await API.me();

    // у аккаунта свои сохранённые тема и акцент
    if (UI.me && UI.me.theme) applyTheme(UI.me.theme === 'dark' ? 'dark' : 'light');
    if (UI.me && UI.me.accent) applyAccent(UI.me.accent, true);

    $('#auth-screen').hidden = true;
    $('#chat-screen').hidden = false;
    renderMe();

    UI.activeId = null;
    UI.active = null;

    // один запрос: все чаты, сообщения и файлы сразу на устройство
    await syncAll();
    renderConversation();
    startPolling();
  }

  function showAuth() {
    stopPolling();
    UI.me = null;
    UI.activeId = null;
    UI.active = null;
    UI.chats = [];
    UI.cache = { chats: {}, favorites: null };

    authMode = 'login';

    settingsOpen = false;
    $('#app').classList.remove('is-settings-open');
    $('#settings-screen').hidden = true;

    membersOpen = false;
    $('#app').classList.remove('is-members-open');
    $('#members-screen').hidden = true;

    ngOpen = false;
    $('#app').classList.remove('is-newgroup-open');
    $('#newgroup-screen').hidden = true;

    $('#auth-screen').hidden = false;
    $('#chat-screen').hidden = true;
    $('#app').classList.remove('is-chat-open');
    $('#message-input').value = '';
    closeMenu();
    setTab(authMode);
  }

  async function logout() {
    await API.signOut();
    closeMenu();
    closeSearch();
    showAuth();
    toast('Вы вышли из аккаунта');
  }

  /* ----------------------------- поиск ------------------------------ */

  function highlight(text, q) {
    if (!q) return esc(text);
    var lower = text.toLowerCase();
    var ql = q.toLowerCase();
    var out = '';
    var i = 0;
    while (i <= text.length) {
      var idx = lower.indexOf(ql, i);
      if (idx === -1) { out += esc(text.slice(i)); break; }
      out += esc(text.slice(i, idx)) + '<mark>' + esc(text.slice(idx, idx + ql.length)) + '</mark>';
      i = idx + ql.length;
    }
    return out;
  }

  function snippet(text, q) {
    var lower = text.toLowerCase();
    var idx = lower.indexOf(String(q).toLowerCase());
    if (idx === -1) return esc(text.slice(0, 90)) + (text.length > 90 ? '…' : '');

    var start = Math.max(0, idx - 30);
    var end = Math.min(text.length, idx + q.length + 44);
    var piece = text.slice(start, end);
    return (start > 0 ? '…' : '') + highlight(piece, q) + (end < text.length ? '…' : '');
  }

  var PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 6v12M6 12h12"></path></svg>';
  var CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"></path></svg>';

  function chatResultHtml(hit, q) {
    var isFav = hit.type === 'saved' || hit.chatId === 'fav';
    var name = isFav ? 'Избранное' : hit.name;
    var fallback = isFav ? 'заметки и ссылки' : (hit.preview || 'перейти в чат');
    var body = hit.message ? snippet(hit.message.text, q) : esc(fallback);

    return '<button class="result" type="button" data-chat="' + esc(hit.chatId) + '"' +
      (hit.message ? ' data-msg="' + esc(hit.message.id) + '"' : '') + '>' +
      (isFav
        ? '<span class="fav-row__icon" style="width:34px;height:34px;border-radius:10px">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
            '<path d="M6 3.5h12a1 1 0 0 1 1 1v16l-7-4.4-7 4.4v-16a1 1 0 0 1 1-1Z"></path></svg></span>'
        : avatarHtml(hit.name, hit.color, 'avatar--xs')) +
      '<span class="result__main">' +
        '<span class="result__name">' + esc(name) + '</span>' +
        '<span class="result__snippet">' + body + '</span>' +
      '</span>' +
    '</button>';
  }

  function personResultHtml(p, q) {
    var sub = p.type === 'group'
      ? 'группа · ' + p.members + ' участников'
      : (p.email || (p.about === 'аккаунт' ? 'аккаунт' : 'человек'));

    return '<button class="result' + (p.chatId ? ' result--added' : '') + '" type="button" data-add="' + esc(p.id) + '">' +
      avatarHtml(p.name, p.color, 'avatar--xs', p.avatar) +
      '<span class="result__main">' +
        '<span class="result__name">' + (q ? highlight(p.name, q) : esc(p.name)) + '</span>' +
        '<span class="result__snippet">' + esc(sub) + '</span>' +
      '</span>' +
      '<span class="result__action">' + (p.chatId ? CHECK_ICON : PLUS_ICON) + '</span>' +
    '</button>';
  }

  async function renderSearch(query) {
    var q = String(query || '').trim();
    var seq = ++searchSeq;

    var box = $('#search-results');

    // без запроса ничего не показываем: люди и группы находятся только поиском
    if (!q) {
      box.innerHTML = '<div class="search-empty">Введите имя или почту —' +
        '<br>люди и группы находятся только так.</div>';
      return;
    }

    var res = await API.searchAll(q);
    if (seq !== searchSeq) return;

    var html = '';

    if (res.chats.length) {
      html += '<div class="search-group__title">Чаты</div>';
      html += res.chats.slice(0, 12).map(function (hit) { return chatResultHtml(hit, q); }).join('');
    }

    if (res.people.length) {
      html += '<div class="search-group__title">Люди и группы</div>';
      html += res.people.slice(0, 20).map(function (p) { return personResultHtml(p, q); }).join('');
    }

    if (res.groups && res.groups.length) {
      html += '<div class="search-group__title">Группы</div>';
      html += res.groups.map(function (g) {
        var action = g.joined ? CHECK_ICON : 'Войти';
        var actionClass = g.joined ? 'result__action' : 'result__action result__action--text';
        return '<button class="result" type="button" data-joingroup="' + esc(g.id) + '">' +
          avatarHtml(g.name, g.color, 'avatar--xs', g.avatar) +
          '<span class="result__main">' +
            '<span class="result__name">' + esc(g.name) + '</span>' +
            '<span class="result__snippet">' + g.members + ' участников</span>' +
          '</span>' +
          '<span class="' + actionClass + '">' + action + '</span>' +
        '</button>';
      }).join('');
    }

    if (!html) {
      html = '<div class="search-empty">Ничего не нашлось по «<b>' + esc(q) + '</b>»' +
        '<br>Попробуйте другое имя или почту.</div>';
    }

    box.innerHTML = html;
  }

  function openSearch() {
    if (!UI.me) return;
    searchOpen = true;
    $('#search-overlay').hidden = false;
    var input = $('#search-input');
    input.value = '';
    renderSearch('');
    setTimeout(function () { input.focus(); }, 30);
  }

  function closeSearch() {
    searchOpen = false;
    searchSeq++;
    $('#search-overlay').hidden = true;
  }

  async function joinGroupFromSearch(chatId) {
    if (!chatId) return;

    try {
      await API.joinGroup(chatId);
      closeSearch();
      await syncAll();
      await openChat(chatId);
      toast('Вы вступили в группу');
    } catch (e) {
      toast((e && e.message) || 'Не получилось вступить');
    }
  }

  async function addContact(entryId) {
    var chatId = await API.addChat(entryId);
    closeSearch();

    // новый чат должен появиться в списке сразу, без перезагрузки
    await refreshChats();
    await openChat(chatId);
    renderChatList();

    toast('Чат добавлен — можно писать');
  }

  /* ----------------------------- меню ------------------------------- */

  var menuTimer = null;

  function openMenu() {
    clearTimeout(menuTimer);

    var menu = $('#menu');
    var scrim = $('#menu-scrim');

    menu.classList.remove('is-closing');
    scrim.classList.remove('is-closing');
    menu.hidden = false;
    scrim.hidden = false;

    $('#menu-btn').setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    var menu = $('#menu');
    var scrim = $('#menu-scrim');
    if (!menu || menu.hidden || menu.classList.contains('is-closing')) return;

    menu.classList.add('is-closing');
    scrim.classList.add('is-closing');
    $('#menu-btn').setAttribute('aria-expanded', 'false');

    clearTimeout(menuTimer);
    menuTimer = setTimeout(function () {
      menu.classList.remove('is-closing');
      scrim.classList.remove('is-closing');
      menu.hidden = true;
      scrim.hidden = true;
      menu.style.transform = '';
    }, 480);
  }

  /* ----------------------------- события ---------------------------- */

  function bindEvents() {
    bindSwipe();

    // системный «назад» на Android (и кнопка назад в браузере)
    window.addEventListener('popstate', function () {
      if (membersOpen) { closeMembersUI(); return; }
      if (ngOpen) { closeNewGroupUI(); return; }
      if (settingsOpen) { closeSettingsUI(); return; }
      if (UI.activeId) closeChatUI();
    });

    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () { setTab(tab.getAttribute('data-tab')); });
    });

    $('#auth-form').addEventListener('submit', submitAuth);

    $('#email').addEventListener('blur', function () {
      var problem = emailProblem($('#email').value.trim());
      setError('email', problem);
      markValid('#email', !problem && !!$('#email').value.trim());
      syncAuthButton();
    });
    $('#email').addEventListener('input', function () {
      if ($('#email-error').classList.contains('is-shown')) {
        var problem = emailProblem($('#email').value.trim());
        setError('email', problem);
        markValid('#email', !problem);
      }
      syncAuthButton();
    });

    $('#password').addEventListener('blur', function () {
      if ($('#password').value) setError('password', passwordProblem($('#password').value));
      syncAuthButton();
    });
    $('#password').addEventListener('input', function () {
      if ($('#password-error').classList.contains('is-shown')) {
        setError('password', passwordProblem($('#password').value));
      }
      if (authMode === 'register' && $('#password2-error').classList.contains('is-shown')) {
        var p2 = password2Problem($('#password').value, $('#password2').value);
        setError('password2', p2);
        markValid('#password2', !p2);
      }
      syncAuthButton();
    });

    $('#password2').addEventListener('input', function () {
      var problem = password2Problem($('#password').value, $('#password2').value);
      setError('password2', problem);
      markValid('#password2', !problem && !!$('#password2').value);
      syncAuthButton();
    });

    $('#toggle-password').addEventListener('click', function () {
      var input = $('#password');
      var isPass = input.type === 'password';
      input.type = isPass ? 'text' : 'password';
      this.setAttribute('aria-label', isPass ? 'Скрыть пароль' : 'Показать пароль');
    });

    // страховка: панели едут из-за края, и автофокус не должен
    // прокручивать контейнер по горизонтали
    $('#app').addEventListener('scroll', function () {
      if (this.scrollLeft) this.scrollLeft = 0;
    });

    $('#menu-btn').addEventListener('click', function (ev) {
      ev.stopPropagation();
      if ($('#menu').hidden) openMenu(); else closeMenu();
    });

    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.sidebar__top') && !ev.target.closest('#menu')) closeMenu();
    });

    $('#menu-scrim').addEventListener('click', function () { closeMenu(); });

    var aboutScreen = $('#about-screen');
    if (aboutScreen) {
      $('#about-close').addEventListener('click', function () {
        aboutScreen.hidden = true;
      });

      aboutScreen.addEventListener('click', function (ev) {
        if (ev.target === aboutScreen) aboutScreen.hidden = true;
      });
    }

    var contactScreen = $('#contact-screen');
    if (contactScreen) {
      $('#contact-close').addEventListener('click', function () {
        contactScreen.hidden = true;
      });

      contactScreen.addEventListener('click', function (ev) {
        if (ev.target === contactScreen) contactScreen.hidden = true;
      });
    }

    // показать карточку человека: фото, имя, почта
    window.showContactCard = function (person) {
      var modal = document.getElementById('contact-screen');
      if (!modal || !person) return;

      var av = document.getElementById('contact-avatar');
      var tone = PALETTE[Math.abs(person.color || 0) % PALETTE.length];

      if (person.avatar) {
        av.className = 'avatar avatar--lg has-img';
        av.innerHTML = '<img class="avatar__img" src="' + esc(person.avatar) + '" alt="">';
      } else {
        av.className = 'avatar avatar--lg avatar--color';
        av.style.setProperty('--a1', tone[0]);
        av.style.setProperty('--a2', tone[1]);
        av.textContent = initials(person.name || '');
      }

      document.getElementById('contact-name').textContent = person.name || '';
      document.getElementById('contact-email').textContent = person.email || 'почта скрыта';
      modal.hidden = false;
    };

    // профиль открывается экраном настроек — без всплывающих окон
    document.querySelector('.me').addEventListener('click', openSettings);

    // настройки закрываются свайпом вверх
    var settingsEl = document.getElementById('settings-screen');
    var settingsDrag = null;

    if (settingsEl) {
      settingsEl.addEventListener('pointerdown', function (ev) {
        if (ev.target.closest('button, input, textarea, select, a')) return;

        var body = settingsEl.querySelector('.settings__body');
        if (body && body.scrollTop > 4) return;

        settingsDrag = { y: ev.clientY, dy: 0, active: false, id: ev.pointerId };
      });

      settingsEl.addEventListener('pointermove', function (ev) {
        if (!settingsDrag) return;

        var dy = ev.clientY - settingsDrag.y;

        if (!settingsDrag.active) {
          if (dy > -12) return;
          settingsDrag.active = true;
          settingsEl.classList.add('is-dragging');
          try { settingsEl.setPointerCapture(settingsDrag.id); } catch (e) { /* ignore */ }
        }

        var offset = Math.min(0, dy);
        settingsDrag.dy = offset;
        settingsEl.style.transform = 'translateY(' + offset + 'px)';
      });

      function endSettingsDrag() {
        if (!settingsDrag) return;

        var drag = settingsDrag;
        settingsDrag = null;
        if (!drag.active) return;

        settingsEl.classList.remove('is-dragging');
        settingsEl.style.transform = '';

        if (drag.dy < -90) closeSettings();
      }

      settingsEl.addEventListener('pointerup', endSettingsDrag);
      settingsEl.addEventListener('pointercancel', endSettingsDrag);
    }

    document.getElementById('pwd-form').addEventListener('submit', async function (ev) {
      ev.preventDefault();

      var error = document.getElementById('pwd-error');
      var oldPass = document.getElementById('pwd-old').value;
      var newPass = document.getElementById('pwd-new').value;
      var repeat = document.getElementById('pwd-repeat').value;

      error.classList.remove('is-ok');
      error.textContent = '';

      if (newPass.length < 6) { error.textContent = 'Новый пароль короче 6 символов'; return; }
      if (newPass !== repeat) { error.textContent = 'Пароли не совпадают'; return; }

      try {
        await API.changePassword(oldPass, newPass);
        document.getElementById('pwd-form').reset();
        error.classList.add('is-ok');
        error.textContent = 'Пароль изменён';
      } catch (e) {
        error.textContent = (e && e.message) || 'Не получилось сменить пароль';
      }
    });

    // свайп вверх закрывает меню; захват указателя включаем только после
    // заметного движения, иначе обычный тап по пункту не срабатывает
    var menuDrag = null;
    var menuEl = $('#menu');

    menuEl.addEventListener('pointerdown', function (ev) {
      menuDrag = { y: ev.clientY, dy: 0, active: false, id: ev.pointerId };
    });

    menuEl.addEventListener('pointermove', function (ev) {
      if (!menuDrag) return;

      var dy = ev.clientY - menuDrag.y;

      if (!menuDrag.active) {
        if (Math.abs(dy) < 10) return;   // это ещё тап, а не свайп
        menuDrag.active = true;
        menuEl.classList.add('is-dragging');
        try { menuEl.setPointerCapture(menuDrag.id); } catch (e) { /* ignore */ }
      }

      var offset = Math.min(0, dy);
      menuDrag.dy = offset;
      menuEl.style.transform = 'translateY(' + offset + 'px)';
    });

    function endMenuDrag() {
      if (!menuDrag) return;
      var drag = menuDrag;
      menuDrag = null;

      if (!drag.active) return;   // обычный тап — отдаём событие дальше

      menuEl.classList.remove('is-dragging');
      menuEl.style.transform = '';
      if (drag.dy < -48) closeMenu();
    }

    menuEl.addEventListener('pointerup', endMenuDrag);
    menuEl.addEventListener('pointercancel', endMenuDrag);

    $('#menu').addEventListener('click', function (ev) {
      var item = ev.target.closest('[data-action]');
      if (!item) return;      var action = item.getAttribute('data-action');
      if (action === 'logout') logout();
      if (action === 'about') {
        closeMenu();
        $('#about-screen').hidden = false;
      }
      if (action === 'settings') {
        closeMenu();
        openSettings();
      }
      if (action === 'newgroup') {
        closeMenu();
        openNewGroup();
      }
    });

    $('#settings-back').addEventListener('click', closeSettings);    $('#settings-change-avatar').addEventListener('click', function () { $('#avatar-input').click(); });
    $('#settings-avatar').addEventListener('click', function () { $('#avatar-input').click(); });

    $('#swatches').addEventListener('click', async function (ev) {
      var sw = ev.target.closest('[data-accent]');
      if (!sw) return;

      var id = sw.getAttribute('data-accent');
      applyAccent(id, true);

      if (UI.me) {
        try { UI.me = await API.setAccent(id); } catch (e) { /* ignore */ }
      }
    });

    $('#theme-seg').addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-theme-opt]');
      if (!btn) return;

      var next = btn.getAttribute('data-theme-opt') === 'dark' ? 'dark' : 'light';
      applyTheme(next);
      applyAccent(accentId, false);
      renderSettings();

      try {
        var saved = await API.setTheme(next);
        if (saved) UI.me = saved;
      } catch (e) { /* сохранится при следующем сохранении */ }
    });
    $('#settings-screen').addEventListener('click', function (ev) {
      var row = ev.target.closest('[data-settings-action]');
      if (!row) return;
      var action = row.getAttribute('data-settings-action');
      if (action === 'logout') logout();

      if (action === 'password') {
        var panel = document.getElementById('pwd-panel');
        if (panel) panel.hidden = !panel.hidden;
      }
    });

    document.getElementById('settings-save').addEventListener('click', async function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
      applyAccent(accentId, true);

      if (UI.me) {
        try { UI.me = await API.setAccent(accentId); } catch (e) { /* ignore */ }
      }

      toast('Настройки сохранены');
      closeSettings();
    });

    $('#chat-list').addEventListener('click', function (ev) {
      var item = ev.target.closest('[data-chat]');
      if (item) openChat(item.getAttribute('data-chat'));
    });

    $('#fav-row').addEventListener('click', function () { openChat('fav'); });
    $('#list-empty-cta').addEventListener('click', openSearch);
    $('#conv-back').addEventListener('click', closeChat);
    $('#members-back').addEventListener('click', closeMembers);

    // добавить участника в уже созданную группу
    var addBtn = document.getElementById('members-add');
    if (addBtn) {
      addBtn.addEventListener('click', async function () {
        if (!UI.activeId) return;

        var screen = document.getElementById('addmember-screen');
        var list = document.getElementById('addmember-list');
        list.innerHTML = '<div class="readers__empty">Загрузка…</div>';
        screen.hidden = false;

        try {
          var contacts = await API.listDirectory();
          var inChat = (membersData && membersData.members || []).map(function (m) { return m.name; });
          var free = (contacts || []).filter(function (c) { return inChat.indexOf(c.name) === -1; });

          if (!free.length) {
            list.innerHTML = '<div class="readers__empty">Все ваши контакты уже в группе</div>';
            return;
          }

          list.innerHTML = free.map(function (c) {
            return '<button class="readers__row readers__row--btn" type="button" data-addmember="' + esc(c.id) + '">' +
              avatarHtml(c.name, c.color, 'avatar--xs', c.avatar) +
              '<span class="readers__name">' + esc(c.name) + '</span>' +
            '</button>';
          }).join('');

          list.addEventListener('click', async function (ev) {
            var row = ev.target.closest('[data-addmember]');
            if (!row) return;

            try {
              await API.addMember(UI.activeId, row.getAttribute('data-addmember'));
              screen.hidden = true;

              var data = await API.getMembers(UI.activeId);
              if (data) renderMembers(data);

              await syncAll();
              var fresh = chatFromCache(UI.activeId);
              if (fresh) UI.active = fresh;

              toast('Участник добавлен');
            } catch (e) {
              toast((e && e.message) || 'Не получилось добавить');
            }
          }, { once: true });
        } catch (e) {
          list.innerHTML = '<div class="readers__empty">Не удалось загрузить контакты</div>';
        }
      });
    }

    var addClose = document.getElementById('addmember-close');
    if (addClose) {
      addClose.addEventListener('click', function () {
        document.getElementById('addmember-screen').hidden = true;
      });
      document.getElementById('addmember-screen').addEventListener('click', function (ev) {
        if (ev.target.id === 'addmember-screen') this.hidden = true;
      });
    }

    var leaveBtn = document.getElementById('members-leave');
    if (leaveBtn) {
      leaveBtn.addEventListener('click', async function () {
        var id = UI.activeId;
        if (!id) return;

        var sure = await askConfirm({
          title: 'Выйти из группы?',
          text: 'Вы перестанете получать сообщения. Вернуться можно через поиск.',
          ok: 'Выйти',
          danger: true
        });
        if (!sure) return;

        try {
          await API.leaveGroup(id);
          closeMembers();
          closeChat();
          await syncAll();
          toast('Вы вышли из группы');
        } catch (e) {
          toast((e && e.message) || 'Не получилось выйти');
        }
      });
    }

    var membersList = document.getElementById('members-list');
    if (membersList) {
      membersList.addEventListener('click', function (ev) {
        var row = ev.target.closest('.member');
        if (!row || !membersData) return;

        var idx = Number(row.getAttribute('data-member'));
        var person = membersData.members[idx];
        if (!person || person.isMe) return;

        showContactCard(person);
      });
    }

    // стрелка к последнему сообщению
    var downBtn = document.getElementById('conv-down');
    if (downBtn) {
      var syncDown = function () {
        var box = document.getElementById('messages');
        if (!box) return;
        downBtn.hidden = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
      };

      window.syncDownArrow = syncDown;

      var boxRef = document.getElementById('messages');
      if (boxRef) boxRef.addEventListener('scroll', syncDown);

      downBtn.addEventListener('click', function () {
        var b = document.getElementById('messages');
        if (!b) return;
        if (b.scrollTo) b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' });
        else b.scrollTop = b.scrollHeight;
      });
    }

    // предпросмотр вложений перед отправкой
    var previewSend = document.getElementById('preview-send');
    var previewCancel = document.getElementById('preview-cancel');

    if (previewSend) {
      previewSend.addEventListener('click', function () {
        var files = pendingFiles;
        closePreview();
        if (files && files.length) uploadFiles(files);
      });
    }

    if (previewCancel) {
      previewCancel.addEventListener('click', closePreview);
    }

    // полноэкранное видео: повёрнутый телефон — системный фуллскрин,
    // иначе показываем по центру внутри интерфейса
    var videoScreen = document.getElementById('video-screen');
    var videoPlayer = document.getElementById('video-full-player');

    document.getElementById('messages').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-expand]');
      if (!btn) return;

      var src = btn.getAttribute('data-src');
      var phone = window.matchMedia('(pointer: coarse)').matches;
      var landscape = window.innerWidth > window.innerHeight;

      if (phone && landscape) {
        var video = btn.closest('.bubble').querySelector('video');
        if (video && video.requestFullscreen) {
          video.requestFullscreen().catch(function () { /* ignore */ });
          return;
        }
      }

      if (!videoScreen || !videoPlayer) return;
      videoPlayer.src = src;
      videoScreen.hidden = false;
      videoPlayer.play().catch(function () { /* ignore */ });
    });

    if (videoScreen) {
      var videoClose = document.getElementById('video-close');

      function closeVideo() {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        videoScreen.hidden = true;
      }

      if (videoClose) videoClose.addEventListener('click', closeVideo);

      videoScreen.addEventListener('click', function (ev) {
        if (ev.target === videoScreen) closeVideo();
      });
    }

    // фото новой группы
    var ngPhotoBtn = document.getElementById('newgroup-photo');
    var ngPhotoInput = document.getElementById('newgroup-avatar-input');

    if (ngPhotoBtn && ngPhotoInput) {
      ngPhotoBtn.addEventListener('click', function () { ngPhotoInput.click(); });

      ngPhotoInput.addEventListener('change', async function () {
        var file = this.files && this.files[0];
        this.value = '';
        if (!file || !/^image\//.test(file.type || '')) return;

        try {
          ngAvatar = await makeAvatar(file);
          renderNewGroupAvatar();
        } catch (e) {
          toast('Не получилось прочитать картинку');
        }
      });
    }

    /* --- меню сообщения: ответ и кто прочитал --- */

    var msgMenu = document.getElementById('msg-menu');
    var messagesBox = document.getElementById('messages');
    var pressTimer = null;
    var press = null;
    var pressTarget = null;

    function messageById(id) {
      var list = (UI.active && UI.active.messages) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) return list[i];
      }
      return null;
    }

    var msgScrim = document.getElementById('msg-menu-scrim');

    function positionMsgMenu() {
      if (msgMenu.hidden) return;

      var appRect = document.getElementById('app').getBoundingClientRect();
      var size = msgMenu.getBoundingClientRect();

      var composer = document.getElementById('composer');
      var composerTop = composer
        ? composer.getBoundingClientRect().top - appRect.top
        : appRect.height - 72;

      // меню держится рядом с сообщением, но не уходит под поле ввода
      var msgNode = pressTarget
        ? document.querySelector('.msg[data-id="' + pressTarget.id + '"]')
        : null;

      var top;
      if (msgNode) {
        var msgRect = msgNode.getBoundingClientRect();
        top = msgRect.top - appRect.top - size.height - 10;
        if (top < 8) top = msgRect.bottom - appRect.top + 10;
      } else {
        top = composerTop - size.height - 10;
      }

      var maxTop = composerTop - size.height - 8;
      if (top > maxTop) top = maxTop;
      if (top < 8) top = 8;

      var left = (appRect.width - size.width) / 2;
      msgMenu.style.left = Math.round(left) + 'px';
      msgMenu.style.top = Math.round(top) + 'px';
    }

    function openMsgMenu(msg, clientX, clientY) {
      pressTarget = msg;
      msgMenu.hidden = false;
      if (msgScrim) msgScrim.hidden = false;

      // перезапускаем анимацию появления окна
      msgMenu.style.animation = 'none';
      void msgMenu.offsetWidth;
      msgMenu.style.animation = '';

      var readers = document.getElementById('msg-menu-readers');
      if (readers) {
        var isGroup = UI.active && UI.active.type === 'group';
        readers.hidden = !isGroup;
      }

      positionMsgMenu();
    }

    // клавиатура поднялась/опустилась — меню едет вместе с полем ввода
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        syncKeyboard();
        positionMsgMenu();
      });
      window.visualViewport.addEventListener('scroll', function () {
        syncKeyboard();
        positionMsgMenu();
      });
    }

    window.addEventListener('resize', function () {
      syncKeyboard();
      positionMsgMenu();
    });

    function closeMsgMenu() {
      msgMenu.hidden = true;
      if (msgScrim) msgScrim.hidden = true;
      pressTarget = null;
    }

    if (msgMenu && messagesBox) {
      window.closeMsgMenu = closeMsgMenu;

      if (msgScrim) {
        msgScrim.addEventListener('pointerdown', function (ev) {
          ev.stopPropagation();
          closeMsgMenu();
        });
      }

      document.addEventListener('pointerdown', function (ev) {
        if (msgMenu.hidden) return;
        if (ev.target.closest('#msg-menu')) return;
        closeMsgMenu();
      }, true);
      // сообщение можно взять и рядом с ним: область захвата шире самого пузыря
      function msgAtPoint(y) {
        var nodes = messagesBox.querySelectorAll('.msg');

        for (var i = nodes.length - 1; i >= 0; i--) {
          var rect = nodes[i].getBoundingClientRect();
          if (y >= rect.top - 14 && y <= rect.bottom + 14) return nodes[i];
        }

        return null;
      }

      messagesBox.addEventListener('pointerdown', function (ev) {
        var node = ev.target.closest('.msg') || msgAtPoint(ev.clientY);
        if (!node) return;

        press = { x: ev.clientX, y: ev.clientY, id: node.getAttribute('data-id'), node: node };
        clearTimeout(pressTimer);

        pressTimer = setTimeout(function () {
          if (!press) return;
          var msg = messageById(press.id);
          if (msg) openMsgMenu(msg, press.x, press.y);
          press = null;
        }, 420);
      });

      // потянул сообщение вправо — ответ на него
      var replyDrag = null;

      function resetReplyDrag() {
        if (replyDrag && replyDrag.node) {
          replyDrag.node.classList.remove('is-reply-drag');
          var bubble = replyDrag.node.querySelector('.bubble');
          if (bubble) bubble.style.transform = '';
        }
        replyDrag = null;
      }

      messagesBox.addEventListener('pointermove', function (ev) {
        if (!press && !replyDrag) return;

        if (press) {
          var dx0 = ev.clientX - press.x;
          var dy0 = ev.clientY - press.y;

          // ждём, пока жест определится: вправо — ответ, иначе — прокрутка
          if (Math.abs(dx0) < 12 && Math.abs(dy0) < 22) return;

          clearTimeout(pressTimer);
          var node0 = press.node;
          var startX = press.x;
          press = null;

          if (dx0 > 12 && dx0 > Math.abs(dy0) && node0) {
            replyDrag = { x: startX, node: node0, dx: 0 };
            node0.classList.add('is-reply-drag');
          }

          return;
        }

        var dx = ev.clientX - replyDrag.x;
        var bubble = replyDrag.node.querySelector('.bubble');

        replyDrag.dx = Math.max(0, Math.min(84, dx));
        if (bubble) bubble.style.transform = 'translateX(' + Math.round(replyDrag.dx) + 'px)';
      });

      function finishPress() {
        clearTimeout(pressTimer);
        press = null;

        if (replyDrag) {
          var dragged = replyDrag.dx;
          var node = replyDrag.node;
          resetReplyDrag();

          if (dragged > 48) {
            var msg = messageById(node.getAttribute('data-id'));
            if (msg) setReply(msg);
          }
        }
      }

      messagesBox.addEventListener('pointerup', finishPress);
      messagesBox.addEventListener('pointercancel', finishPress);

      messagesBox.addEventListener('contextmenu', function (ev) {
        var node = ev.target.closest('.msg');
        if (!node) return;
        ev.preventDefault();
        var msg = messageById(node.getAttribute('data-id'));
        if (msg) openMsgMenu(msg, ev.clientX, ev.clientY);
      });

      msgMenu.addEventListener('click', async function (ev) {
        var item = ev.target.closest('[data-msg-action]');
        if (!item || !pressTarget) return;

        var msg = pressTarget;
        var action = item.getAttribute('data-msg-action');
        closeMsgMenu();

        if (action === 'reply') {
          setReply(msg);
          var input = document.getElementById('message-input');
    // клавиатура не открывается сама — только по нажатию на поле
          return;
        }

        try {
          var data = await API.getReaders(UI.activeId, msg.id);
          renderReaders(data);
          document.getElementById('readers-screen').hidden = false;
        } catch (e) {
          toast('Не удалось получить список');
        }
      });

      document.addEventListener('click', function (ev) {
        if (msgMenu.hidden) return;
        if (ev.target.closest('#msg-menu')) return;
        closeMsgMenu();
      });
    }

    function askConfirm(options) {
    return new Promise(function (resolve) {
      var screen = document.getElementById('confirm-screen');
      var okBtn = document.getElementById('confirm-ok');
      var cancelBtn = document.getElementById('confirm-cancel');

      document.getElementById('confirm-title').textContent = options.title || 'Подтверждение';
      document.getElementById('confirm-text').textContent = options.text || '';
      okBtn.textContent = options.ok || 'Да';

      okBtn.classList.toggle('btn--danger', !!options.danger);
      screen.hidden = false;

      function finish(result) {
        screen.hidden = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        screen.removeEventListener('click', onBackdrop);
        resolve(result);
      }

      function onOk() { finish(true); }
      function onCancel() { finish(false); }
      function onBackdrop(ev) { if (ev.target === screen) finish(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      screen.addEventListener('click', onBackdrop);
    });
  }

  function renderReaders(data) {
      var box = document.getElementById('readers-list');
      if (!box) return;

      var rows = (data && data.readers) || [];
      if (!rows.length) {
        box.innerHTML = '<div class="readers__empty">Пока никто не прочитал</div>';
        return;
      }

      box.innerHTML = rows.map(function (r) {
        return '<div class="readers__row">' +
          avatarHtml(r.name, 0, 'avatar--xs', r.avatar) +
          '<span class="readers__name">' + esc(r.name) + '</span>' +
        '</div>';
      }).join('');
    }

    var readersClose = document.getElementById('readers-close');
    if (readersClose) {
      readersClose.addEventListener('click', function () {
        document.getElementById('readers-screen').hidden = true;
      });
      document.getElementById('readers-screen').addEventListener('click', function (ev) {
        if (ev.target.id === 'readers-screen') this.hidden = true;
      });
    }

    var replyCancel = document.getElementById('reply-cancel');
    if (replyCancel) replyCancel.addEventListener('click', clearReply);

    // фото группы может менять любой участник, не только владелец
    var groupAvatarBtn = document.getElementById('members-change-avatar');
    var groupAvatarInput = document.getElementById('group-avatar-input');

    if (groupAvatarBtn && groupAvatarInput) {
      groupAvatarBtn.addEventListener('click', function () {
        if (!UI.activeId) return;
        groupAvatarInput.click();
      });

      groupAvatarInput.addEventListener('change', async function () {
        var file = this.files && this.files[0];
        this.value = '';
        if (!file || !UI.activeId) return;
        if (!/^image\//.test(file.type || '')) { toast('Нужна картинка'); return; }

        try {
          var dataUrl = await makeAvatar(file);
          await API.setChatAvatar(UI.activeId, dataUrl);
          await syncAll();

          var fresh = chatFromCache(UI.activeId);
          if (fresh) UI.active = fresh;

          var members = await API.getMembers(UI.activeId);
          if (members) renderMembers(members);

          renderConversation();
          toast('Фото группы обновлено');
        } catch (e) {
          toast('Не получилось: ' + (e.message || 'ошибка'));
        }
      });
    }

    $('#conv-head').addEventListener('click', function (ev) {
      if (ev.target.closest('#conv-back')) return;
      if (!UI.active) return;

      if (UI.active.type === 'group') {
        openMembers();
        return;
      }

      // личный чат: показываем карточку собеседника с почтой
      if (UI.active.peerEmail) {
        showContactCard({
          name: UI.active.peerName || UI.active.name,
          email: UI.active.peerEmail,
          avatar: UI.active.peerAvatar,
          color: UI.active.color
        });
      }
    });

    // создание группы
    $('#newgroup-back').addEventListener('click', closeNewGroup);
    $('#newgroup-create').addEventListener('click', submitNewGroup);
    $('#newgroup-name').addEventListener('input', updateNewGroupButton);
    $('#newgroup-filter').addEventListener('input', function () {
      renderNewGroupList(this.value);
    });
    $('#newgroup-list').addEventListener('click', function (ev) {
      var pick = ev.target.closest('[data-pick]');
      if (!pick) return;
      var id = pick.getAttribute('data-pick');
      ngSelected[id] = !ngSelected[id];
      pick.classList.toggle('is-on', !!ngSelected[id]);
      updateNewGroupButton();
    });

    $('#composer').addEventListener('submit', sendMessage);

    // «печатает…» у собеседника: пока в поле есть текст
    $('#message-input').addEventListener('input', function () {
      markTyping(!!this.value.trim());
    });

    $('#message-input').addEventListener('blur', function () {
      markTyping(false);
    });

    $('#attach-btn').addEventListener('click', function () {
      if (!UI.activeId) { toast('Сначала откройте чат'); return; }
      $('#file-input').click();
    });

    $('#file-input').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (files.length) sendFiles(files);
    });

    $('#avatar-input').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      pickAvatar(file);
    });

    $('#me-avatar').addEventListener('click', function () {
      openSettings();
    });

    $('#messages').addEventListener('click', function (ev) {
      var img = ev.target.closest('img.bubble__img');
      if (img && img.src) openLightbox(img.src);
    });

    $('#lightbox').addEventListener('click', closeLightbox);

    $('#search-trigger').addEventListener('click', openSearch);
    $('#search-close').addEventListener('click', closeSearch);

    $('#search-input').addEventListener('input', function () { renderSearch(this.value); });

    $('#search-results').addEventListener('click', function (ev) {
      var add = ev.target.closest('[data-add]');
      if (add) { addContact(add.getAttribute('data-add')); return; }

      var group = ev.target.closest('[data-joingroup]');
      if (group) { joinGroupFromSearch(group.getAttribute('data-joingroup')); return; }

      var chat = ev.target.closest('[data-chat]');
      if (!chat) return;
      var chatId = chat.getAttribute('data-chat');
      var msgId = chat.getAttribute('data-msg');
      closeSearch();
      openChat(chatId, msgId || undefined);
    });

    $('#search-overlay').addEventListener('mousedown', function (ev) {
      if (ev.target === this) closeSearch();
    });

    document.addEventListener('keydown', function (ev) {
      var typing = /^(INPUT|TEXTAREA)$/.test(ev.target.tagName) || ev.target.isContentEditable;

      if (ev.key === 'Escape') {
        if (!$('#lightbox').hidden) { closeLightbox(); ev.preventDefault(); return; }
        if (searchOpen) { closeSearch(); ev.preventDefault(); return; }
        if (membersOpen) { closeMembers(); ev.preventDefault(); return; }
        if (ngOpen) { closeNewGroup(); ev.preventDefault(); return; }
        if (settingsOpen) { closeSettings(); ev.preventDefault(); return; }
        if (UI.activeId) { closeChat(); ev.preventDefault(); return; }
        if (!$('#menu').hidden) { closeMenu(); return; }
        return;
      }

      if (searchOpen && ev.key === 'Enter') {
        var first = $('#search-results .result');
        if (first) first.click();
        return;
      }

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        if (!searchOpen) openSearch();
        return;
      }

      if (ev.key === '/' && !typing) {
        ev.preventDefault();
        openSearch();
      }
    });
  }

  /* ------------------------------ старт ----------------------------- */

  async function init() {
    initTheme();
    applyAccent(accentId, false);

    // включаем плавную смену темы только после первого кадра,
    // чтобы не было анимации «из тёмной в светлую» на старте
    requestAnimationFrame(function () {
      document.documentElement.classList.add('vars-ready');
    });

    bindEvents();
    setTab('login');

    var params = new URLSearchParams(location.search);
    var themeParam = params.get('theme');
    if (themeParam === 'light' || themeParam === 'dark') {
      applyTheme(themeParam);
      applyAccent(accentId, false);
    }

    var accentParam = params.get('accent');
    if (accentParam) applyAccent(accentParam, false);

    if (params.get('demo') === '1') {
      try { await API.signIn(DEMO.email, DEMO.password); } catch (e) { /* ignore */ }
    }

    var me = await API.me();
    if (!me) {
      showAuth();
      if (params.get('tab') === 'register') setTab('register');
      return;
    }

    await enterApp();

    var chatParam = params.get('chat');
    if (chatParam) {
      try { await openChat(chatParam); } catch (e) { /* нет такого чата */ }
    }

    if (params.get('search') === '1') {
      openSearch();
      var q = params.get('q');
      if (q) {
        $('#search-input').value = q;
        await renderSearch(q);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // веб-приложение: ставим интерфейс на устройство
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ });
    });
  }
})();
