require('dotenv').config();

if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

// ===== VERSÃO MULTIMODAL - ÁUDIO + IMAGENS + TEXTO =====

const THREADS_FILE = './threadMap.json';
const LOG_FILE = './idugel-conversations.log';
const MEDIA_DIR = './media_temp';

// Criar diretório para arquivos temporários de mídia
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Sistema de Logs Avançado
class ConversationLogger {
    constructor() {
        this.ensureLogFile();
    }

    ensureLogFile() {
        if (!fs.existsSync(LOG_FILE)) {
            fs.writeFileSync(LOG_FILE, '# IDUGEL WhatsApp Bot - Log de Conversas\n# Iniciado em: ' + new Date().toISOString() + '\n\n');
        }
    }

    log(type, data) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            type,
            ...data
        };

        // Log no console (colorido)
        const colors = {
            'CONVERSATION': '\x1b[36m', // Cyan
            'THREAD': '\x1b[33m',       // Yellow
            'ERROR': '\x1b[31m',        // Red
            'SUCCESS': '\x1b[32m',      // Green
            'INFO': '\x1b[34m',         // Blue
            'MEDIA': '\x1b[35m'         // Magenta
        };
        
        const color = colors[type] || '\x1b[0m';
        const reset = '\x1b[0m';
        
        console.log(`${color}[${type}]${reset} ${timestamp}`);
        console.log(JSON.stringify(data, null, 2));

        // Log no arquivo
        try {
            const fileEntry = `\n[${timestamp}] ${type}\n${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
            fs.appendFileSync(LOG_FILE, fileEntry);
        } catch (err) {
            console.error('❌ Erro ao salvar log:', err);
        }
    }

    logConversation(user, question, answer, threadId, processingTime, mediaType = 'text') {
        this.log('CONVERSATION', {
            user: user.replace('@s.whatsapp.net', ''),
            question,
            answer: answer.substring(0, 500) + (answer.length > 500 ? '...' : ''),
            answer_length: answer.length,
            thread_id: threadId,
            processing_time_ms: processingTime,
            processing_time_readable: `${(processingTime / 1000).toFixed(2)}s`,
            media_type: mediaType
        });
    }

    logMedia(action, user, mediaType, details = {}) {
        this.log('MEDIA', {
            action,
            user: user.replace('@s.whatsapp.net', ''),
            media_type: mediaType,
            ...details
        });
    }

    logThread(action, user, threadId, details = {}) {
        this.log('THREAD', {
            action,
            user: user.replace('@s.whatsapp.net', ''),
            thread_id: threadId,
            ...details
        });
    }

    logError(error, context = {}) {
        this.log('ERROR', {
            message: error.message,
            stack: error.stack,
            context
        });
    }

    logSuccess(message, details = {}) {
        this.log('SUCCESS', {
            message,
            ...details
        });
    }

    logInfo(message, details = {}) {
        this.log('INFO', {
            message,
            ...details
        });
    }

    // Método para gerar relatório de estatísticas
    generateStats() {
        try {
            if (!fs.existsSync(LOG_FILE)) return null;
            
            const logContent = fs.readFileSync(LOG_FILE, 'utf-8');
            const conversations = (logContent.match(/\[CONVERSATION\]/g) || []).length;
            const errors = (logContent.match(/\[ERROR\]/g) || []).length;
            const threads = (logContent.match(/\[THREAD\]/g) || []).length;
            const media = (logContent.match(/\[MEDIA\]/g) || []).length;
            
            return {
                total_conversations: conversations,
                total_errors: errors,
                total_thread_operations: threads,
                total_media_processed: media,
                log_file_size: `${(fs.statSync(LOG_FILE).size / 1024).toFixed(2)} KB`,
                last_updated: new Date().toISOString()
            };
        } catch (err) {
            return { error: err.message };
        }
    }
}

const logger = new ConversationLogger();

// Função para limpar citações das respostas da IA (VERSÃO CORRIGIDA)
function removeCitations(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    
    let cleanText = text;
    
    // 1. Remove citações específicas da OpenAI no formato 【número†source】
    cleanText = cleanText.replace(/【\d+†source】/g, '');
    
    // 2. Remove citações no formato 【número】, 【número:número】, etc.
    cleanText = cleanText.replace(/【[^】]*】/g, '');
    
    // 3. Remove citações no formato [número], [número:número], etc. (mas preserva links markdown)
    cleanText = cleanText.replace(/\[[0-9]+(?::[0-9]+)?\]/g, '');
    
    // 4. Remove citações no formato (número), (número:número), etc.
    cleanText = cleanText.replace(/\([0-9]+(?::[0-9]+)?\)/g, '');
    
    // 5. Converte links markdown para links diretos (preserva funcionalidade)
    // [texto](https://link.com) → https://link.com
    cleanText = cleanText.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2');
    
    // 6. Remove linhas que começam com "Sources:" ou "Fontes:"
    cleanText = cleanText.replace(/^(Sources?|Fontes?):\s*.*$/gmi, '');
    
    // 7. Remove múltiplos espaços e quebras de linha (mas preserva estrutura)
    cleanText = cleanText.replace(/\s+/g, ' ').trim();
    
    // 8. NÃO remove URLs válidos - eles devem permanecer funcionais
    
    return cleanText.trim();
}

// Função para garantir que SEMPRE seja string
function forceString(input) {
    if (input === null || input === undefined) {
        return null;
    }
    
    // Se já é string, retorna
    if (typeof input === 'string') {
        return input.trim();
    }
    
    // Se é objeto com propriedade id
    if (typeof input === 'object' && input.id) {
        return String(input.id).trim();
    }
    
    // Força conversão para string
    return String(input).trim();
}

// Função para validar thread ID
function isValidThreadId(threadId) {
    if (!threadId || typeof threadId !== 'string') {
        return false;
    }
    return /^thread_[a-zA-Z0-9_-]+$/.test(threadId);
}

// Função para processar imagem com GPT-4 Vision
async function processImageWithVision(imagePath, userMessage = '') {
    try {
        logger.logInfo('Processando imagem com GPT-4 Vision', { 
            image_path: imagePath,
            user_message: userMessage 
        });

        // Ler a imagem e converter para base64
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';

        const response = await openai.chat.completions.create({
            model: "gpt-4-vision-preview",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: userMessage || "Analise esta imagem e descreva o que você vê de forma detalhada e útil."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:${mimeType};base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000
        });

        const analysis = response.choices[0].message.content;
        logger.logSuccess('Imagem processada com sucesso', {
            analysis_length: analysis.length
        });

        return analysis;
    } catch (error) {
        logger.logError(error, { context: 'processImageWithVision', image_path: imagePath });
        throw error;
    }
}

// Função para processar áudio com Whisper
async function processAudioWithWhisper(audioPath) {
    try {
        logger.logInfo('Processando áudio com Whisper', { 
            audio_path: audioPath 
        });

        const response = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            language: "pt"
        });

        const transcription = response.text;
        logger.logSuccess('Áudio transcrito com sucesso', {
            transcription_length: transcription.length,
            transcription: transcription.substring(0, 200) + (transcription.length > 200 ? '...' : '')
        });

        return transcription;
    } catch (error) {
        logger.logError(error, { context: 'processAudioWithWhisper', audio_path: audioPath });
        throw error;
    }
}

// Função para baixar mídia do WhatsApp
async function downloadWhatsAppMedia(message, messageType) {
    try {
        const mediaData = await downloadMediaMessage(message, 'buffer', {});
        
        // Determinar extensão baseada no tipo
        let extension = '.bin';
        if (messageType === 'imageMessage') {
            extension = message.message.imageMessage.mimetype === 'image/png' ? '.png' : '.jpg';
        } else if (messageType === 'audioMessage') {
            extension = '.ogg'; // WhatsApp usa OGG para áudio
        }

        // Criar nome único para o arquivo
        const fileName = `media_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${extension}`;
        const filePath = path.join(MEDIA_DIR, fileName);

        // Salvar arquivo
        fs.writeFileSync(filePath, mediaData);
        
        logger.logMedia('DOWNLOAD', message.key.remoteJid, messageType, {
            file_path: filePath,
            file_size: `${(mediaData.length / 1024).toFixed(2)} KB`
        });

        return filePath;
    } catch (error) {
        logger.logError(error, { context: 'downloadWhatsAppMedia', messageType });
        throw error;
    }
}

// Função para limpar arquivos temporários
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logger.logInfo('Arquivo temporário removido', { file_path: filePath });
        }
    } catch (error) {
        logger.logError(error, { context: 'cleanupTempFile', file_path: filePath });
    }
}

// Classe ThreadManager ultra-segura
class ThreadManager {
    constructor() {
        this.threads = new Map();
        this.loadFromDisk();
    }

    loadFromDisk() {
        try {
            if (fs.existsSync(THREADS_FILE)) {
                const data = fs.readFileSync(THREADS_FILE, 'utf-8');
                const parsed = JSON.parse(data);
                
                // Limpa TUDO e reconstrói
                this.threads.clear();
                
                for (const [key, value] of Object.entries(parsed)) {
                    const cleanId = forceString(value);
                    if (isValidThreadId(cleanId)) {
                        this.threads.set(key, cleanId);
                    }
                }
                
                this.saveToDisk();
                logger.logInfo('ThreadManager: Dados carregados e validados', { 
                    threads_loaded: this.threads.size 
                });
            }
        } catch (err) {
            logger.logError(err, { context: 'ThreadManager.loadFromDisk' });
            this.threads.clear();
        }
    }

    saveToDisk() {
        try {
            const obj = {};
            for (const [key, value] of this.threads.entries()) {
                obj[key] = forceString(value);
            }
            fs.writeFileSync(THREADS_FILE, JSON.stringify(obj, null, 2));
        } catch (err) {
            logger.logError(err, { context: 'ThreadManager.saveToDisk' });
        }
    }

    getThreadId(userId) {
        const raw = this.threads.get(userId);
        const clean = forceString(raw);
        
        if (isValidThreadId(clean)) {
            logger.logThread('GET_EXISTING', userId, clean);
            return clean;
        }
        
        logger.logThread('NOT_FOUND', userId, null);
        return null;
    }

    setThreadId(userId, threadId) {
        const clean = forceString(threadId);
        
        if (isValidThreadId(clean)) {
            this.threads.set(userId, clean);
            this.saveToDisk();
            logger.logThread('CREATE_NEW', userId, clean);
            return clean;
        }
        
        const error = new Error(`ThreadId inválido: ${threadId} -> ${clean}`);
        logger.logError(error, { context: 'ThreadManager.setThreadId', userId, threadId });
        throw error;
    }

    removeThreadId(userId) {
        const threadId = this.threads.get(userId);
        this.threads.delete(userId);
        this.saveToDisk();
        logger.logThread('REMOVE_CORRUPTED', userId, threadId);
    }
}

const threadManager = new ThreadManager();

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let connectionStatus = 'Iniciando...';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const authDir = process.env.SESSION_DATA_PATH || './config/session';
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Configurar pasta public para servir arquivos estáticos
app.use(express.static(path.join(__dirname, '../public')));

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: {
            level: 'silent',
            info: () => {},
            error: () => {},
            warn: () => {},
            debug: () => {},
            trace: () => {},
            child: () => ({
                info: () => {},
                error: () => {},
                warn: () => {},
                debug: () => {},
                trace: () => {},
            })
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            connectionStatus = 'QR Code gerado - Escaneie na página web';
            logger.logInfo('QR Code gerado', { status: connectionStatus });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'Conexão fechada - Reconectando...';
            currentQR = null;
            
            logger.logInfo('Conexão fechada', { 
                error: lastDisconnect?.error?.message,
                will_reconnect: shouldReconnect 
            });
            
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        } else if (connection === 'open') {
            connectionStatus = 'Conectado e funcionando!';
            currentQR = null;
            logger.logSuccess('WhatsApp conectado com sucesso');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const message = m.messages[0];
        if (!message.message || message.key.fromMe) return;

        const from = message.key.remoteJid;
        
        // Detectar tipo de mensagem
        const messageTypes = Object.keys(message.message);
        const messageType = messageTypes[0];

        logger.logInfo('Nova mensagem recebida', {
            from: from.replace('@s.whatsapp.net', ''),
            message_type: messageType,
            timestamp: new Date().toISOString()
        });

        try {
            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                // Mensagem de texto normal
                const messageText = message.message.conversation || message.message.extendedTextMessage?.text || '';
                
                if (messageText.toLowerCase() === 'oi' || messageText.toLowerCase() === 'hello') {
                    const response = 'Olá! Eu sou a IA do Grupo Idugel. Como posso ajudá-lo?\n\n🎯 *Funcionalidades:*\n📝 Respondo perguntas em texto\n🖼️ Analiso imagens que você enviar\n🎵 Transcrevo áudios para texto\n\nEnvie sua pergunta, foto ou áudio!';
                    await sock.sendMessage(from, { text: response });
                    logger.logConversation(from, messageText, response, 'greeting', 0);
                } else if (messageText.toLowerCase().includes('teste')) {
                    const response = '✅ IA Idugel funcionando!\n\n🚀 *Recursos Ativos:*\n📝 Processamento de texto\n🖼️ Análise de imagens (GPT-4 Vision)\n🎵 Transcrição de áudio (Whisper)\n🧠 Sistema de memória por usuário';
                    await sock.sendMessage(from, { text: response });
                    logger.logConversation(from, messageText, response, 'test', 0);
                } else if (messageText.trim()) {
                    await processAIMessage(from, messageText, 'text');
                }
            } else if (messageType === 'imageMessage') {
                // Mensagem com imagem
                await processMediaMessage(message, from, 'image');
            } else if (messageType === 'audioMessage') {
                // Mensagem com áudio
                await processMediaMessage(message, from, 'audio');
            } else {
                // Tipo de mensagem não suportado
                await sock.sendMessage(from, { 
                    text: '🤖 Desculpe, ainda não consigo processar este tipo de mídia.\n\n✅ *Tipos suportados:*\n📝 Texto\n🖼️ Imagens (JPG, PNG)\n🎵 Áudios\n\nEnvie um desses tipos para eu poder ajudar!' 
                });
            }
        } catch (error) {
            logger.logError(error, { 
                context: 'message_handler',
                from: from.replace('@s.whatsapp.net', ''),
                message_type: messageType
            });
            
            await sock.sendMessage(from, { 
                text: '❌ Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente em alguns segundos.' 
            });
        }
    });
}

// Função para processar mensagens de mídia
async function processMediaMessage(message, from, mediaType) {
    const startTime = Date.now();
    let tempFilePath = null;
    
    try {
        // Baixar mídia
        const messageTypeKey = mediaType === 'image' ? 'imageMessage' : 'audioMessage';
        tempFilePath = await downloadWhatsAppMedia(message, messageTypeKey);
        
        let processedContent = '';
        let userMessage = '';
        
        if (mediaType === 'image') {
            // Verificar se há texto junto com a imagem
            userMessage = message.message.imageMessage.caption || '';
            
            // Processar imagem com GPT-4 Vision
            processedContent = await processImageWithVision(tempFilePath, userMessage);
            
            logger.logMedia('PROCESS_IMAGE', from, 'image', {
                caption: userMessage,
                analysis_length: processedContent.length
            });
            
        } else if (mediaType === 'audio') {
            // Transcrever áudio com Whisper
            const transcription = await processAudioWithWhisper(tempFilePath);
            
            if (transcription.trim()) {
                // Processar transcrição como mensagem de texto
                await processAIMessage(from, transcription, 'audio');
                return; // Sair aqui pois processAIMessage já enviará a resposta
            } else {
                processedContent = '🎵 Recebi seu áudio, mas não consegui transcrever o conteúdo. Pode tentar enviar novamente?';
            }
            
            logger.logMedia('PROCESS_AUDIO', from, 'audio', {
                transcription: transcription.substring(0, 200) + (transcription.length > 200 ? '...' : ''),
                transcription_length: transcription.length
            });
        }
        
        // Enviar resposta
        if (processedContent) {
            await sock.sendMessage(from, { text: processedContent });
            
            const processingTime = Date.now() - startTime;
            logger.logConversation(from, `[${mediaType.toUpperCase()}] ${userMessage}`, processedContent, 'direct_media', processingTime, mediaType);
        }
        
    } catch (error) {
        logger.logError(error, { 
            context: 'processMediaMessage',
            from: from.replace('@s.whatsapp.net', ''),
            media_type: mediaType
        });
        
        await sock.sendMessage(from, { 
            text: `❌ Desculpe, ocorreu um erro ao processar ${mediaType === 'image' ? 'sua imagem' : 'seu áudio'}. Tente novamente.` 
        });
    } finally {
        // Limpar arquivo temporário
        if (tempFilePath) {
            cleanupTempFile(tempFilePath);
        }
    }
}

// Função para criar thread com validação extrema
async function createNewThread() {
    const response = await openai.beta.threads.create();
    
    if (!response || !response.id) {
        throw new Error('Resposta inválida da criação de thread');
    }
    
    const threadId = forceString(response.id);
    
    if (!isValidThreadId(threadId)) {
        throw new Error(`Thread ID inválido criado: ${threadId}`);
    }
    
    return threadId;
}

// Função para adicionar mensagem com validação extrema
async function addMessageToThread(threadId, messageText) {
    const cleanThreadId = forceString(threadId);
    
    if (!isValidThreadId(cleanThreadId)) {
        throw new Error(`Thread ID inválido para mensagem: ${cleanThreadId}`);
    }
    
    const result = await openai.beta.threads.messages.create(
        cleanThreadId,
        {
            role: 'user',
            content: String(messageText)
        }
    );
    
    return result;
}

// Função para criar run com validação extrema
async function createRun(threadId) {
    const cleanThreadId = forceString(threadId);
    
    if (!isValidThreadId(cleanThreadId)) {
        throw new Error(`Thread ID inválido para run: ${cleanThreadId}`);
    }
    
    const run = await openai.beta.threads.runs.create(
        cleanThreadId,
        {
            assistant_id: String(process.env.OPENAI_ASSISTANT_ID)
        }
    );
    
    return run;
}

// Função para recuperar status do run
async function retrieveRunStatus(threadId, runId) {
    const cleanThreadId = forceString(threadId);
    const cleanRunId = forceString(runId);
    
    if (!isValidThreadId(cleanThreadId)) {
        throw new Error(`Thread ID inválido para status: ${cleanThreadId}`);
    }
    
    return await openai.beta.threads.runs.retrieve(cleanThreadId, cleanRunId);
}

// Função para listar mensagens
async function listMessages(threadId) {
    const cleanThreadId = forceString(threadId);
    
    if (!isValidThreadId(cleanThreadId)) {
        throw new Error(`Thread ID inválido para listar: ${cleanThreadId}`);
    }
    
    return await openai.beta.threads.messages.list(cleanThreadId);
}

// Função principal de processamento (atualizada para suportar diferentes tipos)
async function processAIMessage(from, messageText, sourceType = 'text') {
    const startTime = Date.now();
    
    try {
        logger.logInfo(`Processando mensagem ${sourceType.toUpperCase()}`, {
            from: from.replace('@s.whatsapp.net', ''),
            message: messageText.substring(0, 200) + (messageText.length > 200 ? '...' : ''),
            source_type: sourceType
        });
        
        // Busca thread existente
        let threadId = threadManager.getThreadId(from);
        
        // Se não existe, cria nova
        if (!threadId) {
            threadId = await createNewThread();
            threadId = threadManager.setThreadId(from, threadId);
        }

        // Validação final antes de usar
        if (!isValidThreadId(threadId)) {
            throw new Error(`Thread ID final inválido: ${threadId}`);
        }

        // Adiciona mensagem
        await addMessageToThread(threadId, messageText);

        // Cria run
        const run = await createRun(threadId);

        // Aguarda conclusão
        let result = null;
        let attempts = 0;
        const maxAttempts = 30;

        while (attempts < maxAttempts) {
            const status = await retrieveRunStatus(threadId, run.id);

            if (status.status === 'completed') {
                const messages = await listMessages(threadId);
                
                const lastMessage = messages.data[0];
                if (lastMessage && lastMessage.content[0] && lastMessage.content[0].text) {
                    result = lastMessage.content[0].text.value;
                    
                    // Aplicar filtro de citações
                    const originalLength = result.length;
                    result = removeCitations(result);
                    
                    logger.logInfo('Citações removidas', {
                        original_length: originalLength,
                        cleaned_length: result.length,
                        citations_removed: originalLength - result.length
                    });
                    
                    break;
                }
            } else if (status.status === 'failed' || status.status === 'cancelled') {
                throw new Error(`Run falhou: ${status.status}`);
            }

            attempts++;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (result) {
            // Adicionar prefixo baseado no tipo de fonte
            let responsePrefix = '';
            if (sourceType === 'audio') {
                responsePrefix = '🎵 *Transcrição do áudio:* "' + messageText + '"\n\n';
            }
            
            const finalResponse = responsePrefix + result;
            await sock.sendMessage(from, { text: finalResponse });
            
            const processingTime = Date.now() - startTime;
            logger.logConversation(from, messageText, finalResponse, threadId, processingTime, sourceType);
            logger.logSuccess('Resposta enviada com sucesso', {
                user: from.replace('@s.whatsapp.net', ''),
                processing_time: `${(processingTime / 1000).toFixed(2)}s`,
                source_type: sourceType
            });
        } else {
            throw new Error('Timeout: Run não completou no tempo esperado');
        }

    } catch (error) {
        threadManager.removeThreadId(from);
        logger.logError(error, { 
            context: 'processAIMessage',
            user: from.replace('@s.whatsapp.net', ''),
            message: messageText,
            source_type: sourceType
        });
        
        await sock.sendMessage(from, { 
            text: 'Desculpe, estou com dificuldades técnicas.\nErro: ' + error.message + '\n\nTente novamente em alguns segundos.' 
        });
    }
}

// Rota para ver estatísticas
app.get('/stats', (req, res) => {
    const stats = logger.generateStats();
    res.json(stats);
});

// Rota para baixar logs
app.get('/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) {
        res.download(LOG_FILE, 'idugel-conversations.log');
    } else {
        res.status(404).json({ error: 'Log file not found' });
    }
});

// Servidor web para mostrar QR Code com identidade visual do Grupo Idugel
app.get('/', (req, res) => {
    if (currentQR) {
        qrcode.generate(currentQR, { small: true }, (qr) => {
            res.send(`
                <!DOCTYPE html>
                <html lang="pt-BR">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>IA WhatsApp Bot - Grupo Idugel</title>
                    <style>
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }
                        
                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            min-height: 100vh;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            color: #333;
                            padding: 20px;
                        }
                        
                        .container {
                            background: rgba(255, 255, 255, 0.95);
                            border-radius: 20px;
                            padding: 40px;
                            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                            text-align: center;
                            max-width: 600px;
                            width: 100%;
                            backdrop-filter: blur(10px);
                        }
                        
                        .logo {
                            width: 120px;
                            height: 120px;
                            border-radius: 50%;
                            margin: 0 auto 30px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            overflow: hidden;
                            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                            border: 4px solid white;
                        }
                        
                        .logo img {
                            width: 100%;
                            height: 100%;
                            object-fit: cover;
                            border-radius: 50%;
                        }
                        
                        h1 {
                            color: #2c3e50;
                            margin-bottom: 10px;
                            font-size: 2.2em;
                            font-weight: 700;
                        }
                        
                        .subtitle {
                            color: #7f8c8d;
                            margin-bottom: 30px;
                            font-size: 1.1em;
                            line-height: 1.6;
                        }
                        
                        .status {
                            background: linear-gradient(45deg, #27ae60, #2ecc71);
                            color: white;
                            padding: 15px 25px;
                            border-radius: 50px;
                            margin-bottom: 30px;
                            font-weight: 600;
                            font-size: 1.1em;
                            box-shadow: 0 5px 15px rgba(46, 204, 113, 0.3);
                        }
                        
                        .qr-section {
                            background: #f8f9fa;
                            border-radius: 15px;
                            padding: 30px;
                            margin: 30px 0;
                            border: 3px dashed #667eea;
                        }
                        
                        .qr-title {
                            color: #2c3e50;
                            margin-bottom: 20px;
                            font-size: 1.4em;
                            font-weight: 600;
                        }
                        
                        .qr-code {
                            font-family: 'Courier New', monospace;
                            font-size: 8px;
                            line-height: 8px;
                            background: white;
                            padding: 20px;
                            border-radius: 10px;
                            margin: 20px 0;
                            box-shadow: inset 0 2px 5px rgba(0,0,0,0.1);
                            white-space: pre;
                            overflow: auto;
                        }
                        
                        .instructions {
                            color: #34495e;
                            font-size: 1em;
                            line-height: 1.6;
                            margin-top: 20px;
                        }
                        
                        .tech-info {
                            background: linear-gradient(45deg, #3498db, #2980b9);
                            color: white;
                            padding: 25px;
                            border-radius: 15px;
                            margin-top: 30px;
                            text-align: left;
                        }
                        
                        .tech-title {
                            font-size: 1.3em;
                            font-weight: 600;
                            margin-bottom: 15px;
                            text-align: center;
                        }
                        
                        .tech-features {
                            list-style: none;
                            padding: 0;
                        }
                        
                        .tech-features li {
                            padding: 8px 0;
                            border-bottom: 1px solid rgba(255,255,255,0.2);
                        }
                        
                        .tech-features li:last-child {
                            border-bottom: none;
                        }
                        
                        .tech-features li::before {
                            content: "🚀 ";
                            margin-right: 10px;
                        }
                        
                        .footer {
                            margin-top: 30px;
                            color: #7f8c8d;
                            font-size: 0.9em;
                        }
                        
                        .refresh-note {
                            background: #fff3cd;
                            color: #856404;
                            padding: 15px;
                            border-radius: 10px;
                            margin-top: 20px;
                            border-left: 4px solid #ffc107;
                        }
                        
                        .admin-links {
                            margin-top: 20px;
                            display: flex;
                            gap: 10px;
                            justify-content: center;
                            flex-wrap: wrap;
                        }
                        
                        .admin-links a {
                            background: linear-gradient(45deg, #667eea, #764ba2);
                            color: white;
                            padding: 8px 16px;
                            border-radius: 20px;
                            text-decoration: none;
                            font-size: 0.9em;
                            transition: transform 0.3s ease;
                        }
                        
                        .admin-links a:hover {
                            transform: translateY(-2px);
                        }
                        
                        @media (max-width: 768px) {
                            .container {
                                padding: 20px;
                                margin: 10px;
                            }
                            
                            h1 {
                                font-size: 1.8em;
                            }
                            
                            .logo {
                                width: 80px;
                                height: 80px;
                            }
                        }
                        
                        .pulse {
                            animation: pulse 2s infinite;
                        }
                        
                        @keyframes pulse {
                            0% { transform: scale(1); }
                            50% { transform: scale(1.05); }
                            100% { transform: scale(1); }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="logo pulse">
                            <img src="/logo-idugel.jpg" alt="Logo Grupo Idugel" onerror="this.style.display='none'; this.parentNode.innerHTML='<div style=\\'background: linear-gradient(45deg, #667eea, #764ba2); width: 100%; height: 100%; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: bold; color: white; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);\\'>IG</div>';" />
                        </div>
                        
                        <h1>🤖 IA WhatsApp Bot</h1>
                        <div class="subtitle">
                            Assistente Inteligente <strong>MULTIMODAL</strong> desenvolvido pelo <strong>Grupo Idugel</strong><br>
                            Tecnologia avançada de IA para atendimento automatizado
                        </div>
                        
                        <div class="status">
                            📡 Status: ${connectionStatus}
                        </div>
                        
                        <div class="qr-section">
                            <div class="qr-title">📱 Escaneie o QR Code para conectar</div>
                            <div class="qr-code">${qr}</div>
                            <div class="instructions">
                                <strong>Como conectar:</strong><br>
                                1. Abra o WhatsApp no seu celular<br>
                                2. Toque em "Dispositivos conectados"<br>
                                3. Toque em "Conectar um dispositivo"<br>
                                4. Aponte a câmera para o QR Code acima
                            </div>
                        </div>
                        
                        <div class="tech-info">
                            <div class="tech-title">🔧 Tecnologia Grupo Idugel - MULTIMODAL</div>
                            <ul class="tech-features">
                                <li><strong>IA Avançada:</strong> Processamento inteligente de linguagem natural</li>
                                <li><strong>GPT-4 Vision:</strong> Análise inteligente de imagens e fotos</li>
                                <li><strong>Whisper AI:</strong> Transcrição precisa de áudios para texto</li>
                                <li><strong>Integração OpenAI:</strong> Powered by GPT-4 para respostas precisas</li>
                                <li><strong>Arquitetura Robusta:</strong> Sistema ultra-confiável e escalável</li>
                                <li><strong>Segurança:</strong> Validação rigorosa e proteção de dados</li>
                                <li><strong>Disponibilidade 24/7:</strong> Atendimento automatizado contínuo</li>
                                <li><strong>Multi-thread:</strong> Gerenciamento inteligente de conversas</li>
                                <li><strong>Filtro Inteligente:</strong> Respostas limpas sem citações desnecessárias</li>
                                <li><strong>Sistema de Logs:</strong> Monitoramento completo de conversas e mídia</li>
                            </ul>
                        </div>
                        
                        <div class="admin-links">
                            <a href="/stats" target="_blank">📊 Estatísticas</a>
                            <a href="/logs" target="_blank">📋 Download Logs</a>
                        </div>
                        
                        <div class="refresh-note">
                            💡 <strong>Dica:</strong> Esta página atualiza automaticamente a cada 30 segundos<br>
                            🎯 <strong>Novo:</strong> Agora o bot processa texto, imagens e áudios!
                        </div>
                        
                        <div class="footer">
                            <strong>Grupo Idugel</strong> - Inovação em Tecnologia e IA<br>
                            © 2024 - Todos os direitos reservados
                        </div>
                    </div>
                    
                    <script>
                        // Auto-refresh a cada 30 segundos
                        setTimeout(() => location.reload(), 30000);
                        
                        // Adiciona efeito de hover nos elementos
                        document.querySelectorAll('.tech-features li').forEach(item => {
                            item.addEventListener('mouseenter', function() {
                                this.style.transform = 'translateX(10px)';
                                this.style.transition = 'transform 0.3s ease';
                            });
                            
                            item.addEventListener('mouseleave', function() {
                                this.style.transform = 'translateX(0)';
                            });
                        });
                    </script>
                </body>
                </html>
            `);
        });
    } else {
        res.send(`
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>IA WhatsApp Bot - Grupo Idugel</title>
                <style>
                    * {
                        margin: 0;
                        padding: 0;
                        box-sizing: border-box;
                    }
                    
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        min-height: 100vh;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        color: #333;
                        padding: 20px;
                    }
                    
                    .container {
                        background: rgba(255, 255, 255, 0.95);
                        border-radius: 20px;
                        padding: 40px;
                        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                        text-align: center;
                        max-width: 600px;
                        width: 100%;
                        backdrop-filter: blur(10px);
                    }
                    
                    .logo {
                        width: 120px;
                        height: 120px;
                        border-radius: 50%;
                        margin: 0 auto 30px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        overflow: hidden;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                        border: 4px solid white;
                    }
                    
                    .logo img {
                        width: 100%;
                        height: 100%;
                        object-fit: cover;
                        border-radius: 50%;
                    }
                    
                    h1 {
                        color: #2c3e50;
                        margin-bottom: 10px;
                        font-size: 2.2em;
                        font-weight: 700;
                    }
                    
                    .subtitle {
                        color: #7f8c8d;
                        margin-bottom: 30px;
                        font-size: 1.1em;
                        line-height: 1.6;
                    }
                    
                    .status {
                        background: linear-gradient(45deg, #f39c12, #e67e22);
                        color: white;
                        padding: 15px 25px;
                        border-radius: 50px;
                        margin-bottom: 30px;
                        font-weight: 600;
                        font-size: 1.1em;
                        box-shadow: 0 5px 15px rgba(243, 156, 18, 0.3);
                    }
                    
                    .loading {
                        display: inline-block;
                        width: 40px;
                        height: 40px;
                        border: 4px solid #f3f3f3;
                        border-top: 4px solid #667eea;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                        margin: 20px 0;
                    }
                    
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    
                    .footer {
                        margin-top: 30px;
                        color: #7f8c8d;
                        font-size: 0.9em;
                    }
                    
                    .pulse {
                        animation: pulse 2s infinite;
                    }
                    
                    @keyframes pulse {
                        0% { transform: scale(1); }
                        50% { transform: scale(1.05); }
                        100% { transform: scale(1); }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="logo pulse">
                        <img src="/logo-idugel.jpg" alt="Logo Grupo Idugel" onerror="this.style.display='none'; this.parentNode.innerHTML='<div style=\\'background: linear-gradient(45deg, #667eea, #764ba2); width: 100%; height: 100%; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: bold; color: white; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);\\'>IG</div>';" />
                    </div>
                    
                    <h1>🤖 IA WhatsApp Bot</h1>
                    <div class="subtitle">
                        Assistente Inteligente <strong>MULTIMODAL</strong> desenvolvido pelo <strong>Grupo Idugel</strong><br>
                        Tecnologia avançada de IA para atendimento automatizado
                    </div>
                    
                    <div class="status">
                        ⏳ Status: ${connectionStatus}
                    </div>
                    
                    <div class="loading"></div>
                    
                    <p style="color: #7f8c8d; margin: 20px 0;">
                        <em>Aguarde enquanto o sistema inicializa...</em><br>
                        A página será atualizada automaticamente<br>
                        <strong>🎯 Novo: Processamento de texto, imagens e áudios!</strong>
                    </p>
                    
                    <div class="footer">
                        <strong>Grupo Idugel</strong> - Inovação em Tecnologia e IA<br>
                        © 2024 - Todos os direitos reservados
                    </div>
                </div>
                
                <script>
                    // Auto-refresh a cada 5 segundos quando não há QR
                    setTimeout(() => location.reload(), 5000);
                </script>
            </body>
            </html>
        `);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
    logger.logSuccess('Servidor iniciado', { port: PORT });
});

connectToWhatsApp();

