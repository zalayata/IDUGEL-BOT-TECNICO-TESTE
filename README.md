
# 🤖 Bot WhatsApp com Assistant da OpenAI - Grupo Idugel

Este projeto integra o WhatsApp via Baileys com o modelo GPT-4 da OpenAI utilizando a API de Assistants, permitindo interações inteligentes com contexto por número de telefone.

---

## 🚀 Funcionalidades

- 🤖 Integração com Assistant ID personalizado (via Playground da OpenAI)
- 🧠 Memória de contexto por cliente usando `threadMap.json`
- 🔐 Suporte a múltiplos contatos simultâneos
- 🧰 Deploy automatizado compatível com Railway

---

## ⚙️ Como configurar

1. **Crie um `.env` com suas variáveis:**

```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_ASSISTANT_ID=asst_xxxxxxxxxxxxxxxxxxxxxx
PORT=3000
SESSION_DATA_PATH=./config/session
```

2. **Adicione ao `.gitignore`:**

```
threadMap.json
```

3. **Deploy no Railway:**

- Faça push do projeto para o GitHub.
- Conecte o repositório ao Railway.
- Configure as variáveis de ambiente no painel do Railway.
- Pronto! Acesse a URL pública para ver o QR Code e escanear.

---

## 📁 Arquivo `threadMap.json`

Este arquivo armazena os `thread_id` por número de telefone. Ele é criado e mantido automaticamente, mas **não deve ser versionado**.

---

## 📞 Exemplo de uso

- Envie "Oi" pelo WhatsApp.
- O assistente responde usando seu contexto configurado no Playground.
- Todo o histórico da conversa é preservado por número.

---

## 🛠️ Créditos

- [Baileys (WhatsApp Web API)](https://github.com/WhiskeySockets/Baileys)
- [OpenAI Node SDK](https://www.npmjs.com/package/openai)
- Desenvolvido e adaptado para o Grupo Idugel ✨
