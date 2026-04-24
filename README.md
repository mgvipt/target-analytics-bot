# 🎯 Таргет Аналитика Bot

Telegram-бот для управления рекламой в Meta Ads (Facebook/Instagram).  
Автоматические отчёты, управление кампаниями, запись в Google Sheets, мониторинг биллинга.

---

## Что умеет бот

- ☀️ **Утренний отчёт в 09:00** — расход, охват, CTR за вчера + запись в Google Sheets
- 📊 **Дневные проверки в 13:00 и 18:00** — анализ кампаний и объявлений
- 📈 **Управление кампаниями** — пауза, +20% / -20% бюджет прямо из Telegram
- 📂 **Управление группами объявлений** — просмотр CTR, изменение бюджета
- 🎨 **Управление объявлениями** — включить / выключить каждое
- 💳 **Мониторинг биллинга** — проверка каждые 6 часов, алерт в личку если проблема
- 📝 **Word-отчёты** — полная аналитика за любой период одним файлом
- 🤖 **AI-чат** — задай вопрос про свою рекламу, ответит на основе реальных данных

---

## Что нужно для запуска

| Что | Где получить |
|-----|-------------|
| Сервер (VPS) | [Hetzner](https://hetzner.com) — от 4€/мес |
| Telegram Bot Token | [@BotFather](https://t.me/BotFather) |
| Meta Access Token | [developers.facebook.com](https://developers.facebook.com) |
| Google Cloud проект | [console.cloud.google.com](https://console.cloud.google.com) |
| Anthropic API (опционально) | [console.anthropic.com](https://console.anthropic.com) |

---

## Установка — шаг за шагом

### Шаг 1. Клонируй репозиторий

```bash
git clone https://github.com/mgvipt/target-analytics-bot.git
cd target-analytics-bot
```

---

### Шаг 2. Получи Meta Access Token

1. Зайди на [developers.facebook.com](https://developers.facebook.com)
2. Создай приложение типа **Business**
3. Добавь продукт **Marketing API**
4. В Graph API Explorer выбери своё приложение
5. Добавь права: `ads_management`, `ads_read`, `instagram_basic`, `pages_read_engagement`
6. Нажми **Generate Access Token**
7. Конвертируй в долгоживущий (60 дней):

```
GET https://graph.facebook.com/v21.0/oauth/access_token
  ?grant_type=fb_exchange_token
  &client_id=APP_ID
  &client_secret=APP_SECRET
  &fb_exchange_token=SHORT_TOKEN
```

Узнай свои ID:
```bash
# Ad Account ID
curl "https://graph.facebook.com/v21.0/me/adaccounts?access_token=TOKEN"

# Page ID
curl "https://graph.facebook.com/v21.0/me/accounts?access_token=TOKEN"

# Instagram Account ID
curl "https://graph.facebook.com/v21.0/PAGE_ID?fields=instagram_business_account&access_token=TOKEN"
```

---

### Шаг 3. Создай Telegram бота

1. Открой [@BotFather](https://t.me/BotFather)
2. Отправь `/newbot`
3. Придумай имя и username (например `@MyAdsBot`)
4. Скопируй **Bot Token** — выглядит как `1234567890:ABCdef...`

Получи Chat ID группы:
1. Добавь бота в группу/канал
2. Открой: `https://api.telegram.org/botТВОЙ_ТОКЕН/getUpdates`
3. Найди `"chat":{"id": -100XXXXXXXXXX}` — это и есть `TELEGRAM_CHAT_ID`

Получи свой личный Chat ID:
1. Напиши боту `/myid` в личку
2. Бот ответит твоим числом

---

### Шаг 4. Настрой Google Sheets и Drive

#### 4.1 Создай OAuth2 приложение (для Sheets)

1. Зайди в [Google Cloud Console](https://console.cloud.google.com)
2. Создай проект
3. Включи APIs: **Google Sheets API**, **Google Drive API**
4. Перейди в **APIs & Services → Credentials**
5. Нажми **Create Credentials → OAuth 2.0 Client ID**
6. Тип приложения: **Desktop app**
7. Скачай JSON → возьми из него `client_id` и `client_secret`

#### 4.2 Авторизуй доступ к своим Sheets

```bash
node reports/setup-drive-oauth.js
```

Откроется браузер → разреши доступ → в папке появится `sheets-token.json`

#### 4.3 Создай Google Таблицу

1. Создай новую Google Таблицу
2. Назови лист **"Апрель 2026"** (или текущий месяц)
3. Скопируй ID таблицы из URL:  
   `https://docs.google.com/spreadsheets/d/**ВОТ_ЭТО**/edit`
4. Вставь ID в `bot-server.js` в переменную `SHEET_ID`

#### 4.4 Папка на Google Drive (для Word-отчётов)

1. Создай папку на Google Drive
2. Открой папку → скопируй ID из URL
3. Вставь в `.env` как `DRIVE_STAT_FOLDER_ID`

---

### Шаг 5. Заполни .env

```bash
cp .env.example .env
nano .env   # или открой в любом редакторе
```

```env
META_ACCESS_TOKEN=твой_токен_здесь
META_AD_ACCOUNT_ID=act_XXXXXXXXXX
META_PAGE_ID=XXXXXXXXXX
META_IG_ACCOUNT_ID=XXXXXXXXXX
META_API_VERSION=v21.0

TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
TELEGRAM_CHAT_ID=-100XXXXXXXXXX
TELEGRAM_PERSONAL_CHAT_ID=XXXXXXXXXX

GOOGLE_OAUTH_CLIENT_ID=XXXXX.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=XXXXX
DRIVE_STAT_FOLDER_ID=XXXXX

# Опционально — для AI-чата в боте
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

---

### Шаг 6. Разверни на сервере

#### 6.1 Подготовь сервер (один раз)

Рекомендуется **Hetzner CX22** (2 vCPU, 4GB RAM, 4€/мес).

```bash
# Подключись к серверу
ssh root@ТВОй_IP

# Установи Node.js 20 и PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2

# Создай папку
mkdir -p /root/bot/reports /root/bot/logs
```

Или используй готовый скрипт:
```bash
scp server-setup.sh root@ТВОй_IP:/root/
ssh root@ТВОй_IP "bash /root/server-setup.sh"
```

#### 6.2 Загрузи файлы на сервер

```bash
# Исходный код
scp package.json package-lock.json ecosystem.config.cjs root@IP:/root/bot/
scp reports/bot-server.js root@IP:/root/bot/reports/

# Секреты (не в git!)
scp .env sheets-token.json drive-token.json root@IP:/root/bot/
```

Или используй готовый скрипт:
```bash
bash deploy-upload.sh ТВОй_IP
```

#### 6.3 Установи зависимости и запусти

```bash
ssh root@ТВОй_IP "
  cd /root/bot
  npm install --omit=dev
  
  # Установи часовой пояс
  timedatectl set-timezone Europe/Kyiv
  
  # Запусти бота
  pm2 start ecosystem.config.cjs
  
  # Автозапуск при перезагрузке сервера
  pm2 save
  pm2 startup systemd -u root --hp /root | tail -1 | bash
"
```

---

### Шаг 7. Проверь что всё работает

```bash
# Логи бота
ssh root@IP "pm2 logs tg-bot --lines 20"

# Статус
ssh root@IP "pm2 status"
```

В Telegram напиши боту — он должен ответить на `/start`.

---

## Обновление бота

Когда вносишь изменения в `reports/bot-server.js`:

```bash
# Загрузи обновлённый файл
scp reports/bot-server.js root@IP:/root/bot/reports/

# Перезапусти
ssh root@IP "pm2 restart tg-bot --update-env"
```

---

## Команды бота

| Команда | Что делает |
|---------|-----------|
| `/start`, `/help` | Главное меню с кнопками |
| `/report` | Полный отчёт в Word (выбор периода) |
| `/status` | Активные кампании + бюджеты |
| `/adsets` | Группы объявлений + управление |
| `/ads` | Все объявления (включить/выключить) |
| `/billing` | Статус биллинга Meta + ссылка на оплату |
| `/new` | Мастер создания новой кампании |
| `/myid` | Показать свой Telegram Chat ID |

---

## Структура таблицы Google Sheets

Каждый месяц — отдельный лист (например "Апрель 2026").  
Колонки B–AE = дни месяца, колонка AF = итог за месяц.

Бот автоматически заполняет таблицу каждое утро данными за вчера.

---

## Частые проблемы

**Бот не отвечает**
```bash
ssh root@IP "pm2 logs tg-bot --lines 50"
```

**409 Conflict в логах** — запущено два экземпляра бота
```bash
# На сервере
pm2 restart tg-bot

# Если запущен локально — убей
pkill -f bot-server.js
```

**Таблица не заполняется** — проверь `sheets-token.json` на сервере:
```bash
ssh root@IP "ls -la /root/bot/sheets-token.json"
```

**Meta токен истёк** — токены живут 60 дней, обнови в `.env` и перезапусти бота

---

## Лицензия

MIT — используй свободно.
