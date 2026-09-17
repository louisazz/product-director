@echo off
echo Looking for process on port 7878...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :7878 ^| findstr LISTENING') do (
    echo Found PID: %%a
    taskkill /F /PID %%a
    echo Stopped.
    goto :done
)

echo No process found on port 7878.
:done
pause
