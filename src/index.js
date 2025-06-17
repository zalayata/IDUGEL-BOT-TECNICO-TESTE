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

// Gerenciador de Threads
class ThreadManager {
    constructor() {
        this.threads = this.loadThreads();
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
        this.saveThreads();
        logger.logThread('Thread removida', from, null);
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

        return `🖼️ *Análise da imagem:*\n\n${analysis}`;
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

        return `🎵 *Transcrição do áudio:* "${transcription}"`;
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
            content: String(messageText)
        });
        logger.logThread('Mensagem adicionada à thread', '', cleanThreadId, {
            message_length: messageText.length
        });
        return response;
    } catch (error) {
        logger.logError('Erro ao adicionar mensagem', error, { threadId, messageText });
        throw error;
    }
}

async function createRun(threadId) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        const assistantId = String(process.env.OPENAI_ASSISTANT_ID);
        
        const response = await openai.beta.threads.runs.create(cleanThreadId, {
            assistant_id: assistantId
        });
        
        logger.logThread('Run criado', '', cleanThreadId, {
            run_id: response.id,
            assistant_id: assistantId
        });
        
        return response;
    } catch (error) {
        logger.logError('Erro ao criar run', error, { threadId });
        throw error;
    }
}

async function retrieveRunStatus(threadId, runId) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        const response = await openai.beta.threads.runs.retrieve(cleanThreadId, runId);
        return response;
    } catch (error) {
        logger.logError('Erro ao verificar status do run', error, { threadId, runId });
        throw error;
    }
}

async function listMessages(threadId) {
    try {
        const cleanThreadId = ensureStringThreadId(threadId);
        const response = await openai.beta.threads.messages.list(cleanThreadId);
        return response;
    } catch (error) {
        logger.logError('Erro ao listar mensagens', error, { threadId });
        throw error;
    }
}

// Função principal de processamento de mensagens da IA
async function processAIMessage(from, messageText, mediaType = 'text') {
    const startTime = Date.now();
    
    try {
        logger.logConversation('📩 MENSAGEM RECEBIDA', from, messageText, '', '', {
            mediaType
        });

        let threadId = threadManager.getThreadId(from);
        
        if (!threadId) {
            threadId = await createNewThread();
            threadManager.setThreadId(from, threadId);
            logger.logThread('🧵 Thread criada com ID', from, threadId);
        }

        await addMessageToThread(threadId, messageText);
        const run = await createRun(threadId);
        
        // Aguarda conclusão do run com logs detalhados
        let runStatus = await retrieveRunStatus(threadId, run.id);
        let attempts = 0;
        const maxAttempts = 30;
        
        while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
            attempts++;
            if (attempts > maxAttempts) {
                throw new Error('Timeout: Run demorou muito para completar');
            }
            
            logger.logInfo(`⏳ VERIFICANDO STATUS (${attempts}/${maxAttempts})`, {
                status: runStatus.status,
                thread_id: threadId
            });
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            runStatus = await retrieveRunStatus(threadId, run.id);
        }
        
        if (runStatus.status !== 'completed') {
            throw new Error(`Run falhou com status: ${runStatus.status}`);
        }
        
        const messages = await listMessages(threadId);
        const lastMessage = messages.data[0];
        
        if (!lastMessage || !lastMessage.content || !lastMessage.content[0]) {
            throw new Error('Resposta vazia da IA');
        }
        
        let reply = lastMessage.content[0].text.value;
        
        // Aplica limpeza de citações e formatação
        reply = removeCitations(reply);
        reply = formatForWhatsApp(reply);
        
        const processingTime = Date.now() - startTime;
        
        logger.logConversation('✅ RESPOSTA PROCESSADA', from, messageText, reply, threadId, {
            processingTime,
            mediaType
        });
        
        return reply;
        
    } catch (error) {
        const processingTime = Date.now() - startTime;
        
        logger.logError('❌ Erro na OpenAI', error, {
            from: from.replace('@s.whatsapp.net', ''),
            message: messageText.substring(0, 100),
            processingTime,
            mediaType
        });
        
        return "❌ Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente em alguns instantes.";
    }
}

// Estatísticas globais
const stats = {
    conversations: 0,
    media_processed: 0,
    start_time: new Date()
};

// Configuração do servidor web
const app = express();
const PORT = process.env.PORT || 3000;

// Variáveis globais para status
global.qrCode = '<div style="color: orange;">Gerando QR Code...</div>';
global.connectionStatus = 'Iniciando...';

app.use(express.static('public'));

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.start_time.getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>IAIDUGEL - Tecnologia Grupo Idugel</title>
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
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #333;
                    padding: 20px;
                }

                .container {
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 600px;
                    width: 90%;
                    text-align: center;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.18);
                }

                .logo {
                    width: 120px;
                    height: 120px;
                    margin: 0 auto 30px;
                    border-radius: 50%;
                    background: linear-gradient(45deg, #4facfe, #00f2fe);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 2em;
                    font-weight: bold;
                    color: white;
                    box-shadow: 0 10px 30px rgba(79, 172, 254, 0.3);
                    border: 4px solid white;
                    overflow: hidden;
                }

                h1 {
                    font-size: 2.2em;
                    margin: 10px 0;
                    color: #2c3e50;
                    font-weight: 700;
                }

                .subtitle {
                    font-size: 1.1em;
                    margin-bottom: 30px;
                    color: #7f8c8d;
                    line-height: 1.6;
                }

                .status {
                    background: linear-gradient(45deg, #27ae60, #2ecc71);
                    color: white;
                    padding: 15px 25px;
                    border-radius: 50px;
                    margin: 20px 0;
                    font-weight: 600;
                    font-size: 1.1em;
                    box-shadow: 0 5px 15px rgba(46, 204, 113, 0.3);
                }

                .qr-container {
                    background: #f8f9fa;
                    border-radius: 15px;
                    padding: 30px;
                    margin: 30px 0;
                    border: 3px dashed #667eea;
                    min-height: 200px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: #333;
                }

                .stats {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                    gap: 20px;
                    margin: 30px 0;
                }

                .stat-card {
                    background: linear-gradient(45deg, #3498db, #2980b9);
                    color: white;
                    padding: 20px;
                    border-radius: 10px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    box-shadow: 0 5px 15px rgba(52, 152, 219, 0.3);
                }

                .stat-number {
                    font-size: 2em;
                    font-weight: bold;
                    color: white;
                }

                .stat-label {
                    font-size: 0.9em;
                    opacity: 0.9;
                    margin-top: 5px;
                    color: white;
                }

                .features {
                    text-align: left;
                    margin: 30px 0;
                }

                .features h3 {
                    margin-bottom: 15px;
                    color: #2c3e50;
                    text-align: center;
                }

                .features ul {
                    list-style: none;
                    padding-left: 0;
                }

                .features li {
                    padding: 8px 0;
                    padding-left: 25px;
                    position: relative;
                    color: #34495e;
                }

                .features li:before {
                    content: "🚀";
                    position: absolute;
                    left: 0;
                }

                .instructions {
                    background: #fff3cd;
                    color: #856404;
                    border-radius: 10px;
                    padding: 20px;
                    margin: 20px 0;
                    border-left: 4px solid #ffc107;
                }

                .footer {
                    margin-top: 30px;
                    font-size: 14px;
                    color: #7f8c8d;
                }

                .links {
                    margin: 20px 0;
                }

                .links a {
                    color: white;
                    background: linear-gradient(45deg, #667eea, #764ba2);
                    text-decoration: none;
                    margin: 0 10px;
                    padding: 8px 16px;
                    border-radius: 20px;
                    transition: all 0.3s ease;
                    display: inline-block;
                    margin-bottom: 10px;
                    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
                }

                .links a:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
                }

                .pulse {
                    animation: pulse 2s infinite;
                }

                @keyframes pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                    100% { transform: scale(1); }
                }

                @media (max-width: 768px) {
                    .container {
                        padding: 20px;
                        margin: 20px;
                    }
                    
                    .logo {
                        font-size: 2em;
                    }
                    
                    .stats {
                        grid-template-columns: 1fr 1fr;
                    }
                }
            </style>
            <script>
                function refreshPage() {
                    location.reload();
                }
                
                // Auto-refresh a cada 30 segundos
                setInterval(refreshPage, 30000);
            </script>
        </head>
        <body>
            <div class="                <div class="logo pulse">
                    <img src="/logo-idugel.jpg" alt="Logo Grupo Idugel" 
                         style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" 
                         onerror="this.style.display='none'; this.parentNode.innerHTML='IG';" />
                </div>   
                <h1>IAIDUGEL</h1>
                <div class="subtitle">Tecnologia Grupo Idugel</div>
                
                <div class="status">
                    <strong>Status:</strong> ${global.connectionStatus}
                </div>
                
                <div class="qr-container">
                    ${global.qrCode}
                </div>
                
                <div class="stats">
                    <div class="stat-card">
                        <div class="stat-number">${stats.conversations}</div>
                        <div class="stat-label">Conversas</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${stats.media_processed}</div>
                        <div class="stat-label">Mídias Processadas</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number">${hours}h ${minutes}m ${seconds}s</div>
                        <div class="stat-label">Tempo Ativo</div>
                    </div>
                </div>
                
                <div class="features">
                    <h3>🚀 Recursos Disponíveis:</h3>
                    <ul>
                        <li>💬 Conversas inteligentes com IA</li>
                        <li>🖼️ Análise de imagens com GPT-4o</li>
                        <li>🎵 Transcrição de áudios com Whisper</li>
                        <li>📱 Interface web responsiva</li>
                        <li>📊 Logs detalhados em tempo real</li>
                        <li>🔄 Reconexão automática</li>
                    </ul>
                </div>
                
                <div class="instructions">
                    <h3>📱 Como usar:</h3>
                    <p>1. Escaneie o QR Code com seu WhatsApp</p>
                    <p>2. Envie mensagens, imagens ou áudios</p>
                    <p>3. Receba respostas inteligentes da IA</p>
                </div>
                
                <div class="links">
                    <a href="javascript:refreshPage()">🔄 Atualizar</a>
                    <a href="mailto:atendimento@idugel.com.br">📧 Suporte</a>
                    <a href="tel:+5549999645451">📞 Contato</a>
                </div>
                
                <div class="footer">
                    <p>© 2024 IAIDUGEL - Tecnologia Grupo Idugel</p>
                    <p>Desenvolvido com ❤️ para automatizar seu atendimento</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
    logger.logSuccess('Servidor HTTP iniciado', { port: PORT });
});

// Função para inicializar WhatsApp
async function startWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth');
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: logger,
            browser: ['A.IDUGEL Bot', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);
        
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
                        margin: 1,
                        color: {
                            dark: '#000000',
                            light: '#FFFFFF'
                        }
                    });
                    
                    global.qrCode = `
                        <div style="text-align: center;">
                            <h3 style="color: #333; margin-bottom: 20px;">📱 Escaneie o QR Code</h3>
                            <div style="background: white; padding: 20px; border-radius: 10px; display: inline-block;">
                                <img src="${qrCodeDataURL}" style="max-width: 300px; width: 100%;" alt="QR Code" />
                            </div>
                            <p style="color: #666; margin-top: 15px; font-size: 14px;">
                                Abra o WhatsApp → Menu → Dispositivos conectados → Conectar dispositivo
                            </p>
                        </div>
                    `;
                    global.connectionStatus = 'Aguardando escaneamento do QR Code...';
                    
                    logger.logSuccess('QR Code convertido para base64', { 
                        dataURL_length: qrCodeDataURL.length 
                    });
                    
                } catch (qrError) {
                    logger.logError('Erro ao gerar QR Code', qrError);
                    global.qrCode = `
                        <div style="color: red; text-align: center;">
                            <h3>❌ Erro ao gerar QR Code</h3>
                            <p>Tente recarregar a página</p>
                        </div>
                    `;
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('📴 Conexão fechada devido a:', lastDisconnect?.error, ', reconectando:', shouldReconnect);
                global.connectionStatus = 'Desconectado - Tentando reconectar...';
                global.qrCode = '<div style="color: orange;">Reconectando...</div>';
                
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp conectado e pronto com Baileys!');
                global.connectionStatus = 'Conectado e funcionando!';
                global.qrCode = '<div style="color: green; font-size: 18px;">✅ Conectado com sucesso!</div>';
            }
        });
        
        // Event listener para mensagens (CORRIGIDO)
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            
            if (!message.key.fromMe && message.message) {
                const from = message.key.remoteJid;
                let messageText = '';
                let mediaType = 'text';
                let processedContent = '';
                
                try {
                    // 🔍 Verifica se é uma mensagem de texto
                    if (message.message.conversation) {
                        messageText = message.message.conversation;
                        processedContent = messageText;
                        logger.logMedia('📝 MENSAGEM DE TEXTO DETECTADA', from, 'text', { 
                            message: messageText.substring(0, 100) 
                        });
                    } else if (message.message.extendedTextMessage) {
                        messageText = message.message.extendedTextMessage.text;
                        processedContent = messageText;
                        logger.logMedia('📝 MENSAGEM ESTENDIDA DETECTADA', from, 'text', { 
                            message: messageText.substring(0, 100) 
                        });
                    }
                    // 🖼️ Verifica se é uma imagem
                    else if (message.message.imageMessage) {
                        mediaType = 'image';
                        const caption = message.message.imageMessage.caption || '';
                        
                        logger.logMedia('🖼️ IMAGEM DETECTADA', from, 'image', { 
                            caption: caption,
                            has_caption: !!caption
                        });
                        
                        try {
                            logger.logMedia('📥 INICIANDO DOWNLOAD DA IMAGEM', from, 'image');
                            const buffer = await downloadMediaMessage(message, 'buffer', {});
                            
                            if (!buffer || buffer.length === 0) {
                                throw new Error('Buffer de imagem vazio');
                            }
                            
                            logger.logMedia('✅ DOWNLOAD DA IMAGEM CONCLUÍDO', from, 'image', {
                                buffer_size: buffer.length
                            });
                            
                            const imagePath = path.join(MEDIA_DIR, `image_${Date.now()}.jpg`);
                            fs.writeFileSync(imagePath, buffer);
                            
                            logger.logMedia('💾 IMAGEM SALVA TEMPORARIAMENTE', from, 'image', {
                                path: imagePath,
                                file_exists: fs.existsSync(imagePath)
                            });
                            
                            processedContent = await processImage(imagePath, caption);
                            
                            // Enviar análise da imagem para o assistente processar
                            logger.logMedia('🤖 ENVIANDO ANÁLISE PARA ASSISTENTE', from, 'image');
                            const imageAnalysisText = processedContent.replace('🖼️ *Análise da imagem:*\n\n', '');
                            const aiResponse = await processAIMessage(from, `Análise da imagem: ${imageAnalysisText}`, 'image');
                            
                            processedContent = aiResponse;
                            stats.media_processed++;
                            
                            logger.logMedia('🎯 PROCESSAMENTO DE IMAGEM FINALIZADO', from, 'image', {
                                result_length: processedContent.length
                            });
                        } catch (imageError) {
                            logger.logError('❌ ERRO NO PROCESSAMENTO DE IMAGEM', imageError, {
                                from: from,
                                caption: caption
                            });
                            processedContent = "❌ Desculpe, não consegui processar esta imagem. Tente enviar novamente.";
                        }
                    }
                    // 🎵 Verifica se é um áudio
                    else if (message.message.audioMessage) {
                        mediaType = 'audio';
                        
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
                            
                            const audioPath = path.join(MEDIA_DIR, `audio_${Date.now()}.ogg`);
                            fs.writeFileSync(audioPath, buffer);
                            
                            logger.logMedia('💾 ÁUDIO SALVO TEMPORARIAMENTE', from, 'audio', {
                                path: audioPath,
                                file_exists: fs.existsSync(audioPath)
                            });
                            
                            const transcription = await processAudio(audioPath);
                            
                            // Processa a transcrição como mensagem normal
                            const transcriptionText = transcription.replace('🎵 *Transcrição do áudio:* "', '').replace('"', '');
                            const aiResponse = await processAIMessage(from, transcriptionText, 'audio');
                            
                            processedContent = `${transcription}\n\n${aiResponse}`;
                            stats.media_processed++;
                            
                            logger.logMedia('🎯 PROCESSAMENTO DE ÁUDIO FINALIZADO', from, 'audio', {
                                transcription_length: transcription.length,
                                response_length: aiResponse.length
                            });
                        } catch (audioError) {
                            logger.logError('❌ ERRO NO PROCESSAMENTO DE ÁUDIO', audioError, {
                                from: from
                            });
                            processedContent = "❌ Desculpe, não consegui processar este áudio. Tente enviar novamente.";
                        }
                    }
                    
                    // Se não foi mídia, processa como texto normal
                    if (mediaType === 'text' && processedContent) {
                        logger.logInfo('🤖 PROCESSANDO MENSAGEM DE TEXTO', {
                            from: from.replace('@s.whatsapp.net', ''),
                            message: processedContent.substring(0, 100)
                        });
                        
                        processedContent = await processAIMessage(from, processedContent, mediaType);
                    }
                    
                    // Envia resposta se há conteúdo processado
                    if (processedContent) {
                        await sock.sendMessage(from, { text: processedContent });
                        stats.conversations++;
                        
                        logger.logSuccess('📤 RESPOSTA ENVIADA', {
                            to: from.replace('@s.whatsapp.net', ''),
                            response_length: processedContent.length,
                            media_type: mediaType
                        });
                    }
                    
                } catch (error) {
                    logger.logError('❌ ERRO GERAL NO PROCESSAMENTO', error, {
                        from: from,
                        message_type: mediaType
                    });
                    
                    try {
                        await sock.sendMessage(from, { 
                            text: "❌ Desculpe, ocorreu um erro interno. Tente novamente em alguns instantes." 
                        });
                    } catch (sendError) {
                        logger.logError('❌ ERRO AO ENVIAR MENSAGEM DE ERRO', sendError);
                    }
                }
            }
        });
        
    } catch (error) {
        logger.logError('❌ ERRO CRÍTICO NO WHATSAPP', error);
        console.error('❌ Erro crítico:', error);
        
        // Tenta reconectar após 10 segundos
        setTimeout(startWhatsApp, 10000);
    }
}

// Inicializar o bot
startWhatsApp();

