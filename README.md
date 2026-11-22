# microrun

Self-hosted інструмент безпечного відкату релізів для Docker Compose без Kubernetes.
Один екземпляр обслуговує всі оточення проєкту (dev, stage, production): фіксує кожен реліз,
перевіряє схему бази до деплою, відкочує однією дією в UI без DDL і блокує повторний деплой
коміту, з якого виконано відкат.

## Встановлення

```yaml
# docker-compose.yml
services:
  microrun:
    image: microrun/microrun:1
    restart: unless-stopped
    env_file: .env
    ports: ["8080:8080"]
    volumes:
      - microrun-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
volumes:
  microrun-data:
```

`.env`:

| ENV | Обов'язкова | Значення |
|---|---|---|
| `MICRORUN_ADMIN_USER` | так | логін адміністратора |
| `MICRORUN_ADMIN_PASSWORD` | так | пароль, ≥ 12 символів, інакше сервер не стартує |
| `MICRORUN_SECRET_KEY` | так | 32 байти base64 (`openssl rand -base64 32`) для шифрування секретів сховищ |
| `MICRORUN_PUBLIC_URL` | так | зовнішній URL; `https://` вмикає `Secure` cookie |
| `MICRORUN_TRUST_PROXY` | ні | вимкнено; адреси або підмережі reverse-проксі через кому (`127.0.0.1`, `10.0.0.0/8`), чиїм `X-Forwarded-For`/`X-Forwarded-Proto` сервер довіряє |
| `MICRORUN_DATA_DIR` | ні | `/data`; SQLite `microrun.db` у WAL-режимі |
| `PORT` | ні | `8080` |

### HTTPS через reverse-проксі

Сервер слухає звичайний HTTP; TLS завершує проксі перед ним. Задайте `MICRORUN_TRUST_PROXY`
адресою проксі, щоб сервер бачив справжню IP клієнта й протокол. Проксі має пропускати
WebSocket-апгрейд для `/api/v1/agent` і не буферизувати SSE-потоки `/ops` та `/api/v1/operations`.

Caddy:

```
microrun.example.com {
	reverse_proxy /ops/* 127.0.0.1:8080 {
		flush_interval -1
	}
	reverse_proxy /api/v1/operations/* 127.0.0.1:8080 {
		flush_interval -1
	}
	reverse_proxy 127.0.0.1:8080
}
```

Caddy сам передає WebSocket-апгрейд і заголовки `X-Forwarded-*`.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name microrun.example.com;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location /api/v1/agent {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }

    location ~ ^/(ops|api/v1/operations)/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

### Вбудований агент

Якщо змонтовано `/var/run/docker.sock`, сервер реєструє сервер `local` і керує контейнерами
цього хоста сам. Йому потрібні:

- каталоги compose-проєктів (`compose_dir` оточення), змонтовані в контейнер **за тим самим
  шляхом**: `-v /srv/shop:/srv/shop`;
- для приватних registry — `-v ~/.docker/config.json:/root/.docker/config.json:ro`;
- для локального сховища релізів — каталог `storage_path`, змонтований так само.

### Агент на інших серверах

На кожному іншому хості з Docker і Compose ≥ 2.30:

```sh
npm i -g microrun
microrun agent --url https://microrun.example.com --token <токен із «Сервери»>
```

Агент сам підключається до сервера вихідним WebSocket; вхідні порти й SSH-ключі не потрібні.
Для systemd:

```sh
sudo install -d -m 700 /etc/microrun
sudo install -m 600 /dev/null /etc/microrun/agent.env
echo 'MICRORUN_AGENT_TOKEN=<токен>' | sudo tee /etc/microrun/agent.env >/dev/null
microrun agent install-service --url https://microrun.example.com | sudo tee /etc/systemd/system/microrun-agent.service
sudo systemctl enable --now microrun-agent
```

Юніт від `install-service` читає токен через `EnvironmentFile=/etc/microrun/agent.env` і ніколи
не містить його сам, навіть якщо передано `--token`: файли юнітів доступні на читання всім
користувачам, тому токен лежить лише у файлі з правами 0600.

### Сховища релізів

Для кожного сервера заведіть окремі облікові дані сховища, обмежені власним префіксом
(S3-префікс або репозиторій registry), а не один спільний ключ на всі сервери. Тоді
скомпрометований хост не зможе прочитати чи підмінити релізи інших серверів. Під час
завантаження агент звіряє образи з digest, записаним при деплої, і відхиляє підмінений архів
або перезаписаний тег (`STORAGE_FAILED`, `reason: digest`). Назва оточення в шляхах і тегах
нормалізується до малих літер, цифр і дефісів: `My Env` → `my-env`.

## Деплой із CI

```sh
npx microrun deploy \
  --url "$MICRORUN_URL" --token "$MICRORUN_DEPLOY_TOKEN" \
  --image web=registry.example.com/shop/web:$GIT_SHA \
  --image worker=registry.example.com/shop/worker:$GIT_SHA \
  --commit "$GIT_SHA" --branch prod
```

`--image <ref>` без імені сервісу застосовує один образ до всіх сервісів оточення.
Коди виходу: `0` — успіх або коміт уже активний; `2` — відмова (`COMMIT_BLOCKED`,
`COMMIT_EXPIRED`, `SCHEMA_DESTRUCTIVE`, `BRANCH_MISMATCH`, `DB_MARKER_MISMATCH`, …) з причиною в
повідомленні; `1` — збій під час деплою; `3` — помилка запуску, мережі чи оточення зайняте довше
за `--busy-timeout`.

## Міграції: expand / contract / cleanup

microrun не пише міграцій — він запускає ваші команди з образу релізу в одноразовому контейнері
сервісу `migration_service` з його env і змінними `MICRORUN_ENV`, `MICRORUN_RELEASE_COMMIT`,
`MICRORUN_DEPLOYED_AT`, `MICRORUN_ROLLED_BACK_AT` (ISO 8601 UTC).

- **`expand_cmd`** — лише додає: нові таблиці, nullable-колонки, колонки з default, індекси.
  Схема після expand мусить працювати і зі старим, і з новим кодом. Перед production-деплоєм
  microrun проганяє expand на тимчасовій копії схеми й відхиляє деструктивні зміни
  (`SCHEMA_DESTRUCTIVE`) до того, як торкнутися бази.
- **`contract_cmd`** — прибирає старе. microrun запускає його лише тоді, коли всі старші релізи
  вийшли з вікна відкату.
- **`cleanup_cmd`** — необов'язкові правила прибирання даних релізу після відкату. Протокол
  stdout — JSON-рядки, решта рядків іде в лог:
  - `--dry-run` → `{"rule":"<id>","description":"<текст>","count":<n>}`
  - `--apply --rules=<id>,<id>` → `{"rule":"<id>","deleted":<n>}`

Адміністратор бачить кількість записів для кожного правила й підтверджує прибирання в UI.

## Що варто знати

- microrun пише `docker-compose.microrun.yml` поруч із вашими compose-файлами. Ручний
  `docker compose up` без нього поверне образ із compose-файлу, а не активний реліз.
- Доступ до `docker.sock` рівнозначний root на хості — і для вбудованого, і для зовнішнього агента.
- Rolling-заміна вимагає healthcheck і відсутності `container_name` та опублікованих портів у
  сервісу (трафік іде через ваш проксі або вбудований Caddy).
- Вбудований проксі `microrun-proxy` підключається до окремої мережі на кожен compose-проєкт
  (`microrun-proxy-<project>`), тож сервіси різних проєктів не бачать один одного через нього.
- SQLite як база застосунку з rolling: два контейнери пишуть в один файл під час заміни —
  увімкніть WAL у застосунку.
- Старі колонки живуть до кінця вікна відкату — це ціна відкату без DDL.

## Розробка

```sh
pnpm install
pnpm -r build
pnpm test          # unit та інтеграційні
pnpm test:docker   # агент на справжньому Docker
pnpm test:e2e      # Playwright, повний сценарій
```
