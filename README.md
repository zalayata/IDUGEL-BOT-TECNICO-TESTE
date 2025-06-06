# IAIDUGEL WhatsApp Bot

Bot de WhatsApp integrado com OpenAI para IAIDUGEL, permitindo interações inteligentes com clientes através do WhatsApp.

## Funcionalidades

- Integração com a API da OpenAI para respostas inteligentes
- Gerenciamento de conteúdo personalizado para respostas contextualizadas
- Comandos especiais para gerenciamento da conversa
- Interface web simples para monitoramento do status do bot

## Requisitos

- Node.js 16 ou superior
- Conta no WhatsApp
- Chave de API da OpenAI

## Instalação

1. Clone este repositório
2. Instale as dependências:
   ```
   npm install
   ```
3. Configure as variáveis de ambiente no arquivo `.env`:
   ```
   OPENAI_API_KEY=sua_chave_api_aqui
   OPENAI_MODEL=gpt-3.5-turbo
   BOT_NAME=Assistente IA Idugel
   ```
4. Inicie o bot:
   ```
   npm start
   ```
5. Escaneie o código QR com seu WhatsApp para conectar o bot

## Comandos Disponíveis

- `/ajuda` ou `/help` - Exibe a mensagem de ajuda
- `/limpar` ou `/clear` - Limpa o histórico da conversa
- `/status` - Verifica o status do sistema

## Estrutura do Projeto

- `src/index.js` - Arquivo principal que inicializa o cliente WhatsApp e o servidor Express
- `src/messageHandler.js` - Gerencia o processamento de mensagens e interação com a API da OpenAI
- `src/contentManager.js` - Gerencia o conteúdo personalizado para respostas contextualizadas
- `config/` - Armazena os dados da sessão do WhatsApp
- `data/content/` - Armazena o conteúdo personalizado para o bot

## Personalização de Conteúdo

Você pode adicionar conteúdo personalizado para o bot responder perguntas específicas. Basta adicionar arquivos de texto, PDF ou JSON no diretório `data/content/`.

### Formato JSON recomendado:

```json
[
  {
    "text": "Informação sobre produto X: O produto X é ideal para...",
    "metadata": {
      "categoria": "produtos",
      "prioridade": "alta"
    }
  },
  {
    "text": "Política de devolução: Nossa política permite devoluções em até 7 dias...",
    "metadata": {
      "categoria": "políticas",
      "prioridade": "média"
    }
  }
]
```

## Licença

MIT

