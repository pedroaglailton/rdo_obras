# CRM de Obras 

Sistema de gestão de obras com chat em tempo real, cadastro flexível de materiais e interface mobile para técnicos.

## 🚀 Funcionalidades

### Painel Web (Gestor)
- **Dashboard** - Visão geral de cidades, obras, materiais e registros
- **Cidades** - Cadastro livre com coordenadas GPS
- **Obras** - Gestão completa com etapas flexíveis
- **Materiais** - Importação de lista.txt + cadastro manual
- **Registros** - Histórico de uso de materiais por técnico

### App Técnico (Mobile)
- **Interface Android** - Navigation bar padrão na parte inferior
- **Registro de Materiais** - Seleciona material + informa quantidade
- **Chat em Tempo Real** - Comunicação com gestor via Socket.io
- **Cadastro Rápido** - Cadastra material novo direto no app


```

## 🛠️ Tecnologias

- **Backend:** Node.js + Express
- **Banco:** SQLite (better-sqlite3)
- **Chat:** Socket.io (WebSocket)
- **Frontend:** HTML + CSS + JavaScript puro
- **Mobile:** PWA (Progressive Web App)

## 📱 Uso no Celular

1. Conecte o celular na mesma rede do computador
2. Acesse `http://IP-DO-PC:3000/app`
3. Use o menu inferior para navegar
4. Salve como atalho na tela inicial (PWA)

## 📋 Importação de Materiais

O arquivo `lista.txt` deve conter um material por linha:
```
Parafuso N° 6
Cabo Cat.6
Câmera Bullet
```

Para importar:
1. Acesse o painel web
2. Vá em "Materiais"
3. Clique em "Importar lista.txt"

## 🔧 Configuração

### Porta do servidor
Altere a variável de ambiente `PORT` ou edite `server.js`:
```javascript
const PORT = process.env.PORT || 3000;
```

### Banco de dados
O banco SQLite é criado automaticamente em `data/crm.db`

## 📝 Licença


