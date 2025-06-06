const fs = require('fs-extra');
const path = require('path');
const pdfParse = require('pdf-parse');
/**
 * Gerenciador de conteúdo personalizado
 */
class ContentManager {
  constructor() {
    this.content = {
      text: [],
      embeddings: []
    };
  }
  /**
   * Carrega o conteúdo personalizado de um diretório
   * @param {string} contentPath - Caminho para o diretório de conteúdo
   * @returns {Promise<void>}
   */
  async loadContent(contentPath) {
    try {
      // Verifica se o diretório existe
      if (!fs.existsSync(contentPath)) {
        fs.mkdirSync(contentPath, { recursive: true });
        console.log(`Diretório de conteúdo criado: ${contentPath}`);
        return;
      }
      console.log(`Carregando conteúdo de: ${contentPath}`);
      
      // Lê todos os arquivos do diretório
      const files = await fs.readdir(contentPath);
      
      // Processa cada arquivo
      for (const file of files) {
        const filePath = path.join(contentPath, file);
        const stats = await fs.stat(filePath);
        
        // Ignora diretórios
        if (stats.isDirectory()) continue;
        
        // Processa o arquivo com base na extensão
        const ext = path.extname(file).toLowerCase();
        
        if (ext === '.pdf') {
          await this.processPdf(filePath);
        } else if (ext === '.txt' || ext === '.md') {
          await this.processTextFile(filePath);
        } else if (ext === '.json') {
          await this.processJsonFile(filePath);
        } else {
          console.log(`Tipo de arquivo não suportado: ${file}`);
        }
      }
      
      console.log(`Total de conteúdo carregado: ${this.content.text.length} itens`);
    } catch (error) {
      console.error('Erro ao carregar conteúdo:', error);
      throw error;
    }
  }
  /**
   * Processa um arquivo PDF
   * @param {string} filePath - Caminho para o arquivo PDF
   * @returns {Promise<void>}
   */
  async processPdf(filePath) {
    try {
      console.log(`Processando PDF: ${filePath}`);
      
      // Lê o arquivo PDF
      const dataBuffer = await fs.readFile(filePath);
      
      // Extrai o texto do PDF
      const data = await pdfParse(dataBuffer);
      
      // Adiciona o texto ao conteúdo
      this.content.text.push({
        source: path.basename(filePath),
        text: data.text,
        type: 'pdf'
      });
      
      console.log(`PDF processado: ${filePath}`);
    } catch (error) {
      console.error(`Erro ao processar PDF ${filePath}:`, error);
    }
  }
  /**
   * Processa um arquivo de texto
   * @param {string} filePath - Caminho para o arquivo de texto
   * @returns {Promise<void>}
   */
  async processTextFile(filePath) {
    try {
      console.log(`Processando arquivo de texto: ${filePath}`);
      
      // Lê o arquivo de texto
      const text = await fs.readFile(filePath, 'utf8');
      
      // Adiciona o texto ao conteúdo
      this.content.text.push({
        source: path.basename(filePath),
        text,
        type: 'text'
      });
      
      console.log(`Arquivo de texto processado: ${filePath}`);
    } catch (error) {
      console.error(`Erro ao processar arquivo de texto ${filePath}:`, error);
    }
  }
  /**
   * Processa um arquivo JSON
   * @param {string} filePath - Caminho para o arquivo JSON
   * @returns {Promise<void>}
   */
  async processJsonFile(filePath) {
    try {
      console.log(`Processando arquivo JSON: ${filePath}`);
      
      // Lê o arquivo JSON
      const jsonContent = await fs.readFile(filePath, 'utf8');
      const data = JSON.parse(jsonContent);
      
      // Verifica se o JSON tem o formato esperado
      if (Array.isArray(data) && data.every(item => typeof item.text === 'string')) {
        // Adiciona cada item ao conteúdo
        for (const item of data) {
          this.content.text.push({
            source: path.basename(filePath),
            text: item.text,
            type: 'json',
            metadata: item.metadata || {}
          });
        }
      } else {
        // Adiciona o JSON como texto
        this.content.text.push({
          source: path.basename(filePath),
          text: JSON.stringify(data, null, 2),
          type: 'json'
        });
      }
      
      console.log(`Arquivo JSON processado: ${filePath}`);
    } catch (error) {
      console.error(`Erro ao processar arquivo JSON ${filePath}:`, error);
    }
  }
  /**
   * Busca conteúdo relevante para uma consulta
   * @param {string} query - Consulta para buscar conteúdo relevante
   * @returns {string} - Conteúdo relevante encontrado
   */
  searchContent(query) {
    // Implementação simples de busca por palavras-chave
    // Em uma implementação mais avançada, seria usado embeddings e busca semântica
    
    const keywords = query.toLowerCase().split(/\s+/);
    
    // Filtra o conteúdo que contém as palavras-chave
    const relevantContent = this.content.text
      .filter(item => {
        const text = item.text.toLowerCase();
        return keywords.some(keyword => text.includes(keyword));
      })
      .map(item => item.text)
      .join('\n\n');
    
    // Limita o tamanho do conteúdo para não exceder o limite de tokens da API
    return relevantContent.length > 4000 
      ? relevantContent.substring(0, 4000) + '...'
      : relevantContent;
  }
}
module.exports = new ContentManager();

