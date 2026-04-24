# ТАРГЕТ АНАЛИТИКА — Контекст проекта для Claude

## Что это за проект

Telegram-бот для управления рекламой в Meta Ads (Facebook/Instagram).
Работает 24/7 на сервере Hetzner. Mac не нужен для работы бота.

## Сервер

- **IP**: 46.225.71.162
- **SSH**: `ssh -i ~/.ssh/hetzner_key root@46.225.71.162`
- **Пароль**: хранится у владельца
- **Timezone**: Europe/Kyiv (UTC+3)
- **PM2 процесс**: `tg-bot` → `/root/bot/reports/bot-server.js`
- **Логи**: `pm2 logs tg-bot --lines 50`
- **Рестарт**: `pm2 restart tg-bot --update-env`

## Деплой обновлений

```bash
# 1. Загрузить новый bot-server.js на сервер
sshpass -p 'PASS' scp reports/bot-server.js root@46.225.71.162:/root/bot/reports/

# 2. Перезапустить
sshpass -p 'PASS' ssh root@46.225.71.162 "pm2 restart tg-bot --update-env"
```

## Главный файл бота

`/reports/bot-server.js` — единственный файл, который нужно редактировать для изменения логики бота.

## Архитектура

### Расписание (автоматические отчёты)
- **09:00** — `sendMorningReport()` → утренний отчёт за вчера + запись в Google Sheets
- **13:00** — `sendDayCheck()` → проверка кампаний за 7 дней
- **18:00** — `sendDayCheck()` + `sendWeeklySummary()` (по пятницам)
- **каждые 6ч** — `checkBilling()` → проверка биллинга Meta

### Функции бота
- `sendMorningReport()` — утренний отчёт
- `sendDayCheck()` — дневной отчёт (13 и 18)
- `sendWeeklySummary()` — недельный итог
- `sendAdsetsReport(chatId)` — группы объявлений с кнопками
- `sendAdsReport(chatId)` — объявления с on/off
- `sendBillingReport(chatId)` — статус биллинга Meta
- `saveDailyToSheet(date, campInsights, campaigns, igFollowers)` — запись в Google Sheets
- `checkBilling()` — проверка статуса аккаунта Meta, каждые 6 часов
- `sendCritical(text, keyboard)` — отправка в группу И в личку владельца

### Telegram чаты
- `TG_CHAT` = группа/канал (все отчёты)
- `TG_PERSONAL` = личка владельца (только критичные: биллинг, блокировка)

## Google Sheets

**ID таблицы**: `1jTpm2cF3q_a7lNMbdAFQES0rWhd8noqhYsMMognHA3g`

### Структура листа "Апрель 2026" (и каждый месяц)
- Строки B:AE = дни месяца (B=1, C=2, ..., AE=30/31)
- Столбец AF = итоги за месяц (SUM-формулы)
- Разделитель формул: **`;`** (украинский локаль таблицы)

| Строка | Данные |
|--------|--------|
| 2 | Даты (01.04.2026 ... 30.04.2026) |
| 3 | Затраты Direct ($) |
| 4 | Показы Direct |
| 5 | Охват Direct |
| 6 | Клики Direct |
| 8 | CPM Direct |
| 9 | CPC Direct |
| 10 | CTR Direct (%) |
| 11 | CR Direct (%) |
| 13 | Результаты Direct (лиды/диалоги) |
| 14 | CPL Direct ($) |
| 18 | Затраты Traffic ($) |
| 19 | Показы Traffic |
| 20 | Охват Traffic |
| 21 | Клики Traffic |
| 23 | CPM Traffic |
| 24 | CPC Traffic |
| 25 | CTR Traffic (%) |
| 27 | Результаты Traffic |
| 28 | CPL Traffic |
| 32 | Всего инвестировано ($) |
| 33 | Цена заявки общая ($) |
| 34 | Показы всего |
| 35 | Охват всего |
| 36 | Клики всего |
| 37 | Подписчики Instagram (daily net change) |

### Форматы ячеек (Google Sheets)
- Денежные (3,8,9,14,18,23,24,28,32,33): `'"$"#,##0.00'` CURRENCY
- Целые (4,5,6,13,19,20,21,27,34,35,36,37): `'#,##0'` INTEGER  
- CTR/CR строки (10,11,25): `'0.00"%"'` NUMBER с литеральным % (не PERCENT!)
- **Важно**: PERCENT формат умножает на 100 — не использовать для CTR/CR

## Meta Ads API

### Разделение кампаний
- **Direct** = всё кроме `OUTCOME_TRAFFIC` (engagement, leads, messages)
- **Traffic** = `objective === 'OUTCOME_TRAFFIC'`

### Биллинг
- `account_status`: 1=Active, 2=Disabled, 3=Unsettled, 9=GracePeriod
- `balance` — в центах (делить на 100)
- `amount_spent` — в центах (исторически всего)
- `daily_budget` — в центах (делить на 100)
- Ссылка на биллинг: `https://www.facebook.com/ads/manager/billing/payment_activity`

### Instagram Insights
- `follower_count` с `period=day` → **net daily change** (не total!)
- Данные появляются с задержкой 1-2 дня
- Если API возвращает 0 → не писать в таблицу (нет данных)

## Команды бота

| Команда | Действие |
|---------|----------|
| `/start`, `/help` | Главное меню |
| `/report`, `/отчет` | Выбор периода → два Word документа |
| `/status` | Активные кампании |
| `/adsets`, `/группы` | Группы объявлений |
| `/ads`, `/объявления` | Объявления (вкл/выкл) |
| `/billing`, `/биллинг` | Статус биллинга Meta |
| `/new`, `/создать` | Мастер создания кампании |
| `/myid` | Показать свой Telegram Chat ID |

## Известные особенности / ловушки

1. **409 Conflict** — два экземпляра бота запущены одновременно. Убить локальный: `pkill -f bot-server.js`
2. **effective_status фильтр** — не использовать в API запросах adsets, фильтровать локально по `a.status === 'ACTIVE'`
3. **Длинные сообщения** — использовать `sendLongMessage()` вместо `safeSend()` для /adsets и /ads
4. **Дата row 2** — хранить как RAW текст "01.04.2026", не как Date (иначе парсится некорректно)
5. **Числа в ячейках** — хранить как числа (не строки), иначе SUM возвращает 0
6. **PM2 рестарт** — всегда с `--update-env` если менялся .env

## Структура файлов

```
meta-ads-mcp/
├── reports/
│   └── bot-server.js        ← ГЛАВНЫЙ ФАЙЛ БОТА
├── .env                     ← секреты (не в git)
├── .env.example             ← шаблон для нового пользователя
├── sheets-token.json        ← Google OAuth токен (не в git)
├── drive-token.json         ← Google Drive токен (не в git)
├── ecosystem.config.cjs     ← PM2 конфиг
├── deploy-upload.sh         ← скрипт деплоя на сервер
├── server-setup.sh          ← первичная настройка сервера
└── package.json
```

## Быстрые команды для отладки

```bash
# Посмотреть логи сервера
ssh -i ~/.ssh/hetzner_key root@46.225.71.162 "pm2 logs tg-bot --lines 30"

# Статус PM2
ssh -i ~/.ssh/hetzner_key root@46.225.71.162 "pm2 status"

# Задеплоить изменения
sshpass -p 'PASS' scp reports/bot-server.js root@46.225.71.162:/root/bot/reports/ && \
sshpass -p 'PASS' ssh root@46.225.71.162 "pm2 restart tg-bot --update-env"
```
