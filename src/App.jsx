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
    <path d="M18 4 L8 16 L18 22 Z" fill="currentColor" fillOpacity="0.22" />
    <path d="M18 4 L18 22 L28 16 Z" fill="currentColor" fillOpacity="0.12" />
    <path d="M8 16 L18 22 L18 32 Z" fill="currentColor" fillOpacity="0.16" />
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M18 4 L28 16 L18 32 L8 16 Z" strokeWidth="1.9" />
      <path d="M8 16 L18 22 L28 16" strokeWidth="1.4" />
      <path d="M18 4 L18 22 L18 32" strokeWidth="1.3" />
    </g>
  </svg>
);

const chevronDownIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6 9 L12 15 L18 9"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

const logoutIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M10 4 L5 4 a1 1 0 0 0 -1 1 L4 19 a1 1 0 0 0 1 1 L10 20" />
      <path d="M20 12 L9 12" />
      <path d="M16 8 L20 12 L16 16" />
    </g>
  </svg>
);

const productsIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" fill="none">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </g>
  </svg>
);

const sparkleIcon = (
  <svg viewBox="0 0 512 512" aria-hidden="true">
    <path
      fill="currentColor"
      d="M256 0 Q 256 256 512 256 Q 256 256 256 512 Q 256 256 0 256 Q 256 256 256 0 Z"
    />
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
  "discord privado e área de membros",
  "repertório digital editável, fonte aberta",
  "acervo de mídias, métodos e recursos",
  "acesso liberado automaticamente após a entrada"
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
  const userMenuRef = useRef(null);
  const [storefront, setStorefront] = useState(null);
  const [session, setSession] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState("");
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tooltipStyle, setTooltipStyle] = useState({});

  useEffect(() => {
    if (!isUserMenuOpen) return;
    const onDocPointerDown = (event) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target)) {
        setIsUserMenuOpen(false);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setIsUserMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isUserMenuOpen]);

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
      setLoadError("não foi possível carregar agora. tenta de novo em instantes.");
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMessage("sessão encerrada.");
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
      setMessage("produto indisponível no momento.");
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
        setMessage(payload.message || "não foi possível iniciar a compra.");
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
        <strong>algo saiu do fluxo.</strong>
        <p>{loadError}</p>
        <button className="primary-button" onClick={loadData}>
          tentar novamente
        </button>
      </main>
    );
  }

  if (!storefront || !session) {
    return <div className="screen-loader">carregando...</div>;
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
    { name: "Carter_royall", product: "larper+" },
    { name: "Charlieatk2", product: "larper+" },
    { name: "artera", product: "larper+" },
    { name: "fedded", product: "larper+" },
    { name: "930485k", product: "larper+" },
    { name: "wansueylarper", product: "larper+" }
  ];
  const carouselBuyers = recentPurchases.length ? recentPurchases : fallbackRecentPurchases;
  const carouselBase = (() => {
    const minBaseCount = 10;
    const filled = [];
    while (filled.length < minBaseCount) {
      filled.push(...carouselBuyers);
    }
    return filled;
  })();
  const carouselTrack = [...carouselBase, ...carouselBase];

  return (
    <div className="page-shell">
      <header className="topbar">
        <a className="brand" href="#topo" aria-label="ir para o início">
          <span className="brand-mark">{larperLogo}</span>
          <span className="brand-text">larping</span>
        </a>

        <div className="account-actions">
          {loggedUser ? (
            <div className="user-menu" ref={userMenuRef}>
              <button
                type="button"
                className={`user-chip user-chip-trigger${isUserMenuOpen ? " open" : ""}`}
                onClick={() => setIsUserMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={isUserMenuOpen}
              >
                {loggedUser.avatar ? <img src={loggedUser.avatar} alt="" /> : <span>{loggedUser.username[0]}</span>}
                <div>
                  <strong>{loggedUser.globalName || loggedUser.username}</strong>
                  <small>@{loggedUser.username}</small>
                </div>
                <span className="user-chip-caret" aria-hidden="true">{chevronDownIcon}</span>
              </button>
              {isUserMenuOpen ? (
                <div className="user-menu-popover" role="menu">
                  {ownedProductSlugs.has("larper-plus") ? (
                    <div className="user-menu-status">
                      <span className="status-dot" aria-hidden="true" />
                      larper+ ativo
                    </div>
                  ) : (
                    <div className="user-menu-status muted">
                      sem assinatura
                    </div>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="user-menu-item"
                    onClick={() => {
                      setIsUserMenuOpen(false);
                      handleLogout();
                    }}
                  >
                    <span className="icon-wrap">{logoutIcon}</span>
                    sair
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <a className="discord-button" href="/api/auth/discord/login">
              <span className="icon-wrap">{discordIcon}</span>
              entrar com discord
            </a>
          )}
        </div>
      </header>

      <main id="topo">
        <section className="hero">
          <div className="hero-copy">
            <div className="hero-eyebrow-row">
              <p className="eyebrow">
                <span className="eyebrow-sparkle">{sparkleIcon}</span>
                a arte do larping
              </p>
            </div>
            <h1>
              a nova <em>elite</em> da internet
            </h1>
            <p className="hero-text">
              comunidade fechada de quem leva{" "}
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
                  <span className="term-tooltip-head">
                    <span className="term-tooltip-word">larp</span>
                    <span className="term-tooltip-phon">/laʁp/</span>
                  </span>
                  <span className="term-tooltip-meta">
                    <span>subst. masc.</span>
                    <span className="term-tooltip-dot" aria-hidden="true">·</span>
                    <span>gíria</span>
                  </span>
                  <span className="term-tooltip-def-block">
                    <span className="term-tooltip-def-num">1.</span>
                    <span className="term-tooltip-def">
                      ato de fingir ser algo ou alguém que não se é, geralmente em redes sociais.
                    </span>
                  </span>
                  <a
                    className="term-tooltip-source"
                    href="https://www.dicionarioinformal.com.br/larp/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span>dicionário informal</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17 L17 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      <path d="M9 7 L17 7 L17 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </a>
                </span>
              </span>
              {" "}a sério.
            </p>
            <div className="hero-actions">
              <button className="primary-button products-cta" onClick={() => setIsCatalogOpen(true)}>
                <span className="icon-wrap products-cta-icon">{productsIcon}</span>
                ver produtos
              </button>
            </div>
          </div>

          <div className="hero-stage" aria-hidden="true">
            {SPLINE_SCENE_URL ? (
              <iframe
                className="hero-stage-frame"
                src={SPLINE_SCENE_URL}
                title="larping 3d"
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
                <span className="hero-orbit hero-orbit-3" />
              </div>
            )}
          </div>
        </section>

        <section className="section-block community-section" aria-label="quem tá dentro">
          <header className="section-header">
            <p className="eyebrow">// quem tá dentro</p>
          </header>
          <div className="dashboard-grid">
            <article className="panel top-customer">
              <p className="panel-label">maior comprador</p>
              <div className="buyer-spotlight">
                <Avatar buyer={topCustomer || { name: "wansueylarper" }} size="lg" />
                <div>
                  <strong>{topCustomer?.name || "wansueylarper"}</strong>
                  {topCustomer?.total ? <p>{topCustomer.total}</p> : null}
                </div>
              </div>
            </article>

            <article className="panel recent-panel">
              <p className="panel-label">compras recentes</p>
              <div className="purchase-carousel" aria-label="carrossel de compradores recentes">
                <div className="purchase-track">
                  {carouselTrack.map((buyer, index) => (
                    <div className="purchase-card" key={`${buyer.name}-${buyer.product || "compra"}-${index}`}>
                      <Avatar buyer={buyer} />
                      <div className="purchase-card-text">
                        <strong>{buyer.name}</strong>
                        <span>{(buyer.product || "larper+").toLowerCase()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className="section-block features-section" aria-label="o que tem dentro">
          <header className="section-header">
            <p className="eyebrow">// o que tem dentro</p>
            <h2>conteúdo, <em>cultura</em> e network.</h2>
          </header>
          <div className="features-grid">
            <article className="feature-card">
              <span className="feature-num">// 01</span>
              <h3>acervo</h3>
              <p>mídia, cenário e ambientação. uso livre.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">// 02</span>
              <h3>repertório digital</h3>
              <p>materiais editáveis. fonte aberta, atualização contínua.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">// 03</span>
              <h3>discord privado</h3>
              <p>com divisão de tópico e networking direto.</p>
            </article>
          </div>
        </section>

        <section className="section-block process-section" aria-label="como entra">
          <header className="section-header">
            <p className="eyebrow">// como entra</p>
          </header>
          <div className="features-grid">
            <article className="feature-card">
              <span className="feature-num">→ 01</span>
              <h3>login com discord</h3>
              <p>sua conta vira o id na comunidade.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">→ 02</span>
              <h3>confirma a entrada</h3>
              <p>acesso vitalício, sem renovação.</p>
            </article>
            <article className="feature-card">
              <span className="feature-num">→ 03</span>
              <h3>acesso liberado</h3>
              <p>automático, sem espera.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer-main">
          <a className="brand footer-brand" href="#topo">
            <span className="brand-mark">{larperLogo}</span>
            <div className="footer-brand-text">
              <strong>larping</strong>
              <small>a nova elite da internet</small>
            </div>
          </a>

          <a
            className="footer-discord-icon"
            href="https://discord.gg/5qashjk2Ug"
            target="_blank"
            rel="noreferrer"
            aria-label="discord"
          >
            {discordIcon}
          </a>
        </div>

        <div className="footer-meta">
          <span>© {new Date().getFullYear()} larping</span>
          <span>todos os direitos reservados</span>
        </div>
      </footer>

      {isCatalogOpen ? (
        <div className="modal-backdrop" onClick={() => setIsCatalogOpen(false)}>
          <div className="catalog-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <div className="catalog-head">
              <div>
                <span className="panel-label">produto</span>
              </div>
              <button className="close-button" onClick={() => setIsCatalogOpen(false)} aria-label="fechar">
                ×
              </button>
            </div>

            {products.length ? (
              products.map((item) => {
                const isOwned = loggedUser && ownedProductSlugs.has(item.slug);
                return (
                <article className="catalog-item" key={item.id || item.slug || item.name}>
                  <header className="catalog-item-head">
                    <strong className="product-name">
                      <span className="bitcoin-icon">{bitcoinIcon}</span>
                      {(item.name || "larper+").toLowerCase()}
                    </strong>
                    <p className="product-desc">{(item.description || "acesso à comunidade fechada.").toLowerCase()}</p>
                  </header>

                  <ul className="benefit-list">
                    {(item.benefits?.length ? item.benefits : fallbackBenefits).map((benefit) => (
                      <li key={`${item.id || item.name}-${benefit}`}>{benefit.toLowerCase()}</li>
                    ))}
                  </ul>

                  <footer className="catalog-item-foot">
                    <div className="catalog-price">
                      <strong>{item.price || "R$ 30,00"}</strong>
                      <span>pagamento único</span>
                    </div>
                    {loggedUser ? (
                      <button
                        className="primary-button block-button"
                        onClick={() => handlePurchase(item.id)}
                        disabled={!item.id || busyId === item.id || isOwned}
                      >
                        {isOwned
                          ? "já adquirido"
                          : busyId === item.id
                            ? "abrindo checkout..."
                            : `comprar ${(item.name || "larper+").toLowerCase()}`}
                      </button>
                    ) : (
                      <a className="primary-button block-button" href="/api/auth/discord/login">
                        <span className="icon-wrap">{discordIcon}</span>
                        entrar para comprar
                      </a>
                    )}
                  </footer>
                </article>
                );
              })
            ) : (
              <div className="empty-catalog">
                <strong>nenhum produto disponível.</strong>
                <p>volta em instantes ou entra em contato pelo discord.</p>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {message ? <div className="toast">{message}</div> : null}
    </div>
  );
}
