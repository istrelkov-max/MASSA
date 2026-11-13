#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
massa — весь сервер в одном файле.

Что делает:
  • раздаёт статику (index.html, styles.css, api.js, app.js) из своей папки;
  • отдаёт API под /api/* для клиента;
  • хранит состояние в Firebase Realtime Database (REST), а если Firebase
    не настроен — в state.json рядом с этим файлом;
  • складывает загруженные файлы в папку files/ рядом (без ограничения
    на количество, только 25 МБ на файл).

Запуск:
    python server.py

Переменные окружения:
    PORT=8080                    порт
    HOST=0.0.0.0                 адрес
    FIREBASE_URL=https://xxx.firebaseio.com
    FIREBASE_SECRET=...          database secret (старый способ)
    FIREBASE_TOKEN=...           либо ID-токен / access token
    FIREBASE_PATH=/massa         путь внутри базы (по умолчанию /massa)

Без FIREBASE_URL всё работает локально на state.json — удобно для проверки.
Демо-вход: admin@massa.app / 123456 (админ).
"""

import base64
import hashlib
import json
import mimetypes
import os
import secrets
import signal
import threading
import time
import uuid
import zlib
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

# ----------------------------- настройки ---------------------------------

# server.py лежит в <проект>/server, статика — в <проект>/public
ROOT = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(ROOT)
WEB_DIR = os.environ.get("WEB_DIR") or os.path.join(BASE_DIR, "public")

# данные (состояние чатов, аккаунты, вложения) лежат отдельно от кода
DATA_DIR = os.environ.get("DATA_DIR") or "/var/lib/massa"

FILES_DIR = os.path.join(DATA_DIR, "files")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
ACCOUNTS_FILE = os.environ.get("ACCOUNTS_FILE") or os.path.join(DATA_DIR, "accounts.json")

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(FILES_DIR, exist_ok=True)

SESSION_TTL = 30 * 24 * 60 * 60  # 30 дней

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

FIREBASE_URL = (os.environ.get("FIREBASE_URL") or "").rstrip("/")
FIREBASE_SECRET = os.environ.get("FIREBASE_SECRET") or ""
FIREBASE_TOKEN = os.environ.get("FIREBASE_TOKEN") or ""
FIREBASE_PATH = os.environ.get("FIREBASE_PATH", "/massa")

DEMO_EMAIL = "admin@massa.app"
DEMO_PASSWORD = "123456"
DEMO_NAME = "Админ"

MAX_UPLOAD = 50 * 1024 * 1024
COOKIE = "massa_sid"

STATIC_FILES = {
    "index.html", "styles.css", "api.js", "app.js", "README.md",
    "manifest.webmanifest", "sw.js",
    "icons/icon-192.png", "icons/icon-512.png",
}


# ------------------------------ утилиты ----------------------------------

def now_ms():
    return int(time.time() * 1000)


def now_time():
    return datetime.now().strftime("%H:%M")


def new_id():
    return str(uuid.uuid4())


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 salt.encode("utf-8"), 120000)
    return salt, digest.hex()


def check_password(password, salt, expected):
    return hash_password(password, salt)[1] == expected


def name_from_email(email):
    local = email.split("@")[0].replace(".", " ").replace("_", " ").replace("-", " ").strip()
    return (local[:1].upper() + local[1:]) if local else "Без имени"


# ------------------------------- данные ----------------------------------

def seed_accounts():
    """Начальная база аккаунтов: только хеши паролей, без открытых данных."""
    admin_id = new_id()
    salt, digest = hash_password(DEMO_PASSWORD)
    return {
        "version": 1,
        "users": {
            admin_id: {
                "id": admin_id,
                "email": DEMO_EMAIL,
                "name": DEMO_NAME,
                "role": "admin",
                "salt": salt,
                "hash": digest,
                "avatar": None,
                "accent": None,
                "createdAt": now_ms(),
            }
        },
        "emails": {DEMO_EMAIL: admin_id},
        "sessions": {},
    }


def seed_state():
    # никаких «людей-затычек»: справочник пустой, искать можно только
    # настоящие аккаунты и свои чаты
    return {
        "version": 7,
        "directory": {},
        "chats": {},
        "favorites": {},
        "files": {},
    }


def seed_favorites(admin_id):
    """Три стартовые заметки в «Избранном» админа."""
    fav_id = new_id()
    messages = {}
    for text, t in (
        ("Макет главного экрана v2 — figma.com/file/…", "11:20"),
        ("Не забыть: при регистрации проверять повтор пароля", "11:24"),
        ("Чек-лист: вход, поиск, добавление людей, избранное", "09:15"),
    ):
        mid = new_id()
        messages[mid] = {
            "id": mid, "uid": admin_id, "text": text, "time": t,
            "date": "Сегодня", "ts": now_ms(), "file": None,
        }
    return {"id": fav_id, "messages": messages}


class Store:
    """Состояние в памяти + запись в Firebase (или в state.json)."""

    def __init__(self):
        self.lock = threading.RLock()
        self.remote = bool(FIREBASE_URL)
        self.state = self._load()

    # --- транспорт -------------------------------------------------------

    def _remote_url(self):
        url = FIREBASE_URL + FIREBASE_PATH + ".json"
        if FIREBASE_SECRET:
            url += "?auth=" + FIREBASE_SECRET
        return url

    def _remote_get(self):
        req = Request(self._remote_url(), method="GET")
        if FIREBASE_TOKEN:
            req.add_header("Authorization", "Bearer " + FIREBASE_TOKEN)
        with urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw and raw != "null" else None

    def _remote_put(self, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        req = Request(self._remote_url(), data=body, method="PUT")
        req.add_header("Content-Type", "application/json")
        if FIREBASE_TOKEN:
            req.add_header("Authorization", "Bearer " + FIREBASE_TOKEN)
        with urlopen(req, timeout=20) as resp:
            resp.read()

    def _load(self):
        if self.remote:
            try:
                data = self._remote_get()
                if data:
                    print("[massa] состояние загружено из Firebase")
                    return data
                print("[massa] в Firebase пусто — создаю начальные данные")
            except (HTTPError, URLError, ValueError) as exc:
                print("[massa] Firebase недоступен (%s), работаю на state.json" % exc)

        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, "r", encoding="utf-8") as fh:
                    return json.load(fh)
            except ValueError:
                pass

        return seed_state()

    def save(self):
        with self.lock:
            data = self.state

        if self.remote:
            try:
                self._remote_put(data)
                return
            except (HTTPError, URLError) as exc:
                print("[massa] не смог записать в Firebase: %s" % exc)

        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, STATE_FILE)


STORE = Store()


class Accounts:
    """База аккаунтов отдельным файлом: пользователи и сессии.

    Пароли не хранятся — только соль и PBKDF2-HMAC-SHA256 (120k итераций).
    """

    def __init__(self):
        self.lock = threading.RLock()
        self.path = ACCOUNTS_FILE
        self.data = {"version": 1, "users": {}, "emails": {}, "sessions": {}}
        self.load()

    # --- хранилище -------------------------------------------------------

    def load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    raw = json.load(fh)
                if isinstance(raw, dict):
                    for key in ("users", "emails", "sessions"):
                        self.data[key] = raw.get(key) or {}
                    self._prune()
                    return
            except (ValueError, OSError) as exc:
                print("[massa] accounts.json повреждён: %s" % exc)

        # перенос из старого state.json
        legacy = STORE.state.get("users") or {}
        if legacy:
            self.data["users"] = legacy
            self.data["emails"] = STORE.state.get("emails") or {
                user["email"]: uid for uid, user in legacy.items()
            }
            self.data["sessions"] = STORE.state.get("sessions") or {}
            for key in ("users", "emails", "sessions"):
                STORE.state.pop(key, None)
            STORE.save()
            self.save()
            print("[massa] аккаунты перенесены в %s" % self.path)
            return

        self.data = seed_accounts()
        self.save()

    def save(self):
        with self.lock:
            blob = json.dumps(self.data, ensure_ascii=False, indent=1)
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(blob)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    def _prune(self):
        now = int(time.time())
        sessions = self.data.get("sessions") or {}
        alive = {k: v for k, v in sessions.items() if int(v.get("expiresAt", 0)) > now}
        if len(alive) != len(sessions):
            self.data["sessions"] = alive
            self.save()

    # --- пользователи ----------------------------------------------------

    @property
    def users(self):
        return self.data["users"]

    def user(self, uid):
        return self.users.get(uid)

    def by_email(self, email):
        uid = (self.data.get("emails") or {}).get(email)
        return self.users.get(uid) if uid else None

    def add(self, user):
        self.users[user["id"]] = user
        self.data["emails"][user["email"]] = user["id"]
        self.save()

    # --- сессии ----------------------------------------------------------

    def create_session(self, uid):
        token = secrets.token_urlsafe(24)
        now = int(time.time())
        self.data["sessions"][token] = {"uid": uid, "createdAt": now, "expiresAt": now + SESSION_TTL}
        self.save()
        return token

    def session_user(self, token):
        if not token:
            return None
        info = (self.data.get("sessions") or {}).get(token)
        if not info:
            return None
        if int(info.get("expiresAt", 0)) <= int(time.time()):
            self.data["sessions"].pop(token, None)
            self.save()
            return None
        return self.users.get(info.get("uid"))

    def drop_session(self, token):
        if token and token in (self.data.get("sessions") or {}):
            self.data["sessions"].pop(token, None)
            self.save()


ACCOUNTS = Accounts()

# демо-аккаунт и его «Избранное» создаются один раз
if not ACCOUNTS.by_email(DEMO_EMAIL):
    fresh = seed_accounts()
    for uid, user in fresh["users"].items():
        ACCOUNTS.users[uid] = user
    ACCOUNTS.data["emails"][DEMO_EMAIL] = list(fresh["users"].keys())[0]
    ACCOUNTS.save()

ADMIN_ID = ACCOUNTS.data["emails"][DEMO_EMAIL]
if ADMIN_ID not in STORE.state["favorites"]:
    STORE.state["favorites"][ADMIN_ID] = seed_favorites(ADMIN_ID)
    STORE.save()


# --------------------------- доменная логика -----------------------------

def s_users():
    return ACCOUNTS.users


def s_chats():
    return STORE.state["chats"]


def user_by_id(uid):
    return ACCOUNTS.user(uid)


def is_admin(user):
    return bool(user and user.get("role") == "admin")


def public_user(user):
    if not user:
        return None
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "role": user.get("role", "user"),
        "avatar": user.get("avatar"),
        "accent": user.get("accent"),
        "theme": user.get("theme") or "light",
    }


def user_by_email(email):
    return ACCOUNTS.by_email(email)


def sorted_messages(bucket):
    items = list((bucket or {}).values())
    items.sort(key=lambda m: m.get("ts", 0))
    return items


def public_message(msg, viewer_id):
    return {
        "id": msg["id"],
        "mine": msg.get("uid") == viewer_id,
        "text": msg.get("text", ""),
        "ts": msg.get("ts", 0),
        "time": msg.get("time", ""),
        "date": msg.get("date", "Сегодня"),
        "file": msg.get("file"),
        "reply": msg.get("reply"),
    }


def last_preview(msg):
    if not msg:
        return None
    if msg.get("file"):
        if msg["file"].get("kind") == "image":
            text = "Фото"
        elif msg["file"].get("kind") == "video":
            text = "Видео"
        else:
            text = msg["file"].get("name", "Файл")
    else:
        text = msg.get("text", "")
    return {"text": text, "mine": None, "time": msg.get("time", ""), "ts": msg.get("ts", 0)}


def chat_members(chat):
    raw = chat.get("members")
    members = raw if isinstance(raw, list) else []
    if chat.get("ownerId") and chat["ownerId"] not in members:
        members = list(members) + [chat["ownerId"]]
    return members


def chat_meta(chat, viewer):
    last = sorted_messages(chat.get("messages"))[-1:] or [None]
    last = last[0]

    members = chat_members(chat)
    owned = (not chat.get("ownerId")) or (viewer and chat["ownerId"] == viewer["id"]) \
        or (viewer and viewer["id"] in members)

    meta = {
        "id": chat["id"],
        "name": chat.get("name", ""),
        "handle": chat.get("handle", ""),
        "type": chat.get("type", "user"),
        "color": chat.get("color", 0),
        "ownerId": chat.get("ownerId"),
        "owned": bool(owned),
        "unread": (chat.get("unread") or {}).get(viewer["id"], 0) if viewer else 0,
        "online": bool(chat.get("online")),
        "members": chat.get("membersCount") or (
            chat.get("members") if isinstance(chat.get("members"), int) else len(members)
        ),
        "lastMessage": last_preview(last),
        "avatar": chat.get("avatar"),
    }

    # в личном чате между аккаунтами каждый видит имя и почту собеседника
    if viewer and chat.get("type") != "group":
        others = [uid for uid in members if uid != viewer["id"]]
        if len(others) == 1:
            other = user_by_id(others[0])
            if other:
                meta["name"] = other["name"]
                meta["peerEmail"] = other.get("email", "")
                meta["peerName"] = other.get("name", "")
                meta["peerAvatar"] = other.get("avatar")

    # админу показываем, чей это чат
    if not owned and is_admin(viewer) and chat.get("ownerId"):
        owner = user_by_id(chat["ownerId"])
        meta["ownerName"] = owner["name"] if owner else "неизвестный"

    return meta


def chat_full(chat, viewer):
    meta = chat_meta(chat, viewer)

    is_group = chat.get("type") == "group"
    messages = []

    for m in sorted_messages(chat.get("messages")):
        item = public_message(m, viewer["id"])
        if is_group:
            author = user_by_id(m.get("uid"))
            item["author"] = author["name"] if author else ""
        messages.append(item)

    meta["messages"] = messages

    # до какого времени собеседники прочитали переписку
    reads = chat.get("reads") or {}
    others = [uid for uid in chat_members(chat) if uid != viewer["id"]]
    meta["peerReadTs"] = max([int(reads.get(uid, 0)) for uid in others] or [0])
    meta["readersCount"] = len([uid for uid in others if int(reads.get(uid, 0)) > 0])
    meta["reads"] = {uid: int(reads.get(uid, 0)) for uid in others}
    return meta


def favorites_bucket(uid):
    fav = STORE.state["favorites"].setdefault(uid, {"id": new_id(), "messages": {}})
    return fav


def favorites_chat(viewer):
    fav = favorites_bucket(viewer["id"])
    msgs = sorted_messages(fav["messages"])
    return {
        "id": fav["id"],
        "name": "Избранное",
        "handle": "только вы",
        "type": "saved",
        "color": 3,
        "unread": 0,
        "online": False,
        "members": 0,
        "messages": [public_message(m, viewer["id"]) for m in msgs],
        "lastMessage": last_preview(msgs[-1] if msgs else None),
    }


def visible_chats(viewer):
    """Чаты, где я владелец, участник или (для админа) все подряд."""
    admin = is_admin(viewer)
    result = []
    for chat in s_chats().values():
        if admin:
            result.append(chat)
            continue
        if chat.get("ownerId") == viewer["id"]:
            result.append(chat)
            continue
        if viewer["id"] in chat_members(chat):
            result.append(chat)
    result.sort(key=lambda c: c.get("createdAt", 0))
    return result


def find_chat(chat_id):
    return s_chats().get(chat_id)


def is_saved(chat_id, viewer):
    return chat_id == "fav" or chat_id == favorites_bucket(viewer["id"])["id"]


# -------------------------------- API ------------------------------------

class ApiError(Exception):
    def __init__(self, message, field=None, status=400, retry_after=None):
        super().__init__(message)
        self.message = message
        self.field = field
        self.status = status
        self.retry_after = retry_after


# защита от подбора пароля: 5 неудач с одного IP -> блок на 5 минут
LOGIN_MAX_FAILS = 5
LOGIN_BLOCK_SECONDS = 300
LOGIN_FAILS = {}
LOGIN_LOCK = threading.Lock()


# ограничение частоты запросов с одного адреса
RATE_LIMIT = 90
RATE_WINDOW = 10.0
RATE_BUCKETS = {}
RATE_LOCK = threading.Lock()


def rate_limited(ip):
    now = time.time()

    with RATE_LOCK:
        if len(RATE_BUCKETS) > 5000:
            RATE_BUCKETS.clear()

        info = RATE_BUCKETS.get(ip)
        if not info or now - info[0] > RATE_WINDOW:
            RATE_BUCKETS[ip] = [now, 1]
            return False

        info[1] += 1
        return info[1] > RATE_LIMIT


# кто в сети и кто печатает: приходит heartbeat-ом раз в несколько секунд
PRESENCE = {}
PRESENCE_LOCK = threading.Lock()
PRESENCE_ONLINE_MS = 15000     # нет сигнала 15 секунд — считаем офлайн
PRESENCE_TYPING_MS = 7000      # «печатает…» живёт 7 секунд
PRESENCE_TTL_MS = 600000       # записи старше 10 минут выкидываем


def presence_touch(uid, chat_id, typing):
    now = now_ms()

    with PRESENCE_LOCK:
        PRESENCE[uid] = {"ts": now, "chat": chat_id, "typing": bool(typing and chat_id)}

        for key in [k for k, v in PRESENCE.items() if now - v.get("ts", 0) > PRESENCE_TTL_MS]:
            PRESENCE.pop(key, None)


def presence_state(uid):
    now = now_ms()
    info = PRESENCE.get(uid)

    if not info:
        return {"online": False, "typing": None, "ts": 0}

    fresh = now - info.get("ts", 0) <= PRESENCE_ONLINE_MS
    typing = info.get("chat") if (info.get("typing") and now - info.get("ts", 0) <= PRESENCE_TYPING_MS) else None

    return {"online": fresh, "typing": typing, "ts": info.get("ts", 0)}


def presence_chats(viewer):
    """Короткая сводка по каждому моему чату: кто в сети и кто печатает."""
    result = {}

    for chat in visible_chats(viewer):
        members = [uid for uid in chat_members(chat) if uid != viewer["id"]]

        online = 0
        typing_name = None
        typing_ts = 0
        peer_typing = False

        for uid in members:
            state = presence_state(uid)
            if state["online"]:
                online += 1
            if state["typing"] == chat["id"]:
                if chat.get("type") != "group":
                    peer_typing = True
                elif state["ts"] >= typing_ts:
                    acc = user_by_id(uid)
                    typing_ts = state["ts"]
                    typing_name = acc["name"] if acc else ""

        result[chat["id"]] = {
            "online": online,
            "peerOnline": online > 0 if chat.get("type") != "group" else False,
            "peerTyping": peer_typing,
            "typingName": typing_name,
        }

    return result


def api_presence(user, body):
    presence_touch(user["id"], body.get("chatId") or None, bool(body.get("typing")))
    return {"ok": True, "chats": presence_chats(user)}


def login_block_left(ip):
    with LOGIN_LOCK:
        info = LOGIN_FAILS.get(ip)
        if not info:
            return 0

        until = float(info.get("until", 0) or 0)
        if until <= 0:
            return 0          # блокировки нет — счётчик попыток не трогаем

        left = int(until - time.time())
        if left <= 0:
            LOGIN_FAILS.pop(ip, None)
            return 0
        return left


def login_fail(ip):
    with LOGIN_LOCK:
        info = LOGIN_FAILS.setdefault(ip, {"count": 0, "until": 0})
        info["count"] = int(info.get("count", 0)) + 1
        if info["count"] >= LOGIN_MAX_FAILS:
            info["until"] = time.time() + LOGIN_BLOCK_SECONDS
            info["count"] = 0


def login_ok(ip):
    with LOGIN_LOCK:
        LOGIN_FAILS.pop(ip, None)


REGISTER_MAX_PER_IP = 3


def api_register(body, ip=""):
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    if not email or "@" not in email:
        raise ApiError("Не похоже на почту. Нужен вид: name@mail.com", "email")
    if len(password) < 6:
        raise ApiError("Пароль должен быть не короче 6 символов", "password")
    if user_by_email(email):
        raise ApiError("Аккаунт с такой почтой уже есть — войдите.", "email")

    # с одного IP можно создать не больше трёх аккаунтов
    if ip:
        made = len([u for u in ACCOUNTS.users.values() if u.get("createdIp") == ip])
        if made >= REGISTER_MAX_PER_IP:
            raise ApiError("С этого IP уже создано %d аккаунта — регистрация недоступна" % made,
                           status=403)

    uid = new_id()
    salt, digest = hash_password(password)
    user = {
        "id": uid, "email": email, "name": name_from_email(email),
        "role": "user", "salt": salt, "hash": digest,
        "avatar": None, "accent": None, "theme": "light", "createdAt": now_ms(),
        "createdIp": ip or None,
    }
    ACCOUNTS.add(user)
    return public_user(user)


def api_login(body, session):
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    user = user_by_email(email)

    if not user:
        raise ApiError("Аккаунт не найден. Проверьте почту или зарегистрируйтесь.", "email")
    if not check_password(password, user["salt"], user["hash"]):
        raise ApiError("Неверный пароль", "password")

    token = ACCOUNTS.create_session(user["id"])
    session["token"] = token
    return public_user(user)


def api_logout(session):
    token = session.get("token")
    if token:
        ACCOUNTS.drop_session(token)
    session.clear()


def api_me(session):
    return public_user(current_user(session))


def current_user(session):
    return ACCOUNTS.session_user(session.get("token"))


def api_set_chat_avatar(user, chat_id, body):
    chat = find_chat(chat_id)
    if not chat:
        raise ApiError("Чат не найден", status=404)
    if not is_admin(user) and user["id"] not in chat_members(chat):
        raise ApiError("Нет доступа к чату", status=403)

    avatar = (body.get("avatar") or "").strip()
    if avatar and not avatar.startswith("data:image/"):
        raise ApiError("Нужна картинка")
    if len(avatar) > 900000:
        raise ApiError("Картинка слишком большая", status=413)

    chat["avatar"] = avatar or None
    STORE.save()
    return chat_full(chat, user)


def api_change_password(user, body):
    old = body.get("old") or ""
    new = body.get("new") or ""
    repeat = body.get("repeat")

    if not check_password(old, user["salt"], user["hash"]):
        raise ApiError("Старый пароль не подходит", "old")
    if len(new) < 6:
        raise ApiError("Новый пароль должен быть не короче 6 символов", "new")
    if repeat is not None and repeat != new:
        raise ApiError("Пароли не совпадают", "repeat")

    salt, digest = hash_password(new)
    user["salt"] = salt
    user["hash"] = digest
    ACCOUNTS.save()
    return {"ok": True}


def api_patch_me(user, body):
    if "avatar" in body:
        user["avatar"] = body["avatar"] or None
    if "accent" in body:
        user["accent"] = body["accent"] or None
    if "theme" in body:
        user["theme"] = "dark" if body["theme"] == "dark" else "light"
    ACCOUNTS.save()
    return public_user(user)


def api_directory(user):
    """Список для выбора участников группы — только мои контакты.

    Контакт = аккаунт, с которым у меня уже есть личный чат.
    """
    contacts = {}
    for chat in s_chats().values():
        if chat.get("type") == "group":
            continue
        members = chat_members(chat)
        if user["id"] not in members:
            continue
        for uid in members:
            if uid == user["id"]:
                continue
            acc = ACCOUNTS.user(uid)
            if acc:
                contacts[acc["id"]] = acc

    people = []
    for acc in contacts.values():
        people.append({
            "id": acc["id"], "type": "user",
            "name": acc.get("name", ""), "handle": "",
            "email": acc.get("email", ""), "about": "аккаунт",
            "color": zlib.crc32(acc["id"].encode()) % 8,
            "avatar": acc.get("avatar"),
        })
    people.sort(key=lambda p: p["name"].lower())
    return people


def api_chats(user):
    return [chat_meta(c, user) for c in visible_chats(user)]


def api_get_chat(user, chat_id):
    if is_saved(chat_id, user):
        return favorites_chat(user)
    chat = find_chat(chat_id)
    if not chat:
        raise ApiError("Чат не найден", status=404)
    if not is_admin(user) and user["id"] not in chat_members(chat):
        raise ApiError("Нет доступа к чату", status=403)
    return chat_full(chat, user)


def api_add_chat(user, body):
    entry_id = body.get("entryId")

    # это живой аккаунт — делаем общий чат на двоих
    other = ACCOUNTS.user(entry_id)
    if other and other["id"] != user["id"]:
        for chat in s_chats().values():
            members = chat_members(chat)
            if user["id"] in members and other["id"] in members and chat.get("type") != "group":
                return {"chatId": chat["id"]}

        cid = new_id()
        STORE.state["chats"][cid] = {
            "id": cid, "entryId": None, "ownerId": user["id"],
            "name": other["name"], "handle": "",
            "type": "user",
            "color": zlib.crc32(other["id"].encode()) % 8,
            "members": [user["id"], other["id"]],
            "online": False, "unread": {}, "messages": {}, "createdAt": now_ms(),
        }
        STORE.save()
        return {"chatId": cid}

    entry = STORE.state["directory"].get(entry_id)
    if not entry:
        raise ApiError("Такого контакта нет в справочнике", status=404)

    for chat in s_chats().values():
        if chat.get("entryId") == entry_id and chat.get("ownerId") == user["id"]:
            return {"chatId": chat["id"]}

    cid = new_id()
    STORE.state["chats"][cid] = {
        "id": cid, "entryId": entry_id, "ownerId": user["id"],
        "name": entry["name"], "handle": entry.get("handle", ""),
        "type": entry.get("type", "user"), "color": entry.get("color", 0),
        "members": [user["id"]],
        "people": entry.get("people", []),
        "online": False, "unread": {}, "messages": {}, "createdAt": now_ms(),
    }
    if entry.get("type") == "group":
        STORE.state["chats"][cid]["membersCount"] = entry.get("members", 0)
    STORE.save()
    return {"chatId": cid}


def api_create_group(user, body):
    title = (body.get("name") or "").strip()
    if not title:
        raise ApiError("Введите название группы")

    people = []
    member_ids = []
    for entry_id in body.get("memberIds") or []:
        acc = ACCOUNTS.user(entry_id)
        if acc and acc["id"] != user["id"]:
            member_ids.append(acc["id"])
            people.append({"name": acc.get("name", ""), "handle": "",
                           "color": zlib.crc32(acc["id"].encode()) % 8})
    if not people:
        raise ApiError("Добавьте хотя бы одного участника")

    cid = new_id()
    STORE.state["chats"][cid] = {
        "id": cid, "entryId": None, "ownerId": user["id"],
        "name": title, "handle": "", "type": "group",
        "color": len(s_chats()) % 8,
        "members": [user["id"]] + member_ids,
        "membersCount": len(people) + 1,
        "people": people, "online": False, "unread": {},
        "messages": {}, "createdAt": now_ms(),
    }
    STORE.save()
    return {"chatId": cid}


def api_reset(user):
    """Сброс демо-данных: справочник заново, чаты и файлы удаляются."""
    if not is_admin(user):
        raise ApiError("Только для администратора", status=403)

    fresh = seed_state()
    STORE.state["directory"] = fresh["directory"]
    STORE.state["chats"] = {}
    STORE.state["favorites"] = {user["id"]: {"id": new_id(), "messages": {}}}
    STORE.state["files"] = {}
    STORE.save()

    if os.path.isdir(FILES_DIR):
        for name in os.listdir(FILES_DIR):
            try:
                os.remove(os.path.join(FILES_DIR, name))
            except OSError:
                pass

    return {"ok": True}


def api_members(user, chat_id):
    chat = find_chat(chat_id)
    if not chat or chat.get("type") != "group":
        return None

    people = chat.get("people") or []
    if not people and chat.get("entryId"):
        entry = STORE.state["directory"].get(chat["entryId"]) or {}
        people = entry.get("people") or []

    # участники строятся по uuid — так один и тот же человек не задвоится
    members = [{
        "id": user["id"],
        "name": user["name"], "handle": "вы", "color": 0, "isMe": True,
        "role": "", "email": user.get("email", ""),
        "avatar": user.get("avatar"),
        "online": True, "typing": False,
    }]
    seen = {user["id"]}

    by_name = {acc.get("name", ""): acc for acc in ACCOUNTS.users.values()}

    for uid in chat_members(chat):
        if uid in seen:
            continue
        acc = user_by_id(uid)
        if not acc:
            continue

        seen.add(uid)
        state = presence_state(uid)
        members.append({
            "id": uid,
            "name": acc.get("name", ""), "handle": "", "color": 5,
            "role": "", "email": acc.get("email", ""), "avatar": acc.get("avatar"),
            "online": state["online"],
            "typing": state["typing"] == chat["id"],
        })

    # старые участники без аккаунта (только имя) — показываем, если такого имени ещё нет
    known_names = {m["name"] for m in members}
    for p in people:
        name = p.get("name", "")
        if name in known_names or by_name.get(name):
            continue
        members.append({"name": name, "handle": p.get("handle", ""),
                        "color": p.get("color", 0), "role": p.get("role", ""),
                        "email": p.get("email", ""), "avatar": p.get("avatar")})

    return {
        "id": chat["id"], "name": chat.get("name", ""),
        "handle": chat.get("handle", ""), "color": chat.get("color", 0),
        "avatar": chat.get("avatar"),
        "count": len(members), "members": members,
    }


def bump_unread(chat, sender_id):
    """Остальным участникам чата ++ непрочитанное."""
    unread = chat.setdefault("unread", {})
    for uid in chat_members(chat):
        if uid == sender_id:
            continue
        unread[uid] = int(unread.get(uid, 0)) + 1


def api_send_message(user, chat_id, body):
    text = (body.get("text") or "").strip()
    if not text:
        raise ApiError("Пустое сообщение")

    mid = new_id()
    reply = None
    reply_to = body.get("replyTo")

    if reply_to:
        for chat_candidate in s_chats().values():
            if chat_id == "fav":
                break
            if chat_candidate.get("id") == chat_id:
                src = (chat_candidate.get("messages") or {}).get(reply_to)
                if src:
                    author = user_by_id(src.get("uid"))
                    reply = {
                        "id": src["id"],
                        "text": (src.get("text") or "")[:160],
                        "author": author["name"] if author else "",
                        "mine": src.get("uid") == user["id"],
                    }
                break

    msg = {
        "id": mid, "uid": user["id"], "text": text, "time": now_time(),
        "date": "Сегодня", "ts": now_ms(), "file": None, "reply": reply,
    }

    if is_saved(chat_id, user):
        favorites_bucket(user["id"])["messages"][mid] = msg
    else:
        chat = find_chat(chat_id)
        if not chat:
            raise ApiError("Чат не найден", status=404)
        if not is_admin(user) and user["id"] not in chat_members(chat):
            raise ApiError("Нет доступа к чату", status=403)
        chat.setdefault("messages", {})[mid] = msg
        bump_unread(chat, user["id"])

    STORE.save()
    return public_message(msg, user["id"])


def api_send_file(user, chat_id, filename, content_type, data):
    if len(data) > MAX_UPLOAD:
        raise ApiError("Файл больше 25 МБ", status=413)

    fid = new_id()
    os.makedirs(FILES_DIR, exist_ok=True)
    with open(os.path.join(FILES_DIR, fid), "wb") as fh:
        fh.write(data)

    ctype = (content_type or "").lower()
    if ctype.startswith("image/"):
        kind = "image"
    elif ctype.startswith("video/"):
        kind = "video"
    else:
        kind = "file"
    meta = {"id": fid, "name": filename, "size": len(data),
            "type": content_type or "application/octet-stream", "kind": kind}
    STORE.state["files"][fid] = meta

    mid = new_id()
    msg = {
        "id": mid, "uid": user["id"], "text": "", "time": now_time(),
        "date": "Сегодня", "ts": now_ms(), "file": meta,
    }

    if is_saved(chat_id, user):
        favorites_bucket(user["id"])["messages"][mid] = msg
    else:
        chat = find_chat(chat_id)
        if not chat:
            raise ApiError("Чат не найден", status=404)
        chat.setdefault("messages", {})[mid] = msg
        bump_unread(chat, user["id"])

    STORE.save()
    return {"message": public_message(msg, user["id"]), "persisted": True}


def api_add_member(user, chat_id, body):
    chat = find_chat(chat_id)
    if not chat:
        raise ApiError("Чат не найден", status=404)
    if chat.get("type") != "group":
        raise ApiError("Это не группа")

    members = chat_members(chat)
    if not is_admin(user) and user["id"] not in members:
        raise ApiError("Вы не в группе", status=403)

    acc = ACCOUNTS.user(body.get("userId") or "")
    if not acc:
        raise ApiError("Аккаунт не найден", status=404)
    if acc["id"] in members:
        return chat_full(chat, user)

    members.append(acc["id"])
    chat["members"] = members
    chat["membersCount"] = len(members)

    people = chat.setdefault("people", [])
    if not any(p.get("name") == acc.get("name") for p in people):
        people.append({"name": acc.get("name", ""), "handle": "",
                       "color": zlib.crc32(acc["id"].encode()) % 8, "role": ""})

    STORE.save()
    return chat_full(chat, user)


def api_leave_group(user, chat_id):
    chat = find_chat(chat_id)
    if not chat:
        raise ApiError("Чат не найден", status=404)
    if chat.get("type") != "group":
        raise ApiError("Это не группа")
    if not is_admin(user) and user["id"] not in chat_members(chat):
        raise ApiError("Вы не в группе")

    members = [uid for uid in chat_members(chat) if uid != user["id"]]

    if not members:
        s_chats().pop(chat_id, None)
    else:
        chat["members"] = members
        chat["membersCount"] = len(members)
        if chat.get("ownerId") == user["id"]:
            chat["ownerId"] = members[0]
        (chat.get("unread") or {}).pop(user["id"], None)
        (chat.get("reads") or {}).pop(user["id"], None)

    STORE.save()
    return {"ok": True}


def api_join_group(user, chat_id):
    chat = find_chat(chat_id)
    if not chat:
        raise ApiError("Чат не найден", status=404)
    if chat.get("type") != "group":
        raise ApiError("Это не группа")

    members = chat_members(chat)
    if user["id"] in members:
        return chat_full(chat, user)

    members.append(user["id"])
    chat["members"] = members
    chat["membersCount"] = len(members)
    chat.setdefault("unread", {})[user["id"]] = 0
    STORE.save()

    return chat_full(chat, user)


def api_readers(user, chat_id, message_id):
    chat = find_chat(chat_id)
    if not chat:
        raise ApiError("Чат не найден", status=404)
    if not is_admin(user) and user["id"] not in chat_members(chat):
        raise ApiError("Нет доступа к чату", status=403)

    msg = (chat.get("messages") or {}).get(message_id)
    if not msg:
        raise ApiError("Сообщение не найдено", status=404)

    reads = chat.get("reads") or {}
    readers = []

    for uid in chat_members(chat):
        if uid == msg.get("uid"):
            continue
        if int(reads.get(uid, 0)) < int(msg.get("ts", 0)):
            continue
        acc = user_by_id(uid)
        if acc:
            readers.append({"id": uid, "name": acc.get("name", ""),
                            "email": acc.get("email", ""), "avatar": acc.get("avatar")})

    others = [uid for uid in chat_members(chat) if uid != msg.get("uid")]
    return {"readers": readers, "total": len(others)}


def api_mark_read(user, chat_id):
    chat = find_chat(chat_id)
    if chat:
        changed = chat.setdefault("unread", {}).pop(user["id"], None) is not None
        reads = chat.setdefault("reads", {})
        reads[user["id"]] = now_ms()
        STORE.save()
        return {"ok": True, "changed": changed}
    return {"ok": True}


def api_sync(user):
    """Всё для текущего пользователя одним пакетом: чаты, сообщения, файлы."""
    chats = [chat_full(c, user) for c in visible_chats(user)]
    fav = favorites_chat(user)

    files = {}
    for chat in chats:
        for msg in chat["messages"]:
            payload = msg.get("file")
            if payload:
                files[payload["id"]] = payload
    for msg in fav["messages"]:
        payload = msg.get("file")
        if payload:
            files[payload["id"]] = payload

    return {
        "chats": chats,
        "favorites": {
            "id": fav["id"],
            "messages": fav["messages"],
            "count": len(fav["messages"]),
        },
        "files": files,
    }


def api_favorites(user):
    fav = favorites_chat(user)
    return {"count": len(fav["messages"]), "messages": fav["messages"]}


def api_search(user, query):
    q = (query or "").strip().lower()
    chats = []
    people = []

    if q:
        admin = is_admin(user)
        for chat in visible_chats(user) if not admin else s_chats().values():
            last = sorted_messages(chat.get("messages"))[-1:] or [None]
            last = last[0]

            if q in chat.get("name", "").lower():
                chats.append({
                    "chatId": chat["id"], "name": chat.get("name", ""),
                    "color": chat.get("color", 0), "type": chat.get("type", "user"),
                    "preview": (last.get("text") if last else ""), "message": None,
                })

            hits = [m for m in sorted_messages(chat.get("messages"))
                    if q in (m.get("text") or "").lower()][-3:]
            for m in reversed(hits):
                chats.append({
                    "chatId": chat["id"], "name": chat.get("name", ""),
                    "color": chat.get("color", 0), "type": chat.get("type", "user"),
                    "preview": m.get("text", ""),
                    "message": {"id": m["id"], "text": m.get("text", "")},
                })

        fav = favorites_bucket(user["id"])
        fav_hits = [m for m in sorted_messages(fav["messages"])
                    if q in (m.get("text") or "").lower()][-3:]
        for m in reversed(fav_hits):
            chats.append({
                "chatId": "fav", "name": "Избранное", "color": 3, "type": "saved",
                "preview": m.get("text", ""),
                "message": {"id": m["id"], "text": m.get("text", "")},
            })

        added = {c.get("entryId"): c["id"] for c in s_chats().values() if c.get("entryId")}

        # живые аккаунты: ищем по имени и почте
        for acc in ACCOUNTS.users.values():
            if acc["id"] == user["id"]:
                continue
            hay = (acc.get("name", "") + " " + acc.get("email", "")).lower()
            if q not in hay:
                continue

            shared = None
            for chat in s_chats().values():
                members = chat_members(chat)
                if user["id"] in members and acc["id"] in members:
                    shared = chat["id"]
                    break

            people.append({
                "id": acc["id"], "type": "user",
                "name": acc.get("name", ""), "handle": "",
                "email": acc.get("email", ""), "about": "аккаунт",
                "members": 0,
                "color": zlib.crc32(acc["id"].encode()) % 8,
                "avatar": acc.get("avatar"),
                "chatId": shared,
            })

    # группы, в которые можно вступить (или вернуться)
    groups = []
    if q:
        for chat in s_chats().values():
            if chat.get("type") != "group":
                continue
            if q not in chat.get("name", "").lower():
                continue
            members = chat_members(chat)
            if user["id"] in members:
                continue
            groups.append({
                "id": chat["id"],
                "name": chat.get("name", ""),
                "avatar": chat.get("avatar"),
                "color": chat.get("color", 0),
                "members": len(members),
                "joined": user["id"] in members,
            })
        groups = groups[:10]

    return {"chats": chats, "people": people, "groups": groups}


# ------------------------------ HTTP -------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "massa"
    sys_version = ""

    def version_string(self):
        return "massa"

    def log_message(self, fmt, *args):
        # IP в журнале нужен для fail2ban, flush — чтобы строка попала сразу
        print("[massa] %s %s" % (self.client_ip(), fmt % args), flush=True)

    # --- helpers ---------------------------------------------------------

    def session(self):
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            if "=" in part:
                key, value = part.strip().split("=", 1)
                if key == COOKIE:
                    return {"token": value}
        return {}

    def send_json(self, payload, status=200, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For") or ""
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "?"

    def send_error_json(self, err):
        payload = {"message": err.message, "field": err.field}
        if getattr(err, "retry_after", None):
            payload["retryAfter"] = err.retry_after
        self.send_json({"error": payload}, err.status)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            raise ApiError("Слишком большой запрос", status=413)
        return self.rfile.read(length) if length else b""

    def read_json(self):
        raw = self.read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ApiError("Некорректный JSON")

    # --- маршруты --------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path.startswith("/api/"):
            return self.handle_api("GET", path, parsed.query)

        if path.startswith("/files/"):
            return self.serve_file(path[len("/files/"):])

        return self.serve_static(path, parsed.query)

    def do_POST(self):
        parsed = urlparse(self.path)
        return self.handle_api("POST", unquote(parsed.path), parsed.query)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        return self.handle_api("PATCH", unquote(parsed.path), parsed.query)

    def do_HEAD(self):
        self.do_GET()

    # --- static ----------------------------------------------------------

    def serve_static(self, path, query=""):
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        if name not in STATIC_FILES:
            return self.not_found()

        if ".." in name or name.startswith("/"):
            return self.not_found()

        full = os.path.join(WEB_DIR, name)
        if not os.path.isfile(full):
            return self.not_found()

        stat = os.stat(full)
        etag = '"%x-%x"' % (int(stat.st_mtime), stat.st_size)

        versioned = "v=" in (query or "")
        if name == "sw.js" or name.endswith(".html"):
            cache = "no-cache"
        elif versioned:
            cache = "public, max-age=31536000, immutable"
        else:
            cache = "public, max-age=3600"

        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.end_headers()
            return

        ctype = mimetypes.guess_type(full)[0] or "text/plain"
        if name.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        if name.endswith(".js"):
            ctype = "text/javascript"

        with open(full, "rb") as fh:
            data = fh.read()

        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or
                                                  "javascript" in ctype or "json" in ctype else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def serve_file(self, fid):
        meta = STORE.state["files"].get(fid)
        if not meta:
            return self.not_found()

        full = os.path.join(FILES_DIR, fid)
        if not os.path.isfile(full):
            return self.not_found()

        with open(full, "rb") as fh:
            data = fh.read()

        name = meta.get("name", "file")
        encoded = name.encode("utf-8").decode("latin-1", "replace")

        self.send_response(200)
        self.send_header("Content-Type", meta.get("type") or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition",
                         'inline; filename="%s"' % encoded.replace('"', ""))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def not_found(self):
        body = b"not found"
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- api -------------------------------------------------------------

    def handle_api(self, method, path, query):
        session = self.session()

        if rate_limited(self.client_ip()):
            return self.send_json({"error": {"message": "Слишком много запросов"}}, 429)

        try:
            if path == "/api/ping":
                return self.send_json({"ok": True, "mode": "http", "firebase": STORE.remote})

            if path == "/api/auth/register" and method == "POST":
                reg_ip = self.client_ip()

                # во время блокировки регистрация тоже недоступна
                left = login_block_left(reg_ip)
                if left > 0:
                    raise ApiError("Слишком много неверных попыток", status=429, retry_after=left)

                user = api_register(self.read_json(), reg_ip)
                token = ACCOUNTS.create_session(user["id"])
                return self.send_json(user, cookie=self.cookie_header(token, max_age=SESSION_TTL))

            if path == "/api/auth/login" and method == "POST":
                ip = self.client_ip()
                left = login_block_left(ip)
                if left > 0:
                    raise ApiError("Слишком много неверных попыток", status=429, retry_after=left)

                try:
                    user = api_login(self.read_json(), session)
                except ApiError:
                    login_fail(ip)

                    # пятая неудача сразу включает блокировку и таймер
                    left_after = login_block_left(ip)
                    if left_after > 0:
                        raise ApiError("Слишком много неверных попыток",
                                       status=429, retry_after=left_after)
                    raise

                login_ok(ip)
                return self.send_json(user, cookie=self.cookie_header(session["token"], max_age=SESSION_TTL))

            if path == "/api/auth/logout" and method == "POST":
                api_logout(session)
                return self.send_json({"ok": True}, cookie=self.cookie_header("", max_age=0))

            # всё ниже требует авторизации
            user = current_user(session)
            if not user:
                return self.send_json({"error": {"message": "Нужно войти"}}, 401)

            if path == "/api/me" and method == "GET":
                return self.send_json(public_user(user))

            if path == "/api/me" and method == "PATCH":
                return self.send_json(api_patch_me(user, self.read_json()))

            if path == "/api/account/password" and method == "POST":
                return self.send_json(api_change_password(user, self.read_json()))

            if path == "/api/directory" and method == "GET":
                return self.send_json(api_directory(user))

            if path == "/api/chats" and method == "GET":
                return self.send_json(api_chats(user))

            if path == "/api/chats" and method == "POST":
                body = self.read_json()
                if body.get("entryId"):
                    return self.send_json(api_add_chat(user, body))
                return self.send_json(api_create_group(user, body))

            if path == "/api/favorites" and method == "GET":
                return self.send_json(api_favorites(user))

            if path == "/api/sync" and method == "GET":
                return self.send_json(api_sync(user))

            if path == "/api/presence" and method == "POST":
                return self.send_json(api_presence(user, self.read_json()))

            if path == "/api/reset" and method == "POST":
                return self.send_json(api_reset(user))

            if path == "/api/search" and method == "GET":
                return self.send_json(api_search(user, parse_query(query, "q")))

            if path.startswith("/api/chats/"):
                rest = path[len("/api/chats/"):]
                chat_id, _, action = rest.partition("/")

                if not action and method == "GET":
                    return self.send_json(api_get_chat(user, chat_id))

                if action == "messages" and method == "POST":
                    return self.send_json(api_send_message(user, chat_id, self.read_json()))

                if action == "read" and method == "POST":
                    return self.send_json(api_mark_read(user, chat_id))

                if action == "avatar" and method == "POST":
                    return self.send_json(api_set_chat_avatar(user, chat_id, self.read_json()))

                if action == "members" and method == "GET":
                    return self.send_json(api_members(user, chat_id))

                if action == "members" and method == "POST":
                    return self.send_json(api_add_member(user, chat_id, self.read_json()))

                if action == "leave" and method == "POST":
                    return self.send_json(api_leave_group(user, chat_id))

                if action == "join" and method == "POST":
                    return self.send_json(api_join_group(user, chat_id))

                if action.startswith("messages/"):
                    rest_msg = action[len("messages/"):]
                    msg_id, _, msg_action = rest_msg.partition("/")
                    if msg_action == "readers" and method == "GET":
                        return self.send_json(api_readers(user, chat_id, msg_id))

                if action == "files" and method == "POST":
                    return self.send_json(self.upload(user, chat_id))

            return self.send_json({"error": {"message": "Нет такого метода"}}, 404)

        except ApiError as err:
            return self.send_error_json(err)
        except (HTTPError, URLError) as err:
            return self.send_json({"error": {"message": "Хранилище недоступно: %s" % err}}, 502)
        except Exception as err:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            return self.send_json({"error": {"message": "Внутренняя ошибка: %s" % err}}, 500)

    def upload(self, user, chat_id):
        raw_name = self.headers.get("X-File-Name") or ""
        try:
            filename = base64.b64decode(raw_name).decode("utf-8") if raw_name else "file"
        except Exception:  # noqa: BLE001
            filename = "file"

        content_type = self.headers.get("Content-Type") or "application/octet-stream"
        data = self.read_body()
        return api_send_file(user, chat_id, filename, content_type, data)

    def cookie_header(self, token, max_age=None):
        parts = ["%s=%s" % (COOKIE, token), "Path=/", "HttpOnly", "SameSite=Lax"]
        if max_age is not None:
            parts.append("Max-Age=%d" % max_age)
        # за реверс-прокси с TLS помечаем cookie как Secure
        if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
            parts.append("Secure")
        return "; ".join(parts)


def parse_query(query, key):
    for part in (query or "").split("&"):
        if "=" in part:
            k, v = part.split("=", 1)
            if k == key:
                return unquote(v.replace("+", " "))
    return ""


# ------------------------------- запуск ----------------------------------

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.makedirs(FILES_DIR, exist_ok=True)
    server = Server((HOST, PORT), Handler)

    def stop(signum, frame):
        print("\n[massa] остановка по сигналу", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, stop)
        except (ValueError, AttributeError, OSError):
            pass

    mode = "Firebase " + FIREBASE_URL + FIREBASE_PATH if STORE.remote else "локальный state.json"
    print("massa запущен: http://%s:%d  (%s)" % (HOST, PORT, mode), flush=True)
    print("папка файлов: %s" % FILES_DIR, flush=True)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        print("[massa] сервер остановлен", flush=True)


if __name__ == "__main__":
    main()
