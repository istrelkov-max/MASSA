/* ===================================================================
   massa — слой данных (API).

   Сейчас работает локальный бэкенд: всё лежит в localStorage браузера,
   сетевых запросов нет. Интерфейс общается только с MassaApi, поэтому
   позже достаточно поменять backend: 'local' → 'firebase', не трогая UI.

   Все идентификаторы — UUID v4: пользователи, записи справочника, чаты,
   сообщения и файлы. Вложения на диске тоже адресуются по UUID.
   Интерфейс использует псевдо-id 'fav' как маршрут к «Избранному»;
   у самой записи избранного есть свой UUID.

   Контракт (все методы возвращают Promise):
     me()                        → { email, name, avatar } | null
     signIn(email, password)     → { email, name }        (ошибка: ApiError)
     signUp(email, password)     → { email, name }        (ошибка: ApiError)
     signOut()                   → void
     setAvatar(dataUrl)          → { email, name, avatar, accent }
     setAccent(id)               → { email, name, avatar, accent }
     listChats()                 → [{ id, name, handle, type, color, unread,
                                     online, lastMessage: { text, mine, time } | null }]
     getChat(id)                 → { ...chat, messages: [{ id, mine, text, time, date,
                                     file: { id, name, size, type, kind } | null }] }
     favoritesCount()            → number
     sendMessage(chatId, text)   → message
     sendFile(chatId, file)      → { message, persisted }
     fileUrl(fileId)             → objectURL | null
     markRead(chatId)            → void
     searchAll(query)            → { chats: [...], people: [...] }
     addChat(directoryId)        → chatId
     createGroup(name, memberIds) → chatId
     getMembers(chatId)          → { id, name, count, members: [{ name, handle, color, role, isMe }] }
     reset()                     → void (сброс демо-данных)

   Схема для Firebase (когда подключим):
     /users/{uid}                  { email, name, createdAt }
     /users/{uid}/chats/{chatId}   { type, title, peerId, lastMessage, unread }
     /chats/{chatId}/messages/{id} { from, text, ts }
     /chats/{chatId}/members/{uid} true
   =================================================================== */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'massa.demo.v4';
  var LEGACY_KEY = 'massa.demo.v3';
  var VERSION = 4;

  var DEMO_EMAIL = 'admin@massa.app';
  var LEGACY_DEMO_EMAIL = 'vasyapupkin@mail.com';
  var ADMIN_NAME = 'Админ';
  var DEMO_PASSWORD = '123456';

  /* ---------------------------- утилиты ---------------------------- */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function nowTime() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  // единственный вид идентификатора в данных: UUID v4
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID(); } catch (e) { /* ignore */ }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  }

  function nameFromEmail(email) {
    var local = String(email).split('@')[0].replace(/[._-]+/g, ' ').trim();
    if (!local) return 'Без имени';
    return local.charAt(0).toUpperCase() + local.slice(1);
  }

  // ошибка с привязкой к полю формы
  function apiError(field, message) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.field = field;
    return err;
  }

  /* --------------------------- файлы ------------------------------- */
  /*
   * Где хранятся вложения: сначала пробуем IndexedDB (большие файлы),
   * если браузер не даёт (например, file:// в некоторых сборках) —
   * складываем небольшие файлы в localStorage, остальное держим в памяти
   * до перезагрузки. При переезде на Firebase это место заменится на Storage.
   */
  var FileStore = (function () {
    var LS_KEY = 'massa.files.v1';
    var mem = {};
    var cache = {};
    var db = null;
    var idbReady = false;
    var LS_LIMIT = 1500 * 1024;

    function openIdb() {
      return new Promise(function (resolve) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          resolve(null);
        }, 1200);

        if (!window.indexedDB) { clearTimeout(timer); return resolve(null); }

        var req;
        try { req = indexedDB.open('massa-files', 1); }
        catch (e) { clearTimeout(timer); return resolve(null); }

        req.onupgradeneeded = function () {
          try { req.result.createObjectStore('files'); } catch (e) { /* ignore */ }
        };
        req.onsuccess = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(req.result);
        };
        req.onerror = req.onblocked = function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        };
      });
    }

    function idbWrite(key, blob) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(blob, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    }

    function idbRead(key) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('files', 'readonly');
        var req = tx.objectStore('files').get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    }

    function readLs() {
      try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
    }

    function writeLs(map) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(map)); return true; }
      catch (e) { return false; }
    }

    function toDataUrl(blob) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error); };
        reader.readAsDataURL(blob);
      });
    }

    return {
      init: async function () {
        db = await openIdb();
        idbReady = !!db;
      },

      put: async function (id, blob) {
        if (idbReady) {
          try { await idbWrite(id, blob); return true; } catch (e) { idbReady = false; }
        }
        if (blob.size <= LS_LIMIT) {
          try {
            var map = readLs();
            map[id] = await toDataUrl(blob);
            if (writeLs(map)) return true;
          } catch (e) { /* ignore */ }
        }
        mem[id] = blob;
        return false;
      },

      get: async function (id) {
        if (idbReady) {
          try {
            var stored = await idbRead(id);
            if (stored) return stored;
          } catch (e) { /* ignore */ }
        }
        if (mem[id]) return mem[id];

        var map = readLs();
        if (map[id]) {
          try {
            var res = await fetch(map[id]);
            return await res.blob();
          } catch (e) { /* ignore */ }
        }
        return null;
      },

      url: async function (id) {
        if (cache[id]) return cache[id];
        var blob = await this.get(id);
        if (!blob) return null;
        cache[id] = URL.createObjectURL(blob);
        return cache[id];
      },

      clear: function () {
        mem = {};
        cache = {};
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      }
    };
  })();

  /* ---------------------------- данные ----------------------------- */

  function seed() {
    return {
      version: VERSION,
      users: [
        { id: uuid(), email: DEMO_EMAIL, password: DEMO_PASSWORD, name: ADMIN_NAME, role: 'admin' }
      ],
      session: null,
      chats: [],
      favorites: {
        id: uuid(),
        messages: [
          { id: uuid(), mine: true, text: 'Макет главного экрана v2 — figma.com/file/…', time: '11:20', date: 'Вчера' },
          { id: uuid(), mine: true, text: 'Не забыть: при регистрации проверять повтор пароля', time: '11:24', date: 'Вчера' },
          { id: uuid(), mine: true, text: 'Чек-лист: вход, поиск, добавление людей, избранное', time: '09:15', date: 'Сегодня' }
        ]
      },
      directory: [
        { id: uuid(), type: 'user', name: 'Аня Соколова', handle: '@anya', email: 'anya@mail.com', about: 'дизайнер', color: 0 },
        { id: uuid(), type: 'user', name: 'Дмитрий Волков', handle: '@dvolkov', email: 'd.volkov@mail.com', about: 'разработчик', color: 1 },
        { id: uuid(), type: 'user', name: 'Марина Ким', handle: '@marina.kim', email: 'marina@mail.com', about: 'продакт', color: 4 },
        { id: uuid(), type: 'user', name: 'Саша Гордеев', handle: '@gordeev', email: 'sg@mail.com', about: 'тестировщик', color: 2 },
        { id: uuid(), type: 'user', name: 'Илья Орлов', handle: '@ilya.orlov', email: 'ilya@mail.com', about: 'бэкенд', color: 5 },
        { id: uuid(), type: 'user', name: 'Оля Панова', handle: '@olya.p', email: 'olya@mail.com', about: 'вёрстка', color: 6 },
        { id: uuid(), type: 'user', name: 'Никита Левин', handle: '@nlevin', email: 'n.levin@mail.com', about: 'аналитик', color: 7 },
        { id: uuid(), type: 'user', name: 'Егор Смирнов', handle: '@egor.s', email: 'egor@mail.com', about: 'DevOps', color: 3 },
        {
          id: uuid(), type: 'group', name: 'Команда масса', handle: '@massa_team',
          about: 'рабочий чат', members: 8, color: 0,
          people: [
            { name: 'Аня Соколова', handle: '@anya', color: 0, role: 'админ' },
            { name: 'Дмитрий Волков', handle: '@dvolkov', color: 1 },
            { name: 'Марина Ким', handle: '@marina.kim', color: 4 },
            { name: 'Саша Гордеев', handle: '@gordeev', color: 2 },
            { name: 'Илья Орлов', handle: '@ilya.orlov', color: 5 },
            { name: 'Оля Панова', handle: '@olya.p', color: 6 },
            { name: 'Егор Смирнов', handle: '@egor.s', color: 3 }
          ]
        },
        {
          id: uuid(), type: 'group', name: 'Дизайн-ревью', handle: '@design_review',
          about: 'макеты и правки', members: 5, color: 4,
          people: [
            { name: 'Аня Соколова', handle: '@anya', color: 0, role: 'админ' },
            { name: 'Марина Ким', handle: '@marina.kim', color: 4 },
            { name: 'Оля Панова', handle: '@olya.p', color: 6 },
            { name: 'Никита Левин', handle: '@nlevin', color: 7 }
          ]
        },
        {
          id: uuid(), type: 'group', name: 'Флудилка', handle: '@flood',
          about: 'обо всём', members: 12, color: 6,
          people: [
            { name: 'Аня Соколова', handle: '@anya', color: 0 },
            { name: 'Дмитрий Волков', handle: '@dvolkov', color: 1 },
            { name: 'Марина Ким', handle: '@marina.kim', color: 4 },
            { name: 'Саша Гордеев', handle: '@gordeev', color: 2, role: 'модератор' },
            { name: 'Илья Орлов', handle: '@ilya.orlov', color: 5 },
            { name: 'Оля Панова', handle: '@olya.p', color: 6 },
            { name: 'Никита Левин', handle: '@nlevin', color: 7 },
            { name: 'Егор Смирнов', handle: '@egor.s', color: 3 },
            { name: 'Лена Кузнецова', handle: '@lena.k', color: 3 },
            { name: 'Пётр Савельев', handle: '@petr.s', color: 1 },
            { name: 'Катя Морозова', handle: '@katya.m', color: 6 }
          ]
        }
      ]
    };
  }

  // сохранения до v4: id были короткие ('c-g1', 'm1k2'), сессия — по почте
  function migrateFromV3(old) {
    var seeded = seed();
    var idMap = {};

    var users = (old.users || []).map(function (u) {
      return Object.assign({}, u, { id: u.id || uuid() });
    });

    var directory = (old.directory || []).map(function (entry) {
      var newId = uuid();
      idMap[entry.id] = newId;

      var fresh = seeded.directory.filter(function (e) {
        return e.handle === entry.handle || e.name === entry.name;
      })[0];

      var next = Object.assign({}, entry, { id: newId });
      if ((!next.people || !next.people.length) && fresh && fresh.people) {
        next.people = fresh.people;
        next.members = fresh.members;
      }
      return next;
    });

    var chats = (old.chats || []).map(function (chat) {
      var next = Object.assign({}, chat, { id: uuid() });
      if (chat.entryId && idMap[chat.entryId]) next.entryId = idMap[chat.entryId];
      next.messages = (chat.messages || []).map(function (m) {
        return Object.assign({}, m, { id: uuid() });
      });
      return next;
    });

    var session = null;
    if (old.session && old.session.email) {
      var owner = users.filter(function (u) { return u.email === old.session.email; })[0];
      session = owner ? { userId: owner.id } : null;
    }

    var favorites = {
      id: (old.favorites && old.favorites.id) || uuid(),
      messages: ((old.favorites && old.favorites.messages) || []).map(function (m) {
        return Object.assign({}, m, { id: uuid() });
      })
    };

    return {
      version: VERSION,
      users: users,
      session: session,
      chats: chats,
      favorites: favorites,
      directory: directory
    };
  }

  // добираем поля, которых могло не быть в ранних v4-сохранениях
  function normalize(data) {
    if (!data.favorites) data.favorites = { id: uuid(), messages: [] };
    if (!data.favorites.id) data.favorites.id = uuid();
    if (!Array.isArray(data.users)) data.users = [];
    if (!Array.isArray(data.directory)) data.directory = [];
    if (!Array.isArray(data.chats)) data.chats = [];

    (data.favorites.messages || []).forEach(function (m) {
      if (!m.id) m.id = uuid();
    });

    data.users.forEach(function (u) {
      if (!u.id) u.id = uuid();
    });

    data.directory.forEach(function (e) {
      if (!e.id) e.id = uuid();
    });

    // старые чаты были «ничьи» — отдаём их админу
    var admin = data.users.filter(function (u) { return u.role === 'admin'; })[0];
    if (admin) {
      data.chats.forEach(function (c) {
        if (!c.ownerId) c.ownerId = admin.id;
      });
    }

    // демо-аккаунт всегда админский; старый переименовываем
    var legacy = data.users.filter(function (u) { return u.email === LEGACY_DEMO_EMAIL; })[0];
    if (legacy && !data.users.some(function (u) { return u.email === DEMO_EMAIL; })) {
      legacy.email = DEMO_EMAIL;
      legacy.name = ADMIN_NAME;
    }

    var demo = data.users.filter(function (u) { return u.email === DEMO_EMAIL; })[0];
    if (demo) {
      demo.role = 'admin';
      if (!demo.name || demo.name === 'Вася Пупкин') demo.name = ADMIN_NAME;
    }
  }

  function read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && data.version === VERSION) {
          normalize(data);
          return data;
        }
      }

      // одноразовый переход со старой версии
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        var old = JSON.parse(legacy);
        if (old && old.version === 3) {
          var migrated = migrateFromV3(old);
          normalize(migrated);
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)); } catch (e) { /* ignore */ }
          return migrated;
        }
      }
    } catch (e) { /* приватный режим или мусор */ }
    return seed();
  }

  var state = read();

  (function ensureDemoUser() {
    var found = state.users.some(function (u) { return u.email === DEMO_EMAIL; });
    if (!found) {
      state.users.push({ id: uuid(), email: DEMO_EMAIL, password: DEMO_PASSWORD, name: ADMIN_NAME, role: 'admin' });
    }
  })();

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function currentUser() {
    if (!state.session || !state.session.userId) return null;
    return state.users.filter(function (u) { return u.id === state.session.userId; })[0] || null;
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role || 'user',
      avatar: user.avatar || null,
      accent: user.accent || null
    };
  }

  function isAdmin(user) {
    return !!(user && user.role === 'admin');
  }

  function findChat(id) {
    return state.chats.filter(function (c) { return c.id === id; })[0] || null;
  }

  function lastPreview(message) {
    if (!message) return null;
    var text;
    if (message.file) {
      text = message.file.kind === 'image' ? 'Фото' : message.file.name;
    } else {
      text = message.text;
    }
    return { text: text, mine: !!message.mine, time: message.time };
  }

  function chatMeta(chat) {
    var last = chat.messages[chat.messages.length - 1];
    var me = currentUser();
    var owned = !chat.ownerId || !!(me && chat.ownerId === me.id);

    var meta = {
      id: chat.id,
      name: chat.name,
      handle: chat.handle,
      type: chat.type,
      color: chat.color,
      ownerId: chat.ownerId || null,
      owned: owned,
      unread: chat.unread || 0,
      online: !!chat.online,
      members: chat.members || 0,
      lastMessage: lastPreview(last)
    };

    // админу показываем, чей это чат
    if (!owned && isAdmin(me)) {
      var owner = state.users.filter(function (u) { return u.id === chat.ownerId; })[0];
      meta.ownerName = owner ? owner.name : 'неизвестный';
    }

    return meta;
  }

  function chatFull(chat) {
    return Object.assign(chatMeta(chat), { messages: chat.messages.slice() });
  }

  function isSavedChat(id) {
    return id === 'fav' || id === state.favorites.id;
  }

  function favoritesChat() {
    var messages = state.favorites.messages;
    var last = messages[messages.length - 1];
    return {
      id: state.favorites.id,
      name: 'Избранное',
      handle: 'только вы',
      type: 'saved',
      color: 3,
      unread: 0,
      online: false,
      members: 0,
      messages: messages.slice(),
      lastMessage: lastPreview(last)
    };
  }

  /* ------------------------- локальный бэкенд ---------------------- */

  var LocalBackend = {
    mode: 'local',

    me: async function () {
      return publicUser(currentUser());
    },

    signIn: async function (email, password) {
      var normalized = String(email || '').trim().toLowerCase();
      var user = state.users.filter(function (u) { return u.email === normalized; })[0];
      if (!user) throw apiError('email', 'Аккаунт не найден. Проверьте почту или зарегистрируйтесь.');
      if (user.password !== password) throw apiError('password', 'Неверный пароль');
      state.session = { userId: user.id };
      persist();
      return publicUser(user);
    },

    signUp: async function (email, password) {
      var normalized = String(email || '').trim().toLowerCase();
      var exists = state.users.some(function (u) { return u.email === normalized; });
      if (exists) throw apiError('email', 'Аккаунт с такой почтой уже есть — войдите.');

      var user = { id: uuid(), email: normalized, password: password, name: nameFromEmail(normalized) };
      state.users.push(user);
      state.session = { userId: user.id };
      persist();
      return publicUser(user);
    },

    signOut: async function () {
      state.session = null;
      persist();
    },

    listChats: async function () {
      var me = currentUser();
      var admin = isAdmin(me);

      return state.chats
        .filter(function (chat) {
          if (admin) return true;
          return !chat.ownerId || (me && chat.ownerId === me.id);
        })
        .map(chatMeta);
    },

    // всё сразу: чаты с сообщениями и файлами
    sync: async function () {
      var me = currentUser();
      var admin = isAdmin(me);

      var chats = state.chats
        .filter(function (chat) {
          if (admin) return true;
          return !chat.ownerId || (me && chat.ownerId === me.id);
        })
        .map(chatFull);

      var fav = favoritesChat();
      var files = {};

      chats.concat([fav]).forEach(function (chat) {
        chat.messages.forEach(function (m) {
          if (m.file) files[m.file.id] = m.file;
        });
      });

      return {
        chats: chats,
        favorites: {
          id: fav.id,
          messages: fav.messages,
          count: fav.messages.length
        },
        files: files
      };
    },

    getChat: async function (id) {
      if (isSavedChat(id)) return favoritesChat();
      var chat = findChat(id);
      if (!chat) throw new Error('Чат не найден');
      return chatFull(chat);
    },

    favoritesCount: async function () {
      return state.favorites.messages.length;
    },

    sendMessage: async function (chatId, text) {
      var message = {
        id: uuid(),
        mine: true,
        text: String(text),
        time: nowTime(),
        date: 'Сегодня'
      };

      if (isSavedChat(chatId)) {
        state.favorites.messages.push(message);
      } else {
        var chat = findChat(chatId);
        if (!chat) throw new Error('Чат не найден');
        chat.messages.push(message);
      }

      persist();
      return message;
    },

    sendFile: async function (chatId, file) {
      var fileId = uuid();
      var persisted = await FileStore.put(fileId, file.blob);

      var message = {
        id: uuid(),
        mine: true,
        text: file.caption || '',
        time: nowTime(),
        date: 'Сегодня',
        file: {
          id: fileId,
          name: file.name,
          size: file.size,
          type: file.type,
          kind: file.kind || (/^image\//.test(file.type) ? 'image' : 'file')
        }
      };

      if (isSavedChat(chatId)) {
        state.favorites.messages.push(message);
      } else {
        var chat = findChat(chatId);
        if (!chat) throw new Error('Чат не найден');
        chat.messages.push(message);
      }

      persist();
      return { message: message, persisted: persisted };
    },

    fileUrl: async function (fileId) {
      return FileStore.url(fileId);
    },

    setChatAvatar: async function (chatId, dataUrl) {
      var chat = state.chats.filter(function (c) { return c.id === chatId; })[0];
      if (!chat) throw apiError('chat', 'Чат не найден');
      chat.avatar = dataUrl || null;
      save();
      return chatFull(chat);
    },

    changePassword: async function (oldPassword, newPassword) {
      var me = currentUser();
      if (!me) throw apiError('email', 'Нужно войти');
      var user = state.users.filter(function (u) { return u.id === me.id; })[0];
      if (!user) throw apiError('email', 'Аккаунт не найден');
      if (user.password !== oldPassword) throw apiError('old', 'Старый пароль не подходит');
      if (!newPassword || newPassword.length < 6) throw apiError('new', 'Новый пароль короче 6 символов');
      user.password = newPassword;
      save();
      return { ok: true };
    },

    setAvatar: async function (dataUrl) {
      var user = currentUser();
      if (!user) throw new Error('Нет активного пользователя');
      user.avatar = dataUrl || null;
      persist();
      return publicUser(user);
    },

    setTheme: async function (theme) {
      var user = currentUser();
      if (!user) throw new Error('Нет активного пользователя');
      user.theme = theme === 'dark' ? 'dark' : 'light';
      persist();
      return publicUser(user);
    },

    setAccent: async function (id) {
      var user = currentUser();
      if (!user) throw new Error('Нет активного пользователя');
      user.accent = id || null;
      persist();
      return publicUser(user);
    },

    markRead: async function (chatId) {
      var chat = findChat(chatId);
      if (chat && chat.unread) {
        chat.unread = 0;
        persist();
      }
    },

    searchAll: async function (query) {
      var q = String(query || '').trim().toLowerCase();

      var chats = [];

      function chatHit(chat, message) {
        var last = chat.messages[chat.messages.length - 1];
        return {
          chatId: chat.id,
          name: chat.name,
          color: chat.color,
          type: chat.type,
          preview: last ? last.text : '',
          message: message ? { id: message.id, text: message.text } : null
        };
      }

      if (q) {
        var me = currentUser();
        var admin = isAdmin(me);

        state.chats.forEach(function (chat) {
          if (!admin && chat.ownerId && (!me || chat.ownerId !== me.id)) return;

          if (chat.name.toLowerCase().indexOf(q) !== -1) chats.push(chatHit(chat, null));
          chat.messages
            .filter(function (m) { return m.text.toLowerCase().indexOf(q) !== -1; })
            .slice(-3).reverse()
            .forEach(function (m) { chats.push(chatHit(chat, m)); });
        });

        var favChat = favoritesChat();
        state.favorites.messages
          .filter(function (m) { return m.text.toLowerCase().indexOf(q) !== -1; })
          .slice(-3).reverse()
          .forEach(function (m) { chats.push(chatHit(favChat, m)); });
      }

      // без запроса никого не показываем: люди и группы находятся только поиском
      var added = {};
      state.chats.forEach(function (c) { if (c.entryId) added[c.entryId] = c.id; });

      var people = q ? state.directory.filter(function (entry) {
        var haystack = [entry.name, entry.handle, entry.email || '', entry.about || '']
          .join(' ').toLowerCase();
        return haystack.indexOf(q) !== -1;
      }).map(function (entry) {
        return {
          id: entry.id,
          type: entry.type,
          name: entry.name,
          handle: entry.handle,
          email: entry.email || '',
          about: entry.about || '',
          members: entry.members || 0,
          color: entry.color,
          chatId: added[entry.id] || null
        };
      }) : [];

      return { chats: chats, people: people };
    },

    addChat: async function (directoryId) {
      var entry = state.directory.filter(function (e) { return e.id === directoryId; })[0];
      if (!entry) throw new Error('Такого контакта нет в справочнике');

      var me = currentUser();
      var exists = state.chats.filter(function (c) {
        return c.entryId === directoryId && me && c.ownerId === me.id;
      })[0];
      if (exists) return exists.id;

      var chat = {
        id: uuid(),
        entryId: directoryId,
        name: entry.name,
        handle: entry.handle,
        type: entry.type,
        color: entry.color,
        members: entry.members || 0,
        people: entry.people ? entry.people.slice() : [],
        ownerId: me ? me.id : null,
        online: false,
        unread: 0,
        messages: []
      };

      state.chats.push(chat);
      persist();
      return chat.id;
    },

    // справочник целиком — нужен для выбора участников новой группы
    listDirectory: async function () {
      return state.directory
        .filter(function (entry) { return entry.type === 'user'; })
        .map(function (entry) {
          return {
            id: entry.id,
            type: entry.type,
            name: entry.name,
            handle: entry.handle || '',
            email: entry.email || '',
            about: entry.about || '',
            color: entry.color
          };
        });
    },

    // новая группа из выбранных людей
    createGroup: async function (name, memberIds) {
      var title = String(name || '').trim();
      if (!title) throw new Error('Введите название группы');

      var me = currentUser();

      var people = (memberIds || []).map(function (id) {
        return state.directory.filter(function (e) { return e.id === id; })[0];
      }).filter(function (e) {
        return e && e.type === 'user';
      }).map(function (e) {
        return { name: e.name, handle: e.handle || '', color: e.color || 0 };
      });

      if (!people.length) throw new Error('Добавьте хотя бы одного участника');

      var chat = {
        id: uuid(),
        entryId: null,
        name: title,
        handle: '',
        type: 'group',
        color: Math.floor(Math.random() * 8),
        members: people.length + 1,
        people: people,
        ownerId: me ? me.id : null,
        online: false,
        unread: 0,
        messages: []
      };

      state.chats.push(chat);
      persist();
      return chat.id;
    },

    // участники группы: вы + все, кто записан в people
    getMembers: async function (chatId) {
      var chat = findChat(chatId);
      if (!chat || chat.type !== 'group') return null;

      var entry = chat.entryId
        ? state.directory.filter(function (e) { return e.id === chat.entryId; })[0]
        : null;

      var people = (chat.people && chat.people.length)
        ? chat.people
        : ((entry && entry.people) || []);

      // последняя страховка: если в сохранении состава нет вообще,
      // берём его из исходных данных
      if (!people.length && chat.entryId) {
        var freshEntry = seed().directory.filter(function (e) { return e.id === chat.entryId; })[0];
        if (freshEntry && freshEntry.people) people = freshEntry.people;
      }

      var me = currentUser();
      var list = [];

      if (me) {
        list.push({
          name: me.name,
          handle: me.avatar ? 'вы' : 'вы · ' + me.email,
          color: 0,
          isMe: true,
          role: ''
        });
      }

      return {
        id: chat.id,
        name: chat.name,
        handle: chat.handle,
        color: chat.color,
        count: people.length + (me ? 1 : 0),
        members: list.concat(people.map(function (p) {
          return { name: p.name, handle: p.handle, color: p.color, role: p.role || '' };
        }))
      };
    },

    reset: async function () {
      state = seed();
      persist();
      FileStore.clear();
    }
  };

  /* ------------------------ заготовка Firebase --------------------- */
  /*
   * Ждём следующей версии: Firebase Auth (вход по почте) + Realtime Database.
   * Ниже намеренно нет сетевых вызовов — только контракт, чтобы UI уже был
   * готов к переключению. Понадобится:
   *   1. firebase-config (apiKey, databaseURL, projectId);
   *   2. firebase-auth: signInWithEmailAndPassword / createUserWithEmailAndPassword;
   *   3. подписка onValue на /users/{uid}/chats и /chats/{chatId}/messages;
   *   4. правила безопасности: read/write только владельцу и участникам чата.
   */
  function notConnected() {
    return Promise.reject(new Error('Firebase пока не подключён — работает локальный режим'));
  }

  var FirebaseBackend = {
    mode: 'firebase',
    me: notConnected,
    signIn: notConnected,
    signUp: notConnected,
    signOut: notConnected,
    setAvatar: notConnected,
    changePassword: notConnected,
    setChatAvatar: notConnected,
    setAccent: notConnected,
    setTheme: notConnected,
    listChats: notConnected,
    sync: notConnected,
    getChat: notConnected,
    favoritesCount: notConnected,
    sendMessage: notConnected,
    getReaders: notConnected,
    leaveGroup: notConnected,
    joinGroup: notConnected,
    presence: notConnected,
    addMember: notConnected,
    sendFile: notConnected,
    fileUrl: notConnected,
    markRead: notConnected,
    searchAll: notConnected,
    addChat: notConnected,
    listDirectory: notConnected,
    createGroup: notConnected,
    getMembers: notConnected,
    reset: notConnected
  };

  // Куда переключиться, когда появится облако:
  // var backend = FirebaseBackend;
  var backend = LocalBackend;

  /* ------------------------ HTTP-бэкенд (server.py) ----------------- */
  /*
   * Тот же контракт, но данные живут на сервере (Firebase RTDB за ним).
   * Сессия — cookie, её ставит сервер.
   */

  function httpJson(method, url, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data.error && data.error.message) || ("Ошибка " + res.status));
          if (data.error && data.error.field) err.field = data.error.field;
          if (data.error && data.error.retryAfter) err.retryAfter = data.error.retryAfter;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function httpUpload(chatId, file) {
    var name = btoa(unescape(encodeURIComponent(file.name || "file")));
    return fetch("api/chats/" + encodeURIComponent(chatId) + "/files", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": name
      },
      body: file.blob
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error((data.error && data.error.message) || "Не удалось загрузить файл");
          throw err;
        }
        return data;
      });
    });
  }

  var HttpBackend = {
    mode: "http",

    me: async function () {
      try {
        var res = await fetch("api/me", { credentials: "same-origin" });
        if (res.status === 401) return null;
        if (!res.ok) return null;
        return res.json();
      } catch (e) {
        return null;   // нет сети — покажем экран входа
      }
    },

    signIn: function (email, password) {
      return httpJson("POST", "api/auth/login", { email: email, password: password });
    },

    signUp: function (email, password) {
      return httpJson("POST", "api/auth/register", { email: email, password: password });
    },

    signOut: function () {
      return httpJson("POST", "api/auth/logout", {}).catch(function () { return null; });
    },

    setAvatar: function (dataUrl) {
      return httpJson("PATCH", "api/me", { avatar: dataUrl });
    },

    setChatAvatar: function (chatId, dataUrl) {
      return httpJson("POST", "api/chats/" + encodeURIComponent(chatId) + "/avatar", { avatar: dataUrl });
    },

    changePassword: function (oldPassword, newPassword) {
      return httpJson("POST", "api/account/password", {
        old: oldPassword, new: newPassword, repeat: newPassword
      });
    },

    setAccent: function (id) {
      return httpJson("PATCH", "api/me", { accent: id });
    },

    setTheme: function (theme) {
      return httpJson("PATCH", "api/me", { theme: theme });
    },

    listChats: function () {
      return httpJson("GET", "api/chats");
    },

    sync: function () {
      return httpJson("GET", "api/sync");
    },

    getChat: function (id) {
      return httpJson("GET", "api/chats/" + encodeURIComponent(id));
    },

    favoritesCount: function () {
      return httpJson("GET", "api/favorites").then(function (data) { return data.count; });
    },

    sendMessage: function (chatId, text, replyTo) {
      var body = { text: text };
      if (replyTo) body.replyTo = replyTo;
      return httpJson("POST", "api/chats/" + encodeURIComponent(chatId) + "/messages", body);
    },

    leaveGroup: function (chatId) {
      return httpJson("POST", "api/chats/" + encodeURIComponent(chatId) + "/leave", {});
    },

    joinGroup: function (chatId) {
      return httpJson("POST", "api/chats/" + encodeURIComponent(chatId) + "/join", {});
    },

    presence: function (chatId, typing) {
      return httpJson("POST", "api/presence", { chatId: chatId || null, typing: !!typing });
    },

    addMember: function (chatId, userId) {
      return httpJson("POST", "api/chats/" + encodeURIComponent(chatId) + "/members", { userId: userId });
    },

    getReaders: function (chatId, messageId) {
      return httpJson("GET", "api/chats/" + encodeURIComponent(chatId) +
        "/messages/" + encodeURIComponent(messageId) + "/readers");
    },

    sendFile: function (chatId, file) {
      return httpUpload(chatId, file);
    },

    fileUrl: function (fileId) {
      return Promise.resolve("files/" + encodeURIComponent(fileId));
    },

    markRead: function (chatId) {
      return httpJson("POST", "api/chats/" + encodeURIComponent(chatId) + "/read", {});
    },

    searchAll: function (query) {
      return httpJson("GET", "api/search?q=" + encodeURIComponent(query || ""));
    },

    addChat: function (directoryId) {
      return httpJson("POST", "api/chats", { entryId: directoryId })
        .then(function (data) { return data.chatId; });
    },

    createGroup: function (name, memberIds) {
      return httpJson("POST", "api/chats", { name: name, memberIds: memberIds || [] })
        .then(function (data) { return data.chatId; });
    },

    listDirectory: function () {
      return httpJson("GET", "api/directory");
    },

    getMembers: function (chatId) {
      return httpJson("GET", "api/chats/" + encodeURIComponent(chatId) + "/members")
        .catch(function () { return null; });
    },

    reset: function () {
      return httpJson("POST", "api/reset", {});
    }
  };

  /* --------------------------- выбор бэкенда ------------------------ */

  var httpMode = false;
  var backend = LocalBackend;

  var backendReady = (function () {
    if (typeof location === "undefined" || !/^https?:/.test(location.protocol)) {
      return Promise.resolve(LocalBackend);
    }

    // на http(s) всегда работаем через сервер — даже если он сейчас
    // недоступен, чтобы не подменять живые данные локальной копией
    backend = HttpBackend;
    httpMode = true;

    fetch("api/ping", { credentials: "same-origin" }).catch(function () { /* офлайн */ });

    return Promise.resolve(HttpBackend);
  })();

  function invoke(name, args) {
    return backendReady.then(function (b) {
      return b[name].apply(b, args);
    });
  }

  global.MassaApi = {
    get mode() { return httpMode ? "http" : "local"; },

    me: function () { return invoke("me", arguments); },
    signIn: function (email, password) { return invoke("signIn", arguments); },
    signUp: function (email, password) { return invoke("signUp", arguments); },
    signOut: function () { return invoke("signOut", arguments); },
    setAvatar: function (dataUrl) { return invoke("setAvatar", arguments); },
    changePassword: function (oldPassword, newPassword) { return invoke("changePassword", arguments); },
    setChatAvatar: function (chatId, dataUrl) { return invoke("setChatAvatar", arguments); },
    setAccent: function (id) { return invoke("setAccent", arguments); },
    setTheme: function (theme) { return invoke("setTheme", arguments); },
    listChats: function () { return invoke("listChats", arguments); },
    sync: function () { return invoke("sync", arguments); },
    getChat: function (id) { return invoke("getChat", arguments); },
    favoritesCount: function () { return invoke("favoritesCount", arguments); },
    sendMessage: function (chatId, text, replyTo) { return invoke("sendMessage", arguments); },
    getReaders: function (chatId, messageId) { return invoke("getReaders", arguments); },
    leaveGroup: function (chatId) { return invoke("leaveGroup", arguments); },
    joinGroup: function (chatId) { return invoke("joinGroup", arguments); },
    presence: function (chatId, typing) { return invoke("presence", arguments); },
    addMember: function (chatId, userId) { return invoke("addMember", arguments); },
    sendFile: function (chatId, file) { return invoke("sendFile", arguments); },
    fileUrl: function (fileId) { return invoke("fileUrl", arguments); },
    markRead: function (chatId) { return invoke("markRead", arguments); },
    searchAll: function (query) { return invoke("searchAll", arguments); },
    addChat: function (directoryId) { return invoke("addChat", arguments); },
    createGroup: function (name, memberIds) { return invoke("createGroup", arguments); },
    listDirectory: function () { return invoke("listDirectory", arguments); },
    getMembers: function (chatId) { return invoke("getMembers", arguments); },
    reset: function () { return invoke("reset", arguments); },

    get filesReady() {
      return backendReady.then(function () { return true; });
    }
  };

  global.MassaApi.DEMO = { email: DEMO_EMAIL, password: DEMO_PASSWORD };
})(window);
