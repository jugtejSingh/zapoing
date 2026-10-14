@echo off
cd /d "%~dp0"

call npm run db:migrate
if errorlevel 1 (
	echo Migration failed, not starting the app.
	pause
	exit /b 1
)

npm run dev -- --open
