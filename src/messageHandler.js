/**
 * Manipulador de mensagens
 */
class MessageHandler {
  /**
   * Processa uma mensagem e gera uma resposta
   * @param {Object} message - Objeto de mensagem do WhatsApp
   * @param {Object} conversationContext - Contexto da conversa
   * @param {Object} openai - Cliente da API da OpenAI
   * @param {Object} contentManager - Gerenciador de conteúdo
   * @returns {Promise<string>} - Resposta gerada
   */
  async handleMessage(message, conversationContext, openai, contentManager) {
    try {
      const senderId = message.from;
      const messageText = message.body;
      
      // Inicializa o contexto da conversa se não existir
      if (!conversationContext[senderId]) {
        conversationContext[senderId] = [];
      }
      
      // Verifica se é um comando especial
      if (messageText.startsWith('/')) {
        return this.handleCommand(messageText, senderId, conversationContext);
      }
      
      // Busca conteúdo relevante
      const relevantContent = contentManager.searchContent(messageText);
      
      // Prepara o contexto para a API da OpenAI
      const context = this.prepareContext(
        senderId, 
        messageText, 
        conversationContext, 
        relevantContent
      );
      
      // Gera a resposta usando a API da OpenAI
      const response = await this.generateResponse(openai, context);
      
      // Atualiza o contexto da conversa
      this.updateConversationContext(
        senderId, 
        messageText, 
        response, 
        conversationContext
      );
      
      return response;
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
      return 'Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente mais tarde.';
    }
  }
  /**
   * Processa comandos especiais
   * @param {string} command - Comando recebido
   * @param {string} senderId - ID do remetente
   * @param {Object} conversationContext - Contexto da conversa
   * @returns {string} - Resposta ao comando
   */
  handleCommand(command, senderId, conversationContext) {
    const cmd = command.toLowerCase();
    
    if (cmd === '/ajuda' || cmd === '/help') {
      return `
*Comandos disponíveis:*
/ajuda - Exibe esta mensagem de ajuda
/limpar - Limpa o histórico da conversa
/status - Verifica o status do sistema
      `.trim();
    }
    
    if (cmd === '/limpar' || cmd === '/clear') {
      conversationContext[senderId] = [];
      return 'Histórico da conversa foi limpo.';
    }
    
    if (cmd === '/status') {
      return `
*Status do Sistema:*
- Bot: Ativo
- Memória: ${process.memoryUsage().heapUsed / 1024 / 1024} MB
- Uptime: ${Math.floor(process.uptime() / 60)} minutos
      `.trim();
    }
    
    return `Comando não reconhecido. Digite /ajuda para ver os comandos disponíveis.`;
  }
  /**
   * Prepara o contexto para a API da OpenAI
   * @param {string} senderId - ID do remetente
   * @param {string} messageText - Texto da mensagem
   * @param {Object} conversationContext - Contexto da conversa
   * @param {string} relevantContent - Conteúdo relevante
   * @returns {Array} - Contexto formatado para a API da OpenAI
   */
  prepareContext(senderId, messageText, conversationContext, relevantContent) {
    const messages = [
      {
        role: 'system',
        content: `Você é um assistente de IA chamado ${process.env.BOT_NAME || 'Assistente IA'} que responde perguntas com base em conteúdo personalizado. 
        Seja útil, educado e conciso. Se você não souber a resposta com base no conteúdo fornecido, 
        diga que não tem essa informação disponível no momento.
        
        ${relevantContent ? 'Informações relevantes para a consulta:\n' + relevantContent : 'Não há informações específicas sobre esta consulta no conteúdo personalizado.'}`
      }
    ];
    
    // Adiciona o histórico da conversa
    const maxContextMessages = parseInt(process.env.MAX_CONTEXT_MESSAGES || 10);
    const history = conversationContext[senderId].slice(-maxContextMessages);
    
    for (const item of history) {
      messages.push({ role: 'user', content: item.user });
      messages.push({ role: 'assistant', content: item.assistant });
    }
    
    // Adiciona a mensagem atual
    messages.push({ role: 'user', content: messageText });
    
    return messages;
  }
  /**
   * Gera uma resposta usando a API da OpenAI
   * @param {Object} openai - Cliente da API da OpenAI
   * @param {Array} context - Contexto formatado para a API da OpenAI
   * @returns {Promise<string>} - Resposta gerada
   */
  async generateResponse(openai, context) {
    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: context,
        max_tokens: 500,
        temperature: 0.7,
      });
      
      return completion.choices[0].message.content.trim();
    } catch (error) {
      console.error('Erro ao gerar resposta com a API da OpenAI:', error);
      
      // Verifica o tipo de erro
      if (error.response) {
        const status = error.response.status;
        
        if (status === 429) {
          return 'Desculpe, estou recebendo muitas solicitações no momento. Por favor, tente novamente em alguns minutos.';
        } else if (status === 401) {
          return 'Erro de autenticação com a API. Por favor, informe ao administrador do sistema.';
        }
      }
      
      return 'Desculpe, ocorreu um erro ao gerar uma resposta. Por favor, tente novamente mais tarde.';
    }
  }
  /**
   * Atualiza o contexto da conversa
   * @param {string} senderId - ID do remetente
   * @param {string} userMessage - Mensagem do usuário
   * @param {string} assistantResponse - Resposta do assistente
   * @param {Object} conversationContext - Contexto da conversa
   */
  updateConversationContext(senderId, userMessage, assistantResponse, conversationContext) {
    conversationContext[senderId].push({
      user: userMessage,
      assistant: assistantResponse,
      timestamp: Date.now()
    });
    
    // Limita o tamanho do contexto
    const maxContextMessages = parseInt(process.env.MAX_CONTEXT_MESSAGES || 10);
    if (conversationContext[senderId].length > maxContextMessages) {
      conversationContext[senderId] = conversationContext[senderId].slice(-maxContextMessages);
    }
  }
}
module.exports = new MessageHandler();

