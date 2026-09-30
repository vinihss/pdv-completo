; ============================================================================
; Serviço do daemon de impressão durante a instalação do PDV CAIXA.
;
; O daemon entra junto com o app (sidecar em $INSTDIR) e roda como serviço
; para fora do horário de atendimento: a cozinha precisa imprimir mesmo com o
; app fechado.
;
; Decisões que evitam problema em campo:
;
; 1. O executável é COPIADO de $INSTDIR para $INSTDIR\printer. Um .exe em uso
;    não pode ser sobrescrito, então se o serviço apontasse direto para o
;    sidecar, o update do app falharia ao tentar trocá-lo. Copiando, o update
;    para o serviço, substitui o arquivo e reinicia.
;
; 2. O binPath NÃO leva argumentos. Passar "--config ..." exigiria aspas
;    escapadas (binPath= "\"...exe\" --config \"...json\"") e essa quoting é
;    frágil de escrever. Sem argumento, o daemon acha o config sozinho em
;    %ProgramData%\PDV Printer\config.json (defaultConfigPath).
;
; 3. Nada em %ProgramData% é apagado: config (IP das impressoras) e fila de
;    impressão sobrevivem a reinstalar o app — desinstalar o PDV Caixa não
;    deve desligar a impressora de uma loja que continua usando o sistema.
;
; O que mudou em relação ao `frontend/src-tauri/installer-hooks.nsh` (o app em
; produção, que fica em `frontend/src-tauri` durante a transição):
;
;   - NADA no corpo. Não havia path hardcoded: o sidecar e o destino do serviço
;     são sempre relativos a `$INSTDIR`, e o nome do executável é o que o
;     Tauri gera de `externalBin` + target triple
;     (`pdv-printer-daemon-<triple>.exe`), que é o mesmo nos dois apps.
;   - O nome do serviço e o do display continuam `PDVPrinterDaemon` /
;     "PDV Impressora" DE PROPÓSITO. Uma máquina tem UMA impressora e UM
;     daemon: dois serviços rodando o mesmo binário brigariam pela porta
;     127.0.0.1:8080, e o runbook (`printer/README.md`,
;     `printer/scripts/install-windows.ps1`) documenta esse nome. Enquanto o
;     app antigo e o caixa convivem na mesma loja, o gancho é idempotente e
;     "apaga e recria": o instalador mais recente é quem o serviço passa a
;     apontar, e como o binário é o mesmo, nada muda em campo. Se um dia os
;     dois precisarem de serviços separados, é decisão de produto (impressora
;     por estação) e o impacto em `printer/` precisa ser avaliado junto — não
;     é um !define.
;   - As mensagens de `DetailPrint` dizem "PDV Caixa" para o log do instalador
;     não ficar ambíguo com o do app antigo.
;
; Como usar: macros do template do Tauri 2 (NSIS_HOOK_POSTINSTALL e
; NSIS_HOOK_PREUNINSTALL). O update do app reexecuta este instalador, então
; o mesmo POSTINSTALL cobre instalação nova e atualização.
; ============================================================================

; LogicLib (${If}, ${DoWhile}, ${Errors}) já vem com o template do Tauri — o
; próprio installer.nsi usa ${OrIf}. Não incluímos aqui para não duplicar.

!define PDV_DAEMON_SERVICE "PDVPrinterDaemon"
!define PDV_DAEMON_DISPLAY "PDV Impressora"
!define PDV_DAEMON_DIR "printer"
!define PDV_DAEMON_SIDECAR "pdv-printer-daemon-x86_64-pc-windows-msvc.exe"
!define PDV_DAEMON_EXE "pdv-printer-daemon.exe"

Var PDV_ServiceOk

!macro NSIS_HOOK_POSTINSTALL
  Call PDV_InstallDaemon
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Call un.PDV_StopDaemon
  Call un.PDV_DeleteDaemon
!macroend

; --------------------------------------------------------------------------
; Cópia do binário + registro do serviço. Idempotente: pode rodar várias
; vezes no mesmo boot sem efeito colateral.
; --------------------------------------------------------------------------
Function PDV_InstallDaemon
  StrCpy $PDV_ServiceOk 0

  ; 1. O serviço em execução segura o .exe antigo: para antes de copiar.
  Call PDV_StopDaemon
  Call PDV_DeleteDaemon

  ; 2. Cópia para a pasta própria do daemon.
  CreateDirectory "$INSTDIR\${PDV_DAEMON_DIR}"
  ClearErrors
  CopyFiles "$INSTDIR\${PDV_DAEMON_SIDECAR}" "$INSTDIR\${PDV_DAEMON_DIR}\${PDV_DAEMON_EXE}"
  ${If} ${Errors}
    DetailPrint "PDV Caixa: o daemon de impressão não veio no instalador (${PDV_DAEMON_SIDECAR})."
    DetailPrint "PDV Caixa: a impressão térmica ficará indisponível — reinstale o PDV Caixa."
    Return
  ${EndIf}
  ; O sidecar não deve ficar solto na raiz da instalação.
  Delete "$INSTDIR\${PDV_DAEMON_SIDECAR}"

  ; 3. binPath sem argumento: o daemon resolve o config em %ProgramData%.
  ;    As aspas duplas simples bastam aqui — o sc.exe não precisa de escape.
  ClearErrors
  ExecWait '$SYSDIR\sc.exe create ${PDV_DAEMON_SERVICE} binPath= "$INSTDIR\${PDV_DAEMON_DIR}\${PDV_DAEMON_EXE}" start= auto DisplayName= "${PDV_DAEMON_DISPLAY}"' $0

  ; Logo após um stop/delete o SCM pode responder "marked for deletion" por
  ; algumas centenas de ms: repetir o create resolve.
  StrCpy $1 0
  ${DoWhile} $1 < 10
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    Sleep 1000
    ExecWait '$SYSDIR\sc.exe create ${PDV_DAEMON_SERVICE} binPath= "$INSTDIR\${PDV_DAEMON_DIR}\${PDV_DAEMON_EXE}" start= auto DisplayName= "${PDV_DAEMON_DISPLAY}"' $0
    IntOp $1 $1 + 1
  ${Loop}

  ${If} $0 != 0
    DetailPrint "PDV Caixa: não consegui registrar o serviço de impressora (sc.exe = $0)."
    Return
  ${EndIf}

  ; 4. Se o daemon cair logo depois de subir (impressora desligada, por
  ;    exemplo) o Windows o levanta de novo.
  ExecWait '$SYSDIR\sc.exe failure ${PDV_DAEMON_SERVICE} reset= 86400 actions= restart/5000/restart/5000/restart/10000'
  ExecWait '$SYSDIR\sc.exe start ${PDV_DAEMON_SERVICE}' $0
  ${If} $0 == 0
    StrCpy $PDV_ServiceOk 1
    DetailPrint "PDV Caixa: serviço de impressão instalado e iniciado."
  ${Else}
    DetailPrint "PDV Caixa: serviço registrado, mas não iniciou (sc.exe = $0)."
  ${EndIf}
FunctionEnd

Function PDV_StopDaemon
  ; sc stop devolve 1062 (já parado) ou 1060 (não existe) — os dois são
  ; "não há o que parar".
  ExecWait '$SYSDIR\sc.exe stop ${PDV_DAEMON_SERVICE}' $0
  ${If} $0 == 0
    Sleep 1500
  ${EndIf}
FunctionEnd

Function PDV_DeleteDaemon
  ExecWait '$SYSDIR\sc.exe delete ${PDV_DAEMON_SERVICE}' $0
FunctionEnd

; --------------------------------------------------------------------------
; Mesmas duas operações, agora para o desinstalador.
;
; Não é duplicação por preguiça: o NSIS gera o instalador e o desinstalador
; como stubs separados, e uma função "un.*" não é visível da seção de
; instalação (nem o contrário). Pior: dentro da seção de desinstalação o
; Call só aceita nome começado em "un." — o makensis aborta com "Call must
; be used with function names starting with un. in the uninstall section",
; que é o erro que este arquivo deu no primeiro build de verdade.
;
; O que dá para compartilhar são as !define e o LogicLib: as duas são de
; compilação, não de runtime. O corpo precisa existir dos dois lados.
; --------------------------------------------------------------------------
Function un.PDV_StopDaemon
  ExecWait '$SYSDIR\sc.exe stop ${PDV_DAEMON_SERVICE}' $0
  ${If} $0 == 0
    Sleep 1500
  ${EndIf}
FunctionEnd

Function un.PDV_DeleteDaemon
  ExecWait '$SYSDIR\sc.exe delete ${PDV_DAEMON_SERVICE}' $0
FunctionEnd
