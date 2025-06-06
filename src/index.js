// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();
// Importa as dependências
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const { OpenAI } = require('openai');
// Importa os módulos personalizados
const contentManager = require('./contentManager');
const messageHandler = require('./messageHandler');
// Configuração do Express
const app = express();
const PORT = process.env.PORT || 3000;
// Configuração da API da OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
// Configuração do cliente WhatsApp - Configuração específica para Railway
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.SESSION_DATA_PATH || './config/session'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});
// Armazena o contexto das conversas
const conversationContext = {};
// Evento quando o QR code é recebido
client.on('qr', (qr) => {
  console.log('QR RECEBIDO. Escaneie com seu WhatsApp:');
  qrcode.generate(qr, { small: true });
  
  // Salvar o QR code no arquivo de log para acesso posterior
  const logPath = './logs/qr_code.log';
  // Certifique-se de que o diretório de logs existe
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = `[${new Date().toISOString()}] QR: ${qr}\n`;
  fs.appendFileSync(logPath, log);
  console.log('QR code salvo em logs/qr_code.log');
});
// Evento quando o cliente está pronto
client.on('ready', () => {
  console.log('Cliente WhatsApp está pronto!');
  
  // Carrega os conteúdos personalizados
  contentManager.loadContent(process.env.CUSTOM_CONTENT_PATH || './data/content')
    .then(() => {
      console.log('Conteúdos personalizados carregados com sucesso!');
    })
    .catch((error) => {
      console.error('Erro ao carregar conteúdos personalizados:', error);
    });
});
// Evento quando uma mensagem é recebida
client.on('message', async (message) => {
  try {
    // Ignora mensagens de grupos, se necessário
    // if (message.isGroupMsg) return;
    
    console.log(`Mensagem recebida de ${message.from}: ${message.body}`);
    
    // Processa a mensagem e gera uma resposta
    const response = await messageHandler.handleMessage(
      message, 
      conversationContext, 
      openai, 
      contentManager
    );
    
    // Envia a resposta
    await message.reply(response);
    
    console.log(`Resposta enviada para ${message.from}: ${response}`);
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    await message.reply('Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente mais tarde.');
  }
});
// Evento quando o cliente é desconectado
client.on('disconnected', (reason) => {
  console.log('Cliente WhatsApp desconectado:', reason);
  // Tenta reconectar
  client.initialize();
});
// Inicializa o cliente WhatsApp
client.initialize();
// Configura rotas básicas do Express
app.get('/', (req, res) => {
  res.send('Servidor do WhatsApp Bot está rodando!');
});
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    whatsappConnected: client.info ? true : false,
    uptime: process.uptime()
  });
});
// Inicia o servidor Express
app.listen(PORT, () => {
  console.log(`Servidor Express rodando na porta ${PORT}`);
});
// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Promessa rejeitada não tratada:', reason);
});

