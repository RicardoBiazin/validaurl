@echo off
chcp 65001 >nul
setlocal

rem ===========================================================================
rem  build.bat   gera dist\ValidaURL.exe (portatil, arquivo unico)
rem  Sempre o python do .venv, nunca o do PATH.
rem ===========================================================================

cd /d "%~dp0"
set "PY=%~dp0.venv\Scripts\python.exe"

if not exist "%PY%" (
    echo ERRO: nao encontrei "%PY%"
    echo Monte o ambiente:  python -m venv .venv  e  .venv\Scripts\python.exe -m pip install -r requirements.txt
    exit /b 1
)

echo === [1/4] Suite de testes ===
"%PY%" -u tests\rodar_todos.py
if errorlevel 1 (
    echo BUILD ABORTADO: a suite falhou.
    exit /b 1
)

echo === [2/4] Icone ===
if not exist recursos\validaurl.ico "%PY%" ferramentas\gerar_icone.py

rem Instancia aberta segura o dist\ValidaURL.exe e o PyInstaller falha no meio.
powershell -NoProfile -NonInteractive -Command "if (Get-Process ValidaURL -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if errorlevel 1 (
    echo BUILD ABORTADO: ha um ValidaURL.exe aberto. Feche e rode de novo.
    exit /b 1
)

echo === [3/4] Empacotando ===
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
"%PY%" -m PyInstaller --noconfirm --clean ValidaURL.spec
if errorlevel 1 (
    echo BUILD ABORTADO: o PyInstaller falhou.
    exit /b 1
)

echo === [4/4] Autoverificacao do executavel ===
if not exist dist\ValidaURL.exe (
    echo ERRO: dist\ValidaURL.exe nao foi gerado.
    exit /b 1
)
dist\ValidaURL.exe --autoverificacao
if errorlevel 1 (
    echo BUILD ABORTADO: o .exe NAO passou na autoverificacao.
    echo Detalhes em %%TEMP%%\validaurl_autoverificacao.log
    exit /b 1
)

echo.
echo BUILD OK: dist\ValidaURL.exe
endlocal
