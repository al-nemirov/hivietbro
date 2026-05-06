# Bridge — Chat Translation (browser extension)

Open-source расширение, которое переводит твой чат на Zalo Web в реальном времени через Anthropic Claude API. Ты пишешь по-русски — собеседник видит на вьетнамском (или любом из 6 поддерживаемых языков). Входящие — автоматически переведены под оригиналом.

**Лицензия:** [MIT](LICENSE) — пользуйтесь, форкайте, модифицируйте.

## Что делает

- 🔄 Перехватывает входящие сообщения на `chat.zalo.me` → переводит → подсвечивает над оригиналом
- ✏️ Когда пишешь по-русски и жмёшь Enter — переводит в выбранный язык и отправляет вьетнамским
- 🌏 Поддержка VI, EN, ZH, JA, KO, FR — отдельная настройка для каждого чата
- 🔒 Локальный AES-GCM шифрованный кэш — мгновенно показывает переводы при повторном открытии
- 📚 Глоссарий — закрепить «Anh Tuấn → брат Туан» и подобные принудительные замены
- 🪶 Без интрузивного UI — плавающий чип, draggable, можно перетащить куда удобно

## Архитектура

```
[Browser extension (этот репо)]  →  [Backend API]  →  [Anthropic Claude]
       MIT, открытый                  закрытый            third-party
```

Расширение работает поверх **официального** клиента Zalo Web — вся сетевая часть и шифрование на стороне Zalo. Расширение только читает DOM и инжектит переведённый текст в нативное поле ввода. **Не нарушает ToS Zalo**, не использует неофициальные API.

Бэкенд (Cloudflare Worker, который проксирует Claude API + биллинг + квоты) — закрытый, не входит в этот репозиторий. Расширение коммуницирует с бэкендом через JWT по HTTPS.

## Установка

1. Установи [Plasmo](https://plasmo.com): `npm install`
2. `npm run dev`
3. В Chrome: `chrome://extensions/` → Developer mode → Load unpacked → `build/chrome-mv3-dev/`
4. В попапе расширения — войти через Google
5. Открой `chat.zalo.me` → нажми чип внизу справа → включи перевод

## Структура

```
extension/
├── src/
│   ├── contents/zalo.ts    Content script для chat.zalo.me
│   ├── background.ts       Service worker — OAuth + IDB cache
│   ├── popup.tsx           UI попапа
│   └── lib/
│       ├── api.ts          Клиент Worker API
│       ├── cache.ts        IndexedDB + AES-GCM (в background)
│       ├── cache-client.ts Тонкий клиент к background
│       ├── chat-settings.ts Per-chat настройки (chrome.storage)
│       ├── glossary-client.ts CRUD над /glossary
│       └── storage.ts      JWT + user wrapper
├── assets/                 Иконки
├── package.json            Plasmo manifest
└── LICENSE                 MIT
```

## Сборка

```bash
npm run dev          # Chrome MV3 + HMR
npm run build        # Chrome MV3 production
npm run build:firefox  # Firefox MV2
```

## Конфигурация

Создай `.env.development` и `.env.production`:

```
PLASMO_PUBLIC_API_BASE=https://your-worker.workers.dev
PLASMO_PUBLIC_GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
```

Если хочешь использовать собственный backend вместо нашего — реализуй те же endpoints (см. [docs/api.md](https://github.com/.../docs/api.md)).

## Контрибуции

Pull requests welcome. Перед PR — убедись:
- TypeScript компилится (`npx tsc --noEmit`)
- Plasmo собирается (`npm run build`)
- Селекторы Zalo (см. `src/contents/zalo.ts`) не сломаны на актуальном `chat.zalo.me`

## Troubleshooting

**Extension context invalidated** в консоли — после reload расширения. Закрой вкладку chat.zalo.me и открой заново.

**Чип не появляется** — проверь, что:
1. Залогинен (попап показывает email)
2. Открыт реальный чат (#messageViewScroll присутствует в DOM)
3. Console на странице не показывает ошибок начинающихся с `[zalo-bridge]`

**Иконка серая в тулбаре** — кликни 🧩 (puzzle piece) → найди расширение → 📌 (pin).

## Disclaimer

Это независимый продукт. Не аффилирован с VNG Corporation. «Zalo» — товарный знак VNG.
