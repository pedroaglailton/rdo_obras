# RDO de Campo

Sistema de registro diário de obra (RDO) para técnicos em campo.

- **app-campo/** — app que o técnico usa no celular pra preencher o RDO
  (obra, atividade, materiais, horários, fotos), funciona offline e
  sincroniza quando tem sinal.
- **server/** — servidor (Node.js) que recebe os RDOs de todos os técnicos
  e guarda tudo num banco central.
- **dashboard/** — painel web onde o engenheiro/estagiário acompanha as
  obras em tempo real e exporta relatórios em Excel.
