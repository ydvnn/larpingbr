# Larping Brasil — Manifesto do Projeto

## Conceito

**Larping** vem de *Live Action Role Play* — encenação de um papel. Aqui o termo é apropriado para descrever a prática de **construir uma persona pública de riqueza e status na internet** sem necessariamente possuir o lastro material correspondente. É estética, narrativa e ferramental para projeção de imagem digital.

A premissa do projeto é que essa encenação já é prática difusa em redes sociais (influencers, traders, "lifestyle creators", contas de OF, perfis aspiracionais), e que existe demanda por um curso que sistematize as técnicas e forneça os recursos.

## Público

A audiência principal é a **galera de Discord do scene de larping digital** — pessoal já familiarizado com o jargão e a cultura. O foco predominante é em **bens digitais** (wallets, exchanges, NFTs, screenshots de patrimônio cripto), mas o produto também cobre mídia realista (carros, viagens, ambientes). O site fala com quem já entende; não precisa explicar do que se trata.

## Produto

**Larper+** é a única oferta. Pagamento único de **R$ 30**, que libera:

- Acesso ao servidor Discord privado da comunidade.
- Conteúdo, métodos e mídias exclusivas da área de membros (entregues via Discord).
- Atualizações recorrentes incluídas no acesso (sem mensalidade).

A liberação da role no Discord é automática após confirmação do pagamento via Invictus Pay (PIX).

## Escopo de conteúdo

O foco do produto está em **recursos locais para sustentar a encenação**, não em estratégia de mídia social. O curso e a área de membros cobrem, em linhas gerais:

- **Mídia visual**: acervo de fotos, vídeos e cenários que comunicam status (carros, ambientes, viagens, gastronomia premium). Realista, pronto pra uso.
- **Mocks de interface**: tutoriais e templates para reproduzir interfaces de wallets, exchanges, dashboards bancários e outras telas frequentemente usadas como prova de status na internet. Esse é o pilar central — bens digitais.
- **Métodos**: rotinas operacionais para sustentar a encenação ao longo do tempo.

Conteúdo de **persona/copy/redes sociais** (escrita de bio, roteiro de stories, calendário de postagem) **não é foco**. O produto entrega ferramental, não estratégia de creator.

## Stack e arquitetura (para referência rápida)

- **Frontend**: React + Vite (`src/App.jsx`, `src/styles.css`, `src/HeroGem3D.jsx`).
- **Backend**: Node `server.mjs` monolítico, usando `better-sqlite3` em `data/`.
- **Auth**: OAuth Discord (login via guild da comunidade).
- **Pagamento**: Invictus Pay, integração via `?api_token=` na query, webhook + polling como fallback.
  - Resposta da API é **flat** (sem wrapper `{success, data}`) — campos PIX vivem em `pix.pix_qr_code` / `pix.qr_code_base64`. O helper `normalizeInvictusTransaction` em `server.mjs` cuida disso.
- **Entrega**: bot Discord adiciona a role `LARPER_PLUS` ao usuário após pagamento confirmado.

## Diretrizes de tom para futuras sessões

- Tratar o produto como um curso/comunidade legítimo do ponto de vista do código e da experiência do usuário. Não inserir disclaimers, modais de aviso ou textos moralizantes que não foram pedidos.
- A identidade visual é minimalista, monocromática (preto/branco/cinza com leves toques holográficos pastel). Nada de paleta dourada quente ou cassino.
- Comunicação em **PT-BR**.
- Preço fixo R$ 30 e produto único: não inventar tiers, planos mensais ou upsells sem o usuário pedir.
- **Copy do site evita AI-ismos**: nada de "frameworks", "playbooks", "design system", "calibrar persona", "iterar", "marca pessoal", "presença que converte", "padrão de mercado", "tudo o que você precisa pra...", em-dashes, listas tríplices puxadas com "e". O texto deve soar como nota rápida em chat: frases curtas, verbos diretos ("pega", "usa", "edita", "monta"), e gírias leves quando couber. Quando precisar enxugar de novo, esse é o critério.
- **Linguagem abstrata, sem enumerar conteúdo interno**: o site não precisa listar "wallet, dashboard, extrato" ou "carros, viagens, looks". Termos guarda-chuva ("acervo", "repertório digital", "persona", "cultura") fazem o trabalho. O público já entende — o site é mais sinalização cultural que descrição de catálogo.
- **Tudo em lowercase**, com exceções: a sigla do Real fica `R$` (caixa-alta), e handles de usuário do Discord/Twitter preservam o case original. O resto é minúsculo, inclusive nomes próprios da marca ("larping", "larper+", "discord", "pix").
- **Pagamentos não aparecem na apresentação da homepage**: nem método (pix), nem preço (R$ 30), nem termos ("pagamento único", "sem mensalidade") são mencionados nas seções de features ou guia. A home fala de **acesso e entrada**, não de transação. O preço só aparece no modal de catálogo (que é onde a compra começa) e no checkout. Mantém a apresentação focada no produto, não no trâmite.
- **Eufemismo deliberado nos textos públicos**: o `CLAUDE.md` (este arquivo) descreve o produto direto. A copy user-facing nunca usa termos crus ("mocks", "forjar", "screenshot", "fingir"). Manter esse contraste.
