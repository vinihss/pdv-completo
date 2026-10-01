# Backend CUPS no Linux

O daemon envia ESC/POS para uma fila CUPS usando:

```bash
lp -d NOME_DA_FILA -o raw -
```

O modo `raw` é obrigatório para que o CUPS não aplique filtros que alterem os bytes ESC/POS.

## Configuração

No perfil da impressora:

```json
{
  "transport": "cups",
  "printer_id": "counter-usb",
  "printer_name": "Elgin_MP4200",
  "template": "kitchen-default",
  "status": true
}
```

`printer_name` deve ser o nome da fila CUPS, não necessariamente o nome comercial da impressora.

## Dependências

Ubuntu/Debian:

```bash
sudo apt install cups cups-client
sudo systemctl enable --now cups
lpstat -p
```

A fila deve existir e aceitar jobs RAW. Para criar uma fila USB, use a administração do CUPS ou `lpadmin` conforme o driver disponível. Evite configurar acesso direto a `/dev/usb/lp*` como primeira opção.

## Permissões do serviço

O usuário que executa o daemon precisa conseguir enviar jobs à fila. Em instalações padrão isso normalmente é controlado pelo CUPS e pelo grupo de administração/impressão do sistema. Verifique:

```bash
lpstat -p
lpstat -v
sudo -u pdv-printer lp -d Elgin_MP4200 -o raw /etc/hostname
```

Se a fila exigir autenticação ou ACL, configure a política no CUPS e as credenciais de forma segura; não coloque senha no `config.json`.

## Descoberta

O endpoint usa `lpstat -p`:

```http
GET /api/v1/printers/discover
```

No Linux, as filas descobertas terão `transport: "cups"`.

## Diagnóstico de status

CUPS confirma aceitação/enfileiramento, mas geralmente não expõe sensores ESC/POS DLE EOT. Por isso, o endpoint de status pode retornar `status_supported: false` e `ready: false/unknown`. Isso não deve ser interpretado automaticamente como falta de papel.

O próximo passo, se necessário, é adicionar um diagnóstico CUPS separado com `lpstat -p -l`, `lpstat -o` ou IPP. Isso não substitui o diagnóstico de sensores da impressora.
