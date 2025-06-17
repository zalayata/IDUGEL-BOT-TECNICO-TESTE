require('dotenv').config();

if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto;
}

const { makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const QRCode = require('qrcode');

const THREADS_FILE = path.join(__dirname, 'threadMap.json');
const LOG_FILE = path.join(__dirname, 'idugel-conversations.log');
const MEDIA_DIR = path.join(__dirname, 'media');

// Criar diretório de mídia se não existir
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Sistema de logs avançado compatível com Baileys
class ConversationLogger {
    constructor() {
        this.colors = {
            CONVERSATION: '\x1b[36m', // Cyan
            THREAD: '\x1b[33m',       // Yellow
            ERROR: '\x1b[31m',        // Red
            SUCCESS: '\x1b[32m',      // Green
            INFO: '\x1b[34m',         // Blue
            MEDIA: '\x1b[35m',        // Magenta
            FORMAT: '\x1b[90m',       // Gray
            RESET: '\x1b[0m'
        };
    }

    // Métodos compatíveis com Baileys
    error(message, ...args) {
        this.logError('BAILEYS_ERROR', new Error(message), { args });
    }

    warn(message, ...args) {
        this.logInfo('BAILEYS_WARN', { message, args });
    }

    info(message, ...args) {
        this.logInfo('BAILEYS_INFO', { message, args });
    }

    debug(message, ...args) {
        this.logInfo('BAILEYS_DEBUG', { message, args });
    }

    trace(message, ...args) {
        this.logInfo('BAILEYS_TRACE', { message, args });
    }

    child() {
        return this; // Retorna a mesma instância para compatibilidade
    }

    logConversation(action, from, messageText, reply, threadId, details = {}) {
        this.log('CONVERSATION', {
            action,
            user: from.replace('@s.whatsapp.net', ''),
            question: messageText.substring(0, 100),
            answer: reply.substring(0, 100),
            thread_id: threadId,
            processing_time: details.processingTime,
            media_type: details.mediaType
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

    logError(action, error, details = {}) {
        this.log('ERROR', {
            action,
            message: error.message,
            stack: error.stack,
            ...details
        });
    }

    logSuccess(action, details = {}) {
        this.log('SUCCESS', {
            action,
            ...details
        });
    }

    logInfo(action, details = {}) {
        this.log('INFO', {
            action,
            ...details
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

    logFormat(action, details = {}) {
        this.log('FORMAT', {
            action,
            ...details
        });
    }

    log(type, data) {
        const timestamp = new Date().toISOString();
        const color = this.colors[type] || this.colors.INFO;
        const reset = this.colors.RESET;
        
        // Log colorido no console
        console.log(`${color}[${timestamp}] ${type}:${reset}`, JSON.stringify(data, null, 2));
        
        // Log em arquivo
        const logEntry = {
            timestamp,
            type,
            ...data
        };
        
        try {
            fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n');
        } catch (error) {
            console.error('Erro ao escrever log:', error);
        }
    }
}

const logger = new ConversationLogger();

// Função para limpar citações preservando links
function removeCitations(text) {
    if (!text) return '';
    
    logger.logFormat('Iniciando limpeza de citações', {
        original_length: text.length,
        has_citations: /【\d+†source】/.test(text)
    });

    let cleanText = text
        // Remove citações específicas: 【número†source】
        .replace(/【\d+†source】/g, '')
        // Remove citações numéricas: [número], [número], (número)
        .replace(/【\d+】/g, '')
        .replace(/\[\d+\]/g, '')
        .replace(/\(\d+\)/g, '')
        .replace(/\[\d+:\d+\]/g, '')
        .replace(/\(\d+:\d+\)/g, '')
        // Converte markdown de links para links diretos: [texto](link) → link
        .replace(/\[([^\]]*)\]\(([^)]+)\)/g, '$2')
        // Remove linhas "Sources:" ou "Fontes:"
        .replace(/^(Sources?|Fontes?):\s*$/gim, '')
        // Remove múltiplos espaços e quebras
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim();

    logger.logFormat('Citações removidas', {
        original_length: text.length,
        clean_length: cleanText.length,
        removed_chars: text.length - cleanText.length
    });

    return cleanText;
}

// Função para formatação inteligente para WhatsApp
function formatForWhatsApp(text) {
    if (!text) return '';
    
    logger.logFormat('Iniciando formatação para WhatsApp', {
        original_length: text.length
    });

    let formatted = text
        // Quebra parágrafos longos após pontos finais
        .replace(/\. ([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ])/g, '.\n\n$1')
        // Adiciona espaçamento após dois pontos seguidos de texto
        .replace(/: ([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ])/g, ':\n\n$1')
        // Organiza listas com bullets
        .replace(/^- /gm, '• ')
        // Quebra antes de URLs para ficarem em linha separada
        .replace(/([.!?]) (https?:\/\/[^\s]+)/g, '$1\n\n$2')
        // Quebra antes de emails
        .replace(/([.!?]) ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '$1\n\n$2')
        // Quebra antes de números de telefone
        .replace(/([.!?]) (\+?\d{2}\d{8,})/g, '$1\n\n$2')
        // Quebra antes de perguntas para o usuário
        .replace(/([.!?]) (Como posso|Posso|Gostaria|Deseja|Precisa)/g, '$1\n\n$2')
        // Espaça frases de encerramento
        .replace(/([.!?]) (Obrigad[oa]|Atenciosamente|Cordialmente)/g, '$1\n\n$2')
        // Remove múltiplas quebras de linha (máximo 2)
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    logger.logFormat('Formatação concluída', {
        original_length: text.length,
        formatted_length: formatted.length,
        line_breaks_added: (formatted.match(/\n/g) || []).length
    });

    return formatted;
}

// Configuração OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Funções auxiliares para validação
function forceString(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && value.id) return String(value.id);
    return String(value || '');
}

function isValidThreadId(threadId) {
    const cleanId = forceString(threadId);
    return cleanId && cleanId.startsWith('thread_') && cleanId.length > 10;
}

function ensureStringThreadId(threadId) {
    const cleanId = forceString(threadId);
    if (!isValidThreadId(cleanId)) {
        throw new Error(`Invalid thread ID: ${cleanId}`);
    }
    return cleanId;
}

// Gerenciador de Threads com controle de primeira interação
class ThreadManager {
    constructor() {
        this.threads = this.loadThreads();
        this.firstInteractions = new Set(); // Rastreia primeiras interações
    }

    loadThreads() {
        try {
            if (fs.existsSync(THREADS_FILE)) {
                const data = fs.readFileSync(THREADS_FILE, 'utf8');
                const parsed = JSON.parse(data);
                
                // Limpa dados corrompidos
                const cleaned = {};
                for (const [key, value] of Object.entries(parsed)) {
                    const cleanValue = forceString(value);
                    if (isValidThreadId(cleanValue)) {
                        cleaned[key] = cleanValue;
                    } else {
                        logger.logThread('Removendo thread corrompida', key, cleanValue);
                    }
                }
                
                return cleaned;
            }
        } catch (error) {
            logger.logError('Erro ao carregar threads', error);
        }
        return {};
    }

    saveThreads() {
        try {
            fs.writeFileSync(THREADS_FILE, JSON.stringify(this.threads, null, 2));
        } catch (error) {
            logger.logError('Erro ao salvar threads', error);
        }
    }

    getThreadId(from) {
        const raw = this.threads[from];
        logger.logThread('Buscando thread', from, raw, { type: typeof raw });
        
        if (typeof raw === 'string' && isValidThreadId(raw)) {
            return raw;
        }
        
        logger.logThread('Thread não encontrada ou inválida', from, raw);
        return null;
    }

    setThreadId(from, threadId) {
        const cleanId = ensureStringThreadId(threadId);
        this.threads[from] = cleanId;
        this.saveThreads();
        logger.logThread('Thread salva', from, cleanId);
        return cleanId;
    }

    removeThread(from) {
        delete this.threads[from];
        this.firstInteractions.delete(from); // Remove também do controle de primeira interação
        this.saveThreads();
        logger.logThread('Thread removida', from, null);
    }

    // Controle de primeira interação
    isFirstInteraction(from) {
        const hasThread = this.getThreadId(from) !== null;
        const isFirst = !hasThread;
        
        if (isFirst) {
            this.firstInteractions.add(from);
            logger.logThread('🆕 PRIMEIRA INTERAÇÃO DETECTADA', from, null, { is_first: true });
        } else {
            logger.logThread('🔄 INTERAÇÃO CONTINUADA', from, this.getThreadId(from), { is_first: false });
        }
        
        return isFirst;
    }
}

const threadManager = new ThreadManager();

// Funções de processamento de mídia com logs ultra-detalhados
async function processImage(imagePath, caption = '') {
    try {
        logger.logMedia('🖼️ INICIANDO PROCESSAMENTO DE IMAGEM', '', 'image', {
            path: imagePath,
            caption: caption,
            file_exists: fs.existsSync(imagePath)
        });

        if (!fs.existsSync(imagePath)) {
            throw new Error(`Arquivo de imagem não encontrado: ${imagePath}`);
        }

        const imageBuffer = fs.readFileSync(imagePath);
        logger.logMedia('📁 ARQUIVO LIDO COM SUCESSO', '', 'image', {
            buffer_size: imageBuffer.length,
            buffer_type: typeof imageBuffer
        });

        const base64Image = imageBuffer.toString('base64');
        logger.logMedia('🔄 CONVERSÃO BASE64 CONCLUÍDA', '', 'image', {
            base64_length: base64Image.length,
            base64_preview: base64Image.substring(0, 50) + '...'
        });

        const prompt = caption ? 
            `Analise esta imagem. Contexto adicional: ${caption}` :
            "Analise esta imagem e descreva o que você vê de forma detalhada.";

        logger.logMedia('🤖 ENVIANDO PARA GPT-4O', '', 'image', {
            prompt: prompt,
            model: 'gpt-4o',
            max_tokens: 500
        });

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: prompt
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 500
        });

        const analysis = response.choices[0].message.content;
        logger.logMedia('✅ ANÁLISE DE IMAGEM CONCLUÍDA', '', 'image', {
            analysis_length: analysis.length,
            response_preview: analysis.substring(0, 100) + '...'
        });

        // Limpar arquivo temporário
        try {
            fs.unlinkSync(imagePath);
            logger.logMedia('🗑️ ARQUIVO TEMPORÁRIO REMOVIDO', '', 'image', { path: imagePath });
        } catch (cleanupError) {
            logger.logError('Erro ao remover arquivo temporário', cleanupError, { path: imagePath });
        }

        return analysis; // Retorna apenas a análise, sem formatação extra
    } catch (error) {
        logger.logError('❌ ERRO NO PROCESSAMENTO DE IMAGEM', error, { path: imagePath });
        
        // Tentar limpar arquivo em caso de erro
        try {
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
            }
        } catch (cleanupError) {
            logger.logError('Erro ao limpar arquivo após falha', cleanupError);
        }
        
        return "❌ Desculpe, não consegui processar esta imagem. Tente enviar novamente.";
    }
}

async function processAudio(audioPath) {
    try {
        logger.logMedia('🎵 INICIANDO PROCESSAMENTO DE ÁUDIO', '', 'audio', {
            path: audioPath,
            file_exists: fs.existsSync(audioPath)
        });

        if (!fs.existsSync(audioPath)) {
            throw new Error(`Arquivo de áudio não encontrado: ${audioPath}`);
        }

        const audioBuffer = fs.readFileSync(audioPath);
        logger.logMedia('📁 ARQUIVO DE ÁUDIO LIDO', '', 'audio', {
            buffer_size: audioBuffer.length
        });

        logger.logMedia('🤖 ENVIANDO PARA WHISPER', '', 'audio', {
            model: 'whisper-1',
            language: 'pt'
        });

        const response = await openai.audio.transcriptions.create({
            file: new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' }),
            model: "whisper-1",
            language: "pt"
        });

        const transcription = response.text;
        logger.logMedia('✅ TRANSCRIÇÃO CONCLUÍDA', '', 'audio', {
            transcription_length: transcription.length,
            transcription_preview: transcription.substring(0, 100) + '...'
        });

        // Limpar arquivo temporário
        try {
            fs.unlinkSync(audioPath);
            logger.logMedia('🗑️ ARQUIVO TEMPORÁRIO DE ÁUDIO REMOVIDO', '', 'audio', { path: audioPath });
        } catch (cleanupError) {
            logger.logError('Erro ao remover arquivo de áudio temporário', cleanupError, { path: audioPath });
        }

        return transcription;
    } catch (error) {
        logger.logError('❌ ERRO NO PROCESSAMENTO DE ÁUDIO', error, { path: audioPath });
        
        // Tentar limpar arquivo em caso de erro
        try {
            if (fs.existsSync(audioPath)) {
                fs.unlinkSync(audioPath);
            }
        } catch (cleanupError) {
            logger.logError('Erro ao limpar arquivo de áudio após falha', cleanupError);
        }
        
        return "❌ Desculpe, não consegui processar este áudio. Tente enviar novamente.";
    }
}

// Funções da API OpenAI
async function createNewThread() {
    try {
        const response = await openai.beta.threads.create();
        const threadId = ensureStringThreadId(response.id);
        logger.logThread('Nova thread criada', '', threadId);
        return threadId;
    } catch (error) {
        logger.logError('Erro ao criar thread', error);
        throw error;
    }
}

async function addMessageToThread(threadId, messageText) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        const response = await openai.beta.threads.messages.create(cleanThreadId, {
            role: 'user',
            content: messageText
        });
        logger.logThread('Mensagem adicionada à thread', '', cleanThreadId, {
            message_id: response.id,
            content_length: messageText.length
        });
        return response;
    } catch (error) {
        logger.logError('Erro ao adicionar mensagem à thread', error, { threadId });
        throw error;
    }
}

async function runAssistant(threadId) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        const assistantId = String(process.env.OPENAI_ASSISTANT_ID);
        
        logger.logThread('Executando assistente', '', cleanThreadId, { assistant_id: assistantId });
        
        const run = await openai.beta.threads.runs.create(cleanThreadId, {
            assistant_id: assistantId
        });
        
        logger.logThread('Execução iniciada', '', cleanThreadId, { 
            run_id: run.id,
            status: run.status 
        });
        
        return run;
    } catch (error) {
        logger.logError('Erro ao executar assistente', error, { threadId });
        throw error;
    }
}

async function waitForRunCompletion(threadId, runId) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        let attempts = 0;
        const maxAttempts = 60; // 60 segundos máximo
        
        logger.logThread('Aguardando conclusão da execução', '', cleanThreadId, { 
            run_id: runId,
            max_attempts: maxAttempts 
        });
        
        while (attempts < maxAttempts) {
            const run = await openai.beta.threads.runs.retrieve(cleanThreadId, runId);
            
            logger.logThread('Status da execução', '', cleanThreadId, {
                run_id: runId,
                status: run.status,
                attempt: attempts + 1
            });
            
            if (run.status === 'completed') {
                logger.logThread('Execução concluída com sucesso', '', cleanThreadId, { 
                    run_id: runId,
                    total_attempts: attempts + 1 
                });
                return run;
            }
            
            if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'expired') {
                throw new Error(`Execução falhou com status: ${run.status}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
        }
        
        throw new Error('Timeout: Execução não concluída no tempo esperado');
    } catch (error) {
        logger.logError('Erro ao aguardar conclusão da execução', error, { threadId, runId });
        throw error;
    }
}

async function getLatestMessage(threadId) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        const messages = await openai.beta.threads.messages.list(cleanThreadId);
        
        if (messages.data.length === 0) {
            throw new Error('Nenhuma mensagem encontrada na thread');
        }
        
        const latestMessage = messages.data[0];
        
        if (latestMessage.role !== 'assistant') {
            throw new Error('Última mensagem não é do assistente');
        }
        
        const content = latestMessage.content[0];
        if (content.type !== 'text') {
            throw new Error('Conteúdo da mensagem não é texto');
        }
        
        const responseText = content.text.value;
        
        logger.logThread('Mensagem obtida', '', cleanThreadId, {
            message_id: latestMessage.id,
            content_length: responseText.length,
            content_preview: responseText.substring(0, 100) + '...'
        });
        
        return responseText;
    } catch (error) {
        logger.logError('Erro ao obter última mensagem', error, { threadId });
        throw error;
    }
}

// Função principal para processar mensagens
async function processMessage(from, messageText, mediaType = 'text') {
    const startTime = Date.now();
    
    try {
        logger.logConversation('Iniciando processamento', from, messageText, '', null, { 
            media_type: mediaType,
            message_length: messageText.length 
        });
        
        let threadId = threadManager.getThreadId(from);
        const isFirstInteraction = threadManager.isFirstInteraction(from);
        
        // Preparar mensagem com contexto adequado
        let contextualMessage;
        if (isFirstInteraction) {
            contextualMessage = `Esta é a primeira interação com este usuário. ${messageText}`;
        } else {
            contextualMessage = `Continuando nossa conversa (não se apresente novamente): ${messageText}`;
        }
        
        if (!threadId) {
            threadId = await createNewThread();
            threadManager.setThreadId(from, threadId);
        }
        
        await addMessageToThread(threadId, contextualMessage);
        const run = await runAssistant(threadId);
        await waitForRunCompletion(threadId, run.id);
        const response = await getLatestMessage(threadId);
        
        // Aplicar formatações
        const cleanResponse = removeCitations(response);
        const formattedResponse = formatForWhatsApp(cleanResponse);
        
        const processingTime = Date.now() - startTime;
        
        logger.logConversation('Processamento concluído', from, messageText, formattedResponse, threadId, {
            processing_time: processingTime,
            media_type: mediaType,
            response_length: formattedResponse.length
        });
        
        return formattedResponse;
    } catch (error) {
        const processingTime = Date.now() - startTime;
        logger.logError('Erro no processamento da mensagem', error, {
            from,
            processing_time: processingTime,
            media_type: mediaType
        });
        
        return "❌ Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente em alguns instantes.";
    }
}

// Configuração do socket WhatsApp
let sock;
let qrCodeData = '';
let isConnected = false;

// Estatísticas globais
global.stats = {
    messages: 0,
    images: 0,
    audios: 0,
    uptime: Date.now()
};

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            browser: ['A.IDUGEL Bot', 'Chrome', '1.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                try {
                    console.log('🔐 QR Code gerado! Acesse a página web para escanear.');
                    logger.logSuccess('QR Code gerado', { qr_length: qr.length });
                    
                    // Converter QR Code para base64
                    const qrCodeDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: 'M',
                        type: 'image/png',
                        quality: 0.92,
                        margin: 2,
                        width: 400,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    
                    qrCodeData = `
                        <div style="text-align: center; padding: 20px;">
                            <h3 style="color: #333; margin-bottom: 20px;">📱 Escaneie o QR Code</h3>
                            <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); display: inline-block;">
                                <img src="${qrCodeDataURL}" style="width: 400px; height: 400px;" />
                            </div>
                            <p style="color: #666; margin-top: 20px;">Abra o WhatsApp → Menu → Dispositivos conectados</p>
                        </div>
                    `;
                } catch (error) {
                    logger.logError('Erro ao gerar QR Code', error);
                    qrCodeData = '<p style="color: red;">Erro ao gerar QR Code</p>';
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.logInfo('Conexão fechada', { 
                    should_reconnect: shouldReconnect,
                    reason: lastDisconnect?.error?.output?.statusCode 
                });
                
                if (shouldReconnect) {
                    connectToWhatsApp();
                }
                isConnected = false;
            } else if (connection === 'open') {
                logger.logSuccess('Conectado ao WhatsApp');
                isConnected = true;
                qrCodeData = '<p style="color: green;">✅ WhatsApp conectado com sucesso!</p>';
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Event listener para mensagens
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const message = m.messages[0];
                
                if (!message.key.fromMe && message.message) {
                    const from = message.key.remoteJid;
                    
                    // Ignorar mensagens de grupo
                    if (from.includes('@g.us')) {
                        return;
                    }
                    
                    logger.logConversation('Mensagem recebida', from, '', '', null, {
                        message_type: Object.keys(message.message)[0],
                        timestamp: message.messageTimestamp
                    });
                    
                    let responseText = '';
                    
                    // Processar diferentes tipos de mensagem
                    if (message.message.conversation) {
                        // Mensagem de texto simples
                        const messageText = message.message.conversation;
                        logger.logMedia('📝 MENSAGEM DE TEXTO DETECTADA', from, 'text', {
                            content: messageText.substring(0, 100) + '...'
                        });
                        
                        responseText = await processMessage(from, messageText, 'text');
                        global.stats.messages++;
                        
                    } else if (message.message.extendedTextMessage) {
                        // Mensagem de texto estendida
                        const messageText = message.message.extendedTextMessage.text;
                        logger.logMedia('📝 MENSAGEM DE TEXTO ESTENDIDA DETECTADA', from, 'text', {
                            content: messageText.substring(0, 100) + '...'
                        });
                        
                        responseText = await processMessage(from, messageText, 'text');
                        global.stats.messages++;
                        
                    } else if (message.message.imageMessage) {
                        // Mensagem de imagem
                        logger.logMedia('🖼️ IMAGEM DETECTADA', from, 'image');
                        
                        try {
                            logger.logMedia('📥 INICIANDO DOWNLOAD DA IMAGEM', from, 'image');
                            
                            const buffer = await downloadMediaMessage(message, 'buffer', {});
                            
                            if (!buffer || buffer.length === 0) {
                                throw new Error('Buffer de imagem vazio');
                            }
                            
                            logger.logMedia('✅ DOWNLOAD DA IMAGEM CONCLUÍDO', from, 'image', {
                                buffer_size: buffer.length
                            });
                            
                            // Salvar temporariamente
                            const imagePath = path.join(MEDIA_DIR, `image_${Date.now()}.jpg`);
                            fs.writeFileSync(imagePath, buffer);
                            
                            logger.logMedia('💾 IMAGEM SALVA TEMPORARIAMENTE', from, 'image', {
                                path: imagePath
                            });
                            
                            // Processar imagem
                            const caption = message.message.imageMessage.caption || '';
                            const imageAnalysis = await processImage(imagePath, caption);
                            
                            // Enviar análise para o assistente processar
                            const prompt = `Baseado na análise da imagem a seguir, forneça uma resposta útil e contextualizada para o usuário:

Análise da imagem: ${imageAnalysis}

Mensagem do usuário: ${caption || 'Usuário enviou uma imagem'}

Forneça uma resposta natural e útil baseada no conteúdo da imagem.`;

                            responseText = await processMessage(from, prompt, 'image');
                            global.stats.images++;
                            
                            logger.logMedia('🎯 PROCESSAMENTO DE IMAGEM FINALIZADO', from, 'image', {
                                result_length: responseText.length
                            });
                            
                        } catch (error) {
                            logger.logError('Erro no processamento de imagem', error, { from });
                            responseText = "❌ Desculpe, não consegui processar esta imagem. Tente enviar novamente.";
                        }
                        
                    } else if (message.message.audioMessage) {
                        // Mensagem de áudio
                        logger.logMedia('🎵 ÁUDIO DETECTADO', from, 'audio');
                        
                        try {
                            logger.logMedia('📥 INICIANDO DOWNLOAD DO ÁUDIO', from, 'audio');
                            
                            const buffer = await downloadMediaMessage(message, 'buffer', {});
                            
                            if (!buffer || buffer.length === 0) {
                                throw new Error('Buffer de áudio vazio');
                            }
                            
                            logger.logMedia('✅ DOWNLOAD DO ÁUDIO CONCLUÍDO', from, 'audio', {
                                buffer_size: buffer.length
                            });
                            
                            // Salvar temporariamente
                            const audioPath = path.join(MEDIA_DIR, `audio_${Date.now()}.ogg`);
                            fs.writeFileSync(audioPath, buffer);
                            
                            logger.logMedia('💾 ÁUDIO SALVO TEMPORARIAMENTE', from, 'audio', {
                                path: audioPath
                            });
                            
                            // Processar áudio
                            const transcription = await processAudio(audioPath);
                            responseText = await processMessage(from, transcription, 'audio');
                            global.stats.audios++;
                            
                            logger.logMedia('🎯 PROCESSAMENTO DE ÁUDIO FINALIZADO', from, 'audio', {
                                transcription_length: transcription.length,
                                result_length: responseText.length
                            });
                            
                        } catch (error) {
                            logger.logError('Erro no processamento de áudio', error, { from });
                            responseText = "❌ Desculpe, não consegui processar este áudio. Tente enviar novamente.";
                        }
                    }
                    
                    // Enviar resposta
                    if (responseText) {
                        await sock.sendMessage(from, { text: responseText });
                        logger.logConversation('Resposta enviada', from, '', responseText, threadManager.getThreadId(from));
                    }
                }
            } catch (error) {
                logger.logError('Erro no processamento de mensagem', error);
            }
        });

    } catch (error) {
        logger.logError('Erro ao conectar ao WhatsApp', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Servidor web
const app = express();

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - global.stats.uptime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>A.IDUGEL - Tecnologia Grupo Idugel</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
                min-height: 100vh;
                padding: 20px;
            }
            
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: white;
                border-radius: 20px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                overflow: hidden;
            }
            
            .header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 40px 20px;
                text-align: center;
                position: relative;
            }
            
            .logo {
                width: 120px;
                height: 120px;
                margin: 0 auto 20px;
                border-radius: 50%;
                background: white;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 48px;
                font-weight: bold;
                color: #667eea;
                border: 4px solid white;
                box-shadow: 0 8px 16px rgba(0,0,0,0.2);
                animation: pulse 2s infinite;
            }
            
            @keyframes pulse {
                0% { transform: scale(1); }
                50% { transform: scale(1.05); }
                100% { transform: scale(1); }
            }
            
            h1 {
                font-size: 2.5em;
                margin-bottom: 10px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
            }
            
            .subtitle {
                font-size: 1.2em;
                opacity: 0.9;
                font-weight: 300;
            }
            
            .content {
                padding: 40px;
            }
            
            .status {
                background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
                color: white;
                padding: 20px;
                border-radius: 15px;
                text-align: center;
                margin-bottom: 30px;
                font-size: 1.1em;
                font-weight: 500;
            }
            
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }
            
            .stat-card {
                background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
                color: white;
                padding: 25px;
                border-radius: 15px;
                text-align: center;
                box-shadow: 0 8px 16px rgba(33, 150, 243, 0.3);
            }
            
            .stat-number {
                font-size: 2.5em;
                font-weight: bold;
                margin-bottom: 10px;
            }
            
            .stat-label {
                font-size: 1em;
                opacity: 0.9;
            }
            
            .qr-container {
                background: #f8f9fa;
                border: 2px dashed #dee2e6;
                border-radius: 15px;
                padding: 30px;
                text-align: center;
                margin-bottom: 30px;
            }
            
            .instructions {
                background: linear-gradient(135deg, #FFF3CD 0%, #FFEAA7 100%);
                border: 1px solid #FFEAA7;
                border-radius: 15px;
                padding: 20px;
                margin-bottom: 30px;
            }
            
            .instructions h3 {
                color: #856404;
                margin-bottom: 15px;
                font-size: 1.3em;
            }
            
            .instructions ol {
                color: #856404;
                padding-left: 20px;
            }
            
            .instructions li {
                margin-bottom: 8px;
                line-height: 1.5;
            }
            
            .features {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }
            
            .feature {
                background: #f8f9fa;
                padding: 25px;
                border-radius: 15px;
                text-align: center;
                border: 1px solid #e9ecef;
            }
            
            .feature h4 {
                color: #495057;
                margin-bottom: 15px;
                font-size: 1.2em;
            }
            
            .feature p {
                color: #6c757d;
                line-height: 1.5;
            }
            
            .footer {
                background: #f8f9fa;
                padding: 20px;
                text-align: center;
                color: #6c757d;
                border-top: 1px solid #e9ecef;
            }
            
            .links {
                margin-top: 20px;
            }
            
            .links a {
                color: #667eea;
                text-decoration: none;
                margin: 0 15px;
                font-weight: 500;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }
            
            .links a:hover {
                text-decoration: underline;
            }
            
            @media (max-width: 768px) {
                .container {
                    margin: 10px;
                    border-radius: 15px;
                }
                
                .header {
                    padding: 30px 15px;
                }
                
                h1 {
                    font-size: 2em;
                }
                
                .content {
                    padding: 20px;
                }
                
                .stats {
                    grid-template-columns: 1fr;
                }
                
                .features {
                    grid-template-columns: 1fr;
                }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="logo">
                    <img src="/logo-idugel.jpg" alt="Logo Grupo Idugel" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" 
                         onerror="this.style.display='none'; this.parentNode.innerHTML='AI';" />
                </div>
                <h1>A.IDUGEL</h1>
                <div class="subtitle">Tecnologia Grupo Idugel</div>
            </div>
            
            <div class="content">
                <div class="status">
                    ${isConnected ? '✅ Sistema Online e Funcionando' : '🔄 Conectando ao WhatsApp...'}
                </div>
                
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">${global.stats.messages}</div>
                        <div class="stat-label">Mensagens</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${global.stats.images}</div>
                        <div class="stat-label">Imagens</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${global.stats.audios}</div>
                        <div class="stat-label">Áudios</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${hours}h ${minutes}m ${seconds}s</div>
                        <div class="stat-label">Tempo Online</div>
                    </div>
                </div>
                
                <div class="qr-container">
                    ${qrCodeData || '<p>Aguardando QR Code...</p>'}
                </div>
                
                <div class="instructions">
                    <h3>📱 Como Conectar:</h3>
                    <ol>
                        <li>Abra o <strong>WhatsApp</strong> no seu celular</li>
                        <li>Toque no <strong>menu</strong> (três pontos) no canto superior direito</li>
                        <li>Selecione <strong>"Dispositivos conectados"</strong></li>
                        <li>Toque em <strong>"Conectar um dispositivo"</strong></li>
                        <li><strong>Escaneie o QR Code</strong> acima com a câmera do seu celular</li>
                    </ol>
                </div>
                
                <div class="features">
                    <div class="feature">
                        <h4>🚀 Processamento de Texto</h4>
                        <p>Envie mensagens de texto e receba respostas inteligentes do assistente virtual.</p>
                    </div>
                    <div class="feature">
                        <h4>🚀 Análise de Imagens</h4>
                        <p>Envie fotos e receba análises detalhadas usando tecnologia GPT-4o.</p>
                    </div>
                    <div class="feature">
                        <h4>🚀 Transcrição de Áudio</h4>
                        <p>Grave áudios e receba transcrições precisas com processamento inteligente.</p>
                    </div>
                </div>
            </div>
            
            <div class="footer">
                <p>© 2024 A.IDUGEL - Tecnologia Grupo Idugel</p>
                <div class="links">
                    <a href="#">Suporte</a>
                    <a href="#">Documentação</a>
                    <a href="#">Contato</a>
                </div>
            </div>
        </div>
        
        <script>
            // Auto-refresh a cada 30 segundos
            setTimeout(() => {
                location.reload();
            }, 30000);
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
    logger.logSuccess('Servidor HTTP iniciado', { port: PORT });
});

// Inicializar conexão
connectToWhatsApp();

// Tratamento de erros
process.on('unhandledRejection', (reason, promise) => {
    logger.logError('Rejeição não tratada', new Error(reason), { promise });
});

process.on('uncaughtException', (error) => {
    logger.logError('Exceção não capturada', error);
    process.exit(1);
});

