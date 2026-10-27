# Royalty Lab

Десктопная программа (Windows / macOS) для роялти-учёта лейбла. Electron + TypeScript + React, база — зашифрованная SQLite.

## Этап 1
Зашифрованная база, вход по паролю (владелец / бухгалтер), карточки людей, артистов и треков, проверка долей, вкладка «Проблемы», загрузка стартовой базы.

## Сборка
- Проверки: любой push в `main` (typecheck, тесты, сборка).
- Релиз: тег вида `v0.9.0` → GitHub Actions собирает `.exe` (NSIS) и `.dmg` и кладёт в Releases.

```
git tag v0.9.0 && git push origin v0.9.0
```

## Локально
```
npm install
npm test
npm run dev
```
Данные лежат в `%APPDATA%/RoyaltyLab` (Windows) или `~/Library/Application Support/RoyaltyLab` (Mac). В репозиторий они не попадают.
