const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// Configuração da OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Logger personalizado compatível com Baileys
class ConversationLogger {
    constructor() {
        this.logFile = path.join(__dirname, 'conversation.log');
    }

    log(level, action, message = '', user = '', mediaType = '', additionalData = {}) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            action,
            user,
            message: typeof message === 'string' ? message : JSON.stringify(message),
            media_type: mediaType,
            ...additionalData
        };

        // Log para console
        console.log(`[${timestamp}] ${level.toUpperCase()}: ${JSON.stringify(logEntry, null, 2)}`);

        // Log para arquivo
        try {
            fs.appendFileSync(this.logFile, JSON.stringify(logEntry) + '\n');
        } catch (error) {
            console.error('Erro ao escrever no arquivo de log:', error);
        }
    }

    logConversation(action, user, message, additionalData = {}) {
        this.log('CONVERSATION', action, message, user, '', additionalData);
    }

    logThread(action, user, threadId, additionalData = {}) {
        this.log('THREAD', action, `Thread: ${threadId}`, user, '', additionalData);
    }

    logError(action, error, user = '', additionalData = {}) {
        this.log('ERROR', action, error.message || error, user, '', {
            stack: error.stack,
            ...additionalData
        });
    }

    logSuccess(action, message, user = '', additionalData = {}) {
        this.log('SUCCESS', action, message, user, '', additionalData);
    }

    logInfo(action, message, additionalData = {}) {
        this.log('INFO', action, message, '', '', additionalData);
    }

    logMedia(action, user, mediaType, additionalData = {}) {
        this.log('MEDIA', action, '', user, mediaType, additionalData);
    }

    logFormat(action, originalText, formattedText, user = '') {
        this.log('FORMAT', action, '', user, '', {
            original_length: originalText.length,
            formatted_length: formattedText.length,
            original_preview: originalText.substring(0, 100),
            formatted_preview: formattedText.substring(0, 100)
        });
    }

    // Métodos compatíveis com Baileys
    trace(message, ...args) {
        this.logInfo('BAILEYS_TRACE', message, { args });
    }

    debug(message, ...args) {
        this.logInfo('BAILEYS_DEBUG', message, { args });
    }

    info(message, ...args) {
        this.logInfo('BAILEYS_INFO', message, { args });
    }

    warn(message, ...args) {
        this.log('WARN', 'BAILEYS_WARN', message, '', '', { args });
    }

    error(message, ...args) {
        this.log('ERROR', 'BAILEYS_ERROR', message, '', '', { args });
    }

    fatal(message, ...args) {
        this.log('ERROR', 'BAILEYS_FATAL', message, '', '', { args });
    }

    child() {
        return this;
    }
}

// Instância global do logger
const logger = new ConversationLogger();

// Gerenciador de threads
class ThreadManager {
    constructor() {
        this.threads = new Map();
        this.threadFile = path.join(__dirname, 'threads.json');
        this.loadThreads();
    }

    loadThreads() {
        try {
            if (fs.existsSync(this.threadFile)) {
                const data = fs.readFileSync(this.threadFile, 'utf8');
                const threadsData = JSON.parse(data);
                
                // Validar e limpar dados corrompidos
                for (const [userId, threadData] of Object.entries(threadsData)) {
                    if (threadData && typeof threadData === 'object' && threadData.threadId) {
                        this.threads.set(userId, threadData);
                    } else {
                        logger.logError('THREAD_LOAD_ERROR', new Error(`Dados corrompidos para usuário ${userId}`), userId);
                    }
                }
                
                logger.logSuccess('THREADS_LOADED', `${this.threads.size} threads carregadas`);
            }
        } catch (error) {
            logger.logError('THREAD_LOAD_ERROR', error);
            this.threads = new Map();
        }
    }

    saveThreads() {
        try {
            const threadsData = Object.fromEntries(this.threads);
            fs.writeFileSync(this.threadFile, JSON.stringify(threadsData, null, 2));
            logger.logSuccess('THREADS_SAVED', `${this.threads.size} threads salvas`);
        } catch (error) {
            logger.logError('THREAD_SAVE_ERROR', error);
        }
    }

    getThread(userId) {
        return this.threads.get(userId);
    }

    setThread(userId, threadId, runId = null) {
        const threadData = {
            threadId,
            runId,
            createdAt: new Date().toISOString(),
            lastUsed: new Date().toISOString()
        };
        
        this.threads.set(userId, threadData);
        this.saveThreads();
        logger.logThread('THREAD_SET', userId, threadId, { runId });
        return threadData;
    }

    updateLastUsed(userId) {
        const thread = this.threads.get(userId);
        if (thread) {
            thread.lastUsed = new Date().toISOString();
            this.saveThreads();
        }
    }

    clearThread(userId) {
        this.threads.delete(userId);
        this.saveThreads();
        logger.logThread('THREAD_CLEARED', userId, 'N/A');
    }

    isFirstInteraction(userId) {
        return !this.threads.has(userId);
    }
}

// Instância global do gerenciador de threads
const threadManager = new ThreadManager();

// Função para processar imagem
async function processImage(imagePath, caption = '') {
    try {
        logger.logMedia('🖼️ INICIANDO PROCESSAMENTO DE IMAGEM', '', 'image', {
            path: imagePath,
            caption: caption
        });

        // Verificar se o arquivo existe
        if (!fs.existsSync(imagePath)) {
            throw new Error(`Arquivo de imagem não encontrado: ${imagePath}`);
        }

        // Ler o arquivo de imagem
        const imageBuffer = fs.readFileSync(imagePath);
        
        if (!imageBuffer || imageBuffer.length === 0) {
            throw new Error('Buffer de imagem vazio');
        }

        logger.logMedia('📁 ARQUIVO LIDO COM SUCESSO', '', 'image', {
            buffer_size: imageBuffer.length
        });

        // Converter para base64
        const base64Image = imageBuffer.toString('base64');
        
        logger.logMedia('🔄 CONVERSÃO BASE64 CONCLUÍDA', '', 'image', {
            base64_preview: base64Image.substring(0, 50) + '...',
            base64_size: base64Image.length
        });

        // Preparar prompt
        const prompt = caption || "Analise esta imagem e descreva o que você vê de forma detalhada.";

        logger.logMedia('🤖 ENVIANDO PARA GPT-4O', '', 'image', {
            prompt: prompt,
            model: 'gpt-4o',
            max_tokens: 500
        });

        // Enviar para GPT-4o
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/jpeg;base64,${base64Image}`
                        }
                    }
                ]
            }],
            max_tokens: 500
        });

        const analysis = response.choices[0].message.content;
        
        logger.logMedia('✅ ANÁLISE DE IMAGEM CONCLUÍDA', '', 'image', {
            analysis_length: analysis.length,
            analysis_preview: analysis.substring(0, 100) + '...'
        });

        // Limpar arquivo temporário
        try {
            fs.unlinkSync(imagePath);
            logger.logMedia('🗑️ ARQUIVO TEMPORÁRIO REMOVIDO', '', 'image', {
                path: imagePath
            });
        } catch (cleanupError) {
            logger.logError('CLEANUP_ERROR', cleanupError, '', { path: imagePath });
        }

        return analysis;

    } catch (error) {
        logger.logError('❌ ERRO NO PROCESSAMENTO DE IMAGEM', error, '', {
            path: imagePath
        });
        return "❌ Desculpe, não consegui processar esta imagem. Tente enviar novamente.";
    }
}

// Função para processar áudio
async function processAudio(audioPath) {
    try {
        logger.logMedia('🎵 INICIANDO PROCESSAMENTO DE ÁUDIO', '', 'audio', {
            path: audioPath
        });

        // Verificar se o arquivo existe
        if (!fs.existsSync(audioPath)) {
            throw new Error(`Arquivo de áudio não encontrado: ${audioPath}`);
        }

        // Ler o arquivo de áudio
        const audioBuffer = fs.readFileSync(audioPath);
        
        if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error('Buffer de áudio vazio');
        }

        logger.logMedia('📁 ARQUIVO DE ÁUDIO LIDO', '', 'audio', {
            buffer_size: audioBuffer.length
        });

        logger.logMedia('🤖 ENVIANDO PARA WHISPER', '', 'audio', {
            model: 'whisper-1'
        });

        // Transcrever com Whisper
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: "whisper-1",
            language: "pt"
        });

        logger.logMedia('✅ TRANSCRIÇÃO CONCLUÍDA', '', 'audio', {
            transcription_length: transcription.text.length,
            transcription_preview: transcription.text.substring(0, 100) + '...'
        });

        // Limpar arquivo temporário
        try {
            fs.unlinkSync(audioPath);
            logger.logMedia('🗑️ ARQUIVO TEMPORÁRIO REMOVIDO', '', 'audio', {
                path: audioPath
            });
        } catch (cleanupError) {
            logger.logError('CLEANUP_ERROR', cleanupError, '', { path: audioPath });
        }

        return transcription.text;

    } catch (error) {
        logger.logError('❌ ERRO NO PROCESSAMENTO DE ÁUDIO', error, '', {
            path: audioPath
        });
        return "❌ Desculpe, não consegui processar este áudio. Tente enviar novamente.";
    }
}

// Função para formatar texto para WhatsApp
function formatForWhatsApp(text) {
    logger.logFormat('🔄 INICIANDO FORMATAÇÃO', text, '');
    
    let formatted = text
        // Remover citações desnecessárias
        .replace(/【\d+:\d+†[^】]*】/g, '')
        .replace(/\*\*([^*]+)\*\*/g, '*$1*')
        .replace(/### /g, '*')
        .replace(/## /g, '*')
        .replace(/# /g, '*')
        // Limitar linhas em branco
        .replace(/\n{3,}/g, '\n\n')
        // Remover espaços extras
        .trim();

    logger.logFormat('✅ FORMATAÇÃO CONCLUÍDA', text, formatted);
    return formatted;
}

// Função para criar thread
async function createThread() {
    try {
        logger.logThread('🧵 CRIANDO NOVA THREAD', '', 'N/A');
        const thread = await openai.beta.threads.create();
        logger.logThread('✅ THREAD CRIADA', '', thread.id);
        return thread.id;
    } catch (error) {
        logger.logError('❌ ERRO AO CRIAR THREAD', error);
        throw error;
    }
}

// Função para adicionar mensagem à thread
async function addMessage(threadId, content, userId) {
    try {
        logger.logThread('📝 ADICIONANDO MENSAGEM À THREAD', userId, threadId, {
            content_length: content.length,
            content_preview: content.substring(0, 100) + '...'
        });

        await openai.beta.threads.messages.create(threadId, {
            role: "user",
            content: content
        });

        logger.logThread('✅ MENSAGEM ADICIONADA À THREAD', userId, threadId);
    } catch (error) {
        logger.logError('❌ ERRO AO ADICIONAR MENSAGEM', error, userId, { threadId });
        throw error;
    }
}

// Função para executar assistente
async function createRun(threadId, userId) {
    try {
        const assistantId = String(process.env.OPENAI_ASSISTANT_ID);
        
        logger.logThread('🤖 INICIANDO EXECUÇÃO DO ASSISTENTE', userId, threadId, {
            assistant_id: assistantId
        });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: assistantId
        });

        logger.logThread('✅ EXECUÇÃO INICIADA', userId, threadId, {
            run_id: run.id,
            status: run.status
        });

        return run.id;
    } catch (error) {
        logger.logError('❌ ERRO AO EXECUTAR ASSISTENTE', error, userId, { threadId });
        throw error;
    }
}

// Função para aguardar conclusão
async function waitForCompletion(threadId, runId, userId) {
    try {
        logger.logThread('⏳ AGUARDANDO CONCLUSÃO', userId, threadId, { run_id: runId });

        while (true) {
            const run = await openai.beta.threads.runs.retrieve(threadId, runId);
            
            logger.logThread('🔄 STATUS DA EXECUÇÃO', userId, threadId, {
                run_id: runId,
                status: run.status
            });

            if (run.status === 'completed') {
                logger.logThread('✅ EXECUÇÃO CONCLUÍDA', userId, threadId, { run_id: runId });
                break;
            } else if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'expired') {
                throw new Error(`Execução falhou com status: ${run.status}`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (error) {
        logger.logError('❌ ERRO NA EXECUÇÃO', error, userId, { threadId, runId });
        throw error;
    }
}

// Função para obter resposta
async function getResponse(threadId, userId) {
    try {
        logger.logThread('📥 OBTENDO RESPOSTA', userId, threadId);

        const messages = await openai.beta.threads.messages.list(threadId);
        const lastMessage = messages.data[0];

        if (lastMessage && lastMessage.role === 'assistant') {
            const content = lastMessage.content[0].text.value;
            
            logger.logThread('✅ RESPOSTA OBTIDA', userId, threadId, {
                response_length: content.length,
                response_preview: content.substring(0, 100) + '...'
            });

            return content;
        }

        throw new Error('Nenhuma resposta do assistente encontrada');
    } catch (error) {
        logger.logError('❌ ERRO AO OBTER RESPOSTA', error, userId, { threadId });
        throw error;
    }
}

// Função principal para processar mensagem
async function processMessage(content, userId) {
    try {
        logger.logConversation('🚀 INICIANDO PROCESSAMENTO', userId, content);

        let threadData = threadManager.getThread(userId);
        let threadId;

        if (!threadData) {
            // Primeira interação - criar nova thread
            threadId = await createThread();
            threadManager.setThread(userId, threadId);
            
            // Adicionar contexto para primeira interação
            const contextMessage = `Esta é a primeira interação com este usuário. ${content}`;
            await addMessage(threadId, contextMessage, userId);
        } else {
            // Conversa existente - usar thread existente
            threadId = threadData.threadId;
            threadManager.updateLastUsed(userId);
            
            // Adicionar instrução para não se apresentar novamente
            const continuationMessage = `Continuando nossa conversa (não se apresente novamente): ${content}`;
            await addMessage(threadId, continuationMessage, userId);
        }

        const runId = await createRun(threadId, userId);
        await waitForCompletion(threadId, runId, userId);
        const response = await getResponse(threadId, userId);

        logger.logConversation('✅ PROCESSAMENTO CONCLUÍDO', userId, response);

        return formatForWhatsApp(response);
    } catch (error) {
        logger.logError('❌ ERRO NO PROCESSAMENTO', error, userId);
        return "❌ Desculpe, ocorreu um erro. Tente novamente em alguns instantes.";
    }
}

// Configuração do cliente WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
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

// Variáveis globais para interface web
global.qrCode = '';
global.isReady = false;
global.stats = {
    messages: 0,
    images: 0,
    audios: 0,
    uptime: Date.now()
};

// Eventos do cliente
client.on('qr', async (qr) => {
    try {
        logger.logInfo('🔐 QR Code gerado! Acesse a página web para escanear.');
        
        const qrCodeDataURL = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            quality: 0.92,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });

        global.qrCode = `
            <div style="text-align: center; padding: 20px;">
                <h3 style="color: #333; margin-bottom: 20px;">📱 Escaneie o QR Code</h3>
                <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); display: inline-block;">
                    <img src="${qrCodeDataURL}" style="width: 400px; height: 400px;" />
                </div>
                <p style="color: #666; margin-top: 20px;">Abra o WhatsApp → Menu → Dispositivos conectados</p>
            </div>
        `;
    } catch (error) {
        logger.logError('QR_CODE_ERROR', error);
        global.qrCode = '<p style="color: red;">Erro ao gerar QR Code</p>';
    }
});

client.on('ready', () => {
    global.isReady = true;
    global.qrCode = '<p style="color: green;">✅ WhatsApp conectado com sucesso!</p>';
    logger.logSuccess('WHATSAPP_READY', 'Cliente WhatsApp pronto para uso');
});

client.on('authenticated', () => {
    logger.logSuccess('WHATSAPP_AUTH', 'WhatsApp autenticado com sucesso');
});

client.on('auth_failure', (msg) => {
    logger.logError('WHATSAPP_AUTH_FAILURE', new Error(msg));
});

client.on('disconnected', (reason) => {
    logger.logError('WHATSAPP_DISCONNECTED', new Error(reason));
    global.isReady = false;
});

// Event listener para mensagens
client.on('message', async (message) => {
    try {
        const userId = message.from;
        
        logger.logConversation('📨 MENSAGEM RECEBIDA', userId, '', {
            type: message.type,
            hasMedia: message.hasMedia,
            timestamp: message.timestamp
        });

        // Verificar se é mensagem de grupo (ignorar)
        if (message.from.includes('@g.us')) {
            logger.logConversation('👥 MENSAGEM DE GRUPO IGNORADA', userId, '');
            return;
        }

        // Processar diferentes tipos de mídia
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            
            if (message.type === 'image') {
                logger.logMedia('🖼️ IMAGEM DETECTADA', userId, 'image');
                
                logger.logMedia('📥 INICIANDO DOWNLOAD DA IMAGEM', userId, 'image');
                
                if (!media || !media.data) {
                    throw new Error('Falha no download da mídia');
                }

                const buffer = Buffer.from(media.data, 'base64');
                
                if (!buffer || buffer.length === 0) {
                    throw new Error('Buffer de imagem vazio');
                }

                logger.logMedia('✅ DOWNLOAD DA IMAGEM CONCLUÍDO', userId, 'image', {
                    buffer_size: buffer.length,
                    mimetype: media.mimetype
                });

                // Salvar temporariamente
                const tempDir = path.join(__dirname, 'media');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                const imagePath = path.join(tempDir, `image_${Date.now()}.jpg`);
                fs.writeFileSync(imagePath, buffer);

                logger.logMedia('💾 IMAGEM SALVA TEMPORARIAMENTE', userId, 'image', {
                    path: imagePath
                });

                // Processar imagem
                const imageAnalysis = await processImage(imagePath, message.body);
                
                // Enviar análise para o assistente processar
                const prompt = `Baseado na análise da imagem a seguir, forneça uma resposta útil e contextualizada para o usuário:

Análise da imagem: ${imageAnalysis}

Mensagem do usuário: ${message.body || 'Usuário enviou uma imagem'}

Forneça uma resposta natural e útil baseada no conteúdo da imagem.`;

                const response = await processMessage(prompt, userId);
                await message.reply(response);

                global.stats.images++;
                logger.logMedia('🎯 PROCESSAMENTO DE IMAGEM FINALIZADO', userId, 'image', {
                    result_length: response.length
                });

            } else if (message.type === 'ptt' || message.type === 'audio') {
                logger.logMedia('🎵 ÁUDIO DETECTADO', userId, 'audio');
                
                logger.logMedia('📥 INICIANDO DOWNLOAD DO ÁUDIO', userId, 'audio');
                
                if (!media || !media.data) {
                    throw new Error('Falha no download da mídia');
                }

                const buffer = Buffer.from(media.data, 'base64');
                
                if (!buffer || buffer.length === 0) {
                    throw new Error('Buffer de áudio vazio');
                }

                logger.logMedia('✅ DOWNLOAD DO ÁUDIO CONCLUÍDO', userId, 'audio', {
                    buffer_size: buffer.length,
                    mimetype: media.mimetype
                });

                // Salvar temporariamente
                const tempDir = path.join(__dirname, 'media');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                const audioPath = path.join(tempDir, `audio_${Date.now()}.ogg`);
                fs.writeFileSync(audioPath, buffer);

                logger.logMedia('💾 ÁUDIO SALVO TEMPORARIAMENTE', userId, 'audio', {
                    path: audioPath
                });

                // Processar áudio
                const transcription = await processAudio(audioPath);
                const response = await processMessage(transcription, userId);
                await message.reply(response);

                global.stats.audios++;
                logger.logMedia('🎯 PROCESSAMENTO DE ÁUDIO FINALIZADO', userId, 'audio', {
                    transcription_length: transcription.length,
                    result_length: response.length
                });
            }
        } else {
            // Mensagem de texto
            logger.logConversation('📝 MENSAGEM DE TEXTO DETECTADA', userId, message.body);
            
            const response = await processMessage(message.body, userId);
            await message.reply(response);

            global.stats.messages++;
            logger.logConversation('✅ RESPOSTA ENVIADA', userId, response);
        }

    } catch (error) {
        logger.logError('MESSAGE_PROCESSING_ERROR', error, message.from);
        await message.reply("❌ Desculpe, ocorreu um erro ao processar sua mensagem. Tente novamente.");
    }
});

// Servidor HTTP para interface web
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    
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
                         onerror="this.style.display='none'; this.parentNode.innerHTML='IG';" />
                </div>
                <h1>IAIDUGEL</h1>
                <div class="subtitle">Tecnologia Grupo Idugel</div>
            </div>
            
            <div class="content">
                <div class="status">
                    ${global.isReady ? '✅ Sistema Online e Funcionando' : '🔄 Conectando ao WhatsApp...'}
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
                    ${global.qrCode || '<p>Aguardando QR Code...</p>'}
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
                <p>© 2024 IAIDUGEL - Tecnologia Grupo Idugel</p>
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
    
    res.end(html);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor HTTP na porta ${PORT}`);
    logger.logSuccess('HTTP_SERVER_STARTED', `Servidor HTTP iniciado na porta ${PORT}`, '', { port: PORT });
});

// Inicializar cliente WhatsApp
logger.logInfo('🚀 Iniciando cliente WhatsApp...');
client.initialize();

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
    logger.logError('UNHANDLED_REJECTION', new Error(reason), '', { promise });
});

process.on('uncaughtException', (error) => {
    logger.logError('UNCAUGHT_EXCEPTION', error);
    process.exit(1);
});

