@echo off
rem Golf navi: edit course data on this PC (opens the editor in the browser)
chcp 65001 > nul
cd /d "%~dp0"
where python > nul 2> nul
if %errorlevel%==0 (
  python tools\pcedit.py
) else (
  py tools\pcedit.py
)
pause
