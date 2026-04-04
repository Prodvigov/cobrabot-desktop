# CobraBot Desktop

Клиент для удалённого управления ПК через CobraBot (Telegram).

## Возможности

- 🖥️ Удалённое управление ПК через Telegram
- 📸 Скриншоты экрана
- ⌨️ Выполнение команд
- 🌐 Управление браузером (Puppeteer)
- 🔒 Безопасное соединение через TLS
- ⚠️ Safety prompts для опасных команд
- 💓 Heartbeat (проверка связи каждые 30 сек)
- 🔄 Auto-reconnect при разрыве

## Установка

### macOS
1. Скачайте `CobraBot-1.0.0.dmg`
2. Откройте DMG
3. Перетащите CobraBot в Applications
4. Запустите и введите токен

### Windows
1. Скачайте `CobraBot-1.0.0.exe`
2. Запустите установщик
3. Запустите CobraBot из меню Пуск
4. Введите токен

### Linux
```bash
chmod +x CobraBot-1.0.0.AppImage
./CobraBot-1.0.0.AppImage
```

## Подключение через Deeplink

Нажмите в Telegram: "Подключить ПК"

Откроется: `cobrabot://connect?token=xxx`

Токен подставится автоматически!

## Разработка

```bash
# Установка зависимостей
npm install

# Запуск в режиме разработки
npm start

# Сборка для macOS
npm run build:mac

# Сборка для Windows
npm run build:win

# Сборка для Linux
npm run build:linux
```

## Архитектура

```
┌─────────────┐                      ┌─────────────┐
│  Telegram   │                      │   Desktop   │
│   (User)    │                      │   (Client)  │
└──────┬──────┘                      └──────┬──────┘
       │                                    │
       │ HTTP API (18792)                  │ WebSocket (18790)
       │                                    │
       └──────────────┬─────────────────────┘
                      │
               ┌──────▼──────┐
               │   Gateway   │
               │   (Server)  │
               └─────────────┘
```

## Команды (от Gateway)

### Desktop Control
| Команда | Описание |
|---------|----------|
| `screenshot` | Скриншот экрана |
| `exec` | Выполнить shell команду |
| `click` | Клик по координатам |
| `type` | Ввод текста |
| `keypress` | Нажатие клавиши |
| `mousemove` | Движение мыши |
| `scroll` | Прокрутка |
| `ping` | Проверка соединения |

### Browser Control (Puppeteer)
| Команда | Описание |
|---------|----------|
| `browser_launch` | Запустить браузер |
| `browser_navigate` | Открыть URL |
| `browser_screenshot` | Скриншот страницы |
| `browser_click` | Клик по селектору |
| `browser_type` | Ввод в поле |
| `browser_wait` | Ожидание элемента |
| `browser_evaluate` | Выполнить JS |
| `browser_close` | Закрыть браузер |

## Безопасность

- 🔐 TLS шифрование (wss://)
- 🔑 Токен аутентификации
- 🛡️ Исходящее соединение (ПК → сервер)
- ⚠️ Safety tiers для опасных команд

## Лицензия

MIT
