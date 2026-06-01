# Training Library (.NET + SQLite)

Полная C#/.NET версия проекта `coworker_onboarding`.

- База: SQLite (`training.db`)
- API: ASP.NET Core Minimal API (`/api/*`)
- Frontend: статический SPA из `wwwroot/`

## Запуск

Установить .NET SDK 10, затем:

```bash
cd coworker_onboardingdotnet
dotnet restore
dotnet run
```

Открыть: `http://127.0.0.1:8000`

Порт можно изменить переменной окружения:

```bash
set PORT=8080
dotnet run
```

## Примечания

- Пользователь определяется по заголовку `X-User-Email` или полю email в интерфейсе.
- Админ по умолчанию: `admin / admin`.
- Фронтенд перенесен без изменения из исходного проекта.
- Серверная логика переписана с Python на C# с сохранением существующих таблиц и API-контрактов.
