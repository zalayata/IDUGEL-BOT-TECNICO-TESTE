require('dotenv').config();

if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { OpenAI } = require('openai');
const path = require('path');
const fs = require('fs');

// ===== VERSÃO MULTIMODAL COM FORMATAÇÃO INTELIGENTE =====

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
            'MEDIA': '\x1b[35m',        // Magenta
            'FORMAT': '\x1b[96m'        // Bright Cyan
        };

        const color = colors[type] || '\x1b[0m';
        const reset = '\x1b[0m';
        console.log(`${color}[${type}]${reset} ${JSON.stringify(logEntry, null, 2)}`);

        // Log no arquivo
        try {
            const fileEntry = `\n[${timestamp}] ${type}\n${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
            fs.appendFileSync(LOG_FILE, fileEntry);
        } catch (err) {
            console.error('❌ Erro ao salvar log:', err);
        }
    }

    logConversation(action, user, question, answer, threadId, details = {}) {
        this.log('CONVERSATION', {
            action,
            user: user.replace('@s.whatsapp.net', ''),
            question,
            answer: answer.substring(0, 500) + (answer.length > 500 ? '...' : ''),
            answer_length: answer.length,
            thread_id: threadId,
            processing_time_ms: details.processingTime,
            processing_time_readable: `${(details.processingTime / 1000).toFixed(2)}s`,
            media_type: details.mediaType
        });
    }

    logFormat(action, details = {}) {
        this.log('FORMAT', {
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
        // Remove citações numéricas: 【número】, [número], (número)
        .replace(/【\d+】/g, '')
        .replace(/【\d+:\d+】/g, '')
        .replace(/\[\d+\]/g, '')
        .replace(/\[\d+:\d+\]/g, '')
        .replace(/\(\d+\)/g, '')
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
        .replace(/\. ([A-ZÁÊÇÕ])/g, '.\n\n$1')
        // Adiciona espaçamento após dois pontos seguidos de texto
        .replace(/: ([A-ZÁÊÇÕ])/g, ':\n\n$1')
        // Organiza listas com bullets
        .replace(/^- /gm, '• ')
        // Quebra antes de URLs para ficarem em linha separada
        .replace(/([.!?]) (https?:\/\/[^\s]+)/g, '$1\n\n$2')
        // Quebra antes de emails
        .replace(/([.!?]) ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '$1\n\n$2')
        // Quebra antes de números de telefone
        .replace(/([.!?]) (\+\d{2}\d{8,})/g, '$1\n\n$2')
        // Quebra antes de perguntas para o usuário
        .replace(/([.!?]) (Como posso|Posso|Gostaria|Deseja|Precisa)/g, '$1\n\n$2')
        // Espaça frases de encerramento
        .replace(/(Obrigad[oa]|Atenciosamente|Cordialmente)\./g, '\n\n$1.')
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

// Funções de processamento de mídia
async function processImage(imagePath, caption = '') {
    try {
        logger.logMedia('Iniciando processamento de imagem', '', 'image', { 
            path: imagePath, 
            caption: caption 
        });

        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');
        
        const response = await openai.chat.completions.create({
            model: "gpt-4-vision-preview",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: caption ? 
                                `Analise esta imagem. Contexto adicional: ${caption}` : 
                                "Analise esta imagem e descreva o que você vê de forma detalhada."
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
        logger.logMedia('Imagem processada com sucesso', '', 'image', { 
            analysis_length: analysis.length 
        });

        return `🖼️ *Análise da imagem:*\n\n${analysis}`;
    } catch (error) {
        logger.logError('Erro ao processar imagem', error, { path: imagePath });
        return "❌ Desculpe, não consegui processar esta imagem. Tente enviar novamente.";
    }
}

async function processAudio(audioPath) {
    try {
        logger.logMedia('Iniciando processamento de áudio', '', 'audio', { 
            path: audioPath 
        });

        const audioBuffer = fs.readFileSync(audioPath);
        
        const response = await openai.audio.transcriptions.create({
            file: new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' }),
            model: "whisper-1",
            language: "pt"
        });

        const transcription = response.text;
        logger.logMedia('Áudio transcrito com sucesso', '', 'audio', { 
            transcription_length: transcription.length 
        });

        return `🎵 *Transcrição do áudio:* "${transcription}"`;
    } catch (error) {
        logger.logError('Erro ao processar áudio', error, { path: audioPath });
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
        const response = await openai.beta.threads.runs.retrieve(cleanThreadId, String(runId));
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

// Função principal de processamento
async function processAIMessage(from, messageText, mediaType = 'text') {
    const startTime = Date.now();
    
    try {
        logger.logInfo('Iniciando processamento de mensagem', { 
            from: from.replace('@s.whatsapp.net', ''),
            message_length: messageText.length,
            media_type: mediaType
        });

        let threadId = threadManager.getThreadId(from);
        
        if (!threadId) {
            logger.logThread('Criando nova thread', from, null);
            threadId = await createNewThread();
            threadManager.setThreadId(from, threadId);
        } else {
            logger.logThread('Usando thread existente', from, threadId);
        }

        await addMessageToThread(threadId, messageText);
        const run = await createRun(threadId);
        
        // Aguarda conclusão do run
        let runStatus = await retrieveRunStatus(threadId, run.id);
        let attempts = 0;
        const maxAttempts = 30;
        
        while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
            attempts++;
            if (attempts > maxAttempts) {
                throw new Error('Timeout: Run demorou muito para completar');
            }
            
            logger.logInfo('Aguardando conclusão do run', { 
                attempt: attempts,
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
        
        logger.logConversation('Resposta processada', from, messageText, reply, threadId, {
            processingTime,
            mediaType
        });

        return reply;
        
    } catch (error) {
        logger.logError('Erro no processamento de mensagem', error, { 
            from: from.replace('@s.whatsapp.net', ''),
            messageText: messageText.substring(0, 100)
        });
        
        // Remove thread corrompida em caso de erro
        threadManager.removeThread(from);
        
        return "❌ Desculpe, estou com dificuldades técnicas. Tente novamente em alguns segundos.";
    }
}

// Configuração do Express
const app = express();
app.use(express.static(path.join(__dirname, '../public')));

// Estatísticas
let stats = {
    conversations: 0,
    errors: 0,
    threads: 0,
    media_processed: 0,
    uptime: Date.now()
};

// Rotas
app.get('/', (req, res) => {
    const qrCodeHtml = `
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>IAIDUGEL WhatsApp Bot - Grupo Idugel</title>
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
                    align-items: center;
                    justify-content: center;
                    color: white;
                }
                
                .container {
                    text-align: center;
                    background: rgba(255, 255, 255, 0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 40px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    max-width: 500px;
                    width: 90%;
                }
                
                .logo {
                    width: 100px;
                    height: 100px;
                    border-radius: 50%;
                    margin: 0 auto 20px;
                    background: linear-gradient(45deg, #4facfe 0%, #00f2fe 100%);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 36px;
                    font-weight: bold;
                    color: white;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                    border: 4px solid white;
                    object-fit: cover;
                    overflow: hidden;
                }
                
                .logo img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    border-radius: 50%;
                }
                
                .logo img:error {
                    display: none;
                }
                
                h1 {
                    font-size: 28px;
                    margin-bottom: 10px;
                    background: linear-gradient(45deg, #fff, #f0f0f0);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                
                .subtitle {
                    font-size: 16px;
                    margin-bottom: 30px;
                    opacity: 0.9;
                }
                
                .qr-container {
                    background: white;
                    border-radius: 15px;
                    padding: 20px;
                    margin: 20px 0;
                    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                }
                
                #qrcode {
                    margin: 0 auto;
                }
                
                .status {
                    margin: 20px 0;
                    padding: 15px;
                    border-radius: 10px;
                    background: rgba(255, 255, 255, 0.1);
                    border-left: 4px solid #4facfe;
                }
                
                .features {
                    text-align: left;
                    margin: 20px 0;
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 10px;
                    padding: 20px;
                }
                
                .features h3 {
                    color: #4facfe;
                    margin-bottom: 15px;
                    text-align: center;
                }
                
                .features ul {
                    list-style: none;
                }
                
                .features li {
                    margin: 8px 0;
                    padding-left: 20px;
                    position: relative;
                }
                
                .features li:before {
                    content: "✨";
                    position: absolute;
                    left: 0;
                }
                
                .instructions {
                    background: rgba(255, 255, 255, 0.1);
                    border-radius: 10px;
                    padding: 20px;
                    margin: 20px 0;
                    border-left: 4px solid #00f2fe;
                }
                
                .footer {
                    margin-top: 30px;
                    font-size: 14px;
                    opacity: 0.8;
                }
                
                .links {
                    margin: 20px 0;
                }
                
                .links a {
                    color: #4facfe;
                    text-decoration: none;
                    margin: 0 10px;
                    padding: 8px 16px;
                    border: 1px solid #4facfe;
                    border-radius: 20px;
                    transition: all 0.3s ease;
                    display: inline-block;
                    margin-bottom: 10px;
                }
                
                .links a:hover {
                    background: #4facfe;
                    color: white;
                    transform: translateY(-2px);
                }
                
                .pulse {
                    animation: pulse 2s infinite;
                }
                
                @keyframes pulse {
                    0% { transform: scale(1); }
                    50% { transform: scale(1.05); }
                    100% { transform: scale(1); }
                }
                
                @media (max-width: 600px) {
                    .container {
                        padding: 20px;
                        margin: 20px;
                    }
                    
                    .logo {
                        width: 80px;
                        height: 80px;
                        font-size: 28px;
                    }
                    
                    h1 {
                        font-size: 24px;
                    }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="logo pulse">
                    <img src="/logo-idugel.jpg" alt="Logo Grupo Idugel" onerror="this.style.display='none'; this.parentElement.innerHTML='IG';" />
                </div>
                
                <h1>IAIDUGEL</h1>
                <div class="subtitle">Assistente Inteligente Multimodal</div>
                
                <div class="status">
                    <strong>🔄 Status:</strong> <span id="status">Carregando...</span>
                </div>
                
                <div class="qr-container">
                    <div id="qrcode">Gerando QR Code...</div>
                </div>
                
                <div class="instructions">
                    <strong>📱 Como conectar:</strong><br>
                    1. Abra o WhatsApp no seu celular<br>
                    2. Toque em "Dispositivos conectados"<br>
                    3. Toque em "Conectar um dispositivo"<br>
                    4. Escaneie o QR Code acima
                </div>
                
                <div class="features">
                    <h3>🚀 Tecnologia Grupo Idugel</h3>
                    <ul>
                        <li>IA Avançada com GPT-4</li>
                        <li>Processamento de Imagens</li>
                        <li>Transcrição de Áudios</li>
                        <li>Formatação Inteligente</li>
                        <li>Arquitetura Robusta</li>
                        <li>Segurança e Validação</li>
                        <li>Disponibilidade 24/7</li>
                        <li>Sistema Multi-thread</li>
                        <li>Filtro Inteligente</li>
                        <li>Logs Avançados</li>
                    </ul>
                </div>
                
                <div class="links">
                    <a href="/stats" target="_blank">📊 Estatísticas</a>
                    <a href="/logs" target="_blank">📋 Logs</a>
                </div>
                
                <div class="footer">
                    <strong>Grupo Idugel</strong><br>
                    Tecnologia e Inovação em IA
                </div>
            </div>
            
            <script>
                function updateStatus() {
                    fetch('/status')
                        .then(response => response.json())
                        .then(data => {
                            document.getElementById('status').textContent = data.status;
                            if (data.qr) {
                                document.getElementById('qrcode').innerHTML = data.qr;
                            }
                        })
                        .catch(() => {
                            document.getElementById('status').textContent = 'Erro de conexão';
                        });
                }
                
                updateStatus();
                setInterval(updateStatus, 5000);
            </script>
        </body>
        </html>
    `;
    res.send(qrCodeHtml);
});

app.get('/status', (req, res) => {
    res.json({ 
        status: global.connectionStatus || 'Inicializando...',
        qr: global.qrCode || null
    });
});

app.get('/stats', (req, res) => {
    const uptime = Date.now() - stats.uptime;
    const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
    const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    
    const logSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    
    res.json({
        ...stats,
        threads_active: Object.keys(threadManager.threads).length,
        uptime_readable: `${uptimeHours}h ${uptimeMinutes}m`,
        log_file_size: `${(logSize / 1024).toFixed(2)} KB`,
        timestamp: new Date().toISOString()
    });
});

app.get('/logs', (req, res) => {
    if (fs.existsSync(LOG_FILE)) {
        res.download(LOG_FILE, 'idugel-conversations.log');
    } else {
        res.status(404).send('Arquivo de log não encontrado');
    }
});

// Inicialização do WhatsApp
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(process.env.SESSION_DATA_PATH || './config/session');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: { level: 'silent', child: () => ({ level: 'silent' }) }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            require('qrcode').toDataURL(qr, (err, url) => {
                if (!err) {
                    global.qrCode = `<img src="${url}" style="max-width: 100%; height: auto;" />`;
                    global.connectionStatus = 'QR Code gerado! Escaneie para conectar.';
                    console.log('🔐 QR Code gerado! Acesse a página web para escanear.');
                }
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('📴 Conexão fechada devido a:', lastDisconnect?.error, ', reconectando:', shouldReconnect);
            global.connectionStatus = 'Desconectado - Tentando reconectar...';
            
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
                // Verifica se é uma mensagem de texto
                if (message.message.conversation) {
                    messageText = message.message.conversation;
                    processedContent = messageText;
                } 
                else if (message.message.extendedTextMessage) {
                    messageText = message.message.extendedTextMessage.text;
                    processedContent = messageText;
                }
                // Verifica se é uma imagem
                else if (message.message.imageMessage) {
                    mediaType = 'image';
                    const caption = message.message.imageMessage.caption || '';
                    
                    logger.logMedia('Imagem recebida', from, 'image', { caption });
                    
                    try {
                        const buffer = await downloadMediaMessage(message, 'buffer', {});
                        const imagePath = path.join(MEDIA_DIR, `image_${Date.now()}.jpg`);
                        fs.writeFileSync(imagePath, buffer);
                        
                        processedContent = await processImage(imagePath, caption);
                        stats.media_processed++;
                        
                        // Limpa arquivo temporário
                        fs.unlinkSync(imagePath);
                    } catch (error) {
                        logger.logError('Erro ao processar imagem', error, { from });
                        processedContent = "❌ Erro ao processar imagem. Tente novamente.";
                    }
                }
                // Verifica se é um áudio
                else if (message.message.audioMessage) {
                    mediaType = 'audio';
                    
                    logger.logMedia('Áudio recebido', from, 'audio');
                    
                    try {
                        const buffer = await downloadMediaMessage(message, 'buffer', {});
                        const audioPath = path.join(MEDIA_DIR, `audio_${Date.now()}.ogg`);
                        fs.writeFileSync(audioPath, buffer);
                        
                        const transcription = await processAudio(audioPath);
                        processedContent = transcription;
                        
                        // Processa a transcrição como mensagem normal
                        const transcribedText = transcription.replace('🎵 *Transcrição do áudio:* "', '').replace('"', '');
                        messageText = transcribedText;
                        stats.media_processed++;
                        
                        // Limpa arquivo temporário
                        fs.unlinkSync(audioPath);
                    } catch (error) {
                        logger.logError('Erro ao processar áudio', error, { from });
                        processedContent = "❌ Erro ao processar áudio. Tente novamente.";
                        messageText = processedContent;
                    }
                }
                else {
                    // Tipo de mensagem não suportado
                    logger.logInfo('Tipo de mensagem não suportado', { 
                        from: from.replace('@s.whatsapp.net', ''),
                        messageType: Object.keys(message.message)[0]
                    });
                    return;
                }

                console.log(`📩 Mensagem de ${from}: ${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}`);
                console.log(`🤖 Processando mensagem IA para ${from}`);

                // Processa com IA apenas se for texto ou transcrição de áudio
                let reply;
                if (mediaType === 'text' || mediaType === 'audio') {
                    reply = await processAIMessage(from, messageText, mediaType);
                    
                    // Para áudio, adiciona a transcrição antes da resposta
                    if (mediaType === 'audio') {
                        reply = `${processedContent}\n\n${reply}`;
                    }
                } else {
                    // Para imagens, usa o resultado do processamento direto
                    reply = processedContent;
                }

                await sock.sendMessage(from, { text: reply });
                console.log('✅ Resposta enviada com sucesso');
                
                stats.conversations++;

            } catch (error) {
                logger.logError('Erro no processamento geral', error, { from, messageText });
                
                const errorReply = "❌ Desculpe, estou com dificuldades técnicas. Tente novamente em alguns segundos.";
                await sock.sendMessage(from, { text: errorReply });
                
                stats.errors++;
            }
        }
    });

    return sock;
}

// Inicialização
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
    logger.logInfo('Servidor iniciado', { port: PORT });
});

startWhatsApp().catch(error => {
    logger.logError('Erro ao iniciar WhatsApp', error);
    console.error('❌ Erro ao iniciar:', error);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (error) => {
    logger.logError('Erro não tratado', error);
    console.error('❌ Erro não tratado:', error);
});

process.on('uncaughtException', (error) => {
    logger.logError('Exceção não capturada', error);
    console.error('❌ Exceção não capturada:', error);
});

