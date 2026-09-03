(() => {
  const button = document.querySelector("[data-menu-toggle]");
  const nav = document.querySelector("[data-site-nav]");
  if (!button || !nav) return;

  const closeMenu = () => {
    nav.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "開啟導覽選單");
    document.body.classList.remove("menu-open");
  };

  button.addEventListener("click", () => {
    const willOpen = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", willOpen);
    button.setAttribute("aria-expanded", String(willOpen));
    button.setAttribute("aria-label", willOpen ? "關閉導覽選單" : "開啟導覽選單");
    document.body.classList.toggle("menu-open", willOpen);
  });

  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) closeMenu();
  });
})();

(() => {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  const isHome = pathname === "/" || pathname.endsWith("/index.html");
  if (!isHome) return;

  document.body.classList.add("home-agent-refresh");

  if (!document.querySelector('link[data-home-agent-style]')) {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = "assets/css/home-agent.css?v=agent-homepage-v1";
    style.dataset.homeAgentStyle = "true";
    document.head.appendChild(style);
  }

  const navShell = document.querySelector(".nav-shell");
  const menuToggle = document.querySelector("[data-menu-toggle]");
  const launcher = document.querySelector("[data-xiaorui-launch]");
  const hero = document.querySelector(".hero");
  const heroInner = document.querySelector(".hero-inner");

  if (navShell && menuToggle && !document.querySelector("[data-home-agent-promo]")) {
    const promo = document.createElement("button");
    promo.type = "button";
    promo.className = "home-agent-promo";
    promo.dataset.homeAgentPromo = "true";
    promo.setAttribute("aria-label", "開啟小睿 AI Assistant 對話");
    promo.innerHTML = `
      <span class="home-agent-promo-copy">
        <small>小睿 AI Assistant</small>
        <strong>讓日常商務，多一位貼心助理</strong>
        <span>從接待、回應到安排，小睿陪企業把日常商務處理得更從容</span>
      </span>
      <img src="assets/images/xiaorui-assistant.png" alt="" aria-hidden="true">
    `;
    promo.addEventListener("click", () => launcher?.click());
    navShell.insertBefore(promo, menuToggle);
  }

  if (heroInner && !document.querySelector("[data-home-agent-video]")) {
    const videoCard = document.createElement("figure");
    videoCard.className = "home-agent-video";
    videoCard.dataset.homeAgentVideo = "true";
    videoCard.innerHTML = `
      <video
        autoplay
        muted
        loop
        playsinline
        preload="metadata"
        poster="assets/images/xiaorui-boardroom-poster.jpg"
        aria-label="主管會議中召喚小睿 AI Agent 協助工作的情境影片">
        <source src="assets/video/XIAORUI.mp4" type="video/mp4">
      </video>
      <figcaption>當工作需要幫手，小睿就在這裡。</figcaption>
    `;
    heroInner.appendChild(videoCard);

    const video = videoCard.querySelector("video");
    if (video) {
      video.muted = true;
      const attempt = video.play();
      if (attempt?.catch) attempt.catch(() => {});
    }
  }

  const initialBubble = document.querySelector(".xiaorui-bubble-assistant p");
  if (initialBubble) {
    initialBubble.textContent =
      "您好，我是小睿。除了公司登記、虛擬辦公室與會議空間，也可以問我企業 AI Agent、客製 Agent 或 Agent之家的基本資訊。";
  }

  if (hero && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      ([entry]) => {
        document.body.classList.toggle(
          "home-hero-visible",
          entry.isIntersecting && entry.intersectionRatio >= 0.2
        );
      },
      { threshold: [0, 0.2, 0.5] }
    );
    observer.observe(hero);
  }
})();
