@echo off
cd /d C:\Users\zacka\autopitch-ai
git add -A
git commit -m "auto: deploy"
if errorlevel 1 echo No changes to commit.
git push origin main
pause
