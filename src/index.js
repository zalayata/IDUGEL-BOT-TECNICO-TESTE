// 🎯 CORREÇÃO ESPECÍFICA PARA PROCESSAMENTO DE IMAGEM
// Baseado no bot que funciona corretamente

// 1. SUBSTITUIR A FUNÇÃO processImage por esta versão:

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

        // 🎯 DIFERENÇA PRINCIPAL: Retorna apenas a análise, sem formatação extra
        return analysis; // ← SEM "🖼️ *Análise da imagem:*\n\n"
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

// 2. SUBSTITUIR O TRECHO DE PROCESSAMENTO DE IMAGEM NO EVENT LISTENER por:

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
        
        // 🎯 DIFERENÇA: Nome do arquivo mais simples
        const imagePath = path.join(MEDIA_DIR, `image_${Date.now()}.jpg`);
        fs.writeFileSync(imagePath, buffer);
        
        logger.logMedia('💾 IMAGEM SALVA TEMPORARIAMENTE', from, 'image', {
            path: imagePath,
            file_exists: fs.existsSync(imagePath)
        });
        
        const caption = message.message.imageMessage.caption || '';
        const imageAnalysis = await processImage(imagePath, caption);
        
        // 🎯 DIFERENÇA PRINCIPAL: Cria um prompt contextualizado para o assistente
        const prompt = `Baseado na análise da imagem a seguir, forneça uma resposta útil e contextualizada para o usuário:

Análise da imagem: ${imageAnalysis}

Mensagem do usuário: ${caption || 'Usuário enviou uma imagem'}

Forneça uma resposta natural e útil baseada no conteúdo da imagem.`;

        // 🎯 ENVIA O PROMPT CONTEXTUALIZADO PARA O ASSISTENTE (não a análise direta)
        await messageQueue.addMessage(from, {
            type: 'image',
            content: prompt // ← Envia o prompt contextualizado, não a análise bruta
        });
        
        logger.logMedia('🎯 PROCESSAMENTO DE IMAGEM FINALIZADO', from, 'image', {
            prompt_length: prompt.length
        });
        
    } catch (imageError) {
        logger.logError('❌ ERRO NO PROCESSAMENTO DE IMAGEM', imageError, {
            from: from
        });
        
        await messageQueue.addMessage(from, {
            type: 'image',
            content: "❌ Desculpe, não consegui processar esta imagem. Tente enviar novamente."
        });
    }

/*
🎯 EXPLICAÇÃO DA DIFERENÇA PRINCIPAL:

BOT ATUAL (problemático):
1. Usuário envia imagem
2. GPT-4 Vision analisa → "Esta é uma peça técnica..."
3. Adiciona à fila como: "🖼️ *Análise da imagem:* Esta é uma peça técnica..."
4. Assistant processa e responde: "Agradeço a descrição detalhada!"

BOT CORRETO (funcionando):
1. Usuário envia imagem  
2. GPT-4 Vision analisa → "Esta é uma peça técnica..."
3. Cria prompt contextualizado: "Baseado na análise da imagem a seguir, forneça uma resposta útil..."
4. Assistant processa o prompt contextualizado e responde adequadamente

A DIFERENÇA É QUE O BOT CORRETO:
- Remove a formatação "🖼️ *Análise da imagem:*"
- Cria um prompt que instrui o assistant sobre como usar a análise
- O assistant entende que deve responder baseado na análise, não agradecer por ela
*/

