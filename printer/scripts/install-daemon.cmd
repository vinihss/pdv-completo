@echo off
rem ============================================================================
rem  Entrada de instalacao do daemon de impressao do PDV para quem nao quer
rem  abrir PowerShell: da dois cliques neste arquivo.
rem 
rem  Por que existe um .cmd na frente do install-windows.ps1:
rem 
rem    * Um duplo clique em arquivo .ps1 abre o Bloco de Notas. O Windows
rem      associa .ps1 ao editor, nao ao PowerShell, entao o caminho "clique e
rem      execute" nao existe para o script.
rem    * A loja que so tem o PWA nao tem nenhum motivo de abrir um terminal.
rem 
rem  O trabalho continua sendo do install-windows.ps1 — este arquivo so pede
rem  elevacao, pergunta o IP da impressora e espera a tela, para a janela nao
rem  fechar antes do tecnico ler o resultado. Nenhuma logica de instalacao
rem  mora aqui; se um dia este .cmd e o .ps1 divergirem, o defeito e deste
rem  arquivo.
rem 
rem  O que NAO esta aqui de proposito: auto-elevacao silenciosa. As tecnicas
rem  (mshta, VBScript, PowerShell) que se re-executam sozinhas com "runas" sao
rem  bloqueadas por metade das politicas de seguranca de loja, e quando falham
rem  o sintoma e "deu um clique e nada aconteceu". Preferimos o gesto de
rem  botao direito, que o Windows sempre explaina e sempre permite.
rem  ============================================================================
setlocal
cd /d "%~dp0"

rem --- privilegios de administrador -----------------------------------------
rem  Duas checagens, e nao uma, porque cada uma tem um caso de falso
rem  negativo diferente — e falso negativo aqui custa um chamado de suporte
rem  ("o Windows diz que nao sou admin, mas eu sou").
rem
rem  1. HKU\S-1-5-19 (o hive do Local Service) so fica montado em processo
rem     elevado. Nao depende de servico nenhum, mas falha se a politica de
rem     grupo bloquear o registro.
rem  2. net session: negacao classica, mas depende do servico Server estar
rem     rodando — numa estacao administrativa ele falha mesmo com admin.
rem
rem  Considerada admin se qualquer uma das duas responder.
reg query "HKU\S-1-5-19" >nul 2>&1
if not errorlevel 1 goto :elevado
net session >nul 2>&1
if not errorlevel 1 goto :elevado
echo.
echo ======================================================================
echo  Nao foi possivel confirmar privilegio de administrador.
echo.
echo  Clique com o botao direito neste arquivo e escolha
echo  "Executar como administrador".
echo.
echo  Sem elevacao nao ha como registrar o servico de impressao:
echo  ele precisa subir com o Windows, e nao com o app aberto.
echo.
echo  Se voce ja escolheu "Executar como administrador" e esta tela
echo  aparece de novo, instale o aplicativo do PDV: ele traz o daemon
echo  junto e nao depende de nenhum dos dois.
echo ======================================================================
echo.
pause
exit /b 1

:elevado

rem --- IP da impressora ------------------------------------------------------
rem  Pergunta porque e a unica informacao que o script nao consegue deduzir,
rem  e porque o daemon de propósito nasce sem endereco: uma instalacao nova
rem  com IP herdado de outra loja manda cupom para o lugar errado.
rem
rem  As tres consequencias ficam em `if` de uma linha, sem bloco parenthesado
rem  e sem goto: dentro de ( ), o cmd le o bloco procurando o fecha-parentese
rem  e um goto que sai no meio faz o resto do arquivo ser lido errado. O
rem  sintoma disso so aparece na maquina do cliente.
set "ENDERECO=192.168.1.50:9100"
echo.
echo  Endereco da impressora da cozinha ^(IP:porta^).
echo  Deixe em branco para usar %ENDERECO%, ou digite "pular" para instalar
echo  e configurar depois.
set "DIGITADO="
set /p "DIGITADO=  > "
if defined DIGITADO if /i not "%DIGITADO%"=="pular" set "ENDERECO=%DIGITADO%"
if /i "%DIGITADO%"=="pular" set "ENDERECO="

rem --- PowerShell ------------------------------------------------------------
where powershell >nul 2>&1
if errorlevel 1 (
    echo.
    echo ======================================================================
    echo  Este computador nao tem PowerShell, e ele e quem instala o
    echo  servico. Instale o "Windows PowerShell" pelo Painel de Controle
    echo  e rode este arquivo de novo.
    echo.
    echo  A alternativa e instalar o aplicativo do PDV, que traz o daemon
    echo  junto e nao depende de PowerShell.
    echo ======================================================================
    echo.
    pause
    exit /b 1
)

rem --- instala ---------------------------------------------------------------
rem -File com caminho entre aspas: o pacote vai ser descompactado em
rem "C:\PDV" ou na pasta de Downloads, que tem espaco no nome.
set "CMD=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1""
if defined ENDERECO set "CMD=%CMD% -PrinterAddress kitchen=%ENDERECO%"

echo.
echo  Instalando o daemon de impressao...
echo.
%CMD%
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo ======================================================================
    echo  A instalacao terminou com erro ^(codigo %RC%^).
    echo.
    echo  As mensagens acima dizem o motivo. Se nao houver nada util,
    echo  veja o log do servico em: Event Viewer ^> Aplicacoes,
    echo  fonte "PDV Impressora".
    echo ======================================================================
) else (
    echo ======================================================================
    echo  Instalacao concluida.
    echo.
    echo  Confira a impressora:
    echo      powershell -NoProfile -Command "Invoke-RestMethod http://127.0.0.1:8080/health"
    echo ======================================================================
)
echo.
echo  A tela vai fechar quando voce pressionar uma tecla.
pause >nul
exit /b %RC%
