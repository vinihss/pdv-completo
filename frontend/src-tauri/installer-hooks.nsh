; ============================================================================
; Serviço do daemon de impressão durante a instalação do PDV.
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
;    impressão sobrevivem a reinstalar o app — desinstalar o PDV não deve
;    desligar a impressora de uma loja que continua usando o sistema.
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
  Call PDV_StopDaemon
  Call PDV_DeleteDaemon
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
    DetailPrint "PDV: o daemon de impressão não veio no instalador (${PDV_DAEMON_SIDECAR})."
    DetailPrint "PDV: a impressão térmica ficará indisponível — reinstale o PDV."
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
      Break
    ${EndIf}
    Sleep 1000
    ExecWait '$SYSDIR\sc.exe create ${PDV_DAEMON_SERVICE} binPath= "$INSTDIR\${PDV_DAEMON_DIR}\${PDV_DAEMON_EXE}" start= auto DisplayName= "${PDV_DAEMON_DISPLAY}"' $0
    IntOp $1 $1 + 1
  ${Loop}

  ${If} $0 != 0
    DetailPrint "PDV: não consegui registrar o serviço de impressora (sc.exe = $0)."
    Return
  ${EndIf}

  ; 4. Se o daemon cair logo depois de subir (impressora desligada, por
  ;    exemplo) o Windows o levanta de novo.
  ExecWait '$SYSDIR\sc.exe failure ${PDV_DAEMON_SERVICE} reset= 86400 actions= restart/5000/restart/5000/restart/10000'
  ExecWait '$SYSDIR\sc.exe start ${PDV_DAEMON_SERVICE}' $0
  ${If} $0 == 0
    StrCpy $PDV_ServiceOk 1
    DetailPrint "PDV: serviço de impressão instalado e iniciado."
  ${Else}
    DetailPrint "PDV: serviço registrado, mas não iniciou (sc.exe = $0)."
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
