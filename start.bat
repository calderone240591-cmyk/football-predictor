@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Футбол Аналітика — локальний сервер
echo  ------------------------------------
echo  На ноутбуці:  http://localhost:8080
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%b in ("%%a") do echo  На айфоні (та сама Wi-Fi):  http://%%b:8080
echo.
echo  Щоб зупинити сервер, закрийте це вікно.
echo.
start "" http://localhost:8080
python -m http.server 8080 --bind 0.0.0.0
