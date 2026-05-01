import { lazy, Suspense, useEffect, useRef, useState } from "react";

// Cole aqui o link da sua cena publicada no Spline (formato my.spline.design/.../).
// Deixe vazio para usar a gema 3D WebGL nativa.
const SPLINE_SCENE_URL = "";

const HeroGem3D = lazy(() => import("./HeroGem3D.jsx"));

const discordIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M19.54 5.53A16.88 16.88 0 0 0 15.5 4.3a11.77 11.77 0 0 0-.52 1.06 15.53 15.53 0 0 0-5.96 0c-.16-.37-.34-.72-.53-1.06a16.86 16.86 0 0 0-4.04 1.23C1.9 9.31 1.2 12.98 1.55 16.6a17.2 17.2 0 0 0 4.95 2.5c.4-.55.75-1.13 1.04-1.74-.57-.22-1.11-.49-1.62-.8.14-.1.28-.22.41-.33 3.13 1.45 6.55 1.45 9.64 0 .14.11.28.22.42.33-.51.31-1.06.58-1.63.8.3.61.65 1.2 1.04 1.74a17.16 17.16 0 0 0 4.95-2.5c.43-4.19-.72-7.82-2.76-11.07ZM8.8 14.38c-.94 0-1.7-.86-1.7-1.91 0-1.06.75-1.92 1.7-1.92.95 0 1.71.86 1.7 1.92 0 1.05-.75 1.91-1.7 1.91Zm6.4 0c-.94 0-1.7-.86-1.7-1.91 0-1.06.75-1.92 1.7-1.92.95 0 1.71.86 1.7 1.92 0 1.05-.75 1.91-1.7 1.91Z"
    />
  </svg>
);

const larperLogo = (
  <svg viewBox="0 0 36 36" aria-hidden="true">
    <path d="M18 4 L29 18 L7 18 Z" fill="currentColor" fillOpacity="0.18" />
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M18 4 L29 18 L18 32 L7 18 Z" strokeWidth="1.9" />
      <path d="M7 18 L29 18" strokeWidth="1.5" />
      <path d="M18 4 L18 32" strokeWidth="1" strokeOpacity="0.45" />
    </g>
  </svg>
);

const bitcoinIcon = (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="currentColor" />
    <path
      fill="#202020"
      d="M21.87 14.01c.32-2.13-1.3-3.27-3.52-4.03l.72-2.88-1.75-.44-.7 2.81c-.46-.11-.93-.22-1.4-.33l.71-2.83-1.76-.44-.72 2.88c-.38-.09-.76-.17-1.12-.26v-.01l-2.43-.61-.47 1.88s1.3.3 1.28.32c.71.18.84.65.82 1.02l-.82 3.28c.05.01.11.03.18.06l-.18-.04-1.15 4.6c-.09.22-.31.55-.79.43.02.03-1.28-.32-1.28-.32l-.88 2 2.3.57c.43.11.84.22 1.25.32l-.73 2.91 1.76.44.72-2.88c.48.13.94.25 1.4.36l-.72 2.86 1.76.44.73-2.9c3 .57 5.26.34 6.2-2.37.77-2.18-.04-3.44-1.61-4.26 1.15-.27 2.02-1.03 2.25-2.6Zm-4.05 5.67c-.54 2.18-4.22 1-5.4.7l.96-3.85c1.18.3 5 .89 4.44 3.15Zm.54-5.69c-.5 1.99-3.56.98-4.56.73l.87-3.49c1 .25 4.2.71 3.69 2.76Z"
    />
  </svg>
);

const fallbackBenefits = [
  "Acesso ao Discord privado",
  "Liberação automática após checkout aprovado",
  "Conteúdos e discussões focados em estética, narrativa e presença"
];

function Avatar({ buyer, size = "md" }) {
  const name = buyer?.name || buyer?.username || "?";
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <span className={`buyer-avatar ${size === "lg" ? "large" : ""}`}>
      {buyer?.avatar ? <img src={buyer.avatar} alt="" /> : <span>{initial}</span>}
    </span>
  );
}

export default function App() {
  const tooltipTriggerRef = useRef(null);
  const [storefront, setStorefront] = useState(null);
  const [session, setSession] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState("");
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tooltipStyle, setTooltipStyle] = useState({});

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoadError("");
    try {
      const [storefrontResponse, sessionResponse] = await Promise.all([
        fetch("/api/storefront"),
        fetch("/api/session")
      ]);

      if (!storefrontResponse.ok || !sessionResponse.ok) {
        throw new Error("Falha ao carregar dados.");
      }

      setStorefront(await storefrontResponse.json());
      setSession(await sessionResponse.json());
    } catch {
      setLoadError("Não foi possível carregar a Larping Brasil agora. Tente novamente em instantes.");
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMessage("Sessão encerrada.");
    await loadData();
  }

  function updateTooltipPosition() {
    const trigger = tooltipTriggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const margin = 16;
    const gap = 14;
    const width = Math.min(420, window.innerWidth - margin * 2);
    const triggerCenter = rect.left + rect.width / 2;
    const left = Math.min(Math.max(triggerCenter - width / 2, margin), window.innerWidth - margin - width);
    const arrowLeft = Math.min(Math.max(triggerCenter - left, 18), width - 18);

    setTooltipStyle({
      "--tooltip-left": `${left}px`,
      "--tooltip-top": `${rect.top - gap}px`,
      "--tooltip-width": `${width}px`,
      "--tooltip-arrow-left": `${arrowLeft}px`
    });
  }

  async function handlePurchase(productId) {
    if (!session?.user) {
      window.location.href = "/api/auth/discord/login";
      return;
    }

    if (!productId) {
      setMessage("Produto indisponível no momento.");
      return;
    }

    setBusyId(productId);
    setMessage("");
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId })
      });

      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.message || "Não foi possível iniciar a compra.");
        return;
      }

      window.location.href = payload.checkoutUrl;
    } finally {
      setBusyId(null);
    }
  }

  if (loadError) {
    return (
      <main className="screen-loader error-state">
        <strong>Algo saiu do fluxo.</strong>
        <p>{loadError}</p>
        <button className="primary-button" onClick={loadData}>
          Tentar novamente
        </button>
      </main>
    );
  }

  if (!storefront || !session) {
    return <div className="screen-loader">Carregando Larping Brasil...</div>;
  }

  const loggedUser = session.user;
  const ownedProductSlugs = new Set(
    (session.orders || []).filter((order) => order.status === "paid").map((order) => order.productSlug)
  );
  const primaryProduct = storefront.product || storefront.products?.[0];
  const products = (storefront.products?.length ? storefront.products : primaryProduct ? [primaryProduct] : []).filter(
    (item) => item.slug === "larper-plus" || item.name === "Larper+"
  );
  const product = products[0] || primaryProduct;
  const topCustomer = storefront.topBuyers?.[0];
  const recentPurchases = storefront.recentBuyers?.slice(0, 10) || [];
  const fallbackRecentPurchases = [
    { name: "Carter_royall", product: "Larper+" },
    { name: "Charlieatk2", product: "Larper+" },
    { name: "artera", product: "Larper+" },
    { name: "fedded", product: "Larper+" },
    { name: "930485k", product: "Larper+" },
    { name: "wansueylarper", product: "Larper+" }
  ];
  const carouselBuyers = recentPurchases.length ? recentPurchases : fallbackRecentPurchases;
  const carouselBase = (() => {
    const minBaseCount = 8;
    const filled = [];
    while (filled.length < minBaseCount) {
      filled.push(...carouselBuyers);
    }
    return filled;
  })();
  const rotateOffset = Math.ceil(carouselBase.length / 2);
  const carouselBaseRotated = [...carouselBase.slice(rotateOffset), ...carouselBase.slice(0, rotateOffset)];
  const carouselRows = [
    [...carouselBase, ...carouselBase],
    [...carouselBaseRotated, ...carouselBaseRotated]
  ];

  return (
    <div className="page-shell">
      <header className="topbar">
        <a className="brand" href="#topo" aria-label="Ir para o início">
          <span className="brand-mark">{larperLogo}</span>
          <span>
            <strong>Larping Brasil</strong>
          </span>
        </a>

        <div className="account-actions">
          {loggedUser ? (
            <>
              <div className="user-chip">
                {loggedUser.avatar ? <img src={loggedUser.avatar} alt="" /> : <span>{loggedUser.username[0]}</span>}
                <div>
                  <span className="user-chip-name">
                    <strong>{loggedUser.globalName || loggedUser.username}</strong>
                    {ownedProductSlugs.has("larper-plus") ? <span className="larper-badge">Larper+</span> : null}
                  </span>
                  <small>@{loggedUser.username}</small>
                </div>
              </div>
              <button className="ghost-button" onClick={handleLogout}>
                Sair
              </button>
            </>
          ) : (
            <a className="discord-button" href="/api/auth/discord/login">
              <span className="icon-wrap">{discordIcon}</span>
              Entrar com Discord
            </a>
          )}
        </div>
      </header>

      <main id="topo">
        <section className="hero">
          <div className="hero-copy">
            <div className="hero-eyebrow-row">
              <p className="eyebrow">A arte do Larping</p>
              <span className="on-chain-badge">
                <span className="on-chain-dot" aria-hidden="true" />
                On-chain
              </span>
            </div>
            <h1>
              A nova <em>elite</em> da internet
            </h1>
            <p className="hero-text">
              Somos uma comunidade com acesso privado para quem entende{" "}
              <span className="term-tooltip">
                <button
                  ref={tooltipTriggerRef}
                  className="term-tooltip-trigger"
                  type="button"
                  onClick={updateTooltipPosition}
                  onFocus={updateTooltipPosition}
                  onMouseEnter={updateTooltipPosition}
                >
                  larping
                </button>
                <span className="term-tooltip-bubble" role="tooltip" style={tooltipStyle}>
                  <span>
                    Gíria usada para se referir ao ato de fingir ser algo ou alguém que não se é.
                  </span>
                  <span className="term-tooltip-example">Ex.: "Esse influencer vive de larp de milionário."</span>
                  <a
                    className="term-tooltip-source"
                    href="https://www.dicionarioinformal.com.br/larp/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Dicionário inFormal
                  </a>
                </span>
              </span>
              , estética, narrativa e presença como ferramentas de status online.
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={() => setIsCatalogOpen(true)}>
                Ver Larper+
              </button>
              {!loggedUser ? (
                <a className="secondary-button" href="/api/auth/discord/login">
                  <span className="icon-wrap">{discordIcon}</span>
                  Entrar antes de comprar
                </a>
              ) : null}
            </div>
          </div>

          <div className="hero-stage" aria-hidden="true">
            {SPLINE_SCENE_URL ? (
              <iframe
                className="hero-stage-frame"
                src={SPLINE_SCENE_URL}
                title="Larping Brasil 3D"
                loading="lazy"
                allow="autoplay; fullscreen"
              />
            ) : (
              <div className="hero-stage-fallback">
                <Suspense fallback={null}>
                  <HeroGem3D />
                </Suspense>
                <span className="hero-orbit hero-orbit-1" />
                <span className="hero-orbit hero-orbit-2" />
              </div>
            )}
          </div>
        </section>

        <section className="section-block features-section" aria-label="O que você acessa">
          <header className="section-header">
            <p className="eyebrow">// O que você acessa</p>
            <h2>Estrutura para construir <em>presença</em>.</h2>
          </header>
          <div className="features-grid">
            <article className="feature-card">
              <span className="feature-num">// 01</span>
              <h3>Acervo de métodos</h3>
              <p>Frameworks e playbooks usados por operadores que dominaram a arte. Construção de persona, edição visual, curadoria de feed e timing de postagem.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">// 02</span>
              <h3>Discord privado</h3>
              <p>Canais segmentados para feedback honesto de presença, troca de referências e debate técnico. Acesso liberado automaticamente após o pagamento.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">// 03</span>
              <h3>Drops semanais</h3>
              <p>Conteúdos novos toda semana: breakdowns de personas públicas, templates de bio, estruturas narrativas e cases comentados em vídeo.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">// 04</span>
              <h3>Rede de operadores</h3>
              <p>Networking direto com larpers em diferentes níveis de execução. Feedback vertical de quem está alguns passos à frente do seu.</p>
            </article>
          </div>
        </section>

        <section className="section-block process-section" aria-label="Como funciona">
          <header className="section-header">
            <p className="eyebrow">// Como funciona</p>
            <h2>Três passos para entrar.</h2>
          </header>
          <ol className="process-list">
            <li className="process-step">
              <span className="process-num">→ 01</span>
              <div>
                <h3>Conecte-se via Discord</h3>
                <p>Login OAuth com sua conta. A identidade da comunidade começa pelo cargo no servidor.</p>
              </div>
            </li>
            <li className="process-step">
              <span className="process-num">→ 02</span>
              <div>
                <h3>Adquira o Larper+</h3>
                <p>Pagamento único de R$ 30 via PIX. Liberação automática do cargo no Discord assim que confirmar.</p>
              </div>
            </li>
            <li className="process-step">
              <span className="process-num">→ 03</span>
              <div>
                <h3>Mergulhe no acervo</h3>
                <p>Aplique os métodos, compartilhe progresso, itere com feedback até a presença ficar inquebrável.</p>
              </div>
            </li>
          </ol>
        </section>

        <section className="dashboard-grid" aria-label="Atividade da comunidade">
          <article className="panel top-customer">
            <span className="panel-label">Maior comprador</span>
            <div className="buyer-spotlight">
              <Avatar buyer={topCustomer || { name: "wansueylarper" }} size="lg" />
              <div>
                <strong>{topCustomer?.name || "wansueylarper"}</strong>
                <p>{topCustomer?.total ? `${topCustomer.total} em compras confirmadas.` : "Foi quem mais comprou este mês."}</p>
              </div>
            </div>
          </article>

          <article className="panel recent-panel">
            <span className="panel-label">Compras recentes</span>
            <div className="purchase-carousel" aria-label="Carrossel de compradores recentes">
              {carouselRows.map((row, rowIndex) => (
                <div className={`purchase-track ${rowIndex === 1 ? "reverse" : ""}`} key={`row-${rowIndex}`}>
                  {row.map((buyer, index) => (
                    <div className="purchase-card" key={`${rowIndex}-${buyer.name}-${buyer.product || "compra"}-${index}`}>
                      <Avatar buyer={buyer} />
                      <div>
                        <p>{buyer.name}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </article>
        </section>
      </main>

      {isCatalogOpen ? (
        <div className="modal-backdrop" onClick={() => setIsCatalogOpen(false)}>
          <div className="catalog-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="catalog-head">
              <div>
                <span className="panel-label">Produto</span>
              </div>
              <button className="close-button" onClick={() => setIsCatalogOpen(false)} aria-label="Fechar popup">
                ×
              </button>
            </div>

            {products.length ? (
              products.map((item) => {
                const isOwned = loggedUser && ownedProductSlugs.has(item.slug);
                return (
                <article className="catalog-item" key={item.id || item.slug || item.name}>
                  <div className="catalog-row">
                    <div>
                      <strong className="product-name">
                        <span className="bitcoin-icon">{bitcoinIcon}</span>
                        {item.name || "Larper+"}
                      </strong>
                      <p>{item.description || "Acesso principal para entrar na comunidade fechada."}</p>
                    </div>
                    <div className="catalog-price">
                      <strong>{item.price || "R$ 30,00"}</strong>
                      <span>pagamento único</span>
                    </div>
                  </div>

                  <ul className="benefit-list">
                    {(item.benefits?.length ? item.benefits : fallbackBenefits).map((benefit) => (
                      <li key={`${item.id || item.name}-${benefit}`}>{benefit}</li>
                    ))}
                  </ul>

                  {loggedUser ? (
                    <button
                      className="primary-button block-button"
                      onClick={() => handlePurchase(item.id)}
                      disabled={!item.id || busyId === item.id || isOwned}
                    >
                      {isOwned
                        ? "Já adquirido"
                        : busyId === item.id
                          ? "Abrindo checkout..."
                          : "Comprar Larper+"}
                    </button>
                  ) : (
                    <a className="primary-button block-button" href="/api/auth/discord/login">
                      <span className="icon-wrap">{discordIcon}</span>
                      Entrar para comprar
                    </a>
                  )}
                </article>
                );
              })
            ) : (
              <div className="empty-catalog">
                <strong>Nenhum produto disponível.</strong>
                <p>Volte em instantes ou entre em contato pelo Discord.</p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}
