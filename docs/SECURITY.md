# Безопасность massa

Документ фиксирует, что уже защищено, что добавили в этот заход и что нужно
сделать в Android-версии под кейс «Созвездие».

Интерфейс при этом **не менялся** — все меры серверные и невидимые для пользователя.

---

## 1. Что было и осталось

| Мера | Где | Детали |
|---|---|---|
| Пароли не хранятся в открытом виде | `server.py` | PBKDF2-HMAC-SHA256, 120 000 итераций, соль на пользователя |
| Сессии | `server.py` | случайный токен, httpOnly-cookie, срок 30 дней |
| HTTPS | Caddy | Let's Encrypt, HTTP/2 + HTTP/3, редирект с http |
| Блокировка подбора пароля | `server.py` | 5 неудач с IP → блок на 5 минут, таймер в интерфейсе |
| Лимит регистраций | `server.py` | не больше 3 аккаунтов с одного IP |
| Валидация ввода | `server.py` | длина пароля, формат почты, проверка типов |
| Лимит размера загрузки | Caddy + `server.py` | 60 МБ на запрос, 50 МБ на файл |
| Данные отдельно от кода | systemd | `/opt/massa` (код) и `/var/lib/massa` (данные, 0700) |
| Песочница сервиса | systemd | `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, пустой `CapabilityBoundingSet` |
| Права файлов | ФС | данные `600`, каталоги `700`, код в `/opt` только на чтение сервису |
| Фаервол | ufw | открыты только нужные порты |
| Резервные копии | таймер | ежедневно 03:30, 7 последних копий |

---

## 2. Что добавлено сейчас

### 2.1. Заголовки безопасности (Caddy)

```
strict-transport-security: max-age=31536000; includeSubDomains
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self';
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
permissions-policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
cross-origin-opener-policy: same-origin
```

Что это даёт:

- **HSTS** — браузер больше не пытается открыть сайт по http;
- **CSP** — страница не может подгрузить чужой скрипт и не может быть
  встроена во фрейм (защита от XSS и кликджекинга); наши скрипты и стили
  грузятся только с нашего домена, картинки-аватары (data:) и предпросмотры
  (blob:) разрешены;
- **nosniff** — браузер не угадывает тип файла;
- **X-Frame-Options: DENY** — сайт нельзя встроить в iframe;
- **Referrer-Policy: no-referrer** — адреса не утекают на сторонние сайты;
- **Permissions-Policy** — камера, микрофон, геолокация запрещены.

### 2.2. Скрыта версия сервера

Раньше отдавалось `Server: massa/1.0 Python/3.12.3` — это подсказка атакующему.
Теперь заголовок вообще не отдаётся.

### 2.3. Ограничение частоты запросов

- 90 запросов API с одного IP за 10 секунд, дальше — `429` «Слишком много запросов»;
- счётчик в памяти процесса, окно скользящее по времени;
- обычный клиент тратит ~3 запроса в 10 секунд (опрос `/api/sync` раз в 3 с),
  так что лимит не мешает, но отсекает брутфорс и парсеры.

Проверено: при пороге 5 из 10 запросов прошли 5, остальные получили `429`.

### 2.4. fail2ban для попыток входа

- фильтр читает журнал сервиса и ловит строки
  `[massa] <IP> "POST /api/auth/login HTTP/1.1" 4xx`;
- 12 неудачных попыток за 10 минут → бан IP на час на уровне iptables
  (порты http/https);
- в журнал теперь пишется IP клиента (и строка сбрасывается сразу, без буфера).

Проверено: сервис активен, три тюрьмы — `sshd`, `3x-ipl` (наша панель) и
`massa-auth`.

### 2.5. Ежедневные резервные копии

- `massa-backup.timer` каждый день в 03:30 собирает
  `/var/lib/massa` (состояние, аккаунты, файлы) в
  `/var/backups/massa/data-ГГГГММДД-ЧЧММСС.tar.gz`;
- права `600 root:root`, хранится 7 последних копий;
- первая копия уже снята, таймер включён.

---

## 3. Что добавить в Android-версии (кейс «Созвездие»)

Интерфейс не меняется — это всё внутренняя работа.

### 3.1. Firebase

| Что | Как |
|---|---|
| Правила Realtime Database | `chats/{id}` читают и пишут только участники; `users/{uid}` — только владелец; запрет на изменение `senderId`, `ts`, `reads` чужими |
| Валидация в правилах | длина текста ≤ 4096, тип сообщения из белого списка, размер полей |
| Storage | файлы в `chats/{chatId}/…`, доступ только участникам чата; лимит размера и MIME-типа |
| App Check | Play Integrity для Android — отсекает неофициальные клиенты и скрипты |
| Ключи | `google-services.json` не в git; в консоли ограничить API-ключ по `applicationId` и SHA-1 подписи |

### 3.2. Приложение

| Что | Как |
|---|---|
| Токены | `EncryptedSharedPreferences` (Android Keystore), не обычные настройки |
| Резервное копирование | `android:allowBackup="false"`, чтобы токен не утёк через adb backup |
| Логи | не писать текст сообщений и токены в logcat |
| Сеть | только HTTPS, `network_security_config` с запретом cleartext |
| Скриншоты | `FLAG_SECURE` на экранах чата, если нужно скрыть содержимое от скриншотов |
| Сборка | R8/ProGuard в release, `debuggable=false` |
| Файлы | проверка MIME и размера перед загрузкой, пережатие картинок, удаление EXIF (геометки) |
| Ввод | ограничение длины сообщения на клиенте и сервере |

---

## 4. Как проверить, что всё на месте

```bash
# заголовки
curl -sD - -o /dev/null https://50-114-115-15.sslip.io/ | head -20

# пинг
curl -s https://50-114-115-15.sslip.io/api/ping

# лимит частоты (порог сейчас 90)
seq 1 120 | xargs -P 20 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
  https://50-114-115-15.sslip.io/api/ping | sort | uniq -c

# fail2ban
fail2ban-client status massa-auth

# бэкапы
ls -la /var/backups/massa/data-*.tar.gz
systemctl list-timers massa-backup.timer
```

---

## 5. Откат

Все изменённые конфиги сохранены с меткой времени в `/var/backups/massa`:

- `Caddyfile-<дата>` — прежний конфиг Caddy;
- `server.py-<дата>` — прежний сервер;
- старый юнит — `/root/massa.service.old`;
- данные до переезда — `/root/massa-pre-migration-*.tar.gz`.

Откат заголовков: вернуть `Caddyfile-*` на место и `systemctl reload caddy`.
Откат fail2ban: удалить `/etc/fail2ban/jail.d/massa.local` и
`/etc/fail2ban/filter.d/massa-auth.conf`, затем `systemctl restart fail2ban`.

---

## 6. Что осознанно не делаем

- **Сквозное шифрование переписки** — для MVP кейса избыточно, но стоит
  упомянуть на защите как направление развития.
- **2FA** — не требуется кейсом.
- **Пиннинг сертификата** в Android — усложняет обновления, отложено.
- **WAF** (ModSecurity) — при нашем трафике достаточно CSP, лимитов и fail2ban.
- **Шифрование бэкапов** — сейчас права `600` и отдельный каталог; при желании
  добавим `age`/`gpg` позже.
