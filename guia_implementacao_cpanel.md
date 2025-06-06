# Guia de Implementação no cPanel

Este documento descreve como implementar o bot de WhatsApp no cPanel, caso seja necessário no futuro.

## Requisitos

- Acesso ao cPanel
- Node.js 16 ou superior disponível no servidor
- Acesso SSH (recomendado)

## Passos para Implementação

### 1. Configurar o Aplicativo Node.js no cPanel

1. Acesse o cPanel e vá para a seção "Setup Node.js App"
2. Clique em "Create Application"
3. Preencha os seguintes campos:
   - Nome da aplicação: `whatsapp-bot`
   - Versão do Node.js: Selecione a versão mais recente disponível
   - Modo: `Development`
   - Arquivo de inicialização: `src/index.js`
4. Clique em "Create"

### 2. Configurar Variáveis de Ambiente

1. Na página de configuração do aplicativo Node.js, vá para a seção "Environment Variables"
2. Adicione as seguintes variáveis:
   ```
   OPENAI_API_KEY=sua_chave_api_aqui
   OPENAI_MODEL=gpt-3.5-turbo
   BOT_NAME=Assistente IA Idugel
   SESSION_DATA_PATH=./config/session.json
   PORT=3000
   CUSTOM_CONTENT_PATH=./data/content
   MAX_CONTEXT_MESSAGES=10
   ```
3. Clique em "Save"

### 3. Fazer Upload dos Arquivos

#### Via Gerenciador de Arquivos do cPanel

1. Acesse o gerenciador de arquivos do cPanel
2. Navegue até a pasta do aplicativo Node.js (geralmente em `/home/username/whatsapp-bot`)
3. Faça upload dos arquivos do projeto

#### Via FTP

1. Conecte-se ao servidor FTP usando suas credenciais
2. Navegue até a pasta do aplicativo Node.js
3. Faça upload dos arquivos do projeto

#### Via SSH (Recomendado)

1. Conecte-se ao servidor via SSH
2. Navegue até a pasta do aplicativo Node.js
3. Clone o repositório ou faça upload dos arquivos usando SCP

### 4. Instalar Dependências

1. Na página de configuração do aplicativo Node.js, clique em "Run NPM Install"
2. Aguarde a instalação das dependências

### 5. Iniciar o Bot

1. Na página de configuração do aplicativo Node.js, clique em "Start"
2. Verifique os logs para garantir que o bot está funcionando corretamente

### 6. Conectar o WhatsApp

1. Verifique os logs para encontrar o código QR
2. Escaneie o código QR com seu WhatsApp para conectar o bot

## Problemas Comuns e Soluções

### Erro de Puppeteer

Se você encontrar erros relacionados ao Puppeteer, como:

```
Error: Failed to launch the browser process!
libatk-bridge-2.0.so.0: cannot open shared object file: No such file or directory
```

Isso ocorre porque o ambiente cPanel compartilhado não possui as bibliotecas necessárias para o Puppeteer funcionar corretamente.

#### Soluções:

1. **Usar um serviço de hospedagem especializado** como Railway, Heroku ou DigitalOcean
2. **Solicitar ao provedor de hospedagem** para instalar as bibliotecas necessárias
3. **Usar um serviço de navegador remoto** como browserless.io

## Recomendação

Recomendamos fortemente o uso do Railway para hospedar o bot de WhatsApp, pois ele oferece um ambiente completo com suporte a Node.js e todas as dependências necessárias para o Puppeteer funcionar corretamente.

